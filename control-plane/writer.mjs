#!/usr/bin/env node
/**
 * BOTHook DB single-writer.
 *
 * Reads from `write_queue` and applies batch UPSERTs + event inserts.
 * This is the scaling trick that keeps SQLite healthy at 10万 scale.
 */

import crypto from 'node:crypto';
import { openDb, nowIso } from './lib/db.mjs';

const BATCH_SIZE = parseInt(process.env.BOTHOOK_WRITER_BATCH || '500', 10);
const SLEEP_MS = parseInt(process.env.BOTHOOK_WRITER_SLEEP_MS || '500', 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function ensureEventId(e) {
  return e.event_id || crypto.randomUUID();
}

function mainLoop(db) {
  const sel = db.prepare(
    'SELECT qid, kind, payload_json FROM write_queue ORDER BY qid LIMIT ?'
  );
  const del = db.prepare('DELETE FROM write_queue WHERE qid = ?');
  const fail = db.prepare('UPDATE write_queue SET attempts=attempts+1, last_error=? WHERE qid=?');

  const upsertInstance = db.prepare(`
    INSERT INTO instances(
      instance_id, provider, region, zone,
      public_ip, private_ip, bundle_id, blueprint_id,
      created_at, terminated_at, expired_at,
      lifecycle_status, health_status, last_probe_at, last_ok_at,
      assigned_user_id, assigned_order_id, assigned_at,
      meta_json
    ) VALUES (
      @instance_id, @provider, @region, @zone,
      @public_ip, @private_ip, @bundle_id, @blueprint_id,
      @created_at, @terminated_at, @expired_at,
      COALESCE(@lifecycle_status,'IN_POOL'),
      COALESCE(@health_status,'UNKNOWN'),
      @last_probe_at, @last_ok_at,
      @assigned_user_id, @assigned_order_id, @assigned_at,
      @meta_json
    )
    ON CONFLICT(instance_id) DO UPDATE SET
      provider=excluded.provider,
      region=excluded.region,
      zone=excluded.zone,
      public_ip=excluded.public_ip,
      private_ip=excluded.private_ip,
      bundle_id=excluded.bundle_id,
      blueprint_id=excluded.blueprint_id,
      created_at=COALESCE(excluded.created_at, instances.created_at),
      terminated_at=COALESCE(excluded.terminated_at, instances.terminated_at),
      expired_at=COALESCE(excluded.expired_at, instances.expired_at),
      lifecycle_status=COALESCE(excluded.lifecycle_status, instances.lifecycle_status),
      health_status=COALESCE(excluded.health_status, instances.health_status),
      last_probe_at=COALESCE(excluded.last_probe_at, instances.last_probe_at),
      last_ok_at=COALESCE(excluded.last_ok_at, instances.last_ok_at),
      assigned_user_id=COALESCE(excluded.assigned_user_id, instances.assigned_user_id),
      assigned_order_id=COALESCE(excluded.assigned_order_id, instances.assigned_order_id),
      assigned_at=COALESCE(excluded.assigned_at, instances.assigned_at),
      meta_json=COALESCE(excluded.meta_json, instances.meta_json)
  `);

  const insEvent = db.prepare(`
    INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json)
    VALUES (@event_id, @ts, @entity_type, @entity_id, @event_type, @payload_json)
  `);

  const upsertSub = db.prepare(`
    INSERT INTO subscriptions(provider_sub_id, provider, user_id, plan, status, current_period_end, cancel_at_period_end, updated_at)
    VALUES (@provider_sub_id, @provider, @user_id, @plan, @status, @current_period_end, COALESCE(@cancel_at_period_end,0), @updated_at)
    ON CONFLICT(provider_sub_id) DO UPDATE SET
      provider=excluded.provider,
      user_id=excluded.user_id,
      plan=excluded.plan,
      status=excluded.status,
      current_period_end=excluded.current_period_end,
      cancel_at_period_end=excluded.cancel_at_period_end,
      updated_at=excluded.updated_at
  `);

  const upsertDelivery = db.prepare(`
    INSERT INTO deliveries(delivery_id, order_id, user_id, instance_id, status, provision_uuid, created_at, updated_at, meta_json)
    VALUES (@delivery_id, @order_id, @user_id, @instance_id, @status, @provision_uuid, @created_at, @updated_at, @meta_json)
    ON CONFLICT(delivery_id) DO UPDATE SET
      order_id=COALESCE(excluded.order_id, deliveries.order_id),
      user_id=COALESCE(excluded.user_id, deliveries.user_id),
      instance_id=COALESCE(excluded.instance_id, deliveries.instance_id),
      status=excluded.status,
      provision_uuid=COALESCE(excluded.provision_uuid, deliveries.provision_uuid),
      updated_at=excluded.updated_at,
      meta_json=COALESCE(excluded.meta_json, deliveries.meta_json)
  `);

  const upsertSsh = db.prepare(`
    INSERT INTO ssh_credentials(
      cred_id, instance_id, login_user, auth_type,
      key_fingerprint, private_key_ciphertext, private_key_iv, private_key_tag, private_key_alg,
      status, created_at, rotated_at, revoked_at
    ) VALUES (
      @cred_id, @instance_id, @login_user, @auth_type,
      @key_fingerprint, @private_key_ciphertext, @private_key_iv, @private_key_tag, @private_key_alg,
      COALESCE(@status,'ACTIVE'), @created_at, @rotated_at, @revoked_at
    )
    ON CONFLICT(cred_id) DO UPDATE SET
      instance_id=excluded.instance_id,
      login_user=excluded.login_user,
      auth_type=excluded.auth_type,
      key_fingerprint=COALESCE(excluded.key_fingerprint, ssh_credentials.key_fingerprint),
      private_key_ciphertext=COALESCE(excluded.private_key_ciphertext, ssh_credentials.private_key_ciphertext),
      private_key_iv=COALESCE(excluded.private_key_iv, ssh_credentials.private_key_iv),
      private_key_tag=COALESCE(excluded.private_key_tag, ssh_credentials.private_key_tag),
      private_key_alg=COALESCE(excluded.private_key_alg, ssh_credentials.private_key_alg),
      status=COALESCE(excluded.status, ssh_credentials.status),
      rotated_at=COALESCE(excluded.rotated_at, ssh_credentials.rotated_at),
      revoked_at=COALESCE(excluded.revoked_at, ssh_credentials.revoked_at)
  `);

  function applyRows(rows) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        const payload = parseJson(r.payload_json);
        if (!payload) throw new Error(`Invalid JSON payload qid=${r.qid}`);

        if (r.kind === 'instance_upsert') {
          upsertInstance.run(payload);
        } else if (r.kind === 'event') {
          const e = {
            event_id: ensureEventId(payload),
            ts: payload.ts || nowIso(),
            entity_type: payload.entity_type,
            entity_id: payload.entity_id,
            event_type: payload.event_type,
            payload_json: payload.payload_json ? JSON.stringify(payload.payload_json) : (payload.payload_json_str || null)
          };
          if (!e.entity_type || !e.entity_id || !e.event_type) throw new Error('event missing fields');
          insEvent.run(e);
        } else if (r.kind === 'subscription_upsert') {
          payload.updated_at = payload.updated_at || nowIso();
          upsertSub.run(payload);
        } else if (r.kind === 'delivery_upsert') {
          payload.updated_at = payload.updated_at || nowIso();
          payload.created_at = payload.created_at || payload.updated_at;
          payload.delivery_id = payload.delivery_id || crypto.randomUUID();
          upsertDelivery.run(payload);
        } else if (r.kind === 'ssh_cred_upsert') {
          payload.created_at = payload.created_at || nowIso();
          payload.cred_id = payload.cred_id || crypto.randomUUID();
          // allow JSON-transported byte arrays
          if (Array.isArray(payload.private_key_ciphertext)) payload.private_key_ciphertext = Buffer.from(payload.private_key_ciphertext);
          if (Array.isArray(payload.private_key_iv)) payload.private_key_iv = Buffer.from(payload.private_key_iv);
          if (Array.isArray(payload.private_key_tag)) payload.private_key_tag = Buffer.from(payload.private_key_tag);
          upsertSsh.run(payload);
        } else {
          throw new Error(`Unknown kind=${r.kind}`);
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }

  return async function tick() {
    const rows = sel.all(BATCH_SIZE);
    if (!rows.length) return false;

    try {
      applyRows(rows);
      for (const r of rows) del.run(r.qid);
    } catch (e) {
      // Fail items one-by-one to isolate poison pill
      for (const r of rows) {
        try {
          applyRows([r]);
          del.run(r.qid);
        } catch (err) {
          fail.run(String(err?.message || err), r.qid);
        }
      }
    }
    return true;
  };
}

async function main() {
  const { db, dbPath } = openDb();
  console.log(`[writer] db=${dbPath} batch=${BATCH_SIZE} sleepMs=${SLEEP_MS}`);
  const tick = mainLoop(db);
  while (true) {
    const did = await tick();
    if (!did) await sleep(SLEEP_MS);
  }
}

main().catch((e) => {
  console.error('[writer] fatal', e);
  process.exit(1);
});
