import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function getMasterKeyPath() {
  // IMPORTANT: master.key must be stable across restarts.
  // Historical deployments accidentally created two possible locations:
  // - <cwd>/control-plane/keys/master.key (old)
  // - <cwd>/keys/master.key (new/desired)
  // Prefer explicit env, then prefer whichever already exists to avoid decrypt failures.
  const env = process.env.BOTHOOK_MASTER_KEY_PATH;
  if (env) return env;

  const cwd = process.cwd();
  const pNew = path.join(cwd, 'keys', 'master.key');
  const pOld = path.join(cwd, 'control-plane', 'keys', 'master.key');

  try {
    if (fs.existsSync(pNew)) return pNew;
    if (fs.existsSync(pOld)) return pOld;
  } catch {}

  // Default: create at the new canonical path.
  return pNew;
}

export function ensureMasterKey() {
  const p = getMasterKeyPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) {
    const key = crypto.randomBytes(32); // 256-bit
    fs.writeFileSync(p, key.toString('base64'), { mode: 0o600 });
  }
  try { fs.chmodSync(p, 0o600); } catch {}
  const raw = fs.readFileSync(p, 'utf8').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('master key must be 32 bytes base64');
  return { path: p, key };
}

export function encryptAesGcm(plaintextBuf) {
  const { key } = ensureMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { alg: 'aes-256-gcm', iv, tag, ciphertext };
}

export function decryptAesGcm({ iv, tag, ciphertext }) {
  const { key } = ensureMasterKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
