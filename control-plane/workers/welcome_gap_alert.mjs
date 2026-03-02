#!/usr/bin/env node
// Send a low-noise Telegram alert when WELCOME_GAP_DIAG detects bound-but-no-welcome deliveries.
// Dedupe window: 30 minutes per alert hash.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDb, nowIso } from '../lib/db.mjs';

const TARGET = process.env.BOTHOOK_TELEGRAM_OWNER_CHAT_ID || '7095719535';
const DEDUPE_MIN = Number(process.env.BOTHOOK_WELCOME_GAP_ALERT_DEDUPE_MIN || 30);
const LOOKBACK_MIN = Number(process.env.BOTHOOK_WELCOME_GAP_ALERT_LOOKBACK_MIN || 15);

function sha256Hex(s){
  return crypto.createHash('sha256').update(String(s||'')).digest('hex');
}

function safeJsonParse(s){
  try { return JSON.parse(String(s||'')); } catch { return null; }
}

function ensureDedupeTable(db){
  db.exec(`CREATE TABLE IF NOT EXISTS ops_dedupe (
    k TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );`);
}

function seenRecently(db, k){
  try {
    const cutoff = new Date(Date.now() - DEDUPE_MIN*60*1000).toISOString();
    try { db.prepare('DELETE FROM ops_dedupe WHERE created_at < ?').run(cutoff); } catch {}
    const r = db.prepare('SELECT k FROM ops_dedupe WHERE k=? LIMIT 1').get(k);
    return Boolean(r?.k);
  } catch {
    return false;
  }
}

function markSeen(db, k){
  try { db.prepare('INSERT OR IGNORE INTO ops_dedupe(k, created_at) VALUES (?,?)').run(k, nowIso()); } catch {}
}

function summarize(diag){
  const gaps = Array.isArray(diag?.gaps) ? diag.gaps : [];
  const byReason = {};
  for (const g of gaps){
    const r = g?.outbound_task?.last_error_code || g?.outbound_task?.last_error_detail || 'unknown';
    byReason[r] = (byReason[r] || 0) + 1;
  }
  const topReasons = Object.entries(byReason).sort((a,b)=>b[1]-a[1]).slice(0,4);
  const uuids = gaps.map(g=>String(g.uuid||'')).filter(Boolean).slice(0,8);
  const fmtUuid = (u) => u ? (u.slice(0,8)+'…'+u.slice(-4)) : '';

  const lines = [];
  lines.push(`BOTHook alert: bound but welcome not sent`);
  lines.push(`window=${diag.windowMin}m gaps=${diag.gap_count} checked=${diag.total_checked}`);
  if (topReasons.length) {
    lines.push('reasons: ' + topReasons.map(([k,v])=>`${k}:${v}`).join(', '));
  }
  if (uuids.length) {
    lines.push('uuids: ' + uuids.map(fmtUuid).join(', '));
  }
  lines.push(`ts=${diag.ts}`);
  return lines.join('\n');
}

function sendTelegram(text){
  // Use OpenClaw CLI on control-plane host.
  // Do not pass secrets; text is safe summary.
  execFileSync('openclaw', ['message','send','--channel','telegram','--target', String(TARGET), '--message', String(text)], {
    stdio: 'ignore',
    timeout: 15000,
  });
}

function main(){
  const { db, dbPath } = openDb();
  ensureDedupeTable(db);
  const ts = nowIso();
  const since = new Date(Date.now() - LOOKBACK_MIN*60*1000).toISOString();

  const row = db.prepare(
    `SELECT ts, payload_json FROM events WHERE event_type='WELCOME_GAP_DIAG' AND ts >= ? ORDER BY ts DESC LIMIT 1`
  ).get(since);

  if (!row?.payload_json) {
    console.log(JSON.stringify({ ok:true, dbPath, ts, sent:false, reason:'no_recent_diag' }));
    return;
  }

  const diag = safeJsonParse(row.payload_json);
  const gapCount = Number(diag?.gap_count || 0);
  if (!gapCount) {
    console.log(JSON.stringify({ ok:true, dbPath, ts, sent:false, reason:'gap_count_zero' }));
    return;
  }

  const summary = summarize(diag);
  const h = sha256Hex(summary);
  const dk = `welcome_gap:${h}`;
  if (seenRecently(db, dk)) {
    console.log(JSON.stringify({ ok:true, dbPath, ts, sent:false, reason:'deduped', hash:h }));
    return;
  }

  // Send and record.
  let ok = false;
  let err = null;
  try {
    sendTelegram(summary);
    ok = true;
  } catch (e) {
    ok = false;
    err = String(e?.message || 'send_failed').slice(0,200);
  }

  if (ok) markSeen(db, dk);

  try {
    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json)
                VALUES (?,?,?,?,?,?)`).run(
      crypto.randomUUID(), nowIso(), 'ops', 'welcome_gap', ok ? 'WELCOME_GAP_ALERT_SENT' : 'WELCOME_GAP_ALERT_SEND_FAILED',
      JSON.stringify({ hash:h, dedupe_key: dk, gap_count: gapCount, diag_ts: diag.ts, error: err })
    );
  } catch {}

  console.log(JSON.stringify({ ok:true, dbPath, ts, sent: ok, gap_count: gapCount, hash:h, error: err }));
}

main();
