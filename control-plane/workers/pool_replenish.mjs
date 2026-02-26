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
const FALLBACK_BUNDLES = (process.env.BOTHOOK_POOL_BUNDLE_FALLBACKS || '').split(',').map(s=>s.trim()).filter(Boolean);
const MIN_CPU = parseInt(process.env.BOTHOOK_POOL_MIN_CPU || '2', 10);
const MIN_MEM_GB = parseInt(process.env.BOTHOOK_POOL_MIN_MEM_GB || '2', 10);
// Cost guard: by default, do not create bundles larger than 2GB RAM.
// This prevents accidental 8GB bundles when the cheapest bundle is temporarily unavailable.
const MAX_MEM_GB = parseInt(process.env.BOTHOOK_POOL_MAX_MEM_GB || '2', 10);
// Hard cost ceiling (CNY/month, DiscountPrice) for pool instances.
const MAX_PRICE_CNY = parseFloat(process.env.BOTHOOK_POOL_MAX_PRICE_CNY || '50');
// Optional allowlist (comma-separated). If set, ONLY these bundles are allowed.
const BUNDLE_ALLOWLIST = (process.env.BOTHOOK_POOL_BUNDLE_ALLOWLIST || '').split(',').map(s=>s.trim()).filter(Boolean);
const BUNDLE_CACHE_PATH = process.env.BOTHOOK_POOL_BUNDLE_CACHE_PATH || '/tmp/bothook_bundle_cache.json';
const BUNDLE_CACHE_TTL_MS = parseInt(process.env.BOTHOOK_POOL_BUNDLE_CACHE_TTL_MS || String(30*60*1000), 10);
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
  const out = sh(`curl -s --max-time 8 -X POST ${JSON.stringify(url)} -H 'content-type: application/json' --data-binary ${JSON.stringify(payload)}`);
  return JSON.parse(out);
}

function getJson(url) {
  const out = sh(`curl -s --max-time 2 ${JSON.stringify(url)}`);
  return JSON.parse(out || '{}');
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

function getBundlesFromCache() {
  try {
    const j = JSON.parse(fs.readFileSync(BUNDLE_CACHE_PATH, 'utf8'));
    if (!j?.ts || !Array.isArray(j.bundles)) return null;
    if ((Date.now() - Date.parse(j.ts)) > BUNDLE_CACHE_TTL_MS) return null;
    return j.bundles.map(String).filter(Boolean);
  } catch { return null; }
}

function setBundlesCache(bundles) {
  try {
    fs.writeFileSync(BUNDLE_CACHE_PATH, JSON.stringify({ ts: new Date().toISOString(), bundles }, null, 2));
  } catch {}
}

function pickCheapestBundles() {
  const cached = getBundlesFromCache();
  if (cached?.length) return cached;

  const txt = tccli(`tccli lighthouse DescribeBundles --region ${REGION} --output json`);
  const j = JSON.parse(txt);
  const bs = j.BundleSet || [];
  const cand = [];

  for (const b of bs) {
    if (!b?.SupportLinuxUnixPlatform) continue;
    if (String(b?.BundleSalesState || '') !== 'AVAILABLE') continue;
    const cpu = Number(b?.CPU || 0);
    const mem = Number(b?.Memory || 0);
    if (cpu < MIN_CPU) continue;
    if (mem < MIN_MEM_GB) continue;
    if (mem > MAX_MEM_GB) continue;
    const bundleId = String(b.BundleId);
    if (BUNDLE_ALLOWLIST.length && !BUNDLE_ALLOWLIST.includes(bundleId)) continue;
    const price = Number(b?.Price?.InstancePrice?.DiscountPrice ?? b?.Price?.InstancePrice?.OriginalPrice ?? NaN);
    const p = Number.isFinite(price) ? price : 1e18;
    if (Number.isFinite(MAX_PRICE_CNY) && p > MAX_PRICE_CNY) continue;
    cand.push({ bundleId, cpu, mem, price: p });
  }

  cand.sort((a,b)=> (a.price-b.price) || (a.cpu-b.cpu) || (a.mem-b.mem) || a.bundleId.localeCompare(b.bundleId));
  const bundles = cand.map(x=>x.bundleId);
  if (bundles.length) setBundlesCache(bundles);
  return bundles;
}

function main() {
  const { db } = openDb();
  const ts = nowIso();

  // Background repair cadence: even when ready>=target, slowly drain NEEDS_VERIFY.
  // Default: repair at most once per 10 minutes.
  const REPAIR_EVERY_MS = parseInt(process.env.BOTHOOK_POOL_REPAIR_EVERY_MS || String(10*60*1000), 10);
  const REPAIR_STATE_PATH = process.env.BOTHOOK_POOL_REPAIR_STATE_PATH || '/tmp/bothook_pool_repair_state.json';
  let lastRepairAt = 0;
  try { lastRepairAt = Date.parse(JSON.parse(fs.readFileSync(REPAIR_STATE_PATH,'utf8'))?.lastRepairAt || '') || 0; } catch {}

  const total = db.prepare(`SELECT COUNT(*) c FROM instances WHERE lifecycle_status IN ('IN_POOL','ALLOCATED')`).get().c;

  // NOTE: Some instances may be incorrectly left as lifecycle_status=IN_POOL even though they're bound/paid.
  // We must exclude such "reserved" instances from READY pool capacity decisions, otherwise replenisher will stop creating.
  const readyRaw = db.prepare(`SELECT COUNT(*) c FROM instances WHERE lifecycle_status='IN_POOL' AND health_status='READY'`).get().c;
  const reservedRaw = db.prepare(
    `SELECT COUNT(DISTINCT d.instance_id) c
       FROM deliveries d
       JOIN instances i ON i.instance_id = d.instance_id
      WHERE i.lifecycle_status='IN_POOL'
        AND i.health_status='READY'
        AND d.instance_id IS NOT NULL
        AND d.bound_at IS NOT NULL
        AND d.status IN ('ACTIVE','PAID','DELIVERED')`
  ).get().c;

  const reserved = Number(reservedRaw || 0);
  const ready = Math.max(0, Number(readyRaw || 0) - reserved);

  const needs = db.prepare(`SELECT instance_id FROM instances WHERE lifecycle_status='IN_POOL' AND health_status='NEEDS_VERIFY' ORDER BY last_probe_at ASC NULLS FIRST LIMIT 1`).get();

  if (total >= WARN_THRESHOLD) {
    tgSend(`[bothook] pool nearing cap: total=${total}/${CAP_TOTAL}, ready=${ready}/${TARGET_READY} (raw_ready=${readyRaw}, reserved=${reserved})`);
  }

  if (ready >= TARGET_READY) {
    // If READY target is met, we still do a slow background repair of NEEDS_VERIFY.
    const nowMs = Date.now();
    const due = (nowMs - lastRepairAt) >= REPAIR_EVERY_MS;
    if (!due) {
      console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'ready_sufficient', total, ready, raw_ready: readyRaw, reserved, needs_verify: Boolean(needs?.instance_id), next_repair_in_ms: Math.max(0, REPAIR_EVERY_MS - (nowMs - lastRepairAt)) }, null, 2));
      return;
    }

    if (needs?.instance_id) {
      const instance_id = String(needs.instance_id);
      const job = postJson(`${API_BASE}/api/ops/pool/init`, { instance_id, mode: 'init_only' });
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_BACKGROUND_REPAIR_TRIGGERED', JSON.stringify({ job, cadence_ms: REPAIR_EVERY_MS }));
      try { fs.writeFileSync(REPAIR_STATE_PATH, JSON.stringify({ lastRepairAt: ts }, null, 2)); } catch {}
      console.log(JSON.stringify({ ok:true, ts, action:'background_repair', instance_id, job, cadence_ms: REPAIR_EVERY_MS }, null, 2));
      return;
    }

    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'ready_sufficient_no_needs_verify', total, ready, raw_ready: readyRaw, reserved }, null, 2));
    return;
  }

  if (total >= CAP_TOTAL) {
    tgSend(`[bothook][WARN] pool blocked by cap: total=${total}/${CAP_TOTAL}, ready=${ready}/${TARGET_READY} (raw_ready=${readyRaw}, reserved=${reserved})`);
    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'cap_reached', total, ready, raw_ready: readyRaw, reserved }, null, 2));
    return;
  }

  // Suppress cloud creates while pool init jobs are active (maintenance bursts).
  // During manual/batch init, some READY nodes will temporarily flip to NEEDS_VERIFY; do not overreact by creating new instances.
  try {
    const busy = getJson(`${API_BASE}/api/ops/pool/init/busy`);
    if (busy?.busy || (Number(busy?.active || 0) > 0)) {
      console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'init_busy_suppress_create', total, ready, raw_ready: readyRaw, reserved, active_init: Number(busy?.active||0) }, null, 2));
      return;
    }
  } catch {
    // Fail-closed: if busy signal is unreachable (e.g. API server blocked by a long init),
    // suppress create to avoid over-provision.
    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'init_busy_suppress_create_unreachable', total, ready, raw_ready: readyRaw, reserved }, null, 2));
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

  const cheapest = pickCheapestBundles();
  // If allowlist is set, only try allowlisted bundles.
  const baseList = BUNDLE_ALLOWLIST.length ? BUNDLE_ALLOWLIST : [DEFAULT_BUNDLE_ID, ...FALLBACK_BUNDLES, ...cheapest];
  const bundlesToTry = baseList.filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 8); // avoid huge loops

  let resp = null;
  let usedBundle = null;

  // Try zone rotation too (some zones may be out of stock)
  const zonesToTry = (zone ? [zone, ...ZONES] : [...ZONES]).filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 3);

  for (const bundleId of bundlesToTry) {
    for (const z of zonesToTry.length ? zonesToTry : [null]) {
      const payload = {
        BundleId: bundleId,
        BlueprintId: BLUEPRINT_ID,
        // Pool policy: default auto-renew ON (monthly) to avoid cloud-expiry vs subscription mismatch.
        InstanceChargePrepaid: { Period: 1, RenewFlag: 'NOTIFY_AND_AUTO_RENEW' },
        InstanceName: name,
        InstanceCount: 1,
        Zones: z ? [z] : undefined,
        ClientToken: clientToken
      };

      const tmp = `/tmp/bothook_create_${clientToken}.json`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      try {
        const json = tccli(`tccli lighthouse CreateInstances --region ${REGION} --cli-input-json file://${tmp} --output json`);
        resp = JSON.parse(json);
        usedBundle = bundleId;
        break;
      } catch (e) {
        const s = String(e?._stderr || e?.message || e);
        if (s.includes('InstanceQuotaLimitExceeded') || s.includes('LimitExceeded')) {
          // try next zone/bundle
          continue;
        }
        tgSend(`[bothook][WARN] pool create failed bundle=${bundleId} zone=${z||''}: ${s.slice(0,180)}`);
        throw e;
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
    if (resp) break;
  }

  if (!resp) {
    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'cloud_quota_all_bundles', total, ready, bundlesToTry }, null, 2));
    return;
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
  ).run(instance_id, 'tencent_lighthouse', REGION, zone, usedBundle || DEFAULT_BUNDLE_ID, BLUEPRINT_ID, 'IN_POOL', 'NEEDS_VERIFY', ts, JSON.stringify({ created_by:'pool_replenish', client_token: clientToken }));

  db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
    .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_INSTANCE_CREATED', JSON.stringify({ bundle_id: DEFAULT_BUNDLE_ID, blueprint_id: BLUEPRINT_ID, zone, request_id: resp.RequestId }));

  const job = postJson(`${API_BASE}/api/ops/pool/init`, { instance_id, mode: 'init_only' });
  console.log(JSON.stringify({ ok:true, ts, action:'create_and_init', instance_id, zone, job }, null, 2));
}

main();
