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

function sh2(cmd){
  return execSync(cmd, { stdio:['ignore','pipe','pipe'], encoding:'utf8', shell:'/bin/bash' });
}

function loadEnvFile(p) {
  try {
    const text = sh2(`bash -lc 'set -a; source ${JSON.stringify(p)}; set +a; python3 - <<"PY"\nimport os, json\nkeys=["TELEGRAM_BOT_TOKEN","TELEGRAM_TOKEN","TELEGRAM_CHAT_ID","OWNER_CHAT_ID"]\nprint(json.dumps({k:os.environ.get(k) for k in keys}))\nPY'`);
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
    sh2(`curl -s -X POST https://api.telegram.org/bot${token}/sendMessage -d chat_id=${chatId} -d text=${JSON.stringify(text)} >/dev/null`);
    return true;
  } catch { return false; }
}

const REGION = process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore';
const POOL_KEY_ID = process.env.BOTHOOK_POOL_KEY_ID || 'lhkp-q1oc3vdz';
const POOL_SSH_KEY = process.env.BOTHOOK_POOL_SSH_KEY || '/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519';
const EXPECT_RENEW_FLAG = process.env.BOTHOOK_POOL_EXPECT_RENEW_FLAG || 'NOTIFY_AND_AUTO_RENEW';
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

function ensureAutoRenew(instance_id, currentFlag, instanceChargeType) {
  // Only meaningful for PREPAID instances.
  if (String(instanceChargeType || '').toUpperCase() !== 'PREPAID') return { ok: true, skipped: true };
  const cur = String(currentFlag || '').trim();
  if (!cur) return { ok: true, skipped: true };
  if (cur === EXPECT_RENEW_FLAG) return { ok: true, already: true };
  try {
    tccli(`tccli lighthouse ModifyInstancesRenewFlag --region ${REGION} --InstanceIds '["${instance_id}"]' --RenewFlag ${EXPECT_RENEW_FLAG} --output json`);
    return { ok: true, changed: true, from: cur, to: EXPECT_RENEW_FLAG };
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e);
    return { ok: false, error: 'modify_renew_flag_failed', msg, from: cur, to: EXPECT_RENEW_FLAG };
  }
}

function sshProbe(ip) {
  try {
    const host = String(ip || '').trim();
    if (!host) return { ok: false, error: 'missing_ip' };

    // Probe in one SSH session to reduce latency.
    // - ssh_ok: network + auth
    // - has_openclaw: runtime presence
    // - gateway_unit: systemd unit presence
    const cmd =
      `ssh -i ${JSON.stringify(POOL_SSH_KEY)} `
      + `-o BatchMode=yes -o StrictHostKeyChecking=no `
      + `-o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null `
      + `-o ConnectTimeout=5 ubuntu@${host} `
      + `'set -euo pipefail; `
      + `echo ssh_ok; `
      + `test -x /home/ubuntu/.npm-global/bin/openclaw && echo has_openclaw || echo no_openclaw; `
      + `systemctl status openclaw-gateway.service >/dev/null 2>&1 && echo gateway_unit_ok || echo gateway_unit_missing'`;

    const out = String(sh2(cmd) || '').trim();
    const lines = out.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    const ok = lines.includes('ssh_ok');
    const hasOpenclaw = lines.includes('has_openclaw');
    const gatewayUnitOk = lines.includes('gateway_unit_ok');

    return { ok, hasOpenclaw, gatewayUnitOk, raw: lines.slice(0, 10) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
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
      let keyIds = ((it.LoginSettings || {}).KeyIds || []).map(String);
      const renewFlag = it.RenewFlag || null;
      const instanceChargeType = it.InstanceChargeType || null;

      // IN_POOL: enforce SSH key binding + SSH reachability + runtime presence as a READY gate.
      let desiredHealth = null;
      let desiredReason = null;
      let desiredSource = null;
      let sshOk = null;
      let renewFix = null;

      if (String(r.lifecycle_status) === 'IN_POOL') {
        // Ensure PREPAID instances are set to auto-renew (policy).
        renewFix = ensureAutoRenew(instance_id, renewFlag, instanceChargeType);
        if (renewFix?.changed) {
          db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
            .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_AUTORENEW_FIXED', JSON.stringify(renewFix));
        } else if (renewFix && renewFix.ok === false) {
          db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
            .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_AUTORENEW_FIX_FAILED', JSON.stringify(renewFix));
        }

        if (!keyIds.includes(POOL_KEY_ID)) {
          const rr = associateKey(instance_id);
          if (rr.ok) {
            keyfix++;
            db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
              .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_KEYPAIR_REBOUND', JSON.stringify({ pool_key_id: POOL_KEY_ID }));

            // Refresh keyIds after bind (best-effort).
            try {
              const it2 = describe(instance_id);
              keyIds = (((it2.LoginSettings || {}).KeyIds || []).map(String)) || keyIds;
            } catch {}
          }
        }

        // Probe SSH if we have a public IP and key is bound.
        if (pub && keyIds.includes(POOL_KEY_ID)) {
          const pr = sshProbe(pub);
          sshOk = Boolean(pr.ok);

          if (!sshOk) {
            desiredHealth = 'NEEDS_VERIFY';
            desiredReason = 'ssh_fail';
            desiredSource = 'cloud_reconcile';
          } else if (!pr.hasOpenclaw || !pr.gatewayUnitOk) {
            desiredHealth = 'NEEDS_VERIFY';
            desiredReason = 'runtime_missing_openclaw';
            desiredSource = 'cloud_reconcile';
          } else {
            desiredHealth = 'READY';
            desiredReason = 'postboot_ok';
            desiredSource = 'cloud_reconcile';
          }
        } else {
          desiredHealth = 'NEEDS_VERIFY';
          desiredReason = pub ? 'pool_key_missing' : 'missing_ip';
          desiredSource = 'cloud_reconcile';
        }
      }

      const meta2 = mergeMeta(r.meta_json, {
        key_ids: keyIds,
        renew_flag: renewFlag,
        renew_flag_expected: EXPECT_RENEW_FLAG,
        renew_flag_fixed: Boolean(renewFix?.changed),
        cloud_refreshed_at: ts,
        ssh_probe_ok: sshOk,
        ssh_probe_at: ts
      });

      db.prepare(
        `UPDATE instances
            SET public_ip=COALESCE(?,public_ip),
                private_ip=COALESCE(?,private_ip),
                bundle_id=COALESCE(?,bundle_id),
                blueprint_id=COALESCE(?,blueprint_id),
                zone=COALESCE(?,zone),
                last_probe_at=?,
                health_status=COALESCE(?, health_status),
                health_reason=COALESCE(?, health_reason),
                health_source=COALESCE(?, health_source),
                meta_json=?
          WHERE instance_id=?`
      ).run(pub, priv, bundle, blueprint, zone, ts, desiredHealth, desiredReason, desiredSource, meta2, instance_id);
      refreshed++;
    } catch (e) {
      fail++;
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), ts, 'instance', instance_id, 'CLOUD_RECONCILE_FAIL', JSON.stringify({ error: String(e?.message || e) }));
    }
  }

  const summary = { ok: true, ts, scanned: rows.length, refreshed, keyfix, fail };
  console.log(JSON.stringify(summary, null, 2));
  if (keyfix || fail) {
    tgSend(`[bothook] cloud_reconcile: refreshed=${refreshed} keyfix=${keyfix} fail=${fail}`);
  }
}

main();
