import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function getDbPath() {
  const p = process.env.BOTHOOK_DB_PATH || path.join(process.cwd(), 'control-plane', 'data', 'bothook.sqlite');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

export function openDb() {
  const dbPath = getDbPath();
  const db = new DatabaseSync(dbPath);
  // Pragmas for WAL + decent durability/throughput tradeoff
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  // Minimal outbox for smoketests + auditing of user-visible copy.
  db.exec(`CREATE TABLE IF NOT EXISTS outbox_messages(
    outbox_id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    uuid TEXT NOT NULL,
    kind TEXT NOT NULL,
    channel TEXT,
    target TEXT,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_outbox_uuid_ts ON outbox_messages(uuid, ts);');

  return { db, dbPath };
}

export function nowIso() {
  return new Date().toISOString();
}
