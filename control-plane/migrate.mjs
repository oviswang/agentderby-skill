#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { openDb, nowIso } from './lib/db.mjs';

const SCHEMA_VERSION = 1;

function readSchemaSql() {
  const p = path.join(process.cwd(), 'control-plane', 'schema.sql');
  return fs.readFileSync(p, 'utf8');
}

function main() {
  const { db, dbPath } = openDb();
  const schema = readSchemaSql();
  db.exec(schema);

  // Mark migration version (idempotent)
  const stmt = db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)');
  stmt.run(SCHEMA_VERSION, nowIso());

  const row = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
  console.log(JSON.stringify({ ok: true, dbPath, schemaVersion: row?.v ?? null }, null, 2));
}

main();
