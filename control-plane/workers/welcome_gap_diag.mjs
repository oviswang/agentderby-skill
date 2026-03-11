#!/usr/bin/env node
// Diagnose deliveries that are bound (or recently bound) but have no successful welcome send.
// Writes a structured event into the control-plane DB for later alerting/inspection.
import { openDb, nowIso } from '../lib/db.mjs';
import crypto from 'node:crypto';

const WINDOW_MIN = Number(process.env.BOTHOOK_WELCOME_GAP_WINDOW_MIN || 30);
const LIMIT = Number(process.env.BOTHOOK_WELCOME_GAP_LIMIT || 50);

// If control-plane proactive welcome is disabled (default), then "no welcome sent" is NOT a bug
// unless we have evidence of an attempted send (outbound task exists and failed/stuck).
const CP_WELCOME_UNPAID = String(process.env.BOTHOOK_CONTROL_PLANE_WELCOME_UNPAID || '0') === '1';

function safeJsonParse(s){
  try { return JSON.parse(String(s||'')); } catch { return null; }
}

function main(){
  const { db, dbPath } = openDb();
  const ts = nowIso();
  const since = new Date(Date.now() - WINDOW_MIN*60*1000).toISOString();

  // Candidate deliveries:
  // - have wa_jid set + bound_at within window
  // - not DELIVERED
  // - meta does NOT show welcome_unpaid_sent_at
  const rows = db.prepare(`
    SELECT delivery_id, provision_uuid, instance_id, status, wa_jid, bound_at, updated_at, user_lang, meta_json
    FROM deliveries
    WHERE wa_jid IS NOT NULL AND wa_jid != ''
      AND bound_at IS NOT NULL AND bound_at >= ?
      AND status NOT IN ('DELIVERED')
    ORDER BY datetime(bound_at) DESC
    LIMIT ?
  `).all(since, LIMIT) || [];

  const gaps = [];
  for (const d of rows){
    const meta = safeJsonParse(d.meta_json) || {};
    if (meta.welcome_unpaid_sent_at) continue;

    // Pull last outbound task info (welcome)
    let task = null;
    try {
      task = db.prepare(`
        SELECT status, attempt, next_run_at, last_error_code, last_error_detail, updated_at
        FROM outbound_tasks
        WHERE delivery_id=? AND kind='welcome_unpaid'
        ORDER BY datetime(updated_at) DESC
        LIMIT 1
      `).get(d.delivery_id) || null;
    } catch { task = null; }

    // In plugin-first mode, if there's no outbound task at all, we treat it as expected (not a gap).
    if (!CP_WELCOME_UNPAID && !task) continue;

    gaps.push({
      delivery_id: d.delivery_id,
      uuid: d.provision_uuid,
      instance_id: d.instance_id,
      status: d.status,
      lang: d.user_lang || null,
      wa_jid_set: Boolean(d.wa_jid),
      bound_at: d.bound_at,
      updated_at: d.updated_at,
      welcome_meta: {
        sent_at: meta.welcome_unpaid_sent_at || null,
        last_attempt_at: meta.welcome_unpaid_last_attempt_at || null,
        send_ok: meta.welcome_unpaid_send_ok ?? null,
      },
      outbound_task: task ? {
        status: task.status,
        attempt: task.attempt,
        next_run_at: task.next_run_at || null,
        last_error_code: task.last_error_code || null,
        last_error_detail: task.last_error_detail || null,
        updated_at: task.updated_at || null,
      } : null,
    });
  }

  // Write one summary event (idempotent per minute by dedupe key)
  const payload = {
    ts,
    windowMin: WINDOW_MIN,
    since,
    total_checked: rows.length,
    gap_count: gaps.length,
    gaps: gaps.slice(0, 20),
  };

  const dedupeKey = crypto.createHash('sha256').update(JSON.stringify({ ts: ts.slice(0,16), since, gap_count: gaps.length })).digest('hex');
  try {
    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json)
                VALUES (?,?,?,?,?,?)`).run(
      crypto.randomUUID(), ts, 'ops', 'welcome_gap', 'WELCOME_GAP_DIAG', JSON.stringify({ ...payload, dedupe_key: dedupeKey })
    );
  } catch {}

  console.log(JSON.stringify({ ok:true, dbPath, ts, windowMin: WINDOW_MIN, since, total: rows.length, gap_count: gaps.length }, null, 2));
}

main();
