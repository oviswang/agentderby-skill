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

function getInstanceById(db, instance_id) {
  return db.prepare('SELECT instance_id, public_ip, meta_json FROM instances WHERE instance_id = ?').get(instance_id);
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

function send(res, status, obj) {
  res.status(status).type('application/json').send(JSON.stringify(obj));
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

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
    return send(res, 200, { ok: true, uuid, instance_id: instance.instance_id, status: r.json?.status || 'starting', connected: Boolean(r.json?.connected) });
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

    if (r.status === 409) return send(res, 409, r.json || { ok: false, error: 'qr_not_ready' });
    if (!r.ok) return send(res, 502, { ok: false, error: 'pool_qr_failed', detail: r.json || r.text });

    return send(res, 200, { ok: true, uuid, instance_id: instance.instance_id, qrDataUrl: r.json?.qrDataUrl, status: r.json?.status });
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

    if (!r.ok) return send(res, 502, { ok: false, error: 'pool_status_failed', detail: r.json || r.text });

    // If connected: bind UUID to WhatsApp identity (prevents relink takeover)
    if (r.json?.connected) {
      const waJid = r.json?.wa_jid || null;
      const ts = nowIso();

      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare('SELECT wa_jid FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
        const bound = current?.wa_jid;

        if (!bound && waJid) {
          db.prepare('UPDATE deliveries SET status=?, wa_jid=?, bound_at=?, updated_at=? WHERE delivery_id=?')
            .run('ACTIVE', waJid, ts, ts, delivery.delivery_id);
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'UUID_BOUND', JSON.stringify({ uuid, wa_jid: waJid, instance_id: instance.instance_id })
          );
        } else if (bound && waJid && bound !== waJid) {
          // takeover attempt: keep delivery inactive and report mismatch
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'UUID_BIND_MISMATCH', JSON.stringify({ uuid, expected: bound, got: waJid, instance_id: instance.instance_id })
          );
          db.exec('COMMIT');
          return send(res, 403, { ok: false, error: 'uuid_bound_to_another_account' });
        } else {
          // Either already bound to same jid, or jid missing; just mark active.
          db.prepare('UPDATE deliveries SET status=?, updated_at=? WHERE delivery_id=?').run('ACTIVE', ts, delivery.delivery_id);
        }

        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
      }
    }

    return send(res, 200, { ok: true, uuid, instance_id: instance.instance_id, ...r.json });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message || 'server_error' });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[bothook-api] listening on 127.0.0.1:${PORT}`);
});
