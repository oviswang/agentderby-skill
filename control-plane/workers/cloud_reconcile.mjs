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

// Default region is a fallback; we primarily use the per-instance region stored in DB.
const DEFAULT_REGION = process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore';
const POOL_KEY_ID = process.env.BOTHOOK_POOL_KEY_ID || 'lhkp-q1oc3vdz';
const POOL_SSH_KEY = process.env.BOTHOOK_POOL_SSH_KEY || '/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519';
const EXPECT_RENEW_FLAG = process.env.BOTHOOK_POOL_EXPECT_RENEW_FLAG || 'NOTIFY_AND_AUTO_RENEW';
const MAX_BATCH = parseInt(process.env.BOTHOOK_RECONCILE_BATCH || '20', 10);

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
    err._code = e?.status;
    throw err;
  }
}

function tccli(cmd) {
  const envFile = '/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env';
  const full = `set -a; source ${envFile}; set +a; ${cmd}`;
  return sh(full);
}

function parseJson(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

function parseJsonStrict(s, { op, region, instance_id } = {}) {
  try {
    return s ? JSON.parse(s) : {};
  } catch (e) {
    const head = String(s || '').slice(0, 600);
    const err = new Error(`tccli_non_json_output op=${op||'unknown'} region=${region||''} instance=${instance_id||''} head=${JSON.stringify(head)}`);
    err._stdout = s;
    throw err;
  }
}

function classifyTccliError(e) {
  const t = String(e?._stderr || e?.message || e || '');
  if (t.includes('secretId is invalid') || t.includes('AuthFailure')) return { code: 'auth_invalid', retryable: false };
  if (t.includes('RequestLimitExceeded') || t.includes('LimitExceeded')) return { code: 'rate_limited', retryable: true };
  if (t.includes('InternalError') || t.includes('ServiceUnavailable')) return { code: 'cloud_unavailable', retryable: true };
  if (t.includes('instance_not_found') || t.includes('InvalidInstanceId')) return { code: 'instance_not_found', retryable: false };
  if (t.includes('LatestOperationUnfinished')) return { code: 'latest_op_unfinished', retryable: true };
  // Sometimes tccli prints usage help text when args/env are wrong.
  if (t.includes('usage: tccli')) return { code: 'tccli_usage', retryable: false };
  return { code: 'unknown', retryable: false };
}

function mergeMeta(oldMetaStr, patch) {
  const m = parseJson(oldMetaStr);
  return JSON.stringify({ ...m, ...patch });
}

function describe(region, instance_id) {
  const reg = String(region || '').trim() || DEFAULT_REGION;
  const text = tccli(`tccli lighthouse DescribeInstances --region ${reg} --InstanceIds '["${instance_id}"]' --output json`);
  const j = parseJsonStrict(text, { op: 'DescribeInstances', region: reg, instance_id });
  const it = (j.InstanceSet || [])[0];
  if (!it) throw new Error('instance_not_found');
  return it;
}

function resolvePoolKeyIdForRegion(targetRegion) {
  const region = String(targetRegion || '').trim() || DEFAULT_REGION;
  const desiredKeyId = String(POOL_KEY_ID || '').trim();
  const sourceRegion = String(process.env.BOTHOOK_POOL_KEY_SOURCE_REGION || DEFAULT_REGION).trim() || DEFAULT_REGION;
  const cachePath = process.env.BOTHOOK_POOL_KEY_REGION_CACHE_PATH || '/tmp/bothook_pool_key_by_region.json';

  if (!desiredKeyId) throw new Error('pool_key_id_missing');
  if (region === sourceRegion) return desiredKeyId;

  // Cache lookup.
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const hit = j?.[region];
    if (hit) return String(hit);
  } catch {}

  // Describe public key in source region, then import into target region.
  const txt = tccli(`tccli lighthouse DescribeKeyPairs --region ${sourceRegion} --KeyIds '["${desiredKeyId}"]' --output json`);
  const dj = parseJsonStrict(txt, { op: 'DescribeKeyPairs', region: sourceRegion, instance_id: 'n/a' });
  const kp = (dj.KeyPairSet || [])[0] || null;
  const pub = String(kp?.PublicKey || '').trim();
  const name = String(kp?.KeyName || 'bothook_pool_key').trim() || 'bothook_pool_key';
  if (!pub) throw new Error('pool_key_public_key_missing');

  const impTxt = tccli(`tccli lighthouse ImportKeyPair --region ${region} --KeyName '${name}' --PublicKey '${pub.replace(/'/g, "'\\''")}' --output json`);
  const ij = parseJsonStrict(impTxt, { op: 'ImportKeyPair', region, instance_id: 'n/a' });
  const newKeyId = String(ij?.KeyId || ij?.KeyPairId || '').trim();
  if (!newKeyId) throw new Error('pool_key_import_failed');

  // Persist cache best-effort.
  try {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { j = {}; }
    j[region] = newKeyId;
    fs.writeFileSync(cachePath, JSON.stringify(j, null, 2));
  } catch {}

  return newKeyId;
}

function associateKey(region, instance_id) {
  // Allow duplicate binds as ok.
  try {
    const reg = String(region || '').trim() || DEFAULT_REGION;
    let keyId = resolvePoolKeyIdForRegion(reg);

    try {
      tccli(`tccli lighthouse AssociateInstancesKeyPairs --region ${reg} --InstanceIds '["${instance_id}"]' --KeyIds '["${keyId}"]' --output json`);
      return { ok: true, keyId };
    } catch (e1) {
      const msg1 = String(e1?._stderr || e1?.stderr || e1?.message || e1);
      // If key not found in region (cache stale), re-resolve (import) and retry once.
      if (msg1.includes('KeyIdNotFound') || msg1.includes('ResourceNotFound.KeyIdNotFound')) {
        keyId = resolvePoolKeyIdForRegion(reg);
        tccli(`tccli lighthouse AssociateInstancesKeyPairs --region ${reg} --InstanceIds '["${instance_id}"]' --KeyIds '["${keyId}"]' --output json`);
        return { ok: true, keyId, retried: true };
      }
      throw e1;
    }
  } catch (e) {
    const msg = String(e?._stderr || e?.stderr || e?.message || e);
    if (msg.includes('KeyPairBindDuplicate')) return { ok: true, duplicate: true };
    if (msg.includes('LatestOperationUnfinished')) return { ok: false, retryable: true };
    return { ok: false, error: 'associate_failed', msg };
  }
}

function ensureAutoRenew(region, instance_id, currentFlag, instanceChargeType) {
  // Only meaningful for PREPAID instances.
  if (String(instanceChargeType || '').toUpperCase() !== 'PREPAID') return { ok: true, skipped: true };
  const cur = String(currentFlag || '').trim();
  if (!cur) return { ok: true, skipped: true };
  if (cur === EXPECT_RENEW_FLAG) return { ok: true, already: true };
  try {
    const reg = String(region || '').trim() || DEFAULT_REGION;
    tccli(`tccli lighthouse ModifyInstancesRenewFlag --region ${reg} --InstanceIds '["${instance_id}"]' --RenewFlag ${EXPECT_RENEW_FLAG} --output json`);
    return { ok: true, changed: true, from: cur, to: EXPECT_RENEW_FLAG };
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e);
    return { ok: false, error: 'modify_renew_flag_failed', msg, from: cur, to: EXPECT_RENEW_FLAG };
  }
}

function sshProbe(ip) {
  const host = String(ip || '').trim();
  if (!host) return { ok: false, error: 'missing_ip' };

  // IMPORTANT: use a dedicated known_hosts for machine-to-machine probes.
  // Policy: accept-new (learn first-seen keys), but do NOT ignore changes.
  const KNOWN_HOSTS = process.env.BOTHOOK_POOL_KNOWN_HOSTS || '/tmp/bothook_pool_known_hosts';

  const probeCmd = (connectTimeoutSec) =>
    `ssh -i ${JSON.stringify(POOL_SSH_KEY)} `
    + `-o BatchMode=yes -o StrictHostKeyChecking=accept-new `
    + `-o UserKnownHostsFile=${JSON.stringify(KNOWN_HOSTS)} -o GlobalKnownHostsFile=/dev/null `
    + `-o UpdateHostKeys=yes -o HashKnownHosts=no `
    + `-o ConnectTimeout=${connectTimeoutSec} ubuntu@${host} `
    + `'set -euo pipefail; `
    + `echo ssh_ok; `
    + `test -x /home/ubuntu/.npm-global/bin/openclaw && echo has_openclaw || echo no_openclaw; `
    + `systemctl status openclaw-gateway.service >/dev/null 2>&1 && echo gateway_unit_ok || echo gateway_unit_missing'`;

  const parse = (out) => {
    const lines = String(out || '').trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    return {
      ok: lines.includes('ssh_ok'),
      hasOpenclaw: lines.includes('has_openclaw'),
      gatewayUnitOk: lines.includes('gateway_unit_ok'),
      raw: lines.slice(0, 10)
    };
  };

  // Attempt 1: fast probe
  try {
    const out = sh2(probeCmd(5));
    const r = parse(out);
    if (r.ok) return r;
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e);
    // Host key mismatch: clear our dedicated known_hosts entry and retry once.
    if (msg.includes('REMOTE HOST IDENTIFICATION HAS CHANGED') || msg.includes('Host key verification failed')) {
      try { sh2(`ssh-keygen -f ${JSON.stringify(KNOWN_HOSTS)} -R ${JSON.stringify(host)} >/dev/null 2>&1 || true`); } catch {}
    }
  }

  // Attempt 2: slightly longer timeout (handles transient network jitter)
  try {
    const out2 = sh2(probeCmd(8));
    return parse(out2);
  } catch (e2) {
    return { ok: false, error: String(e2?.stderr || e2?.message || e2) };
  }
}

function main() {
  const { db } = openDb();
  const ts = nowIso();

  const rows = db.prepare(
    `SELECT instance_id, region, lifecycle_status, health_status, health_reason, meta_json
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
    const region = String(r.region || '').trim() || DEFAULT_REGION;
    try {
      const it = describe(region, instance_id);
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
        renewFix = ensureAutoRenew(region, instance_id, renewFlag, instanceChargeType);
        if (renewFix?.changed) {
          db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
            .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_AUTORENEW_FIXED', JSON.stringify(renewFix));
        } else if (renewFix && renewFix.ok === false) {
          db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
            .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_AUTORENEW_FIX_FAILED', JSON.stringify(renewFix));
        }

        if (!keyIds.includes(POOL_KEY_ID)) {
          const rr = associateKey(region, instance_id);
          if (rr.ok) {
            keyfix++;
            db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
              .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_KEYPAIR_REBOUND', JSON.stringify({ pool_key_id: POOL_KEY_ID }));

            // Refresh keyIds after bind (best-effort).
            try {
              const it2 = describe(region, instance_id);
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
            // If previously marked ssh_fail, explicitly record recovery.
            const prevH = String(r.health_status || '');
            const prevR = String(r.health_reason || '');
            desiredReason = (prevH === 'NEEDS_VERIFY' && prevR === 'ssh_fail') ? 'ssh_recovered' : 'postboot_ok';
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
                last_ok_at=CASE WHEN ?='READY' THEN ? ELSE last_ok_at END,
                health_status=COALESCE(?, health_status),
                health_reason=COALESCE(?, health_reason),
                health_source=COALESCE(?, health_source),
                meta_json=?
          WHERE instance_id=?`
      ).run(pub, priv, bundle, blueprint, zone, ts, desiredHealth, ts, desiredHealth, desiredReason, desiredSource, meta2, instance_id);
      refreshed++;
    } catch (e) {
      fail++;
      const cls = classifyTccliError(e);
      const payload = {
        error_code: cls.code,
        retryable: cls.retryable,
        instance_id,
        region,
        message: String(e?.message || e),
        stderr_head: String(e?._stderr || '').slice(0, 800),
        stdout_head: String(e?._stdout || '').slice(0, 800)
      };
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), ts, 'instance', instance_id, 'CLOUD_RECONCILE_FAIL', JSON.stringify(payload));
    }
  }

  const summary = { ok: true, ts, scanned: rows.length, refreshed, keyfix, fail };
  console.log(JSON.stringify(summary, null, 2));
  if (keyfix || fail) {
    tgSend(`[bothook] cloud_reconcile: refreshed=${refreshed} keyfix=${keyfix} fail=${fail}`);
  }
}

main();
