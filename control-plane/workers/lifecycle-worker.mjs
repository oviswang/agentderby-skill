#!/usr/bin/env node
/**
 * BOTHook lifecycle worker (Phase 1)
 *
 * Processes queued lifecycle actions from write_queue.
 * Goals: safe, auditable, idempotent-ish, and concurrency-limited.
 *
 * Queue row:
 * - kind: 'lifecycle_action'
 * - payload_json: { action, instance_id, reason?, dryRunAllowed? }
 *
 * Supported actions (initial):
 * - 'REIMAGE_TO_POOL' (placeholder; dry-run by default)
 * - 'TERMINATE_INSTANCE' (placeholder; dry-run by default)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { openDb, nowIso } from '../lib/db.mjs';

const LOCK_PATH = process.env.BOTHOOK_LIFECYCLE_LOCK || '/tmp/bothook.lifecycle.lock';

function sleep(ms){
  return new Promise((r)=>setTimeout(r, ms));
}

function tryAcquireLock(){
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx', 0o600);
    fs.writeFileSync(fd, `${process.pid} ${nowIso()}\n`);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(){
  try { fs.unlinkSync(LOCK_PATH); } catch {}
}

function parseArgs(){
  const args = process.argv.slice(2);
  const out = { once: false, dryRun: true, maxRows: 5 };
  for (let i=0;i<args.length;i++){
    const a=args[i];
    if (a==='--once') out.once=true;
    else if (a==='--dry-run') out.dryRun=true;
    else if (a==='--no-dry-run') out.dryRun=false;
    else if (a==='--max-rows') out.maxRows=parseInt(args[++i]||'5',10);
  }
  return out;
}

function appendEvent(db, { entity_type, entity_id, event_type, payload }){
  db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
    .run(crypto.randomUUID(), nowIso(), entity_type, entity_id, event_type, payload ? JSON.stringify(payload) : null);
}

function claimOne(db){
  // claim the oldest row of our kind
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT qid, enqueued_at, payload_json, attempts FROM write_queue WHERE kind=? ORDER BY qid ASC LIMIT 1')
      .get('lifecycle_action');
    if (!row){
      db.exec('COMMIT');
      return null;
    }
    // bump attempts so we can see progress even if we crash
    db.prepare('UPDATE write_queue SET attempts=attempts+1 WHERE qid=?').run(row.qid);
    db.exec('COMMIT');
    return row;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function finishRow(db, qid){
  db.prepare('DELETE FROM write_queue WHERE qid=?').run(qid);
}

function failRow(db, qid, err){
  const msg = String(err?.stack || err?.message || err);
  db.prepare('UPDATE write_queue SET last_error=? WHERE qid=?').run(msg.slice(0, 2000), qid);
}

async function handleAction(db, payload, { dryRun }){
  const { action, instance_id, reason } = payload || {};
  if (!action || !instance_id) throw new Error('bad_payload_missing_fields');

  // Record intent
  appendEvent(db, {
    entity_type: 'instance',
    entity_id: instance_id,
    event_type: 'LIFECYCLE_ACTION_START',
    payload: { action, reason: reason || null, dryRun }
  });

  if (dryRun) {
    appendEvent(db, {
      entity_type: 'instance',
      entity_id: instance_id,
      event_type: 'LIFECYCLE_ACTION_DRY_RUN',
      payload: { action }
    });
    return { ok: true, dryRun: true };
  }

  // NOTE: real cloud actions will be implemented next.
  // For now, refuse irreversible actions unless explicitly wired.
  throw new Error('real_actions_not_implemented');
}

async function main(){
  const opts = parseArgs();
  if (!tryAcquireLock()){
    console.error(JSON.stringify({ ok:false, error:'locked', lockPath: LOCK_PATH }, null, 2));
    process.exit(2);
  }

  const { db, dbPath } = openDb();
  console.log(JSON.stringify({ ok:true, dbPath, mode: opts.once ? 'once':'loop', dryRun: opts.dryRun, maxRows: opts.maxRows }, null, 2));

  let processed=0;
  try {
    for (;;) {
      const row = claimOne(db);
      if (!row) {
        if (opts.once) break;
        await sleep(1000);
        continue;
      }
      let payload;
      try { payload = JSON.parse(row.payload_json); } catch { payload = null; }

      try {
        const res = await handleAction(db, payload, { dryRun: opts.dryRun });
        finishRow(db, row.qid);
        processed++;
        console.log(JSON.stringify({ qid: row.qid, action: payload?.action, instance_id: payload?.instance_id, result: res }, null, 2));
      } catch (e) {
        failRow(db, row.qid, e);
        appendEvent(db, {
          entity_type: 'instance',
          entity_id: payload?.instance_id || 'unknown',
          event_type: 'LIFECYCLE_ACTION_FAIL',
          payload: { action: payload?.action || null, error: String(e?.message || e) }
        });
        console.error(JSON.stringify({ qid: row.qid, error: String(e?.message || e) }, null, 2));
        // Controlled retry: stop if we keep failing on same item.
        break;
      }

      if (opts.once && processed >= opts.maxRows) break;
      if (!opts.once && processed >= opts.maxRows) {
        // throttle between batches
        processed = 0;
        await sleep(1000);
      }
    }
  } finally {
    releaseLock();
  }
}

main().catch((e)=>{
  try { releaseLock(); } catch {}
  console.error(e);
  process.exit(1);
});
