#!/usr/bin/env node
/**
 * delivery_watchdog.mjs
 *
 * Enforce linking/payment timeouts to prevent half-allocated instances from draining pool capacity.
 *
 * Policy (owner-confirmed):
 * - Stage A (pre-bind): 5 minutes from instance.assigned_at (or delivery.created_at) until bound_at is set.
 *   Action: release instance back to IN_POOL (NEEDS_VERIFY) and mark delivery timeout.
 * - Stage B (post-bind, unpaid): 15 minutes from delivery.bound_at until paid.
 *   Action: reimage instance (ResetInstance) then return to pool via /api/ops/pool/init.
 *
 * Notes:
 * - We treat deliveries.status in ('PAID','DELIVERED','ACTIVE') or meta_json.paid_at set as PAID.
 * - Heavy concurrency: 1 per run (systemd flock + LIMIT=1).
 */

import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { openDb, nowIso } from '../lib/db.mjs';

const API_BASE = process.env.BOTHOOK_API_BASE || 'http://127.0.0.1:18998';
const REGION = process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore';
const BLUEPRINT_ID = process.env.BOTHOOK_REIMAGE_BLUEPRINT_ID || 'lhbp-1l4ptuvm';

const STAGE_A_MS = 5 * 60 * 1000;
// Hard reclaim threshold: unpaid deliveries older than this (from assigned_at/created_at) are reclaimed.
const STAGE_B_MS = 20 * 60 * 1000;
// Cleanup: stale LINKING records (no wa_jid, no bound) that linger on pool instances.
// These are usually abandoned test UUIDs and should not pin instance_id forever.
const STALE_LINKING_MS = 30 * 60 * 1000;

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

function postJson(url, body) {
  const payload = JSON.stringify(body);
  const out = sh(`curl -s -X POST ${JSON.stringify(url)} -H 'content-type: application/json' --data-binary ${JSON.stringify(payload)}`);
  return JSON.parse(out);
}

function sshCmd(ip, cmd, { timeoutSec = 15 } = {}) {
  const key = '/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519';
  const ssh = [
    'ssh',
    '-i', key,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', `ConnectTimeout=${Math.min(8, timeoutSec)}`,
    '-o', 'ConnectionAttempts=1',
    `ubuntu@${ip}`,
    cmd
  ].map(x => JSON.stringify(String(x))).join(' ');
  return sh(`timeout ${Math.max(5, timeoutSec)}s ${ssh}`);
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

function hasActiveSubscription(db, user_id) {
  try {
    const uid = String(user_id || '').trim();
    if (!uid) return false;
    const row = db.prepare(
      `SELECT status
         FROM subscriptions
        WHERE user_id=? AND provider='stripe'
        ORDER BY datetime(updated_at) DESC
        LIMIT 1`
    ).get(uid);
    const st = String(row?.status || '').toLowerCase();
    return st === 'active' || st === 'trialing' || st === 'paid';
  } catch {
    return false;
  }
}

function isPaid(db, delivery_status, delivery_meta_json, user_id) {
  // Treat an ACTIVE subscription as paid, regardless of delivery.status drift.
  if (hasActiveSubscription(db, user_id)) return true;

  const st = String(delivery_status || '').toUpperCase();
  if (['PAID','DELIVERED'].includes(st)) return true;
  const m = parseJson(delivery_meta_json);
  // Backward/forward compatible paid markers
  return Boolean(m?.paid_at || m?.paid_confirmed_at || m?.payment_paid_at);
}

async function main() {
  const { db } = openDb();
  const ts = nowIso();

  // 0) Cleanup stale deliveries that still reference IN_POOL instances.
  // a) Stale LINKING: status='LINKING', not bound, older than STALE_LINKING_MS -> mark QR_EXPIRED + unpin instance_id.
  // b) Stale ACTIVE/PAID/DELIVERED bound-but-expired: if bound_unpaid_expires_at is past and still pinned to an IN_POOL instance -> mark QR_EXPIRED + unpin.
  // Safety: clear at most 5 per run.
  try {
    const stale = db.prepare(
      `SELECT d.delivery_id, d.user_id, d.instance_id, d.status, d.updated_at, d.meta_json AS delivery_meta,
              COALESCE(i.lifecycle_status,'') AS lifecycle_status
         FROM deliveries d
         LEFT JOIN instances i ON i.instance_id = d.instance_id
        WHERE d.instance_id IS NOT NULL AND d.instance_id != ''
          AND (
            (d.status='LINKING' AND (d.wa_jid IS NULL OR d.wa_jid='') AND d.bound_at IS NULL)
            OR (d.status IN ('ACTIVE','PAID','DELIVERED') AND d.bound_at IS NOT NULL)
          )
        ORDER BY d.updated_at ASC
        LIMIT 80`
    ).all();

    let cleared = 0;
    for (const r of stale) {
      const lc = String(r.lifecycle_status || '');
      // Never touch the workstation/master instance.
      if (lc === 'WORKSTATION_MASTER') continue;
      if (lc && lc !== 'IN_POOL') continue;

      const st = String(r.status || '');
      const meta = parseJson(r.delivery_meta);

      let shouldClear = false;
      let reason = '';

      if (st === 'LINKING') {
        const t0 = Date.parse(String(r.updated_at || ''));
        if (Number.isFinite(t0) && (Date.now() - t0 >= STALE_LINKING_MS)) {
          shouldClear = true;
          reason = 'stale_linking_unpinned';
        }
      } else {
        // Never clear sessions for paid users (active subscription), keep pinned until explicit reclaim/cancel policy.
        if (isPaid(db, st, r.delivery_meta, r.user_id)) continue;
        // bound-but-expired fallback: use meta.bound_unpaid_expires_at if present
        const exp = meta?.bound_unpaid_expires_at ? Date.parse(String(meta.bound_unpaid_expires_at)) : NaN;
        if (Number.isFinite(exp) && Date.now() >= exp) {
          shouldClear = true;
          reason = 'stale_bound_expired_unpinned';
        }
      }

      if (!shouldClear) continue;

      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE deliveries SET status=?, instance_id=NULL, updated_at=?, meta_json=? WHERE delivery_id=?')
          .run('QR_EXPIRED', ts, mergeMeta(r.delivery_meta, { cleared_by: 'delivery_watchdog', cleared_at: ts, cleared_reason: reason, prev_status: st }), String(r.delivery_id));
        db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
          .run(crypto.randomUUID(), ts, 'delivery', String(r.delivery_id), 'DELIVERY_STALE_PIN_CLEARED', JSON.stringify({ instance_id: String(r.instance_id || ''), prev_status: st, reason }));

        // Best-effort: if instance is IN_POOL but was actually linked, force it back to NEEDS_VERIFY.
        // (We avoid touching lifecycle_status here; pool ops decide if reimage is needed.)
        try {
          if (r.instance_id) {
            db.prepare("UPDATE instances SET health_status='NEEDS_VERIFY' WHERE instance_id=? AND lifecycle_status='IN_POOL'")
              .run(String(r.instance_id));
          }
        } catch {}

        db.exec('COMMIT');
        cleared++;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
      }

      if (cleared >= 5) break;
    }

    if (cleared) {
      tgSend(`[bothook][watchdog] cleared stale pinned deliveries: count=${cleared}`);
    }
  } catch {}

  // Candidates: allocated deliveries that are not paid.
  const rows = db.prepare(
    `SELECT
        d.delivery_id, d.provision_uuid, d.user_id, d.instance_id, d.status as delivery_status, d.created_at as delivery_created_at,
        d.bound_at, d.meta_json as delivery_meta,
        i.public_ip, i.lifecycle_status, i.health_status, i.assigned_at, i.meta_json as instance_meta
     FROM deliveries d
     JOIN instances i ON i.instance_id = d.instance_id
     WHERE i.lifecycle_status = 'ALLOCATED'
     ORDER BY COALESCE(d.bound_at, d.created_at) ASC
     LIMIT 50`
  ).all();

  let chosen = null;
  let stage = null;

  // Best-effort self-heal for onboarding UX (at most 1 instance per run):
  // ensure user-machine has autoreply enabled + gateway running after bind.
  let ensured = 0;

  for (const r of rows) {
    // Hard skip: if ops has marked this delivery as "do not reallocate" / closed out,
    // watchdog must not keep touching it (prevents release/reallocate loops).
    const dm = parseJson(r.delivery_meta);
    if (dm?.do_not_reallocate === 1 || dm?.closed_out_at || dm?.closed_out_reason) continue;

    // UX self-heal: only for bound-but-unpaid within the 15m window.
    // Goal: avoid cases where user gets no welcome/guide due to autoreply disabled or gateway not running.
    if (ensured < 1 && r.bound_at && !isPaid(db, r.delivery_status, r.delivery_meta, r.user_id)) {
      try {
        const boundMs = Date.now() - Date.parse(String(r.bound_at));
        if (Number.isFinite(boundMs) && boundMs >= 0 && boundMs < STAGE_B_MS) {
          const m = parseJson(r.delivery_meta);
          const last = m?.autoreply_ensured_at ? Date.parse(String(m.autoreply_ensured_at)) : null;
          // Once per QR generation window, or at most once per 10 minutes as fallback.
          const qrGenAt = m?.qr_generated_at ? Date.parse(String(m.qr_generated_at)) : null;
          const allow = (!last) || (qrGenAt && last && qrGenAt > last) || (last && (Date.now() - last) > 10 * 60 * 1000);
          if (allow) {
            const ip = String(r.public_ip || '');
            if (ip) {
              let ok2 = false;
              let detail = '';
              try {
                const out = sshCmd(ip, "set -euo pipefail; openclaw plugins list 2>/dev/null | grep -q 'bothook-wa-autoreply.*loaded' || (openclaw plugins enable bothook-wa-autoreply >/dev/null 2>&1 || true); openclaw models set openai/gpt-5.2 >/dev/null 2>&1 || true; sudo systemctl restart openclaw-gateway.service >/dev/null 2>&1 || true; ss -ltn 2>/dev/null | grep -q ':18789' && echo ok || echo noport");
                detail = String(out || '').trim().slice(0, 300);
                ok2 = detail.includes('ok');
              } catch (e) {
                detail = String(e?.message || e).slice(0, 300);
                ok2 = false;
              }

              const ts2 = nowIso();
              try {
                db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(
                  mergeMeta(r.delivery_meta, { autoreply_ensured_at: ts2, autoreply_ensure_ok: ok2 }), ts2, String(r.delivery_id)
                );
              } catch {}
              try {
                db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
                  .run(crypto.randomUUID(), ts2, 'delivery', String(r.delivery_id), ok2 ? 'AUTOREPLY_ENSURED_OK' : 'AUTOREPLY_ENSURED_FAILED', JSON.stringify({ uuid: String(r.provision_uuid || ''), instance_id: String(r.instance_id || ''), ip, ok: ok2, detail }));
              } catch {}

              ensured++;
            }
          }
        }
      } catch {}
    }

    if (isPaid(db, r.delivery_status, r.delivery_meta, r.user_id)) continue;

    // Anchor for unpaid timeout decisions: use instance.assigned_at when available (more accurate),
    // otherwise fall back to delivery.created_at.
    const anchor = r.assigned_at || r.delivery_created_at;
    const t0 = Date.parse(anchor || '');
    const elapsedMs = Number.isFinite(t0) ? (Date.now() - t0) : NaN;

    // Hard reclaim: unpaid for >= STAGE_B_MS (20m) regardless of whether it is bound.
    if (Number.isFinite(elapsedMs) && elapsedMs >= STAGE_B_MS) {
      chosen = r;
      stage = 'HARD_UNPAID_20M';
      break;
    }

    // Stage A (soft): not bound yet and older than STAGE_A_MS (5m).
    // We ONLY record + optionally self-heal; do NOT release the instance.
    if (!r.bound_at) {
      if (Number.isFinite(elapsedMs) && elapsedMs >= STAGE_A_MS) {
        chosen = r;
        stage = 'A_PRE_BIND_SOFT_5M';
        break;
      }
      continue;
    }
  }

  if (!chosen) {
    console.log(JSON.stringify({ ok:true, ts, action:'noop', scanned: rows.length }, null, 2));
    return;
  }

  const instance_id = String(chosen.instance_id);
  const delivery_id = String(chosen.delivery_id);

  if (stage === 'A_PRE_BIND_SOFT_5M') {
    // Soft handling only: do NOT release allocation.
    // Rationale: users can be slow to scan/confirm WhatsApp link; releasing here can create race conditions.
    try {
      db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?')
        .run(mergeMeta(chosen.delivery_meta, { prebind_soft_timeout_at: ts }), ts, delivery_id);
    } catch {}
    try {
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), ts, 'delivery', delivery_id, 'DELIVERY_PREBIND_SOFT_TIMEOUT', JSON.stringify({ instance_id }));
    } catch {}

    tgSend(`[bothook][watchdog] pre-bind soft timeout (5m): no release (instance=${instance_id} delivery=${delivery_id})`);
    console.log(JSON.stringify({ ok:true, ts, action:'prebind_soft_timeout_no_release', stage, instance_id, delivery_id }, null, 2));
    return;
  }

  // Hard reclaim (unpaid >= 20m). Safeguard: confirm payment before any action.
  // Policy: if still unpaid, we reclaim the instance back to IN_POOL and enqueue reimage+init,
  // so it returns to READY (true pool return).
  let confirmPaid = false;
  try {
    const u = String(chosen.provision_uuid || chosen.user_id || '').trim();
    if (u) {
      const j = await fetch(`${API_BASE}/api/pay/confirm?uuid=${encodeURIComponent(u)}`).then(r => r.json()).catch(() => null);
      confirmPaid = Boolean(j?.paid === true);
    }
  } catch { confirmPaid = false; }

  if (confirmPaid) {
    console.log(JSON.stringify({ ok:true, ts, action:'skip_paid_confirmed', stage, instance_id, delivery_id }, null, 2));
    return;
  }

  // Sanitize WhatsApp provisioning state on the instance (no reimage) to ensure next user can generate a fresh QR.
  // If sanitize fails, leave instance as NEEDS_VERIFY and proceed to release.
  let sanitize = null;
  try {
    sanitize = postJson(`${API_BASE}/api/ops/pool/wa-sanitize`, { instance_id });
  } catch {
    sanitize = { ok:false, error:'wa_sanitize_call_failed' };
  }

  // Enqueue pool reimage+init so the instance truly returns to READY.
  let initJob = null;
  try {
    initJob = postJson(`${API_BASE}/api/ops/pool/init`, { instance_id, mode: 'reimage_and_init' });
  } catch {
    initJob = { ok:false, error:'pool_init_call_failed' };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE deliveries SET status=?, instance_id=NULL, updated_at=?, meta_json=? WHERE delivery_id=?')
      .run('PAYMENT_TIMEOUT', ts, mergeMeta(chosen.delivery_meta, { timeout_stage: stage, timeout_at: ts, reclaim_plan: 'reimage_and_init' }), delivery_id);

    db.prepare(
      `UPDATE instances
          SET lifecycle_status='IN_POOL',
              health_status='NEEDS_VERIFY',
              assigned_user_id=NULL,
              assigned_order_id=NULL,
              assigned_at=NULL,
              meta_json=?
        WHERE instance_id=?`
    ).run(mergeMeta(chosen.instance_meta, { released_by: 'delivery_watchdog', released_at: ts, timeout_stage: stage }), instance_id);

    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), ts, 'delivery', delivery_id, 'DELIVERY_HARD_UNPAID_RECLAIM', JSON.stringify({ instance_id, sanitize, initJob }));
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  tgSend(`[bothook][watchdog] hard reclaim (unpaid>=20m): released + init(enqueued) instance=${instance_id} delivery=${delivery_id}`);
  console.log(JSON.stringify({ ok:true, ts, action:'hard_reclaim_unpaid', stage, instance_id, delivery_id, sanitize, initJob }, null, 2));
}

main();
