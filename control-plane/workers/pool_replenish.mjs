#!/usr/bin/env node
/**
 * pool_replenish.mjs
 *
 * Maintain pool capacity.
 * Policy:
 * - target_ready=5 (IN_POOL+READY)
 * - cap_total=20 (all instances count incl. ALLOCATED)
 * - Prefer repairing existing IN_POOL+NEEDS_VERIFY first (via /api/ops/pool/init)
 * - Otherwise create 1 new Lighthouse instance and then init it.
 * - Heavy concurrency=1 (enforced by systemd flock)
 *
 * Alerts:
 * - When total >= warn_threshold, send Telegram alert.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { openDb, nowIso } from '../lib/db.mjs';

const API_BASE = process.env.BOTHOOK_API_BASE || 'http://127.0.0.1:18998';
const REGION = process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore';
const BLUEPRINT_ID = process.env.BOTHOOK_REIMAGE_BLUEPRINT_ID || 'lhbp-1l4ptuvm';
const DEFAULT_BUNDLE_ID = process.env.BOTHOOK_POOL_BUNDLE_ID || 'bundle_rs_nmc_lin_med2_01';
const ZONES = (process.env.BOTHOOK_POOL_ZONES || 'ap-singapore-1,ap-singapore-3').split(',').map(s=>s.trim()).filter(Boolean);

const TARGET_READY = parseInt(process.env.BOTHOOK_POOL_TARGET_READY || '5', 10);
const CAP_TOTAL = parseInt(process.env.BOTHOOK_POOL_CAP_TOTAL || '20', 10);
const WARN_THRESHOLD = parseInt(process.env.BOTHOOK_POOL_WARN_TOTAL || String(Math.max(1, CAP_TOTAL-2)), 10);

const TELEGRAM_ENV = process.env.TELEGRAM_ENV || '/home/ubuntu/.openclaw/credentials/telegram.env';

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: '/bin/bash' });
  } catch (e) {
    const stderr = String(e?.stderr || '');
    const stdout = String(e?.stdout || '');
    const msg = String(e?.message || e);
    const err = new Error([msg, stdout, stderr].filter(Boolean).join('\n'));
    err._stderr = stderr;
    err._stdout = stdout;
    throw err;
  }
}

function tccli(cmd) {
  const envFile = '/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env';
  const full = `set -a; source ${envFile}; set +a; ${cmd}`;
  return sh(full);
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
  const env = loadEnvFile(TELEGRAM_ENV);
  const token = env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID || env.OWNER_CHAT_ID;
  if (!token || !chatId) return { ok:false, error:'telegram_not_configured' };
  // best-effort
  try {
    sh(`curl -s -X POST https://api.telegram.org/bot${token}/sendMessage -d chat_id=${chatId} -d text=${JSON.stringify(text)} >/dev/null`);
    return { ok:true };
  } catch { return { ok:false, error:'telegram_send_failed' }; }
}

function chooseZone() {
  if (!ZONES.length) return null;
  const i = Math.floor(Math.random() * ZONES.length);
  return ZONES[i];
}

function main() {
  const { db } = openDb();
  const ts = nowIso();

  const total = db.prepare(`SELECT COUNT(*) c FROM instances WHERE lifecycle_status IN ('IN_POOL','ALLOCATED')`).get().c;
  const ready = db.prepare(`SELECT COUNT(*) c FROM instances WHERE lifecycle_status='IN_POOL' AND health_status='READY'`).get().c;
  const needs = db.prepare(`SELECT instance_id FROM instances WHERE lifecycle_status='IN_POOL' AND health_status='NEEDS_VERIFY' ORDER BY last_probe_at ASC NULLS FIRST LIMIT 1`).get();

  if (total >= WARN_THRESHOLD) {
    tgSend(`[bothook] pool nearing cap: total=${total}/${CAP_TOTAL}, ready=${ready}/${TARGET_READY}`);
  }

  if (ready >= TARGET_READY) {
    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'ready_sufficient', total, ready }, null, 2));
    return;
  }

  if (total >= CAP_TOTAL) {
    tgSend(`[bothook][WARN] pool blocked by cap: total=${total}/${CAP_TOTAL}, ready=${ready}/${TARGET_READY}`);
    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'cap_reached', total, ready }, null, 2));
    return;
  }

  // Prefer repairing NEEDS_VERIFY
  if (needs?.instance_id) {
    const instance_id = String(needs.instance_id);
    const job = postJson(`${API_BASE}/api/ops/pool/init`, { instance_id, mode: 'init_only' });
    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_REPAIR_TRIGGERED', JSON.stringify({ job }));
    console.log(JSON.stringify({ ok:true, ts, action:'repair', instance_id, job }, null, 2));
    return;
  }

  // Create one new instance
  const zone = chooseZone();
  const name = `bothook-pool-${ts.replace(/[:.]/g,'-')}`;
  const clientToken = crypto.randomUUID();
  const payload = {
    BundleId: DEFAULT_BUNDLE_ID,
    BlueprintId: BLUEPRINT_ID,
    InstanceChargePrepaid: { Period: 1, RenewFlag: 'NOTIFY_AND_MANUAL_RENEW' },
    InstanceName: name,
    InstanceCount: 1,
    Zones: zone ? [zone] : undefined,
    ClientToken: clientToken
  };

  const tmp = `/tmp/bothook_create_${clientToken}.json`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  let resp = null;
  try {
    const json = tccli(`tccli lighthouse CreateInstances --region ${REGION} --cli-input-json file://${tmp} --output json`);
    resp = JSON.parse(json);
  } catch (e) {
    const s = String(e?._stderr || e?.message || e);
    // Quota / limit exceeded: alert + noop (do not crash timer)
    if (s.includes('InstanceQuotaLimitExceeded') || s.includes('LimitExceeded')) {
      tgSend(`[bothook][WARN] pool create blocked by cloud quota: total=${total}/${CAP_TOTAL}, ready=${ready}/${TARGET_READY}`);
      console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'cloud_quota', detail: s.slice(0,400) }, null, 2));
      return;
    }
    tgSend(`[bothook][WARN] pool create failed: ${s.slice(0,200)}`);
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }

  const ids = resp.InstanceIdSet || [];
  const instance_id = String(ids[0] || '').trim();
  if (!instance_id) throw new Error('create_instances_no_id');

  // Upsert minimal DB row so ops/init can find it
  db.prepare(
    `INSERT INTO instances(instance_id, provider, region, zone, bundle_id, blueprint_id, lifecycle_status, health_status, created_at, meta_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(instance_id) DO UPDATE SET
       provider=excluded.provider,
       region=excluded.region,
       zone=excluded.zone,
       bundle_id=excluded.bundle_id,
       blueprint_id=excluded.blueprint_id,
       lifecycle_status='IN_POOL',
       health_status='NEEDS_VERIFY'`
  ).run(instance_id, 'tencent_lighthouse', REGION, zone, DEFAULT_BUNDLE_ID, BLUEPRINT_ID, 'IN_POOL', 'NEEDS_VERIFY', ts, JSON.stringify({ created_by:'pool_replenish', client_token: clientToken }));

  db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
    .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_INSTANCE_CREATED', JSON.stringify({ bundle_id: DEFAULT_BUNDLE_ID, blueprint_id: BLUEPRINT_ID, zone, request_id: resp.RequestId }));

  const job = postJson(`${API_BASE}/api/ops/pool/init`, { instance_id, mode: 'init_only' });
  console.log(JSON.stringify({ ok:true, ts, action:'create_and_init', instance_id, zone, job }, null, 2));
}

main();
