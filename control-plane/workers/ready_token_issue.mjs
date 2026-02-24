#!/usr/bin/env node
/**
 * Issue a short-lived READY-report token for a pool instance and write it onto the instance.
 * This is part of the INSTANCE lifecycle (pool init), not user delivery.
 *
 * Usage:
 *   node control-plane/workers/ready_token_issue.mjs --instance lhins-xxx [--minutes 30]
 */

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openDb, nowIso } from '../lib/db.mjs';

function arg(name){
  const i=process.argv.indexOf(name);
  if(i===-1) return null;
  return process.argv[i+1] ?? null;
}

const instanceId = arg('--instance');
const minutes = parseInt(arg('--minutes') || '30', 10);
if(!instanceId){
  console.error('missing --instance');
  process.exit(2);
}
if(instanceId==='lhins-npsqfxvn'){
  console.error('forbidden master host');
  process.exit(3);
}

const token = crypto.randomBytes(24).toString('hex');
const expIso = new Date(Date.now() + minutes*60*1000).toISOString();

const { db } = openDb();
const inst = db.prepare('SELECT instance_id, public_ip, meta_json FROM instances WHERE instance_id=?').get(instanceId);
if(!inst){
  console.error('instance not found');
  process.exit(4);
}
if(!inst.public_ip){
  console.error('instance missing public_ip');
  process.exit(5);
}

let meta={};
try{ meta = inst.meta_json ? JSON.parse(inst.meta_json) : {}; } catch { meta = {}; }
meta.ready_report_token = token;
meta.ready_report_exp = expIso;
meta.ready_report_issued_at = nowIso();

db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(JSON.stringify(meta), instanceId);

// Write to instance via SSH (pool key)
const key = process.env.BOTHOOK_POOL_SSH_KEY || '/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519';
const ip = inst.public_ip;
const content = `instance_id=${instanceId}\nready_report_token=${token}\nready_report_exp=${expIso}\n`;
const b64 = Buffer.from(content,'utf8').toString('base64');
const remote = `set -euo pipefail; sudo mkdir -p /opt/bothook; echo '${b64}' | base64 -d | sudo tee /opt/bothook/READY_REPORT.txt >/dev/null; sudo chmod 600 /opt/bothook/READY_REPORT.txt; sudo chown root:root /opt/bothook/READY_REPORT.txt; echo ok`;
const cmd = ['bash','-lc', `ssh -i ${key} -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null ubuntu@${ip} '${remote.replace(/'/g, "'\\''")}'`];
const r = spawnSync(cmd[0], cmd.slice(1), { encoding:'utf8', timeout: 15000, maxBuffer: 2*1024*1024 });
if((r.status ?? 0) !== 0){
  console.error('ssh write failed', r.stdout, r.stderr);
  process.exit(6);
}

console.log(JSON.stringify({ ok:true, instance_id: instanceId, public_ip: ip, token_issued:true, expIso }, null, 2));
