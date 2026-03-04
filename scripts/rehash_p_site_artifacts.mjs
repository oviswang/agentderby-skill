#!/usr/bin/env node
/**
 * Recompute sha256sums.txt for a p-site artifacts version directory.
 *
 * Why:
 * - bootstrap.sh uses fetch_verified() which checks sha256sums.txt.
 * - If any artifact file changes without updating sha256sums.txt, pool init will fail (checksum_mismatch).
 *
 * Usage:
 *   node scripts/rehash_p_site_artifacts.mjs /var/www/p-site/artifacts/v0.2.23
 *   node scripts/rehash_p_site_artifacts.mjs /var/www/p-site/artifacts/v0.2.23 --check
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

function parseFetchVerifiedFromBootstrap(bootstrapPath) {
  if (!fs.existsSync(bootstrapPath)) return [];
  const txt = fs.readFileSync(bootstrapPath, 'utf8');
  const re = /fetch_verified\s+"([^"]+)"/g;
  const rels = new Set();
  let m;
  while ((m = re.exec(txt))) rels.add(m[1]);
  return [...rels];
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const targetDir = args.find(a => !a.startsWith('-')) || '/var/www/p-site/artifacts/latest';

const realDir = fs.lstatSync(targetDir).isSymbolicLink() ? fs.realpathSync(targetDir) : targetDir;
const sumsPath = path.join(realDir, 'sha256sums.txt');

if (!fs.existsSync(realDir) || !fs.statSync(realDir).isDirectory()) {
  console.error(`Not a directory: ${realDir}`);
  process.exit(2);
}

const files = walk(realDir)
  .filter(p => path.basename(p) !== 'sha256sums.txt')
  .sort();

const lines = files.map(p => {
  const rel = path.relative(realDir, p).replace(/\\/g, '/');
  const sum = sha256File(p);
  return `${sum}  ${rel}`;
});

const next = lines.join('\n') + '\n';

if (checkOnly) {
  const cur = fs.existsSync(sumsPath) ? fs.readFileSync(sumsPath, 'utf8') : '';
  if (cur === next) {
    console.log(JSON.stringify({ ok: true, action: 'check', dir: realDir, changed: false, files: files.length }, null, 2));
    process.exit(0);
  }

  // Extra: ensure every fetch_verified rel exists in sums (helps avoid silent drift)
  const bootstrapPath = path.join(realDir, 'bootstrap.sh');
  const need = parseFetchVerifiedFromBootstrap(bootstrapPath);
  const have = new Set(lines.map(l => l.split(/\s\s+/)[1]));
  const missing = need.filter(r => !have.has(r));

  console.log(JSON.stringify({ ok: true, action: 'check', dir: realDir, changed: true, files: files.length, missingFromSums: missing }, null, 2));
  process.exit(1);
}

fs.writeFileSync(sumsPath, next);

// Quick sanity check: every fetch_verified in bootstrap has a sums entry.
const bootstrapPath = path.join(realDir, 'bootstrap.sh');
const need = parseFetchVerifiedFromBootstrap(bootstrapPath);
const have = new Set(lines.map(l => l.split(/\s\s+/)[1]));
const missing = need.filter(r => !have.has(r));
if (missing.length) {
  console.error(`WARNING: bootstrap.sh references rel paths missing from sha256sums.txt: ${missing.join(', ')}`);
}

console.log(JSON.stringify({ ok: true, action: 'write', dir: realDir, sha256sums: sumsPath, files: files.length, missingFromSums: missing }, null, 2));
