#!/usr/bin/env node
/**
 * Sync Tencent Lighthouse instances into control-plane DB.
 * - Reads Tencent creds from env (TENCENTCLOUD_SECRET_ID/KEY)
 * - Uses tccli lighthouse DescribeInstances
 * - Enqueues instance_upsert + event records to the local write_queue
 */

import { execFileSync } from 'node:child_process';
import { openDb, nowIso } from './lib/db.mjs';

const REGION = process.env.BOTHOOK_REGION || 'ap-singapore';

function mustEnv(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
}

function runTccli(args) {
  const out = execFileSync('tccli', args, { encoding: 'utf8' });
  return JSON.parse(out);
}

function enqueue(db, kind, key, payload) {
  const stmt = db.prepare('INSERT INTO write_queue(enqueued_at, kind, key, payload_json) VALUES (?,?,?,?)');
  stmt.run(nowIso(), kind, key || null, JSON.stringify(payload));
}

function main() {
  const secretId = mustEnv('TENCENTCLOUD_SECRET_ID');
  const secretKey = mustEnv('TENCENTCLOUD_SECRET_KEY');

  const { db } = openDb();

  const res = runTccli([
    'lighthouse',
    'DescribeInstances',
    '--region', REGION,
    '--language', 'en-US',
    '--secretId', secretId,
    '--secretKey', secretKey,
    '--Limit', '100'
  ]);

  const set = res.InstanceSet || [];
  for (const ins of set) {
    const instance_id = ins.InstanceId;
    const payload = {
      instance_id,
      provider: 'tencent_lighthouse',
      region: REGION,
      zone: ins.Zone || null,
      public_ip: (ins.PublicAddresses && ins.PublicAddresses[0]) || null,
      private_ip: (ins.PrivateAddresses && ins.PrivateAddresses[0]) || null,
      bundle_id: ins.BundleId || null,
      blueprint_id: ins.BlueprintId || null,
      created_at: ins.CreatedTime || null,
      expired_at: ins.ExpiredTime || null,
      meta_json: JSON.stringify({
        instance_name: ins.InstanceName,
        instance_state: ins.InstanceState,
        cpu: ins.CPU,
        memory: ins.Memory,
        uuid: ins.Uuid,
        latest_operation: ins.LatestOperation,
        latest_operation_state: ins.LatestOperationState,
        internet_max_bw_out: ins?.InternetAccessible?.InternetMaxBandwidthOut,
      })
    };

    enqueue(db, 'instance_upsert', instance_id, payload);
    enqueue(db, 'event', `instance:${instance_id}:${ins.LatestOperationStartedTime || ''}`,
      {
        ts: nowIso(),
        entity_type: 'instance',
        entity_id: instance_id,
        event_type: 'LH_SYNC_SNAPSHOT',
        payload_json: {
          instance_state: ins.InstanceState,
          expired_at: ins.ExpiredTime,
          public_ip: payload.public_ip,
          latest_operation: ins.LatestOperation,
          latest_operation_state: ins.LatestOperationState,
        }
      }
    );
  }

  console.log(JSON.stringify({ ok: true, region: REGION, count: set.length }, null, 2));
}

main();
