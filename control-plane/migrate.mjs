#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { openDb, nowIso } from './lib/db.mjs';

const SCHEMA_VERSION = 5;

function readSchemaSql() {
  // Resolve schema.sql relative to this file (works regardless of process.cwd()).
  const here = path.dirname(new URL(import.meta.url).pathname);
  const p = path.join(here, 'schema.sql');
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

  if (v < 5) {
    // Stripe timestamps
    try { db.exec("ALTER TABLE subscriptions ADD COLUMN cancel_at TEXT"); } catch {}
    try { db.exec("ALTER TABLE subscriptions ADD COLUMN canceled_at TEXT"); } catch {}
    try { db.exec("ALTER TABLE subscriptions ADD COLUMN ended_at TEXT"); } catch {}

    // Backfill: we previously stored Stripe cancel_at into current_period_end (schema lacked cancel_at).
    // Only apply for rows updated in a narrow window to avoid corrupting real current_period_end semantics.
    try {
      const cutoff = '2026-02-22T07:55:00.000Z';
      db.prepare(
        `UPDATE subscriptions
            SET cancel_at = current_period_end
          WHERE cancel_at IS NULL
            AND cancel_at_period_end = 0
            AND LOWER(status) = 'active'
            AND current_period_end IS NOT NULL
            AND updated_at >= ?`
      ).run(cutoff);
    } catch {}
  }

  // Mark migration version (idempotent)
  const stmt = db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)');
  stmt.run(SCHEMA_VERSION, nowIso());

  const row = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
  console.log(JSON.stringify({ ok: true, dbPath, schemaVersion: row?.v ?? null }, null, 2));
}

main();
