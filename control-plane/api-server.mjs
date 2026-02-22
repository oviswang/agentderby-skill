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

import { openDb, nowIso } from './lib/db.mjs';

const PORT = parseInt(process.env.BOTHOOK_API_PORT || '18998', 10);
const POOL_HTTP_PORT = parseInt(process.env.BOTHOOK_POOL_HTTP_PORT || '80', 10);

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

function getOrCreateDeliveryForUuid(db, uuid) {
  const existing = db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
  if (existing) return existing;

  // find provision-ready instances first (MVP: only instances that have the provision service running)
  const candidates = db.prepare(`
    SELECT instance_id, public_ip, lifecycle_status, meta_json
    FROM instances
    WHERE public_ip IS NOT NULL AND public_ip != ''
    ORDER BY created_at ASC
    LIMIT 50
  `).all();

  const provisionReady = candidates.filter((i) => (jsonMeta(i.meta_json) || {}).provision_ready === true);
  if (!provisionReady.length) {
    throw Object.assign(new Error('No provision-ready instances available'), { statusCode: 503 });
  }

  // For now, allow multiple UUID sessions to map to the same provision-ready instance (demo & early ops).
  const chosen = provisionReady[0];

  const delivery_id = crypto.randomUUID();
  const ts = nowIso();

  // Create delivery mapping (reservation logic will be tightened later when we have per-user orders).
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO deliveries(delivery_id, order_id, user_id, instance_id, status, provision_uuid, created_at, updated_at, meta_json)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      delivery_id,
      null,
      'anon',
      chosen.instance_id,
      'LINKING',
      uuid,
      ts,
      ts,
      JSON.stringify({ allocated_from: 'pool', note: 'MVP uuid->instance mapping (provision_ready only)' })
    );

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

function getInstanceById(db, instance_id) {
  return db.prepare(
    `SELECT instance_id, provider, region, zone, public_ip, private_ip, bundle_id, blueprint_id,
            created_at, terminated_at, expired_at, lifecycle_status, health_status,
            last_probe_at, last_ok_at, assigned_user_id, assigned_order_id, assigned_at,
            meta_json
     FROM instances WHERE instance_id = ?`
  ).get(instance_id);
}

async function poolFetch(instance, path, opts = {}) {
  const ip = instance.public_ip;
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

// C (Relink v2 / p-site state): minimal state endpoint (Phase 1)
// Returns a coarse state derived from local DB only (Stripe integration later).
app.get('/api/p/state', (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    const lang = String(req.query?.lang || '').trim() || null;
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();

    // Busy signal: no READY capacity
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
      try {
        subscription = db.prepare(
          "SELECT provider_sub_id, provider, user_id, plan, status, current_period_end, cancel_at_period_end, updated_at FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1"
        ).get(delivery.user_id) || null;
      } catch {
        subscription = null;
      }
      if (subscription && String(subscription.status || '').toLowerCase() === 'active') {
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
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
        updated_at: subscription.updated_at
      } : null,
      instance: instance ? {
        instance_id: instance.instance_id,
        provider: instance.provider,
        region: instance.region,
        zone: instance.zone,
        public_ip: instance.public_ip,
        bundle_id: instance.bundle_id,
        blueprint_id: instance.blueprint_id,
        lifecycle_status: instance.lifecycle_status,
        health_status: instance.health_status,
        created_at: instance.created_at,
        expired_at: instance.expired_at,
        last_ok_at: instance.last_ok_at,
        last_probe_at: instance.last_probe_at
      } : null,
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

    const r = await poolFetch(instance, '/api/wa/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uuid, force }),
      timeoutMs: 12000,
    });

    if (!r.ok) return send(res, 502, { ok: false, error: 'pool_start_failed', detail: r.json || r.text, poolUrl: r.url });

    const out = { ok: true, uuid, instance_id: instance.instance_id, status: r.json?.status || 'starting', connected: Boolean(r.json?.connected) };
    if (isDebug(req)) out.debug = { upstreamUrl: r.url, upstreamStatus: r.status, upstreamBody: r.json || r.text };
    return send(res, 200, out);
  } catch (e) {
    return send(res, e.statusCode || 500, { ok: false, error: e.message || 'server_error' });
  }
});

app.get('/api/wa/qr', async (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok: false, error: 'uuid_required' });

    const { db } = openDb();
    const delivery = db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
    if (!delivery) return send(res, 404, { ok: false, error: 'unknown_uuid' });

    const instance = getInstanceById(db, delivery.instance_id);
    const r = await poolFetch(instance, `/api/wa/qr?uuid=${encodeURIComponent(uuid)}`, { timeoutMs: 12000 });

    if (r.status === 409) {
      const out = r.json || { ok: false, error: 'qr_not_ready' };
      if (isDebug(req)) out.debug = { upstreamUrl: r.url, upstreamStatus: r.status, upstreamBody: r.json || r.text };
      return send(res, 409, out);
    }
    if (!r.ok) {
      const out = { ok: false, error: 'pool_qr_failed', detail: r.json || r.text };
      if (isDebug(req)) out.debug = { upstreamUrl: r.url, upstreamStatus: r.status, upstreamBody: r.json || r.text };
      return send(res, 502, out);
    }

    const out = { ok: true, uuid, instance_id: instance.instance_id, qrDataUrl: r.json?.qrDataUrl, status: r.json?.status };
    if (isDebug(req)) out.debug = { upstreamUrl: r.url, upstreamStatus: r.status };
    return send(res, 200, out);
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
    const r = await poolFetch(instance, `/api/wa/status?uuid=${encodeURIComponent(uuid)}`, { timeoutMs: 8000 });

    if (!r.ok) {
      const out = { ok: false, error: 'pool_status_failed', detail: r.json || r.text };
      if (isDebug(req)) out.debug = { upstreamUrl: r.url, upstreamStatus: r.status, upstreamBody: r.json || r.text };
      return send(res, 502, out);
    }

    // If connected: bind UUID to WhatsApp identity (prevents relink takeover)
    if (r.json?.connected) {
      const waJid = r.json?.wa_jid || null;
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
          // Either already bound to same jid, or jid missing; just mark active.
          db.prepare('UPDATE deliveries SET status=?, updated_at=? WHERE delivery_id=?').run('ACTIVE', ts, delivery.delivery_id);
        }

        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
      }
    }

    const out = { ok: true, uuid, instance_id: instance.instance_id, ...r.json };
    if (isDebug(req)) out.debug = { upstreamUrl: r.url, upstreamStatus: r.status };
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
        db.prepare('UPDATE deliveries SET status=?, updated_at=? WHERE delivery_id=?').run('PAID', ts, delivery_id);
        db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
          crypto.randomUUID(), ts, 'delivery', delivery_id, 'PAYMENT_CONFIRMED', JSON.stringify({ uuid, stripe_event_id: eventId })
        );
      }
    }

    // TODO: handle subscription lifecycle events (invoice.paid, customer.subscription.*)

    return res.status(200).type('text/plain').send('ok');
  } catch (e) {
    return res.status(500).type('text/plain').send('error');
  }
});

// Delivery status (for user machine to decide next stage)
app.get('/api/delivery/status', (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });
    const { db } = openDb();
    const d = db.prepare('SELECT delivery_id, status, wa_jid, bound_at, updated_at FROM deliveries WHERE provision_uuid=? LIMIT 1').get(uuid);
    if (!d) return send(res, 404, { ok:false, error:'unknown_uuid' });
    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, status: d.status, paid: d.status === 'PAID', wa_jid: d.wa_jid, bound_at: d.bound_at, updated_at: d.updated_at });
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
      db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE delivery_id=?')
        .run('LINKING', ts, meta, d.delivery_id);

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
        // Attempt unbind+cleanup on pool instance
        try {
          if (r.instance_id) {
            const inst = db.prepare('SELECT instance_id, public_ip, meta_json FROM instances WHERE instance_id=?').get(r.instance_id);
            if (inst && inst.public_ip) {
              await poolFetch(inst, '/api/wa/reset', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ uuid: r.provision_uuid }),
                timeoutMs: 15000,
              });
            }
          }
        } catch {}

        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE delivery_id=?')
            .run('RECYCLED_UNPAID', ts, mergeMeta(r.meta_json, { recycled_at: ts, recycle_reason: 'UNPAID' }), r.delivery_id);
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

    const r = await poolFetch(instance, '/api/wa/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uuid }),
      timeoutMs: 15000,
    });
    if (!r.ok) return send(res, 502, { ok:false, error:'pool_reset_failed', detail: r.json || r.text });

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
