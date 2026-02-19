#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { openDb, nowIso } from './lib/db.mjs';

const SCHEMA_VERSION = 2;

function readSchemaSql() {
  const p = path.join(process.cwd(), 'control-plane', 'schema.sql');
  return fs.readFileSync(p, 'utf8');
}

function main() {
  const { db, dbPath } = openDb();
  const schema = readSchemaSql();
  db.exec(schema);

  // Apply additive migrations (SQLite cannot add columns via CREATE TABLE when table already exists)
  const v = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get()?.v ?? 0;
  if (v < 2) {
    try { db.exec("ALTER TABLE deliveries ADD COLUMN wa_jid TEXT"); } catch {}
    try { db.exec("ALTER TABLE deliveries ADD COLUMN wa_e164 TEXT"); } catch {}
    try { db.exec("ALTER TABLE deliveries ADD COLUMN bound_at TEXT"); } catch {}
  }

  // Mark migration version (idempotent)
  const stmt = db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)');
  stmt.run(SCHEMA_VERSION, nowIso());

  const row = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
  console.log(JSON.stringify({ ok: true, dbPath, schemaVersion: row?.v ?? null }, null, 2));
}

main();
