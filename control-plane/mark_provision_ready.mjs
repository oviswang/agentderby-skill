#!/usr/bin/env node
/**
 * Mark an instance as provision-ready (has bothook-provision service running).
 */

import { openDb } from './lib/db.mjs';

const id = process.argv[2];
if (!id) {
  console.error('usage: mark_provision_ready.mjs <instance_id>');
  process.exit(2);
}

const { db } = openDb();
const row = db.prepare('SELECT instance_id, meta_json FROM instances WHERE instance_id=?').get(id);
if (!row) {
  console.error('unknown instance', id);
  process.exit(2);
}

let meta = {};
try { meta = row.meta_json ? JSON.parse(row.meta_json) : {}; } catch { meta = {}; }
meta.provision_ready = true;

db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(JSON.stringify(meta), id);
console.log(JSON.stringify({ ok: true, instance_id: id, provision_ready: true }, null, 2));
