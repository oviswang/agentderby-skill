#!/usr/bin/env node
/**
 * reclaim_executor.mjs
 *
 * Execute destructive reclaim actions for instances previously marked RECLAIM_PENDING.
 *
 * Policy (owner-confirmed):
 * - Terminate instances to reduce cost.
 * - Only act on RECLAIM_PENDING instances older than a delay window.
 * - Strong re-checks before terminate:
 *   - subscription status + period end timestamps in DB
 *   - past_due/payment_failed grace (24h since payment_failed_since)
 *   - Stripe API re-check (fail-closed: if Stripe check fails, do NOT terminate)
 * - Process at most 1 instance per run.
 */

import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { openDb, nowIso } from '../lib/db.mjs';

const REGION = process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore';
const GRACE_MS = 24 * 60 * 60 * 1000;
const DELAY_MS = parseInt(process.env.BOTHOOK_RECLAIM_EXEC_DELAY_MS || String(30 * 60 * 1000), 10);

function sh(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: '/bin/bash' });
}

function tccli(cmd) {
  const envFile = '/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env';
  const full = `set -a; source ${envFile}; set +a; ${cmd}`;
  return sh(full);
}

function parseJson(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
function mergeMeta(oldMetaStr, patch) {
  const m = parseJson(oldMetaStr);
  return JSON.stringify({ ...m, ...patch });
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

function isExpiredByTime(tsIso) {
  if (!tsIso) return false;
  const t = Date.parse(tsIso);
  if (!Number.isFinite(t)) return false;
  return Date.now() >= t;
}

function stripeGetSubscription(subId) {
  const secret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
  if (!secret) throw new Error('stripe_not_configured');
  const out = sh(`curl -sS https://api.stripe.com/v1/subscriptions/${subId} -H 'Authorization: Bearer ${secret}'`);
  const j = JSON.parse(out);
  if (j?.error) throw new Error(`stripe_error:${j.error?.type || 'unknown'}`);
  return j;
}

function describeInstance(instance_id) {
  const txt = tccli(`tccli lighthouse DescribeInstances --region ${REGION} --InstanceIds '["${instance_id}"]' --output json`);
  const j = JSON.parse(txt);
  return (j.InstanceSet || [])[0] || null;
}

function terminateInstance(instance_id) {
  tccli(`tccli lighthouse TerminateInstances --region ${REGION} --cli-unfold-argument --InstanceIds ${instance_id} --output json`);
}

function main() {
  const { db } = openDb();
  const ts = nowIso();

  // Candidate: RECLAIM_PENDING instances with a delivery+subscription.
  // Delay gate uses deliveries.meta_json.reclaim_started_at (set by subscription_reclaim.mjs) when present.
  const rows = db.prepare(
    `SELECT
        i.instance_id,
        i.lifecycle_status,
        i.meta_json as instance_meta,
        d.delivery_id,
        d.user_id,
        d.status as delivery_status,
        d.meta_json as delivery_meta,
        s.provider_sub_id,
        s.status as sub_status,
        s.current_period_end,
        s.cancel_at,
        s.updated_at
     FROM instances i
     JOIN deliveries d ON d.instance_id = i.instance_id
     JOIN subscriptions s ON s.user_id = d.user_id
     WHERE i.lifecycle_status = 'RECLAIM_PENDING'
       AND s.provider = 'stripe'
     ORDER BY datetime(s.updated_at) ASC
     LIMIT 50`
  ).all();

  let chosen = null;
  for (const r of rows) {
    const meta = parseJson(r.delivery_meta);
    const startedAt = meta.reclaim_started_at ? Date.parse(String(meta.reclaim_started_at)) : NaN;
    if (Number.isFinite(startedAt) && (Date.now() - startedAt < DELAY_MS)) continue;

    // Re-check reclaim conditions in DB
    const subStatus = String(r.sub_status || '').toLowerCase();

    const terminal = new Set(['canceled', 'unpaid', 'incomplete_expired']);
    const graceStates = new Set(['past_due', 'payment_failed']);

    let should = false;
    let reason = null;

    if (terminal.has(subStatus)) {
      // Require time expiry too (avoid early cancel before end of period)
      if ((r.current_period_end && isExpiredByTime(r.current_period_end)) || (!r.current_period_end && r.cancel_at && isExpiredByTime(r.cancel_at))) {
        should = true;
        reason = `terminal_${subStatus}_expired`;
      }
    }

    if (!should && graceStates.has(subStatus)) {
      const t0 = meta.payment_failed_since ? Date.parse(String(meta.payment_failed_since)) : NaN;
      if (Number.isFinite(t0) && (Date.now() - t0 >= GRACE_MS)) {
        // Also require period end reached
        if ((r.current_period_end && isExpiredByTime(r.current_period_end)) || (!r.current_period_end && r.cancel_at && isExpiredByTime(r.cancel_at))) {
          should = true;
          reason = `grace_${subStatus}_expired`;
        }
      }
    }

    if (!should) continue;

    chosen = { ...r, reason };
    break;
  }

  if (!chosen) {
    console.log(JSON.stringify({ ok:true, ts, action:'noop', scanned: rows.length }, null, 2));
    return;
  }

  const instance_id = String(chosen.instance_id);
  const delivery_id = String(chosen.delivery_id);
  const user_id = String(chosen.user_id);
  const subId = String(chosen.provider_sub_id || '').trim();

  tgSend(`[bothook] reclaim_executor: evaluating instance=${instance_id} reason=${chosen.reason}`);

  // Stripe re-check (fail-closed)
  let stripe = null;
  try {
    if (!subId) throw new Error('missing_sub_id');
    stripe = stripeGetSubscription(subId);
  } catch (e) {
    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), ts, 'instance', instance_id, 'SUBSCRIPTION_RECLAIM_STRIPE_RECHECK_FAILED', JSON.stringify({ delivery_id, user_id, provider_sub_id: subId || null, err: String(e?.message || e) }));
    console.log(JSON.stringify({ ok:true, ts, action:'skip_stripe_recheck_failed', instance_id, delivery_id, reason: chosen.reason }, null, 2));
    tgSend(`[bothook][WARN] reclaim_executor: stripe re-check failed; NOT terminating instance=${instance_id} (${String(e?.message||e)})`);
    return;
  }

  const stripeStatus = String(stripe?.status || '').toLowerCase();
  const stripeCpeMs = (stripe && stripe.current_period_end) ? (Number(stripe.current_period_end) * 1000) : null;

  // Decide terminate based on Stripe: require NOT active/trialing and require period end reached.
  const okStatuses = new Set(['canceled', 'unpaid', 'incomplete_expired', 'past_due', 'payment_failed']);
  if (!okStatuses.has(stripeStatus) || (stripeCpeMs !== null && Date.now() < stripeCpeMs)) {
    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), ts, 'instance', instance_id, 'SUBSCRIPTION_RECLAIM_STRIPE_RECHECK_BLOCKED', JSON.stringify({ delivery_id, user_id, provider_sub_id: subId, stripe_status: stripeStatus, stripe_cpe: stripe?.current_period_end || null }));
    console.log(JSON.stringify({ ok:true, ts, action:'skip_stripe_blocked', instance_id, delivery_id, stripe_status: stripeStatus }, null, 2));
    tgSend(`[bothook] reclaim_executor: blocked by stripe status=${stripeStatus} instance=${instance_id}`);
    return;
  }

  // Cloud terminate
  try {
    const it = describeInstance(instance_id);
    if (!it) {
      // Already gone
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), ts, 'instance', instance_id, 'SUBSCRIPTION_RECLAIM_TERMINATED', JSON.stringify({ delivery_id, user_id, provider_sub_id: subId, note: 'instance_missing_cloud' }));
      console.log(JSON.stringify({ ok:true, ts, action:'already_terminated', instance_id }, null, 2));
      return;
    }

    terminateInstance(instance_id);

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE delivery_id=?')
        .run('EXPIRED_TERMINATED', ts, mergeMeta(chosen.delivery_meta, { reclaim_terminated_at: ts, reclaim_executor_reason: chosen.reason, provider_sub_id: subId, stripe_status: stripeStatus }), delivery_id);
      db.prepare('UPDATE instances SET lifecycle_status=?, health_status=?, meta_json=? WHERE instance_id=?')
        .run('TERMINATING', 'NEEDS_VERIFY', mergeMeta(chosen.instance_meta, { reclaim_terminated_at: ts, reclaim_executor_reason: chosen.reason, provider_sub_id: subId, stripe_status: stripeStatus }), instance_id);
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), ts, 'instance', instance_id, 'SUBSCRIPTION_RECLAIM_TERMINATE_REQUESTED', JSON.stringify({ delivery_id, user_id, provider_sub_id: subId, stripe_status: stripeStatus, reason: chosen.reason }));
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    tgSend(`[bothook] reclaim_executor: terminate requested instance=${instance_id} user=${user_id} stripe_status=${stripeStatus}`);
    console.log(JSON.stringify({ ok:true, ts, action:'terminate_requested', instance_id, delivery_id, user_id, stripe_status: stripeStatus, reason: chosen.reason }, null, 2));
  } catch (e) {
    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), ts, 'instance', instance_id, 'SUBSCRIPTION_RECLAIM_TERMINATE_FAILED', JSON.stringify({ delivery_id, user_id, provider_sub_id: subId || null, err: String(e?.message||e) }));
    tgSend(`[bothook][WARN] reclaim_executor: terminate failed instance=${instance_id} err=${String(e?.message||e)}`);
    console.log(JSON.stringify({ ok:false, ts, action:'terminate_failed', instance_id, err: String(e?.message||e) }, null, 2));
  }
}

main();
