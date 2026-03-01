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
import crypto from 'node:crypto';
import fs from 'node:fs';
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

  // Alert state (dedupe across timer runs)
  const ALERT_STATE_PATH = '/home/ubuntu/.openclaw/workspace/control-plane/data/stripe_missing_uuid_alert_state.json';
  let alertState = { lastEventTs: null, lastHash: null };
  try { alertState = JSON.parse(fs.readFileSync(ALERT_STATE_PATH, 'utf8')); } catch {}
  const lastEventTs = alertState?.lastEventTs ? String(alertState.lastEventTs) : null;

  // --- (A) Subscription refresh (existing rows) ---
  const rows = db.prepare(
    `SELECT provider_sub_id
       FROM subscriptions
      WHERE provider='stripe'
      ORDER BY updated_at ASC
      LIMIT 50`
  ).all();

  let ok = 0;
  let fail = 0;

  // --- (B) Payment confirm reconcile (when webhooks are delayed/missed) ---
  // Scan recent checkout shortlinks and confirm payment via the control-plane endpoint.
  // This backfills deliveries.status=PAID + subscriptions rows, then triggers /api/wa/status to send guide/cutover.
  let confirmedPaid = 0;
  let confirmedFail = 0;
  let guideTriggered = 0;

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

  // (B) confirm payment/cutover for recent checkout sessions
  try {
    const candidates = db.prepare(
      `SELECT provision_uuid, created_at, meta_json
         FROM shortlinks
        WHERE kind='stripe_checkout'
          AND created_at >= datetime('now','-24 hours')
        ORDER BY datetime(created_at) DESC
        LIMIT 30`
    ).all();

    for (const c of candidates) {
      const uuid = String(c.provision_uuid || '').trim();
      if (!uuid) continue;

      // Skip if already paid/delivered.
      try {
        const d = db.prepare('SELECT status, wa_jid FROM deliveries WHERE provision_uuid=? LIMIT 1').get(uuid);
        const st = String(d?.status || '').toUpperCase();
        if (st === 'DELIVERED' || st === 'DELIVERING' || st === 'PAID') continue;
      } catch {}

      // Use the authoritative confirm endpoint (it also creates PAYMENT_PAID funnel event).
      try {
        const r = await fetch(`http://127.0.0.1:18998/api/pay/confirm?uuid=${encodeURIComponent(uuid)}`);
        const j = await r.json().catch(() => null);
        if (r.ok && j?.ok && j?.paid === true) {
          confirmedPaid++;

          // Trigger /api/wa/status to send guide_key_paid (if linked + key not verified) or cutover (if verified).
          try {
            const s = await fetch(`http://127.0.0.1:18998/api/wa/status?uuid=${encodeURIComponent(uuid)}`);
            if (s.ok) guideTriggered++;
          } catch {}

          // Audit event
          try {
            db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
              crypto.randomUUID(), ts, 'delivery', uuid, 'PAY_CONFIRM_RECONCILED', JSON.stringify({ uuid, via: 'stripe_reconcile' })
            );
          } catch {}
        } else {
          // Ignore "not paid"; count hard failures only.
          if (!r.ok) confirmedFail++;
        }
      } catch {
        confirmedFail++;
      }
    }
  } catch {}

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

  // Alert: Stripe subscription events with missing uuid mapping
  try {
    const q = lastEventTs
      ? `SELECT ts, entity_id, payload_json FROM events WHERE event_type='STRIPE_SUB_UUID_MISSING' AND ts > ? ORDER BY ts ASC LIMIT 50`
      : `SELECT ts, entity_id, payload_json FROM events WHERE event_type='STRIPE_SUB_UUID_MISSING' ORDER BY ts DESC LIMIT 50`;
    const evs = lastEventTs ? db.prepare(q).all(lastEventTs) : db.prepare(q).all();
    if (evs && evs.length) {
      // Deduplicate message content
      const newestTs = evs[evs.length - 1].ts;
      const sample = evs.slice(-10).map(e => {
        let payload = {};
        try { payload = e.payload_json ? JSON.parse(e.payload_json) : {}; } catch {}
        return `${e.ts} subId=${e.entity_id} type=${payload.type || ''}`;
      }).join('\n');

      const msg = `[bothook] ALERT: STRIPE_SUB_UUID_MISSING (count=${evs.length})\n` + sample;
      const h = crypto.createHash('sha256').update(msg).digest('hex');
      if (h != alertState.lastHash) {
        tgSend(msg);
        alertState.lastHash = h;
      }
      alertState.lastEventTs = newestTs;
      try { fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(alertState, null, 2) + '\n'); } catch {}
    }
  } catch {}

  const summary = {
    ok: true,
    ts,
    dbPath,
    scanned_subscriptions: rows.length,
    updated_subscriptions: ok,
    failed_subscriptions: fail,
    scanned_checkout_shortlinks: 30,
    confirmed_paid: confirmedPaid,
    confirm_failed: confirmedFail,
    wa_status_triggered: guideTriggered,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (ok || fail || confirmedPaid || confirmedFail) {
    tgSend(`[bothook] stripe_reconcile: subs_scanned=${rows.length} subs_updated=${ok} subs_failed=${fail} paid_confirmed=${confirmedPaid} confirm_failed=${confirmedFail}`);
  }
}

main().catch((e) => {
  console.error('[stripe_reconcile] fatal', e);
  process.exit(1);
});
