#!/usr/bin/env node
/**
 * Import the current pool SSH private key into DB (encrypted) and attach to all IN_POOL instances.
 *
 * Phase 1: stores the existing shared pool key (fast). Later: per-instance keys.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDb, nowIso } from './lib/db.mjs';
import { encryptAesGcm } from './lib/crypto.mjs';

const KEY_PATH = process.env.BOTHOOK_POOL_SSH_KEY_PATH || '/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519';
const LOGIN_USER = process.env.BOTHOOK_POOL_SSH_LOGIN || 'ubuntu';

function sshFingerprint(pubPath) {
  // returns like: SHA256:xxxx
  const out = execFileSync('ssh-keygen', ['-lf', pubPath], { encoding: 'utf8' }).trim();
  // format: "256 SHA256:.... comment (ED25519)"
  const m = out.match(/\b(SHA256:[A-Za-z0-9+/=]+)\b/);
  return m ? m[1] : null;
}

function enqueue(db, kind, key, payload) {
  const stmt = db.prepare('INSERT INTO write_queue(enqueued_at, kind, key, payload_json) VALUES (?,?,?,?)');
  stmt.run(nowIso(), kind, key || null, JSON.stringify(payload));
}

function main() {
  const priv = fs.readFileSync(KEY_PATH);
  const pubPath = KEY_PATH + '.pub';
  if (!fs.existsSync(pubPath)) throw new Error(`missing pubkey: ${pubPath}`);

  const fp = sshFingerprint(pubPath);
  const enc = encryptAesGcm(priv);

  const { db } = openDb();
  const instances = db.prepare("SELECT instance_id FROM instances WHERE lifecycle_status='IN_POOL' OR lifecycle_status IS NULL").all();

  let n = 0;
  for (const row of instances) {
    const instance_id = row.instance_id;
    const payload = {
      cred_id: crypto.randomUUID(),
      instance_id,
      login_user: LOGIN_USER,
      auth_type: 'keypair',
      key_fingerprint: fp,
      private_key_ciphertext: Array.from(enc.ciphertext),
      private_key_iv: Array.from(enc.iv),
      private_key_tag: Array.from(enc.tag),
      private_key_alg: enc.alg,
      status: 'ACTIVE',
      created_at: nowIso(),
    };

    enqueue(db, 'ssh_cred_upsert', `ssh:${instance_id}:${fp || 'no_fp'}`, payload);
    enqueue(db, 'event', `ssh_import:${instance_id}:${fp || ''}`, {
      ts: nowIso(),
      entity_type: 'instance',
      entity_id: instance_id,
      event_type: 'SSH_CRED_IMPORTED',
      payload_json: { key_fingerprint: fp, login_user: LOGIN_USER, auth_type: 'keypair' }
    });
    n++;
  }

  console.log(JSON.stringify({ ok: true, importedForInstances: n, keyPath: KEY_PATH, fingerprint: fp }, null, 2));
}

main();
