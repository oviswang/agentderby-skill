#!/usr/bin/env node
/*
  Stripe -> DB reconciliation (source of truth: Stripe)

  Usage:
    STRIPE_SECRET_KEY=... node scripts/stripe_reconcile_subscriptions.mjs --limit 50

  Notes:
  - Updates control-plane SQLite DB.
  - Intended for periodic timer use (future), but safe for manual runs.
*/

import { openDb, nowIso } from '../control-plane/lib/db.mjs';

function getArg(name, def = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v ?? def;
}

const limit = Number(getArg('--limit', '100'));
const dryRun = process.argv.includes('--dry-run');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
if (!STRIPE_SECRET_KEY) {
  console.error('[stripe-reconcile] missing STRIPE_SECRET_KEY');
  process.exit(2);
}

function authHeader() {
  const b64 = Buffer.from(`${STRIPE_SECRET_KEY}:`).toString('base64');
  return `Basic ${b64}`;
}

async function stripeGetSubscription(subId) {
  const url = `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`;
  const resp = await fetch(url, { headers: { authorization: authHeader() } });
  const json = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, json };
}

function isoFromUnix(ts) {
  if (!ts) return null;
  try {
    return new Date(Number(ts) * 1000).toISOString();
  } catch {
    return null;
  }
}

async function main() {
  const { db, dbPath } = openDb();

  // Pick candidates that are likely to change.
  const rows = db.prepare(
    `SELECT provider_sub_id, provider, status, cancel_at_period_end, cancel_at, current_period_end
     FROM subscriptions
     WHERE provider='stripe'
       AND (
         LOWER(status) IN ('active','trialing','past_due','unpaid')
         OR cancel_at_period_end = 1
         OR cancel_at IS NOT NULL
       )
     ORDER BY updated_at DESC
     LIMIT ?`
  ).all(limit);

  let updated = 0;
  let errors = 0;

  for (const r of rows) {
    const subId = r.provider_sub_id;
    const res = await stripeGetSubscription(subId);
    if (!res.ok) {
      errors++;
      console.error('[stripe-reconcile] fetch failed', { subId, http: res.status, error: res.json?.error?.message || res.json?.error || null });
      continue;
    }

    const s = res.json;
    const patch = {
      status: s.status || r.status,
      current_period_end: isoFromUnix(s.current_period_end),
      cancel_at_period_end: s.cancel_at_period_end ? 1 : 0,
      cancel_at: isoFromUnix(s.cancel_at),
      canceled_at: isoFromUnix(s.canceled_at),
      ended_at: isoFromUnix(s.ended_at),
      updated_at: nowIso(),
    };

    const changed = (
      String(r.status || '') !== String(patch.status || '') ||
      String(r.current_period_end || '') !== String(patch.current_period_end || '') ||
      Number(r.cancel_at_period_end || 0) !== Number(patch.cancel_at_period_end || 0) ||
      String(r.cancel_at || '') !== String(patch.cancel_at || '')
    );

    if (!changed) continue;

    if (!dryRun) {
      db.prepare(
        `UPDATE subscriptions
           SET status=?, current_period_end=?, cancel_at_period_end=?, cancel_at=?, canceled_at=?, ended_at=?, updated_at=?
         WHERE provider_sub_id=?`
      ).run(
        patch.status,
        patch.current_period_end,
        patch.cancel_at_period_end,
        patch.cancel_at,
        patch.canceled_at,
        patch.ended_at,
        patch.updated_at,
        subId
      );
    }

    updated++;
    console.log('[stripe-reconcile] updated', { subId, ...patch });
  }

  console.log(JSON.stringify({ ok: true, dbPath, scanned: rows.length, updated, errors, dryRun }, null, 2));
}

main().catch((e) => {
  console.error('[stripe-reconcile] fatal', e);
  process.exit(1);
});
