#!/usr/bin/env node
/**
 * Archive old events to local jsonl files.
 *
 * Phase 1 target: local filesystem (later COS/S3).
 * Strategy:
 * - Select events older than cutoff (default 90d)
 * - Write to control-plane/archive/events/YYYY-MM-DD.jsonl
 * - Delete archived rows from SQLite
 */

import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './lib/db.mjs';

const DAYS = parseInt(process.env.BOTHOOK_EVENTS_RETENTION_DAYS || '90', 10);
const BATCH = parseInt(process.env.BOTHOOK_ARCHIVE_BATCH || '5000', 10);

function cutoffIso(days) {
  const d = new Date(Date.now() - days * 86400 * 1000);
  return d.toISOString();
}

function dayKey(isoTs) {
  return String(isoTs).slice(0, 10);
}

function main() {
  const { db } = openDb();
  const cutoff = cutoffIso(DAYS);
  const outDir = path.join(process.cwd(), 'control-plane', 'archive', 'events');
  fs.mkdirSync(outDir, { recursive: true });

  const sel = db.prepare('SELECT event_id, ts, entity_type, entity_id, event_type, payload_json FROM events WHERE ts < ? ORDER BY ts LIMIT ?');
  const del = db.prepare('DELETE FROM events WHERE event_id = ?');

  let total = 0;
  while (true) {
    const rows = sel.all(cutoff, BATCH);
    if (!rows.length) break;

    db.exec('BEGIN IMMEDIATE');
    try {
      // group by day to keep files bounded
      const groups = new Map();
      for (const r of rows) {
        const k = dayKey(r.ts);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }

      for (const [day, items] of groups.entries()) {
        const file = path.join(outDir, `${day}.jsonl`);
        const lines = items.map(x => JSON.stringify(x)).join('\n') + '\n';
        fs.appendFileSync(file, lines, 'utf8');
      }

      for (const r of rows) del.run(r.event_id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    total += rows.length;
  }

  console.log(JSON.stringify({ ok: true, cutoff, archived: total }, null, 2));
}

main();
