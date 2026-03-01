#!/usr/bin/env node
/**
 * subscription_reclaim.mjs
 *
 * Reclaim expired subscriptions.
 *
 * Policy:
 * - Grace for past_due/payment_failed: 24h from first observation (stored in deliveries.meta_json.payment_failed_since).
 * - End of access: current_period_end (preferred); fallback to cancel_at.
 *
 * Safety model (owner-confirmed):
 * - This worker MUST NOT perform destructive actions automatically (no reimage / terminate).
 * - It only marks states + notifies, moving instances to RECLAIM_PENDING for manual execution.
 *
 * Safety:
 * - Processes at most 1 instance per run.
 */

import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { openDb, nowIso } from '../lib/db.mjs';

const BLUEPRINT_ID = process.env.BOTHOOK_REIMAGE_BLUEPRINT_ID || 'lhbp-1l4ptuvm';
const REGION = process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore';
const API_BASE = process.env.BOTHOOK_API_BASE || 'http://127.0.0.1:18998';
const TARGET_READY = parseInt(process.env.BOTHOOK_POOL_TARGET_READY || '5', 10);
const GRACE_MS = 24 * 60 * 60 * 1000;

// Instances moved to this lifecycle_status will not be allocated by the pool allocator.
const RECLAIM_PENDING = 'RECLAIM_PENDING';

function parseJson(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
function mergeMeta(oldMetaStr, patch) {
  const m = parseJson(oldMetaStr);
  return JSON.stringify({ ...m, ...patch });
}

function sh(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: '/bin/bash' });
}

function tccli(cmd) {
  const envFile = '/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env';
  const full = `set -a; source ${envFile}; set +a; ${cmd}`;
  return sh(full);
}

function describe(instance_id) {
  const txt = tccli(`tccli lighthouse DescribeInstances --region ${REGION} --InstanceIds '["${instance_id}"]' --output json`);
  const j = JSON.parse(txt);
  const it = (j.InstanceSet || [])[0];
  return it || null;
}

function waitStopped(instance_id, { timeoutMs=5*60*1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const it = describe(instance_id);
    if (!it) return true;
    const st = String(it.InstanceState || '');
    if (st === 'STOPPED') return true;
    // best-effort sleep
    execSync('sleep 5', { stdio:'ignore', shell:'/bin/bash' });
  }
  return false;
}

function ensureStopped(instance_id) {
  const it = describe(instance_id);
  if (!it) return true;
  const st = String(it.InstanceState || '');
  if (st === 'STOPPED') return true;
  if (st === 'RUNNING') {
    tccli(`tccli lighthouse StopInstances --region ${REGION} --InstanceIds '["${instance_id}"]' --StopType SOFT_FIRST --output json`);
  }
  return waitStopped(instance_id);
}

function returnable(instance_id) {
  const txt = tccli(`tccli lighthouse DescribeInstancesReturnable --region ${REGION} --cli-unfold-argument --InstanceIds ${instance_id} --output json`);
  const j = JSON.parse(txt);
  const it = (j.Response?.InstanceReturnableSet || j.InstanceReturnableSet || [])[0];
  return it || null;
}

function terminate(instance_id) {
  tccli(`tccli lighthouse TerminateInstances --region ${REGION} --cli-unfold-argument --InstanceIds ${instance_id} --output json`);
}

function postJson(url, body) {
  const payload = JSON.stringify(body);
  const out = sh(`curl -s -X POST ${JSON.stringify(url)} -H 'content-type: application/json' --data-binary ${JSON.stringify(payload)}`);
  return JSON.parse(out);
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

function main() {
  const { db } = openDb();
  const ts = nowIso();

  // Candidate: instances in ALLOCATED/DELIVERED with an active-ish delivery + a Stripe subscription row.
  // (We include DELIVERED to ensure reclaim works for already delivered users too.)
  const rows = db.prepare(
    `SELECT
        i.instance_id,
        i.lifecycle_status,
        i.health_status,
        i.public_ip,
        i.meta_json as instance_meta,
        d.delivery_id,
        d.user_id,
        d.status as delivery_status,
        d.meta_json as delivery_meta,
        s.provider_sub_id,
        s.status as sub_status,
        s.current_period_end,
        s.cancel_at,
        s.cancel_at_period_end,
        s.updated_at
     FROM instances i
     JOIN deliveries d ON d.instance_id = i.instance_id
     JOIN subscriptions s ON s.user_id = d.user_id
     WHERE i.lifecycle_status IN ('ALLOCATED','DELIVERED')
       AND d.status IN ('ACTIVE','DELIVERED','PAID')
       AND s.provider = 'stripe'
     ORDER BY s.updated_at ASC
     LIMIT 50`
  ).all();

  let decided = null;

  for (const r of rows) {
    const subStatus = String(r.sub_status || '').toLowerCase();

    // 1) Immediate terminal states
    const terminal = new Set(['canceled', 'unpaid', 'incomplete_expired']);
    let shouldReclaim = terminal.has(subStatus);
    let reason = terminal.has(subStatus) ? `sub_status_${subStatus}` : null;

    // 2) Grace states
    const graceStates = new Set(['past_due', 'payment_failed']);
    if (!shouldReclaim && graceStates.has(subStatus)) {
      const meta = parseJson(r.delivery_meta);
      if (!meta.payment_failed_since) {
        // First observation: mark and wait.
        const meta2 = mergeMeta(r.delivery_meta, { payment_failed_since: ts, payment_failed_provider_sub_id: r.provider_sub_id });
        db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta2, ts, r.delivery_id);
        db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
          .run(crypto.randomUUID(), ts, 'delivery', r.delivery_id, 'PAYMENT_FAILED_GRACE_START', JSON.stringify({ provider_sub_id: r.provider_sub_id, status: subStatus }));
        continue;
      }
      const t0 = Date.parse(meta.payment_failed_since);
      if (Number.isFinite(t0) && (Date.now() - t0 >= GRACE_MS)) {
        shouldReclaim = true;
        reason = `grace_expired_${subStatus}`;
      }
    }

    // 3) Period end
    if (!shouldReclaim) {
      if (r.current_period_end && isExpiredByTime(r.current_period_end)) {
        shouldReclaim = true;
        reason = 'current_period_end_reached';
      } else if (!r.current_period_end && r.cancel_at && isExpiredByTime(r.cancel_at)) {
        shouldReclaim = true;
        reason = 'cancel_at_reached_fallback';
      }
    }

    if (!shouldReclaim) continue;

    decided = { ...r, reason };
    break;
  }

  if (!decided) {
    console.log(JSON.stringify({ ok: true, ts, action: 'noop', scanned: rows.length }, null, 2));
    return;
  }

  tgSend(`[bothook] subscription_reclaim: start instance=${decided.instance_id} reason=${decided.reason}`);

  const instance_id = decided.instance_id;
  const delivery_id = decided.delivery_id;
  const user_id = decided.user_id;

  const readyNow = db.prepare(`SELECT COUNT(*) c FROM instances WHERE lifecycle_status='IN_POOL' AND health_status='READY'`).get().c;

  // 1) Mark DB states (idempotent-ish)
  // NOTE: no destructive cloud actions here. We only mark RECLAIM_PENDING.
  db.exec('BEGIN IMMEDIATE');
  try {
    const dcur = db.prepare('SELECT status, meta_json FROM deliveries WHERE delivery_id=?').get(delivery_id);
    const ist = String(dcur?.status || '').toUpperCase();
    if (ist === 'EXPIRED_RECLAIMING' || ist === 'RECLAIM_PENDING') {
      db.exec('COMMIT');
      console.log(JSON.stringify({ ok:true, ts, action:'already_pending', instance_id, delivery_id, reason: decided.reason }, null, 2));
      return;
    }

    db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE delivery_id=?')
      .run('EXPIRED_RECLAIMING', ts, mergeMeta(decided.delivery_meta, { reclaim_reason: decided.reason, reclaim_started_at: ts, reclaim_plan: 'manual_reclaim_pending' }), delivery_id);

    db.prepare(
      `UPDATE instances
          SET lifecycle_status=?,
              health_status='NEEDS_VERIFY',
              assigned_user_id=NULL,
              assigned_order_id=NULL,
              assigned_at=NULL,
              meta_json=?
        WHERE instance_id=?`
    ).run(
      RECLAIM_PENDING,
      mergeMeta(decided.instance_meta, { reclaimed_from_user_id: user_id, reclaim_reason: decided.reason, reclaim_started_at: ts, reclaim_plan: 'manual_reclaim_pending' }),
      instance_id
    );

    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), ts, 'instance', instance_id, 'SUBSCRIPTION_RECLAIM_PENDING', JSON.stringify({ delivery_id, user_id, reason: decided.reason, readyNow, targetReady: TARGET_READY, plan: 'manual' }));
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  const out = { ok:true, ts, action:'mark_reclaim_pending', instance_id, delivery_id, reason: decided.reason, readyNow, targetReady: TARGET_READY };
  console.log(JSON.stringify(out, null, 2));
  tgSend(`[bothook] subscription_reclaim: pending (manual) instance=${instance_id} delivery=${delivery_id} reason=${decided.reason}`);
}

main();
