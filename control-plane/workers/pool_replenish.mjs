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
// Default region is only used as a fallback; pool replenisher can operate cross-region.
const DEFAULT_REGION = process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore';
// Lighthouse API version (recommended by tccli help)
const API_VERSION = process.env.BOTHOOK_CLOUD_API_VERSION || '2020-03-24';
const BLUEPRINT_ID = process.env.BOTHOOK_REIMAGE_BLUEPRINT_ID || 'lhbp-1l4ptuvm';

// Cross-region compatibility
const POOL_SSH_PUB_PATH = process.env.BOTHOOK_POOL_SSH_PUB_PATH || '/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519.pub';
// Fingerprinted key name avoids cross-account / cross-region name collisions.
const _pubForName = (()=>{ try { return fs.readFileSync(POOL_SSH_PUB_PATH,'utf8').trim(); } catch { return ''; } })();
const _fp8 = _pubForName ? crypto.createHash('sha256').update(_pubForName).digest('hex').slice(0,8) : 'unknown';
const POOL_KEY_NAME = process.env.BOTHOOK_POOL_KEY_NAME || `bothook_pool_key_${_fp8}`;
const DRY_RUN = String(process.env.BOTHOOK_POOL_REPLENISH_DRY_RUN || '') === '1';

// Region selection policy:
// - BOTHOOK_POOL_REGIONS=auto_non_cn (default): discover all Lighthouse regions and exclude China regions.
// - BOTHOOK_POOL_REGIONS=<region> OR <comma-separated>: only consider these regions.
// - BOTHOOK_POOL_REGIONS=single: use DEFAULT_REGION only.
const POOL_REGIONS_MODE = String(process.env.BOTHOOK_POOL_REGIONS || 'auto_non_cn').trim();
const POOL_REGIONS_EXPLICIT = (!POOL_REGIONS_MODE || ['auto_non_cn','single'].includes(POOL_REGIONS_MODE))
  ? []
  : POOL_REGIONS_MODE.split(',').map(s=>s.trim()).filter(Boolean);
const REGION_CACHE_PATH = process.env.BOTHOOK_POOL_REGION_CACHE_PATH || '/tmp/bothook_region_cache.json';
const REGION_CACHE_TTL_MS = parseInt(process.env.BOTHOOK_POOL_REGION_CACHE_TTL_MS || String(6*60*60*1000), 10);

// Bundle selection policy:
// - Prefer dynamic cheapest bundle list from DescribeBundles (filtered by CPU/MEM/MAX_PRICE)
// - If BUNDLE_ALLOWLIST is set, ONLY those bundles are allowed
// - If DescribeBundles yields none (rare), fall back to env BOTHOOK_POOL_BUNDLE_FALLBACKS
const FALLBACK_BUNDLES = (process.env.BOTHOOK_POOL_BUNDLE_FALLBACKS || '')
  .split(',').map(s=>s.trim()).filter(Boolean)
  .filter((v,i,a)=>a.indexOf(v)===i);

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
// Zones are optional; in cross-region mode we default to not specifying Zones.
const ZONES = (process.env.BOTHOOK_POOL_ZONES || '').split(',').map(s=>s.trim()).filter(Boolean);

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

// Map bundle type → quota bucket name for DescribeGeneralResourceQuotas
function quotaResourceNameForBundleType(bundleType) {
  const t = String(bundleType || '').trim();
  const m = {
    GENERAL_BUNDLE: 'GENERAL_BUNDLE_INSTANCE',
    STARTER_BUNDLE: 'STARTER_BUNDLE_INSTANCE',
    ECONOMY_BUNDLE: 'ECONOMY_BUNDLE_INSTANCE',
    BUDGET_BUNDLE: 'BUDGET_BUNDLE_INSTANCE',
    BANDWIDTH_BUNDLE: 'BANDWIDTH_BUNDLE_INSTANCE',
    RAZOR_SPEED_BUNDLE: 'RAZOR_SPEED_BUNDLE_INSTANCE',
    EXCLUSIVE_BUNDLE_02: 'EXCLUSIVE_BUNDLE_02_INSTANCE',
    EXCLUSIVE_BUNDLE: 'EXCLUSIVE_BUNDLE_INSTANCE',
    HK_EXCLUSIVE_BUNDLE: 'HK_EXCLUSIVE_BUNDLE_INSTANCE',
    CAREFREE_BUNDLE: 'CAREFREE_BUNDLE_INSTANCE',
    NEWCOMER_BUNDLE: 'NEWCOMER_BUNDLE_INSTANCE',
  };
  return m[t] || null;
}

const _quotaCache = new Map(); // key: `${region}:${resourceName}` -> { tsMs, avail, total }
function getQuota(region, resourceName) {
  const key = `${region}:${resourceName}`;
  const hit = _quotaCache.get(key);
  if (hit && (Date.now() - hit.tsMs) < 60_000) return hit;

  const txt = tccli(`tccli lighthouse DescribeGeneralResourceQuotas --region ${region} --version ${API_VERSION} --ResourceNames '["${resourceName}"]' --output json`);
  const j = JSON.parse(txt);
  const row = (j.GeneralResourceQuotaSet || [])[0] || null;
  const out = {
    tsMs: Date.now(),
    avail: Number(row?.ResourceQuotaAvailable ?? 0),
    total: Number(row?.ResourceQuotaTotal ?? 0),
  };
  _quotaCache.set(key, out);
  return out;
}

const _keyByRegionCachePath = process.env.BOTHOOK_POOL_KEY_BY_REGION_CACHE_PATH || '/tmp/bothook_pool_key_by_region.json';
function resolveOrImportKeyId(region) {
  // Cache format: { ts, byRegion: { [region]: { keyName, keyId } } }
  try {
    const c = JSON.parse(fs.readFileSync(_keyByRegionCachePath, 'utf8'));
    const e = c?.byRegion?.[region];
    if (e?.keyName === POOL_KEY_NAME && e?.keyId) return String(e.keyId);
  } catch {}

  const listTxt = tccli(`tccli lighthouse DescribeKeyPairs --region ${region} --version ${API_VERSION} --output json`);
  const list = JSON.parse(listTxt);
  const ks = list.KeyPairSet || [];
  const hit = ks.find(k => String(k?.KeyName || '') === POOL_KEY_NAME);
  let keyId = hit?.KeyId ? String(hit.KeyId) : null;

  if (!keyId) {
    const pub = fs.readFileSync(POOL_SSH_PUB_PATH, 'utf8').trim();
    const payload = { KeyName: POOL_KEY_NAME, PublicKey: pub };
    const tmp = `/tmp/bothook_import_key_${region}_${Date.now()}.json`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    try {
      const itxt = tccli(`tccli lighthouse ImportKeyPair --region ${region} --version ${API_VERSION} --cli-input-json file://${tmp} --output json`);
      const ij = JSON.parse(itxt);
      keyId = String(ij?.KeyId || '');
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  if (!keyId) throw new Error(`resolve_key_id_failed region=${region} keyName=${POOL_KEY_NAME}`);

  try {
    const cur = (()=>{ try { return JSON.parse(fs.readFileSync(_keyByRegionCachePath,'utf8')); } catch { return {}; } })();
    cur.ts = new Date().toISOString();
    cur.byRegion = cur.byRegion || {};
    cur.byRegion[region] = { keyName: POOL_KEY_NAME, keyId };
    fs.writeFileSync(_keyByRegionCachePath, JSON.stringify(cur, null, 2));
  } catch {}

  return keyId;
}

const _blueprintCachePath = process.env.BOTHOOK_BLUEPRINT_BY_REGION_CACHE_PATH || '/tmp/bothook_blueprint_by_region.json';
function pickUbuntuBlueprintId(region) {
  try {
    const c = JSON.parse(fs.readFileSync(_blueprintCachePath, 'utf8'));
    const e = c?.byRegion?.[region];
    if (e?.blueprintId) return String(e.blueprintId);
  } catch {}

  const txt = tccli(`tccli lighthouse DescribeBlueprints --region ${region} --version ${API_VERSION} --output json`);
  const j = JSON.parse(txt);
  const bs = j.BlueprintSet || [];
  const cand = [];
  for (const b of bs) {
    const id = String(b?.BlueprintId || '').trim();
    const name = String(b?.BlueprintName || '').trim();
    const plat = String(b?.Platform || '').trim();
    const btype = String(b?.BlueprintType || '').trim();
    if (!id || !name) continue;
    if (plat && plat !== 'LINUX') continue;
    if (btype && btype !== 'PUBLIC_IMAGE') continue;
    if (!/ubuntu/i.test(name)) continue;
    cand.push({ id, name });
  }
  // Prefer newer Ubuntu versions by name; fallback first.
  cand.sort((a,b)=> b.name.localeCompare(a.name));
  const chosen = cand[0]?.id || null;
  if (!chosen) return BLUEPRINT_ID; // fallback

  try {
    const cur = (()=>{ try { return JSON.parse(fs.readFileSync(_blueprintCachePath,'utf8')); } catch { return {}; } })();
    cur.ts = new Date().toISOString();
    cur.byRegion = cur.byRegion || {};
    cur.byRegion[region] = { blueprintId: chosen, blueprintName: cand[0]?.name || null };
    fs.writeFileSync(_blueprintCachePath, JSON.stringify(cur, null, 2));
  } catch {}

  return chosen;
}

function chooseZone() {
  if (!ZONES.length) return null;
  const i = Math.floor(Math.random() * ZONES.length);
  return ZONES[i];
}

function getRegionsFromCache() {
  try {
    const j = JSON.parse(fs.readFileSync(REGION_CACHE_PATH, 'utf8'));
    if (!j?.ts || !Array.isArray(j.regions)) return null;
    if ((Date.now() - Date.parse(j.ts)) > REGION_CACHE_TTL_MS) return null;
    return j.regions.map(String).map(s=>s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function setRegionsCache(regions) {
  try {
    fs.writeFileSync(REGION_CACHE_PATH, JSON.stringify({ ts: new Date().toISOString(), regions }, null, 2));
  } catch {}
}

function listNonChinaRegions() {
  const cached = getRegionsFromCache();
  if (cached?.length) return cached;

  const txt = tccli(`tccli lighthouse DescribeRegions --version ${API_VERSION} --output json`);
  const j = JSON.parse(txt);
  const rs = j.RegionSet || j.Regions || [];

  // Tencent CN Lighthouse regions (not exhaustive, but covers common ones)
  const china = new Set(['ap-guangzhou','ap-shanghai','ap-beijing','ap-chengdu','ap-nanjing','ap-chongqing']);
  const out = [];
  for (const r of rs) {
    const rid = String(r?.Region || r?.RegionId || r?.RegionName || '').trim();
    if (!rid) continue;
    if (china.has(rid)) continue;
    out.push(rid);
  }
  const regions = Array.from(new Set(out)).sort();
  if (regions.length) setRegionsCache(regions);
  return regions;
}

function pickCreateRegions() {
  if (POOL_REGIONS_EXPLICIT.length) return POOL_REGIONS_EXPLICIT;
  if (POOL_REGIONS_MODE === 'single') return [DEFAULT_REGION];
  // default
  return listNonChinaRegions();
}

function getBundlesFromCache() {
  try {
    const j = JSON.parse(fs.readFileSync(BUNDLE_CACHE_PATH, 'utf8'));
    if (!j?.ts) return null;
    if ((Date.now() - Date.parse(j.ts)) > BUNDLE_CACHE_TTL_MS) return null;

    // Backward compatible:
    // - v1: { ts, bundles: [bundleId,...] }
    // - v2: { ts, bundles: [{ bundleId, price }, ...] }
      if (Array.isArray(j.bundles) && j.bundles.length && typeof j.bundles[0] === 'string') {
      const out = j.bundles
        .map((bundleId) => ({ bundleId: String(bundleId || '').trim(), price: null }))
        .filter((x) => x.bundleId);
      out._region = String(j.region || '').trim() || null;
      return out;
    }

    if (Array.isArray(j.bundles) && j.bundles.length && typeof j.bundles[0] === 'object') {
      const out = j.bundles
        .map((x) => ({
          bundleId: String(x?.bundleId || '').trim(),
          price: (typeof x?.price === 'number' && Number.isFinite(x.price)) ? x.price : null
        }))
        .filter((x) => x.bundleId);
      out._region = String(j.region || '').trim() || null;
      return out;
    }

    return null;
  } catch {
    return null;
  }
}

function setBundlesCache(region, bundlesDetailed) {
  try {
    // bundlesDetailed: [{ bundleId, price }]
    fs.writeFileSync(BUNDLE_CACHE_PATH, JSON.stringify({ ts: new Date().toISOString(), region, bundles: bundlesDetailed }, null, 2));
  } catch {}
}

function pickCheapestBundlesDetailed(region) {
  const cached = getBundlesFromCache();
  // Cache is per-region; if cache contains a different region, ignore.
  if (cached?.length && cached._region && cached._region === region) return cached;

  const txt = tccli(`tccli lighthouse DescribeBundles --region ${region} --version ${API_VERSION} --output json`);
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
    const bundleType = String(b?.BundleType || '').trim() || null;
    cand.push({ bundleId, cpu, mem, price: p, bundleType });
  }

  cand.sort((a,b)=> (a.price-b.price) || (a.cpu-b.cpu) || (a.mem-b.mem) || a.bundleId.localeCompare(b.bundleId));

  const bundlesDetailed = cand.map(x => ({ bundleId: x.bundleId, price: x.price, bundleType: x.bundleType }));
  if (bundlesDetailed.length) setBundlesCache(region, bundlesDetailed);
  return bundlesDetailed;
}

function pickCheapestBundleAcrossRegions(regions) {
  const out = [];
  for (const region of regions) {
    try {
      const detailed = pickCheapestBundlesDetailed(region);
      if (!detailed?.length) continue;

      // Pick the cheapest bundle in this region that also has quota available in its bucket.
      let chosen = null;
      for (const b of detailed.slice(0, 12)) {
        if (!b?.bundleId) continue;
        const resName = quotaResourceNameForBundleType(b.bundleType);
        if (!resName) continue; // unknown bucket; skip (fail-closed)
        const q = getQuota(region, resName);
        if ((q?.avail ?? 0) > 0) {
          chosen = { region, bundleId: b.bundleId, price: b.price, bundleType: b.bundleType, quota: { resourceName: resName, avail: q.avail, total: q.total } };
          break;
        }
      }
      if (chosen) out.push(chosen);
    } catch {
      // ignore region failures; keep going
    }
  }

  out.sort((a,b) => (Number(a.price||1e18) - Number(b.price||1e18)) || String(a.region).localeCompare(String(b.region)));
  return out[0] || null;
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
  const manualRaw = db.prepare(`SELECT COUNT(*) c FROM instances WHERE lifecycle_status='IN_POOL' AND health_status='NEEDS_MANUAL'`).get().c;
  const manual = Number(manualRaw || 0);

  if (total >= WARN_THRESHOLD) {
    tgSend(`[bothook] pool nearing cap: total=${total}/${CAP_TOTAL}, ready=${ready}/${TARGET_READY} (raw_ready=${readyRaw}, reserved=${reserved}, manual=${manual})`);
  }

  // Owner rule: if raw_ready >= target, NEVER create new instances.
  // (Even if some are temporarily "reserved" by bound deliveries.)
  if (readyRaw >= TARGET_READY) {
    // If raw READY target is met, we still do a slow background repair of NEEDS_VERIFY.
    const nowMs = Date.now();
    const due = (nowMs - lastRepairAt) >= REPAIR_EVERY_MS;
    if (!due) {
      console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'raw_ready_sufficient', total, ready, raw_ready: readyRaw, reserved, manual, needs_verify: Boolean(needs?.instance_id), next_repair_in_ms: Math.max(0, REPAIR_EVERY_MS - (nowMs - lastRepairAt)) }, null, 2));
      return;
    }

    if (needs?.instance_id) {
      const instance_id = String(needs.instance_id);
      // Cooldown: avoid spamming init enqueues while a job is already queued/running.
      const ENQUEUE_COOLDOWN_MS = parseInt(process.env.BOTHOOK_POOL_INIT_ENQUEUE_COOLDOWN_MS || String(5*60*1000), 10);
      const inflight = db.prepare(
        `SELECT job_id, status, created_at
           FROM pool_init_jobs
          WHERE instance_id=?
            AND status IN ('QUEUED','RUNNING')
          ORDER BY created_at DESC
          LIMIT 1`
      ).get(instance_id);
      if (inflight?.job_id) {
        const ageMs = Date.now() - Date.parse(String(inflight.created_at||''));
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ENQUEUE_COOLDOWN_MS) {
          console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'background_repair_inflight_cooldown', total, ready, raw_ready: readyRaw, reserved, manual, instance_id, inflight_job_id: inflight.job_id, inflight_status: inflight.status, inflight_age_ms: ageMs, cadence_ms: REPAIR_EVERY_MS }, null, 2));
          return;
        }
      }

      const job = postJson(`${API_BASE}/api/ops/pool/init`, { instance_id, mode: 'init_only' });
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_BACKGROUND_REPAIR_TRIGGERED', JSON.stringify({ job, cadence_ms: REPAIR_EVERY_MS }));
      try { fs.writeFileSync(REPAIR_STATE_PATH, JSON.stringify({ lastRepairAt: ts }, null, 2)); } catch {}
      console.log(JSON.stringify({ ok:true, ts, action:'background_repair', instance_id, job, cadence_ms: REPAIR_EVERY_MS }, null, 2));
      return;
    }

    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'raw_ready_sufficient_no_needs_verify', total, ready, raw_ready: readyRaw, reserved, manual }, null, 2));
    return;
  }

  if (total >= CAP_TOTAL) {
    tgSend(`[bothook][WARN] pool blocked by cap: total=${total}/${CAP_TOTAL}, ready=${ready}/${TARGET_READY} (raw_ready=${readyRaw}, reserved=${reserved}, manual=${manual})`);
    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'cap_reached', total, ready, raw_ready: readyRaw, reserved, manual }, null, 2));
    return;
  }

  // Hard guard: if any instance is flagged NEEDS_MANUAL, suppress cloud creates.
  // We still allow repair of NEEDS_VERIFY; but we do not "create our way out" of manual problems.
  // Implementation detail: allow the repair path below to run, but block the create path later.
  const manualBlocked = manual > 0;
  if (manualBlocked) {
    tgSend(`[bothook][WARN] pool create suppressed: manual=${manual} total=${total}/${CAP_TOTAL}, ready=${ready}/${TARGET_READY}`);
    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'manual_blocked_suppress_create', total, ready, raw_ready: readyRaw, reserved, manual }, null, 2));
  }

  // Suppress cloud creates while pool init jobs are active (maintenance bursts).
  // During manual/batch init, some READY nodes will temporarily flip to NEEDS_VERIFY; do not overreact by creating new instances.
  try {
    const busy = getJson(`${API_BASE}/api/ops/pool/init/busy`);
    if (busy?.busy || (Number(busy?.active || 0) > 0)) {
      console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'init_busy_suppress_create', total, ready, raw_ready: readyRaw, reserved, manual, active_init: Number(busy?.active||0) }, null, 2));
      return;
    }
  } catch {
    // Fail-closed: if busy signal is unreachable (e.g. API server blocked by a long init),
    // suppress create to avoid over-provision.
    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'init_busy_suppress_create_unreachable', total, ready, raw_ready: readyRaw, reserved, manual }, null, 2));
    return;
  }

  // Prefer repairing NEEDS_VERIFY
  if (needs?.instance_id) {
    const instance_id = String(needs.instance_id);

    // Cooldown: do not enqueue init for the same instance too frequently.
    // New instances can take time before SSH is reachable; repeated enqueues just create noise.
    const ENQUEUE_COOLDOWN_MS = parseInt(process.env.BOTHOOK_POOL_INIT_ENQUEUE_COOLDOWN_MS || String(5*60*1000), 10);
    const inflight = db.prepare(
      `SELECT job_id, status, created_at
         FROM pool_init_jobs
        WHERE instance_id=?
          AND status IN ('QUEUED','RUNNING')
        ORDER BY created_at DESC
        LIMIT 1`
    ).get(instance_id);
    if (inflight?.job_id) {
      const ageMs = Date.now() - Date.parse(String(inflight.created_at||''));
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ENQUEUE_COOLDOWN_MS) {
        console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'init_job_inflight_cooldown', total, ready, raw_ready: readyRaw, reserved, manual, instance_id, inflight_job_id: inflight.job_id, inflight_status: inflight.status, inflight_age_ms: ageMs }, null, 2));
        return;
      }
    }

    const job = postJson(`${API_BASE}/api/ops/pool/init`, { instance_id, mode: 'init_only' });
    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_REPAIR_TRIGGERED', JSON.stringify({ job }));

    // If repair is blocked because the instance is still tied to active deliveries, skip repair and proceed to create.
    if (job?.ok === false && String(job?.error || '') === 'active_delivery_conflict') {
      console.log(JSON.stringify({ ok:true, ts, action:'skip_repair', reason:'active_delivery_conflict', instance_id, job, manual }, null, 2));
    } else {
      console.log(JSON.stringify({ ok:true, ts, action:'repair', instance_id, job, manual }, null, 2));
      return;
    }
  }

  // If manual-blocked, stop here. No creates while manual issues exist.
  if (manualBlocked) {
    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'manual_blocked_no_create', total, ready, raw_ready: readyRaw, reserved, manual }, null, 2));
    return;
  }

  // Create one new instance (cross-region, cheapest)
  const name = `bothook-pool-${ts.replace(/[:.]/g,'-')}`;
  const clientToken = crypto.randomUUID();

  const regions = pickCreateRegions();
  const pick = pickCheapestBundleAcrossRegions(regions) || null;
  if (!pick?.region || !pick?.bundleId) {
    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'no_region_bundle_available', total, ready, raw_ready: readyRaw, reserved, manual }, null, 2));
    return;
  }

  const chosenRegion = pick.region;
  const chosenBundleId = pick.bundleId;

  // Resolve region-scoped dependencies so init/SSH won't get stuck.
  const chosenKeyId = resolveOrImportKeyId(chosenRegion);
  const chosenBlueprintId = pickUbuntuBlueprintId(chosenRegion);

  if (DRY_RUN) {
    console.log(JSON.stringify({ ok:true, ts, action:'dry_run', chosenRegion, chosenBundleId, chosenPriceCny: pick.price ?? null, chosenBundleType: pick.bundleType ?? null, quota: pick.quota ?? null, keyId: chosenKeyId, blueprintId: chosenBlueprintId, maxPriceCny: MAX_PRICE_CNY, minCpu: MIN_CPU, minMemGb: MIN_MEM_GB, maxMemGb: MAX_MEM_GB }, null, 2));
    return;
  }

  // Candidate bundles within the chosen region (cheapest first), but prefer the globally-chosen bundle.
  const cheapestDetailed = pickCheapestBundlesDetailed(chosenRegion);
  const priceByBundle = new Map(cheapestDetailed.map(x => [x.bundleId, x.price]));

  const baseList = BUNDLE_ALLOWLIST.length
    ? BUNDLE_ALLOWLIST
    : [
        chosenBundleId,
        ...cheapestDetailed
          .map(x => x.bundleId)
          .filter(Boolean)
      ];

  const bundlesToTry = baseList
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 8); // avoid huge loops

  let resp = null;
  let usedBundle = null;
  let usedZone = null;

  // Zones: optional. If BOTHOOK_POOL_ZONES provided, try those first.
  const zone = chooseZone();
  const zonesToTry = (zone ? [zone, ...ZONES] : [...ZONES]).filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 3);

  for (const bundleId of bundlesToTry) {
    for (const z of (zonesToTry.length ? zonesToTry : [null])) {
      const payload = {
        BundleId: bundleId,
        BlueprintId: chosenBlueprintId,
        KeyIds: [chosenKeyId],
        InstanceChargePrepaid: { Period: 1, RenewFlag: 'NOTIFY_AND_AUTO_RENEW' },
        InstanceName: name,
        InstanceCount: 1,
        Zones: z ? [z] : undefined,
        ClientToken: clientToken
      };

      const tmp = `/tmp/bothook_create_${clientToken}.json`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      try {
        const json = tccli(`tccli lighthouse CreateInstances --region ${chosenRegion} --version ${API_VERSION} --cli-input-json file://${tmp} --output json`);
        resp = JSON.parse(json);
        usedBundle = bundleId;
        usedZone = z || null;
        break;
      } catch (e) {
        const s = String(e?._stderr || e?.message || e);
        if (s.includes('InstanceQuotaLimitExceeded') || s.includes('LimitExceeded')) {
          continue;
        }
        tgSend(`[bothook][WARN] pool create failed region=${chosenRegion} bundle=${bundleId} zone=${z||''}: ${s.slice(0,180)}`);
        throw e;
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
    if (resp) break;
  }

  if (!resp) {
    console.log(JSON.stringify({ ok:true, ts, action:'noop', reason:'cloud_quota_all_bundles', total, ready, raw_ready: readyRaw, reserved, manual, bundlesToTry }, null, 2));
    return;
  }

  const ids = resp.InstanceIdSet || [];
  const instance_id = String(ids[0] || '').trim();
  if (!instance_id) throw new Error('create_instances_no_id');

  const usedPrice = usedBundle ? (priceByBundle.has(usedBundle) ? priceByBundle.get(usedBundle) : null) : null;

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
  ).run(
    instance_id,
    'tencent_lighthouse',
    chosenRegion,
    usedZone || null,
    usedBundle || null,
    chosenBlueprintId,
    'IN_POOL',
    'NEEDS_VERIFY',
    ts,
    JSON.stringify({ created_by:'pool_replenish', client_token: clientToken, used_bundle_id: usedBundle || null, used_bundle_price_cny: usedPrice, key_id: chosenKeyId, blueprint_id: chosenBlueprintId, init_state: 'INIT_PENDING', init_state_updated_at: ts })
  );

  db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
    .run(
      crypto.randomUUID(),
      ts,
      'instance',
      instance_id,
      'POOL_INSTANCE_CREATED',
      JSON.stringify({ bundle_id: usedBundle || null, bundle_price_cny: usedPrice, blueprint_id: chosenBlueprintId, key_id: chosenKeyId, region: chosenRegion, zone: usedZone || null, request_id: resp.RequestId })
    );

  const job = postJson(`${API_BASE}/api/ops/pool/init`, { instance_id, mode: 'init_only' });
  console.log(JSON.stringify({ ok:true, ts, action:'create_and_init', instance_id, region: chosenRegion, zone: usedZone || null, bundle_id: usedBundle || null, bundle_price_cny: usedPrice, job, manual }, null, 2));
}

main();
