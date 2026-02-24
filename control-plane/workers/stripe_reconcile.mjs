#!/usr/bin/env node
/**
 * stripe_reconcile.mjs
 *
 * Periodically refresh Stripe subscription fields into local `subscriptions` table.
 *
 * Scope: minimal + safe.
 * - Reads existing rows where provider='stripe'
 * - Fetches Stripe subscription object via REST
 * - Updates: status, current_period_end, cancel_at, canceled_at, ended_at, cancel_at_period_end, updated_at
 */

import { execSync } from 'node:child_process';
import { openDb, nowIso } from '../lib/db.mjs';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET;
if (!STRIPE_SECRET_KEY) {
  console.error('[stripe_reconcile] missing STRIPE_SECRET_KEY in env');
  process.exit(2);
}

function unixToIso(u) {
  if (!u) return null;
  const n = Number(u);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

async function fetchStripeSub(id) {
  const resp = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
    headers: {
      authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded'
    }
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!resp.ok) {
    const msg = json?.error?.message || text || `http_${resp.status}`;
    throw new Error(`stripe_subscription_fetch_failed:${msg}`);
  }
  return json;
}

function sh(cmd){
  return execSync(cmd, { stdio:['ignore','pipe','pipe'], encoding:'utf8', shell:'/bin/bash' });
}

function loadEnvFile(p) {
  try {
    const text = sh(`bash -lc 'set -a; source ${JSON.stringify(p)}; set +a; python3 - <<"PY"\nimport os, json\nkeys=["TELEGRAM_BOT_TOKEN","TELEGRAM_TOKEN","TELEGRAM_CHAT_ID","OWNER_CHAT_ID"]\nprint(json.dumps({k:os.environ.get(k) for k in keys}))\nPY'`);
    return JSON.parse(text);
  } catch { return {}; }
}

function tgSend(text) {
  const envFile = process.env.TELEGRAM_ENV || '/home/ubuntu/.openclaw/credentials/telegram.env';
  const env = loadEnvFile(envFile);
  const token = env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID || env.OWNER_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    sh(`curl -s -X POST https://api.telegram.org/bot${token}/sendMessage -d chat_id=${chatId} -d text=${JSON.stringify(text)} >/dev/null`);
    return true;
  } catch { return false; }
}

async function main() {
  const { db, dbPath } = openDb();
  const ts = nowIso();

  // Process a small batch each run.
  const rows = db.prepare(
    `SELECT provider_sub_id
       FROM subscriptions
      WHERE provider='stripe'
      ORDER BY updated_at ASC
      LIMIT 50`
  ).all();

  let ok = 0;
  let fail = 0;

  const upd = db.prepare(
    `UPDATE subscriptions
        SET status=?,
            current_period_end=?,
            cancel_at=?,
            canceled_at=?,
            ended_at=?,
            cancel_at_period_end=?,
            updated_at=?
      WHERE provider_sub_id=?`
  );

  for (const r of rows) {
    const id = String(r.provider_sub_id || '').trim();
    if (!id) continue;
    try {
      const sub = await fetchStripeSub(id);
      upd.run(
        String(sub.status || ''),
        unixToIso(sub.current_period_end),
        unixToIso(sub.cancel_at),
        unixToIso(sub.canceled_at),
        unixToIso(sub.ended_at),
        sub.cancel_at_period_end ? 1 : 0,
        ts,
        id
      );
      ok++;
    } catch (e) {
      fail++;
      console.error('[stripe_reconcile] fail', id, String(e?.message || e));
    }
  }

  const summary = { ok: true, ts, dbPath, scanned: rows.length, updated: ok, failed: fail };
  console.log(JSON.stringify(summary, null, 2));
  if (ok || fail) {
    tgSend(`[bothook] stripe_reconcile: scanned=${rows.length} updated=${ok} failed=${fail}`);
  }
}

main().catch((e) => {
  console.error('[stripe_reconcile] fatal', e);
  process.exit(1);
});
