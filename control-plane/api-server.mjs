#!/usr/bin/env node
/**
 * BOTHook central Provisioning API (work machine)
 *
 * This service backs p.bothook.me /api/* and routes by UUID to a pool instance.
 *
 * Endpoints (mirrors pool provisioning server):
 * - POST /api/wa/start { uuid, turnstileToken? }
 * - GET  /api/wa/qr?uuid=...
 * - GET  /api/wa/status?uuid=...
 *
 * Allocation model (MVP):
 * - UUID is the provisioning session id.
 * - If UUID not yet mapped, allocate a pool instance (prefer meta.provision_ready=true).
 * - Persist mapping in SQLite deliveries table.
 */

import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { openDb, nowIso } from './lib/db.mjs';
import { encryptAesGcm } from './lib/crypto.mjs';
import { verifyOpenAiKey } from './lib/openai_verify.mjs';

const PORT = parseInt(process.env.BOTHOOK_API_PORT || '18998', 10);
const POOL_HTTP_PORT = parseInt(process.env.BOTHOOK_POOL_HTTP_PORT || '80', 10);
const POOL_LOCAL_PORT = parseInt(process.env.BOTHOOK_POOL_LOCAL_PORT || '18999', 10);
const POOL_FETCH_MODE = String(process.env.BOTHOOK_POOL_FETCH_MODE || 'ssh').toLowerCase(); // ssh|http
const POOL_SSH_KEY = process.env.BOTHOOK_POOL_SSH_KEY || '/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519';

function normalizeWaBase(waJid){
  try {
    if (!waJid) return null;
    const left = String(waJid).split('@')[0];
    const num = left.split(':')[0];
    return num + '@s.whatsapp.net';
  } catch {
    return null;
  }
}

function jsonMeta(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

function pickProvisionReady(instances) {
  for (const i of instances) {
    const meta = jsonMeta(i.meta_json) || {};
    if (meta.provision_ready === true) return i;
  }
  return instances[0] || null;
}

function parseChannelsStatusJson(text) {
  try {
    const j = JSON.parse(String(text || ''));
    const w = j?.channels?.whatsapp || j?.whatsapp || null;
    const selfJid = w?.self?.jid ? String(w.self.jid) : null;
    const linked = Boolean(w?.linked);
    const connected = Boolean(w?.connected);
    return { ok: true, linked, connected, selfJid, raw: j };
  } catch {
    return { ok: false, linked: false, connected: false, selfJid: null, raw: null };
  }
}

// (normalizeWaBase already defined above)

function probeInstanceWhatsappClean(db, instance) {
  // A-mode strict gate: pool instances must be WhatsApp-unlinked before allocation.
  // Returns { ok, clean, linked, connected, selfJid, detail }
  const cmd = `set -euo pipefail; `
    + `sudo systemctl start openclaw-gateway.service 2>/dev/null || true; `
    + `systemctl --user start openclaw-gateway.service 2>/dev/null || true; `
    + `sleep 1; `
    + `openclaw channels status --json 2>/dev/null || openclaw channels status`;

  const r = poolSsh(instance, cmd, { timeoutMs: 12000, tty: false, retries: 1 });
  const text = (r.stdout || r.stderr || '').trim();
  const parsed = parseChannelsStatusJson(text);

  let linked = false;
  let connected = false;
  let selfJid = null;
  if (parsed.ok) {
    linked = parsed.linked;
    connected = parsed.connected;
    selfJid = parsed.selfJid;
  } else {
    // best-effort text fallback
    const lower = text.toLowerCase();
    linked = lower.includes('whatsapp') && lower.includes('linked') && !lower.includes('not linked');
    connected = lower.includes('whatsapp') && lower.includes('connected');
    selfJid = null;
  }

  const clean = !linked; // strict
  const ts = nowIso();
  try {
    db.prepare('UPDATE instances SET last_probe_at=? WHERE instance_id=?').run(ts, instance.instance_id);
    if (clean) {
      db.prepare('UPDATE instances SET health_status=?, last_ok_at=? WHERE instance_id=?').run('READY', ts, instance.instance_id);
    } else {
      db.prepare('UPDATE instances SET health_status=? WHERE instance_id=?').run('DIRTY', instance.instance_id);
    }
  } catch {}

  return { ok: r.code === 0, clean, linked, connected, selfJid, detail: text.slice(0, 400) };
}

function getOrCreateDeliveryForUuid(db, uuid) {
  const existing = db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
  if (existing) return existing;

  // A-mode strict allocation: choose only pool instances and reserve exclusively.
  const candidates = db.prepare(`
    SELECT instance_id, public_ip, lifecycle_status, health_status, meta_json, created_at
    FROM instances
    WHERE public_ip IS NOT NULL AND public_ip != ''
      AND lifecycle_status='IN_POOL'
    ORDER BY created_at ASC
    LIMIT 50
  `).all();

  const provisionReady = candidates.filter((i) => (jsonMeta(i.meta_json) || {}).provision_ready === true);
  if (!provisionReady.length) {
    throw Object.assign(new Error('No provision-ready instances available'), { statusCode: 503 });
  }

  // Pick the first instance that is WhatsApp-clean (NOT linked).
  // NOTE: we run a live probe here to prevent "connected != this UUID" false positives.
  let chosen = null;
  for (const c of provisionReady) {
    const inst = getInstanceById(db, c.instance_id);
    const probe = probeInstanceWhatsappClean(db, inst);
    if (probe.clean) { chosen = inst; break; }
  }
  if (!chosen) {
    throw Object.assign(new Error('No clean instances available (all linked). Please retry in a few minutes.'), { statusCode: 503 });
  }

  const delivery_id = crypto.randomUUID();
  const ts = nowIso();

  // Reserve + create delivery mapping.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO deliveries(delivery_id, order_id, user_id, instance_id, status, provision_uuid, created_at, updated_at, meta_json)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      delivery_id,
      null,
      uuid,
      chosen.instance_id,
      'LINKING',
      uuid,
      ts,
      ts,
      JSON.stringify({ allocated_from: 'pool', note: 'A-mode strict: reserved clean instance only' })
    );

    db.prepare('UPDATE instances SET lifecycle_status=?, assigned_user_id=?, assigned_at=? WHERE instance_id=?')
      .run('ALLOCATED', uuid, ts, chosen.instance_id);

    // NOTE: READY-report tokens are issued during pool init/reimage (instance lifecycle),
    // not during user allocation (delivery lifecycle). Do not couple instance readiness to user UUID.

    // Persist UUID recovery link on the user machine for later relink/support.
    try {
      const lang = 'en';
      const pLink = `https://p.bothook.me/p/${encodeURIComponent(uuid)}?lang=${encodeURIComponent(lang)}`;
      const remote = `set -euo pipefail; sudo mkdir -p /opt/bothook; sudo sh -lc 'cat > /opt/bothook/UUID.txt <<EOF\nuuid=${uuid}\np_link=${pLink}\nEOF'; sudo chmod 644 /opt/bothook/UUID.txt; echo ok`;
      poolSsh(chosen, remote, { timeoutMs: 12000, tty: false, retries: 1 });
    } catch {}

    db.prepare(`
      INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json)
      VALUES (?,?,?,?,?,?)
    `).run(
      crypto.randomUUID(),
      ts,
      'instance',
      chosen.instance_id,
      'PROVISION_ALLOCATED',
      JSON.stringify({ provision_uuid: uuid, delivery_id })
    );

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  return db.prepare('SELECT * FROM deliveries WHERE delivery_id = ?').get(delivery_id);
}

function getDeliveryByUuid(db, uuid){
  return db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
}

function mergeMeta(oldJson, patch){
  let obj = {};
  try { obj = oldJson ? JSON.parse(oldJson) : {}; } catch { obj = {}; }
  return JSON.stringify({ ...obj, ...patch });
}

function makeReadyReportToken(){
  // short-lived capability token (instance-scoped)
  return crypto.randomBytes(24).toString('hex');
}

function tokenNotExpired(expIso){
  if (!expIso) return false;
  try { return Date.parse(expIso) > Date.now(); } catch { return false; }
}

function writeReadyReportFilesOnInstance(instance, { token, expIso } = {}) {
  // Store instance-scoped token on the pool machine so post-boot verify can report READY.
  // No global secrets.
  const instId = instance.instance_id;
  const ip = instance.public_ip;
  if (!instId || !ip || !token) return;
  const content = `instance_id=${instId}\nready_report_token=${token}\nready_report_exp=${expIso || ''}\n`;
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const remote = `set -euo pipefail; sudo mkdir -p /opt/bothook; echo '${b64}' | base64 -d | sudo tee /opt/bothook/READY_REPORT.txt >/dev/null; `
    + `sudo chmod 600 /opt/bothook/READY_REPORT.txt; sudo chown root:root /opt/bothook/READY_REPORT.txt; echo ok`;
  try { poolSsh(instance, remote, { timeoutMs: 12000, tty: false, retries: 1 }); } catch {}
}

function getInstanceById(db, instance_id) {
  return db.prepare(
    `SELECT instance_id, provider, region, zone, public_ip, private_ip, bundle_id, blueprint_id,
            created_at, terminated_at, expired_at, lifecycle_status, health_status,
            last_probe_at, last_ok_at, assigned_user_id, assigned_order_id, assigned_at,
            meta_json
     FROM instances WHERE instance_id = ?`
  ).get(instance_id);
}

function sh(cmd, { timeoutMs = 12000 } = {}) {
  const res = spawnSync('bash', ['-lc', cmd], {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env }
  });
  return { code: res.status ?? 0, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function poolSsh(instance, remoteCmd, { timeoutMs = 20000, tty = false, retries = 2 } = {}) {
  const ip = instance.public_ip;
  if (!ip) return { code: 1, stdout: '', stderr: 'instance_missing_ip' };
  const tflag = tty ? '-tt' : '';
  const cmd = `ssh ${tflag} -i '${POOL_SSH_KEY}' -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=25 ubuntu@${ip} '${String(remoteCmd).replace(/'/g, "'\\''")}'`;

  let last = null;
  for (let i = 0; i <= retries; i++) {
    const r = sh(cmd, { timeoutMs });
    last = r;
    // 255 is typically SSH transport failure; retry with small backoff.
    if ((r.code ?? 0) === 255 && i < retries) {
      try { require('child_process').spawnSync('bash', ['-lc', 'sleep 0.6'], { stdio: 'ignore' }); } catch {}
      continue;
    }
    return r;
  }
  return last || { code: 255, stdout: '', stderr: 'ssh_failed' };
}

async function poolFetch(instance, path, opts = {}) {
  const ip = instance.public_ip;
  if (!ip) return { ok: false, status: 0, json: null, text: 'instance_missing_ip', url: null };

  // Default mode is SSH: keep pool provision server bound to 127.0.0.1 (no public exposure).
  if (POOL_FETCH_MODE === 'ssh') {
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    const body = opts.body ? String(opts.body) : '';
    const timeoutMs = opts.timeoutMs || 12000;

    const remoteUrl = `http://127.0.0.1:${POOL_LOCAL_PORT}${path}`;
    const headerFlags = Object.entries(headers)
      .map(([k, v]) => `-H '${String(k).replace(/'/g, "'\\''")}: ${String(v).replace(/'/g, "'\\''")}'`)
      .join(' ');

    // Use base64 to avoid shell/JSON quoting issues (prevents invalid JSON on the remote side).
    let curl;
    if (body) {
      const b64 = Buffer.from(body, 'utf8').toString('base64');
      curl = `echo '${b64}' | base64 -d | curl -sS -m ${Math.ceil(timeoutMs / 1000)} -X ${method} ${headerFlags} --data-binary @- '${remoteUrl}'`;
    } else {
      curl = `curl -sS -m ${Math.ceil(timeoutMs / 1000)} -X ${method} ${headerFlags} '${remoteUrl}'`;
    }

    const cmd = `ssh -i '${POOL_SSH_KEY}' -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=25 ubuntu@${ip} '${curl.replace(/'/g, "'\\''")}'`;
    const r = sh(cmd, { timeoutMs: timeoutMs + 3000 });
    const text = (r.stdout || r.stderr || '').trim();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    // SSH mode cannot reliably get HTTP status; treat JSON ok:false as failure.
    const ok = Boolean(json ? json.ok !== false : (r.code === 0));
    return { ok, status: ok ? 200 : 502, json, text, url: `ssh://${ip}${path}` };
  }

  // HTTP mode: requires pool provision server exposed on POOL_HTTP_PORT
  const url = `http://${ip}:${POOL_HTTP_PORT}${path}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs || 8000);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { ok: resp.ok, status: resp.status, json, text, url };
  } finally {
    clearTimeout(t);
  }
}

function baseUrlForShortlinks(){
  return process.env.BOTHOOK_SHORTLINK_BASE || 'https://s.bothook.me/s/';
}

function waJidToE164(waJid){
  try{
    const base = normalizeWaBase(waJid);
    if(!base) return null;
    const num = String(base).split('@')[0];
    if(!/^\d{6,20}$/.test(num)) return null;
    return '+' + num;
  }catch{ return null; }
}

function isKeyVerified(db, uuid){
  try{
    const row = db.prepare('SELECT meta_json FROM delivery_secrets WHERE provision_uuid=? AND kind=? LIMIT 1').get(uuid, 'openai_api_key');
    if(!row) return false;
    let meta={};
    try{ meta = row.meta_json ? JSON.parse(row.meta_json) : {}; }catch{ meta={}; }
    return Boolean(meta.verified_at);
  }catch{ return false; }
}

function isPaid(db, uuid){
  // same logic as /api/delivery/status
  try{
    const d = getDeliveryByUuid(db, uuid);
    if(!d) return false;
    if(String(d.status||'') === 'PAID') return true;
    const sub = db.prepare('SELECT status, ended_at, cancel_at, current_period_end FROM subscriptions WHERE user_id=? ORDER BY updated_at DESC LIMIT 1').get(uuid);
    if(!sub) return false;
    const st = String(sub.status || '').toLowerCase();
    const now = Date.now();
    const endedAt = sub.ended_at ? Date.parse(sub.ended_at) : null;
    const cancelAt = sub.cancel_at ? Date.parse(sub.cancel_at) : null;
    const cpe = sub.current_period_end ? Date.parse(sub.current_period_end) : null;
    const notEnded = !endedAt || endedAt > now;
    const inPeriod = (cancelAt && cancelAt > now) || (cpe && cpe > now);
    return (st === 'active' || st === 'trialing') && notEnded && inPeriod;
  }catch{ return false; }
}

function tryCutoverDelivered(db, uuid, { reason } = {}) {
  // Control-plane decides and triggers cutover on the user machine.
  // Preconditions: linked + paid + key verified.
  const d = getDeliveryByUuid(db, uuid);
  if(!d) return { ok:false, skip:'no_delivery' };

  if(String(d.status||'') === 'DELIVERED') return { ok:true, skip:'already_delivered' };

  const linked = Boolean(d.wa_jid);
  const paid = isPaid(db, uuid);
  const verified = isKeyVerified(db, uuid);
  if(!linked || !paid || !verified) {
    return { ok:false, skip:'preconditions_not_met', linked, paid, verified };
  }

  const inst = getInstanceById(db, d.instance_id);
  if(!inst?.public_ip) return { ok:false, skip:'instance_missing_ip' };

  const controller = waJidToE164(d.wa_jid);
  const ts = nowIso();

  // Trigger cutover script on the user machine (idempotent).
  const remote = `set -euo pipefail; sudo -n true; `
    + `BOTHOOK_UUID='${uuid}' BOTHOOK_CONTROLLER_E164='${controller || ''}' sudo -E /opt/bothook/bin/cutover_delivered.sh`;

  const r = poolSsh(inst, remote, { timeoutMs: 30000, tty: false, retries: 1 });

  // Mark delivered if remote ran (best-effort). If remote fails, keep status for retry.
  if((r.code ?? 1) === 0) {
    const row = db.prepare('SELECT meta_json FROM deliveries WHERE provision_uuid=?').get(uuid);
    const meta2 = mergeMeta(row?.meta_json || null, { delivered_at: ts, cutover_reason: reason || null });
    db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE provision_uuid=?').run('DELIVERED', ts, meta2, uuid);
    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)').run(
      crypto.randomUUID(), ts, 'delivery', uuid, 'CUTOVER_DELIVERED', JSON.stringify({ uuid, instance_id: d.instance_id, reason: reason || null })
    );
    return { ok:true, delivered:true, controller, ssh_code:r.code };
  }

  return { ok:false, delivered:false, ssh_code:r.code, err: (r.stderr||r.stdout||'').slice(0,300) };
}


function randCode(n=7){
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out='';
  for (let i=0;i<n;i++){
    out += alphabet[Math.floor(Math.random()*alphabet.length)];
  }
  return out;
}

async function createStripeCheckout({ uuid, delivery_id }){
  const secret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
  const price = process.env.STRIPE_PRICE_ID || process.env.STRIPE_STANDARD_PRICE_ID || process.env.STRIPE_PRICE_ID_STANDARD || '';
  if (!secret || !price) throw Object.assign(new Error('stripe_not_configured'), { statusCode: 500 });

  const successBase = process.env.BOTHOOK_STRIPE_SUCCESS_URL || 'https://p.bothook.me/?paid=1';
  const cancelBase = process.env.BOTHOOK_STRIPE_CANCEL_URL || 'https://p.bothook.me/?canceled=1';

  const success_url = successBase + (successBase.includes('?') ? '&' : '?') + 'uuid=' + encodeURIComponent(uuid);
  const cancel_url = cancelBase + (cancelBase.includes('?') ? '&' : '?') + 'uuid=' + encodeURIComponent(uuid);

  const body = new URLSearchParams();
  body.set('mode','subscription');
  body.set('line_items[0][price]', price);
  body.set('line_items[0][quantity]', '1');
  body.set('success_url', success_url);
  body.set('cancel_url', cancel_url);
  body.set('metadata[provision_uuid]', uuid);
  body.set('metadata[delivery_id]', delivery_id);

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${secret}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!resp.ok) throw Object.assign(new Error('stripe_checkout_failed'), { statusCode: 502, detail: json || text });
  return { url: json.url, id: json.id };
}

function upsertShortlink(db, { code, long_url, created_at, expires_at, kind, delivery_id, provision_uuid, meta }){
  db.prepare(`INSERT OR REPLACE INTO shortlinks(code,long_url,created_at,expires_at,kind,delivery_id,provision_uuid,meta_json) VALUES (?,?,?,?,?,?,?,?)`)
    .run(code, long_url, created_at, expires_at, kind, delivery_id, provision_uuid, meta ? JSON.stringify(meta) : null);
}

function tryAcquireShortlinkLock(db, lockKey, ts){
  // Returns existing code if lock already exists, else creates lock row and returns null.
  const ex = db.prepare('SELECT code FROM shortlink_locks WHERE lock_key=?').get(lockKey);
  if (ex) return ex.code || '';
  db.prepare('INSERT OR IGNORE INTO shortlink_locks(lock_key, created_at, code) VALUES (?,?,?)').run(lockKey, ts, null);
  const ex2 = db.prepare('SELECT code FROM shortlink_locks WHERE lock_key=?').get(lockKey);
  return ex2.code || null;
}

function setShortlinkLockCode(db, lockKey, code){
  db.prepare('UPDATE shortlink_locks SET code=? WHERE lock_key=?').run(code, lockKey);
}



function isDebug(req) {
  return req.query?.debug === '1' || req.headers['x-bothook-debug'] === '1' || process.env.BOTHOOK_DEBUG === '1';
}

function send(res, status, obj) {
  res.status(status).type('application/json').send(JSON.stringify(obj));
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyStripeSignature({ rawBody, sigHeader, secret, toleranceSeconds = 300 }) {
  if (!rawBody || !sigHeader || !secret) return { ok: false, error: 'missing' };
  const parts = String(sigHeader).split(',').map(s => s.trim());
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Part = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) return { ok:false, error:'bad_header' };
  const t = tPart.slice(2);
  const v1 = v1Part.slice(3);
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts)) return { ok:false, error:'bad_timestamp' };
  const now = Math.floor(Date.now()/1000);
  if (Math.abs(now - ts) > toleranceSeconds) return { ok:false, error:'timestamp_out_of_tolerance' };
  const signed = `${t}.` + rawBody.toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const match = timingSafeEqual(expected, v1);
  return match ? { ok:true, ts } : { ok:false, error:'signature_mismatch' };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

// Ops: pool init job runner (no autonomous tasks; explicit ops call only)
const poolInitJobs = new Map(); // job_id -> { status, startedAt, endedAt, instance_id, mode, log:[] }
let poolInitBusy = false;

function sleepMs(ms){ return new Promise(r => setTimeout(r, ms)); }

function pushJobLog(job, msg){
  job.log.push({ ts: nowIso(), msg: String(msg) });
  if (job.log.length > 200) job.log = job.log.slice(-200);
}

async function tccli(cmd, { envFile='/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env' } = {}) {
  const full = `set -a; source ${envFile}; set +a; ${cmd}`;
  return sh(full, { timeoutMs: 20000 });
}

async function describeInstance(instance_id){
  const r = await tccli(`tccli lighthouse DescribeInstances --region ap-singapore --InstanceIds '["${instance_id}"]' --output json`);
  if ((r.code ?? 1) !== 0) throw new Error('describe_instances_failed');
  const j = JSON.parse(String(r.stdout||'{}'));
  const it = (j.InstanceSet||[])[0];
  if (!it) throw new Error('instance_not_found');
  return it;
}

async function waitPort22(ip, { timeoutMs=10*60*1000 } = {}){
  const start = Date.now();
  while (Date.now()-start < timeoutMs) {
    const rr = sh(`timeout 3 bash -lc "</dev/tcp/${ip}/22"`, { timeoutMs: 5000 });
    if ((rr.code ?? 1) === 0) return true;
    await sleepMs(5000);
  }
  return false;
}

async function waitSshEcho(instance, { timeoutMs=10*60*1000 } = {}){
  const start = Date.now();
  while (Date.now()-start < timeoutMs) {
    const r = poolSsh(instance, 'echo ssh_ok', { timeoutMs: 8000, tty: false, retries: 0 });
    if ((r.code ?? 1) === 0 && String(r.stdout||'').includes('ssh_ok')) return true;
    await sleepMs(5000);
  }
  return false;
}

async function associatePoolKey(instance_id){
  const r = await tccli(`tccli lighthouse AssociateInstancesKeyPairs --region ap-singapore --InstanceIds '["${instance_id}"]' --KeyIds '["lhkp-q1oc3vdz"]' --output json`);
  // Allow "duplicate" as success.
  const out = String((r.stdout||'') + (r.stderr||''));
  if ((r.code ?? 0) === 0) return true;
  if (out.includes('KeyPairBindDuplicate')) return true;
  // Retryable: cloud is busy or instance still pending.
  if (out.includes('LatestOperationUnfinished')) return false;
  if (out.includes('InvalidInstanceState') && out.includes('PENDING')) return false;
  throw new Error('associate_key_failed');
}

async function issueReadyToken(db, instRow){
  const token = makeReadyReportToken();
  const expIso = new Date(Date.now() + 10*60*1000).toISOString();
  const meta = mergeMeta(instRow.meta_json, { ready_report_token: token, ready_report_exp: expIso });
  db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(meta, instRow.instance_id);
  writeReadyReportFilesOnInstance(instRow, { token, expIso });
}

async function runPoolInitJob(job){
  const { db } = openDb();
  const ts0 = nowIso();
  job.startedAt = ts0;
  job.status = 'RUNNING';
  pushJobLog(job, `start (instance=${job.instance_id}, mode=${job.mode})`);

  try {
    const inst0 = getInstanceById(db, job.instance_id);
    if (!inst0) throw new Error('instance_not_found');
    if (inst0.instance_id === 'lhins-npsqfxvn') throw new Error('forbidden_master_host');
    if (String(inst0.lifecycle_status||'') !== 'IN_POOL') throw new Error('not_in_pool');

    // Describe + write IP/KeyIds to DB
    const it = await describeInstance(job.instance_id);
    const pub = (it.PublicAddresses||[])[0] || null;
    const priv = (it.PrivateAddresses||[])[0] || null;
    const keyIds = ((it.LoginSettings||{}).KeyIds||[]).map(String);
    pushJobLog(job, `describe: ip=${pub}, keyIds=${keyIds.join(',')||'[]'}`);
    let meta = {};
    try { meta = inst0.meta_json ? JSON.parse(inst0.meta_json) : {}; } catch { meta = {}; }
    meta.key_ids = keyIds;
    db.prepare('UPDATE instances SET public_ip=COALESCE(?,public_ip), private_ip=COALESCE(?,private_ip), meta_json=? WHERE instance_id=?')
      .run(pub, priv, JSON.stringify(meta), job.instance_id);

    // Associate pool key (retry window)
    pushJobLog(job, 'associate keypair bothook_pool_key');
    for (let i=0;i<20;i++){
      const ok = await associatePoolKey(job.instance_id);
      if (ok) break;
      await sleepMs(3000);
      if (i===19) throw new Error('associate_key_timeout');
    }

    // Refresh describe
    const it2 = await describeInstance(job.instance_id);
    const pub2 = (it2.PublicAddresses||[])[0] || pub;
    pushJobLog(job, `describe2: ip=${pub2}`);
    db.prepare('UPDATE instances SET public_ip=COALESCE(?,public_ip) WHERE instance_id=?').run(pub2, job.instance_id);

    const inst = getInstanceById(db, job.instance_id);
    if (!inst.public_ip) throw new Error('missing_public_ip');

    // Issue ready token
    pushJobLog(job, 'issue ready_report_token');
    await issueReadyToken(db, inst);

    // Verify the token file exists on the instance (guard against write failures)
    try {
      const chk = poolSsh(inst, 'test -s /opt/bothook/READY_REPORT.txt && echo ok || echo missing', { timeoutMs: 12000, tty:false, retries: 0 });
      if (!String(chk.stdout||'').includes('ok')) {
        throw new Error('ready_report_file_missing');
      }
    } catch {
      // re-issue once
      pushJobLog(job, 're-issue ready_report_token (file missing)');
      await issueReadyToken(db, inst);
    }

    // Wait SSH
    pushJobLog(job, 'wait port22');
    await waitPort22(inst.public_ip, { timeoutMs: 10*60*1000 });
    pushJobLog(job, 'wait ssh echo');
    const sshOk = await waitSshEcho(inst, { timeoutMs: 10*60*1000 });
    if (!sshOk) throw new Error('ssh_unreachable');

    // Bootstrap
    pushJobLog(job, 'run bootstrap v0.2.7');
    const boot = poolSsh(inst, "sudo bash -lc \"curl -fsSL https://p.bothook.me/artifacts/v0.2.7/bootstrap.sh | bash\"", { timeoutMs: 20*60*1000, tty:false, retries:0 });
    if ((boot.code ?? 1) !== 0) throw new Error('bootstrap_failed');

    // Wait reboot
    pushJobLog(job, 'wait reboot ssh');
    const sshBack = await waitSshEcho(inst, { timeoutMs: 15*60*1000 });
    if (!sshBack) throw new Error('ssh_not_back_after_reboot');

    // Ensure postboot verify has run (kick once)
    pushJobLog(job, 'kick postboot verify');
    poolSsh(inst, 'sudo systemctl start bothook-postboot-verify.service || true', { timeoutMs: 12000, tty:false, retries:0 });

    // Wait DB READY (from push)
    pushJobLog(job, 'wait DB READY');
    const startWait = Date.now();
    while (Date.now()-startWait < 10*60*1000) {
      const cur = getInstanceById(db, job.instance_id);
      if (String(cur.health_status||'') === 'READY') {
        job.status='DONE';
        job.endedAt=nowIso();
        pushJobLog(job, 'done: READY');
        return;
      }
      await sleepMs(5000);
    }
    throw new Error('db_ready_timeout');

  } catch (e) {
    job.status = 'ERROR';
    job.endedAt = nowIso();
    pushJobLog(job, `error: ${e?.message || 'unknown'}`);
    try {
      const { db } = openDb();
      db.prepare('UPDATE instances SET health_status=? WHERE instance_id=?').run('NEEDS_VERIFY', job.instance_id);
    } catch {}
  }
}

app.post('/api/ops/pool/init', (req, res) => {
  try {
    const instance_id = String(req.body?.instance_id || '').trim();
    const mode = String(req.body?.mode || 'init_only').trim();
    if (!instance_id) return send(res, 400, { ok:false, error:'instance_id_required' });
    if (poolInitBusy) return send(res, 429, { ok:false, error:'pool_init_busy' });
    if (!['init_only','reimage_and_init'].includes(mode)) return send(res, 400, { ok:false, error:'bad_mode' });

    const job_id = crypto.randomUUID();
    const job = { job_id, instance_id, mode, status:'QUEUED', startedAt:null, endedAt:null, log:[] };
    poolInitJobs.set(job_id, job);
    poolInitBusy = true;

    setTimeout(async () => {
      try { await runPoolInitJob(job); } finally { poolInitBusy = false; }
    }, 0);

    return send(res, 200, { ok:true, job_id, status: job.status });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

app.get('/api/ops/pool/init/status', (req, res) => {
  const job_id = String(req.query?.job_id || '').trim();
  if (!job_id) return send(res, 400, { ok:false, error:'job_id_required' });
  const job = poolInitJobs.get(job_id);
  if (!job) return send(res, 404, { ok:false, error:'job_not_found' });
  return send(res, 200, { ok:true, job });
});


// Pool READY report (push): called by pool instances after they finish bootstrap + verification.
// Auth: short-lived instance-scoped token stored in instances.meta_json.ready_report_token.
// Safety: control-plane runs a quick reverse-probe before marking READY.
app.post('/api/pool/ready', (req, res) => {
  try {
    const instance_id = String(req.body?.instance_id || '').trim();
    const token = String(req.body?.token || '').trim();
    // Do not trust reporter-provided IPs (often private IP from hostname -I). We'll refresh from cloud DescribeInstances.
    const public_ip = null;
    const private_ip = null;
    const checks = req.body?.checks || null;
    if (!instance_id || !token) return send(res, 400, { ok:false, error:'instance_id_and_token_required' });

    if (instance_id === 'lhins-npsqfxvn') return send(res, 403, { ok:false, error:'forbidden_master_host' });

    const { db } = openDb();
    const inst = getInstanceById(db, instance_id);
    if (!inst) return send(res, 404, { ok:false, error:'instance_not_found' });

    let meta = {};
    try { meta = inst.meta_json ? JSON.parse(inst.meta_json) : {}; } catch { meta = {}; }

    const exp = meta.ready_report_exp || null;
    if (!tokenNotExpired(exp)) {
      return send(res, 403, { ok:false, error:'token_expired_or_missing' });
    }

    if (String(meta.ready_report_token || '') !== token) {
      return send(res, 403, { ok:false, error:'token_mismatch' });
    }

    const ts = nowIso();

    // Refresh instance IPs from cloud (authoritative)
    try {
      const r = sh(`set -a; source /home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env; set +a; tccli lighthouse DescribeInstances --region ap-singapore --InstanceIds '["${instance_id}"]' --output json`, { timeoutMs: 20000 });
      if ((r.code ?? 1) === 0) {
        const j = JSON.parse(String(r.stdout||'{}'));
        const it = (j.InstanceSet||[])[0] || {};
        const pub = (it.PublicAddresses||[])[0] || null;
        const priv = (it.PrivateAddresses||[])[0] || null;
        if (pub) {
          db.prepare('UPDATE instances SET public_ip=COALESCE(?,public_ip), private_ip=COALESCE(?,private_ip) WHERE instance_id=?').run(pub, priv, instance_id);
        }
      }
    } catch {}

    // Reverse-probe (fast). If it fails, do NOT mark READY.
    try {
      const instForProbe = getInstanceById(db, instance_id);
      const probe = poolSsh(instForProbe, '/opt/bothook/healthcheck.sh', { timeoutMs: 15000, tty: false, retries: 0 });
      const text = String((probe.stdout || '') + (probe.stderr || '')).toLowerCase();
      const okGate = (probe.code === 0) && text.includes('healthcheck completed');
      if (!okGate) {
        db.prepare('UPDATE instances SET health_status=?, last_probe_at=? WHERE instance_id=?')
          .run('NEEDS_VERIFY', ts, instance_id);
        return send(res, 200, { ok:false, error:'reverse_probe_failed', instance_id });
      }
    } catch {
      db.prepare('UPDATE instances SET health_status=?, last_probe_at=? WHERE instance_id=?')
        .run('NEEDS_VERIFY', ts, instance_id);
      return send(res, 200, { ok:false, error:'reverse_probe_error', instance_id });
    }

    // Update instance status
    const patch = {
      provision_ready: true,
      ready_reported_at: ts,
      ready_report_checks: checks || null,
      ready_report_public_ip: public_ip,
      ready_report_private_ip: private_ip,
    };

    db.prepare('UPDATE instances SET health_status=?, last_probe_at=?, last_ok_at=?, public_ip=COALESCE(?, public_ip), private_ip=COALESCE(?, private_ip), meta_json=? WHERE instance_id=?')
      .run('READY', ts, ts, public_ip, private_ip, mergeMeta(inst.meta_json, patch), instance_id);

    // One-shot: invalidate token after success to prevent replay.
    try {
      const inst2 = getInstanceById(db, instance_id);
      let meta2 = {};
      try { meta2 = inst2.meta_json ? JSON.parse(inst2.meta_json) : {}; } catch { meta2 = {}; }
      meta2.ready_report_token = null;
      meta2.ready_report_exp = null;
      db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(JSON.stringify(meta2), instance_id);
    } catch {}

    return send(res, 200, { ok:true, instance_id, health_status:'READY', ts });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// C (Relink v2 / p-site state): minimal state endpoint (Phase 1)
// Returns a coarse state derived from local DB only (Stripe integration later).
app.get('/api/p/state', (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    const lang = String(req.query?.lang || '').trim() || null;
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();

    // Busy signal (A-mode strict): ONLY use DB-cached health_status here.
    // Do NOT run live SSH probes inside /api/p/state (would block the Node event loop and slow down the site).
    // A background worker / explicit ops probe should refresh READY/DIRTY.
    const ready = db.prepare("SELECT COUNT(*) as c FROM instances WHERE lifecycle_status='IN_POOL' AND health_status='READY'").get()?.c ?? 0;
    const busy = ready <= 0;

    const delivery = getDeliveryByUuid(db, uuid);
    const status = delivery?.status || 'NEW';

    // Coarse state machine (Phase 1.5, DB-only)
    // - NEW: no delivery mapping
    // - LINKING: user not yet linked
    // - PAID_ACTIVE: paid subscription active (relink/cancel shown)
    // NOTE: Stripe webhook not wired yet; we rely on local `subscriptions` table only.
    let state = 'NEW';
    let subscription = null;

    if (delivery) {
      state = 'LINKING';
      // Paid-mode must be strongly scoped to the delivery user_id.
      // We use user_id = provision_uuid for isolation (prevents subscription leakage across UUIDs).
      if (String(delivery.user_id || '')) {
        try {
          subscription = db.prepare(
            "SELECT provider_sub_id, provider, user_id, plan, status, current_period_end, cancel_at, canceled_at, ended_at, cancel_at_period_end, updated_at FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1"
          ).get(delivery.user_id) || null;
        } catch {
          subscription = null;
        }
      }

      if (String(status || '') === 'PAID') {
        state = 'PAID_ACTIVE';
      } else if (subscription && String(subscription.status || '').toLowerCase() === 'active') {
        state = 'PAID_ACTIVE';
      }
    }

    const instance = delivery ? getInstanceById(db, delivery.instance_id) : null;

    return send(res, 200, {
      ok: true,
      uuid,
      lang,
      busy,
      readyCapacity: ready,
      state,
      subscription: subscription ? {
        plan: subscription.plan,
        status: subscription.status,
        current_period_end: subscription.current_period_end || null,
        cancel_at: subscription.cancel_at || null,
        canceled_at: subscription.canceled_at || null,
        ended_at: subscription.ended_at || null,
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
        updated_at: subscription.updated_at
      } : null,
      instance: instance ? (() => {
        let meta = {};
        try { meta = instance.meta_json ? JSON.parse(instance.meta_json) : {}; } catch { meta = {}; }
        return {
          // SECURITY: do not expose cloud provider instance_id to end-users.
          provider: instance.provider,
          region: instance.region,
          zone: instance.zone,
          public_ip: instance.public_ip,
          lifecycle_status: instance.lifecycle_status,
          health_status: instance.health_status,
          created_at: instance.created_at,
          expired_at: instance.expired_at,
          last_ok_at: instance.last_ok_at,
          last_probe_at: instance.last_probe_at,

          // Server configuration (best-effort)
          config: {
            cpu: meta.cpu ?? null,
            memory_gb: meta.memory ?? null,
            internet_max_bw_out_mbps: meta.internet_max_bw_out ?? null,
            bundle_id: instance.bundle_id || null,
            blueprint_id: instance.blueprint_id || null,
          }
        };
      })() : null,
      delivery: delivery ? {
        delivery_id: delivery.delivery_id,
        instance_id: delivery.instance_id,
        status,
        wa_jid: delivery.wa_jid ? '[set]' : null,
        bound_at: delivery.bound_at || null,
        updated_at: delivery.updated_at,
      } : null,
    });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// Billing portal (Stripe): allow paid users to self-manage subscription (cancel, update payment method).
// This endpoint returns a redirect URL. Caller should navigate to it.
app.get('/api/billing/portal', async (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    const lang = String(req.query?.lang || '').trim() || 'en';
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const secret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
    if (!secret) return send(res, 500, { ok:false, error:'stripe_not_configured' });

    const { db } = openDb();
    const delivery = getDeliveryByUuid(db, uuid);
    if (!delivery) return send(res, 404, { ok:false, error:'unknown_uuid' });

    const sub = db.prepare(
      "SELECT provider_sub_id, provider, user_id, plan, status, current_period_end, cancel_at_period_end, updated_at FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1"
    ).get(delivery.user_id) || null;

    if (!sub || String(sub.provider || '') !== 'stripe' || !sub.provider_sub_id) {
      return send(res, 404, { ok:false, error:'subscription_not_found' });
    }

    // Retrieve subscription to get customer id
    const auth = Buffer.from(`${secret}:`).toString('base64');
    const subResp = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(sub.provider_sub_id)}`, {
      headers: { 'authorization': `Basic ${auth}` }
    });
    const subJson = await subResp.json().catch(()=>null);
    if (!subResp.ok) return send(res, 502, { ok:false, error:'stripe_subscription_fetch_failed', detail: subJson });

    const customer = subJson && subJson.customer;
    if (!customer) return send(res, 502, { ok:false, error:'stripe_customer_missing' });

    const return_url = (lang === 'zh')
      ? `https://p.bothook.me/zh/?lang=zh&uuid=${encodeURIComponent(uuid)}`
      : `https://p.bothook.me/?lang=${encodeURIComponent(lang)}&uuid=${encodeURIComponent(uuid)}`;

    const body = new URLSearchParams();
    body.set('customer', String(customer));
    body.set('return_url', return_url);

    const portalResp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'authorization': `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body
    });
    const portalJson = await portalResp.json().catch(()=>null);
    if (!portalResp.ok) return send(res, 502, { ok:false, error:'stripe_portal_create_failed', detail: portalJson });

    return send(res, 200, { ok:true, url: portalJson.url });
  } catch (e) {
    return send(res, 500, { ok:false, error: e.message || 'server_error' });
  }
});

app.post('/api/wa/start', async (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok: false, error: 'uuid_required' });

    const { db } = openDb();
    const delivery = getOrCreateDeliveryForUuid(db, uuid);
    const instance = getInstanceById(db, delivery.instance_id);
    if (!instance?.public_ip) return send(res, 500, { ok: false, error: 'instance_missing_ip' });

    const force = Boolean(req.body?.force);

    // SECURITY (A-style relink: same instance): force relink must be authorized.
    // Policy: allow when either
    // - delivery.status is PAID (legacy MVP), OR
    // - Stripe subscription is still in the paid effective period (including cancel_at_period_end but not yet ended).
    if (force) {
      const st = String(delivery.status || '');
      let entitled = (st === 'PAID');

      if (!entitled) {
        const uid = String(delivery.user_id || '').trim();
        if (uid) {
          const sub = db.prepare(
            `SELECT provider_sub_id, provider, user_id, status,
                    current_period_end, cancel_at, canceled_at, ended_at, updated_at
             FROM subscriptions
             WHERE user_id = ?
             ORDER BY updated_at DESC
             LIMIT 1`
          ).get(uid) || null;

          const now = Date.now();
          const providerOk = String(sub?.provider || '') === 'stripe' && !!sub?.provider_sub_id;
          const endedAt = sub?.ended_at ? Date.parse(sub.ended_at) : null;
          const cpe = sub?.current_period_end ? Date.parse(sub.current_period_end) : null;
          const cancelAt = sub?.cancel_at ? Date.parse(sub.cancel_at) : null;

          const notEnded = !endedAt || endedAt > now;
          const inPeriod = (cpe && cpe > now) || (cancelAt && cancelAt > now);
          const statusOk = ['active', 'trialing'].includes(String(sub?.status || '').toLowerCase());

          entitled = Boolean(providerOk && notEnded && inPeriod && statusOk);
        }
      }

      if (!entitled) {
        return send(res, 403, { ok: false, error: 'relink_requires_active_subscription' });
      }
    }

    // SINGLE-CHANNEL login model (tmux-backed):
    // - stop gateway (avoid competition)
    // - start `openclaw channels login --channel whatsapp` inside tmux (stable TTY)
    // - QR is only display (tmux capture), success judged by `openclaw channels status`
    const tmuxSession = `wa-login-${uuid}`.replace(/[^a-zA-Z0-9_-]/g, '');

    const remoteCmd = `set -euo pipefail; `
      + `systemctl --user stop openclaw-gateway.service 2>/dev/null || true; `
      + `sudo systemctl stop openclaw-gateway.service 2>/dev/null || true; `
      + `sudo systemctl stop bothook-provision.service 2>/dev/null || true; `
      + `sudo systemctl disable bothook-provision.service 2>/dev/null || true; `
      + `tmux has-session -t '${tmuxSession}' 2>/dev/null && { echo already_running; exit 0; } || true; `
      + `tmux new-session -d -s '${tmuxSession}' "bash -lc 'stty cols 220 rows 80 2>/dev/null || true; export COLUMNS=220 LINES=80; openclaw channels login --channel whatsapp'"; `
      + `echo started`;

    const r = poolSsh(instance, remoteCmd, { timeoutMs: 20000, tty: false, retries: 2 });
    if (r.code !== 0) {
      const detail = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
      return send(res, 502, { ok: false, error: 'pool_start_failed', detail: detail || `ssh_failed_exit_${r.code}` });
    }

    const out = { ok: true, uuid, instance_id: instance.instance_id, status: 'starting', mode: 'channels_login_tmux', tmuxSession };
    if (isDebug(req)) out.debug = { stdout: r.stdout, stderr: r.stderr };
    return send(res, 200, out);
  } catch (e) {
    return send(res, e.statusCode || 500, { ok: false, error: e.message || 'server_error' });
  }
});

function stripAnsi(s) {
  return String(s || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function extractAsciiQrBlock(text) {
  const lines = stripAnsi(String(text || '')).replace(/\r/g, '').split('\n');
  // There can be multiple QR blocks over time; always return the latest.
  let best = null;
  for (let start = 0; start < lines.length; start++) {
    if (!lines[start].includes('Scan this QR')) continue;
    const out = [];
    for (let i = start; i < lines.length; i++) {
      const l = lines[i];
      if (i > start && l === '') break;
      out.push(l);
    }

    // Post-process: drop truncated trailing QR lines (script output can contain broken bytes).
    // Find QR glyph line range.
    const glyphIdx = out.findIndex(l => /[█▄▀]{5,}/.test(l));
    if (glyphIdx === -1) continue;
    const glyph = out.slice(glyphIdx);
    const widths = glyph.map(l => l.length);
    const maxW = Math.max(...widths);
    while (glyph.length && glyph[glyph.length - 1].length < Math.floor(maxW * 0.9)) {
      glyph.pop();
    }
    const cleaned = out.slice(0, glyphIdx).concat(glyph);

    const joined = cleaned.join('\n');
    if (/[█▄▀]{10,}/.test(joined)) best = joined.trimEnd();
  }
  return best;
}

const qrWatch = new Map();
// qrWatch.get(uuid) => { lastHash, lastSeenAtMs, lastRestartAtMs }

function sha256Hex(s){
  return crypto.createHash('sha256').update(String(s||''), 'utf8').digest('hex');
}

app.get('/api/wa/qr', async (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok: false, error: 'uuid_required' });

    const { db } = openDb();
    const delivery = db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
    if (!delivery) return send(res, 404, { ok: false, error: 'unknown_uuid' });

    const instance = getInstanceById(db, delivery.instance_id);
    const tmuxSession = `wa-login-${uuid}`.replace(/[^a-zA-Z0-9_-]/g, '');

    const rr = poolSsh(instance, `set -euo pipefail; tmux has-session -t '${tmuxSession}' 2>/dev/null || exit 3; tmux capture-pane -t '${tmuxSession}' -p -S - | tail -n 260`, { timeoutMs: 12000, tty: false, retries: 1 });
    const raw = (rr.stdout || rr.stderr || '').toString();
    const qrText = extractAsciiQrBlock(raw);

    if (!qrText) {
      return send(res, 409, { ok: false, error: 'qr_not_ready' });
    }

    // Watchdog: ensure QR rotates.
    // If QR hasn't changed for a while, restart tmux session to obtain a fresh QR.
    const now = Date.now();
    const h = sha256Hex(qrText);
    const w = qrWatch.get(uuid) || { lastHash: null, lastSeenAtMs: now, lastRestartAtMs: 0 };
    if (w.lastHash !== h) {
      w.lastHash = h;
      w.lastSeenAtMs = now;
    }

    const staleMs = now - (w.lastSeenAtMs || now);
    const sinceRestartMs = now - (w.lastRestartAtMs || 0);

    let loginRunning = (rr.code ?? 0) !== 3; // code 3 => no session

    const shouldRestart = (staleMs > 25_000);
    if (shouldRestart && sinceRestartMs > 15_000) {
      w.lastRestartAtMs = now;
      w.lastSeenAtMs = now;
      try {
        const remoteCmd = `set -euo pipefail; `
          + `tmux kill-session -t '${tmuxSession}' 2>/dev/null || true; `
          + `tmux new-session -d -s '${tmuxSession}' "bash -lc 'stty cols 220 rows 80 2>/dev/null || true; export COLUMNS=220 LINES=80; openclaw channels login --channel whatsapp'"; `
          + `echo restarted`;
        poolSsh(instance, remoteCmd, { timeoutMs: 20000, tty: false, retries: 1 });
      } catch {}
    }

    qrWatch.set(uuid, w);

    return send(res, 200, { ok: true, uuid, instance_id: instance.instance_id, status: 'qr', qrText, qrHash: h, qrAgeMs: staleMs, loginRunning });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message || 'server_error' });
  }
});

app.get('/api/wa/status', async (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok: false, error: 'uuid_required' });

    const { db } = openDb();
    const delivery = db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
    if (!delivery) return send(res, 404, { ok: false, error: 'unknown_uuid' });

    const instance = getInstanceById(db, delivery.instance_id);

    // SINGLE-CHANNEL model: status is from `openclaw channels status`.
    const rr = poolSsh(instance, `set -euo pipefail; openclaw channels status --json 2>/dev/null || openclaw channels status`, { timeoutMs: 12000, tty: false });
    const text = (rr.stdout || rr.stderr || '').trim();

    let connected = false;
    let waJid = null;

    // Best-effort parse:
    // - JSON mode: { ok, channels: { whatsapp: { state, jid, ... } } }
    // - Text mode: contains 'WhatsApp' and 'linked/connected/ready'
    try {
      const j = JSON.parse(text);
      const w = j?.channels?.whatsapp || j?.whatsapp || null;
      const state = String(w?.state || w?.status || '').toLowerCase();
      connected = Boolean(w?.connected) || ['ok', 'ready', 'connected', 'linked'].includes(state);
      // Authoritative identity is the WhatsApp self JID
      waJid = w?.self?.jid || w?.jid || w?.wa_jid || w?.id || null;
      if (waJid) waJid = String(waJid);
    } catch {
      const lower = text.toLowerCase();
      // If gateway is unreachable, we cannot claim connected.
      if (lower.includes('gateway not reachable') || lower.includes('gateway closed')) {
        connected = false;
      } else {
        connected = lower.includes('whatsapp') && (lower.includes('connected') || lower.includes('ready') || lower.includes('linked'));
      }
      waJid = null;
    }

    if (rr.code !== 0 && !text) {
      return send(res, 502, { ok: false, error: 'pool_status_failed', detail: (rr.stderr || rr.stdout || '').trim() });
    }

    // If connected: bind UUID to WhatsApp identity (prevents relink takeover)
    // IMPORTANT: Only bind when we can read the self JID from status.
    if (connected && waJid) {
      const ts = nowIso();

      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare('SELECT wa_jid FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
        const bound = current?.wa_jid;

        if (!bound && waJid) {
          const boundUnpaidExpiresAt = new Date(Date.parse(ts) + 15*60*1000).toISOString();
          const meta2 = mergeMeta(delivery.meta_json, { bound_unpaid_expires_at: boundUnpaidExpiresAt });
          db.prepare('UPDATE deliveries SET status=?, wa_jid=?, bound_at=?, updated_at=?, meta_json=? WHERE delivery_id=?')
            .run('BOUND_UNPAID', waJid, ts, ts, meta2, delivery.delivery_id);
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'UUID_BOUND', JSON.stringify({ uuid, wa_jid: waJid, instance_id: instance.instance_id })
          );
        } else if (bound && waJid && bound !== waJid) {
          // allow device id change for same number (e.g. :46 -> :47)
          const expectedBase = normalizeWaBase(bound);
          const gotBase = normalizeWaBase(waJid);
          if (expectedBase && gotBase && expectedBase === gotBase) {
            db.prepare('UPDATE deliveries SET wa_jid=?, updated_at=? WHERE delivery_id=?').run(waJid, ts, delivery.delivery_id);
            db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
              crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'UUID_BIND_DEVICE_CHANGED', JSON.stringify({ uuid, expected: bound, got: waJid, base: expectedBase, instance_id: instance.instance_id })
            );
          } else {
            db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
              crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'UUID_BIND_MISMATCH', JSON.stringify({ uuid, expected: bound, got: waJid, instance_id: instance.instance_id })
            );
            db.exec('COMMIT');
            return send(res, 403, { ok: false, error: 'uuid_bound_to_another_account' });
          }
        } else {
          // Either already bound to same jid, or jid missing.
          // Do NOT downgrade paid state: keep PAID as the highest-precedence state.
          const row = db.prepare('SELECT status FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
          const st = row?.status || '';
          if (st !== 'PAID') {
            db.prepare('UPDATE deliveries SET status=?, updated_at=? WHERE delivery_id=?').run('ACTIVE', ts, delivery.delivery_id);
          } else {
            db.prepare('UPDATE deliveries SET updated_at=? WHERE delivery_id=?').run(ts, delivery.delivery_id);
          }
        }

        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
      }
    }

    // A-mode strict: do NOT claim "connected" unless this UUID is actually bound.
    // Otherwise a previously-linked (dirty) pool machine would appear as linked without scanning.
    let boundJid = null;
    try {
      const row = db.prepare('SELECT wa_jid, status FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
      boundJid = row?.wa_jid || null;
    } catch {}

    const claimConnected = Boolean(connected && boundJid && normalizeWaBase(boundJid) === normalizeWaBase(waJid));
    const out = { ok: true, uuid, instance_id: instance.instance_id, status: claimConnected ? 'connected' : 'linking', connected: claimConnected, wa_jid: boundJid || null, lastUpdateAt: nowIso() };
    if (isDebug(req)) out.debug = { raw: text.slice(0, 800) };
    return send(res, 200, out);
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message || 'server_error' });
  }
});



// Create payment shortlink (Stripe checkout)
app.post('/api/pay/link', async (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const delivery = getOrCreateDeliveryForUuid(db, uuid);    // Determine expiry: 15m window from link creation time
    const now = Date.now();
    const expiresAt = new Date(now + 15*60*1000).toISOString();
    // Pay link idempotency (lock + reuse)
    const lockKey = `stripe_checkout:${uuid}`;
    const ts = nowIso();

    db.exec('BEGIN IMMEDIATE');
    let lockedCode = null;
    try {
      lockedCode = tryAcquireShortlinkLock(db, lockKey, ts);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      lockedCode = null;
    }

    // If a code is already locked/assigned, reuse it (if unexpired)
    if (lockedCode) {
      const row = db.prepare('SELECT expires_at FROM shortlinks WHERE code=?').get(lockedCode);
      if (!row || !row.expires_at || Date.parse(row.expires_at) > now) {
        db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
          crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'PAY_LINK_REUSED', JSON.stringify({ uuid, code: lockedCode })
        );
        return send(res, 200, { ok:true, uuid, delivery_id: delivery.delivery_id, payUrl: baseUrlForShortlinks()+lockedCode, expiresAt: (row && row.expires_at) ? row.expires_at : expiresAt });
      }
    }

    // If an unexpired shortlink already exists for this uuid, reuse it
    const existing = db.prepare(`SELECT code, expires_at FROM shortlinks WHERE provision_uuid=? AND kind='stripe_checkout' ORDER BY created_at DESC LIMIT 1`).get(uuid);
    if (existing?.code && (!existing.expires_at || Date.parse(existing.expires_at) > now)) {
      setShortlinkLockCode(db, lockKey, existing.code);
      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'PAY_LINK_REUSED', JSON.stringify({ uuid, code: existing.code })
      );
      return send(res, 200, { ok:true, uuid, delivery_id: delivery.delivery_id, payUrl: baseUrlForShortlinks()+existing.code, expiresAt: existing.expires_at || expiresAt });
    }

    const checkout = await createStripeCheckout({ uuid, delivery_id: delivery.delivery_id });

    let code;
    for (let i=0;i<5;i++){
      const c = randCode(7);
      const used = db.prepare('SELECT 1 FROM shortlinks WHERE code=?').get(c);
      if (!used) { code = c; break; }
    }
    if (!code) throw new Error('shortlink_code_exhausted');

    const ts2 = nowIso();
    upsertShortlink(db, {
      code,
      long_url: checkout.url,
      created_at: ts2,
      expires_at: expiresAt,
      kind: 'stripe_checkout',
      delivery_id: delivery.delivery_id,
      provision_uuid: uuid,
      meta: { stripe_session_id: checkout.id },
    });

    // persist lock code
    try { setShortlinkLockCode(db, lockKey, code); } catch {}


    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
      crypto.randomUUID(), ts2, 'delivery', delivery.delivery_id, 'PAY_LINK_CREATED', JSON.stringify({ uuid, code, expires_at: expiresAt })
    );

    return send(res, 200, { ok:true, uuid, delivery_id: delivery.delivery_id, payUrl: baseUrlForShortlinks()+code, expiresAt });
  } catch (e) {
    return send(res, e.statusCode || 500, { ok:false, error: e.message || 'server_error', detail: e.detail });
  }
});

// Shortlink redirect
app.get('/s/:code', (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(404).type('text/plain').send('not found');
    const { db } = openDb();
    const row = db.prepare('SELECT long_url, expires_at FROM shortlinks WHERE code=? LIMIT 1').get(code);
    if (!row?.long_url) return res.status(404).type('text/plain').send('not found');
    if (row.expires_at) {
      const t = Date.parse(row.expires_at);
      if (!isNaN(t) && Date.now() > t) return res.status(410).type('text/plain').send('expired');
    }
    res.setHeader('cache-control','no-store');
    return res.redirect(302, row.long_url);
  } catch (e) {
    return res.status(500).type('text/plain').send('error');
  }
});



// Stripe webhook (authoritative payment events)
app.post('/api/stripe/webhook', async (req, res) => {
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    const sig = req.headers['stripe-signature'];
    const rawBody = req.rawBody;

    const v = verifyStripeSignature({ rawBody, sigHeader: sig, secret });
    if (!v.ok) return res.status(400).type('text/plain').send('bad signature');

    const evt = req.body;
    const ts = nowIso();

    const { db } = openDb();

    const type = evt?.type || 'unknown';
    const obj = evt?.data?.object || null;

    // Extract metadata we set on checkout sessions
    const md = obj?.metadata || {};
    const uuid = md?.provision_uuid || null;
    const delivery_id = md?.delivery_id || null;

    // Always write raw event (dedupe by event id)
    const eventId = String(evt?.id || crypto.randomUUID());
    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
      eventId, ts, 'stripe', eventId, type, JSON.stringify({ uuid, delivery_id, object: obj })
    );

    // Minimal state transitions
    if (type === 'checkout.session.completed') {
      // Mark delivery paid (MVP)
      if (delivery_id) {
        // Preserve existing meta and record paid timestamp for audit.
        const row = db.prepare('SELECT meta_json FROM deliveries WHERE delivery_id=?').get(delivery_id);
        const meta2 = mergeMeta(row?.meta_json || null, { paid_at: ts, stripe_event_id: eventId });
        db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE delivery_id=?').run('PAID', ts, meta2, delivery_id);
        db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
          crypto.randomUUID(), ts, 'delivery', delivery_id, 'PAYMENT_CONFIRMED', JSON.stringify({ uuid, stripe_event_id: eventId })
        );
        // If key already verified + linked, cutover now.
        try { tryCutoverDelivered(db, uuid, { reason: 'payment_confirmed' }); } catch {}
      }
    }

    // TODO: handle subscription lifecycle events (invoice.paid, customer.subscription.*)

    return res.status(200).type('text/plain').send('ok');
  } catch (e) {
    return res.status(500).type('text/plain').send('error');
  }
});

// i18n: WhatsApp prompts (platform-owned copy)
app.get('/api/i18n/whatsapp-prompts', (req, res) => {
  try {
    const langRaw = String(req.query?.lang || '').trim().toLowerCase();
    const lang = langRaw || 'en';
    const allow = new Set(['en','zh','zh-tw','ar','de','es','fr','hi','id','ja','ko','pt-br','ru','th','tr','vi']);
    const pick = allow.has(lang) ? lang : 'en';

    const here = path.dirname(new URL(import.meta.url).pathname);
    const p = path.join(here, 'i18n', 'whatsapp_prompts', `${pick}.json`);
    let prompts;
    try { prompts = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { prompts = null; }
    if (!prompts) return send(res, 500, { ok:false, error:'prompts_load_failed' });
    return send(res, 200, { ok:true, lang: pick, prompts });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// Delivery status (for user machine to decide next stage)
// Key status (OpenAI) — used by onboarding responder
app.get('/api/key/status', (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });
    const { db } = openDb();
    const row = db.prepare('SELECT meta_json FROM delivery_secrets WHERE provision_uuid=? AND kind=? LIMIT 1').get(uuid, 'openai_api_key');
    if (!row) return send(res, 200, { ok:true, uuid, hasKey:false, verified:false });
    let meta = {};
    try { meta = row.meta_json ? JSON.parse(row.meta_json) : {}; } catch { meta = {}; }
    const verifiedAt = meta.verified_at || null;
    return send(res, 200, { ok:true, uuid, hasKey:true, verified: Boolean(verifiedAt), verifiedAt });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// Verify + store OpenAI key (encrypted) — returns verified=true on success
app.post('/api/key/verify', async (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '').trim();
    const provider = String(req.body?.provider || 'openai').trim().toLowerCase();
    const key = String(req.body?.key || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });
    if (provider !== 'openai') return send(res, 400, { ok:false, error:'provider_not_supported' });
    if (!key) return send(res, 400, { ok:false, error:'key_required' });

    const vr = await verifyOpenAiKey(key, { timeoutMs: 10000 });
    if (!vr.ok) {
      return send(res, 200, { ok:true, verified:false, error:'key_invalid', detail: vr.error || null });
    }

    const { ciphertext, iv, tag, alg } = encryptAesGcm(Buffer.from(key, 'utf8'));
    const ts = nowIso();
    const secretId = `${uuid}:openai_api_key`;

    const { db } = openDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO delivery_secrets(secret_id, provision_uuid, kind, ciphertext, iv, tag, alg, created_at, updated_at, meta_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(secret_id) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag, alg=excluded.alg, updated_at=excluded.updated_at, meta_json=excluded.meta_json`
      ).run(
        secretId,
        uuid,
        'openai_api_key',
        ciphertext,
        iv,
        tag,
        alg,
        ts,
        ts,
        JSON.stringify({ verified_at: ts })
      );
      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), ts, 'delivery', uuid, 'OPENAI_KEY_VERIFIED', JSON.stringify({ uuid })
      );
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    // If paid + linked, trigger cutover automatically.
    try {
      const { db } = openDb();
      tryCutoverDelivered(db, uuid, { reason: 'openai_key_verified' });
    } catch {}

    return send(res, 200, { ok:true, verified:true, message:'[bothook] OpenAI Key 验证成功 ✅ 现在你可以直接在 WhatsApp 里对它说“帮我做什么”。' });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

app.get('/api/delivery/status', (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });
    const { db } = openDb();
    const d = db.prepare('SELECT delivery_id, status, wa_jid, bound_at, updated_at, user_lang FROM deliveries WHERE provision_uuid=? LIMIT 1').get(uuid);
    if (!d) return send(res, 404, { ok:false, error:'unknown_uuid' });

    // paid: delivery.status=PAID OR an active subscription exists for this UUID-scoped user_id.
    let paid = (d.status === 'PAID');
    try {
      const sub = db.prepare('SELECT status, ended_at, cancel_at, current_period_end FROM subscriptions WHERE user_id=? ORDER BY updated_at DESC LIMIT 1').get(uuid);
      if (sub) {
        const st = String(sub.status || '').toLowerCase();
        const now = Date.now();
        const endedAt = sub.ended_at ? Date.parse(sub.ended_at) : null;
        const cancelAt = sub.cancel_at ? Date.parse(sub.cancel_at) : null;
        const cpe = sub.current_period_end ? Date.parse(sub.current_period_end) : null;
        const notEnded = !endedAt || endedAt > now;
        const inPeriod = (cancelAt && cancelAt > now) || (cpe && cpe > now);
        if (!paid && (st === 'active' || st === 'trialing') && notEnded && inPeriod) {
          paid = true;
        }
      }
    } catch {}

    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, status: d.status, paid, wa_jid: d.wa_jid, bound_at: d.bound_at, user_lang: d.user_lang || null, updated_at: d.updated_at });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});



// Ops: mark QR generated (A-stage start)
app.post('/api/ops/qr-generated', (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '').trim();
    const lang = String(req.body?.lang || '').trim() || null;
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const d = getOrCreateDeliveryForUuid(db, uuid);
    const ts = nowIso();
    const expiresAt = new Date(Date.now() + 5*60*1000).toISOString();

    db.exec('BEGIN IMMEDIATE');
    try {
      const meta = mergeMeta(d.meta_json, { preferred_lang: lang || undefined, qr_generated_at: ts, qr_expires_at: expiresAt });
      // Do NOT downgrade state for already-bound/paid deliveries.
      // Only move to LINKING when not yet bound.
      const cur = db.prepare('SELECT status, wa_jid FROM deliveries WHERE delivery_id=?').get(d.delivery_id);
      const nextStatus = (cur?.wa_jid ? String(cur.status || 'LINKING') : 'LINKING');
      // Language must follow p-site selection end-to-end. Use current `lang` as the source of truth.
      // If `lang` is missing/null, preserve existing user_lang.
      db.prepare('UPDATE deliveries SET status=?, user_lang=COALESCE(?, user_lang), updated_at=?, meta_json=? WHERE delivery_id=?')
        .run(nextStatus, lang || null, ts, meta, d.delivery_id);

      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), ts, 'delivery', d.delivery_id, 'QR_GENERATED', JSON.stringify({ uuid, lang, expires_at: expiresAt, instance_id: d.instance_id })
      );
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, expiresAt });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

app.get('/api/ops/provision-state', (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const d = getDeliveryByUuid(db, uuid);
    if (!d) return send(res, 404, { ok:false, error:'unknown_uuid' });

    let meta = {};
    try { meta = d.meta_json ? JSON.parse(d.meta_json) : {}; } catch { meta = {}; }

    const qrExpiresAt = meta.qr_expires_at || null;
    const now = Date.now();
    const expired = Boolean(!d.wa_jid && qrExpiresAt && Date.parse(qrExpiresAt) <= now);

    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, status: d.status, expired, qrExpiresAt });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});


function startOpsWorker(){
  const intervalMs = parseInt(process.env.BOTHOOK_OPS_TICK_MS || '30000', 10);
  const enabled = (process.env.BOTHOOK_OPS_WORKER || '1') === '1';
  if (!enabled) return;

  async function tick(){
    const { db } = openDb();
    const now = Date.now();
    // A-stage: QR expired (5m) and not bound
    const rowsA = db.prepare(`
      SELECT delivery_id, provision_uuid, instance_id, meta_json
      FROM deliveries
      WHERE status='LINKING' AND (wa_jid IS NULL OR wa_jid='')
      LIMIT 200
    `).all();

    for (const r of rowsA){
      let meta = {};
      try { meta = r.meta_json ? JSON.parse(r.meta_json) : {}; } catch { meta = {}; }
      const exp = meta.qr_expires_at ? Date.parse(meta.qr_expires_at) : NaN;
      if (!isNaN(exp) && exp <= now){
        const ts = nowIso();
        db.exec('BEGIN IMMEDIATE');
        try {
          // mark recycled
          db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE delivery_id=?')
            .run('QR_EXPIRED', ts, mergeMeta(r.meta_json, { recycled_at: ts, recycle_reason: 'QR_EXPIRED' }), r.delivery_id);
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), ts, 'delivery', r.delivery_id, 'RECYCLE_UNBOUND', JSON.stringify({ uuid: r.provision_uuid, instance_id: r.instance_id })
          );
          // return instance to pool (safe for unbound)
          if (r.instance_id){
            db.prepare('UPDATE instances SET lifecycle_status=?, assigned_user_id=NULL, assigned_order_id=NULL, assigned_at=NULL WHERE instance_id=?')
              .run('IN_POOL', r.instance_id);
          }
          db.exec('COMMIT');
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
        }
      }
    }

    // B-stage: bound but unpaid (15m)
    const rowsB = db.prepare(`
      SELECT delivery_id, provision_uuid, instance_id, status, meta_json
      FROM deliveries
      WHERE status='BOUND_UNPAID'
      LIMIT 200
    `).all();

    for (const r of rowsB){
      let meta = {};
      try { meta = r.meta_json ? JSON.parse(r.meta_json) : {}; } catch { meta = {}; }
      const exp = meta.bound_unpaid_expires_at ? Date.parse(meta.bound_unpaid_expires_at) : NaN;
      if (!isNaN(exp) && exp <= now){
        const ts = nowIso();
        // Attempt unbind+cleanup on pool instance (A-mode strict): remove WhatsApp auth so the machine becomes clean.
        try {
          if (r.instance_id) {
            const inst = db.prepare('SELECT instance_id, public_ip, meta_json FROM instances WHERE instance_id=?').get(r.instance_id);
            if (inst && inst.public_ip) {
              const session = `wa-login-${r.provision_uuid}`.replace(/[^a-zA-Z0-9_-]/g, '');
              const remoteCmd = `set -euo pipefail; `
                + `tmux kill-session -t '${session}' 2>/dev/null || true; `
                + `sudo systemctl stop openclaw-gateway.service 2>/dev/null || true; `
                + `systemctl --user stop openclaw-gateway.service 2>/dev/null || true; `
                + `openclaw channels logout --channel whatsapp 2>/dev/null || true; `
                + `rm -rf /home/ubuntu/.openclaw/channels/whatsapp 2>/dev/null || true; `
                + `sudo systemctl start openclaw-gateway.service 2>/dev/null || true; `
                + `echo cleaned`;
              poolSsh(inst, remoteCmd, { timeoutMs: 25000, tty: false, retries: 2 });
            }
          }
        } catch {}

        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE deliveries SET status=?, wa_jid=NULL, bound_at=NULL, updated_at=?, meta_json=? WHERE delivery_id=?')
            .run('RECYCLED_UNPAID', ts, ts, mergeMeta(r.meta_json, { recycled_at: ts, recycle_reason: 'UNPAID' }), r.delivery_id);
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), ts, 'delivery', r.delivery_id, 'RECYCLE_UNPAID', JSON.stringify({ uuid: r.provision_uuid, instance_id: r.instance_id })
          );
          if (r.instance_id){
            db.prepare('UPDATE instances SET lifecycle_status=?, assigned_user_id=NULL, assigned_order_id=NULL, assigned_at=NULL WHERE instance_id=?')
              .run('IN_POOL', r.instance_id);
          }
          db.exec('COMMIT');
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
        }
      }
    }
  }

  setInterval(() => { tick().catch(()=>{}); }, intervalMs);
  // immediate tick
  tick().catch(()=>{});
}

startOpsWorker();



app.post('/api/wa/reset', async (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const delivery = db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
    if (!delivery) return send(res, 404, { ok:false, error:'unknown_uuid' });
    const instance = getInstanceById(db, delivery.instance_id);
    if (!instance?.public_ip) return send(res, 500, { ok:false, error:'instance_missing_ip' });

    const session = `wa-login-${uuid}`.replace(/[^a-zA-Z0-9_-]/g, '');
    const remoteCmd = `set -euo pipefail; `
      + `tmux kill-session -t '${session}' 2>/dev/null || true; `
      + `sudo systemctl stop openclaw-gateway.service 2>/dev/null || true; `
      + `systemctl --user stop openclaw-gateway.service 2>/dev/null || true; `
      + `openclaw channels logout --channel whatsapp 2>/dev/null || true; `
      + `rm -rf /home/ubuntu/.openclaw/channels/whatsapp 2>/dev/null || true; `
      + `sudo systemctl start openclaw-gateway.service 2>/dev/null || true; `
      + `echo cleaned`;

    const rr = poolSsh(instance, remoteCmd, { timeoutMs: 25000, tty: false, retries: 2 });
    if (rr.code !== 0) {
      const detail = ((rr.stdout || '') + '\n' + (rr.stderr || '')).trim();
      return send(res, 502, { ok:false, error:'pool_reset_failed', detail: detail || `ssh_failed_exit_${rr.code}` });
    }

    const ts = nowIso();
    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
      crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'UNBIND_SENT', JSON.stringify({ uuid, instance_id: instance.instance_id })
    );

    return send(res, 200, { ok:true, uuid, instance_id: instance.instance_id, reset:true });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[bothook-api] listening on 127.0.0.1:${PORT}`);
});
