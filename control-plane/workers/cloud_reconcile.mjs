#!/usr/bin/env node
/**
 * cloud_reconcile.mjs
 *
 * Periodically reconcile DB instance snapshot with Tencent Lighthouse DescribeInstances.
 * - Refresh public/private IPs, bundle_id, blueprint_id, zone
 * - Persist LoginSettings.KeyIds into instances.meta_json.key_ids
 * - For IN_POOL instances: if missing pool ssh key, attempt AssociateInstancesKeyPairs
 *
 * Safety: small batch each run.
 */

import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { openDb, nowIso } from '../lib/db.mjs';

const REGION = process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore';
const POOL_KEY_ID = process.env.BOTHOOK_POOL_KEY_ID || 'lhkp-q1oc3vdz';
const MAX_BATCH = parseInt(process.env.BOTHOOK_RECONCILE_BATCH || '20', 10);

function sh(cmd) {
  const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: '/bin/bash' });
  return out;
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

function describe(instance_id) {
  const text = tccli(`tccli lighthouse DescribeInstances --region ${REGION} --InstanceIds '["${instance_id}"]' --output json`);
  const j = JSON.parse(text);
  const it = (j.InstanceSet || [])[0];
  if (!it) throw new Error('instance_not_found');
  return it;
}

function associateKey(instance_id) {
  // Allow duplicate binds as ok.
  try {
    tccli(`tccli lighthouse AssociateInstancesKeyPairs --region ${REGION} --InstanceIds '["${instance_id}"]' --KeyIds '["${POOL_KEY_ID}"]' --output json`);
    return { ok: true };
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e);
    if (msg.includes('KeyPairBindDuplicate')) return { ok: true, duplicate: true };
    if (msg.includes('LatestOperationUnfinished')) return { ok: false, retryable: true };
    return { ok: false, error: 'associate_failed', msg };
  }
}

function main() {
  const { db } = openDb();
  const ts = nowIso();

  const rows = db.prepare(
    `SELECT instance_id, lifecycle_status, meta_json
       FROM instances
      WHERE lifecycle_status IN ('IN_POOL','ALLOCATED')
      ORDER BY last_probe_at ASC NULLS FIRST, instance_id
      LIMIT ?`
  ).all(MAX_BATCH);

  let refreshed = 0;
  let keyfix = 0;
  let fail = 0;

  for (const r of rows) {
    const instance_id = String(r.instance_id);
    try {
      const it = describe(instance_id);
      const pub = (it.PublicAddresses || [])[0] || null;
      const priv = (it.PrivateAddresses || [])[0] || null;
      const bundle = it.BundleId || null;
      const blueprint = it.BlueprintId || null;
      const zone = it.Zone || null;
      const keyIds = ((it.LoginSettings || {}).KeyIds || []).map(String);

      const meta2 = mergeMeta(r.meta_json, { key_ids: keyIds, cloud_refreshed_at: ts });
      db.prepare(
        `UPDATE instances
            SET public_ip=COALESCE(?,public_ip),
                private_ip=COALESCE(?,private_ip),
                bundle_id=COALESCE(?,bundle_id),
                blueprint_id=COALESCE(?,blueprint_id),
                zone=COALESCE(?,zone),
                last_probe_at=?,
                meta_json=?
          WHERE instance_id=?`
      ).run(pub, priv, bundle, blueprint, zone, ts, meta2, instance_id);
      refreshed++;

      if (String(r.lifecycle_status) === 'IN_POOL') {
        if (!keyIds.includes(POOL_KEY_ID)) {
          const rr = associateKey(instance_id);
          if (rr.ok) {
            keyfix++;
            db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
              .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_KEYPAIR_REBOUND', JSON.stringify({ pool_key_id: POOL_KEY_ID }));
          }
        }
      }
    } catch (e) {
      fail++;
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), ts, 'instance', instance_id, 'CLOUD_RECONCILE_FAIL', JSON.stringify({ error: String(e?.message || e) }));
    }
  }

  console.log(JSON.stringify({ ok: true, ts, scanned: rows.length, refreshed, keyfix, fail }, null, 2));
}

main();
