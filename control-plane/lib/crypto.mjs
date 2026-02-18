import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function getMasterKeyPath() {
  return process.env.BOTHOOK_MASTER_KEY_PATH || path.join(process.cwd(), 'control-plane', 'keys', 'master.key');
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
