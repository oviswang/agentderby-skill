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
  return { db, dbPath };
}

export function nowIso() {
  return new Date().toISOString();
}
