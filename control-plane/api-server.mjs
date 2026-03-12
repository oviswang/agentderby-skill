#!/usr/bin/env node
/**
 * BOTHook central Provisioning API (work machine)
 *
 * This service backs p.bothook.me /api/* and routes by UUID to a pool instance.
 *
 * Endpoints (mirrors pool provisioning server):
 * - POST /api/wa/start { uuid, turnstileToken? }
 * - GET  /api/wa/qr?uuid=...
 * - GET  /api/wa/status?uuid=...
 *
 * Allocation model (MVP):
 * - UUID is the provisioning session id.
 * - If UUID not yet mapped, allocate a pool instance (prefer meta.provision_ready=true).
 * - Persist mapping in SQLite deliveries table.
 */

import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

import { openDb, nowIso } from './lib/db.mjs';

// i18n WhatsApp prompt templates (for self-chat onboarding/relink messaging)
const WA_PROMPTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'i18n', 'whatsapp_prompts');
function loadWaPrompts(lang){
  const safe = String(lang||'').toLowerCase();
  const pick = (safe && fs.existsSync(path.join(WA_PROMPTS_DIR, `${safe}.json`))) ? safe : 'en';
  try { return JSON.parse(fs.readFileSync(path.join(WA_PROMPTS_DIR, `${pick}.json`), 'utf8')); } catch { return null; }
}
function renderTpl(s, vars){
  let out = String(s||'');
  for (const [k,v] of Object.entries(vars||{})) {
    out = out.split(`{{${k}}}`).join(String(v ?? ''));
  }
  return out;
}
function getDeliveryLang(delivery){
  try {
    const meta = jsonMeta(delivery?.meta_json) || {};
    return String(delivery?.user_lang || meta.preferred_lang || 'en').toLowerCase();
  } catch { return 'en'; }
}
function deliveryEntitled(db, delivery){
  try {
    // Legacy/ops reality: deliveries can be marked ACTIVE after delivery cutover.
    // Also some rows may not have user_id populated (legacy), so relying solely on subscriptions
    // would misclassify paid users as unpaid (causing welcome_unpaid to be sent on relink).
    const st0 = String(delivery?.status || '').toUpperCase();

    // Strong local signals (do not require subscriptions table):
    // - explicit lifecycle statuses
    // - paid/delivered markers in meta (covers relink flows where status may temporarily be LINKING)
    if (st0 === 'PAID' || st0 === 'DELIVERING' || st0 === 'DELIVERED') return true;
    try {
      const meta = jsonMeta(delivery?.meta_json) || {};
      if (meta.paid_at || meta.delivered_at || meta.stripe_subscription_id) return true;
    } catch {}

    const uid = String(delivery?.user_id || '').trim();
    if (!uid) return false;
    const sub = db.prepare(
      `SELECT provider_sub_id, provider, user_id, status,
              current_period_end, cancel_at, canceled_at, ended_at, updated_at
       FROM subscriptions
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    ).get(uid) || null;

    const now = Date.now();
    const providerOk = String(sub?.provider || '') === 'stripe' && !!sub?.provider_sub_id;
    const endedAt = sub?.ended_at ? Date.parse(sub.ended_at) : null;
    const cpe = sub?.current_period_end ? Date.parse(sub.current_period_end) : null;
    const cancelAt = sub?.cancel_at ? Date.parse(sub.cancel_at) : null;

    const notEnded = !endedAt || endedAt > now;
    const inPeriod = (cpe && cpe > now) || (cancelAt && cancelAt > now);
    const statusOk = ['active', 'trialing'].includes(String(sub?.status || '').toLowerCase());

    return Boolean(providerOk && notEnded && inPeriod && statusOk);
  } catch {
    return false;
  }
}

function getAttributionForUuid(db, uuid){
  try {
    const u = String(uuid || '').trim();
    if (!u) return null;
    // uuid attribution
    const r = db.prepare('SELECT payload_json FROM attributions WHERE uuid=? LIMIT 1').get(u);
    if (r?.payload_json) return JSON.parse(r.payload_json);
    // uuid->vid->vid attribution
    const m = db.prepare('SELECT vid FROM uuid_vid_map WHERE uuid=? LIMIT 1').get(u);
    const vid = m?.vid ? String(m.vid) : '';
    if (!vid) return null;
    const v = db.prepare('SELECT payload_json FROM vid_attributions WHERE vid=? LIMIT 1').get(vid);
    return v?.payload_json ? JSON.parse(v.payload_json) : null;
  } catch { return null; }
}

function sendSelfChatOnInstance(instance, text, { toJid } = {}){
  // Prefer loopback send endpoint (does not depend on CLI JSON output).
  // NOTE: `toJid` should be a WhatsApp JID like "6581...@s.whatsapp.net".
  // SMOKE/SIM: allow a non-deliverable simulated jid prefix (e.g. "sim:...") to bypass real WhatsApp sending.
  const t = String(text || '').trim();
  const to = String(toJid || '').trim();
  if (to && to.startsWith('sim:')) {
    return { code: 0, stdout: 'simulated', stderr: '' };
  }
  if (to) {
    // Send directly to self via WhatsApp target e164 derived from jid.
    // Use base64 to avoid shell quoting issues with newlines/UTF-8.
    const e164 = '+' + String(to).split('@')[0].split(':')[0].replace(/\D+/g, '');
    if (!/^\+\d{6,20}$/.test(e164)) return { code: 2, stdout: '', stderr: 'bad_toJid' };
    const b64 = Buffer.from(String(t), 'utf8').toString('base64');
    const cmd = `set -euo pipefail; MSG=$(echo '${b64}' | base64 -d); openclaw message send --channel whatsapp --target '${e164}' --message "$MSG" --json`;
    return poolSsh(instance, cmd, { timeoutMs: 15000, tty:false, retries: 1 });
  }

  // Fallback: Derive self e164 from channel status JSON, then send via CLI.
  // IMPORTANT: avoid heredoc in remote SSH (quoting is fragile); use python -c.
  const msg = JSON.stringify(t);
  const cmd = `set -euo pipefail; `
    + `JSON=$(openclaw channels status --probe --json 2>/dev/null || true); `
    + `SELF=$(JSON="$JSON" python3 -c "import os,json;\
try: j=json.loads(os.environ.get('JSON','') or '{}');\
except Exception: j={};\
wa=((j.get('channels',{}) or {}).get('whatsapp',{}) or {});\
self=(wa.get('self') or {});\
print(self.get('e164') or '')" ); `
    + `[ -n "$SELF" ] || { echo no_self; exit 2; }; `
    + `openclaw message send --channel whatsapp --target "$SELF" --message ${msg} --json`;
  return poolSsh(instance, cmd, { timeoutMs: 15000, tty:false, retries: 1 });
}

function writeOpenAiAuthOnInstance(db, instance, { uuid } = {}) {
  try {
    const safeUuid = String(uuid || '').trim();
    if (!safeUuid) return { ok:false, error:'uuid_required' };

    const row = db.prepare('SELECT ciphertext, iv, tag, alg, meta_json FROM delivery_secrets WHERE provision_uuid=? AND kind=? LIMIT 1').get(safeUuid, 'openai_api_key');
    if (!row?.ciphertext || !row?.iv || !row?.tag) return { ok:false, error:'missing_secret' };

    // Fields are stored as blobs by better-sqlite3; normalize to Buffer.
    const ciphertext = Buffer.isBuffer(row.ciphertext) ? row.ciphertext : Buffer.from(row.ciphertext);
    const iv = Buffer.isBuffer(row.iv) ? row.iv : Buffer.from(row.iv);
    const tag = Buffer.isBuffer(row.tag) ? row.tag : Buffer.from(row.tag);

    const key = decryptAesGcm({ iv, tag, ciphertext }).toString('utf8').trim();
    if (!key) return { ok:false, error:'decrypt_failed' };

    // Re-verify key before writing to user machine (key may have been revoked or billing may have changed).
    // Sync check (no async) to keep cutover paths simple.
    const tsCheck = nowIso();
    const metaOld = row?.meta_json ? (()=>{ try{return JSON.parse(row.meta_json)}catch{return {}} })() : {};
    let verifyOk = false;
    let verifyErr = null;
    let verifyStatus = 0;
    try {
      // Keep key out of argv by passing via env (base64) to a node helper.
      const envKeyB64 = Buffer.from(key, 'utf8').toString('base64');
      const r = sh(
        `set -euo pipefail; OPENAI_API_KEY_B64=${envKeyB64} node - <<'NODE'\
import { verifyOpenAiKey } from './lib/openai_verify.mjs';\
const b64 = process.env.OPENAI_API_KEY_B64 || '';\
const key = Buffer.from(b64, 'base64').toString('utf8');\
const out = await verifyOpenAiKey(key, { timeoutMs: 10000 });\
console.log(JSON.stringify(out));\
NODE`,
        { timeoutMs: 15000 }
      );
      const j = JSON.parse(String(r.stdout || '{}'));
      verifyOk = Boolean(j?.ok);
      verifyStatus = Number(j?.status || 0);
      verifyErr = verifyOk ? null : (j?.error || 'verify_failed');
    } catch {
      verifyOk = false;
      verifyStatus = 0;
      verifyErr = 'verify_failed';
    }

    // Only mark as INVALID when we have a strong signal (401/403).
    // For transient failures (timeouts, 429, 5xx, network), record inconclusive and DO NOT prompt the user.
    const strongInvalid = !verifyOk && (verifyStatus === 401 || verifyStatus === 403);

    try {
      const metaNew = JSON.stringify({
        ...metaOld,
        last_checked_at: tsCheck,
        last_check_ok: verifyOk ? true : (strongInvalid ? false : null),
        ...(verifyOk
          ? { verified_at: metaOld.verified_at || tsCheck }
          : (strongInvalid
              ? { invalid_at: tsCheck, invalid_reason: verifyErr || 'key_invalid' }
              : { last_check_error: verifyErr || 'verify_failed' }
            )
        )
      });
      db.prepare('UPDATE delivery_secrets SET meta_json=?, updated_at=? WHERE provision_uuid=? AND kind=?')
        .run(metaNew, tsCheck, safeUuid, 'openai_api_key');
    } catch {}

    // If the user already verified the key via /api/key/verify (metaOld.verified_at exists),
    // do NOT block cutover on a transient re-verify failure here. We still record the check error.
    if (!verifyOk && !strongInvalid && metaOld?.verified_at) {
      verifyOk = true;
    }

    if (!verifyOk) {
      return { ok:false, error: strongInvalid ? 'key_invalid' : 'key_verify_inconclusive' };
    }

    const authStore = {
      version: 1,
      profiles: {
        'openai:manual': { type: 'api_key', provider: 'openai', key }
      },
      order: { openai: ['openai:manual'] }
    };

    const b64 = Buffer.from(JSON.stringify(authStore, null, 2) + '\n', 'utf8').toString('base64');
    const remote = `set -euo pipefail; `
      + `AGENT_DIR=/home/ubuntu/.openclaw/agents/main/agent; `
      + `mkdir -p "$AGENT_DIR"; `
      + `echo '${b64}' | base64 -d > /tmp/auth-profiles.json; `
      + `sudo install -o ubuntu -g ubuntu -m 600 /tmp/auth-profiles.json "$AGENT_DIR/auth-profiles.json"; `
      + `rm -f /tmp/auth-profiles.json; `
      + `openclaw models set openai/gpt-5.2 >/dev/null 2>&1 || true; `
      + `echo ok`;

    const r = poolSsh(instance, remote, { timeoutMs: 20000, tty: false, retries: 1 });
    return { ok: (r.code ?? 1) == 0, ssh_code: r.code ?? 1, stderr: (r.stderr||'').slice(0,200) };
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}
import { encryptAesGcm, decryptAesGcm } from './lib/crypto.mjs';
import { verifyOpenAiKey } from './lib/openai_verify.mjs';

const PORT = parseInt(process.env.BOTHOOK_API_PORT || '18998', 10);
const POOL_HTTP_PORT = parseInt(process.env.BOTHOOK_POOL_HTTP_PORT || '80', 10);
const POOL_LOCAL_PORT = parseInt(process.env.BOTHOOK_POOL_LOCAL_PORT || '18999', 10);
const POOL_FETCH_MODE = String(process.env.BOTHOOK_POOL_FETCH_MODE || 'ssh').toLowerCase(); // ssh|http
const POOL_SSH_KEY = process.env.BOTHOOK_POOL_SSH_KEY || '/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519';


function readInstanceSpecsBestEffort(inst){
  // Best-effort specs for welcome messages.
  // Priority: DB meta_json -> /opt/bothook/SPECS.json on instance -> live shell probe.
  let cpu='?', ram_gb='?', disk_gb='?';

  try {
    const m = jsonMeta(inst?.meta_json) || {};
    if (m.cpu != null) cpu = String(m.cpu);
    if (m.ram_gb != null) ram_gb = String(m.ram_gb);
    if (m.disk_gb != null) disk_gb = String(m.disk_gb);
    // cloud_reconcile legacy: memory is GB
    if (ram_gb === '?' && m.memory != null) ram_gb = String(m.memory);
  } catch {}

  // Try stable specs file written by bootstrap/postboot.
  if ((cpu === '?' || ram_gb === '?' || disk_gb === '?') && inst?.public_ip) {
    try {
      const sr = poolSsh(
        inst,
        `set -euo pipefail; f=/opt/bothook/SPECS.json; if [ -f "$f" ]; then cat "$f"; fi`,
        { timeoutMs: 2500, tty: false, retries: 0 }
      );
      const raw = String(sr.stdout||'').trim();
      if (raw) {
        const j = JSON.parse(raw);
        if (cpu === '?' && j?.cpu != null) cpu = String(j.cpu);
        if (ram_gb === '?' && (j?.ram_gb != null || j?.memory_gb != null)) ram_gb = String(j.ram_gb ?? j.memory_gb);
        if (disk_gb === '?' && j?.disk_gb != null) disk_gb = String(j.disk_gb);
      }
    } catch {}
  }

  // Fallback: live probe (best-effort)
  if ((cpu === '?' || ram_gb === '?' || disk_gb === '?') && inst?.public_ip) {
    try {
      const sr = poolSsh(
        inst,
        `set -euo pipefail; `
          + `CPU=$(nproc 2>/dev/null || echo '?'); `
          + `RAM=$(free -m 2>/dev/null | awk '/Mem:/{printf "%.0f", $2/1024}' || echo '?'); `
          + `DISK=$(df -BG / 2>/dev/null | awk 'NR==2{gsub(/G/,"",$2); print $2}' || echo '?'); `
          + `echo "${CPU} ${RAM} ${DISK}"`,
        { timeoutMs: 3500, tty: false, retries: 0 }
      );
      const parts = String(sr.stdout||'').trim().split(/\s+/);
      if (parts[0] && cpu === '?') cpu = parts[0];
      if (parts[1] && ram_gb === '?') ram_gb = parts[1];
      if (parts[2] && disk_gb === '?') disk_gb = parts[2];
    } catch {}
  }

  // Owner requirement: if still unknown, pin to 2c/2g/40g to avoid missing config in welcome.
  if (cpu === '?') cpu = '2';
  if (ram_gb === '?') ram_gb = '2';
  if (disk_gb === '?') disk_gb = '40';

  return { cpu, ram_gb, disk_gb };
}

function normalizeWaBase(waJid){
  try {
    if (!waJid) return null;
    const left = String(waJid).split('@')[0];
    const num = left.split(':')[0];
    return num + '@s.whatsapp.net';
  } catch {
    return null;
  }
}

function jsonMeta(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

function pickProvisionReady(instances) {
  const requiredArtifacts = getRequiredArtifactsVersion();
  for (const i of instances) {
    const meta = jsonMeta(i.meta_json) || {};
    const pr = meta.provision_ready;
    if (!(pr === true || pr === 1 || pr === '1')) continue;

    // Versioned READY gate (prevents allocating old images after artifacts/latest bumps).
    if (requiredArtifacts && String(meta.provision_artifacts_version || '') !== String(requiredArtifacts)) continue;
    if (MIN_OPENCLAW_VERSION && cmpVersion(meta.provision_openclaw_version, MIN_OPENCLAW_VERSION) < 0) continue;

    return i;
  }
  return null;
}

function parseChannelsStatusJson(text) {
  try {
    const rawText = String(text || '');
    const a = rawText.indexOf('{');
    const b = rawText.lastIndexOf('}');
    const jsonText = (a >= 0 && b >= a) ? rawText.slice(a, b + 1) : rawText;
    const j = JSON.parse(jsonText);
    const w = j?.channels?.whatsapp || j?.whatsapp || null;
    const selfJid = w?.self?.jid ? String(w.self.jid) : null;
    const linked = Boolean(w?.linked);
    const connected = Boolean(w?.connected);
    return { ok: true, linked, connected, selfJid, raw: j };
  } catch {
    return { ok: false, linked: false, connected: false, selfJid: null, raw: null };
  }
}

// (normalizeWaBase already defined above)

function probeInstanceWhatsappClean(db, instance, { timeoutMs = 12000 } = {}) {
  // A-mode strict gate: pool instances must be WhatsApp-unlinked before allocation.
  // Returns { ok, clean, linked, connected, selfJid, detail }
  // IMPORTANT: keep this probe lightweight and non-interactive.
  // Do NOT call sudo/systemctl here: it can hang or fail under non-tty SSH and will create false negatives.
  const cmd = `set -euo pipefail; `
    + `openclaw channels status --json`;

  // Fail-fast: do NOT let web handlers block on slow/overloaded instances.
  const r = poolSsh(instance, cmd, { timeoutMs, tty: false, retries: 0, profile: 'fast' });
  const text = (r.stdout || r.stderr || '').trim();
  const parsed = parseChannelsStatusJson(text);

  let linked = false;
  let connected = false;
  let selfJid = null;
  if (parsed.ok) {
    linked = parsed.linked;
    connected = parsed.connected;
    selfJid = parsed.selfJid;
  } else {
    // best-effort text fallback
    const lower = text.toLowerCase();
    linked = lower.includes('whatsapp') && lower.includes('linked') && !lower.includes('not linked');
    connected = lower.includes('whatsapp') && lower.includes('connected');
    selfJid = null;
  }

  // NOTE: some OpenClaw CLI versions may exit non-zero even when emitting valid JSON (e.g. due to doctor warnings).
  // Treat "parsed JSON ok" as the source of truth for this probe.
  const ok = parsed.ok;
  // Strict: if we cannot positively determine status, treat instance as NOT clean.
  const clean = ok ? !linked : false;
  const ts = nowIso();
  const evidence = JSON.stringify({ ok, linked, connected, selfJid, exit_code: r.code ?? null, via: 'probeInstanceWhatsappClean' });
  try {
    db.prepare('UPDATE instances SET last_probe_at=? WHERE instance_id=?').run(ts, instance.instance_id);
    if (!ok) {
      // Fail-closed for allocation decisions, but avoid downgrading a freshly-verified READY instance
      // due to transient OpenClaw startup/CLI noise.
      let curHs = '';
      try {
        const cur = db.prepare('SELECT health_status FROM instances WHERE instance_id=?').get(instance.instance_id);
        curHs = String(cur?.health_status || '');
      } catch {}

      if (curHs === 'READY') {
        // Keep READY, but record evidence for debugging.
        db.prepare(
          'UPDATE instances SET health_reason=?, health_source=?, last_verify_evidence=? WHERE instance_id=?'
        ).run('probe_failed_observed', 'probe_pull', evidence, instance.instance_id);
      } else {
        // Unknown probe result must NOT be treated as DIRTY/linked.
        db.prepare(
          'UPDATE instances SET health_status=?, health_reason=?, health_source=?, last_verify_evidence=? WHERE instance_id=?'
        ).run('NEEDS_VERIFY', 'probe_failed', 'probe_pull', evidence, instance.instance_id);
      }
    } else if (clean) {
      db.prepare(
        'UPDATE instances SET health_status=?, last_ok_at=?, health_reason=?, health_source=?, last_verify_evidence=? WHERE instance_id=?'
      ).run('READY', ts, 'whatsapp_unlinked', 'probe_pull', evidence, instance.instance_id);
    } else {
      db.prepare(
        'UPDATE instances SET health_status=?, health_reason=?, health_source=?, last_verify_evidence=? WHERE instance_id=?'
      ).run('DIRTY', 'whatsapp_linked', 'probe_pull', evidence, instance.instance_id);
    }
  } catch {}

  return { ok, clean, linked, connected, selfJid, detail: text.slice(0, 400) };
}

function getOrCreateDeliveryForUuid(db, uuid, { preferredLang } = {}) {
  const existing = db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
  if (existing) {
    // Best-effort: persist preferred lang when provided.
    let updated = existing;
    try {
      const lang = String(preferredLang || '').trim().toLowerCase();
      if (lang) {
        const meta = mergeMeta(existing.meta_json, { preferred_lang: lang });
        // Strategy #2 (owner confirmed): allow overwrite so the latest P-site language always wins.
        db.prepare('UPDATE deliveries SET meta_json=?, user_lang=?, updated_at=? WHERE delivery_id=?')
          .run(meta, lang, nowIso(), existing.delivery_id);
        updated = { ...existing, meta_json: meta, user_lang: lang };
      }
    } catch {}

    // IMPORTANT: If watchdog cleared instance_id (e.g. stale QR_EXPIRED) we must re-allocate a fresh pool machine.
    // This keeps the website flow self-healing: user can click "retry" and get a new QR.
    const st = String(updated.status || '');
    const needsAlloc = !updated.instance_id && ['QR_EXPIRED','CANCELED','LINKING_TIMEOUT','LINKING'].includes(st);
    if (needsAlloc) {
      // Respect ops/manual suppression: when do_not_reallocate=1 (or closed_out markers exist),
      // never allocate a new pool instance. This prevents stale/abandoned deliveries from
      // repeatedly stealing pool machines and also stops noisy reallocation attempts.
      const metaR = jsonMeta(updated.meta_json) || {};
      const suppressed = Number(metaR.do_not_reallocate || 0) === 1 || Boolean(metaR.closed_out_at || metaR.closed_out_reason);
      if (suppressed) {
        const ts = nowIso();
        const reason = (suppressed && Number(metaR.do_not_reallocate || 0) === 1)
          ? 'do_not_reallocate'
          : 'closed_out';

        // De-noise: dedupe suppressed events per delivery+reason within a window.
        // This prevents QR_EXPIRED polling/refresh loops from spamming events/alerts.
        const DEDUPE_MS = parseInt(process.env.BOTHOOK_REALLOCATE_SUPPRESS_DEDUPE_MS || String(30 * 60 * 1000), 10);
        let shouldEmit = true;
        try {
          const row = db.prepare(
            `SELECT ts, payload_json
               FROM events
              WHERE entity_type='delivery'
                AND entity_id=?
                AND event_type='PROVISION_REALLOCATE_SUPPRESSED'
              ORDER BY datetime(ts) DESC
              LIMIT 1`
          ).get(updated.delivery_id);

          if (row && row.ts) {
            const lastTs = Date.parse(String(row.ts));
            const last = jsonMeta(row.payload_json) || {};
            const lastReason = String(last.reason || '').trim();
            if (Number.isFinite(lastTs) && (Date.now() - lastTs) < DEDUPE_MS && lastReason === reason) {
              shouldEmit = false;
            }
          }
        } catch {}

        if (shouldEmit) {
          try {
            db.prepare(
              `INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json)
               VALUES (?,?,?,?,?,?)`
            ).run(
              crypto.randomUUID(),
              ts,
              'delivery',
              updated.delivery_id,
              'PROVISION_REALLOCATE_SUPPRESSED',
              JSON.stringify({ provision_uuid: uuid, delivery_id: updated.delivery_id, from_status: st, reason })
            );
          } catch {}
        }
        return updated;
      }

      console.log('[bothook-api] reallocating instance for uuid', uuid, 'status', st, 'delivery_id', updated.delivery_id);
      // Re-enter allocation path by treating as non-existing.
      // (We allocate a clean instance and move status back to LINKING.)
      // NOTE: we keep the same delivery_id and provision_uuid.
      const ts = nowIso();

      const candidates = db.prepare(`
        SELECT instance_id, public_ip, lifecycle_status, health_status, meta_json, created_at
        FROM instances
        WHERE public_ip IS NOT NULL AND public_ip != ''
          AND lifecycle_status='IN_POOL'
          AND health_status='READY'
        ORDER BY created_at ASC
        LIMIT 50
      `).all();

      const requiredArtifacts = getRequiredArtifactsVersion();
      const provisionReady = candidates.filter((i) => {
        const meta = (jsonMeta(i.meta_json) || {});
        if (meta.provision_ready !== true) return false;
        if (requiredArtifacts && String(meta.provision_artifacts_version || '') !== String(requiredArtifacts)) return false;
        if (MIN_OPENCLAW_VERSION && cmpVersion(meta.provision_openclaw_version, MIN_OPENCLAW_VERSION) < 0) return false;
        return true;
      });
      if (!provisionReady.length) {
        throw Object.assign(new Error('No provision-ready instances available'), { statusCode: 503 });
      }

      let chosen = null;
      for (const c of provisionReady) {
        const inst = getInstanceById(db, c.instance_id);
        const probe = probeInstanceWhatsappClean(db, inst);
        if (probe.clean) { chosen = inst; break; }
      }
      if (!chosen) {
        throw Object.assign(new Error('No clean instances available (all linked). Please retry in a few minutes.'), { statusCode: 503 });
      }

      db.exec('BEGIN IMMEDIATE');
      try {
        const meta2 = mergeMeta(updated.meta_json, {
          reallocated_at: ts,
          prev_instance_id: updated.instance_id || null,
          prev_status: updated.status || null
        });
        db.prepare('UPDATE deliveries SET instance_id=?, status=?, updated_at=?, meta_json=? WHERE delivery_id=?')
          .run(chosen.instance_id, 'LINKING', ts, meta2, updated.delivery_id);

        db.prepare('UPDATE instances SET lifecycle_status=?, assigned_user_id=?, assigned_at=? WHERE instance_id=?')
          .run('ALLOCATED', uuid, ts, chosen.instance_id);

        {
          const wr = writeUuidStateFilesOnInstance(chosen, { uuid, lang: preferredLang || 'en' });
          recordDeliveryEventBestEffort(db, uuid, wr?.ok ? 'UUID_FILE_WRITTEN' : 'UUID_FILE_WRITE_FAILED', {
            uuid,
            instance_id: chosen.instance_id,
            public_ip: chosen.public_ip,
            lang: preferredLang || 'en',
            ...wr
          });
        }

        db.prepare(`
          INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json)
          VALUES (?,?,?,?,?,?)
        `).run(
          crypto.randomUUID(),
          ts,
          'instance',
          chosen.instance_id,
          'PROVISION_REALLOCATED',
          JSON.stringify({ provision_uuid: uuid, delivery_id: updated.delivery_id, from_status: st })
        );

        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }

      updated = db.prepare('SELECT * FROM deliveries WHERE delivery_id=?').get(updated.delivery_id);
    }

    return updated;
  }

  // Allocation is triggered explicitly by user action (/api/wa/start). Do NOT allocate here.
  // This keeps /api/p/state and simple page visits fast and prevents control-plane hangs.
  {
    const delivery_id = crypto.randomUUID();
    const ts = nowIso();
    db.prepare(`
      INSERT INTO deliveries(delivery_id, order_id, user_id, instance_id, status, provision_uuid, created_at, updated_at, meta_json, user_lang)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      delivery_id,
      null,
      uuid,
      null,
      'NEW',
      uuid,
      ts,
      ts,
      JSON.stringify({ allocated_from: null, note: 'created_without_allocation; allocate on /api/wa/start' }),
      preferredLang || null
    );
    return db.prepare('SELECT * FROM deliveries WHERE delivery_id=?').get(delivery_id);
  }

  // A-mode strict allocation: choose only pool instances and reserve exclusively.
  // IMPORTANT: allocator must only use READY pool instances (prevents assigning DIRTY/NEEDS_VERIFY machines).
  const candidates = db.prepare(`
    SELECT instance_id, public_ip, lifecycle_status, health_status, meta_json, created_at
    FROM instances
    WHERE public_ip IS NOT NULL AND public_ip != ''
      AND lifecycle_status='IN_POOL'
      AND health_status='READY'
    ORDER BY created_at ASC
    LIMIT 50
  `).all();

  const requiredArtifacts = getRequiredArtifactsVersion();
      const provisionReady = candidates.filter((i) => {
        const meta = (jsonMeta(i.meta_json) || {});
        if (meta.provision_ready !== true) return false;
        if (requiredArtifacts && String(meta.provision_artifacts_version || '') !== String(requiredArtifacts)) return false;
        if (MIN_OPENCLAW_VERSION && cmpVersion(meta.provision_openclaw_version, MIN_OPENCLAW_VERSION) < 0) return false;
        return true;
      });
  if (!provisionReady.length) {
    throw Object.assign(new Error('No provision-ready instances available'), { statusCode: 503 });
  }

  // Extra guard: do not allocate any instance that already has other active/delivered deliveries.
  // This prevents allocating a delivered user's machine to a new UUID (QR/start will fail and is a security issue).
  const conflictFree = provisionReady.filter((c) => !hasOtherActiveDeliveriesOnInstance(db, c.instance_id, uuid).length);
  if (!conflictFree.length) {
    throw Object.assign(new Error('No conflict-free instances available. Please retry in a few minutes.'), { statusCode: 503 });
  }

  // Pick the first instance that is WhatsApp-clean (NOT linked).
  // NOTE: we run a live probe here to prevent "connected != this UUID" false positives.
  let chosen = null;
  for (const c of conflictFree) {
    const inst = getInstanceById(db, c.instance_id);
    const probe = probeInstanceWhatsappClean(db, inst);
    if (probe.clean) { chosen = inst; break; }
  }
  if (!chosen) {
    throw Object.assign(new Error('No clean instances available (all linked). Please retry in a few minutes.'), { statusCode: 503 });
  }

  const delivery_id = crypto.randomUUID();
  const ts = nowIso();

  // Reserve + create delivery mapping.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO deliveries(delivery_id, order_id, user_id, instance_id, status, provision_uuid, created_at, updated_at, meta_json)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      delivery_id,
      null,
      uuid,
      chosen.instance_id,
      'LINKING',
      uuid,
      ts,
      ts,
      JSON.stringify({ allocated_from: 'pool', note: 'A-mode strict: reserved clean instance only' })
    );

    db.prepare('UPDATE instances SET lifecycle_status=?, assigned_user_id=?, assigned_at=? WHERE instance_id=?')
      .run('ALLOCATED', uuid, ts, chosen.instance_id);

    // NOTE: READY-report tokens are issued during pool init/reimage (instance lifecycle),
    // not during user allocation (delivery lifecycle). Do not couple instance readiness to user UUID.

    // Persist UUID recovery link + basic inbound state on the user machine for later relink/support.
    // This must be present even before WhatsApp linking succeeds.
    {
      const wr = writeUuidStateFilesOnInstance(chosen, { uuid, lang: preferredLang || 'en' });
      recordDeliveryEventBestEffort(db, uuid, wr?.ok ? 'UUID_FILE_WRITTEN' : 'UUID_FILE_WRITE_FAILED', {
        uuid,
        instance_id: chosen.instance_id,
        public_ip: chosen.public_ip,
        lang: preferredLang || 'en',
        ...wr
      });
    }

    db.prepare(`
      INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json)
      VALUES (?,?,?,?,?,?)
    `).run(
      crypto.randomUUID(),
      ts,
      'instance',
      chosen.instance_id,
      'PROVISION_ALLOCATED',
      JSON.stringify({ provision_uuid: uuid, delivery_id })
    );

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  // Best-effort: cache SPECS into instances.meta_json so /api/p/state can show cpu/memory without live SSH.
  try {
    const sr = poolSsh(chosen, 'sudo cat /opt/bothook/SPECS.json 2>/dev/null || echo missing', { timeoutMs: 6000, tty:false, retries: 0 });
    const stxt = String(sr.stdout||'').trim();
    if (stxt && stxt !== 'missing') {
      const specs = JSON.parse(stxt);
      const curX = getInstanceById(db, chosen.instance_id);
      const meta = mergeMeta(curX?.meta_json, {
        cpu: specs?.cpu ?? null,
        memory: specs?.ram_gb ?? null,
        disk_gb: specs?.disk_gb ?? null,
        openclaw_version: specs?.openclaw_version ?? null,
        specs_captured_at: specs?.captured_at ?? null,
      });
      db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(meta, chosen.instance_id);
    }
  } catch {}

  return db.prepare('SELECT * FROM deliveries WHERE delivery_id = ?').get(delivery_id);
}

function getDeliveryByUuid(db, uuid){
  return db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
}

function mergeMeta(oldJson, patch){
  let obj = {};
  try { obj = oldJson ? JSON.parse(oldJson) : {}; } catch { obj = {}; }
  return JSON.stringify({ ...obj, ...patch });
}

function parseVerParts(v){
  return String(v || '').trim().split('.').map((x) => {
    const n = Number(String(x).replace(/[^0-9]/g, ''));
    return Number.isFinite(n) ? n : 0;
  });
}

function cmpVersion(a, b){
  const aa = parseVerParts(a);
  const bb = parseVerParts(b);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function getRequiredArtifactsVersion(){
  try {
    const p = '/home/ubuntu/.openclaw/workspace/p-site/artifacts/latest/manifest.json';
    const j = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    return String(j?.version || '').trim() || null;
  } catch {
    return null;
  }
}

const MIN_OPENCLAW_VERSION = String(process.env.BOTHOOK_MIN_OPENCLAW_VERSION || '2026.3.7').trim();

function makeReadyReportToken(){
  // short-lived capability token (instance-scoped)
  return crypto.randomBytes(24).toString('hex');
}

function tokenNotExpired(expIso){
  if (!expIso) return false;
  try { return Date.parse(expIso) > Date.now(); } catch { return false; }
}

function writeReadyReportFilesOnInstance(instance, { token, expIso } = {}) {
  // Store instance-scoped token on the pool machine so post-boot verify can report READY.
  // No global secrets.
  const instId = instance.instance_id;
  const ip = instance.public_ip;
  if (!instId || !ip || !token) return;
  const content = `instance_id=${instId}\nready_report_token=${token}\nready_report_exp=${expIso || ''}\n`;
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const remote = `set -euo pipefail; sudo mkdir -p /opt/bothook; echo '${b64}' | base64 -d | sudo tee /opt/bothook/READY_REPORT.txt >/dev/null; `
    + `sudo chmod 600 /opt/bothook/READY_REPORT.txt; sudo chown root:root /opt/bothook/READY_REPORT.txt; echo ok`;
  try { poolSsh(instance, remote, { timeoutMs: 12000, tty: false, retries: 1 }); } catch {}
}

function writeUuidStateFilesOnInstance(instance, { uuid, lang } = {}) {
  try {
    const safeUuid = String(uuid || '').trim();
    if (!safeUuid) return { ok: false, code: 1, detail: 'uuid_empty' };
    const safeLang = String(lang || 'en').trim().toLowerCase() || 'en';
    const pLink = `https://p.bothook.me/p/${encodeURIComponent(safeUuid)}?lang=${encodeURIComponent(safeLang)}`;

    const uuidB64 = Buffer.from(`uuid=${safeUuid}\np_link=${pLink}\n`, 'utf8').toString('base64');

    // IMPORTANT: reset instance-side autoreply state on UUID assignment.
    // Reason: state.json contains cached welcome text; without reset it can leak across UUIDs/languages.
    const stateB64 = Buffer.from(JSON.stringify({
      autoreply: {
        uuid: safeUuid,
        externalReplied: {},
        welcome_full_sent_at: null,
        welcome_short_sent_at: null,
        welcome_full_scheduled_at: null,
        cachedWelcomeUnpaidText: null,
        cachedWelcomeUnpaidAt: null,
        cachedWelcomeUnpaidUuid: null,
        welcome_full_echo_after_user_msg_at: null
      }
    }, null, 2) + "\n", 'utf8').toString('base64');

    const instB64 = Buffer.from(JSON.stringify({
      region: String(instance?.region || ''),
      public_ip: String(instance?.public_ip || '')
    }, null, 2) + "\n", 'utf8').toString('base64');

    const remote = `set -euo pipefail; `
      + `sudo mkdir -p /opt/bothook; `
      + `echo '${uuidB64}' | base64 -d | sudo tee /opt/bothook/UUID.txt >/dev/null; `
      + `sudo chmod 644 /opt/bothook/UUID.txt; `
      + `echo '${instB64}' | base64 -d | sudo tee /opt/bothook/INSTANCE.json >/dev/null; `
      + `sudo chmod 644 /opt/bothook/INSTANCE.json; `
      + `echo '${stateB64}' | base64 -d | sudo tee /opt/bothook/state.json >/dev/null; `
      + `sudo chown ubuntu:ubuntu /opt/bothook/state.json || true; `
      + `sudo chmod 664 /opt/bothook/state.json || true; `
      + `echo ok`;

    // This write is critical for instance-side autoreply (UUID.txt).
    // slow SSH handshakes are common on fresh boxes.
    const rr = poolSsh(instance, remote, { timeoutMs: 20000, tty: false, retries: 2, profile: 'fast' });
    return { ok: (rr?.code ?? 1) === 0, code: rr?.code ?? 1, detail: String(rr?.stderr || rr?.stdout || '').replace(/\s+/g,' ').slice(0, 160) };
  } catch (e) {
    return { ok: false, code: 1, detail: 'exception' };
  }
}

// In-memory de-dupe for welcome scheduling retries (best-effort within a single process lifetime).
const _welcomeScheduleInFlight = new Map();

function recordDeliveryEventBestEffort(db, delivery_id, event_type, payload) {
  try {
    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
      crypto.randomUUID(), nowIso(), 'delivery', String(delivery_id), String(event_type), JSON.stringify(payload || {})
    );
  } catch {}
}

function scheduleAutoreplyFullWelcomeOnInstance(instance, { uuid, delayMs = 15_000 } = {}) {
  try {
    const safeUuid = String(uuid || '').trim();
    if (!safeUuid) return { ok: false, code: 1, detail: 'uuid_empty' };
    if (!instance?.public_ip) return { ok: false, code: 1, detail: 'instance_missing_ip' };

    // The bothook-wa-autoreply plugin can proactively send the full welcome when this is set.
    // Key property: the retry loop lives instance-side and will naturally wait until WhatsApp is truly connected.
    const scheduledAt = new Date(Date.now() + Math.max(0, Number(delayMs) || 0)).toISOString();

    const py = [
      "import json,os",
      "p='/opt/bothook/state.json'",
      "st={}",
      "\ntry:\n  st=json.load(open(p)) if os.path.exists(p) else {}\nexcept Exception:\n  st={}",
      "ar=st.get('autoreply') or {}",
      // Always refresh uuid context + schedule welcome if not already sent.
      "if not ar.get('uuid'): ar['uuid']=" + JSON.stringify(safeUuid),
      "if not ar.get('welcome_full_sent_at'): ar['welcome_full_scheduled_at']=" + JSON.stringify(scheduledAt),
      "st['autoreply']=ar",
      "os.makedirs('/opt/bothook', exist_ok=True)",
      "open(p,'w').write(json.dumps(st,indent=2)+'\\n')",
      "print('ok')",
    ].join(';');

    const remote = `set -euo pipefail; sudo mkdir -p /opt/bothook; `
      + `python3 -c '${py.replace(/'/g, "'\\''")}' >/dev/null 2>&1 || true; `
      + `sudo chown ubuntu:ubuntu /opt/bothook/state.json || true; `
      + `sudo chmod 664 /opt/bothook/state.json || true; `
      + `echo ok`;

    const rr = poolSshFast(instance, remote, { timeoutMs: 8000, tty: false, retries: 0 });
    return { ok: (rr?.code ?? 1) === 0, code: rr?.code ?? 1, detail: String(rr?.stderr || rr?.stdout || '').replace(/\s+/g,' ').slice(0, 160) };
  } catch {
    return { ok: false, code: 1, detail: 'exception' };
  }
}

function kickWelcomeScheduleRetries(uuid, { maxWindowMs = 120_000 } = {}) {
  try {
    const key = String(uuid || '').trim();
    if (!key) return;
    if (_welcomeScheduleInFlight.has(key)) return;
    _welcomeScheduleInFlight.set(key, Date.now());

    const delays = [15_000, 30_000, 60_000, 90_000, 120_000].filter((d) => d <= maxWindowMs);

    delays.forEach((dly, idx) => {
      setTimeout(() => {
        try {
          const { db } = openDb();
          const d = getDeliveryByUuid(db, key);
          if (!d?.instance_id) { _welcomeScheduleInFlight.delete(key); return; }

          const st = String(d.status || '').toUpperCase();
          if (st === 'DELIVERED' || st === 'DELIVERING') { _welcomeScheduleInFlight.delete(key); return; }

          const inst = getInstanceById(db, d.instance_id);
          if (!inst?.public_ip) { _welcomeScheduleInFlight.delete(key); return; }

          const rr = scheduleAutoreplyFullWelcomeOnInstance(inst, { uuid: key, delayMs: 15_000 });
          if (rr?.ok) {
            recordDeliveryEventBestEffort(db, d.delivery_id, 'WELCOME_SCHEDULED', { uuid: key, instance_id: inst.instance_id, attempt: idx + 1, via: 'retry', delay_ms: dly });
            _welcomeScheduleInFlight.delete(key);
            return;
          }

          recordDeliveryEventBestEffort(db, d.delivery_id, 'WELCOME_SCHEDULE_FAILED', { uuid: key, instance_id: inst.instance_id, attempt: idx + 1, via: 'retry', delay_ms: dly, code: rr?.code ?? null, detail: rr?.detail ?? null });

          if (idx === delays.length - 1) {
            recordDeliveryEventBestEffort(db, d.delivery_id, 'WELCOME_SCHEDULE_GIVEUP', { uuid: key, instance_id: inst.instance_id, attempts: delays.length });
            _welcomeScheduleInFlight.delete(key);
          }
        } catch {
          _welcomeScheduleInFlight.delete(key);
        }
      }, dly);
    });
  } catch {}
}

function getInstanceById(db, instance_id) {
  return db.prepare(
    `SELECT instance_id, provider, region, zone, public_ip, private_ip, bundle_id, blueprint_id,
            created_at, terminated_at, expired_at, lifecycle_status, health_status,
            last_probe_at, last_ok_at, assigned_user_id, assigned_order_id, assigned_at,
            meta_json
     FROM instances WHERE instance_id = ?`
  ).get(instance_id);
}

function sh(cmd, { timeoutMs = 12000 } = {}) {
  const res = spawnSync('bash', ['-lc', cmd], {
    encoding: 'utf8',
    // NOTE: QR PNG data URLs can exceed a few MB; keep buffer large to avoid silent truncation.
    maxBuffer: 25 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env }
  });
  return { code: res.status ?? 0, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function poolSsh(instance, remoteCmd, { timeoutMs = 20000, tty = false, retries = 2, profile = 'fast' } = {}) {
  const ip = instance.public_ip;
  if (!ip) return { code: 1, stdout: '', stderr: 'instance_missing_ip' };
  const tflag = tty ? '-tt' : '';

  // SSH profiles:
  // - fast: used for interactive QR polling / web handlers (fail fast)
  // - init: used for pool init/verify (more tolerant to boot jitter / slow banner exchange)
  const isInit = String(profile) === 'init';
  const connectTimeout = isInit ? 25 : 8;
  const connAttempts = isInit ? 2 : 1;
  const aliveInterval = isInit ? 5 : 2;
  const aliveMax = isInit ? 6 : 2;

  const cmd = `ssh ${tflag} -i '${POOL_SSH_KEY}' `
    + `-o BatchMode=yes -o StrictHostKeyChecking=no `
    + `-o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null `
    + `-o LogLevel=ERROR `
    + `-o ConnectTimeout=${connectTimeout} -o ConnectionAttempts=${connAttempts} `
    + `-o ServerAliveInterval=${aliveInterval} -o ServerAliveCountMax=${aliveMax} `
    + `ubuntu@${ip} '${String(remoteCmd).replace(/'/g, "'\\''")}'`;

  let last = null;
  for (let i = 0; i <= retries; i++) {
    const r = sh(cmd, { timeoutMs });
    last = r;
    // 255 is typically SSH transport failure; retry with small backoff.
    if ((r.code ?? 0) === 255 && i < retries) {
      try { require('child_process').spawnSync('bash', ['-lc', 'sleep 0.6'], { stdio: 'ignore' }); } catch {}
      continue;
    }
    return r;
  }
  return last || { code: 255, stdout: '', stderr: 'ssh_failed' };
}

const poolSshInit = (instance, remoteCmd, opts = {}) => poolSsh(instance, remoteCmd, { ...opts, profile: 'init' });
const poolSshFast = (instance, remoteCmd, opts = {}) => poolSsh(instance, remoteCmd, { ...opts, profile: 'fast' });

async function poolFetch(instance, path, opts = {}) {
  const ip = instance.public_ip;
  if (!ip) return { ok: false, status: 0, json: null, text: 'instance_missing_ip', url: null };

  // Default mode is SSH: keep pool provision server bound to 127.0.0.1 (no public exposure).
  if (POOL_FETCH_MODE === 'ssh') {
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    const body = opts.body ? String(opts.body) : '';
    const timeoutMs = opts.timeoutMs || 12000;

    const remoteUrl = `http://127.0.0.1:${POOL_LOCAL_PORT}${path}`;
    const headerFlags = Object.entries(headers)
      .map(([k, v]) => `-H '${String(k).replace(/'/g, "'\\''")}: ${String(v).replace(/'/g, "'\\''")}'`)
      .join(' ');

    // Use base64 to avoid shell/JSON quoting issues (prevents invalid JSON on the remote side).
    let curl;
    if (body) {
      const b64 = Buffer.from(body, 'utf8').toString('base64');
      curl = `echo '${b64}' | base64 -d | curl -sS -m ${Math.ceil(timeoutMs / 1000)} -X ${method} ${headerFlags} --data-binary @- '${remoteUrl}'`;
    } else {
      curl = `curl -sS -m ${Math.ceil(timeoutMs / 1000)} -X ${method} ${headerFlags} '${remoteUrl}'`;
    }

    const cmd = `ssh -i '${POOL_SSH_KEY}' -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=25 ubuntu@${ip} '${curl.replace(/'/g, "'\\''")}'`;
    const r = sh(cmd, { timeoutMs: timeoutMs + 3000 });
    const text = (r.stdout || r.stderr || '').trim();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    // SSH mode cannot reliably get HTTP status; treat JSON ok:false as failure.
    const ok = Boolean(json ? json.ok !== false : (r.code === 0));
    return { ok, status: ok ? 200 : 502, json, text, url: `ssh://${ip}${path}` };
  }

  // HTTP mode: requires pool provision server exposed on POOL_HTTP_PORT
  const url = `http://${ip}:${POOL_HTTP_PORT}${path}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs || 8000);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { ok: resp.ok, status: resp.status, json, text, url };
  } finally {
    clearTimeout(t);
  }
}

function baseUrlForShortlinks(){
  return process.env.BOTHOOK_SHORTLINK_BASE || 'https://s.bothook.me/s/';
}

function waJidToE164(waJid){
  try{
    const base = normalizeWaBase(waJid);
    if(!base) return null;
    const num = String(base).split('@')[0];
    if(!/^\d{6,20}$/.test(num)) return null;
    return '+' + num;
  }catch{ return null; }
}

function isKeyVerified(db, uuid){
  try{
    const row = db.prepare('SELECT meta_json FROM delivery_secrets WHERE provision_uuid=? AND kind=? LIMIT 1').get(uuid, 'openai_api_key');
    if(!row) return false;
    let meta={};
    try{ meta = row.meta_json ? JSON.parse(row.meta_json) : {}; }catch{ meta={}; }
    // Treat key as verified only when it is both syntactically valid AND chargeable (funded).
    return Boolean(meta.verified_at) && Boolean(meta.funded_at);
  }catch{ return false; }
}

function isPaid(db, uuid){
  // same logic as /api/delivery/status
  try{
    const d = getDeliveryByUuid(db, uuid);
    if(!d) return false;
    if(String(d.status||'') === 'PAID' || String(d.status||'') === 'DELIVERED') return true;
    const sub = db.prepare('SELECT status, ended_at, cancel_at, current_period_end FROM subscriptions WHERE user_id=? ORDER BY updated_at DESC LIMIT 1').get(uuid);
    if(!sub) return false;
    const st = String(sub.status || '').toLowerCase();
    const now = Date.now();
    const endedAt = sub.ended_at ? Date.parse(sub.ended_at) : null;
    const cancelAt = sub.cancel_at ? Date.parse(sub.cancel_at) : null;
    const cpe = sub.current_period_end ? Date.parse(sub.current_period_end) : null;
    const notEnded = !endedAt || endedAt > now;
    const inPeriod = (cancelAt && cancelAt > now) || (cpe && cpe > now);
    return (st === 'active' || st === 'trialing') && notEnded && inPeriod;
  }catch{ return false; }
}

function tryCutoverDelivered(db, uuid, { reason } = {}) {
  // Control-plane decides and triggers cutover on the user machine.
  // Preconditions: linked + paid + key verified.
  const d = getDeliveryByUuid(db, uuid);
  if(!d) return { ok:false, skip:'no_delivery' };

  if(String(d.status||'') === 'DELIVERED') {
    // Still ensure the user machine has the verified OpenAI key + model configured.
    const inst2 = getInstanceById(db, d.instance_id);
    if (inst2?.public_ip) {
      try { writeOpenAiAuthOnInstance(db, inst2, { uuid }); } catch {}
    }
    // Reconcile instance lifecycle for delivered users.
    try { db.prepare('UPDATE instances SET lifecycle_status=? WHERE instance_id=?').run('DELIVERED', d.instance_id); } catch {}
    return { ok:true, skip:'already_delivered' };
  }

  // Reconcile: if user machine already has DELIVERED.json, but DB status isn't DELIVERED, fix DB.
  try {
    const inst0 = getInstanceById(db, d.instance_id);
    if (inst0?.public_ip) {
      const rr = poolSsh(inst0, `set -euo pipefail; test -f /opt/bothook/DELIVERED.json && cat /opt/bothook/DELIVERED.json`, { timeoutMs: 12000, tty: false, retries: 0 });
      if ((rr.code ?? 1) === 0 && String(rr.stdout||'').includes('"delivery_status"')) {
        const ts = nowIso();
        const row = db.prepare('SELECT meta_json FROM deliveries WHERE provision_uuid=?').get(uuid);
        const meta2 = mergeMeta(row?.meta_json || null, { delivered_at: ts, cutover_reason: reason || 'reconcile_marker' });
        db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE provision_uuid=?').run('DELIVERED', ts, meta2, uuid);
        try { db.prepare('UPDATE instances SET lifecycle_status=? WHERE instance_id=?').run('DELIVERED', d.instance_id); } catch {}
        db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)').run(
          crypto.randomUUID(), ts, 'delivery', uuid, 'CUTOVER_DELIVERED_RECONCILED', JSON.stringify({ uuid, instance_id: d.instance_id, reason: reason || null })
        );
        // Continue below to ensure auth sync etc.
      }
    }
  } catch {}

  const linked = Boolean(d.wa_jid);
  const paid = isPaid(db, uuid);
  const verified = isKeyVerified(db, uuid);
  if(!linked || !paid || !verified) {
    return { ok:false, skip:'preconditions_not_met', linked, paid, verified };
  }

  const inst = getInstanceById(db, d.instance_id);
  if(!inst?.public_ip) return { ok:false, skip:'instance_missing_ip' };

  const controller = waJidToE164(d.wa_jid);
  const ts = nowIso();

  // 0) Sync verified OpenAI key onto the user machine's OpenClaw auth store (auth-profiles.json)
  // This is required for the model-driven assistant to work post-delivery.
  const authSync = writeOpenAiAuthOnInstance(db, inst, { uuid });
  if (!authSync.ok) {
    return { ok:false, delivered:false, skip:'auth_sync_failed', detail: authSync };
  }

  // 1) Trigger cutover script on the user machine (idempotent).
  const remote = `set -euo pipefail; sudo -n true; `
    + `BOTHOOK_UUID='${uuid}' BOTHOOK_CONTROLLER_E164='${controller || ''}' sudo -E /opt/bothook/bin/cutover_delivered.sh`;

  // Cutover can include a gateway restart + short probes; allow a longer window.
  const r = poolSsh(inst, remote, { timeoutMs: 120000, tty: false, retries: 1 });

  // Mark delivered if remote ran (best-effort). If remote fails, keep status for retry.
  if((r.code ?? 1) === 0) {
    const row = db.prepare('SELECT meta_json FROM deliveries WHERE provision_uuid=?').get(uuid);
    const meta2 = mergeMeta(row?.meta_json || null, { delivered_at: ts, cutover_reason: reason || null });
    db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE provision_uuid=?').run('DELIVERED', ts, meta2, uuid);
    try { db.prepare('UPDATE instances SET lifecycle_status=? WHERE instance_id=?').run('DELIVERED', d.instance_id); } catch {}
    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)').run(
      crypto.randomUUID(), ts, 'delivery', uuid, 'CUTOVER_DELIVERED', JSON.stringify({ uuid, instance_id: d.instance_id, reason: reason || null })
    );
    return { ok:true, delivered:true, controller, ssh_code:r.code };
  }

  return { ok:false, delivered:false, ssh_code:r.code, err: (r.stderr||r.stdout||'').slice(0,300) };
}


function randCode(n=7){
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out='';
  for (let i=0;i<n;i++){
    out += alphabet[Math.floor(Math.random()*alphabet.length)];
  }
  return out;
}

async function createStripeCheckout({ uuid, delivery_id }){
  const secret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
  const price = process.env.STRIPE_PRICE_ID || process.env.STRIPE_STANDARD_PRICE_ID || process.env.STRIPE_PRICE_ID_STANDARD || '';
  if (!secret || !price) throw Object.assign(new Error('stripe_not_configured'), { statusCode: 500 });

  const successBase = process.env.BOTHOOK_STRIPE_SUCCESS_URL || 'https://p.bothook.me/?paid=1';
  const cancelBase = process.env.BOTHOOK_STRIPE_CANCEL_URL || 'https://p.bothook.me/?canceled=1';

  const success_url = successBase + (successBase.includes('?') ? '&' : '?') + 'uuid=' + encodeURIComponent(uuid);
  const cancel_url = cancelBase + (cancelBase.includes('?') ? '&' : '?') + 'uuid=' + encodeURIComponent(uuid);

  const body = new URLSearchParams();
  body.set('mode','subscription');
  body.set('line_items[0][price]', price);
  body.set('line_items[0][quantity]', '1');
  body.set('success_url', success_url);
  body.set('cancel_url', cancel_url);

  // NOTE: Checkout Session metadata does NOT propagate to the Subscription.
  // We must write subscription_data.metadata so Stripe webhooks can map subId -> uuid.
  body.set('metadata[provision_uuid]', uuid);
  body.set('metadata[delivery_id]', delivery_id);
  body.set('subscription_data[metadata][provision_uuid]', uuid);
  body.set('subscription_data[metadata][delivery_id]', delivery_id);

  // Optional: helps ops search in Stripe dashboard/logs.
  body.set('client_reference_id', uuid);

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${secret}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!resp.ok) throw Object.assign(new Error('stripe_checkout_failed'), { statusCode: 502, detail: json || text });
  return { url: json.url, id: json.id };
}

function upsertShortlink(db, { code, long_url, created_at, expires_at, kind, delivery_id, provision_uuid, meta }){
  db.prepare(`INSERT OR REPLACE INTO shortlinks(code,long_url,created_at,expires_at,kind,delivery_id,provision_uuid,meta_json) VALUES (?,?,?,?,?,?,?,?)`)
    .run(code, long_url, created_at, expires_at, kind, delivery_id, provision_uuid, meta ? JSON.stringify(meta) : null);
}

function tryAcquireShortlinkLock(db, lockKey, ts){
  // Returns existing code if lock already exists, else creates lock row and returns null.
  const ex = db.prepare('SELECT code FROM shortlink_locks WHERE lock_key=?').get(lockKey);
  if (ex) return ex.code || '';
  db.prepare('INSERT OR IGNORE INTO shortlink_locks(lock_key, created_at, code) VALUES (?,?,?)').run(lockKey, ts, null);
  const ex2 = db.prepare('SELECT code FROM shortlink_locks WHERE lock_key=?').get(lockKey);
  return ex2.code || null;
}

function setShortlinkLockCode(db, lockKey, code){
  db.prepare('UPDATE shortlink_locks SET code=? WHERE lock_key=?').run(code, lockKey);
}



function isDebug(req) {
  return req.query?.debug === '1' || req.headers['x-bothook-debug'] === '1' || process.env.BOTHOOK_DEBUG === '1';
}

function send(res, status, obj) {
  res.status(status).type('application/json').send(JSON.stringify(obj));
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyStripeSignature({ rawBody, sigHeader, secret, toleranceSeconds = 300 }) {
  if (!rawBody || !sigHeader || !secret) return { ok: false, error: 'missing' };
  const parts = String(sigHeader).split(',').map(s => s.trim());
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Part = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) return { ok:false, error:'bad_header' };
  const t = tPart.slice(2);
  const v1 = v1Part.slice(3);
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts)) return { ok:false, error:'bad_timestamp' };
  const now = Math.floor(Date.now()/1000);
  if (Math.abs(now - ts) > toleranceSeconds) return { ok:false, error:'timestamp_out_of_tolerance' };
  const signed = `${t}.` + rawBody.toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const match = timingSafeEqual(expected, v1);
  return match ? { ok:true, ts } : { ok:false, error:'signature_mismatch' };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

// Web analytics tracking (first-party, minimal)
// Used for hourly funnel reports and future ads attribution.
app.post('/api/track', (req, res) => {
  try {
    const { db } = openDb();
    const ts = nowIso();

    const ev = String(req.body?.event_type || '').trim().toUpperCase();
    const allow = new Set([
      'WEB_VISIT','WEB_CTA_CLICK',
      'P_VISIT','P_RELINK_CLICK','P_QR_CLICK'
    ]);
    if (!allow.has(ev)) return send(res, 400, { ok:false, error:'event_type_not_allowed' });

    const uuid = req.body?.uuid ? String(req.body.uuid).trim() : '';
    const vid = req.body?.vid ? String(req.body.vid).trim() : '';
    const lang = req.body?.lang ? String(req.body.lang).trim().toLowerCase() : '';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();

    const payload = {
      event_type: ev,
      ts,
      host,
      uuid: uuid || null,
      vid: vid || null,
      lang: lang || null,
      path: req.body?.path ? String(req.body.path).slice(0,300) : null,
      referrer: req.body?.referrer ? String(req.body.referrer).slice(0,500) : null,
      utm: req.body?.utm && typeof req.body.utm === 'object' ? req.body.utm : null,
      click: req.body?.click && typeof req.body.click === 'object' ? req.body.click : null,
      tz: req.body?.tz ? String(req.body.tz).slice(0,80) : null,
      ua: req.body?.ua ? String(req.body.ua).slice(0,300) : null,
      dedupe_key: req.body?.dedupe_key ? String(req.body.dedupe_key).slice(0,200) : null
    };

    // Persist attribution snapshot:
    // - uuid-level (when uuid exists)
    // - vid-level (always when vid exists)
    // Also persist uuid<->vid binding when both present.
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS attributions (
        uuid TEXT PRIMARY KEY,
        first_ts TEXT,
        last_ts TEXT,
        payload_json TEXT
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS vid_attributions (
        vid TEXT PRIMARY KEY,
        first_ts TEXT,
        last_ts TEXT,
        payload_json TEXT
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS uuid_vid_map (
        uuid TEXT PRIMARY KEY,
        vid TEXT,
        first_ts TEXT,
        last_ts TEXT,
        payload_json TEXT
      )`);
    } catch {}

    if (vid) {
      try {
        const ex = db.prepare('SELECT first_ts FROM vid_attributions WHERE vid=? LIMIT 1').get(vid);
        const firstTs = ex?.first_ts || ts;
        db.prepare('INSERT OR REPLACE INTO vid_attributions(vid, first_ts, last_ts, payload_json) VALUES (?,?,?,?)')
          .run(vid, firstTs, ts, JSON.stringify(payload));
      } catch {}
    }

    if (uuid) {
      try {
        const existing = db.prepare('SELECT first_ts FROM attributions WHERE uuid=? LIMIT 1').get(uuid);
        const firstTs = existing?.first_ts || ts;
        db.prepare('INSERT OR REPLACE INTO attributions(uuid, first_ts, last_ts, payload_json) VALUES (?,?,?,?)')
          .run(uuid, firstTs, ts, JSON.stringify(payload));
      } catch {}

      if (vid) {
        try {
          const ex = db.prepare('SELECT first_ts FROM uuid_vid_map WHERE uuid=? LIMIT 1').get(uuid);
          const firstTs = ex?.first_ts || ts;
          db.prepare('INSERT OR REPLACE INTO uuid_vid_map(uuid, vid, first_ts, last_ts, payload_json) VALUES (?,?,?,?,?)')
            .run(uuid, vid, firstTs, ts, JSON.stringify(payload));
        } catch {}
      }
    }

    // Persistent dedupe (best-effort)
    // If dedupe_key present, ignore duplicates within 30 minutes.
    if (payload.dedupe_key) {
      db.exec(`CREATE TABLE IF NOT EXISTS track_dedupe (
        dedupe_key TEXT PRIMARY KEY,
        event_type TEXT,
        created_at TEXT
      )`);
      const cutoff = new Date(Date.now() - 30*60*1000).toISOString();
      try { db.prepare('DELETE FROM track_dedupe WHERE created_at < ?').run(cutoff); } catch {}
      const dk = `${ev}:${payload.dedupe_key}`;
      const ex = db.prepare('SELECT dedupe_key FROM track_dedupe WHERE dedupe_key=? LIMIT 1').get(dk);
      if (ex?.dedupe_key) return send(res, 200, { ok:true, deduped:true });
      db.prepare('INSERT OR IGNORE INTO track_dedupe(dedupe_key,event_type,created_at) VALUES (?,?,?)').run(dk, ev, ts);
    }

    const entity_type = uuid ? 'delivery' : 'web';
    const entity_id = uuid || vid || '';
    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), ts, entity_type, entity_id, ev, JSON.stringify(payload));

    return send(res, 200, { ok:true });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// Ops: pool init job runner (no autonomous tasks; explicit ops call only)
// IMPORTANT: pool init jobs must NOT block the API event loop.
// We persist jobs in SQLite and run the worker loop in a separate process (BOTHOOK_OPS_WORKER=1).

function sleepMs(ms){ return new Promise(r => setTimeout(r, ms)); }

function pushJobLog(job, msg){
  job.log.push({ ts: nowIso(), msg: String(msg) });
  if (job.log.length > 200) job.log = job.log.slice(-200);
  // Best-effort persist when job is DB-backed (worker mode).
  try {
    if (job?._db && job?.job_id) {
      job._db.prepare('UPDATE pool_init_jobs SET log_json=? WHERE job_id=?')
        .run(JSON.stringify(job.log), job.job_id);
    }
  } catch {}
}

async function tccli(cmd, { envFile='/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env' } = {}) {
  const full = `set -a; source ${envFile}; set +a; ${cmd}`;
  return sh(full, { timeoutMs: 20000 });
}

async function describeInstance(instance_id, { region } = {}){
  const rgn = String(region || process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore');
  const r = await tccli(`tccli lighthouse DescribeInstances --region ${rgn} --InstanceIds '["${instance_id}"]' --output json`);
  if ((r.code ?? 1) !== 0) throw new Error('describe_instances_failed');
  const j = JSON.parse(String(r.stdout||'{}'));
  const it = (j.InstanceSet||[])[0];
  if (!it) throw new Error('instance_not_found');
  return it;
}

async function waitPort22(ip, { timeoutMs=10*60*1000 } = {}){
  const start = Date.now();
  while (Date.now()-start < timeoutMs) {
    const rr = sh(`timeout 3 bash -lc "</dev/tcp/${ip}/22"`, { timeoutMs: 5000 });
    if ((rr.code ?? 1) === 0) return true;
    await sleepMs(5000);
  }
  return false;
}

async function waitSshEcho(instance, { timeoutMs=15*60*1000, phase='ssh', onProgress } = {}){
  // Harden: after reimage, SSH can be "half-up" for a while (port 22 open but handshake slow/reset).
  // Strategy:
  // - allow a longer total window
  // - per-attempt timeout + retries
  // - backoff
  // - return diagnostic context
  const start = Date.now();
  let attempt = 0;
  let lastDetail = '';
  let lastCode = null;
  while (Date.now()-start < timeoutMs) {
    attempt++;
    // Fail-fast attempts: keep each attempt short so the ops worker stays responsive.
    const r = poolSshInit(instance, 'echo ssh_ok', { timeoutMs: 15000, tty: false, retries: 0 });
    lastCode = (r.code ?? null);
    const detail = String((r.stdout || '') + (r.stderr || '')).trim();
    if (detail) lastDetail = detail.slice(-600);
    if ((r.code ?? 1) === 0 && String(r.stdout||'').includes('ssh_ok')) return { ok: true, attempt, lastDetail, lastCode, phase };

    // Progress heartbeat every attempt so jobs don't look "stuck".
    if (typeof onProgress === 'function') {
      try {
        const msg = `ssh not ready yet (attempt=${attempt}, lastCode=${lastCode ?? 'null'})`;
        onProgress(lastDetail ? (msg + `, last=${lastDetail.replace(/\s+/g,' ').slice(0,120)}`) : msg);
      } catch {}
    }

    // Backoff (max 20s) to avoid thrashing.
    const sleepMsX = Math.min(20000, 2500 + attempt * 1200);
    await sleepMs(sleepMsX);
  }
  return { ok: false, attempt, lastDetail, lastCode, phase };
}

async function resolvePoolKeyIdForRegion(targetRegion) {
  const region = String(targetRegion || process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore').trim();
  const cachePath = process.env.BOTHOOK_POOL_KEY_REGION_CACHE_PATH || '/tmp/bothook_pool_key_by_region.json';
  const pubPath = process.env.BOTHOOK_POOL_SSH_PUB_PATH || '/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519.pub';
  const pub = String(fs.readFileSync(pubPath, 'utf8') || '').trim();
  if (!pub) throw new Error('pool_key_public_key_missing');
  const fp8 = crypto.createHash('sha256').update(pub).digest('hex').slice(0, 8);
  const keyName = String(process.env.BOTHOOK_POOL_KEY_NAME || `bothook_pool_key_${fp8}`).trim();

  // Cache lookup (supports legacy { [region]: keyId } and new { byRegion: { [region]: { keyName, keyId }}})
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const legacy = j?.[region];
    if (typeof legacy === 'string' && legacy) return String(legacy);
    const hit = j?.byRegion?.[region];
    if (hit?.keyName === keyName && hit?.keyId) return String(hit.keyId);
  } catch {}

  // If key already exists in this region, reuse it.
  const list1 = await tccli(`tccli lighthouse DescribeKeyPairs --region ${region} --version 2020-03-24 --output json`);
  const dj1 = JSON.parse(String(list1.stdout||'{}'));
  const ks1 = dj1.KeyPairSet || [];
  const hit1 = ks1.find(k => String(k?.KeyName || '') === keyName);
  let keyId = hit1?.KeyId ? String(hit1.KeyId) : '';

  if (!keyId) {
    // Import (best-effort); if it fails due to exists/race, re-describe.
    try {
      const imp = await tccli(`tccli lighthouse ImportKeyPair --region ${region} --version 2020-03-24 --KeyName '${keyName}' --PublicKey '${pub.replace(/'/g, "'\\''")}' --output json`);
      const ij = JSON.parse(String(imp.stdout||'{}'));
      keyId = String(ij?.KeyId || ij?.KeyPairId || '').trim();
    } catch {}

    if (!keyId) {
      const list2 = await tccli(`tccli lighthouse DescribeKeyPairs --region ${region} --version 2020-03-24 --output json`);
      const dj2 = JSON.parse(String(list2.stdout||'{}'));
      const ks2 = dj2.KeyPairSet || [];
      const hit2 = ks2.find(k => String(k?.KeyName || '') === keyName);
      keyId = hit2?.KeyId ? String(hit2.KeyId) : '';
    }
  }

  if (!keyId) throw new Error('pool_key_import_failed');

  // Persist cache best-effort.
  try {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { j = {}; }
    j.ts = new Date().toISOString();
    j.byRegion = j.byRegion || {};
    j.byRegion[region] = { keyName, keyId };
    fs.writeFileSync(cachePath, JSON.stringify(j, null, 2));
  } catch {}

  return keyId;
}

async function associatePoolKey(instance_id, { region } = {}){
  const rgn = String(region || process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore');
  let keyId = await resolvePoolKeyIdForRegion(rgn);

  let r = await tccli(`tccli lighthouse AssociateInstancesKeyPairs --region ${rgn} --InstanceIds '["${instance_id}"]' --KeyIds '["${keyId}"]' --output json`);
  let out = String((r.stdout||'') + (r.stderr||''));

  // If key is missing in that region, re-resolve (imports) and retry once.
  if (out.includes('KeyIdNotFound') || out.includes('ResourceNotFound.KeyIdNotFound')) {
    keyId = await resolvePoolKeyIdForRegion(rgn);
    r = await tccli(`tccli lighthouse AssociateInstancesKeyPairs --region ${rgn} --InstanceIds '["${instance_id}"]' --KeyIds '["${keyId}"]' --output json`);
    out = String((r.stdout||'') + (r.stderr||''));
  }

  // Allow "duplicate" as success.
  if ((r.code ?? 0) === 0) return true;
  if (out.includes('KeyPairBindDuplicate')) return true;
  // Retryable: cloud is busy or instance still pending.
  if (out.includes('LatestOperationUnfinished')) return false;
  if (out.includes('InvalidInstanceState') && out.includes('PENDING')) return false;
  throw new Error('associate_key_failed');
}

async function issueReadyToken(db, instRow){
  const token = makeReadyReportToken();
  const expIso = new Date(Date.now() + 60*60*1000).toISOString();
  const meta = mergeMeta(instRow.meta_json, { ready_report_token: token, ready_report_exp: expIso });
  db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(meta, instRow.instance_id);
  writeReadyReportFilesOnInstance(instRow, { token, expIso });
}

async function resetInstance(instance_id, blueprint_id, { region } = {}){
  const rgn = String(region || process.env.BOTHOOK_CLOUD_REGION || 'ap-singapore');
  const r = await tccli(`tccli lighthouse ResetInstance --region ${rgn} --version 2020-03-24 --InstanceId '${instance_id}' --BlueprintId '${blueprint_id}' --output json`);
  const out = String((r.stdout||'') + (r.stderr||''));
  if ((r.code ?? 0) === 0) return { ok:true, out };
  if (out.includes('LatestOperationUnfinished')) return { ok:false, retryable:true, out };
  throw new Error('reset_instance_failed');
}

async function waitInstanceRunning(instance_id, { timeoutMs=15*60*1000, region }={}){
  const t0 = Date.now();
  while (Date.now()-t0 < timeoutMs) {
    // IMPORTANT: must use the instance's region; otherwise cross-region instances
    // will be reported as "instance_not_found".
    const it = await describeInstance(instance_id, { region });
    const st = String(it?.InstanceState || '').toUpperCase();
    const op = String(it?.LatestOperation || '');
    const opSt = String(it?.LatestOperationState || '');
    if (st === 'RUNNING' && (!op || opSt === 'SUCCESS' || opSt === '')) return true;
    await sleepMs(5000);
  }
  return false;
}

async function runPoolInitJob(job){
  const { db } = openDb();
  // If caller provided a db handle (worker mode), persist job updates there.
  job._db = job._db || db;

  const ts0 = nowIso();
  job.startedAt = ts0;
  job.status = 'RUNNING';
  try {
    job._db.prepare('UPDATE pool_init_jobs SET status=?, started_at=? WHERE job_id=?').run('RUNNING', ts0, job.job_id);
  } catch {}
  pushJobLog(job, `start (instance=${job.instance_id}, mode=${job.mode})`);

  // UX: track init phase in instance meta_json so ops can distinguish "waiting for new machine" vs real NEEDS_VERIFY.
  try {
    const instRow0 = getInstanceById(db, job.instance_id);
    if (instRow0) {
      const meta0 = mergeMeta(instRow0.meta_json, { init_state: 'INIT_RUNNING', init_state_updated_at: ts0 });
      db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(meta0, job.instance_id);
    }
  } catch {}

  try {
    const inst0 = getInstanceById(db, job.instance_id);
    if (!inst0) throw new Error('instance_not_found');
    if (inst0.instance_id === 'lhins-npsqfxvn') throw new Error('forbidden_master_host');
    // Ops init is allowed for pool instances, and for explicit recovery of paid-but-stuck deliveries.
    // Do NOT allow for master host (guarded above) and do not broaden to arbitrary statuses.
    const ls = String(inst0.lifecycle_status||'');
    if (!(ls === 'IN_POOL' || ls === 'DELIVERING')) throw new Error('not_in_pool');

    // Safety: never run init/reimage on an instance that is still referenced by any active delivery.
    // Otherwise, we can wipe a real user machine (or break onboarding mid-flight) and cause missing welcomes/replies.
    const activeDeliveries = (() => {
      try {
        return db.prepare(
          `SELECT delivery_id, provision_uuid, status, updated_at
             FROM deliveries
            WHERE instance_id=?
              AND status IN ('LINKING','BOUND_UNPAID','ACTIVE','PAID','DELIVERING','DELIVERED')
            ORDER BY datetime(updated_at) DESC
            LIMIT 5`
        ).all(inst0.instance_id) || [];
      } catch {
        return [];
      }
    })();

    if (activeDeliveries.length) {
      pushJobLog(job, `BLOCKED: instance has active deliveries (count=${activeDeliveries.length})`);
      pushJobLog(job, `BLOCKED deliveries: ${activeDeliveries.map(r => `${r.provision_uuid}:${r.status}`).join(', ')}`);
      try {
        db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
          crypto.randomUUID(), nowIso(), 'instance', inst0.instance_id, 'POOL_INIT_BLOCKED_ACTIVE_DELIVERY',
          JSON.stringify({ instance_id: inst0.instance_id, mode: job.mode, active: activeDeliveries })
        );
      } catch {}
      throw new Error('pool_init_blocked_active_delivery');
    }

    // Describe + write IP/KeyIds to DB
    const it = await describeInstance(job.instance_id, { region: inst0.region });
    const pub = (it.PublicAddresses||[])[0] || null;
    const priv = (it.PrivateAddresses||[])[0] || null;
    const keyIds = ((it.LoginSettings||{}).KeyIds||[]).map(String);
    pushJobLog(job, `describe: ip=${pub}, keyIds=${keyIds.join(',')||'[]'}`);
    let meta = {};
    try { meta = inst0.meta_json ? JSON.parse(inst0.meta_json) : {}; } catch { meta = {}; }
    meta.key_ids = keyIds;
    db.prepare('UPDATE instances SET public_ip=COALESCE(?,public_ip), private_ip=COALESCE(?,private_ip), meta_json=? WHERE instance_id=?')
      .run(pub, priv, JSON.stringify(meta), job.instance_id);

    // Reimage (cloud reset) when requested
    if (String(job.mode||'') === 'reimage_and_init') {
      pushJobLog(job, `reset instance (reimage): blueprint=${(it.BlueprintId||'')}`);
      // reset may be blocked by ongoing ops; retry a bit
      for (let i=0;i<10;i++){
        const rr = await resetInstance(job.instance_id, String(it.BlueprintId || ''), { region: inst0.region });
        if (rr.ok) break;
        if (rr.retryable) {
          await sleepMs(5000);
          continue;
        }
        if (i===9) throw new Error('reset_instance_timeout');
      }

      pushJobLog(job, 'wait instance RUNNING after reset');
      const running = await waitInstanceRunning(job.instance_id, { timeoutMs: 20*60*1000, region: inst0.region });
      if (!running) throw new Error('reset_not_running');
    }

    // Associate pool key (retry window)
    pushJobLog(job, 'associate keypair bothook_pool_key');
    for (let i=0;i<20;i++){
      const ok = await associatePoolKey(job.instance_id, { region: inst0.region });
      if (ok) break;
      await sleepMs(3000);
      if (i===19) throw new Error('associate_key_timeout');
    }

    // Refresh describe
    const it2 = await describeInstance(job.instance_id, { region: inst0.region });
    const pub2 = (it2.PublicAddresses||[])[0] || pub;
    pushJobLog(job, `describe2: ip=${pub2}`);
    db.prepare('UPDATE instances SET public_ip=COALESCE(?,public_ip) WHERE instance_id=?').run(pub2, job.instance_id);

    const inst = getInstanceById(db, job.instance_id);
    if (!inst.public_ip) throw new Error('missing_public_ip');

    // Wait SSH
    pushJobLog(job, 'wait port22');
    try {
      const curX = getInstanceById(db, job.instance_id);
      const meta = mergeMeta(curX?.meta_json, { init_state: 'WAIT_PORT22', init_state_updated_at: nowIso() });
      db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(meta, job.instance_id);
    } catch {}

    const portOk = await waitPort22(inst.public_ip, { timeoutMs: 10*60*1000 });
    if (!portOk) throw new Error('port22_timeout');

    pushJobLog(job, 'wait ssh echo');
    try {
      const curX = getInstanceById(db, job.instance_id);
      const meta = mergeMeta(curX?.meta_json, { init_state: 'WAIT_SSH', init_state_updated_at: nowIso() });
      db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(meta, job.instance_id);
    } catch {}

    const sshWait = await waitSshEcho(inst, { timeoutMs: 15*60*1000, phase: 'post-reimage', onProgress: (m) => pushJobLog(job, m) });
    if (!sshWait.ok) {
      // Preserve debug context for diagnosis.
      pushJobLog(job, `ssh wait failed (attempts=${sshWait.attempt})`);
      if (sshWait.lastDetail) pushJobLog(job, `ssh last: ${sshWait.lastDetail.replace(/\s+/g,' ').slice(0,200)}`);
      throw new Error('ssh_unreachable');
    }

    // Issue ready token (requires SSH to be actually usable).
    // Why here: issuing before SSH is ready causes READY_REPORT.txt to be missing, so postboot_verify cannot report READY.
    pushJobLog(job, 'issue ready_report_token');
    await issueReadyToken(db, inst);

    // Verify the token file exists on the instance (guard against write failures)
    try {
      const chk = poolSshInit(inst, 'test -s /opt/bothook/READY_REPORT.txt && echo ok || echo missing', { timeoutMs: 20000, tty:false, retries: 0 });
      if (!String(chk.stdout||'').includes('ok')) {
        throw new Error('ready_report_file_missing');
      }
    } catch {
      // re-issue once
      pushJobLog(job, 're-issue ready_report_token (file missing)');
      await issueReadyToken(db, inst);
    }

    // Mark as pool machine (enables watchdog + other pool-only behavior)
    // This file is used by systemd ConditionPathExists gates.
    try {
      pushJobLog(job, 'mark POOL_MACHINE');
      poolSshInit(inst, 'sudo mkdir -p /opt/bothook && sudo touch /opt/bothook/POOL_MACHINE && echo ok', { timeoutMs: 20000, tty:false, retries: 0 });
    } catch {}

    // Bootstrap
    // Bootstrap artifacts version.
    // HARD RULE: always use /artifacts/latest for pool (re)image/init to ensure the newest fixes (e.g. autoreply hard gate) are applied.
    const bootstrapVer = 'latest';
    pushJobLog(job, `run bootstrap ${bootstrapVer}`);
    const boot = poolSshInit(
      inst,
      // IMPORTANT: enforce pipefail so curl failures do not get masked by a successful `bash` exit.
      `sudo bash -lc "set -euo pipefail; export DEBIAN_FRONTEND=noninteractive; curl -fsSL --retry 5 --retry-delay 1 --retry-all-errors https://p.bothook.me/artifacts/${bootstrapVer}/bootstrap.sh | ARTIFACT_BASE_URL=https://p.bothook.me/artifacts/${bootstrapVer} bash"`,
      { timeoutMs: parseInt(process.env.BOTHOOK_POOL_INIT_BOOTSTRAP_TIMEOUT_MS || String(45*60*1000), 10), tty:false, retries:0 }
    );
    if ((boot.code ?? 1) !== 0) {
      try {
        const out = String((boot.stdout || '')).trim();
        const err = String((boot.stderr || '')).trim();
        if (out) pushJobLog(job, `bootstrap stdout: ${out.replace(/\s+/g,' ').slice(-600)}`);
        if (err) pushJobLog(job, `bootstrap stderr: ${err.replace(/\s+/g,' ').slice(-600)}`);
      } catch {}
      throw new Error('bootstrap_failed');
    }

    // Post-bootstrap strong validation (do not allow fake READY).
    // Ensure Node + OpenClaw + provision server are present. Provision may be inactive until started.
    try {
      const chk2 = poolSshInit(inst,
        `set -euo pipefail; `
        + `command -v node >/dev/null; `
        + `command -v openclaw >/dev/null; `
        + `test -s /opt/bothook/provision/server.mjs; `
        + `test -s /opt/bothook/bin/postboot_verify.sh; `
        + `echo ok`,
        { timeoutMs: 20000, tty:false, retries:0 }
      );
      if (!String(chk2.stdout||'').includes('ok')) {
        throw new Error('bootstrap_validate_failed');
      }
    } catch {
      throw new Error('bootstrap_validate_failed');
    }

    // Extra hardening: ensure memorySearch patch applied (some boxes may have cached older patch script).
    // Fetch and apply from p-site latest to avoid relying on /opt/bothook/scripts contents.
    try {
      pushJobLog(job, 'apply memorySearch patch (best-effort)');
      poolSsh(inst,
        `set -euo pipefail; `
        + `curl -fsSL https://p.bothook.me/artifacts/${bootstrapVer}/scripts/patch_openclaw_enable_memory_search_openai.sh | sudo bash >/dev/null 2>&1 || true; `
        + `sudo systemctl restart openclaw-gateway.service >/dev/null 2>&1 || true; `
        + `echo ok`,
        { timeoutMs: 60000, tty:false, retries: 0 }
      );

      const msDump = poolSshInit(inst,
        `python3 - <<'PY'\nimport json\np='/home/ubuntu/.openclaw/openclaw.json'\ntry:\n  j=json.load(open(p))\nexcept Exception as e:\n  print('ERR:'+str(e)); raise SystemExit(0)\nms=((j.get('agents') or {}).get('defaults') or {}).get('memorySearch')\nprint(json.dumps(ms,ensure_ascii=False))\nPY\n`,
        { timeoutMs: 15000, tty:false, retries: 0 }
      );
      const out = String(msDump.stdout||msDump.stderr||'').trim().slice(0, 400);
      pushJobLog(job, `memorySearch cfg: ${out || 'empty'}`);
    } catch {}

    // Wait reboot
    pushJobLog(job, 'wait reboot ssh');
    const sshBack = await waitSshEcho(inst, { timeoutMs: 15*60*1000 });
    if (!sshBack) throw new Error('ssh_not_back_after_reboot');

    // Refresh ready token after bootstrap.
    // Rationale:
    // - bootstrap writes /opt/bothook and can race with our earlier token write
    // - token TTL may be exceeded during long init
    // - postboot_verify only reports READY if /opt/bothook/READY_REPORT.txt exists
    try {
      pushJobLog(job, 'refresh ready_report_token (post-bootstrap)');
      const instX = getInstanceById(db, job.instance_id);
      await issueReadyToken(db, instX);
    } catch {}

    // Ensure READY_REPORT.txt exists right before running postboot verify.
    // This is required for the push-based READY report path inside postboot_verify.sh.
    try {
      const chk = poolSshInit(inst, 'test -s /opt/bothook/READY_REPORT.txt && echo ok || echo missing', { timeoutMs: 20000, tty:false, retries: 0 });
      if (!String(chk.stdout||'').includes('ok')) {
        pushJobLog(job, 're-issue ready_report_token (pre-postboot; file missing)');
        const instX = getInstanceById(db, job.instance_id);
        await issueReadyToken(db, instX);
      }
    } catch {}

    // Ensure postboot verify has run (kick once)
    pushJobLog(job, 'kick postboot verify');
    poolSshInit(inst, 'sudo systemctl start bothook-postboot-verify.service || true', { timeoutMs: 20000, tty:false, retries:0 });

    // Wait DB READY (from push)
    // Kick postboot verify periodically to self-heal transient failures (e.g. gateway port not yet listening).
    // Also: pull /opt/bothook/evidence/postboot_verify.json as a fallback, because missing READY_REPORT.txt prevents push.
    pushJobLog(job, 'wait DB READY');
    const startWait = Date.now();
    let lastKick = Date.now();
    let lastPull = 0;
    while (Date.now()-startWait < 10*60*1000) {
      const cur = getInstanceById(db, job.instance_id);
      if (String(cur.health_status||'') === 'READY') {
        // HARD gate (A): before declaring the instance truly READY-for-allocation, re-check SSH stability + key local services.
        // Rationale: some instances accept port 22 but randomly stall during SSH banner exchange. Those must NOT enter the pool.
        const postCheck = (() => {
          const out = { ok: true, ssh: [], provisionHealthz: null, onboardingReady: null, gatewayProbe: null };
          try {
            for (let i = 0; i < 3; i++) {
              const r = poolSsh(inst, 'echo ok', { timeoutMs: 6000, tty: false, retries: 0, profile: 'fast' });
              out.ssh.push({ i: i + 1, code: r.code ?? null, stdout: String(r.stdout || '').trim().slice(0, 40), stderr: String(r.stderr || '').trim().slice(0, 120) });
              if ((r.code ?? 1) !== 0 || !String(r.stdout || '').includes('ok')) out.ok = false;
            }
          } catch (e) {
            out.ok = false;
            out.ssh.push({ i: 'exception', error: String(e?.message || e) });
          }

          try {
            const r = poolSsh(inst, 'curl -fsS -m 2 http://127.0.0.1:18999/healthz >/dev/null && echo ok || echo bad', { timeoutMs: 8000, tty: false, retries: 0, profile: 'fast' });
            out.provisionHealthz = { code: r.code ?? null, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim().slice(0, 120) };
            if (!String(r.stdout || '').includes('ok')) out.ok = false;
          } catch (e) {
            out.ok = false;
            out.provisionHealthz = { error: String(e?.message || e) };
          }

          try {
            const r = poolSsh(inst, 'test -s /opt/bothook/state/ONBOARDING_READY && echo ok || echo missing', { timeoutMs: 8000, tty: false, retries: 0, profile: 'fast' });
            out.onboardingReady = { code: r.code ?? null, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim().slice(0, 120) };
            if (!String(r.stdout || '').includes('ok')) out.ok = false;
          } catch (e) {
            out.ok = false;
            out.onboardingReady = { error: String(e?.message || e) };
          }

          // Gateway probe is observational only (startup can be slow). Do NOT fail the init job based on this.
          try {
            const r = poolSsh(inst, 'openclaw gateway probe --json 2>/dev/null || openclaw gateway probe', { timeoutMs: 15000, tty: false, retries: 0, profile: 'fast' });
            const txt = String(r.stdout || r.stderr || '').trim();
            out.gatewayProbe = { code: r.code ?? null, out: txt.slice(0, 400) };
          } catch (e) {
            out.gatewayProbe = { error: String(e?.message || e) };
          }

          return out;
        })();

        if (!postCheck.ok) {
          const tsFail = nowIso();
          try {
            db.prepare(
              'UPDATE instances SET health_status=?, last_probe_at=?, health_reason=?, health_source=?, last_verify_evidence=? WHERE instance_id=?'
            ).run('NEEDS_VERIFY', tsFail, 'ready_post_checks_failed', 'init_postcheck', JSON.stringify(postCheck).slice(0, 2000), job.instance_id);
          } catch {}
          pushJobLog(job, `postcheck FAILED: ${JSON.stringify(postCheck).slice(0, 400)}`);
          throw new Error('ready_post_checks_failed');
        }

        const ts = nowIso();
        job.status='DONE';
        job.endedAt=ts;
        try {
          const cur2 = getInstanceById(db, job.instance_id);
          const meta2 = mergeMeta(cur2?.meta_json, { init_state: 'INIT_DONE', init_state_updated_at: ts });
          db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(meta2, job.instance_id);
        } catch {}
        // Refresh last_verify_evidence even when already READY (otherwise evidence can lag behind config changes).
        // Also: pull /opt/bothook/SPECS.json into instances.meta_json so /api/p/state can show cpu/memory.
        try {
          const r = poolSsh(inst, 'sudo cat /opt/bothook/evidence/postboot_verify.json 2>/dev/null || echo missing', { timeoutMs: 12000, tty:false, retries:0 });
          const txt = String(r.stdout||'').trim();
          if (txt && txt !== 'missing') {
            db.prepare('UPDATE instances SET last_verify_evidence=? WHERE instance_id=?').run(txt.slice(0, 2000), job.instance_id);
          }
        } catch {}

        try {
          const sr = poolSsh(inst, 'sudo cat /opt/bothook/SPECS.json 2>/dev/null || echo missing', { timeoutMs: 8000, tty:false, retries:0 });
          const stxt = String(sr.stdout||'').trim();
          if (stxt && stxt !== 'missing') {
            const specs = JSON.parse(stxt);
            const curX = getInstanceById(db, job.instance_id);
            const meta = mergeMeta(curX?.meta_json, {
              cpu: specs?.cpu ?? null,
              memory: specs?.ram_gb ?? null,
              disk_gb: specs?.disk_gb ?? null,
              openclaw_version: specs?.openclaw_version ?? null,
              specs_captured_at: specs?.captured_at ?? null,
            });
            db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(meta, job.instance_id);
          }
        } catch {}

        try { job._db.prepare('UPDATE pool_init_jobs SET status=?, ended_at=? WHERE job_id=?').run('DONE', ts, job.job_id); } catch {}
        pushJobLog(job, 'done: READY');
        return;
      }

      // Fallback: pull the local postboot evidence and mark READY ourselves (we already have SSH trust).
      // Rate-limit pulls to keep init cheap.
      if (Date.now() - lastPull > 60*1000) {
        lastPull = Date.now();
        try {
          const r = poolSsh(inst, 'sudo cat /opt/bothook/evidence/postboot_verify.json 2>/dev/null || echo missing', { timeoutMs: 12000, tty:false, retries:0 });
          const txt = String(r.stdout||'').trim();
          if (txt && txt !== 'missing') {
            const j = JSON.parse(txt);
            if (j && j.ok === true) {
              const ts = nowIso();
              db.prepare(
                'UPDATE instances SET health_status=?, last_ok_at=?, health_reason=?, health_source=?, last_verify_evidence=? WHERE instance_id=?'
              ).run('READY', ts, 'postboot_ok', 'init_pull', txt.slice(0, 2000), job.instance_id);
              job.status='DONE';
              job.endedAt=ts;
              try {
                const cur2 = getInstanceById(db, job.instance_id);
                const meta2 = mergeMeta(cur2?.meta_json, { init_state: 'INIT_DONE', init_state_updated_at: ts });
                db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(meta2, job.instance_id);
              } catch {}
              try { job._db.prepare('UPDATE pool_init_jobs SET status=?, ended_at=? WHERE job_id=?').run('DONE', ts, job.job_id); } catch {}
              pushJobLog(job, 'done: READY (pulled postboot_verify.json)');
              return;
            }
          }
        } catch {}
      }

      if (Date.now() - lastKick > 60*1000) {
        pushJobLog(job, 're-kick postboot verify');
        poolSsh(inst, 'sudo systemctl start bothook-postboot-verify.service || true', { timeoutMs: 12000, tty:false, retries:0 });
        lastKick = Date.now();
      }
      await sleepMs(5000);
    }
    // One last kick before failing
    try { poolSsh(inst, 'sudo systemctl start bothook-postboot-verify.service || true', { timeoutMs: 12000, tty:false, retries:0 }); } catch {}
    throw new Error('db_ready_timeout');

  } catch (e) {
    job.status = 'ERROR';
    job.endedAt = nowIso();
    try { job._db.prepare('UPDATE pool_init_jobs SET status=?, ended_at=? WHERE job_id=?').run('ERROR', job.endedAt, job.job_id); } catch {}
    pushJobLog(job, `error: ${e?.message || 'unknown'}`);

    // Persist init phase for better ops visibility.
    try {
      const cur2 = getInstanceById(db, job.instance_id);
      const meta2 = mergeMeta(cur2?.meta_json, { init_state: 'INIT_ERROR', init_error: String(e?.message || 'unknown'), init_state_updated_at: job.endedAt });
      db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(meta2, job.instance_id);
    } catch {}
    try {
      const { db } = openDb();
      // Do not mark DELIVERED instances as NEEDS_VERIFY from pool init failures.
      // Pool init worker is only authoritative for IN_POOL/DELIVERING readiness.
      const cur = getInstanceById(db, job.instance_id);
      const ls = String(cur?.lifecycle_status || '');
      if (ls === 'IN_POOL' || ls === 'DELIVERING') {
        db.prepare(
          'UPDATE instances SET health_status=?, health_reason=?, health_source=? WHERE instance_id=?'
        ).run('NEEDS_VERIFY', String(e?.message || 'unknown'), 'init_worker', job.instance_id);
      } else {
        try {
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), nowIso(), 'instance', job.instance_id, 'POOL_INIT_SKIPPED_NON_POOL_INSTANCE',
            JSON.stringify({ instance_id: job.instance_id, lifecycle_status: ls, error: String(e?.message || 'unknown') })
          );
        } catch {}
      }
    } catch {}
  }
}

function spawnOpsWorkerBestEffort(){
  // Fire-and-forget: run worker loop in a separate process so API remains responsive.
  try {
    const env = { ...process.env, BOTHOOK_OPS_WORKER: '1' };
    const p = spawn('/usr/bin/node', [new URL(import.meta.url).pathname], { env, stdio: 'ignore', detached: true });
    p.unref();
  } catch {}
}

function enqueueOutboundTask(db, { delivery_id, uuid, instance_id, kind, lang, to_jid }){
  try {
    const task_id = crypto.randomUUID();
    const ts = nowIso();
    // Dedupe: unique active index on (delivery_id, kind) prevents duplicates.
    const r = db.prepare(
      `INSERT OR IGNORE INTO outbound_tasks(task_id, delivery_id, provision_uuid, instance_id, kind, lang, to_jid, status, attempt, next_run_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(task_id, delivery_id, uuid, instance_id, kind, lang || null, to_jid || null, 'QUEUED', 0, ts, ts, ts);

    // Only emit ENQUEUED event if a new row was actually inserted.
    if (r && r.changes > 0) {
      try {
        db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
          crypto.randomUUID(), ts, 'delivery', delivery_id || uuid, 'OUTBOUND_TASK_ENQUEUED',
          JSON.stringify({ uuid, delivery_id, instance_id, kind, lang })
        );
      } catch {}
    }

    return { ok:true, task_id, inserted: Boolean(r && r.changes > 0) };
  } catch (e) {
    return { ok:false, error: e?.message || 'enqueue_failed' };
  }
}

function parseJsonFromFirstBrace(s){
  const t = String(s || '');
  const i = t.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(t.slice(i)); } catch { return null; }
}

function outboundBackoffMs(attempt){
  const n = Number(attempt || 0);
  if (n <= 0) return 30_000;
  if (n === 1) return 60_000;
  if (n === 2) return 120_000;
  if (n === 3) return 300_000;
  return 600_000;
}

function outboundReadinessProbe(inst){
  // Readiness gating for outbound welcome/guide.
  // Goal: avoid wasting attempts when the user machine isn't ready to send/receive.
  // Checks (best-effort, cheap):
  // 1) gateway probe ok
  // 2) whatsapp channel running+connected
  // 3) autoreply plugin loaded (from postboot evidence if present; fallback to plugin list text)
  try {
    // (1) gateway probe
    const pr = poolSsh(inst, 'openclaw gateway probe --json 2>/dev/null || true', { timeoutMs: 12000, tty:false, retries:1 });
    const pj = parseJsonFromFirstBrace(pr.stdout || pr.stderr || '');
    if (!pj || pj.ok !== true) {
      return {
        ok: false,
        reason: 'gateway_probe_failed',
        detail: {
          ssh_code: pr.code ?? null,
          stdout: String(pr.stdout || '').slice(0, 600),
          stderr: String(pr.stderr || '').slice(0, 600),
          parsed: pj || null,
        }
      };
    }

    // (2) whatsapp channel status
    const cr = poolSsh(inst, 'openclaw channels status --probe --json 2>/dev/null || true', { timeoutMs: 15000, tty:false, retries:1 });
    const cj = parseJsonFromFirstBrace(cr.stdout || cr.stderr || '');
    const wa = cj?.channels?.whatsapp || null;
    // Some versions may omit connected/running fields; be conservative.
    if (!wa) return { ok:false, reason:'wa_status_missing' };

    // Some WhatsApp stacks can report running/connected=false transiently (e.g. session conflict auto-restart).
    // If the account is still linked, allow outbound attempts (worker retries will handle transient send errors),
    // and optionally let higher layers trigger a gateway restart.
    if (wa.linked === true) {
      // If linked but not currently connected, proceed with a warning.
      if (wa.running === false || wa.connected === false) {
        return { ok:true, warn:'linked_but_not_connected' };
      }
    } else {
      if (wa.running === false) return { ok:false, reason:'wa_not_running' };
      if (wa.connected === false) return { ok:false, reason:'wa_not_connected' };
    }

    // (3) autoreply loaded
    // Prefer the cheap marker written by the plugin itself.
    let autoreplyOk = null;
    try {
      const mr = poolSsh(inst, 'test -f /opt/bothook/evidence/autoreply_loaded && echo ok || echo missing', { timeoutMs: 3000, tty:false, retries:0 });
      const mt = String(mr.stdout || '').trim();
      if (mt === 'ok') autoreplyOk = true;
    } catch {}

    if (autoreplyOk === null) {
      try {
        const lr = poolSsh(inst, 'openclaw plugins list 2>/dev/null || true', { timeoutMs: 6000, tty:false, retries:0 });
        const lt = String(lr.stdout || lr.stderr || '');
        // Heuristic: presence of the plugin name suggests it is installed/recognized.
        autoreplyOk = /bothook-wa-autoreply/i.test(lt);
      } catch {}
    }

    // Autoreply is a UX gate, not a transport gate: welcome/guide can still be sent even if the marker is missing.
    if (autoreplyOk === false) return { ok:true, warn:'autoreply_not_loaded' };

    return { ok:true };
  } catch {
    return { ok:false, reason:'readiness_probe_failed' };
  }
}

async function runOutboundWorkerLoop(){
  const lockPath = '/tmp/bothook_outbound_worker.lock';
  let fd = null;
  try {
    fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lockPath, String(process.pid));
  } catch {
    return;
  }

  try {
    const { db } = openDb();
    const now = nowIso();
    while (true) {
      const row = db.prepare(
        "SELECT * FROM outbound_tasks WHERE status='QUEUED' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY datetime(created_at) ASC LIMIT 1"
      ).get(now);
      if (!row) break;

      const ts0 = nowIso();
      const task_id = row.task_id;
      const attempt = Number(row.attempt || 0) + 1;
      try {
        db.prepare('UPDATE outbound_tasks SET status=?, attempt=?, updated_at=? WHERE task_id=?')
          .run('RUNNING', attempt, ts0, task_id);
      } catch {}

      const delivery_id = String(row.delivery_id || '');
      const uuid = String(row.provision_uuid || '');
      const instance_id = String(row.instance_id || '');
      const kind = String(row.kind || '');
      const lang = String(row.lang || '') || null;
      const to_jid = String(row.to_jid || '') || null;

      const inst = getInstanceById(db, instance_id);
      if (!inst?.public_ip) {
        try { db.prepare('UPDATE outbound_tasks SET status=?, last_error_code=?, last_error_detail=?, updated_at=? WHERE task_id=?')
          .run('ERROR', 'missing_instance', 'instance_not_found_or_missing_ip', nowIso(), task_id); } catch {}
        continue;
      }

      // Readiness gating before send
      const ready = outboundReadinessProbe(inst);
      if (!ready.ok) {
        const tsN = nowIso();
        const next = new Date(Date.now() + outboundBackoffMs(attempt)).toISOString();
        try {
          const detail = ready?.detail ? JSON.stringify(ready.detail).slice(0, 1800) : '';
          db.prepare('UPDATE outbound_tasks SET status=?, next_run_at=?, last_error_code=?, last_error_detail=?, updated_at=? WHERE task_id=?')
            .run('QUEUED', next, ready.reason || 'not_ready', detail, tsN, task_id);
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), tsN, 'delivery', delivery_id || uuid, 'OUTBOUND_TASK_DELAYED',
            JSON.stringify({ uuid, delivery_id, instance_id, kind, reason: ready.reason || 'not_ready', attempt, next_run_at: next, detail: ready?.detail || null })
          );
        } catch {}
        continue;
      }

      // welcome_short is deprecated: instance-side plugin sends the short linked ack.
      // Keep tasks idempotent by marking DONE without sending to avoid duplicate messages.
      if (kind === 'welcome_short') {
        const tsD = nowIso();
        try {
          db.prepare('UPDATE outbound_tasks SET status=?, updated_at=?, done_at=? WHERE task_id=?')
            .run('DONE', tsD, tsD, task_id);
        } catch {}
        continue;
      }

      // Render message
      let msg = '';
      try {
        const prompts = loadWaPrompts(lang || 'en') || loadWaPrompts('en') || {};
        const pLink = `https://p.bothook.me/p/${encodeURIComponent(uuid)}?lang=${encodeURIComponent(lang || 'en')}`;

        if (kind === 'welcome_unpaid') {
          const tpl = String(prompts.welcome_unpaid || '').trim();
          if (!tpl) throw new Error('welcome_unpaid_missing');

          // Fill full i18n template variables (specs captured on user machine).
          let specs = {};
          try {
            const sr = poolSsh(inst, 'cat /opt/bothook/SPECS.json 2>/dev/null || echo {}', { timeoutMs: 5000, tty:false, retries:0 });
            specs = JSON.parse(String(sr.stdout || '{}')) || {};
          } catch {}

          let openclaw_version = '';
          try {
            const vr = poolSsh(inst, 'openclaw --version 2>/dev/null | head -n 1 || true', { timeoutMs: 4000, tty:false, retries:0 });
            openclaw_version = String(vr.stdout || '').trim();
          } catch {}

          msg = renderTpl(tpl, {
            uuid,
            p_link: pLink,
            pay_countdown_minutes: 15,
            pay_short_link: '',
            region: String(inst.region || ''),
            public_ip: String(inst.public_ip || ''),
            cpu: String(specs.cpu ?? ''),
            ram_gb: String(specs.ram_gb ?? ''),
            disk_gb: String(specs.disk_gb ?? ''),
            openclaw_version: openclaw_version || String(specs.openclaw_version || '')
          });
        } else if (kind === 'guide_key_paid') {
          const tpl = String(prompts.guide_key_paid || '').trim();
          if (!tpl) throw new Error('guide_key_paid_missing');
          msg = renderTpl(tpl, { uuid, p_link: pLink });
        } else if (kind === 'key_verified_success') {
          let tpl = String(prompts.key_verified_success || '').trim();
          if (!tpl) {
            tpl = '[bothook] OpenAI Key verified ✅\n\nWe’re finishing delivery cutover (takes ~1–2 minutes and includes a service restart).\n\nPlease wait 1 minute, then send: "hi"';
          }
          msg = renderTpl(tpl, { uuid, p_link: pLink });
        } else if (kind === 'relink_success') {
          let tpl = String(prompts.relink_success || '').trim();
          if (!tpl) {
            // Fallback to English prompt if the locale file doesn't have this new key yet.
            const p2 = loadWaPrompts('en') || {};
            tpl = String(p2.relink_success || '').trim();
          }
          if (!tpl) {
            tpl = '[bothook] Relink successful ✅\n\nYour device is connected again. You can now chat normally here.';
          }
          msg = renderTpl(tpl, { uuid, p_link: pLink });
        } else {
          throw new Error('unknown_kind');
        }
      } catch (e) {
        try {
          db.prepare('UPDATE outbound_tasks SET status=?, last_error_code=?, last_error_detail=?, updated_at=? WHERE task_id=?')
            .run('ERROR', 'render_failed', String(e?.message || 'render_failed').slice(0,120), nowIso(), task_id);
        } catch {}
        continue;
      }

      // Attempt send (best-effort enable plugin)
      try { poolSsh(inst, `openclaw plugins enable bothook-wa-autoreply 2>/dev/null || true`, { timeoutMs: 8000, tty:false, retries:0 }); } catch {}

      let rr = { code: 1, stdout: '', stderr: 'send_not_run' };
      try { rr = sendSelfChatOnInstance(inst, msg, { toJid: to_jid }); } catch {}
      const ok = (rr.code ?? 1) === 0;
      const ts1 = nowIso();

      try {
        const detail = (String(rr.stderr || rr.stdout || '')).replace(/\s+/g,' ').slice(0,300);
        const eventType = (() => {
          if (ok) {
            if (kind === 'welcome_short') return 'WELCOME_SHORT_SENT';
            if (kind === 'welcome_unpaid') return 'WELCOME_UNPAID_SENT';
            if (kind === 'guide_key_paid') return 'GUIDE_KEY_SENT';
            if (kind === 'key_verified_success') return 'KEY_VERIFIED_SUCCESS_SENT';
            if (kind === 'relink_success') return 'RELINK_SUCCESS_SENT';
            return 'OUTBOUND_SENT';
          }
          if (kind === 'welcome_short') return 'WELCOME_SHORT_SEND_FAILED';
          if (kind === 'welcome_unpaid') return 'WELCOME_UNPAID_SEND_FAILED';
          if (kind === 'guide_key_paid') return 'GUIDE_KEY_SEND_FAILED';
          if (kind === 'key_verified_success') return 'KEY_VERIFIED_SUCCESS_SEND_FAILED';
          if (kind === 'relink_success') return 'RELINK_SUCCESS_SEND_FAILED';
          return 'OUTBOUND_SEND_FAILED';
        })();

        db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
          crypto.randomUUID(), ts1, 'delivery', delivery_id || uuid,
          eventType,
          JSON.stringify({ uuid, delivery_id, instance_id, exit_code: rr.code ?? null, detail, attempt, kind })
        );
      } catch {}

      if (ok) {
        try { db.prepare('UPDATE outbound_tasks SET status=?, done_at=?, updated_at=? WHERE task_id=?').run('DONE', ts1, ts1, task_id); } catch {}
        // Persist delivery meta (idempotent)
        try {
          const d2 = db.prepare('SELECT meta_json FROM deliveries WHERE delivery_id=?').get(delivery_id);
          const patch = (() => {
            if (kind === 'welcome_short') return { welcome_short_sent_at: ts1, welcome_short_lang: lang, welcome_short_send_ok: true };
            if (kind === 'welcome_unpaid') return { welcome_unpaid_sent_at: ts1, welcome_unpaid_lang: lang, welcome_unpaid_send_ok: true };
            if (kind === 'guide_key_paid') return { guide_key_sent_at: ts1, guide_key_lang: lang, guide_key_send_ok: true };
            if (kind === 'key_verified_success') return { key_verified_success_sent_at: ts1, key_verified_success_lang: lang, key_verified_success_send_ok: true };
            if (kind === 'relink_success') return { relink_success_sent_at: ts1, relink_success_lang: lang, relink_success_send_ok: true };
            return { outbound_sent_at: ts1 };
          })();
          const meta2 = mergeMeta(d2?.meta_json || null, patch);
          db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta2, ts1, delivery_id);
        } catch {}

        // After the user receives a critical success message, trigger cutover.
        if (kind === 'key_verified_success') {
          try { tryCutoverDelivered(db, uuid, { reason: 'key_verified_success_sent' }); } catch {}
        }
        if (kind === 'relink_success') {
          try { tryCutoverDelivered(db, uuid, { reason: 'relink_success_sent' }); } catch {}
        }
      } else {
        const next = new Date(Date.now() + outboundBackoffMs(attempt)).toISOString();
        const detail = (String(rr.stderr || rr.stdout || '')).replace(/\s+/g,' ').slice(0,300);
        try {
          db.prepare('UPDATE outbound_tasks SET status=?, next_run_at=?, last_error_code=?, last_error_detail=?, updated_at=? WHERE task_id=?')
            .run('QUEUED', next, 'send_failed', detail, ts1, task_id);
        } catch {}
        // Persist delivery meta attempt
        try {
          const d2 = db.prepare('SELECT meta_json FROM deliveries WHERE delivery_id=?').get(delivery_id);
          const patch = (() => {
            if (kind === 'welcome_short') return { welcome_short_last_attempt_at: ts1, welcome_short_lang: lang, welcome_short_send_ok: false };
            if (kind === 'welcome_unpaid') return { welcome_unpaid_last_attempt_at: ts1, welcome_unpaid_lang: lang, welcome_unpaid_send_ok: false };
            if (kind === 'guide_key_paid') return { guide_key_last_attempt_at: ts1, guide_key_lang: lang, guide_key_send_ok: false };
            if (kind === 'key_verified_success') return { key_verified_success_last_attempt_at: ts1, key_verified_success_lang: lang, key_verified_success_send_ok: false };
            if (kind === 'relink_success') return { relink_success_last_attempt_at: ts1, relink_success_lang: lang, relink_success_send_ok: false };
            return { outbound_last_attempt_at: ts1 };
          })();
          const meta2 = mergeMeta(d2?.meta_json || null, patch);
          db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta2, ts1, delivery_id);
        } catch {}
      }
    }
  } finally {
    try { if (fd) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

app.post('/api/ops/pool/init', (req, res) => {
  try {
    const instance_id = String(req.body?.instance_id || '').trim();
    const mode = String(req.body?.mode || 'init_only').trim();
    if (!instance_id) return send(res, 400, { ok:false, error:'instance_id_required' });
    if (!['init_only','reimage_and_init'].includes(mode)) return send(res, 400, { ok:false, error:'bad_mode' });

    const { db } = openDb();

    // Safety: never enqueue init/reimage on an instance that is referenced by any active delivery.
    // This prevents accidental wipes of real user machines.
    try {
      const active = db.prepare(
        `SELECT delivery_id, provision_uuid, status, updated_at
           FROM deliveries
          WHERE instance_id=?
            AND status IN ('LINKING','BOUND_UNPAID','ACTIVE','PAID','DELIVERING','DELIVERED')
          ORDER BY datetime(updated_at) DESC
          LIMIT 5`
      ).all(instance_id) || [];
      if (active.length) {
        return send(res, 409, { ok:false, error:'active_delivery_conflict', instance_id, active });
      }
    } catch {}

    // Dedupe / idempotency: at most ONE init job in-flight per instance.
    // Rationale: cross-region boot/SSH/npm can be slow; repeated enqueues create queue storms and can destabilize the box.
    const inflight = db.prepare(
      "SELECT job_id, status, created_at, mode FROM pool_init_jobs WHERE instance_id=? AND status IN ('QUEUED','RUNNING') ORDER BY created_at DESC LIMIT 1"
    ).get(instance_id);
    if (inflight?.job_id) {
      return send(res, 200, {
        ok: true,
        deduped: true,
        job_id: inflight.job_id,
        status: inflight.status,
        queued: inflight.status === 'QUEUED',
        running: inflight.status === 'RUNNING',
        inflight_mode: inflight.mode,
        inflight_created_at: inflight.created_at
      });
    }

    const job_id = crypto.randomUUID();
    db.prepare('INSERT INTO pool_init_jobs(job_id, instance_id, mode, status, created_at, log_json) VALUES (?,?,?,?,?,?)')
      .run(job_id, instance_id, mode, 'QUEUED', nowIso(), '[]');

    spawnOpsWorkerBestEffort();
    return send(res, 200, { ok:true, job_id, status:'QUEUED', queued:true });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

app.get('/api/ops/pool/init/status', (req, res) => {
  const job_id = String(req.query?.job_id || '').trim();
  if (!job_id) return send(res, 400, { ok:false, error:'job_id_required' });
  try {
    const { db } = openDb();
    const row = db.prepare('SELECT * FROM pool_init_jobs WHERE job_id=? LIMIT 1').get(job_id);
    if (!row) return send(res, 404, { ok:false, error:'job_not_found' });
    const log = (()=>{ try { return JSON.parse(row.log_json || '[]'); } catch { return []; } })();
    return send(res, 200, { ok:true, job: { job_id: row.job_id, instance_id: row.instance_id, mode: row.mode, status: row.status, startedAt: row.started_at || null, endedAt: row.ended_at || null, createdAt: row.created_at || null, log } });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// Used by pool_replenish to suppress cloud creates during maintenance/init bursts.
app.get('/api/ops/pool/init/busy', (req, res) => {
  try {
    const { db } = openDb();
    const active = db.prepare("SELECT COUNT(*) as c FROM pool_init_jobs WHERE status IN ('QUEUED','RUNNING')").get()?.c ?? 0;
    return send(res, 200, { ok:true, busy: active > 0, active });
  } catch {
    return send(res, 200, { ok:true, busy: false, active: 0 });
  }
});

// ===== Smoketest (test mode only) =====
function requireTestMode(res){
  if (String(process.env.BOTHOOK_TEST_MODE || '') !== '1') {
    send(res, 403, { ok:false, error:'test_mode_disabled' });
    return false;
  }
  return true;
}

function recordOutbox(db, { uuid, kind, channel=null, target=null, text }){
  const ts = nowIso();
  const textHash = crypto.createHash('sha256').update(String(text||''),'utf8').digest('hex');
  db.prepare('INSERT INTO outbox_messages(outbox_id, ts, uuid, kind, channel, target, text, text_hash) VALUES (?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), ts, uuid, kind, channel, target, String(text||''), textHash);
  return { ts, textHash };
}

app.post('/api/test/wa/link', (req, res) => {
  try {
    if (!requireTestMode(res)) return;
    const uuid = String(req.body?.uuid || '').trim();
    const wa_e164 = String(req.body?.wa_e164 || '+10000000000').trim();
    const wa_jid = String(req.body?.wa_jid || 'test@wa').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const d = db.prepare('SELECT * FROM deliveries WHERE provision_uuid=? LIMIT 1').get(uuid);
    if (!d) return send(res, 404, { ok:false, error:'unknown_uuid' });

    const ts = nowIso();
    db.prepare('UPDATE deliveries SET wa_e164=?, wa_jid=?, bound_at=?, updated_at=? WHERE delivery_id=?')
      .run(wa_e164, wa_jid, ts, ts, d.delivery_id);

    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), ts, 'delivery', d.delivery_id, 'WA_LINKED', JSON.stringify({ uuid, wa_e164, wa_jid }));

    const welcome = `[bothook] Linked ✅\n\nNext step:\n1) Open: https://p.bothook.me/p/${uuid}?lang=en\n2) Follow the setup steps (payment + OpenAI key) shown on the page.`;
    const out = recordOutbox(db, { uuid, kind:'welcome_linked', channel:'whatsapp', target: wa_e164, text: welcome });

    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, event:'WA_LINKED', outbox: out });
  } catch (e) {
    return send(res, 500, { ok:false, error: e?.message || 'server_error' });
  }
});

app.post('/api/test/pay/confirm', (req, res) => {
  try {
    if (!requireTestMode(res)) return;
    const uuid = String(req.body?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const d = db.prepare('SELECT * FROM deliveries WHERE provision_uuid=? LIMIT 1').get(uuid);
    if (!d) return send(res, 404, { ok:false, error:'unknown_uuid' });

    const ts = nowIso();
    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), ts, 'delivery', d.delivery_id, 'PAYMENT_CONFIRMED', JSON.stringify({ uuid }));

    const guide = `[bothook] Payment received ✅\n\nNext step: paste your OpenAI API key on the setup page to finish delivery.`;
    const out = recordOutbox(db, { uuid, kind:'guide_paid', channel:'whatsapp', target: d.wa_e164 || null, text: guide });

    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, event:'PAYMENT_CONFIRMED', outbox: out });
  } catch (e) {
    return send(res, 500, { ok:false, error: e?.message || 'server_error' });
  }
});

app.post('/api/test/openai/key_verified', (req, res) => {
  try {
    if (!requireTestMode(res)) return;
    const uuid = String(req.body?.uuid || '').trim();
    const ok = Boolean(req.body?.ok ?? true);
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const d = db.prepare('SELECT * FROM deliveries WHERE provision_uuid=? LIMIT 1').get(uuid);
    if (!d) return send(res, 404, { ok:false, error:'unknown_uuid' });

    const ts = nowIso();
    const ev = ok ? 'OPENAI_KEY_VERIFIED' : 'OPENAI_KEY_INVALID';
    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), ts, 'delivery', d.delivery_id, ev, JSON.stringify({ uuid }));

    if (ok) {
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), ts, 'delivery', d.delivery_id, 'CUTOVER_DELIVERED', JSON.stringify({ uuid, mode:'test' }));
      const success = `[bothook] OpenAI key verified ✅\n\nDelivery complete. You can now chat with your server.`;
      const out = recordOutbox(db, { uuid, kind:'key_verified_success', channel:'whatsapp', target: d.wa_e164 || null, text: success });
      return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, events:[ev,'CUTOVER_DELIVERED'], outbox: out });
    }

    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, events:[ev] });
  } catch (e) {
    return send(res, 500, { ok:false, error: e?.message || 'server_error' });
  }
});

app.get('/api/test/outbox', (req, res) => {
  try {
    if (!requireTestMode(res)) return;
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const rows = db.prepare('SELECT ts, kind, channel, target, text_hash, substr(text,1,200) as text_preview FROM outbox_messages WHERE uuid=? ORDER BY ts ASC LIMIT 50').all(uuid);
    return send(res, 200, { ok:true, uuid, items: rows || [] });
  } catch (e) {
    return send(res, 500, { ok:false, error: e?.message || 'server_error' });
  }
});

// Ops: clear OpenClaw auth on a pool instance (used to ensure smoke-test keys never linger on pool machines).
// NOTE: This does not touch control-plane delivery_secrets; caller should delete secrets separately if desired.
app.post('/api/ops/pool/apply-memorysearch', (req, res) => {
  try {
    if (String(process.env.BOTHOOK_DEBUG_OPS || '') !== '1') {
      return send(res, 403, { ok:false, error:'debug_ops_disabled' });
    }
    const instance_id = String(req.body?.instance_id || '').trim();
    if (!instance_id) return send(res, 400, { ok:false, error:'instance_id_required' });
    if (instance_id === 'lhins-npsqfxvn') return send(res, 403, { ok:false, error:'forbidden_master_host' });

    const { db } = openDb();
    const inst = getInstanceById(db, instance_id);
    if (!inst?.public_ip) return send(res, 404, { ok:false, error:'instance_not_found_or_missing_ip' });

    const remote = `set -euo pipefail; `
      + `echo '[memorySearch] pre-check:'; `
      + `ls -l /opt/bothook/scripts/patch_openclaw_enable_memory_search_openai.sh 2>&1 || true; `
      + `ls -l /home/ubuntu/.openclaw/openclaw.json 2>&1 || true; `
      + `echo '[memorySearch] apply patch (fetch latest from p-site):'; `
      + `curl -fsSL https://p.bothook.me/artifacts/latest/scripts/patch_openclaw_enable_memory_search_openai.sh | sudo bash 2>&1 || true; `
      + `echo '[memorySearch] restart gateway:'; `
      + `sudo systemctl restart openclaw-gateway.service 2>&1 || true; `
      + `echo '[memorySearch] postboot verify:'; `
      + `sudo bash /opt/bothook/bin/postboot_verify.sh 2>&1 || true; `
      + `echo '[memorySearch] dump config:'; `
      + `python3 - <<'PY'\n`
      + `import json\n`
      + `p='/home/ubuntu/.openclaw/openclaw.json'\n`
      + `j=json.load(open(p))\n`
      + `ms=((j.get('agents') or {}).get('defaults') or {}).get('memorySearch')\n`
      + `print(json.dumps(ms,ensure_ascii=False))\n`
      + `PY\n`;

    const rr = poolSsh(inst, remote, { timeoutMs: 120000, tty:false, retries: 0 });
    const out = ((rr.stdout || '') + (rr.stderr || '')).trim();
    return send(res, 200, { ok:true, instance_id, ip: inst.public_ip, code: rr.code, out: out.slice(0, 4000) });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

app.post('/api/ops/pool/cat-memorysearch', (req, res) => {
  try {
    if (String(process.env.BOTHOOK_DEBUG_OPS || '') !== '1') {
      return send(res, 403, { ok:false, error:'debug_ops_disabled' });
    }
    const instance_id = String(req.body?.instance_id || '').trim();
    if (!instance_id) return send(res, 400, { ok:false, error:'instance_id_required' });
    if (instance_id === 'lhins-npsqfxvn') return send(res, 403, { ok:false, error:'forbidden_master_host' });

    const { db } = openDb();
    const inst = getInstanceById(db, instance_id);
    if (!inst?.public_ip) return send(res, 404, { ok:false, error:'instance_not_found_or_missing_ip' });

    const remote = "python3 - <<'PY'\n"+
      "import json\n"+
      "p='/home/ubuntu/.openclaw/openclaw.json'\n"+
      "try:\n  j=json.load(open(p))\nexcept Exception as e:\n  print('ERR:'+str(e))\n  raise SystemExit(0)\n"+
      "ms=((j.get('agents') or {}).get('defaults') or {}).get('memorySearch')\n"+
      "print(json.dumps(ms,ensure_ascii=False))\n"+
      "PY\n";

    const rr = poolSsh(inst, remote, { timeoutMs: 15000, tty:false, retries: 1 });
    const out = ((rr.stdout || '') + (rr.stderr || '')).trim();
    return send(res, 200, { ok:true, instance_id, ip: inst.public_ip, code: rr.code, out: out.slice(0, 2000) });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

app.post('/api/ops/instance/get-specs', (req, res) => {
  try {
    const instance_id = String(req.body?.instance_id || '').trim();
    const confirm = String(req.body?.confirm || '').trim();
    if (!instance_id) return send(res, 400, { ok:false, error:'instance_id_required' });
    if (instance_id === 'lhins-npsqfxvn') return send(res, 403, { ok:false, error:'forbidden_master_host' });
    if (confirm !== 'GET_SPECS') return send(res, 400, { ok:false, error:'confirm_required', hint:"set confirm='GET_SPECS'" });

    const { db } = openDb();
    const inst = getInstanceById(db, instance_id);
    if (!inst?.public_ip) return send(res, 404, { ok:false, error:'instance_not_found_or_missing_ip' });

    const rr = poolSsh(inst, 'sudo cat /opt/bothook/SPECS.json 2>/dev/null || echo missing', { timeoutMs: 15000, tty:false, retries: 1 });
    const txt = String(rr.stdout||'').trim();

    const vr = poolSsh(inst, 'sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw --version 2>/dev/null | head -n 1 || echo missing', { timeoutMs: 12000, tty:false, retries: 1 });
    const ver = String(vr.stdout||'').trim();

    return send(res, 200, { ok:true, instance_id, ip: inst.public_ip, code: rr.code, specs: txt.slice(0, 4000), openclaw_version: ver && ver!='missing' ? ver : null });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

app.post('/api/ops/instance/apply-memorysearch', (req, res) => {
  try {
    const instance_id = String(req.body?.instance_id || '').trim();
    const confirm = String(req.body?.confirm || '').trim();
    if (!instance_id) return send(res, 400, { ok:false, error:'instance_id_required' });
    if (instance_id === 'lhins-npsqfxvn') return send(res, 403, { ok:false, error:'forbidden_master_host' });
    if (confirm !== 'APPLY_MEMORYSEARCH') return send(res, 400, { ok:false, error:'confirm_required', hint:"set confirm='APPLY_MEMORYSEARCH'" });

    const { db } = openDb();
    const inst = getInstanceById(db, instance_id);
    if (!inst?.public_ip) return send(res, 404, { ok:false, error:'instance_not_found_or_missing_ip' });

    // Safety: patch only OpenClaw config; do not touch channels/models/gateway.
    const remote = `set -euo pipefail; `
      + `mkdir -p /home/ubuntu/.openclaw/memory; `
      + `chmod 700 /home/ubuntu/.openclaw/memory || true; `
      + `curl -fsSL https://p.bothook.me/artifacts/latest/scripts/patch_openclaw_enable_memory_search_openai.sh | sudo bash >/dev/null 2>&1; `
      + `sudo systemctl restart openclaw-gateway.service >/dev/null 2>&1 || true; `
      + `python3 - <<'PY'\n`
      + `import json\n`
      + `p='/home/ubuntu/.openclaw/openclaw.json'\n`
      + `j=json.load(open(p))\n`
      + `ms=((j.get('agents') or {}).get('defaults') or {}).get('memorySearch')\n`
      + `print(json.dumps(ms,ensure_ascii=False))\n`
      + `PY\n`;

    const rr = poolSsh(inst, remote, { timeoutMs: 120000, tty:false, retries: 1 });
    const out = ((rr.stdout || '') + (rr.stderr || '')).trim();
    return send(res, 200, { ok:true, instance_id, ip: inst.public_ip, code: rr.code, memorySearch: out.slice(0, 2000) });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

app.post('/api/ops/pool/clear-auth', (req, res) => {
  try {
    const instance_id = String(req.body?.instance_id || '').trim();
    if (!instance_id) return send(res, 400, { ok:false, error:'instance_id_required' });
    if (instance_id === 'lhins-npsqfxvn') return send(res, 403, { ok:false, error:'forbidden_master_host' });

    const { db } = openDb();
    const inst = getInstanceById(db, instance_id);
    if (!inst?.public_ip) return send(res, 404, { ok:false, error:'instance_not_found_or_missing_ip' });

    const ts = nowIso();
    // Clear auth store (this is where writeOpenAiAuthOnInstance writes).
    const remote = `set -euo pipefail; `
      + `AGENT_DIR=/home/ubuntu/.openclaw/agents/main/agent; `
      + `sudo rm -f "$AGENT_DIR/auth-profiles.json"; `
      + `sudo rm -f /opt/bothook/DELIVERED.json 2>/dev/null || true; `
      + `echo cleared`;

    const r = poolSsh(inst, remote, { timeoutMs: 15000, tty: false, retries: 0 });
    const ok = (r.code ?? 1) === 0;

    try {
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), ts, 'instance', instance_id, 'POOL_AUTH_CLEARED', JSON.stringify({ instance_id, ok, ssh_code: r.code ?? null }));
    } catch {}

    return send(res, 200, { ok:true, instance_id, cleared: ok, ssh_code: r.code ?? null });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// Ops: sanitize WhatsApp provisioning state on a pool instance so the next user can generate a fresh QR.
// Policy: no reimage. We stop provision service (if present), clear PROVISION_DATA_DIR contents, clear auth-profiles/DELIVERED markers,
// restart provision service, and probe /healthz. Any failure leaves the instance in NEEDS_VERIFY for further repair.
function smokeForbiddenHits(text){
  const s = String(text || '');
  const hits = [];
  const patterns = [
    /No API key found for provider/i,
    /auth-profiles\.json/i,
    /openclaw\s+(channels|gateway|plugins|models)\b/i,
    /\[gateway\]/i,
    /stack trace|stacktrace/i,
  ];
  for (const p of patterns) {
    try { if (p.test(s)) hits.push(String(p)); } catch {}
  }
  return hits;
}

function recordSmokeMessage(db, { uuid, delivery_id, instance_id, kind, lang, text, sendResult }){
  try {
    const ts = nowIso();
    const msg = String(text || '');
    const hits = smokeForbiddenHits(msg);
    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json)
                VALUES (?,?,?,?,?,?)`).run(
      crypto.randomUUID(), ts, 'delivery', delivery_id || uuid, 'SMOKE_MESSAGE_RECORDED',
      JSON.stringify({ uuid, delivery_id, instance_id, kind, lang, sha256: sha256Hex(msg), forbidden_hits: hits, send_code: sendResult?.code ?? null, send_detail: String(sendResult?.stderr || sendResult?.stdout || '').slice(0,300), text: msg })
    );
    return { ok: hits.length === 0, forbidden_hits: hits };
  } catch {
    return { ok: false, forbidden_hits: ['record_failed'] };
  }
}

app.post('/api/ops/pool/wa-sanitize', (req, res) => {
  try {
    const instance_id = String(req.body?.instance_id || '').trim();
    if (!instance_id) return send(res, 400, { ok:false, error:'instance_id_required' });
    if (instance_id === 'lhins-npsqfxvn') return send(res, 403, { ok:false, error:'forbidden_master_host' });

    const { db } = openDb();
    const inst = getInstanceById(db, instance_id);
    if (!inst?.public_ip) return send(res, 404, { ok:false, error:'instance_not_found_or_missing_ip' });

    const ts = nowIso();
    const steps = [];

    const remote = `set -euo pipefail; 
`+
`DATA_DIR='/opt/bothook/provision/data';
`+
`HAS_UNIT=0;
`+
`if systemctl list-unit-files 2>/dev/null | grep -q '^bothook-provision\\.service'; then HAS_UNIT=1; fi
`+
`# If systemd unit exists, prefer its configured PROVISION_DATA_DIR
`+
`if [ "$HAS_UNIT" = "1" ]; then
`+
`  ENV_LINE=$(systemctl show bothook-provision.service -p Environment 2>/dev/null | sed 's/^Environment=//');
`+
`  if echo "$ENV_LINE" | tr ' ' '\n' | grep -q '^PROVISION_DATA_DIR='; then
`+
`    DATA_DIR=$(echo "$ENV_LINE" | tr ' ' '\n' | sed -n 's/^PROVISION_DATA_DIR=//p' | tail -n1);
`+
`  fi
`+
`fi
`+
`echo "step:detected_data_dir:$DATA_DIR";
`+
`echo "step:has_provision_unit:$HAS_UNIT";
`+
`# Stop provision if present
`+
`if [ "$HAS_UNIT" = "1" ]; then
`+
`  sudo systemctl stop bothook-provision.service || true;
`+
`  echo 'step:stopped_provision:ok';
`+
`else
`+
`  echo 'step:stopped_provision:skip';
`+
`fi
`+
`# Clear WA/provision session data
`+
`sudo mkdir -p "$DATA_DIR";
`+
`sudo rm -rf "$DATA_DIR"/*;
`+
`echo 'step:cleared_provision_data:ok';
`+
`# Clear OpenClaw WhatsApp state (best-effort)
`+
`openclaw channels logout --channel whatsapp 2>/dev/null || true;
`+
`sudo rm -rf /home/ubuntu/.openclaw/channels/whatsapp 2>/dev/null || true;
`+
`sudo rm -rf /home/ubuntu/.openclaw/credentials/whatsapp 2>/dev/null || true;
`+
`echo 'step:cleared_openclaw_wa:ok';
`+
`# Clear OpenClaw auth + delivered markers
`+
`AGENT_DIR=/home/ubuntu/.openclaw/agents/main/agent;
`+
`sudo rm -f "$AGENT_DIR/auth-profiles.json" || true;
`+
`sudo rm -f /opt/bothook/DELIVERED.json 2>/dev/null || true;
`+
`sudo rm -f /opt/bothook/LOGIN_AUTHORITY.control-plane 2>/dev/null || true;
`+
`echo 'step:cleared_auth:ok';
`+
`# Ensure onboarding autoreply is enabled (critical for welcome/guide UX)
`+
`openclaw plugins enable bothook-wa-autoreply 2>/dev/null || true;
`+
`sudo systemctl restart openclaw-gateway.service 2>/dev/null || true;
`+
`echo 'step:enabled_autoreply:ok';
`+
`# Start provision if present
`+
`if [ "$HAS_UNIT" = "1" ]; then
`+
`  sudo systemctl start bothook-provision.service || true;
`+
`  echo 'step:started_provision:ok';
`+
`else
`+
`  echo 'step:started_provision:skip';
`+
`fi
`+
`# Probe health.
`+
`code=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18999/healthz 2>/dev/null || true);
`+
`echo "step:probe_healthz:$code";
`+
`# Strong validation: if provision unit exists, require healthz=200 (wait a short window).
`+
`if [ "$HAS_UNIT" = "1" ]; then
`+
`  ok=0;
`+
`  for i in 1 2 3 4 5 6 7 8 9 10; do
`+
`    code=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18999/healthz 2>/dev/null || true);
`+
`    if [ "$code" = "200" ]; then ok=1; break; fi
`+
`    sleep 1;
`+
`  done
`+
`  echo "step:healthz_required_ok:$ok";
`+
`  if [ "$ok" != "1" ]; then
`+
`    echo 'step:healthz_required_failed';
`+
`    exit 12;
`+
`  fi
`+
`fi
`+
`echo done`;

    // Use init SSH profile here: some pool instances accept TCP but are slow to present SSH banner; fast profile times out.
    const r = poolSsh(inst, remote, { timeoutMs: 45000, tty: false, retries: 1, profile: 'init' });
    const stdout = String(r.stdout || '');
    const ok = (r.code ?? 1) === 0;

    // Parse step markers (best-effort)
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith('step:')) steps.push(line.trim());
    }

    try {
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(
          crypto.randomUUID(), ts, 'instance', instance_id,
          ok ? 'POOL_WA_SANITIZED' : 'POOL_WA_SANITIZE_FAILED',
          JSON.stringify({ instance_id, ok, ssh_code: r.code ?? null, steps: steps.slice(0, 50) })
        );
    } catch {}

    if (!ok) {
      try {
        db.prepare('UPDATE instances SET health_status=?, health_reason=?, health_source=? WHERE instance_id=?')
          .run('NEEDS_VERIFY', 'wa_sanitize_failed', 'ops', instance_id);
      } catch {}
    }

    return send(res, 200, { ok:true, instance_id, sanitized: ok, ssh_code: r.code ?? null, steps });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});


// Pool READY report (push): called by pool instances after they finish bootstrap + verification.
// Auth: short-lived instance-scoped token stored in instances.meta_json.ready_report_token.
// Safety: control-plane runs a quick reverse-probe before marking READY.
app.post('/api/pool/ready', (req, res) => {
  try {
    const instance_id = String(req.body?.instance_id || '').trim();
    const token = String(req.body?.token || '').trim();
    // Do not trust reporter-provided IPs (often private IP from hostname -I). We'll refresh from cloud DescribeInstances.
    const public_ip = null;
    const private_ip = null;
    const checks = req.body?.checks || null;
    if (!instance_id || !token) return send(res, 400, { ok:false, error:'instance_id_and_token_required' });

    if (instance_id === 'lhins-npsqfxvn') return send(res, 403, { ok:false, error:'forbidden_master_host' });

    const { db } = openDb();
    const inst = getInstanceById(db, instance_id);
    if (!inst) return send(res, 404, { ok:false, error:'instance_not_found' });

    let meta = {};
    try { meta = inst.meta_json ? JSON.parse(inst.meta_json) : {}; } catch { meta = {}; }

    const exp = meta.ready_report_exp || null;
    if (!tokenNotExpired(exp)) {
      return send(res, 403, { ok:false, error:'token_expired_or_missing' });
    }

    if (String(meta.ready_report_token || '') !== token) {
      return send(res, 403, { ok:false, error:'token_mismatch' });
    }

    const ts = nowIso();

    // Refresh instance IPs from cloud (authoritative)
    try {
      const r = sh(`set -a; source /home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env; set +a; tccli lighthouse DescribeInstances --region ap-singapore --InstanceIds '["${instance_id}"]' --output json`, { timeoutMs: 20000 });
      if ((r.code ?? 1) === 0) {
        const j = JSON.parse(String(r.stdout||'{}'));
        const it = (j.InstanceSet||[])[0] || {};
        const pub = (it.PublicAddresses||[])[0] || null;
        const priv = (it.PrivateAddresses||[])[0] || null;
        if (pub) {
          db.prepare('UPDATE instances SET public_ip=COALESCE(?,public_ip), private_ip=COALESCE(?,private_ip) WHERE instance_id=?').run(pub, priv, instance_id);
        }
      }
    } catch {}

    // Reverse-probe (fast). If it fails, do NOT mark READY.
    try {
      const instForProbe = getInstanceById(db, instance_id);
      const probe = poolSsh(instForProbe, '/opt/bothook/healthcheck.sh', { timeoutMs: 15000, tty: false, retries: 0 });
      const text = String((probe.stdout || '') + (probe.stderr || '')).toLowerCase();
      const okGate = (probe.code === 0) && text.includes('healthcheck completed');
      if (!okGate) {
        db.prepare(
          'UPDATE instances SET health_status=?, last_probe_at=?, health_reason=?, health_source=?, last_verify_evidence=? WHERE instance_id=?'
        ).run('NEEDS_VERIFY', ts, 'reverse_probe_failed', 'ready_push', null, instance_id);
        return send(res, 200, { ok:false, error:'reverse_probe_failed', instance_id });
      }
    } catch {
      db.prepare(
        'UPDATE instances SET health_status=?, last_probe_at=?, health_reason=?, health_source=?, last_verify_evidence=? WHERE instance_id=?'
      ).run('NEEDS_VERIFY', ts, 'reverse_probe_error', 'ready_push', null, instance_id);
      return send(res, 200, { ok:false, error:'reverse_probe_error', instance_id });
    }

    // Read instance versions (authoritative) and enforce versioned READY gate.
    let instArtifactsVer = null;
    let instOpenclawVer = null;
    try {
      const instForProbe = getInstanceById(db, instance_id);
      const rr = poolSsh(instForProbe, "set -euo pipefail; v1=$(jq -r '.version' /opt/bothook/artifacts/manifest.json 2>/dev/null || true); v2=$(openclaw --version 2>/dev/null || true); echo \"$v1|$v2\"", { timeoutMs: 12000, tty: false, retries: 0 });
      const t = String(rr?.stdout || '').trim();
      if (t.includes('|')) {
        instArtifactsVer = t.split('|')[0].trim() || null;
        instOpenclawVer = t.split('|')[1].trim() || null;
      }
    } catch {}

    const requiredArtifacts = getRequiredArtifactsVersion();
    const okArtifacts = !requiredArtifacts || (String(instArtifactsVer || '') === String(requiredArtifacts));
    const okOpenclaw = !MIN_OPENCLAW_VERSION || (cmpVersion(instOpenclawVer, MIN_OPENCLAW_VERSION) >= 0);
    if (!okArtifacts || !okOpenclaw) {
      db.prepare(
        'UPDATE instances SET health_status=?, last_probe_at=?, health_reason=?, health_source=?, last_verify_evidence=? WHERE instance_id=?'
      ).run('NEEDS_VERIFY', ts, 'version_gate_failed', 'ready_push', JSON.stringify({ requiredArtifacts, instArtifactsVer, MIN_OPENCLAW_VERSION, instOpenclawVer }), instance_id);
      return send(res, 200, { ok:false, error:'version_gate_failed', instance_id, requiredArtifacts, instArtifactsVer, minOpenclaw: MIN_OPENCLAW_VERSION, instOpenclawVer });
    }

    // Update instance status
    const patch = {
      provision_ready: true,
      provision_artifacts_version: instArtifactsVer,
      provision_openclaw_version: instOpenclawVer,
      ready_reported_at: ts,
      ready_report_checks: checks || null,
      ready_report_public_ip: public_ip,
      ready_report_private_ip: private_ip,
    };

    db.prepare(
      'UPDATE instances SET health_status=?, last_probe_at=?, last_ok_at=?, health_reason=?, health_source=?, last_verify_evidence=?, public_ip=COALESCE(?, public_ip), private_ip=COALESCE(?, private_ip), meta_json=? WHERE instance_id=?'
    ).run('READY', ts, ts, 'postboot_ok', 'ready_push', JSON.stringify({ checks: checks || null }), public_ip, private_ip, mergeMeta(inst.meta_json, patch), instance_id);

    // One-shot: invalidate token after success to prevent replay.
    try {
      const inst2 = getInstanceById(db, instance_id);
      let meta2 = {};
      try { meta2 = inst2.meta_json ? JSON.parse(inst2.meta_json) : {}; } catch { meta2 = {}; }
      meta2.ready_report_token = null;
      meta2.ready_report_exp = null;
      db.prepare('UPDATE instances SET meta_json=? WHERE instance_id=?').run(JSON.stringify(meta2), instance_id);
    } catch {}

    return send(res, 200, { ok:true, instance_id, health_status:'READY', ts });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// C (Relink v2 / p-site state): minimal state endpoint (Phase 1)
// Returns a coarse state derived from local DB only (Stripe integration later).
app.get('/api/p/state', (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    const lang = String(req.query?.lang || '').trim() || null;
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();

    // Busy signal (A-mode strict): ONLY use DB-cached health_status here.
    // Do NOT run live SSH probes inside /api/p/state (would block the Node event loop and slow down the site).
    // A background worker / explicit ops probe should refresh READY/DIRTY.
    const ready = db.prepare("SELECT COUNT(*) as c FROM instances WHERE lifecycle_status='IN_POOL' AND health_status='READY'").get()?.c ?? 0;
    const busy = ready <= 0;

    const delivery = getDeliveryByUuid(db, uuid);
    const status = delivery?.status || 'NEW';

    // Coarse state machine (Phase 1.5, DB-only)
    // - NEW: no delivery mapping
    // - LINKING: user not yet linked
    // - PAID_ACTIVE: paid subscription active (relink/cancel shown)
    // NOTE: Stripe webhook not wired yet; we rely on local `subscriptions` table only.
    let state = 'NEW';
    let subscription = null;

    if (delivery) {
      state = 'LINKING';
      // Paid-mode must be strongly scoped to the delivery user_id.
      // We use user_id = provision_uuid for isolation (prevents subscription leakage across UUIDs).
      if (String(delivery.user_id || '')) {
        try {
          subscription = db.prepare(
            "SELECT provider_sub_id, provider, user_id, plan, status, current_period_end, cancel_at, canceled_at, ended_at, cancel_at_period_end, updated_at FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1"
          ).get(delivery.user_id) || null;
        } catch {
          subscription = null;
        }
      }

      const stU = String(status || '').toUpperCase();
      if (stU === 'PAID' || stU === 'DELIVERING' || stU === 'DELIVERED') {
        state = 'PAID_ACTIVE';
      } else if (subscription && String(subscription.status || '').toLowerCase() === 'active') {
        state = 'PAID_ACTIVE';
      }
    }

    const instance = delivery ? getInstanceById(db, delivery.instance_id) : null;

    return send(res, 200, {
      ok: true,
      uuid,
      lang,
      busy,
      readyCapacity: ready,
      state,
      subscription: subscription ? {
        plan: subscription.plan,
        status: subscription.status,
        current_period_end: subscription.current_period_end || null,
        cancel_at: subscription.cancel_at || null,
        canceled_at: subscription.canceled_at || null,
        ended_at: subscription.ended_at || null,
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
        updated_at: subscription.updated_at
      } : null,
      instance: instance ? (() => {
        let meta = {};
        try { meta = instance.meta_json ? JSON.parse(instance.meta_json) : {}; } catch { meta = {}; }
        return {
          // SECURITY: do not expose cloud provider instance_id to end-users.
          provider: instance.provider,
          region: instance.region,
          zone: instance.zone,
          public_ip: instance.public_ip,
          lifecycle_status: instance.lifecycle_status,
          health_status: instance.health_status,
          created_at: instance.created_at,
          expired_at: instance.expired_at,
          last_ok_at: instance.last_ok_at,
          last_probe_at: instance.last_probe_at,

          // Server configuration (best-effort)
          config: {
            cpu: meta.cpu ?? null,
            memory_gb: meta.memory ?? null,
            internet_max_bw_out_mbps: meta.internet_max_bw_out ?? null,
            bundle_id: instance.bundle_id || null,
            blueprint_id: instance.blueprint_id || null,
          }
        };
      })() : null,
      delivery: delivery ? {
        delivery_id: delivery.delivery_id,
        instance_id: delivery.instance_id,
        status,
        wa_jid: delivery.wa_jid ? '[set]' : null,
        bound_at: delivery.bound_at || null,
        updated_at: delivery.updated_at,
      } : null,
    });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// Billing portal (Stripe): allow paid users to self-manage subscription (cancel, update payment method).
// This endpoint returns a redirect URL. Caller should navigate to it.
app.get('/api/billing/portal', async (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    const lang = String(req.query?.lang || '').trim() || 'en';
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const secret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
    if (!secret) return send(res, 500, { ok:false, error:'stripe_not_configured' });

    const { db } = openDb();
    const delivery = getDeliveryByUuid(db, uuid);
    if (!delivery) return send(res, 404, { ok:false, error:'unknown_uuid' });

    const sub = db.prepare(
      "SELECT provider_sub_id, provider, user_id, plan, status, current_period_end, cancel_at_period_end, updated_at FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1"
    ).get(delivery.user_id) || null;

    if (!sub || String(sub.provider || '') !== 'stripe' || !sub.provider_sub_id) {
      return send(res, 404, { ok:false, error:'subscription_not_found' });
    }

    // Retrieve subscription to get customer id
    const auth = Buffer.from(`${secret}:`).toString('base64');
    const subResp = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(sub.provider_sub_id)}`, {
      headers: { 'authorization': `Basic ${auth}` }
    });
    const subJson = await subResp.json().catch(()=>null);
    if (!subResp.ok) return send(res, 502, { ok:false, error:'stripe_subscription_fetch_failed', detail: subJson });

    const customer = subJson && subJson.customer;
    if (!customer) return send(res, 502, { ok:false, error:'stripe_customer_missing' });

    const return_url = (lang === 'zh')
      ? `https://p.bothook.me/zh/?lang=zh&uuid=${encodeURIComponent(uuid)}`
      : `https://p.bothook.me/?lang=${encodeURIComponent(lang)}&uuid=${encodeURIComponent(uuid)}`;

    const body = new URLSearchParams();
    body.set('customer', String(customer));
    body.set('return_url', return_url);

    const portalResp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'authorization': `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body
    });
    const portalJson = await portalResp.json().catch(()=>null);
    if (!portalResp.ok) return send(res, 502, { ok:false, error:'stripe_portal_create_failed', detail: portalJson });

    return send(res, 200, { ok:true, url: portalJson.url });
  } catch (e) {
    return send(res, 500, { ok:false, error: e.message || 'server_error' });
  }
});

// Billing cancel shortlink (Stripe portal session behind shortlink).
// IMPORTANT: this does NOT cancel anything server-side; user cancels inside Stripe portal UI.
app.post('/api/billing/cancel_link', async (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '').trim();
    const lang = String(req.body?.lang || '').trim().toLowerCase() || 'en';
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const secret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
    if (!secret) return send(res, 500, { ok:false, error:'stripe_not_configured' });

    const { db } = openDb();
    const delivery = getDeliveryByUuid(db, uuid);
    if (!delivery) return send(res, 404, { ok:false, error:'unknown_uuid' });

    // Create portal session URL via existing endpoint logic (inline minimal subset).
    const sub = db.prepare(
      "SELECT provider_sub_id, provider, user_id, plan, status, current_period_end, cancel_at_period_end, updated_at FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1"
    ).get(delivery.user_id) || null;

    if (!sub || String(sub.provider || '') !== 'stripe' || !sub.provider_sub_id) {
      return send(res, 404, { ok:false, error:'subscription_not_found' });
    }

    const auth = Buffer.from(`${secret}:`).toString('base64');
    const subResp = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(sub.provider_sub_id)}`, {
      headers: { 'authorization': `Basic ${auth}` }
    });
    const subJson = await subResp.json().catch(()=>null);
    if (!subResp.ok) return send(res, 502, { ok:false, error:'stripe_subscription_fetch_failed', detail: subJson });

    const customer = subJson && subJson.customer;
    if (!customer) return send(res, 502, { ok:false, error:'stripe_customer_missing' });

    const return_url = (lang === 'zh')
      ? `https://p.bothook.me/zh/?lang=zh&uuid=${encodeURIComponent(uuid)}`
      : `https://p.bothook.me/?lang=${encodeURIComponent(lang)}&uuid=${encodeURIComponent(uuid)}`;

    const body = new URLSearchParams();
    body.set('customer', String(customer));
    body.set('return_url', return_url);

    const portalResp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'authorization': `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body
    });
    const portalJson = await portalResp.json().catch(()=>null);
    if (!portalResp.ok) return send(res, 502, { ok:false, error:'stripe_portal_create_failed', detail: portalJson });
    const portalUrl = portalJson?.url ? String(portalJson.url) : '';
    if (!portalUrl) return send(res, 502, { ok:false, error:'stripe_portal_url_missing' });

    // Shortlink TTL: 1 hour (portal URL itself is session-based).
    const now = Date.now();
    const expiresAt = new Date(now + 60*60*1000).toISOString();

    // Reuse an unexpired shortlink if present (idempotent within TTL).
    const existing = db.prepare(`SELECT code, expires_at FROM shortlinks WHERE provision_uuid=? AND kind='stripe_portal_cancel' ORDER BY created_at DESC LIMIT 1`).get(uuid);
    if (existing?.code && (!existing.expires_at || Date.parse(existing.expires_at) > now)) {
      return send(res, 200, { ok:true, uuid, cancelUrl: baseUrlForShortlinks()+existing.code, expiresAt: existing.expires_at || expiresAt, reused:true });
    }

    let code;
    for (let i=0;i<5;i++){
      const c = randCode(7);
      const used = db.prepare('SELECT 1 FROM shortlinks WHERE code=?').get(c);
      if (!used) { code = c; break; }
    }
    if (!code) throw new Error('shortlink_code_exhausted');

    const ts2 = nowIso();
    upsertShortlink(db, {
      code,
      long_url: portalUrl,
      created_at: ts2,
      expires_at: expiresAt,
      kind: 'stripe_portal_cancel',
      delivery_id: delivery.delivery_id,
      provision_uuid: uuid,
      meta: { lang },
    });

    return send(res, 200, { ok:true, uuid, cancelUrl: baseUrlForShortlinks()+code, expiresAt, reused:false });
  } catch (e) {
    return send(res, e.statusCode || 500, { ok:false, error: e.message || 'server_error', detail: e.detail });
  }
});

function hasOtherActiveDeliveriesOnInstance(db, instanceId, uuid) {
  try {
    const rows = db.prepare(`
      SELECT delivery_id, provision_uuid, status, updated_at
      FROM deliveries
      WHERE instance_id = ?
        AND provision_uuid != ?
        AND status IN ('LINKING','ACTIVE','BOUND_UNPAID','PAID','DELIVERING','DELIVERED')
      ORDER BY datetime(updated_at) DESC
      LIMIT 5
    `).all(instanceId, uuid);
    return rows || [];
  } catch {
    return [];
  }
}

app.post('/api/wa/start', async (req, res) => {
  try {
    res.set('x-bothook-build', 'wa-start-alloc-v2-user-machine');
    const uuid = String(req.body?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok: false, error: 'uuid_required' });

    const { db } = openDb();
    const preferredLang = String(req.body?.lang || req.query?.lang || '').trim().toLowerCase() || null;
    let delivery = getOrCreateDeliveryForUuid(db, uuid, { preferredLang });

    // Self-heal: if watchdog cleared instance_id (QR_EXPIRED) or the delivery has no instance,
    // allocate a fresh clean pool machine here (this is the concrete user action: start linking).
    if (!delivery.instance_id) {
      // DEBUG: surface allocation path execution
      console.log('[bothook-api] wa/start needs allocation for uuid', uuid, 'delivery_id', delivery.delivery_id, 'status', delivery.status);
      const ts = nowIso();

      const candidates = db.prepare(`
        SELECT instance_id, public_ip, lifecycle_status, health_status, meta_json, created_at
        FROM instances
        WHERE public_ip IS NOT NULL AND public_ip != ''
          AND lifecycle_status='IN_POOL'
          AND health_status='READY'
        ORDER BY created_at ASC
        LIMIT 50
      `).all();

      const provisionReady = candidates.filter((i) => {
        const meta = (jsonMeta(i.meta_json) || {});
        const pr = meta.provision_ready;
        // Back-compat: older pool init sets init_state=INIT_DONE but not provision_ready.
        return pr === true || pr === 1 || pr === '1' || String(meta.init_state || '') === 'INIT_DONE';
      });
      if (!provisionReady.length) {
        return send(res, 503, { ok:false, error:'no_provision_ready_instances' });
      }

      // Extra guard: only consider instances that have no other non-terminal deliveries bound to them.
      const conflictFree = provisionReady.filter((c) => !hasOtherActiveDeliveriesOnInstance(db, c.instance_id, uuid).length);

      let chosen = null;
      // Fail-fast: never let /api/wa/start spend unbounded time probing instances.
      // We cap probes and use a short SSH timeout to avoid control-plane hangs.
      const PROBE_LIMIT = parseInt(process.env.BOTHOOK_WA_START_PROBE_LIMIT || '2', 10);
      let probed = 0;
      for (const c of conflictFree) {
        if (probed >= PROBE_LIMIT) break;
        const inst = getInstanceById(db, c.instance_id);
        // Lightweight B: ensure SSH is responsive before running any OpenClaw probe.
        // This filters out instances that have port 22 open but stall during SSH banner exchange.
        try {
          const sshQuick = poolSsh(inst, 'echo ok', { timeoutMs: 5000, tty: false, retries: 0, profile: 'fast' });
          if ((sshQuick.code ?? 1) !== 0 || !String(sshQuick.stdout || '').includes('ok')) {
            continue;
          }
        } catch {
          continue;
        }

        const timeoutMs = parseInt(process.env.BOTHOOK_WA_START_INSTANCE_PROBE_TIMEOUT_MS || '15000', 10);
        const probe = probeInstanceWhatsappClean(db, inst, { timeoutMs });
        probed++;
        if (probe.clean) { chosen = inst; break; }
      }
      if (!chosen) {
        if (conflictFree.length !== provisionReady.length) {
          return send(res, 503, { ok:false, error:'no_conflict_free_instances_available' });
        }
        return send(res, 503, { ok:false, error:'no_clean_instances_available' });
      }

      db.exec('BEGIN IMMEDIATE');
      try {
        // Re-check conflicts under write lock to avoid race: two concurrent allocators can otherwise pick the same instance.
        const conflictsNow = hasOtherActiveDeliveriesOnInstance(db, chosen.instance_id, uuid);
        if (conflictsNow.length) {
          throw Object.assign(new Error('instance_conflict_race'), { conflictsNow });
        }

        const row = db.prepare('SELECT status, meta_json FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
        const meta2 = mergeMeta(row?.meta_json || delivery.meta_json, {
          reallocated_at: ts,
          prev_instance_id: null,
          prev_status: row?.status || delivery.status || null
        });

        db.prepare('UPDATE deliveries SET instance_id=?, status=?, updated_at=?, meta_json=? WHERE delivery_id=?')
          .run(chosen.instance_id, 'LINKING', ts, meta2, delivery.delivery_id);

        db.prepare('UPDATE instances SET lifecycle_status=?, assigned_user_id=?, assigned_at=? WHERE instance_id=?')
          .run('ALLOCATED', uuid, ts, chosen.instance_id);

        writeUuidStateFilesOnInstance(chosen, { uuid, lang: preferredLang || 'en' });

        db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json)
                    VALUES (?,?,?,?,?,?)`).run(
          crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'PROVISION_REALLOCATED',
          JSON.stringify({ uuid, instance_id: chosen.instance_id, from_status: row?.status || delivery.status || null })
        );

        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        if (String(e?.message || '') === 'instance_conflict_race') {
          const conflicts = e?.conflictsNow || [];
          try {
            const ts3 = nowIso();
            db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
              crypto.randomUUID(), ts3, 'delivery', delivery.delivery_id, 'INSTANCE_CONFLICT_DETECTED',
              JSON.stringify({ uuid, instance_id: chosen.instance_id, conflicts, mode: 'race_recheck' })
            );
          } catch {}
          return send(res, 409, { ok:false, error:'instance_conflict', detail:'instance allocation race detected', instance_id: chosen.instance_id, conflicts });
        }
        throw e;
      }

      delivery = db.prepare('SELECT * FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
    }

    const instance = getInstanceById(db, delivery.instance_id);
    if (!instance?.public_ip) return send(res, 500, { ok: false, error: 'instance_missing_ip' });

    // Safety: prevent multiple active deliveries from sharing one instance (causes WA/gateway flapping).
    // If this happens, surface a 409 and require ops intervention rather than silently hijacking.
    try {
      const conflicts = hasOtherActiveDeliveriesOnInstance(db, instance.instance_id, uuid);
      if (conflicts.length) {
        try {
          const ts = nowIso();
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'INSTANCE_CONFLICT_DETECTED',
            JSON.stringify({ uuid, instance_id: instance.instance_id, conflicts })
          );
        } catch {}
        return send(res, 409, {
          ok: false,
          error: 'instance_conflict',
          detail: `instance ${instance.instance_id} already has other active deliveries`,
          conflicts,
          instance_id: instance.instance_id,
        });
      }
    } catch {}

    const force = Boolean(req.body?.force);

    // Turnstile enforcement (relink only): require a valid Turnstile token when force=true.
    // Frontend already performs Turnstile verification, but backend must enforce it to prevent bypass.
    if (force) {
      const token = String(req.body?.turnstileToken || '').trim();
      if (!token) {
        return send(res, 403, { ok: false, error: 'turnstile_required' });
      }
      try {
        let secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
        if (!secret) {
          // Fallback: read local credentials file (service may not load EnvironmentFile).
          try {
            const envTxt = fs.readFileSync('/home/ubuntu/.openclaw/credentials/cloudflare_turnstile.env', 'utf8');
            for (const line of envTxt.split(/\r?\n/)) {
              const m = line.match(/^TURNSTILE_SECRET_KEY=(.*)$/);
              if (m) { secret = String(m[1] || '').trim(); break; }
            }
          } catch {}
        }
        if (!secret) {
          // Misconfiguration: fail closed for relink.
          return send(res, 500, { ok: false, error: 'turnstile_misconfigured' });
        }

        const params = new URLSearchParams();
        params.set('secret', secret);
        params.set('response', token);

        // Best-effort: forward a client IP if present (Cloudflare headers / proxy).
        const rip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        if (rip) params.set('remoteip', rip);

        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        try {
          const vr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: params,
            signal: ctrl.signal,
          });
          const vj = await vr.json().catch(() => ({}));
          if (!vr.ok || !vj || vj.success !== true) {
            return send(res, 403, { ok: false, error: 'turnstile_failed' });
          }
        } finally {
          clearTimeout(t);
        }
      } catch {
        return send(res, 403, { ok: false, error: 'turnstile_failed' });
      }
    }

    // Anti-storm: /api/wa/start can be hit repeatedly by page refreshes / double-clicks.
    // Without a cooldown, we end up restarting the user-machine login (tmux + openclaw channels login)
    // which can spike CPU and cause gateway flapping on pool instances.
    //
    // Policy: for first-link (force=false), apply a short server-side cooldown window.
    // (Force relink flows are gated separately by entitlement checks.)
    try {
      const meta0 = jsonMeta(delivery.meta_json) || {};
      const lastAt = Date.parse(String(meta0.wa_start_last_at || ''));
      const COOLDOWN_MS = parseInt(process.env.BOTHOOK_WA_START_COOLDOWN_MS || String(60_000), 10);
      if (!force && lastAt && (Date.now() - lastAt) < COOLDOWN_MS) {
        return send(res, 200, {
          ok: true,
          uuid,
          instance_id: instance.instance_id,
          status: 'cooldown',
          cooldown_ms: COOLDOWN_MS - (Date.now() - lastAt),
          mode: 'user_machine_provision'
        });
      }
    } catch {}

    // Mark relink intent (force flow) so /api/wa/status can branch behavior without affecting first-link.
    try {
      if (force) {
        const ts2 = nowIso();
        const meta2 = mergeMeta(delivery.meta_json, { relink_force: true, relink_started_at: ts2 });
        db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta2, ts2, delivery.delivery_id);
        delivery = db.prepare('SELECT * FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
      }
    } catch {}

    // SECURITY (A-style relink: same instance): force relink must be authorized.
    // Policy: allow when either
    // - delivery.status is PAID (legacy MVP), OR
    // - Stripe subscription is still in the paid effective period (including cancel_at_period_end but not yet ended).
    if (force) {
      const st = String(delivery.status || '');
      // Allow forcing a fresh (unpaid) onboarding relink when the delivery is not in a paid/delivered state.
      // This keeps the UI unblocked for new-user tests and avoids trapping users behind subscription checks.
      const allowUnpaidForce = ['QR_EXPIRED','BOUND_UNPAID','ACTIVE','LINKING_TIMEOUT','LINKING','ALLOCATED'].includes(st);
      let entitled = (st === 'PAID') || allowUnpaidForce;

      if (!entitled) {
        const uid = String(delivery.user_id || '').trim();
        if (uid) {
          const sub = db.prepare(
            `SELECT provider_sub_id, provider, user_id, status,
                    current_period_end, cancel_at, canceled_at, ended_at, updated_at
             FROM subscriptions
             WHERE user_id = ?
             ORDER BY updated_at DESC
             LIMIT 1`
          ).get(uid) || null;

          const now = Date.now();
          const providerOk = String(sub?.provider || '') === 'stripe' && !!sub?.provider_sub_id;
          const endedAt = sub?.ended_at ? Date.parse(sub.ended_at) : null;
          const cpe = sub?.current_period_end ? Date.parse(sub.current_period_end) : null;
          const cancelAt = sub?.cancel_at ? Date.parse(sub.cancel_at) : null;

          const notEnded = !endedAt || endedAt > now;
          const inPeriod = (cpe && cpe > now) || (cancelAt && cancelAt > now);
          const statusOk = ['active', 'trialing'].includes(String(sub?.status || '').toLowerCase());

          entitled = Boolean(providerOk && notEnded && inPeriod && statusOk);
        }
      }

      if (!entitled) {
        return send(res, 403, { ok: false, error: 'relink_requires_active_subscription' });
      }
    }

    // Default: delegate QR/login to user-machine provisioning server (18999) and keep it loopback-only.
    // Control-plane should coordinate + persist state, not parse tmux QR.
    const startPath = '/api/wa/start';
    const body = JSON.stringify({ uuid, force });

    // Persist a "start" timestamp early to suppress start storms even if delegation fails.
    // (Clients should use /api/wa/status + /api/wa/qr polling after calling /api/wa/start once.)
    try {
      const tsS = nowIso();
      const metaS = mergeMeta(delivery.meta_json, { wa_start_last_at: tsS, wa_start_last_force: force });
      db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(metaS, tsS, delivery.delivery_id);
      delivery = db.prepare('SELECT * FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
    } catch {}

    // Ensure user-machine provisioning server (18999) is running before delegating QR/login.
    // Delivered-mode convergence may have disabled it; relink must be able to start it on-demand.
    //
    // STRICT MODE (relink only): when force=true, require provision to actually start and pass /healthz,
    // otherwise fail fast (do NOT let UI spin forever on qr_not_ready).
    const STRICT_RELINK = force && String(process.env.BOTHOOK_RELINK_STRICT_PROVISION_START || '1') === '1';
    try {
      const cmd = `set -euo pipefail; `
        + (STRICT_RELINK ? `sudo rm -f /opt/bothook/LOGIN_AUTHORITY.control-plane 2>/dev/null || true; ` : ``)
        + `sudo systemctl start bothook-provision.service; `
        + `sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins enable bothook-wa-loopback >/dev/null 2>&1 || true; `
        + `sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins enable bothook-wa-sendguard >/dev/null 2>&1 || true; `
        + (STRICT_RELINK
            ? `for i in 1 2 3 4 5; do curl -sf -m 1 http://127.0.0.1:18999/healthz >/dev/null 2>&1 && break; sleep 0.4; done; `
              + `curl -sf -m 1 http://127.0.0.1:18999/healthz >/dev/null 2>&1`
            : `true`)
        + `; echo provision_started`;

      const pr = poolSsh(instance, cmd, { timeoutMs: STRICT_RELINK ? 15000 : 8000, tty: false, retries: 0 });
      if (STRICT_RELINK && (pr.code ?? 1) !== 0) {
        return send(res, 502, { ok: false, error: 'provision_start_failed' });
      }
    } catch {
      if (STRICT_RELINK) {
        return send(res, 502, { ok: false, error: 'provision_start_failed' });
      }
    }
    // For first-link (force=false): we still keep it bounded, but we MUST ensure the user-machine provision
    // server actually receives the start request, otherwise the UI will spin forever on qr_not_ready.
    if (!force) {
      const kick = await poolFetch(instance, startPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        timeoutMs: 12000,
      });
      if (!kick.ok) {
        return send(res, 502, {
          ok: false,
          error: 'provision_start_failed',
          uuid,
          instance_id: instance.instance_id,
          detail: String(kick.text || '').slice(0, 300),
        });
      }

      try { startWelcomeWatch(uuid); } catch {}

      return send(res, 200, {
        ok: true,
        uuid,
        instance_id: instance.instance_id,
        status: 'starting',
        queued: false,
        mode: 'user_machine_provision',
      });
    }

    // Force relink: proactively logout WhatsApp on the instance so /api/wa/status won't short-circuit as "connected".
    // This makes the QR flow deterministic: disconnected -> QR -> scan -> connected.
    if (force) {
      try {
        poolSsh(
          instance,
          `set -euo pipefail; `
            + `openclaw channels logout --channel whatsapp 2>/dev/null || true; `
            + `rm -rf /home/ubuntu/.openclaw/channels/whatsapp 2>/dev/null || true; `
            + `echo wa_logged_out`,
          { timeoutMs: 8000, tty: false, retries: 0 }
        );
      } catch {}
    }

    const rr = await poolFetch(instance, startPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      timeoutMs: 15000,
    });

    // Self-heal: if user-machine provision server is down, try to start it once and retry QR fetch.
    if (!rr.ok && /Failed to connect to 127\.0\.0\.1 port 18999|Couldn\u2019t connect to server|Connection refused/i.test(String(rr.text||''))) {      let provisionKick = null;
      try {
        const r0 = poolSsh(
          instance,
          `set -euo pipefail; `
            + `sudo systemctl start bothook-provision.service; `
            + `for i in 1 2 3 4 5; do curl -sf -m 1 http://127.0.0.1:18999/healthz >/dev/null 2>&1 && break; sleep 0.4; done; `
            + `curl -sf -m 1 http://127.0.0.1:18999/healthz >/dev/null 2>&1 && echo provision_ready || echo provision_not_ready`,
          { timeoutMs: 12000, tty: false, retries: 0 }
        );
        provisionKick = {
          code: r0?.code ?? null,
          stdout: String(r0?.stdout || '').slice(0, 200),
          stderr: String(r0?.stderr || '').slice(0, 200),
        };
      } catch (e) {
        provisionKick = { code: 255, stdout: '', stderr: 'poolSsh_throw' };
      }
      lastProvisionKick = provisionKick;


      // Retry QR fetch once after attempting to start provision.
      const rr2 = await poolFetch(instance, `/api/wa/qr?uuid=${encodeURIComponent(uuid)}`, { method: 'GET', timeoutMs: 20000 });
      if (rr2.ok && rr2.json) {
        const payload = {
          ok: true,
          uuid,
          instance_id: instance.instance_id,
          status: rr2.json.status || 'qr',
          qrDataUrl: rr2.json.qrDataUrl || null,
          qrSeq: rr2.json.qrSeq || 0,
          qrAt: rr2.json.qrAt || null,
          mode: 'user_machine_provision',
          recovered: true,
          provisionKick,
        };
        if (payload.qrDataUrl && isPlausiblePngDataUrl(payload.qrDataUrl)) {
          qrCache.set(uuid, { qrDataUrl: payload.qrDataUrl, qrSeq: payload.qrSeq, qrAt: payload.qrAt, cachedAtMs: Date.now() });
        }
        return send(res, 200, payload);
      }
    }

    if (rr.ok && rr.json) {
      // After starting linking, proactively watch for WA becoming connected and trigger welcome.
      // This removes the dependency on the frontend polling /api/wa/status.
      try { startWelcomeWatch(uuid); } catch {}

      return send(res, 200, {
        ok: true,
        uuid,
        instance_id: instance.instance_id,
        status: rr.json.status || 'starting',
        mode: 'user_machine_provision',
      });
    }

    // No tmux fallback in the default architecture.
    // If delegation fails, surface the failure and let ops decide.
    return send(res, 502, { ok:false, error:'user_machine_start_failed', detail: (rr.text||'').slice(0,300) });
  } catch (e) {
    return send(res, e.statusCode || 500, { ok: false, error: e.message || 'server_error' });
  }
});

function stripAnsi(s) {
  return String(s || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function extractAsciiQrBlock(text) {
  const lines = stripAnsi(String(text || '')).replace(/\r/g, '').split('\n');
  // There can be multiple QR blocks over time; always return the latest.
  let best = null;
  for (let start = 0; start < lines.length; start++) {
    if (!lines[start].includes('Scan this QR')) continue;
    const out = [];
    for (let i = start; i < lines.length; i++) {
      const l = lines[i];
      if (i > start && l === '') break;
      out.push(l);
    }

    // Post-process: drop truncated trailing QR lines (script output can contain broken bytes).
    // Find QR glyph line range.
    const glyphIdx = out.findIndex(l => /[█▄▀]{5,}/.test(l));
    if (glyphIdx === -1) continue;
    const glyph = out.slice(glyphIdx);
    const widths = glyph.map(l => l.length);
    const maxW = Math.max(...widths);
    while (glyph.length && glyph[glyph.length - 1].length < Math.floor(maxW * 0.9)) {
      glyph.pop();
    }
    const cleaned = out.slice(0, glyphIdx).concat(glyph);

    const joined = cleaned.join('\n');
    if (/[█▄▀]{10,}/.test(joined)) best = joined.trimEnd();
  }
  return best;
}

const qrWatch = new Map();
// qrWatch.get(uuid) => { lastHash, lastSeenAtMs, lastRestartAtMs }

const welcomeWatch = new Map();
// welcomeWatch.get(uuid) => { startedAtMs, timer }

function startWelcomeWatch(uuid, { maxMs = 2 * 60 * 1000, intervalMs = 4000 } = {}) {
  const u = String(uuid || '').trim();
  if (!u) return;
  if (welcomeWatch.has(u)) return;

  const startedAtMs = Date.now();
  const timer = setInterval(async () => {
    try {
      if (Date.now() - startedAtMs > maxMs) {
        try { clearInterval(timer); } catch {}
        welcomeWatch.delete(u);
        return;
      }

      // Stop once welcome is confirmed sent.
      try {
        const { db } = openDb();
        const d = db.prepare('SELECT meta_json FROM deliveries WHERE provision_uuid=? LIMIT 1').get(u);
        const meta = jsonMeta(d?.meta_json) || {};
        if (meta.welcome_unpaid_sent_at) {
          try { clearInterval(timer); } catch {}
          welcomeWatch.delete(u);
          return;
        }
      } catch {}

      // Trigger /api/wa/status internally; it contains the async welcome send logic.
      try {
        await fetch(`http://127.0.0.1:${PORT}/api/wa/status?uuid=${encodeURIComponent(u)}`);
      } catch {}
    } catch {}
  }, intervalMs);

  // do not hold the event loop open
  try { timer.unref?.(); } catch {}
  welcomeWatch.set(u, { startedAtMs, timer });
}

const qrCache = new Map();
// qrCache.get(uuid) => { qrDataUrl, qrSeq, qrAt, cachedAtMs }

function sha256Hex(s){
  return crypto.createHash('sha256').update(String(s||''), 'utf8').digest('hex');
}

function isPlausiblePngDataUrl(dataUrl){
  try{
    const s = String(dataUrl||'');
    if(!s.startsWith('data:image/png;base64,')) return false;
    const b64 = s.split(',',2)[1] || '';
    const buf = Buffer.from(b64, 'base64');
    if(buf.length < 24) return false;
    // PNG signature
    const sig = [0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A];
    for(let i=0;i<sig.length;i++) if(buf[i]!==sig[i]) return false;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if(!w || !h) return false;
    if(w < 120 || h < 120) return false;
    if(w > 2000 || h > 2000) return false;
    const ratio = w / h;
    if(ratio > 1.6 || ratio < (1/1.6)) return false;
    return true;
  }catch{ return false; }
}

app.get('/api/wa/qr', async (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok: false, error: 'uuid_required' });

    // QR must never be cached by browsers/CDNs.
    try {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } catch {}

    const { db } = openDb();
    const delivery = db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
    if (!delivery) return send(res, 404, { ok: false, error: 'unknown_uuid' });

    const instance = getInstanceById(db, delivery.instance_id);
    if (!instance?.public_ip) {
      return send(res, 409, { ok: false, error: 'no_instance_allocated', uuid, status: delivery.status });
    }

    // Fast path: serve cached QR (avoid blocking the entire node process on SSH/poolFetch).
    // IMPORTANT: poolFetch currently uses synchronous primitives; keep this handler cheap.
    try {
      const cached = qrCache.get(uuid);
      const ageMs = cached?.cachedAtMs ? (Date.now() - cached.cachedAtMs) : 1e12;
      if (cached?.qrDataUrl && ageMs < 8000) {
        return send(res, 200, {
          ok: true,
          uuid,
          instance_id: instance.instance_id,
          status: 'qr',
          qrDataUrl: cached.qrDataUrl,
          qrSeq: cached.qrSeq || 0,
          qrAt: cached.qrAt || null,
          mode: 'cache',
          cachedAgeMs: ageMs,
        });
      }
    } catch {}

    // Default: delegate to user machine (18999). Returns qrDataUrl.
    let lastProvisionKick = null;
    let rr = await poolFetch(instance, `/api/wa/qr?uuid=${encodeURIComponent(uuid)}`, {
      method: 'GET',
      // SSH + curl can occasionally exceed a few seconds due to banner exchange / jitter.
      timeoutMs: 20000,
    });

    // Self-heal: if provision server is down, try to start it and retry once.
    if (!rr.ok && /Failed to connect to 127\.0\.0\.1 port 18999|Couldn\u2019t connect to server|Connection refused/i.test(String(rr.text||''))) {
      try {
        const k = poolSsh(
          instance,
          `set -euo pipefail; `
            + `sudo systemctl start bothook-provision.service; `
            + `for i in 1 2 3 4 5; do curl -sf -m 1 http://127.0.0.1:18999/healthz >/dev/null 2>&1 && break; sleep 0.4; done; `
            + `curl -sf -m 1 http://127.0.0.1:18999/healthz >/dev/null 2>&1 && echo provision_ready || echo provision_not_ready`,
          { timeoutMs: 12000, tty: false, retries: 0 }
        );
        lastProvisionKick = {
          code: k?.code ?? null,
          stdout: String(k?.stdout || '').slice(0, 200),
          stderr: String(k?.stderr || '').slice(0, 200),
        };
      } catch (e) {
        lastProvisionKick = { code: 255, stdout: '', stderr: 'poolSsh_throw' };
      }

      const rr2 = await poolFetch(instance, `/api/wa/qr?uuid=${encodeURIComponent(uuid)}`, { method: 'GET', timeoutMs: 20000 });
      if (rr2.ok && rr2.json) {
        const payload = {
          ok: true,
          uuid,
          instance_id: instance.instance_id,
          status: rr2.json.status || 'qr',
          qrDataUrl: rr2.json.qrDataUrl || null,
          qrSeq: rr2.json.qrSeq || 0,
          qrAt: rr2.json.qrAt || null,
          mode: 'user_machine_provision',
          recovered: true,
          provisionKick: lastProvisionKick,
        };
        if (payload.qrDataUrl && isPlausiblePngDataUrl(payload.qrDataUrl)) {
          qrCache.set(uuid, { qrDataUrl: payload.qrDataUrl, qrSeq: payload.qrSeq, qrAt: payload.qrAt, cachedAtMs: Date.now() });
        }
        return send(res, 200, payload);
      }

      // Replace rr with the retry result so downstream logic sees the freshest response.
      rr = rr2;
    }

    // Self-heal: if linking has started but QR is not ready, kick provision /api/wa/start and retry once.
    // IMPORTANT: do this even if rr.ok is false (SSH-mode poolFetch treats json.ok=false as ok=false).
    if (rr?.json && (String(rr.json.error || '') === 'qr_not_ready' || Number(rr.json.qrSeq || 0) === 0)) {
      try {
        await poolFetch(instance, `/api/wa/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ uuid, force: false }),
          timeoutMs: 12000,
        });
      } catch {}

      const rrRetry = await poolFetch(instance, `/api/wa/qr?uuid=${encodeURIComponent(uuid)}`, { method: 'GET', timeoutMs: 20000 });
      // Replace rr so the normal return path can proceed.
      rr = rrRetry;
    }

    if (rr.ok && rr.json) {
      const payload = {
        ok: true,
        uuid,
        instance_id: instance.instance_id,
        status: rr.json.status || 'qr',
        qrDataUrl: rr.json.qrDataUrl || null,
        qrSeq: rr.json.qrSeq || 0,
        qrAt: rr.json.qrAt || null,
        mode: 'user_machine_provision',
      };
      if (payload.qrDataUrl && isPlausiblePngDataUrl(payload.qrDataUrl)) {
        qrCache.set(uuid, { qrDataUrl: payload.qrDataUrl, qrSeq: payload.qrSeq, qrAt: payload.qrAt, cachedAtMs: Date.now() });
      }
      return send(res, 200, payload);
    }

    // Consistency guard: NEVER serve cached QR when provision explicitly says qr_not_ready.
    // Otherwise users can get a stale QR (scan fails/"expired") while the instance hasn't produced a fresh one.
    if (rr?.json && (String(rr.json.error || '') === 'qr_not_ready' || Number(rr.json.qrSeq || 0) === 0)) {
      try { qrCache.delete(uuid); } catch {}
      return send(res, 409, {
        ok: false,
        error: 'qr_not_ready',
        mode: 'user_machine_provision',
        detail: JSON.stringify({ fetch: String(rr.text||'').slice(0,200), kick: lastProvisionKick }).slice(0,500)
      });
    }

    // If user-machine provision is temporarily not ready, serve cached QR for UI stability.
    // BUT: never serve cached QR indefinitely — WhatsApp QR expires and a static QR will confuse users.
    const cached = qrCache.get(uuid);
    if (cached?.qrDataUrl) {
      const cachedAtMs = Number(cached.cachedAtMs || 0) || 0;
      const cachedAgeMs = cachedAtMs > 0 ? (Date.now() - cachedAtMs) : 1e12;
      const CACHE_TTL_MS = 90_000;

      // Hard-expire stale cached QR.
      if (cachedAgeMs > CACHE_TTL_MS) {
        try { qrCache.delete(uuid); } catch {}
      } else if (!isPlausiblePngDataUrl(cached.qrDataUrl)) {
        try { qrCache.delete(uuid); } catch {}
      } else {
        // best-effort kick provision back on (do not block UI when cached QR exists)
        try {
          poolSsh(instance, `set -euo pipefail; sudo systemctl start bothook-provision.service >/dev/null 2>&1 || true; echo kicked`, { timeoutMs: 6000, tty:false, retries:0 });
        } catch {}

        return send(res, 200, {
          ok: true,
          uuid,
          instance_id: instance.instance_id,
          status: 'qr',
          qrDataUrl: cached.qrDataUrl,
          qrSeq: cached.qrSeq || 0,
          qrAt: cached.qrAt || null,
          mode: 'user_machine_provision_cached',
          cached: true,
          cachedAgeMs,
          stale: false,
        });
      }
    }

    // Fallback: legacy control-plane tmux parsing.
    if (String(process.env.BOTHOOK_WA_FALLBACK_TMUX || '').toLowerCase() !== '1') {
      return send(res, 409, { ok:false, error:'qr_not_ready', mode:'user_machine_provision', detail: JSON.stringify({ fetch: String(rr.text||'').slice(0,200), kick: lastProvisionKick }).slice(0,500) });
    }

    // --- legacy tmux fallback below (unchanged) ---
    const tmuxSession = `wa-login-${uuid}`.replace(/[^a-zA-Z0-9_-]/g, '');
    const capCmd = `set -euo pipefail; tmux has-session -t '${tmuxSession}' 2>/dev/null || exit 3; tmux capture-pane -t '${tmuxSession}' -p -S -4000 | tail -n 1200`;
    let sshr = poolSsh(instance, capCmd, { timeoutMs: 5000, tty: false, retries: 0 });
    if ((sshr.code ?? 0) === 3) {
      return send(res, 409, { ok:false, error:'qr_not_ready', mode:'tmux_fallback', loginRunning:false });
    }
    const raw = (sshr.stdout || sshr.stderr || '').toString();
    const qrText = extractAsciiQrBlock(raw);
    if (!qrText) {
      return send(res, 409, { ok:false, error:'qr_not_ready', mode:'tmux_fallback' });
    }
    const h = sha256Hex(qrText);
    return send(res, 200, { ok:true, uuid, instance_id: instance.instance_id, status:'qr', qrText, qrHash:h, mode:'tmux_fallback' });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message || 'server_error' });
  }
});


app.get('/api/wa/welcome_unpaid_text', async (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const d = db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
    if (!d) return send(res, 404, { ok:false, error:'unknown_uuid' });

    const inst = getInstanceById(db, d.instance_id);
    if (!inst?.public_ip) return send(res, 409, { ok:false, error:'no_instance_allocated' });

    const lang = getDeliveryLang(d);
    const prompts = loadWaPrompts(lang) || loadWaPrompts('en') || {};
    const welcome = prompts.welcome_unpaid;
    if (!welcome) return send(res, 404, { ok:false, error:'welcome_unpaid_missing', lang });

    // Pay link (in-process; no HTTP self-calls)
    let payShortLink = '';
    try {
      const r = await ensurePayShortlinkForUuid(db, uuid);
      if (r?.payUrl) payShortLink = String(r.payUrl);
    } catch {
      // Fallback: reuse an existing unexpired shortlink if present (never blank when possible)
      try {
        const row = db.prepare(`SELECT code, expires_at FROM shortlinks WHERE provision_uuid=? AND kind='stripe_checkout' ORDER BY created_at DESC LIMIT 1`).get(uuid);
        const now = Date.now();
        if (row?.code && (!row.expires_at || Date.parse(row.expires_at) > now)) {
          payShortLink = baseUrlForShortlinks() + row.code;
        }
      } catch {}
    }

    // Specs (best-effort). Never allow blanks; hard-fallback to default 2/2/40.
    let cpu = '?', ram_gb = '?', disk_gb = '?';
    try {
      const specs = readInstanceSpecsBestEffort(inst);
      cpu = String(specs.cpu || '').trim() || '?';
      ram_gb = String(specs.ram_gb || '').trim() || '?';
      disk_gb = String(specs.disk_gb || '').trim() || '?';
    } catch {}

    if (cpu === '?' || ram_gb === '?' || disk_gb === '?') {
      try {
        const sr = poolSsh(inst, `set -euo pipefail; `
          + `CPU=$(nproc 2>/dev/null || echo '?'); `
          + `RAM=$(free -m 2>/dev/null | awk '/Mem:/{printf "%.0f", $2/1024}' || echo '?'); `
          + `DISK=$(df -BG / 2>/dev/null | awk 'NR==2{gsub(/G/,"",$2); print $2}' || echo '?'); `
          + `echo "${CPU} ${RAM} ${DISK}"`,
          { timeoutMs: 6000, tty: false, retries: 0 }
        );
        const parts = String(sr.stdout||'').trim().split(/\s+/);
        if (parts[0] && cpu === '?') cpu = parts[0];
        if (parts[1] && ram_gb === '?') ram_gb = parts[1];
        if (parts[2] && disk_gb === '?') disk_gb = parts[2];
      } catch {}
    }

    if (cpu === '?') cpu = '2';
    if (ram_gb === '?') ram_gb = '2';
    if (disk_gb === '?') disk_gb = '40';

    let openclawVersion='';
    try {
      const vr = poolSsh(inst, `openclaw --version 2>/dev/null || true`, { timeoutMs: 6000, tty: false, retries: 0 });
      openclawVersion = String(vr.stdout||'').trim();
    } catch {}

    const pLink = `https://p.bothook.me/p/${encodeURIComponent(uuid)}?lang=${encodeURIComponent(lang || 'en')}`;

    const msg = renderTpl(welcome, {
      uuid,
      region: inst.region || '',
      public_ip: inst.public_ip || '',
      cpu,
      ram_gb,
      disk_gb,
      openclaw_version: openclawVersion,
      p_link: pLink,
      pay_countdown_minutes: 15,
      pay_short_link: payShortLink
    });

    return send(res, 200, { ok:true, uuid, lang, text: msg });
  } catch (e) {
    return send(res, 500, { ok:false, error: e?.message || 'server_error' });
  }
});

app.get('/api/wa/status', async (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok: false, error: 'uuid_required' });

    const { db } = openDb();
    const delivery = db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
    if (!delivery) return send(res, 404, { ok: false, error: 'unknown_uuid' });

    const instance = getInstanceById(db, delivery.instance_id);

    // FAST PATH: once bound, do not do any SSH probing. The UI should move on immediately.
    if (String(delivery.status || '') === 'BOUND_UNPAID' && delivery.wa_jid) {
      return send(res, 200, {
        ok: true,
        uuid,
        status: 'BOUND_UNPAID',
        instance_id: delivery.instance_id || null,
        connected: true,
        wa_jid: delivery.wa_jid,
        bound_at: delivery.bound_at || null,
      });
    }

    // FAST PATH: do not block HTTP on SSH/tmux probes.
    // UI should poll /api/wa/qr for QR availability; /api/wa/status is used mainly to observe bind completion.
    let connected = Boolean(delivery?.wa_jid);
    let waJid = delivery?.wa_jid || null;

    // Probe (sync, bounded): discover JID from creds.json and bind.
    // This is required for the web UI to reflect scan success promptly.
    if (!waJid && instance?.public_ip) {
      try {
        const pr = poolSsh(
          instance,
          `set -euo pipefail; python3 -c "import os,json; p='/home/ubuntu/.openclaw/credentials/whatsapp/default/creds.json'; j=(json.load(open(p)) if os.path.exists(p) else {}); me=(j.get('me') or {}); print(me.get('id') or me.get('jid') or '')"`,
          { timeoutMs: 6000, tty: false, retries: 0 }
        );
        const jid = String(pr.stdout || '').trim();
        if (jid) {
          const ts = nowIso();
          const current = db.prepare('SELECT wa_jid, meta_json FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
          if (!current?.wa_jid) {
            const boundUnpaidExpiresAt = new Date(Date.parse(ts) + 15*60*1000).toISOString();
            const meta2 = mergeMeta(current?.meta_json || delivery.meta_json, { bound_unpaid_expires_at: boundUnpaidExpiresAt, qr_done_at: ts });
            db.exec('BEGIN IMMEDIATE');
            try {
              db.prepare('UPDATE deliveries SET status=?, wa_jid=?, bound_at=?, updated_at=?, meta_json=? WHERE delivery_id=?')
                .run('BOUND_UNPAID', jid, ts, ts, meta2, delivery.delivery_id);
              // Mark QR as done for this QR session (prevents UI from staying in linking after scan).
              try {
                const cur2 = db.prepare('SELECT meta_json FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
                const m2 = jsonMeta(cur2?.meta_json || meta2) || {};
                const qrGenAt2 = m2.qr_generated_at ? Date.parse(m2.qr_generated_at) : null;
                const qrDoneAt2 = m2.qr_done_at ? Date.parse(m2.qr_done_at) : null;
                if (qrGenAt2 && (!qrDoneAt2 || qrDoneAt2 < qrGenAt2)) {
                  const meta3 = mergeMeta(cur2?.meta_json || meta2, { qr_done_at: ts });
                  db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta3, ts, delivery.delivery_id);
                }
              } catch {}

              db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
                crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'UUID_BOUND', JSON.stringify({ uuid, wa_jid: jid, instance_id: instance.instance_id })
              );
              try {
                db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
                  crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'WA_LINKED', JSON.stringify({ uuid, wa_jid: jid, instance_id: instance.instance_id })
                );
              } catch {}

              // Proactively schedule full welcome on the instance (do NOT wait for user to send a ping).
              // The plugin will retry until WhatsApp is actually connected.
              try {
                const rr = scheduleAutoreplyFullWelcomeOnInstance(instance, { uuid, delayMs: 15_000 });
                if (rr?.ok) {
                  recordDeliveryEventBestEffort(db, delivery.delivery_id, 'WELCOME_SCHEDULED', { uuid, instance_id: instance.instance_id, via: 'wa_status', delay_ms: 15_000 });
                } else {
                  recordDeliveryEventBestEffort(db, delivery.delivery_id, 'WELCOME_SCHEDULE_FAILED', { uuid, instance_id: instance.instance_id, via: 'wa_status', delay_ms: 15_000, code: rr?.code ?? null, detail: rr?.detail ?? null });
                  kickWelcomeScheduleRetries(uuid, { maxWindowMs: 120_000 });
                }
              } catch {}

              db.exec('COMMIT');
              waJid = jid;
              connected = true;
            } catch {
              try { db.exec('ROLLBACK'); } catch {}
            }
          } else {
            waJid = current.wa_jid;
            connected = true;
          }
        }
      } catch {}
    }

    // If connected: bind UUID to WhatsApp identity (prevents relink takeover)
    // IMPORTANT: Only bind when we can read the self JID from status/creds.
    if (connected && waJid) {
      const ts = nowIso();

      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare('SELECT wa_jid FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
        const bound = current?.wa_jid;

        if (!bound && waJid) {
          const boundUnpaidExpiresAt = new Date(Date.parse(ts) + 15*60*1000).toISOString();
          // Mark QR as completed for UI; client should hide/close QR once bound.
          const meta2 = mergeMeta(delivery.meta_json, { bound_unpaid_expires_at: boundUnpaidExpiresAt, qr_done_at: ts });
          db.prepare('UPDATE deliveries SET status=?, wa_jid=?, bound_at=?, updated_at=?, meta_json=? WHERE delivery_id=?')
            .run('BOUND_UNPAID', waJid, ts, ts, meta2, delivery.delivery_id);
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'UUID_BOUND', JSON.stringify({ uuid, wa_jid: waJid, instance_id: instance.instance_id })
          );
          // Funnel: record a normalized linked event (once per bound).
          try {
            db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
              crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'WA_LINKED', JSON.stringify({ uuid, wa_jid: waJid, instance_id: instance.instance_id })
            );
          } catch {}

          // Proactively schedule full welcome on the instance (do NOT wait for user to send a ping).
          // The plugin will retry until WhatsApp is actually connected.
          try {
            const rr = scheduleAutoreplyFullWelcomeOnInstance(instance, { uuid, delayMs: 15_000 });
            if (rr?.ok) {
              recordDeliveryEventBestEffort(db, delivery.delivery_id, 'WELCOME_SCHEDULED', { uuid, instance_id: instance.instance_id, via: 'wa_status', delay_ms: 15_000 });
            } else {
              recordDeliveryEventBestEffort(db, delivery.delivery_id, 'WELCOME_SCHEDULE_FAILED', { uuid, instance_id: instance.instance_id, via: 'wa_status', delay_ms: 15_000, code: rr?.code ?? null, detail: rr?.detail ?? null });
              kickWelcomeScheduleRetries(uuid, { maxWindowMs: 120_000 });
            }
          } catch {}
        } else if (bound && waJid && bound !== waJid) {
          // allow device id change for same number (e.g. :46 -> :47)
          const expectedBase = normalizeWaBase(bound);
          const gotBase = normalizeWaBase(waJid);
          if (expectedBase && gotBase && expectedBase === gotBase) {
            db.prepare('UPDATE deliveries SET wa_jid=?, updated_at=? WHERE delivery_id=?').run(waJid, ts, delivery.delivery_id);
            db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
              crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'UUID_BIND_DEVICE_CHANGED', JSON.stringify({ uuid, expected: bound, got: waJid, base: expectedBase, instance_id: instance.instance_id })
            );
            // Funnel: linked success (device id rotated)
            try {
              db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
                crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'WA_LINKED', JSON.stringify({ uuid, wa_jid: waJid, instance_id: instance.instance_id, rotated: true })
              );
            } catch {}
          } else {
            db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
              crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'UUID_BIND_MISMATCH', JSON.stringify({ uuid, expected: bound, got: waJid, instance_id: instance.instance_id })
            );
            db.exec('COMMIT');
            return send(res, 403, { ok: false, error: 'uuid_bound_to_another_account' });
          }
        } else {
          // Either already bound to same jid, or jid missing.
          // Do NOT downgrade paid state: keep PAID/DELIVERED as the highest-precedence state.
          // IMPORTANT: Do not automatically mark ACTIVE on mere WhatsApp link.
          // Unpaid users must stay in BOUND_UNPAID so the welcome_unpaid / payment flow triggers.
          const row = db.prepare('SELECT status, meta_json FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
          const st = String(row?.status || '');

          // If a row ended up ACTIVE without payment (legacy behavior), self-heal back to BOUND_UNPAID.
          // This ensures welcome_unpaid/payment UX triggers correctly.
          const entitled = deliveryEntitled(db, { ...delivery, status: st, meta_json: row?.meta_json || delivery.meta_json });
          if (!entitled && st === 'ACTIVE' && waJid) {
            const boundUnpaidExpiresAt = new Date(Date.parse(ts) + 15*60*1000).toISOString();
            const meta2 = mergeMeta(row?.meta_json || delivery.meta_json, { bound_unpaid_expires_at: boundUnpaidExpiresAt });
            db.prepare('UPDATE deliveries SET status=?, bound_at=COALESCE(bound_at,?), updated_at=?, meta_json=? WHERE delivery_id=?')
              .run('BOUND_UNPAID', ts, ts, meta2, delivery.delivery_id);
          } else {
            // Otherwise: preserve status and just bump updated_at.
            db.prepare('UPDATE deliveries SET updated_at=? WHERE delivery_id=?').run(ts, delivery.delivery_id);
          }
        }

        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
      }
    }

    // A-mode strict: do NOT claim "connected" unless this UUID is actually bound.
    // Otherwise a previously-linked (dirty) pool machine would appear as linked without scanning.
    let boundJid = null;
    try {
      const row = db.prepare('SELECT wa_jid, status FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
      boundJid = row?.wa_jid || null;


    // If we generated a new QR but qr_done_at is still older, try to detect a fresh scan by checking creds.json mtime.
    // This is bounded and only runs when already bound.
    try {
      const meta0 = jsonMeta(delivery.meta_json) || {};
      const qrGenAt0 = meta0.qr_generated_at ? Date.parse(meta0.qr_generated_at) : null;
      const qrDoneAt0 = meta0.qr_done_at ? Date.parse(meta0.qr_done_at) : null;
      if (boundJid && qrGenAt0 && (!qrDoneAt0 || qrDoneAt0 < qrGenAt0) && instance?.public_ip) {
        const pr = poolSsh(
          instance,
          `set -euo pipefail; p='/home/ubuntu/.openclaw/credentials/whatsapp/default/creds.json'; `
          + `if [ -f "$p" ]; then stat -c %Y "$p" 2>/dev/null || python3 -c "import os;print(int(os.path.getmtime('"'"'$p'"'"')))"; else echo 0; fi`,
          { timeoutMs: 6000, tty: false, retries: 0 }
        );
        const mtimeSec = parseInt(String(pr.stdout||'').trim() || '0', 10);
        const qrGenSec = Math.floor(qrGenAt0 / 1000);
        if (mtimeSec && qrGenSec && mtimeSec >= qrGenSec) {
          const ts = nowIso();
          db.exec('BEGIN IMMEDIATE');
          try {
            const cur = db.prepare('SELECT meta_json FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
            const meta2 = mergeMeta(cur?.meta_json || delivery.meta_json, { qr_done_at: ts });
            db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta2, ts, delivery.delivery_id);
            db.exec('COMMIT');
          } catch { try { db.exec('ROLLBACK'); } catch {} }
        }
      }
    } catch {}
    } catch {}

    // If waJid is unavailable (e.g. gateway not yet reachable), but we have a boundJid and status indicates linked,
    // treat it as connected for UI purposes.
    // Only claim connected for the CURRENT QR session.
    // If a delivery was previously bound (wa_jid exists) but we generated a NEW QR (qr_generated_at),
    // the UI must not jump to "linked" unless we have qr_done_at >= qr_generated_at.
    let claimConnected = Boolean(boundJid);
    try {
      const rowm = db.prepare('SELECT meta_json FROM deliveries WHERE delivery_id=?').get(delivery.delivery_id);
      const meta = jsonMeta(rowm?.meta_json || delivery.meta_json) || {};
      const qrGenAt = meta.qr_generated_at ? Date.parse(meta.qr_generated_at) : null;
      const qrDoneAt = meta.qr_done_at ? Date.parse(meta.qr_done_at) : null;
      if (qrGenAt && qrDoneAt && qrDoneAt < qrGenAt) claimConnected = false;
      if (qrGenAt && (qrDoneAt == null)) claimConnected = false;
    } catch {}




    // user-machine status override: if the pool machine reports WhatsApp not linked/connected, do not claim connected.
    try {
      const meta0 = jsonMeta(delivery.meta_json) || {};
      const qrGenAt0 = meta0.qr_generated_at ? Date.parse(meta0.qr_generated_at) : null;
      const recent = qrGenAt0 && (Date.now() - qrGenAt0) < 20*60*1000;
      if (boundJid && recent && instance?.public_ip) {
        const rr = await poolFetch(instance, `/api/wa/status?uuid=${encodeURIComponent(uuid)}`, { method:'GET', timeoutMs: 2200 });
        const um = rr?.json || {};
        const umConnected = (typeof um.connected === 'boolean') ? um.connected : null;
        const umErr = String(um.lastError || '');
        if (umConnected === false || umErr === 'not linked') {
          // The provision server's session map can go idle (no active QR), causing false negatives.
          // Double-check via `openclaw channels status --probe --json` over SSH before clearing boundJid.
          let trulyConnected = false;
          try {
            const sr = poolSsh(instance, `openclaw channels status --probe --json 2>/dev/null || true`, { timeoutMs: 3500, tty: false, retries: 0 });
            const raw0 = String(sr.stdout || '').trim();
            if (raw0) {
              // `openclaw ... --json` may include plugin banner lines before the JSON.
              const i = raw0.indexOf('{');
              const raw = i >= 0 ? raw0.slice(i) : raw0;
              const j = JSON.parse(raw);
              const w = j?.channels?.whatsapp || null;
              if (w?.connected === true && w?.running === true) trulyConnected = true;
            }
          } catch {}

          if (!trulyConnected) {
            // Force UI to stay in linking state until re-scan.
            boundJid = null;
          }
        }
      }
    } catch {}
    // If linked, restart services and close the tmux login session.
    // NOTE: In DELIVERED mode we converge by keeping provision server OFF by default.
    if (claimConnected) {
      try {
        const tmuxSession = `wa-login-${uuid}`.replace(/[^a-zA-Z0-9_-]/g, '');
        const delivered = String(delivery?.status || '') === 'DELIVERED';
        const meta0 = jsonMeta(delivery?.meta_json) || {};
        const relinkInProgress = delivered && Boolean(meta0.relink_force);

        const cmd = (delivered && !relinkInProgress)
          ? (
              `set -euo pipefail; `
              + `tmux kill-session -t '${tmuxSession}' 2>/dev/null || true; `
              + `sudo systemctl start openclaw-gateway.service 2>/dev/null || true; `
              + `sudo systemctl stop bothook-provision.service 2>/dev/null || true; `
              + `sudo systemctl disable bothook-provision.service 2>/dev/null || true; `
              + `sudo mkdir -p /opt/bothook 2>/dev/null || true; `
              + `sudo touch /opt/bothook/LOGIN_AUTHORITY.control-plane 2>/dev/null || true; `
              + `# Enforce self-chat only (first-link + delivered): never reply to other contacts. `
              + `E164=$(openclaw channels status --probe --json 2>/dev/null | python3 -c "import sys,json; raw=sys.stdin.read(); i=raw.find('{'); j=json.loads(raw[i:]) if i>=0 else {}; w=(j.get('channels') or {}).get('whatsapp') or {}; s=(w.get('self') or {}); print((s.get('e164') or '').strip())" 2>/dev/null || true); `
              + `if [ -n \"$E164\" ]; then E164=\"$E164\" python3 - <<'PY'\nimport json, os\np='/home/ubuntu/.openclaw/openclaw.json'\nj=json.load(open(p))\nwa=j.setdefault('channels',{}).setdefault('whatsapp',{})\nwa['dmPolicy']='allowlist'\nwa['allowFrom']=[os.environ.get('E164','').strip()]\nwa['groupPolicy']='disabled'\njson.dump(j, open(p,'w'), ensure_ascii=False, indent=2)\nPY\n; fi; `
              + `echo services_restarted_delivered`
            )
          : (
              `set -euo pipefail; `
              + `tmux kill-session -t '${tmuxSession}' 2>/dev/null || true; `
              + `sudo rm -f /opt/bothook/LOGIN_AUTHORITY.control-plane 2>/dev/null || true; `
              + `sudo systemctl enable bothook-provision.service 2>/dev/null || true; `
              + `sudo systemctl start bothook-provision.service 2>/dev/null || true; `
              + `sudo systemctl start openclaw-gateway.service 2>/dev/null || true; `
              + `# Enforce self-chat only (first-link + delivered): never reply to other contacts. `
              + `E164=$(openclaw channels status --probe --json 2>/dev/null | python3 -c "import sys,json; raw=sys.stdin.read(); i=raw.find('{'); j=json.loads(raw[i:]) if i>=0 else {}; w=(j.get('channels') or {}).get('whatsapp') or {}; s=(w.get('self') or {}); print((s.get('e164') or '').strip())" 2>/dev/null || true); `
              + `if [ -n \"$E164\" ]; then E164=\"$E164\" python3 - <<'PY'\nimport json, os\np='/home/ubuntu/.openclaw/openclaw.json'\nj=json.load(open(p))\nwa=j.setdefault('channels',{}).setdefault('whatsapp',{})\nwa['dmPolicy']='allowlist'\nwa['allowFrom']=[os.environ.get('E164','').strip()]\nwa['groupPolicy']='disabled'\njson.dump(j, open(p,'w'), ensure_ascii=False, indent=2)\nPY\n; fi; `
              + `echo services_restarted`
            );
        const rr = poolSsh(instance, cmd, { timeoutMs: 20000, tty: false, retries: 0 });
        try {
          // Audit: record whether delivered service convergence + marker write succeeded.
          const out = String(rr?.stdout || rr?.stderr || '').trim();
          const ok = out.includes('services_restarted_delivered') || out.includes('services_restarted');
          const ts = nowIso();
          const et = relinkInProgress
            ? (ok ? 'RELINK_SERVICES_PREPARED' : 'RELINK_SERVICES_PREPARE_FAILED')
            : delivered
              ? (ok ? 'DELIVERED_SERVICES_CONVERGED' : 'DELIVERED_SERVICES_CONVERGE_FAILED')
              : (ok ? 'LINKING_SERVICES_CONVERGED' : 'LINKING_SERVICES_CONVERGE_FAILED');
          const detail = out.replace(/\s+/g, ' ').slice(0, 300);
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), ts, 'delivery', (delivery?.delivery_id || uuid), et,
            JSON.stringify({ uuid, instance_id: instance.instance_id, delivered, relinkInProgress, ok, detail })
          );
        } catch {}
      } catch {}
    }
    // If connected + entitled, self-heal delivered cutover (auth/model/config) and send OpenAI key setup guide.
    try {
      if (claimConnected) {
        // NOTE: /api/wa/status must be fast. Do not block the HTTP response with SSH-heavy operations.
        // Do the self-heal + guide send asynchronously (best-effort).
        setTimeout(async () => {
          try {
            const { db: db2 } = openDb();
            const d2 = db2.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
            if (!d2) return;
            const inst2 = getInstanceById(db2, d2.instance_id);
            if (!inst2?.public_ip) return;

            const lang = getDeliveryLang(d2);
            const prompts = loadWaPrompts(lang) || loadWaPrompts('en') || {};
            const meta = jsonMeta(d2.meta_json) || {};
            const qrGenAt = meta.qr_generated_at ? Date.parse(meta.qr_generated_at) : null;

            // Branch by entitlement:
            // - New user (unpaid): send welcome + Stripe pay shortlink
            // - Paid/relink: self-heal + (only if key missing/invalid) send key guide
            if (!deliveryEntitled(db2, d2)) {
              // Instance-side autoreply already guarantees the full welcome on user inbound messages.
              // Control-plane proactive welcome_unpaid is disabled by default to avoid duplicate/conflicting welcomes.
              const CP_WELCOME_UNPAID = String(process.env.BOTHOOK_CONTROL_PLANE_WELCOME_UNPAID || '0') === '1';
              if (!CP_WELCOME_UNPAID) return;

              // Safety: if a previous bug/misclassification enqueued paid-only guides for an unpaid user,
              // cancel them to avoid sending confusing/wrong instructions.
              try {
                const n = db2.prepare(
                  "DELETE FROM outbound_tasks WHERE provision_uuid=? AND kind='guide_key_paid' AND status IN ('QUEUED','RETRYING')"
                ).run(uuid).changes || 0;
                if (n > 0) {
                  try {
                    db2.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
                      crypto.randomUUID(), nowIso(), 'delivery', d2.delivery_id, 'OUTBOUND_TASK_CANCELED',
                      JSON.stringify({ uuid, kind: 'guide_key_paid', canceled: n, reason: 'not_entitled' })
                    );
                  } catch {}
                }
              } catch {}

              const welcome = prompts.welcome_unpaid;
              const lastSentAt = meta.welcome_unpaid_sent_at ? Date.parse(meta.welcome_unpaid_sent_at) : null;
              const lastAttemptAt = meta.welcome_unpaid_last_attempt_at ? Date.parse(meta.welcome_unpaid_last_attempt_at) : null;

              const shouldSend = (!lastSentAt) || (qrGenAt && lastSentAt && qrGenAt > lastSentAt);
              const shouldRetry = (!lastSentAt) && (!lastAttemptAt || (Date.now() - lastAttemptAt) > 60_000);

              if (welcome && (shouldSend || shouldRetry)) {
                const ts = nowIso();

                // Best-effort self-heal: if WA was just linked but the WhatsApp listener is not yet running/connected
                // (common after pairing/logout conflicts), restart the gateway ONCE per QR generation window.
                try {
                  const metaNow = jsonMeta(d2.meta_json) || {};
                  const lastAutoRestartAt = metaNow.welcome_unpaid_gateway_restart_at ? Date.parse(metaNow.welcome_unpaid_gateway_restart_at) : null;
                  const allowAutoRestart = (!lastAutoRestartAt) || (qrGenAt && lastAutoRestartAt && qrGenAt > lastAutoRestartAt);
                  if (allowAutoRestart) {
                    let needRestart = false;
                    try {
                      const sr = poolSsh(inst2, `openclaw channels status --probe --json 2>/dev/null || true`, { timeoutMs: 6000, tty: false, retries: 0 });
                      const raw = String(sr.stdout || '').trim();
                      if (raw) {
                        const j = JSON.parse(raw);
                        const w = j?.channels?.whatsapp || null;
                        if (!(w?.running === true && w?.connected === true)) needRestart = true;
                      } else {
                        needRestart = true;
                      }
                    } catch { needRestart = true; }

                    if (needRestart) {
                      try {
                        poolSsh(inst2,
                          `set -euo pipefail; sudo systemctl restart openclaw-gateway.service 2>/dev/null || true; sleep 2; echo restarted`,
                          { timeoutMs: 20000, tty: false, retries: 0 }
                        );
                        const meta3 = mergeMeta(d2.meta_json, { welcome_unpaid_gateway_restart_at: ts });
                        db2.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta3, ts, d2.delivery_id);
                        try {
                          db2.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
                            crypto.randomUUID(), ts, 'delivery', d2.delivery_id, 'WA_GATEWAY_AUTO_RESTART',
                            JSON.stringify({ uuid, instance_id: inst2.instance_id, reason: 'welcome_unpaid_probe_failed' })
                          );
                        } catch {}
                      } catch {}
                    }
                  }
                } catch {}

                let payShortLink = '';
                try {
                  const r = await fetch('http://127.0.0.1:18998/api/pay/link', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ uuid })
                  });
                  const t = await r.text();
                  const j = JSON.parse(t);
                  if (j?.ok && j?.payUrl) payShortLink = String(j.payUrl);
                } catch {}

                const pLink = `https://p.bothook.me/p/${encodeURIComponent(uuid)}?lang=${encodeURIComponent(lang || 'en')}`;
                // Best-effort instance specs (avoid leaving {{vars}} unreplaced)
                const specs = readInstanceSpecsBestEffort(inst2);
                // Normalize: never allow empty strings in specs placeholders.
                let cpu = String(specs.cpu || '').trim() || '?';
                let ram_gb = String(specs.ram_gb || '').trim() || '?';
                let disk_gb = String(specs.disk_gb || '').trim() || '?';

                // Fallback: query from the instance directly (fast, best-effort)
                if (cpu === '?' || ram_gb === '?' || disk_gb === '?') {
                  try {
                    const sr = poolSsh(inst2, `set -euo pipefail; `
                      + `CPU=$(nproc 2>/dev/null || echo '?'); `
                      + `RAM=$(free -m 2>/dev/null | awk '/Mem:/{printf "%.0f", $2/1024}' || echo '?'); `
                      + `DISK=$(df -BG / 2>/dev/null | awk 'NR==2{gsub(/G/,"",$2); print $2}' || echo '?'); `
                      + `echo "${CPU} ${RAM} ${DISK}"`,
                      { timeoutMs: 6000, tty: false, retries: 0 }
                    );
                    const parts = String(sr.stdout||'').trim().split(/\s+/);
                    if (parts[0] && cpu === '?') cpu = parts[0];
                    if (parts[1] && ram_gb === '?') ram_gb = parts[1];
                    if (parts[2] && disk_gb === '?') disk_gb = parts[2];
                  } catch {}
                }

                // Hard fallback: align with product default spec when probe is inconclusive.
                // (Prevents blank spec lines in non-English templates.)
                if (cpu === '?') cpu = '2';
                if (ram_gb === '?') ram_gb = '2';
                if (disk_gb === '?') disk_gb = '40';

                let openclawVersion='';
                try {
                  const vr = poolSsh(inst2, `openclaw --version 2>/dev/null || true`, { timeoutMs: 6000, tty: false, retries: 0 });
                  openclawVersion = String(vr.stdout||'').trim();
                } catch {}

                const msg = renderTpl(welcome, {
                  uuid,
                  region: inst2.region || '',
                  public_ip: inst2.public_ip || '',
                  cpu,
                  ram_gb,
                  disk_gb,
                  openclaw_version: openclawVersion,
                  p_link: pLink,
                  pay_countdown_minutes: 15,
                  pay_short_link: payShortLink
                });

                // Ensure autoreply plugin is enabled on the user machine (repeat welcome until paid).
                try { poolSsh(inst2, `openclaw plugins enable bothook-wa-autoreply 2>/dev/null || true`, { timeoutMs: 8000, tty: false, retries: 0 }); } catch {}

                // Enqueue welcome send (worker will do readiness gating + retries).
                try { enqueueOutboundTask(db2, { delivery_id: d2.delivery_id, uuid, instance_id: inst2.instance_id, kind: 'welcome_unpaid', lang, to_jid: d2.wa_jid }); } catch {}
              }
              return;
            }

            // Paid entitlement branch
            // IMPORTANT: keep relink behavior isolated from first-link.
            const isRelink = Boolean(meta?.relink_force);

            if (isRelink) {
              // Relink: do NOT send a "success" message. Control-plane cannot perfectly guarantee end-to-end success,
              // and any extra system message is noisy. Instead, immediately run the same idempotent delivered cutover
              // convergence steps (auth/model/config), then let the user continue chatting normally.
              try { tryCutoverDelivered(db2, uuid, { reason: 'relink_connected' }); } catch {}
              try { writeOpenAiAuthOnInstance(db2, inst2, { uuid }); } catch {}

              // NOTE: do NOT clear relink_force here.
              // Rationale: when the user is still connected, `/api/wa/status` may temporarily claim connected
              // even though a force-relink QR flow is in progress. Clearing relink_force early re-enables
              // DELIVERED convergence which can stop/disable provision and re-touch LOGIN_AUTHORITY,
              // causing the UI to get stuck waiting for QR.
            } else {
              // First-link paid path (or non-force paid connect): keep legacy behavior.
              // Self-heal delivered cutover (auth/model/config). Idempotent.
              // Also forces a fresh key re-check (avoids stale last_check_ok=false from prior transient failures).
              try { tryCutoverDelivered(db2, uuid, { reason: 'relink_connected' }); } catch {}
              try { writeOpenAiAuthOnInstance(db2, inst2, { uuid }); } catch {}
            }

            // Decide whether we need to proactively ask for key.
            // Rule:
            // - If key missing OR last_check_ok=false -> send guide_key_paid.
            // - If last_check_ok=true -> do NOT send guide.
            let keyOk = false;
            try {
              const ks = db2.prepare('SELECT meta_json FROM delivery_secrets WHERE provision_uuid=? AND kind=? LIMIT 1').get(uuid, 'openai_api_key');
              if (ks?.meta_json) {
                const km = JSON.parse(ks.meta_json);
                // Treat as OK when:
                // - explicitly ok, OR
                // - check is inconclusive (null) but we have a previous verified_at and no invalid_at.
                // Treat as OK when:
                // - last_check_ok is explicitly true, OR
                // - we have a previous verified_at and no invalid_at (covers legacy meta that only stored verified_at).
                if (km?.last_check_ok === true) keyOk = true;
                else if (km?.verified_at && !km?.invalid_at && km?.last_check_ok !== false) keyOk = true;
                else keyOk = false;
              } else {
                keyOk = false;
              }
            } catch { keyOk = false; }

            const guide = prompts.guide_key_paid;
            const lastSentAt = meta.guide_key_sent_at ? Date.parse(meta.guide_key_sent_at) : null;
            const lastAttemptAt = meta.guide_key_last_attempt_at ? Date.parse(meta.guide_key_last_attempt_at) : null;

            if (guide && !keyOk) {
              // Send at most once per QR generation, but retry if previous attempts failed.
              const shouldSend = (!lastSentAt) || (qrGenAt && lastSentAt && qrGenAt > lastSentAt);
              const shouldRetry = (!lastSentAt) && (!lastAttemptAt || (Date.now() - lastAttemptAt) > 60_000);
              if (shouldSend || shouldRetry) {
                const ts = nowIso();
                const msg = renderTpl(guide, { uuid });
                // Ensure autoreply plugin is enabled on the user machine.
                try { poolSsh(inst2, `openclaw plugins enable bothook-wa-autoreply 2>/dev/null || true`, { timeoutMs: 8000, tty: false, retries: 0 }); } catch {}

                // Enqueue guide send (worker will do readiness gating + retries).
                try { enqueueOutboundTask(db2, { delivery_id: d2.delivery_id, uuid, instance_id: inst2.instance_id, kind: 'guide_key_paid', lang, to_jid: d2.wa_jid }); } catch {}
              }
            }
          } catch {}
        }, 0);
      }
    } catch {}

    const out = { ok: true, uuid, instance_id: instance.instance_id, status: claimConnected ? 'connected' : 'linking', connected: claimConnected, wa_jid: boundJid || null, lastUpdateAt: nowIso() };
    return send(res, 200, out);
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message || 'server_error' });
  }
});



// Confirm payment (fallback when Stripe webhooks are delayed/misconfigured)
// Called by p-site after redirect: /?paid=1&uuid=...
app.get('/api/pay/confirm', async (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const secret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
    if (!secret) return send(res, 500, { ok:false, error:'stripe_not_configured' });

    const { db } = openDb();
    const delivery = getOrCreateDeliveryForUuid(db, uuid);

    // Find most recent checkout shortlink meta (stores stripe_session_id)
    const sl = db.prepare(`SELECT code, meta_json FROM shortlinks WHERE provision_uuid=? AND kind='stripe_checkout' ORDER BY created_at DESC LIMIT 1`).get(uuid);
    let sessionId = null;
    try { sessionId = sl?.meta_json ? (JSON.parse(sl.meta_json).stripe_session_id || null) : null; } catch { sessionId = null; }
    if (!sessionId) return send(res, 404, { ok:false, error:'stripe_session_not_found' });

    const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`;
    const resp = await fetch(url, { headers: { 'authorization': `Bearer ${secret}` } });
    const text = await resp.text();
    let j; try { j = JSON.parse(text); } catch { j = null; }
    if (!resp.ok) return send(res, 502, { ok:false, error:'stripe_fetch_failed', detail: j || text });

    const paid = String(j?.payment_status || '') === 'paid' || Boolean(j?.status === 'complete');
    const sub = j?.subscription || null;
    const subId = typeof sub === 'string' ? sub : (sub?.id || null);

    if (!paid || !subId) {
      return send(res, 200, { ok:true, uuid, delivery_id: delivery.delivery_id, paid:false, stripe_session_id: sessionId });
    }

    // Upsert subscription snapshot
    const ts = nowIso();
    const status = String((typeof sub === 'object' && sub?.status) ? sub.status : 'active');
    const cpeSec = (typeof sub === 'object' && sub?.current_period_end) ? Number(sub.current_period_end) : 0;
    const cancelAtSec = (typeof sub === 'object' && sub?.cancel_at) ? Number(sub.cancel_at) : 0;
    const cpe = cpeSec ? new Date(cpeSec*1000).toISOString() : null;
    const cancelAt = cancelAtSec ? new Date(cancelAtSec*1000).toISOString() : null;

    db.prepare(`INSERT OR REPLACE INTO subscriptions(provider_sub_id, provider, user_id, plan, status, current_period_end, cancel_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)`).run(
      subId, 'stripe', uuid, 'standard', status, cpe, cancelAt, ts
    );

    // Mark delivery paid (do not jump to DELIVERED; cutover still requires key verified)
    try {
      const row = db.prepare('SELECT status, meta_json FROM deliveries WHERE provision_uuid=?').get(uuid);
      const meta2 = mergeMeta(row?.meta_json || null, { paid_confirmed_at: ts, paid_confirmed_via: 'pay_confirm' });
      db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE provision_uuid=?').run('PAID', ts, meta2, uuid);
    } catch {}

    // Funnel event
    try {
      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'PAYMENT_PAID', JSON.stringify({ uuid, provider_sub_id: subId, via:'pay_confirm' })
      );
    } catch {}

    // Proactively trigger onboarding/cutover messaging immediately after payment.
    // (0) Write a paid marker onto the user machine for offline autoreply fallback.
    try {
      const d2m = getDeliveryByUuid(db, uuid);
      if (d2m?.instance_id) {
        const instm = getInstanceById(db, d2m.instance_id);
        if (instm?.public_ip) {
          // best-effort; do not block pay confirm
          poolSsh(instm, `sudo mkdir -p /opt/bothook/evidence && echo ${JSON.stringify(ts)} | sudo tee /opt/bothook/evidence/paid >/dev/null && sudo chmod 644 /opt/bothook/evidence/paid`, { timeoutMs: 8000, tty:false, retries:0 });
        }
      }
    } catch {}

    // (1) Kick the status endpoint (best-effort)
    try { await fetch(`http://127.0.0.1:18998/api/wa/status?uuid=${encodeURIComponent(uuid)}`); } catch {}

    // (2) Also push guide_key_paid directly (best-effort) so the user sees it without sending a message.
    // Fire-and-forget: keep this endpoint fast.
    setTimeout(() => {
      try {
        const d2 = getDeliveryByUuid(db, uuid);
        if (!d2?.instance_id || !d2?.wa_jid) return;
        const inst2 = getInstanceById(db, d2.instance_id);
        if (!inst2?.public_ip) return;

        // If key already verified, don't send guide.
        let keyVerified = false;
        try {
          const ks = db.prepare('SELECT meta_json FROM delivery_secrets WHERE provision_uuid=? AND kind=? LIMIT 1').get(String(uuid), 'openai_api_key');
          if (ks?.meta_json) {
            const km = JSON.parse(ks.meta_json);
            keyVerified = Boolean(km?.verified_at) && !km?.invalid_at;
          }
        } catch { keyVerified = false; }
        if (keyVerified) return;

        const ts2 = nowIso();
        const lang = getDeliveryLang(d2);
        // Enqueue guide send (worker will do readiness gating + retries).
        try { enqueueOutboundTask(db, { delivery_id: d2.delivery_id, uuid: String(uuid), instance_id: inst2.instance_id, kind: 'guide_key_paid', lang, to_jid: d2.wa_jid }); } catch {}

        // Persist meta that we attempted to enqueue (best-effort)
        try {
          const meta2 = mergeMeta(d2.meta_json, { guide_key_enqueued_at: ts2, guide_key_lang: lang, guide_key_sent_via: 'pay_confirm' });
          db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta2, ts2, d2.delivery_id);
        } catch {}
      } catch {}
    }, 0);

    return send(res, 200, { ok:true, uuid, delivery_id: delivery.delivery_id, paid:true, provider_sub_id: subId });
  } catch (e) {
    return send(res, 500, { ok:false, error: e.message || 'server_error' });
  }
});

async function ensurePayShortlinkForUuid(db, uuid) {
  // Returns: { payUrl, expiresAt, delivery_id }
  // IMPORTANT: do not call back into HTTP (self-fetch); keep it in-process to avoid intermittent deadlocks/timeouts.
  const delivery = getOrCreateDeliveryForUuid(db, uuid);

  const now = Date.now();
  const expiresAt = new Date(now + 15*60*1000).toISOString();
  const lockKey = `stripe_checkout:${uuid}`;
  const ts = nowIso();

  // Best-effort lock (idempotency)
  try {
    db.exec('BEGIN IMMEDIATE');
    tryAcquireShortlinkLock(db, lockKey, ts);
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch {}
  }

  // Reuse existing unexpired link if present
  const existing = db.prepare(
    `SELECT code, expires_at FROM shortlinks WHERE provision_uuid=? AND kind='stripe_checkout' ORDER BY created_at DESC LIMIT 1`
  ).get(uuid);
  if (existing?.code && (!existing.expires_at || Date.parse(existing.expires_at) > now)) {
    try { setShortlinkLockCode(db, lockKey, existing.code); } catch {}
    return { payUrl: baseUrlForShortlinks() + existing.code, expiresAt: existing.expires_at || expiresAt, delivery_id: delivery.delivery_id };
  }

  // Otherwise create a new Stripe checkout + shortlink
  const checkout = await createStripeCheckout({ uuid, delivery_id: delivery.delivery_id });

  let code;
  for (let i=0;i<5;i++){
    const c = randCode(7);
    const used = db.prepare('SELECT 1 FROM shortlinks WHERE code=?').get(c);
    if (!used) { code = c; break; }
  }
  if (!code) throw new Error('shortlink_code_exhausted');

  const ts2 = nowIso();
  upsertShortlink(db, {
    code,
    long_url: checkout.url,
    created_at: ts2,
    expires_at: expiresAt,
    kind: 'stripe_checkout',
    delivery_id: delivery.delivery_id,
    provision_uuid: uuid,
    meta: { stripe_session_id: checkout.id },
  });

  try { setShortlinkLockCode(db, lockKey, code); } catch {}

  try {
    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
      crypto.randomUUID(), ts2, 'delivery', delivery.delivery_id, 'PAY_LINK_CREATED', JSON.stringify({ uuid, code, expires_at: expiresAt })
    );
    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
      crypto.randomUUID(), ts2, 'delivery', delivery.delivery_id, 'PAY_OPEN', JSON.stringify({ uuid, delivery_id: delivery.delivery_id, mode: 'created', attr: getAttributionForUuid(db, uuid) })
    );
  } catch {}

  return { payUrl: baseUrlForShortlinks() + code, expiresAt, delivery_id: delivery.delivery_id };
}

// Create payment shortlink (Stripe checkout)
app.post('/api/pay/link', async (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const r = await ensurePayShortlinkForUuid(db, uuid);
    return send(res, 200, { ok:true, uuid, delivery_id: r.delivery_id, payUrl: r.payUrl, expiresAt: r.expiresAt });
  } catch (e) {
    return send(res, e.statusCode || 500, { ok:false, error: e.message || 'server_error', detail: e.detail });
  }
});

// Shortlink redirect
app.get('/s/:code', (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(404).type('text/plain').send('not found');
    const { db } = openDb();
    const row = db.prepare('SELECT long_url, expires_at FROM shortlinks WHERE code=? LIMIT 1').get(code);
    if (!row?.long_url) return res.status(404).type('text/plain').send('not found');
    if (row.expires_at) {
      const t = Date.parse(row.expires_at);
      if (!isNaN(t) && Date.now() > t) return res.status(410).type('text/plain').send('expired');
    }
    res.setHeader('cache-control','no-store');
    return res.redirect(302, row.long_url);
  } catch (e) {
    return res.status(500).type('text/plain').send('error');
  }
});



// Stripe webhook (authoritative payment events)
app.post('/api/stripe/webhook', async (req, res) => {
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    const sig = req.headers['stripe-signature'];
    const rawBody = req.rawBody;

    // Observability: record webhook hits and bad signatures (no sensitive payload stored).
    // This helps diagnose misrouted webhooks / wrong secrets quickly.
    try {
      const { db } = openDb();
      const ts0 = nowIso();
      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), ts0, 'stripe', 'webhook', 'STRIPE_WEBHOOK_HIT',
        JSON.stringify({ ts: ts0, has_sig: Boolean(sig), raw_len: rawBody ? Buffer.byteLength(String(rawBody)) : 0 })
      );
    } catch {}

    const v = verifyStripeSignature({ rawBody, sigHeader: sig, secret });
    if (!v.ok) {
      try {
        const { db } = openDb();
        const ts1 = nowIso();
        db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
          crypto.randomUUID(), ts1, 'stripe', 'webhook', 'STRIPE_WEBHOOK_BAD_SIG',
          JSON.stringify({ ts: ts1, has_sig: Boolean(sig), raw_len: rawBody ? Buffer.byteLength(String(rawBody)) : 0 })
        );
      } catch {}
      return res.status(400).type('text/plain').send('bad signature');
    }

    const evt = req.body;
    const ts = nowIso();

    const { db } = openDb();

    const type = evt?.type || 'unknown';
    const obj = evt?.data?.object || null;

    // Extract metadata we set on checkout sessions
    const md = obj?.metadata || {};
    const uuid = md?.provision_uuid || null;
    const delivery_id = md?.delivery_id || null;

    // Always write raw event (dedupe by event id)
    const eventId = String(evt?.id || crypto.randomUUID());
    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
      eventId, ts, 'stripe', eventId, type, JSON.stringify({ uuid, delivery_id, object: obj })
    );

    // Attribution snapshot (best-effort): join by uuid when available.
    // Ensure table exists (created lazily to avoid schema migrations).
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS attributions (
        uuid TEXT PRIMARY KEY,
        first_ts TEXT,
        last_ts TEXT,
        payload_json TEXT
      )`);
    } catch {}

    const getAttr = (u) => {
      try {
        if (!u) return null;
        // 1) uuid-level attribution
        const r = db.prepare('SELECT payload_json FROM attributions WHERE uuid=? LIMIT 1').get(String(u));
        if (r?.payload_json) return JSON.parse(r.payload_json);
        // 2) fallback: uuid -> vid mapping -> vid attribution (captures main-site first touch)
        const m = db.prepare('SELECT vid FROM uuid_vid_map WHERE uuid=? LIMIT 1').get(String(u));
        const vid = m?.vid ? String(m.vid) : '';
        if (!vid) return null;
        const v = db.prepare('SELECT payload_json FROM vid_attributions WHERE vid=? LIMIT 1').get(vid);
        return v?.payload_json ? JSON.parse(v.payload_json) : null;
      } catch { return null; }
    };

    // Offline conversion upload (Google Ads) for PAYMENT_PAID (best-effort)
    // This enables keyword-level淘汰机制 based on paid conversions.
    function fmtDateTimeInTz(d, timeZone) {
      const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).formatToParts(d);
      const get = (t) => parts.find(p => p.type === t)?.value;
      return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
    }

    async function uploadPaidConversionBestEffort({ uuid, delivery_id, paid_at_iso, attr }) {
      try {
        const gclid = attr?.click?.gclid || attr?.gclid || null;
        if (!gclid) return { ok:false, reason:'missing_gclid' };

        let policy = null;
        try { policy = JSON.parse(fs.readFileSync('/home/ubuntu/.openclaw/workspace/growth/ads_policy_v0.1.json','utf8')); } catch { policy = null; }
        const convAction = policy?.googleAds?.conversionActions?.paymentPaid;
        if (!convAction) return { ok:false, reason:'missing_conversion_action' };

        // Mint access token
        const creds = (()=>{ try {
          const txt = fs.readFileSync('/home/ubuntu/.openclaw/credentials/google_ads.env','utf8');
          const env={};
          for(const line of txt.split(/\r?\n/)){
            if(!line||line.trim().startsWith('#')) continue;
            const idx=line.indexOf('=');
            if(idx<0) continue;
            env[line.slice(0,idx)] = line.slice(idx+1);
          }
          return env;
        } catch { return {}; }})();

        const mcc = policy?.googleAds?.mccCustomerId;
        const customerId = policy?.googleAds?.clientCustomerId;
        const developerToken = creds.GOOGLE_ADS_DEVELOPER_TOKEN;
        if (!mcc || !customerId || !developerToken) return { ok:false, reason:'missing_ads_creds' };

        const params = new URLSearchParams({
          client_id: creds.GOOGLE_ADS_CLIENT_ID,
          client_secret: creds.GOOGLE_ADS_CLIENT_SECRET,
          refresh_token: creds.GOOGLE_ADS_REFRESH_TOKEN,
          grant_type: 'refresh_token'
        });
        const tokRes = await fetch('https://oauth2.googleapis.com/token', { method:'POST', body: params });
        const tok = await tokRes.json();
        if (!tokRes.ok) return { ok:false, reason:'oauth_failed' };
        const accessToken = tok.access_token;

        const timeZone = policy?.googleAds?.timeZone || 'Asia/Singapore';
        const dt = paid_at_iso ? new Date(paid_at_iso) : new Date();
        const convDateTime = fmtDateTimeInTz(dt, timeZone) + '+00:00';

        const url = `https://googleads.googleapis.com/v20/customers/${customerId}:uploadClickConversions`;
        const headers = {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'login-customer-id': String(mcc),
          'Content-Type': 'application/json'
        };
        const body = {
          partialFailure: true,
          conversions: [
            {
              gclid,
              conversionAction: convAction,
              conversionDateTime: convDateTime,
              conversionValue: 1.0,
              currencyCode: 'SGD',
              orderId: String(delivery_id || uuid || '')
            }
          ]
        };

        const res = await fetch(url, { method:'POST', headers, body: JSON.stringify(body) });
        const text = await res.text();
        let j = null;
        try { j = text ? JSON.parse(text) : null; } catch { j = { _raw: text }; }
        return { ok: res.ok, status: res.status, resp: j };
      } catch (e) {
        return { ok:false, reason:'exception' };
      }
    }

    // Minimal state transitions
    if (type === 'checkout.session.completed') {
      // Mark delivery paid (MVP)
      if (delivery_id) {
        // Preserve existing meta and record paid timestamp for audit.
        const row = db.prepare('SELECT meta_json FROM deliveries WHERE delivery_id=?').get(delivery_id);
        const meta2 = mergeMeta(row?.meta_json || null, { paid_at: ts, stripe_event_id: eventId });
        db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE delivery_id=?').run('PAID', ts, meta2, delivery_id);
        db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
          crypto.randomUUID(), ts, 'delivery', delivery_id, 'PAYMENT_CONFIRMED', JSON.stringify({ uuid, stripe_event_id: eventId })
        );
        // Normalized funnel event
        const attrSnap = getAttr(uuid);
        db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
          crypto.randomUUID(), ts, 'delivery', delivery_id, 'PAYMENT_PAID', JSON.stringify({ uuid, delivery_id, stripe_event_id: eventId, attr: attrSnap })
        );

        // Subscription upsert (needed by /api/p/state to show plan/status/ends_at)
        // NOTE: checkout.session.completed may arrive before invoice.paid; we still want a row keyed by provider_sub_id.
        try {
          const subId = obj?.subscription || null;
          if (subId) {
            db.prepare(
              `INSERT INTO subscriptions(provider_sub_id, provider, user_id, plan, status, current_period_end, cancel_at, canceled_at, ended_at, cancel_at_period_end, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(provider_sub_id) DO UPDATE SET
                 status=excluded.status,
                 user_id=excluded.user_id,
                 plan=excluded.plan,
                 updated_at=excluded.updated_at`
            ).run(String(subId), 'stripe', String(uuid), 'standard', 'active', null, null, null, null, 0, ts, ts);

            // Best-effort: refresh period end timestamps from Stripe subscription object.
            setTimeout(async () => {
              try {
                const secret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
                if (!secret) return;
                const resp = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(String(subId))}`, {
                  headers: { authorization: `Bearer ${secret}` }
                });
                const sj = await resp.json().catch(()=>null);
                if (!resp.ok || !sj) return;
                const unixToIso = (u) => {
                  if (!u) return null;
                  const n = Number(u);
                  if (!Number.isFinite(n) || n <= 0) return null;
                  return new Date(n * 1000).toISOString();
                };

                // Some Stripe responses (observed) may omit current_period_end/start even when active.
                // Fallback: derive from latest_invoice.lines[0].period.
                let cpe = sj.current_period_end;
                if (!cpe) {
                  try {
                    const lines = sj?.latest_invoice?.lines?.data || [];
                    const per = lines?.[0]?.period || null;
                    if (per?.end) cpe = per.end;
                  } catch {}
                }

                const ts2 = nowIso();
                db.prepare(
                  `UPDATE subscriptions SET status=?, current_period_end=COALESCE(?, current_period_end), cancel_at=COALESCE(?, cancel_at), canceled_at=COALESCE(?, canceled_at), ended_at=COALESCE(?, ended_at), cancel_at_period_end=?, updated_at=? WHERE provider_sub_id=? AND provider='stripe'`
                ).run(
                  String(sj.status || 'active'),
                  unixToIso(cpe),
                  unixToIso(sj.cancel_at),
                  unixToIso(sj.canceled_at),
                  unixToIso(sj.ended_at),
                  sj.cancel_at_period_end ? 1 : 0,
                  ts2,
                  String(subId)
                );
              } catch {}
            }, 0);
          }
        } catch (e) {
          try {
            db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
              crypto.randomUUID(), ts, 'delivery', delivery_id, 'SUB_UPSERT_FAILED',
              JSON.stringify({ uuid, delivery_id, stripe_event_id: eventId, error: String(e?.message || e).slice(0,200) })
            );
          } catch {}
        }

        // Best-effort: persist gclid snapshot to delivery meta for later audits.
        try {
          const gclid = attrSnap?.click?.gclid || attrSnap?.gclid || null;
          if (gclid) {
            const row2 = db.prepare('SELECT meta_json FROM deliveries WHERE delivery_id=?').get(delivery_id);
            const meta3 = mergeMeta(row2?.meta_json || null, { ads_gclid: String(gclid), ads_paid_at: ts });
            db.prepare('UPDATE deliveries SET meta_json=? WHERE delivery_id=?').run(meta3, delivery_id);
          }
        } catch {}

        // If linked but key not yet verified: enqueue key setup guide immediately (even if user sends no messages).
        // Use outbound_tasks queue for gating + retries (more reliable than direct send in webhook).
        try {
          const d2 = getDeliveryByUuid(db, String(uuid));
          if (d2?.instance_id && d2?.wa_jid) {
            const lang = getDeliveryLang(d2);
            enqueueOutboundTask(db, { delivery_id: d2.delivery_id, uuid: String(uuid), instance_id: d2.instance_id, kind: 'guide_key_paid', lang, to_jid: d2.wa_jid });
            const ts2 = nowIso();
            const meta2 = mergeMeta(d2.meta_json, { guide_key_enqueued_at: ts2, guide_key_lang: lang, guide_key_enqueued_via: 'stripe_webhook' });
            db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta2, ts2, d2.delivery_id);
          }
        } catch {}

        // Best-effort: upload offline conversion to Google Ads for keyword-level淘汰机制.
        // Fire-and-forget to keep webhook fast.
        setTimeout(() => {
          uploadPaidConversionBestEffort({ uuid, delivery_id, paid_at_iso: ts, attr: attrSnap })
            .then((r) => {
              try {
                const ok = Boolean(r?.ok);
                const reason = r?.reason || null;
                db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
                  crypto.randomUUID(), nowIso(), 'delivery', delivery_id, 'ADS_OFFLINE_CONVERSION_UPLOAD',
                  JSON.stringify({ ok, status: r?.status || null, reason, has_gclid: Boolean(attrSnap?.click?.gclid || attrSnap?.gclid || null) })
                );

                // Self-check alert event (for Telegram reporter / dashboards): if paid occurred but upload failed or gclid missing.
                if (!ok) {
                  db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
                    crypto.randomUUID(), nowIso(), 'delivery', delivery_id, 'ADS_OFFLINE_CONVERSION_UPLOAD_WARN',
                    JSON.stringify({ uuid, delivery_id, ok:false, reason: reason || 'upload_failed', has_gclid: Boolean(attrSnap?.click?.gclid || attrSnap?.gclid || null) })
                  );
                }
              } catch {}
            })
            .catch(() => {
              try {
                db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
                  crypto.randomUUID(), nowIso(), 'delivery', delivery_id, 'ADS_OFFLINE_CONVERSION_UPLOAD_WARN',
                  JSON.stringify({ uuid, delivery_id, ok:false, reason: 'exception', has_gclid: Boolean(attrSnap?.click?.gclid || attrSnap?.gclid || null) })
                );
              } catch {}
            });
        }, 0);
        // If key already verified + linked, cutover now.
        try { tryCutoverDelivered(db, uuid, { reason: 'payment_confirmed' }); } catch {}

        // If linked but key not yet verified: proactively send key setup guide immediately.
        // (Control-plane learns payment first; do not wait for the user to send a message.)
        // Fire-and-forget to keep webhook fast.
        if (uuid) {
          setTimeout(() => {
            try {
              const d2 = getDeliveryByUuid(db, String(uuid));
              if (!d2?.instance_id || !d2?.wa_jid) return; // must be linked
              const inst2 = getInstanceById(db, d2.instance_id);
              if (!inst2?.public_ip) return;

              // Check key verified
              let keyVerified = false;
              try {
                const ks = db.prepare('SELECT meta_json FROM delivery_secrets WHERE provision_uuid=? AND kind=? LIMIT 1').get(String(uuid), 'openai_api_key');
                if (ks?.meta_json) {
                  const km = JSON.parse(ks.meta_json);
                  keyVerified = Boolean(km?.verified_at) && !km?.invalid_at;
                }
              } catch { keyVerified = false; }
              if (keyVerified) return;

              // Idempotency: avoid spamming if already sent after this payment.
              const ts2 = nowIso();
              let meta = {};
              try { meta = d2.meta_json ? JSON.parse(d2.meta_json) : {}; } catch { meta = {}; }
              const paidAt = meta.paid_at ? Date.parse(meta.paid_at) : null;
              const guideSentAt = meta.guide_key_sent_at ? Date.parse(meta.guide_key_sent_at) : null;
              if (guideSentAt && (!paidAt || guideSentAt >= paidAt)) return;

              const lang = getDeliveryLang(d2);
              const prompts = loadWaPrompts(lang) || loadWaPrompts('en') || {};
              const guide = prompts.guide_key_paid;
              if (!guide) return;

              const msg = renderTpl(guide, { uuid: String(uuid) });
              const rr2 = sendSelfChatOnInstance(inst2, msg);
              const ok = (rr2.code ?? 1) === 0;
              const patch = ok
                ? { guide_key_sent_at: ts2, guide_key_lang: lang, guide_key_send_ok: true, guide_key_sent_via: 'stripe_webhook' }
                : { guide_key_last_attempt_at: ts2, guide_key_lang: lang, guide_key_send_ok: false, guide_key_sent_via: 'stripe_webhook' };
              const meta2 = mergeMeta(d2.meta_json, patch);
              try { db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta2, ts2, d2.delivery_id); } catch {}
            } catch {}
          }, 0);
        }
      }
    }

    // Subscription lifecycle events (minimal)
    try {
      const upsertSub = db.prepare(
        `INSERT INTO subscriptions(provider_sub_id, provider, user_id, plan, status, current_period_end, cancel_at, canceled_at, ended_at, cancel_at_period_end, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(provider_sub_id) DO UPDATE SET
           status=excluded.status,
           current_period_end=COALESCE(excluded.current_period_end, subscriptions.current_period_end),
           cancel_at=COALESCE(excluded.cancel_at, subscriptions.cancel_at),
           canceled_at=COALESCE(excluded.canceled_at, subscriptions.canceled_at),
           ended_at=COALESCE(excluded.ended_at, subscriptions.ended_at),
           cancel_at_period_end=excluded.cancel_at_period_end,
           updated_at=excluded.updated_at`
      );

      const unixToIso = (u) => {
        if (!u) return null;
        const n = Number(u);
        if (!Number.isFinite(n) || n <= 0) return null;
        return new Date(n * 1000).toISOString();
      };

      // Helpers: map subscription id -> uuid (user_id)
      const findUuidBySubId = (subId) => {
        try {
          const row = db.prepare('SELECT user_id FROM subscriptions WHERE provider_sub_id=? AND provider=? LIMIT 1').get(String(subId||''), 'stripe');
          return row?.user_id || null;
        } catch { return null; }
      };

      const type2 = String(type || '');
      if (type2 === 'invoice.paid' || type2 === 'invoice.payment_failed') {
        const subId = obj?.subscription || null;
        if (subId) {
          const uid = findUuidBySubId(subId);
          // Best-effort pull subscription from Stripe to refresh timestamps.
          try {
            const secret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
            if (secret) {
              const subResp = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`, { headers: { authorization: `Bearer ${secret}` } });
              const subJson = await subResp.json().catch(()=>null);
              if (subResp.ok && subJson) {
                const user_id = uid || subJson?.metadata?.provision_uuid || subJson?.metadata?.uuid || null;
                if (!user_id) {
                  try {
                    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
                      .run(crypto.randomUUID(), ts, 'stripe', String(subId), 'STRIPE_SUB_UUID_MISSING', JSON.stringify({ type: type2, subId: String(subId) }));
                  } catch {}
                }
                if (user_id) {
                  upsertSub.run(
                    String(subJson.id || subId),
                    'stripe',
                    String(user_id),
                    'standard',
                    String(subJson.status || ''),
                    unixToIso(subJson.current_period_end),
                    unixToIso(subJson.cancel_at),
                    unixToIso(subJson.canceled_at),
                    unixToIso(subJson.ended_at),
                    subJson.cancel_at_period_end ? 1 : 0,
                    ts,
                    ts
                  );

                  // On payment failure: start grace window immediately (best-effort)
                  if (type2 === 'invoice.payment_failed') {
                    try {
                      const d = getDeliveryByUuid(db, String(user_id));
                      if (d) {
                        // Only set if missing to preserve the first observation timestamp.
                        let meta0 = {};
                        try { meta0 = d.meta_json ? JSON.parse(d.meta_json) : {}; } catch { meta0 = {}; }
                        if (!meta0.payment_failed_since) {
                          const meta = mergeMeta(d.meta_json, { payment_failed_since: ts, payment_failed_provider_sub_id: String(subId) });
                          db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta, ts, d.delivery_id);
                          db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
                            .run(crypto.randomUUID(), ts, 'delivery', d.delivery_id, 'PAYMENT_FAILED_GRACE_START', JSON.stringify({ provider_sub_id: String(subId), status: String(subJson.status || '') }));
                          // Normalized funnel event
                          db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
                            .run(crypto.randomUUID(), ts, 'delivery', d.delivery_id, 'PAYMENT_FAILED', JSON.stringify({ uuid: String(user_id), provider_sub_id: String(subId), status: String(subJson.status || ''), attr: getAttr(String(user_id)) }));
                        }
                      }
                    } catch {}
                  }

                  // Clear grace marker when recovered
                  if (type2 === 'invoice.paid') {
                    try {
                      const d = getDeliveryByUuid(db, String(user_id));
                      if (d) {
                        const meta = mergeMeta(d.meta_json, { payment_failed_since: null });
                        db.prepare('UPDATE deliveries SET meta_json=?, updated_at=? WHERE delivery_id=?').run(meta, ts, d.delivery_id);
                      }
                    } catch {}

                    // Normalized funnel event
                    try {
                      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
                        .run(crypto.randomUUID(), ts, 'delivery', String(user_id), 'PAYMENT_PAID', JSON.stringify({ uuid: String(user_id), provider_sub_id: String(subId), attr: getAttr(String(user_id)) }));
                    } catch {}

                    // If key already verified + linked, cutover now.
                    try { tryCutoverDelivered(db, String(user_id), { reason: 'invoice_paid' }); } catch {}
                  }
                }
              }
            }
          } catch {}
        }
      }

      if (type2 === 'customer.subscription.updated' || type2 === 'customer.subscription.deleted') {
        const sub = obj || null;
        const subId = sub?.id || null;
        if (subId) {
          const user_id = findUuidBySubId(subId) || sub?.metadata?.provision_uuid || sub?.metadata?.uuid || null;
          if (!user_id) {
            try {
              db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
                .run(crypto.randomUUID(), ts, 'stripe', String(subId), 'STRIPE_SUB_UUID_MISSING', JSON.stringify({ type: type2, subId: String(subId) }));
            } catch {}
          }
          if (user_id) {
            upsertSub.run(
              String(subId),
              'stripe',
              String(user_id),
              'standard',
              String(sub?.status || ''),
              unixToIso(sub?.current_period_end),
              unixToIso(sub?.cancel_at),
              unixToIso(sub?.canceled_at),
              unixToIso(sub?.ended_at),
              sub?.cancel_at_period_end ? 1 : 0,
              ts,
              ts
            );

            // Normalize cancel signal
            if (type2 === 'customer.subscription.deleted' || String(sub?.status || '').toLowerCase() === 'canceled') {
              try {
                db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
                  .run(crypto.randomUUID(), ts, 'delivery', String(user_id), 'SUB_CANCELED', JSON.stringify({ uuid: String(user_id), provider_sub_id: String(subId), status: String(sub?.status || ''), attr: getAttr(String(user_id)) }));
              } catch {}
            }

            if (String(sub?.status || '').toLowerCase() in { active:1, trialing:1 }) {
              try { tryCutoverDelivered(db, String(user_id), { reason: 'subscription_updated' }); } catch {}
            }
          }
        }
      }
    } catch {}

    return res.status(200).type('text/plain').send('ok');
  } catch (e) {
    return res.status(500).type('text/plain').send('error');
  }
});

// i18n: WhatsApp prompts (platform-owned copy)
app.get('/api/i18n/whatsapp-prompts', (req, res) => {
  try {
    const langRaw = String(req.query?.lang || '').trim().toLowerCase();
    const lang = langRaw || 'en';
    const allow = new Set(['en','zh','zh-tw','ar','de','es','fr','hi','id','ja','ko','pt-br','ru','th','tr','vi']);
    const pick = allow.has(lang) ? lang : 'en';

    const here = path.dirname(new URL(import.meta.url).pathname);
    const p = path.join(here, 'i18n', 'whatsapp_prompts', `${pick}.json`);
    let prompts;
    try { prompts = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { prompts = null; }
    if (!prompts) return send(res, 500, { ok:false, error:'prompts_load_failed' });
    return send(res, 200, { ok:true, lang: pick, prompts });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// Delivery status (for user machine to decide next stage)
// Key status (OpenAI) — used by onboarding responder
app.get('/api/key/status', (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });
    const { db } = openDb();
    const row = db.prepare('SELECT meta_json FROM delivery_secrets WHERE provision_uuid=? AND kind=? LIMIT 1').get(uuid, 'openai_api_key');
    if (!row) return send(res, 200, { ok:true, uuid, hasKey:false, verified:false });
    let meta = {};
    try { meta = row.meta_json ? JSON.parse(row.meta_json) : {}; } catch { meta = {}; }
    let verifiedAt = meta.verified_at || null;

    // Self-heal: if a verified event exists but meta_json was overwritten by a later re-check,
    // treat the key as verified and restore verified_at.
    if (!verifiedAt) {
      try {
        const ev = db.prepare("SELECT ts FROM events WHERE event_type='OPENAI_KEY_VERIFIED' AND payload_json LIKE ? ORDER BY ts DESC LIMIT 1")
          .get(`%\"uuid\":\"${uuid}\"%`);
        if (ev?.ts) {
          verifiedAt = String(ev.ts);
          const ts2 = nowIso();
          const meta2 = JSON.stringify({ ...meta, verified_at: verifiedAt, verified_restored_at: ts2, verified_restored_via: 'key_status_self_heal' });
          db.prepare('UPDATE delivery_secrets SET meta_json=?, updated_at=? WHERE provision_uuid=? AND kind=?')
            .run(meta2, ts2, uuid, 'openai_api_key');
        }
      } catch {}
    }

    const fundedAt = meta.funded_at || null;
    return send(res, 200, { ok:true, uuid, hasKey:true, verified: Boolean(verifiedAt), verifiedAt, funded: Boolean(fundedAt), fundedAt });
  } catch {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// Verify + store OpenAI key (encrypted) — returns verified=true on success
app.post('/api/key/verify', async (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '').trim();
    const provider = String(req.body?.provider || 'openai').trim().toLowerCase();
    const key = String(req.body?.key || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });
    if (provider !== 'openai') return send(res, 400, { ok:false, error:'provider_not_supported' });
    if (!key) return send(res, 400, { ok:false, error:'key_required' });

    const vr = await verifyOpenAiKey(key, { timeoutMs: 10000 });
    if (!vr.ok) {
      // Distinguish invalid key vs quota/billing issues.
      const err = String(vr.error || 'key_invalid');
      const code = (err === 'insufficient_quota') ? 'key_unfunded' : 'key_invalid';
      return send(res, 200, { ok:true, verified:false, error: code, detail: vr.detail || vr.error || null });
    }

    const { ciphertext, iv, tag, alg } = encryptAesGcm(Buffer.from(key, 'utf8'));
    const ts = nowIso();
    const secretId = `${uuid}:openai_api_key`;

    const { db } = openDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO delivery_secrets(secret_id, provision_uuid, kind, ciphertext, iv, tag, alg, created_at, updated_at, meta_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(secret_id) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag, alg=excluded.alg, updated_at=excluded.updated_at, meta_json=excluded.meta_json`
      ).run(
        secretId,
        uuid,
        'openai_api_key',
        ciphertext,
        iv,
        tag,
        alg,
        ts,
        ts,
        JSON.stringify({ verified_at: ts, funded_at: ts, funded_model: vr.model || null })
      );
      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), ts, 'delivery', uuid, 'OPENAI_KEY_VERIFIED', JSON.stringify({ uuid })
      );
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    // NOTE (2026-03-04): Do NOT enqueue a duplicate WhatsApp success message here.
    // The user-machine guide/autoreply plugin calls /api/key/verify and will send `message`
    // back to self-chat immediately. If we also enqueue an outbound task, the user receives
    // two identical "key verified" messages.
    //
    // If we later want server-side gating (send-first-then-cutover), implement it as a single
    // source of truth and update the plugin accordingly.

    // Return a localized success message (sent to WhatsApp by the user-machine autoreply plugin).
    let msg = '';
    try {
      const { db } = openDb();
      const d2 = db.prepare('SELECT * FROM deliveries WHERE provision_uuid=? LIMIT 1').get(uuid);
      const lang = d2 ? getDeliveryLang(d2) : 'en';
      const prompts = loadWaPrompts(lang) || loadWaPrompts('en') || {};
      const tpl = String(prompts.key_verified_success || '').trim();
      const pLink = `https://p.bothook.me/p/${encodeURIComponent(uuid)}?lang=${encodeURIComponent(lang || 'en')}`;
      if (tpl) msg = renderTpl(tpl, { uuid, p_link: pLink });
    } catch {}

    if (!msg) {
      msg = '[bothook] OpenAI Key verified ✅\n\nWe’re finishing delivery cutover (takes ~1–2 minutes and includes a service restart).\n\nPlease wait 1 minute, then send: "hi"';
    }

    return send(res, 200, { ok:true, verified:true, message: msg });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

app.get('/api/delivery/status', (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });
    const { db } = openDb();
    const d = db.prepare('SELECT * FROM deliveries WHERE provision_uuid=? LIMIT 1').get(uuid);
    if (!d) return send(res, 404, { ok:false, error:'unknown_uuid' });

    // IMPORTANT: this endpoint is consumed by the user-machine onboarding/autoreply plugin.
    // If we misclassify a paid user as unpaid, the plugin will spam welcome_unpaid on every inbound message.
    const paid = deliveryEntitled(db, d);

    return send(res, 200, {
      ok:true,
      uuid,
      delivery_id: d.delivery_id,
      status: d.status,
      paid,
      wa_jid: d.wa_jid,
      bound_at: d.bound_at,
      user_lang: d.user_lang || null,
      updated_at: d.updated_at
    });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

function getClientIp(req){
  // Prefer Cloudflare header when present.
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(Array.isArray(cf) ? cf[0] : cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
  return String(req.ip || '').trim();
}

// Instance callback: mark delivered after local cutover is complete.
// Auth: require caller IP to match the currently bound instance public_ip.
app.post('/api/delivery/mark_delivered', (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const d = db.prepare('SELECT * FROM deliveries WHERE provision_uuid=? LIMIT 1').get(uuid);
    if (!d) return send(res, 404, { ok:false, error:'unknown_uuid' });

    const instId = String(d.instance_id || '').trim();
    if (!instId) return send(res, 409, { ok:false, error:'no_instance_bound' });

    const inst = db.prepare('SELECT * FROM instances WHERE instance_id=? LIMIT 1').get(instId);
    const ip = getClientIp(req);
    const expectedIp = String(inst?.public_ip || '').trim();
    if (expectedIp && ip && ip !== expectedIp) {
      return send(res, 403, { ok:false, error:'ip_mismatch' });
    }

    const ts = nowIso();

    // Mark delivery delivered (idempotent).
    try {
      const meta2 = mergeMeta(d?.meta_json || null, { delivered_at: ts, delivered_via: 'instance_mark_delivered', delivered_instance_id: instId });
      db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE provision_uuid=?').run('DELIVERED', ts, meta2, uuid);
    } catch {}

    try {
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)').run(
        crypto.randomUUID(), ts, 'delivery', d.delivery_id, 'CUTOVER_DELIVERED', JSON.stringify({ uuid, instance_id: instId, via: 'instance_mark_delivered' })
      );
    } catch {}

    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, status: 'DELIVERED' });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

// Instance callback: report outbound messaging outcomes (welcome/guide/success).
// Auth: require caller IP to match the currently bound instance public_ip.
app.post('/api/instance/event', (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '').trim();
    const eventType = String(req.body?.event_type || '').trim().toUpperCase();
    const payload = req.body?.payload || {};
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });
    if (!eventType) return send(res, 400, { ok:false, error:'event_type_required' });

    const allow = new Set([
      'WELCOME_UNPAID_SENT',
      'WELCOME_UNPAID_SEND_FAILED',
      'GUIDE_KEY_PAID_SENT',
      'GUIDE_KEY_PAID_SEND_FAILED',
      'KEY_VERIFIED_SUCCESS_SENT',
      'KEY_VERIFIED_SUCCESS_SEND_FAILED'
    ]);
    if (!allow.has(eventType)) return send(res, 400, { ok:false, error:'event_type_not_allowed' });

    const { db } = openDb();
    const d = db.prepare('SELECT * FROM deliveries WHERE provision_uuid=? LIMIT 1').get(uuid);
    if (!d) return send(res, 404, { ok:false, error:'unknown_uuid' });

    const instId = String(d.instance_id || '').trim();
    if (!instId) return send(res, 409, { ok:false, error:'no_instance_bound' });
    const inst = db.prepare('SELECT * FROM instances WHERE instance_id=? LIMIT 1').get(instId);

    const ip = getClientIp(req);
    const expectedIp = String(inst?.public_ip || '').trim();
    if (expectedIp && ip && ip !== expectedIp) {
      return send(res, 403, { ok:false, error:'ip_mismatch' });
    }

    const ts = nowIso();
    db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)').run(
      crypto.randomUUID(), ts, 'delivery', d.delivery_id, eventType,
      JSON.stringify({ uuid, instance_id: instId, ...payload })
    );

    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, event_type: eventType });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});



// Ops: mark QR generated (A-stage start)
app.post('/api/ops/smoke/run', async (req, res) => {
  try {
    // IMPORTANT: do not log request bodies (may contain smoke test keys).
    const instance_id = String(req.body?.instance_id || '').trim();
    const lang = String(req.body?.lang || 'en').trim().toLowerCase();
    const key = String(req.body?.openai_key || '').trim();
    const targetE164Raw = String(req.body?.target_e164 || '').trim();
    const doCutover = Boolean(req.body?.cutover);
    if (!instance_id) return send(res, 400, { ok:false, error:'instance_id_required' });
    if (!key) return send(res, 400, { ok:false, error:'openai_key_required' });
    if (instance_id === 'lhins-npsqfxvn') return send(res, 403, { ok:false, error:'forbidden_master_host' });

    const uuid = crypto.randomUUID();
    // Target: either simulated (default) or a real WhatsApp recipient.
    // If target_e164 is provided (e.g. +6586...), send for real; otherwise use simulated jid.
    let wa_jid = `sim:1${sha256Hex(uuid).slice(0,10).replace(/\D/g,'0')}@s.whatsapp.net`;
    if (targetE164Raw) {
      const e164 = '+' + targetE164Raw.replace(/\D+/g, '');
      if (!/^\+\d{6,20}$/.test(e164)) return send(res, 400, { ok:false, error:'bad_target_e164' });
      const digits = e164.slice(1);
      wa_jid = `${digits}@s.whatsapp.net`;
    }
    const ts0 = nowIso();
    const { db } = openDb();

    const inst = getInstanceById(db, instance_id);
    if (!inst?.public_ip) return send(res, 404, { ok:false, error:'instance_not_found_or_missing_ip' });

    // Create a smoke delivery bound to the chosen instance WITHOUT using the normal allocation path.
    // Rationale: allocation requires provision_ready pool stock; for smoke we want to pin to a specific instance.
    const delivery_id = crypto.randomUUID();
    const meta2 = JSON.stringify({ smoke: true, smoke_started_at: ts0, smoke_lang: lang, preferred_lang: lang });

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'INSERT INTO deliveries(delivery_id, order_id, user_id, instance_id, status, provision_uuid, created_at, updated_at, meta_json, wa_jid, wa_e164, bound_at, user_lang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        delivery_id,
        null,
        uuid,
        instance_id,
        'BOUND_UNPAID',
        uuid,
        ts0,
        ts0,
        meta2,
        wa_jid,
        wa_jid.startsWith('sim:') ? null : ('+' + String(wa_jid).split('@')[0].replace(/\D+/g,'')),
        ts0,
        lang
      );

      db.prepare('UPDATE instances SET lifecycle_status=?, assigned_user_id=?, assigned_at=? WHERE instance_id=?')
        .run('DELIVERING', uuid, ts0, instance_id);

      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), ts0, 'delivery', delivery_id, 'SMOKE_BOUND_SIMULATED',
        JSON.stringify({ uuid, delivery_id, instance_id, wa_jid, lang })
      );
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    const d = db.prepare('SELECT * FROM deliveries WHERE delivery_id=?').get(delivery_id);

    // (1) Welcome (BOUND_UNPAID)
    // Do NOT call back into HTTP (can deadlock under some server configurations). Render directly.
    const promptsW = loadWaPrompts(lang) || loadWaPrompts('en') || {};
    const welcomeTpl = String(promptsW.welcome_unpaid || '').trim();
    if (!welcomeTpl) return send(res, 500, { ok:false, error:'welcome_unpaid_missing', uuid, lang });
    const pLinkW = `https://p.bothook.me/p/${encodeURIComponent(uuid)}?lang=${encodeURIComponent(lang || 'en')}`;
    const welcomeMsg = renderTpl(welcomeTpl, {
      uuid,
      region: inst.region || '',
      public_ip: inst.public_ip || '',
      cpu: '2',
      ram_gb: '2',
      disk_gb: '40',
      openclaw_version: '',
      p_link: pLinkW,
      pay_countdown_minutes: 15,
      pay_short_link: ''
    });

    const rrW = sendSelfChatOnInstance(inst, welcomeMsg, { toJid: wa_jid });
    const recW = recordSmokeMessage(db, { uuid, delivery_id: d.delivery_id, instance_id, kind:'welcome_unpaid', lang, text: welcomeMsg, sendResult: rrW });
    if (!recW.ok) return send(res, 500, { ok:false, error:'welcome_contains_forbidden', uuid, forbidden_hits: recW.forbidden_hits });

    // (2) Mark paid + send guide
    const tsPaid = nowIso();
    try {
      const metaPaid = mergeMeta(d.meta_json, { smoke_paid_at: tsPaid, paid_confirmed_via: 'smoke' });
      db.prepare('UPDATE deliveries SET status=?, updated_at=?, meta_json=? WHERE delivery_id=?').run('PAID', tsPaid, metaPaid, d.delivery_id);
      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), tsPaid, 'delivery', d.delivery_id, 'SMOKE_PAYMENT_SIMULATED', JSON.stringify({ uuid, instance_id })
      );
    } catch {}

    // Build guide text using the same prompt slot.
    const prompts = loadWaPrompts(lang) || loadWaPrompts('en') || {};
    const guideTpl = String(prompts.guide_key_paid || '').trim();
    const pLink = `https://p.bothook.me/p/${encodeURIComponent(uuid)}?lang=${encodeURIComponent(lang || 'en')}`;
    const guideMsg = guideTpl ? renderTpl(guideTpl, { uuid, p_link: pLink }) : `[bothook] Payment received ✅\n\nNext: paste your OpenAI API key here as ONE line starting with sk- (self-chat only).\nLink: ${pLink}`;

    const rrG = sendSelfChatOnInstance(inst, guideMsg, { toJid: wa_jid });
    const recG = recordSmokeMessage(db, { uuid, delivery_id: d.delivery_id, instance_id, kind:'guide_key_paid', lang, text: guideMsg, sendResult: rrG });
    if (!recG.ok) return send(res, 500, { ok:false, error:'guide_contains_forbidden', uuid, forbidden_hits: recG.forbidden_hits });

    // (3) Verify key (real OpenAI call) + store encrypted key in DB (do NOT call back into HTTP)
    const vr = await verifyOpenAiKey(key, { timeoutMs: 10000 });
    if (!vr.ok) {
      const failMsg = 'key_invalid';
      recordSmokeMessage(db, { uuid, delivery_id: d.delivery_id, instance_id, kind:'key_verify_failed', lang, text: failMsg, sendResult: { code: 0, stdout: 'simulated', stderr: '' } });
      return send(res, 200, { ok:true, uuid, instance_id, lang, verified:false, verify_error: vr.error || 'key_invalid' });
    }

    // Upsert secret (encrypted)
    try {
      const { ciphertext, iv, tag, alg } = encryptAesGcm(Buffer.from(key, 'utf8'));
      const tsKey = nowIso();
      const secretId = `${uuid}:openai_api_key`;
      db.prepare(
        `INSERT INTO delivery_secrets(secret_id, provision_uuid, kind, ciphertext, iv, tag, alg, created_at, updated_at, meta_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(secret_id) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag, alg=excluded.alg, updated_at=excluded.updated_at, meta_json=excluded.meta_json`
      ).run(secretId, uuid, 'openai_api_key', ciphertext, iv, tag, alg, tsKey, tsKey, JSON.stringify({ verified_at: tsKey }));
      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), tsKey, 'delivery', d.delivery_id, 'OPENAI_KEY_VERIFIED', JSON.stringify({ uuid })
      );
    } catch {}

    // Record key-verified success message (localized)
    let keyOkMsg = '';
    try {
      const promptsK = loadWaPrompts(lang) || loadWaPrompts('en') || {};
      const tpl = String(promptsK.key_verified_success || '').trim();
      if (tpl) keyOkMsg = renderTpl(tpl, { uuid });
    } catch {}
    if (!keyOkMsg) {
      keyOkMsg = '[bothook] OpenAI Key verified ✅\n\nWe’re finishing delivery cutover (takes ~1–2 minutes and includes a service restart).\n\nPlease wait 1 minute, then send: "hi"';
    }
    const recK = recordSmokeMessage(db, { uuid, delivery_id: d.delivery_id, instance_id, kind:'key_verified_success', lang, text: keyOkMsg, sendResult: { code: 0, stdout: 'simulated', stderr: '' } });
    if (!recK.ok) return send(res, 500, { ok:false, error:'key_success_message_contains_forbidden', uuid, forbidden_hits: recK.forbidden_hits });

    // (4) Optional: Cutover + finalize delivery
    let cutover = { attempted: false, delivered: false, checks: null };
    if (doCutover) {
      cutover.attempted = true;
      try { tryCutoverDelivered(db, uuid, { reason: 'smoke' }); } catch {}

      // Wait a bit then check if machine is converged to DELIVERED.
      await sleepMs(4000);
      let d3 = null;
      try { d3 = getDeliveryByUuid(db, uuid); } catch {}
      try { cutover.delivered = String(d3?.status || '') === 'DELIVERED'; } catch { cutover.delivered = false; }

      // Verify instance-side convergence BEFORE cleanup.
      try {
        const vr = poolSsh(inst,
          `set -euo pipefail; `
          + `test -f /opt/bothook/DELIVERED.json && echo delivered_marker=1 || echo delivered_marker=0; `
          + `test -f /home/ubuntu/.openclaw/agents/main/agent/auth-profiles.json && echo auth_profiles=1 || echo auth_profiles=0; `
          + `systemctl is-enabled bothook-provision.service >/dev/null 2>&1 && echo provision_enabled=1 || echo provision_enabled=0; `
          + `systemctl is-active bothook-provision.service >/dev/null 2>&1 && echo provision_active=1 || echo provision_active=0; `
          + `sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins list 2>/dev/null | grep -qi bothook-wa-autoreply && echo autoreply_present=1 || echo autoreply_present=0; `
          + `sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins list 2>/dev/null | grep -qi 'bothook-wa-autoreply.*disabled' && echo autoreply_disabled=1 || echo autoreply_disabled=0; `
          + `echo ok`,
          { timeoutMs: 20000, tty:false, retries:0 }
        );
        const lines = String(vr.stdout || '').trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
        const asBool = (k) => lines.includes(`${k}=1`);
        cutover.checks = {
          delivered_marker: asBool('delivered_marker'),
          auth_profiles: asBool('auth_profiles'),
          provision_enabled: asBool('provision_enabled'),
          provision_active: asBool('provision_active'),
          autoreply_present: asBool('autoreply_present'),
          autoreply_disabled: asBool('autoreply_disabled')
        };
      } catch {
        cutover.checks = { error: 'instance_verify_failed' };
      }
    }

    // (5) Cleanup on instance: clear auth + sanitize WA session (so it is safe to return to pool)
    try { poolSsh(inst, 'sudo rm -f /home/ubuntu/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null || true', { timeoutMs: 15000, tty:false, retries:0 }); } catch {}
    try { await fetch('http://127.0.0.1:18998/api/ops/pool/wa-sanitize', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ instance_id }) }); } catch {}

    // Delete stored secret for smoke UUID (do not leave keys behind)
    try {
      db.prepare('DELETE FROM delivery_secrets WHERE provision_uuid=? AND kind=?').run(uuid, 'openai_api_key');
      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), nowIso(), 'delivery', d.delivery_id, 'SMOKE_SECRET_DELETED', JSON.stringify({ uuid })
      );
    } catch {}

    // Return instance back to pool (best-effort, but we must not leave it allocated).
    try {
      const tsEnd = nowIso();
      db.prepare('UPDATE instances SET lifecycle_status=?, assigned_user_id=NULL, assigned_at=NULL WHERE instance_id=?').run('IN_POOL', instance_id);
      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), tsEnd, 'instance', instance_id, 'SMOKE_INSTANCE_RETURNED_TO_POOL', JSON.stringify({ uuid, instance_id })
      );
    } catch {}

    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, instance_id, lang, cutover, target: wa_jid.startsWith('sim:') ? 'simulated' : 'real', wa_jid });
  } catch (e) {
    return send(res, 500, { ok:false, error: e?.message || 'server_error' });
  }
});

// Ops: mark QR generated (A-stage start)
app.post('/api/ops/qr-generated', (req, res) => {
  try {
    res.set('x-bothook-build', 'ops-alloc-v2');
    const uuid = String(req.body?.uuid || '').trim();
    const lang = String(req.body?.lang || '').trim() || null;
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    let d = getOrCreateDeliveryForUuid(db, uuid, { preferredLang: lang || null });

    // Self-heal: p-site currently calls this endpoint on "retry".
    // If watchdog cleared delivery.instance_id, allocate a fresh clean pool machine here so a QR can be produced.
    if (!d.instance_id) {
      console.log('[bothook-api] ops/qr-generated allocating for uuid', uuid, 'delivery_id', d.delivery_id, 'status', d.status);
      const ts0 = nowIso();
      const candidates = db.prepare(`
        SELECT instance_id, public_ip, lifecycle_status, health_status, meta_json, created_at
        FROM instances
        WHERE public_ip IS NOT NULL AND public_ip != ''
          AND lifecycle_status='IN_POOL'
          AND health_status='READY'
        ORDER BY created_at ASC
        LIMIT 50
      `).all();

      const requiredArtifacts = getRequiredArtifactsVersion();
      const provisionReady = candidates.filter((i) => {
        const meta = (jsonMeta(i.meta_json) || {});
        if (meta.provision_ready !== true) return false;
        if (requiredArtifacts && String(meta.provision_artifacts_version || '') !== String(requiredArtifacts)) return false;
        if (MIN_OPENCLAW_VERSION && cmpVersion(meta.provision_openclaw_version, MIN_OPENCLAW_VERSION) < 0) return false;
        return true;
      });
      if (!provisionReady.length) return send(res, 503, { ok:false, error:'no_provision_ready_instances' });

      let chosen = null;
      for (const c of provisionReady) {
        const inst = getInstanceById(db, c.instance_id);
        const probe = probeInstanceWhatsappClean(db, inst);
        if (probe.clean) { chosen = inst; break; }
      }
      if (!chosen) return send(res, 503, { ok:false, error:'no_clean_instances_available' });

      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT status, meta_json FROM deliveries WHERE delivery_id=?').get(d.delivery_id);
        const meta2 = mergeMeta(row?.meta_json || d.meta_json, { reallocated_at: ts0, prev_status: row?.status || d.status || null });
        db.prepare('UPDATE deliveries SET instance_id=?, status=?, updated_at=?, meta_json=? WHERE delivery_id=?')
          .run(chosen.instance_id, 'LINKING', ts0, meta2, d.delivery_id);
        db.prepare('UPDATE instances SET lifecycle_status=?, assigned_user_id=?, assigned_at=? WHERE instance_id=?')
          .run('ALLOCATED', uuid, ts0, chosen.instance_id);

        writeUuidStateFilesOnInstance(chosen, { uuid, lang: lang || getDeliveryLang(d) || 'en' });

        db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
          crypto.randomUUID(), ts0, 'delivery', d.delivery_id, 'PROVISION_REALLOCATED',
          JSON.stringify({ uuid, instance_id: chosen.instance_id, via: 'ops/qr-generated', from_status: row?.status || d.status || null })
        );
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }

      d = db.prepare('SELECT * FROM deliveries WHERE delivery_id=?').get(d.delivery_id);

      // HARD FAIL: if still not allocated, surface error (do not emit QR_GENERATED with null instance_id)
      if (!d?.instance_id) {
        const tsF = nowIso();
        try {
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json)
                      VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), tsF, 'delivery', d.delivery_id, 'QR_ALLOCATE_FAILED',
            JSON.stringify({ uuid, via: 'ops/qr-generated', error: 'instance_id_still_null_after_allocate' })
          );
        } catch {}
        return send(res, 503, { ok:false, error:'allocate_failed', uuid });
      }
    }

    // Ensure /opt/bothook/UUID.txt + /opt/bothook/state.json exist on the allocated instance.
    try {
      const inst = getInstanceById(db, d.instance_id);
      if (inst?.public_ip) writeUuidStateFilesOnInstance(inst, { uuid, lang: lang || getDeliveryLang(d) || 'en' });
    } catch {}
    const ts = nowIso();
    const expiresAt = new Date(Date.now() + 5*60*1000).toISOString();

    db.exec('BEGIN IMMEDIATE');
    try {
      const meta = mergeMeta(d.meta_json, { preferred_lang: lang || undefined, qr_generated_at: ts, qr_expires_at: expiresAt });
      // Do NOT downgrade state for already-bound/paid deliveries.
      // Only move to LINKING when not yet bound.
      const cur = db.prepare('SELECT status, wa_jid FROM deliveries WHERE delivery_id=?').get(d.delivery_id);
      const nextStatus = (cur?.wa_jid ? String(cur.status || 'LINKING') : 'LINKING');
      // Language must follow p-site selection end-to-end. Use current `lang` as the source of truth.
      // If `lang` is missing/null, preserve existing user_lang.
      db.prepare('UPDATE deliveries SET status=?, user_lang=COALESCE(?, user_lang), updated_at=?, meta_json=? WHERE delivery_id=?')
        .run(nextStatus, lang || null, ts, meta, d.delivery_id);

      db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
        crypto.randomUUID(), ts, 'delivery', d.delivery_id, 'QR_GENERATED', JSON.stringify({ uuid, lang, expires_at: expiresAt, instance_id: d.instance_id })
      );
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, expiresAt });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

app.get('/api/ops/provision-state', (req, res) => {
  try {
    const uuid = String(req.query?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const d = getDeliveryByUuid(db, uuid);
    if (!d) return send(res, 404, { ok:false, error:'unknown_uuid' });

    let meta = {};
    try { meta = d.meta_json ? JSON.parse(d.meta_json) : {}; } catch { meta = {}; }

    const qrExpiresAt = meta.qr_expires_at || null;
    const now = Date.now();
    const expired = Boolean(!d.wa_jid && qrExpiresAt && Date.parse(qrExpiresAt) <= now);

    return send(res, 200, { ok:true, uuid, delivery_id: d.delivery_id, status: d.status, expired, qrExpiresAt });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});


function startOpsWorker(){
  const intervalMs = parseInt(process.env.BOTHOOK_OPS_TICK_MS || '30000', 10);
  const enabled = (process.env.BOTHOOK_OPS_WORKER || '1') === '1';
  if (!enabled) return;

  async function tick(){
    const { db } = openDb();
    const now = Date.now();

    // QR/Login watchdog (linking loop) — LEGACY.
    // Default architecture delegates QR/login to the user-machine provisioning server (127.0.0.1:18999 on the instance).
    // Running a second tmux-based login loop from the control-plane can conflict with provision/server.mjs.
    // Gate behind an explicit env flag.
    const tmuxWatchdogEnabled = (process.env.BOTHOOK_WA_TMUX_WATCHDOG || '0') === '1';
    if (tmuxWatchdogEnabled) try {
      const rowsW = db.prepare(`
        SELECT provision_uuid, instance_id
        FROM deliveries
        WHERE status='LINKING' AND (wa_jid IS NULL OR wa_jid='') AND instance_id IS NOT NULL AND instance_id != ''
        LIMIT 50
      `).all();

      for (const r of rowsW) {
        const uuid = String(r.provision_uuid || '').trim();
        if (!uuid) continue;
        const inst = getInstanceById(db, r.instance_id);
        if (!inst?.public_ip) continue;
        const session = `wa-login-${uuid}`.replace(/[^a-zA-Z0-9_-]/g, '');

        // Fire-and-forget: do not block the ops loop.
        setTimeout(() => {
          try {
            const chk = poolSsh(inst, `set -euo pipefail; tmux has-session -t '${session}' 2>/dev/null && echo has || echo no`, { timeoutMs: 2500, tty: false, retries: 0 });
            const has = String(chk.stdout || chk.stderr || '').includes('has');
            if (!has) {
              const cmd = `set -euo pipefail; `
                + `tmux kill-session -t '${session}' 2>/dev/null || true; `
                + `tmux new-session -d -s '${session}' "bash -lc 'stty cols 220 rows 80 2>/dev/null || true; export COLUMNS=220 LINES=80; openclaw channels login --channel whatsapp'"; `
                + `echo started`;
              poolSsh(inst, cmd, { timeoutMs: 12000, tty: false, retries: 0 });
            }
          } catch {}
        }, 0);
      }
    } catch {}


    // A-stage: QR expired (5m) and not bound
    const rowsA = db.prepare(`
      SELECT delivery_id, provision_uuid, instance_id, meta_json
      FROM deliveries
      WHERE status='LINKING' AND (wa_jid IS NULL OR wa_jid='')
      LIMIT 200
    `).all();

    for (const r of rowsA){
      let meta = {};
      try { meta = r.meta_json ? JSON.parse(r.meta_json) : {}; } catch { meta = {}; }
      const exp = meta.qr_expires_at ? Date.parse(meta.qr_expires_at) : NaN;
      if (!isNaN(exp) && exp <= now){
        const ts = nowIso();

        // Late-link salvage: before recycling, probe the instance to see if WhatsApp actually linked.
        // Rationale: pairing can complete after the QR expires (or after the UI stops polling).
        // If creds.json indicates a fresh self JID for this QR window, bind + move to BOUND_UNPAID instead of recycling.
        try {
          if (r.instance_id) {
            const inst = getInstanceById(db, r.instance_id);
            const qrGenAt = meta.qr_generated_at ? Date.parse(meta.qr_generated_at) : NaN;
            if (inst?.public_ip) {
              const pr = poolSsh(
                inst,
                `set -euo pipefail; python3 -c "import os,json; p=\"/home/ubuntu/.openclaw/credentials/whatsapp/default/creds.json\"; mt=int(os.path.getmtime(p)) if os.path.exists(p) else 0; j=(json.load(open(p)) if os.path.exists(p) else {}); me=(j.get('me') or {}); jid=(me.get('id') or me.get('jid') or \"\"); print(str(mt)+' '+str(jid))"`,
                { timeoutMs: 6000, tty: false, retries: 0 }
              );
              const out = String(pr.stdout || '').trim();
              const parts = out.split(/\s+/, 2);
              const mtimeSec = parseInt(parts[0] || '0', 10) || 0;
              const jid = String(parts[1] || '').trim();
              const looksFresh = (!isNaN(qrGenAt)) ? (mtimeSec >= Math.floor(qrGenAt/1000)) : (mtimeSec > 0);

              if (jid && looksFresh) {
                const boundUnpaidExpiresAt = new Date(Date.parse(ts) + 15*60*1000).toISOString();
                const meta2 = mergeMeta(r.meta_json, { bound_unpaid_expires_at: boundUnpaidExpiresAt, qr_done_at: ts });
                db.exec('BEGIN IMMEDIATE');
                try {
                  db.prepare('UPDATE deliveries SET status=?, wa_jid=?, bound_at=?, updated_at=?, meta_json=? WHERE delivery_id=?')
                    .run('BOUND_UNPAID', jid, ts, ts, meta2, r.delivery_id);
                  db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
                    crypto.randomUUID(), ts, 'delivery', r.delivery_id, 'UUID_BOUND', JSON.stringify({ uuid: r.provision_uuid, wa_jid: jid, instance_id: r.instance_id, salvage: true })
                  );
                  try {
                    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
                      crypto.randomUUID(), ts, 'delivery', r.delivery_id, 'WA_LINKED', JSON.stringify({ uuid: r.provision_uuid, wa_jid: jid, instance_id: r.instance_id, salvage: true })
                    );
                  } catch {}
                  db.exec('COMMIT');
                  continue; // do NOT recycle
                } catch {
                  try { db.exec('ROLLBACK'); } catch {}
                }
              }
            }
          }
        } catch {}

        db.exec('BEGIN IMMEDIATE');
        try {
          // mark recycled
          db.prepare('UPDATE deliveries SET status=?, instance_id=NULL, updated_at=?, meta_json=? WHERE delivery_id=?')
            .run('QR_EXPIRED', ts, mergeMeta(r.meta_json, { recycled_at: ts, recycle_reason: 'QR_EXPIRED' }), r.delivery_id);
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), ts, 'delivery', r.delivery_id, 'RECYCLE_UNBOUND', JSON.stringify({ uuid: r.provision_uuid, instance_id: r.instance_id })
          );
          // return instance to pool (safe for unbound)
          // Guard: do NOT return to pool if the user has an active subscription.
          if (r.instance_id){
            const sub = db.prepare(
              `SELECT status
                 FROM subscriptions
                WHERE user_id=? AND provider='stripe'
                ORDER BY datetime(updated_at) DESC
                LIMIT 1`
            ).get(String(r.provision_uuid||''));
            const st = String(sub?.status || '').toLowerCase();
            const active = (st === 'active' || st === 'trialing' || st === 'paid');
            if (!active) {
              db.prepare('UPDATE instances SET lifecycle_status=?, assigned_user_id=NULL, assigned_order_id=NULL, assigned_at=NULL WHERE instance_id=?')
                .run('IN_POOL', r.instance_id);
            }
          }
          db.exec('COMMIT');
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
        }
      }
    }

    // B-stage: bound but unpaid (15m)
    const rowsB = db.prepare(`
      SELECT delivery_id, provision_uuid, instance_id, status, meta_json
      FROM deliveries
      WHERE status='BOUND_UNPAID'
      LIMIT 200
    `).all();

    for (const r of rowsB){
      let meta = {};
      try { meta = r.meta_json ? JSON.parse(r.meta_json) : {}; } catch { meta = {}; }
      const exp = meta.bound_unpaid_expires_at ? Date.parse(meta.bound_unpaid_expires_at) : NaN;
      if (!isNaN(exp) && exp <= now){
        const ts = nowIso();
        // Attempt unbind+cleanup on pool instance (A-mode strict): remove WhatsApp auth so the machine becomes clean.
        try {
          if (r.instance_id) {
            const inst = db.prepare('SELECT instance_id, public_ip, meta_json FROM instances WHERE instance_id=?').get(r.instance_id);
            if (inst && inst.public_ip) {
              const session = `wa-login-${r.provision_uuid}`.replace(/[^a-zA-Z0-9_-]/g, '');
              const remoteCmd = `set -euo pipefail; `
                + `tmux kill-session -t '${session}' 2>/dev/null || true; `
                + `sudo systemctl stop openclaw-gateway.service 2>/dev/null || true; `
                + `systemctl --user stop openclaw-gateway.service 2>/dev/null || true; `
                + `openclaw channels logout --channel whatsapp 2>/dev/null || true; `
                + `rm -rf /home/ubuntu/.openclaw/channels/whatsapp 2>/dev/null || true; `
                + `sudo systemctl start openclaw-gateway.service 2>/dev/null || true; `
                + `echo cleaned`;
              // Fire-and-forget cleanup. Never block the ops loop (and thus the whole HTTP server)
              // on slow/unreachable instances.
              setTimeout(() => {
                try { poolSsh(inst, remoteCmd, { timeoutMs: 8000, tty: false, retries: 0 }); } catch {}
              }, 0);
            }
          }
        } catch {}

        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE deliveries SET status=?, instance_id=NULL, wa_jid=NULL, bound_at=NULL, updated_at=?, meta_json=? WHERE delivery_id=?')
            .run('RECYCLED_UNPAID', ts, mergeMeta(r.meta_json, { recycled_at: ts, recycle_reason: 'UNPAID' }), r.delivery_id);
          db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
            crypto.randomUUID(), ts, 'delivery', r.delivery_id, 'RECYCLE_UNPAID', JSON.stringify({ uuid: r.provision_uuid, instance_id: r.instance_id })
          );
          if (r.instance_id){
            const sub = db.prepare(
              `SELECT status
                 FROM subscriptions
                WHERE user_id=? AND provider='stripe'
                ORDER BY datetime(updated_at) DESC
                LIMIT 1`
            ).get(String(r.provision_uuid||''));
            const st = String(sub?.status || '').toLowerCase();
            const active = (st === 'active' || st === 'trialing' || st === 'paid');
            if (!active) {
              db.prepare('UPDATE instances SET lifecycle_status=?, assigned_user_id=NULL, assigned_order_id=NULL, assigned_at=NULL WHERE instance_id=?')
                .run('IN_POOL', r.instance_id);
            }
          }
          db.exec('COMMIT');
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
        }
      }
    }
  }

  setInterval(() => { tick().catch(()=>{}); }, intervalMs);
  // immediate tick
  tick().catch(()=>{});
}

startOpsWorker();



app.post('/api/wa/reset', async (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '').trim();
    if (!uuid) return send(res, 400, { ok:false, error:'uuid_required' });

    const { db } = openDb();
    const delivery = db.prepare('SELECT * FROM deliveries WHERE provision_uuid = ? LIMIT 1').get(uuid);
    if (!delivery) return send(res, 404, { ok:false, error:'unknown_uuid' });
    const instance = getInstanceById(db, delivery.instance_id);
    if (!instance?.public_ip) return send(res, 500, { ok:false, error:'instance_missing_ip' });

    const session = `wa-login-${uuid}`.replace(/[^a-zA-Z0-9_-]/g, '');
    const remoteCmd = `set -euo pipefail; `
      + `tmux kill-session -t '${session}' 2>/dev/null || true; `
      + `sudo systemctl stop openclaw-gateway.service 2>/dev/null || true; `
      + `systemctl --user stop openclaw-gateway.service 2>/dev/null || true; `
      + `openclaw channels logout --channel whatsapp 2>/dev/null || true; `
      + `rm -rf /home/ubuntu/.openclaw/channels/whatsapp 2>/dev/null || true; `
      + `sudo systemctl start openclaw-gateway.service 2>/dev/null || true; `
      + `echo cleaned`;

    const rr = poolSsh(instance, remoteCmd, { timeoutMs: 25000, tty: false, retries: 2 });
    if (rr.code !== 0) {
      const detail = ((rr.stdout || '') + '\n' + (rr.stderr || '')).trim();
      return send(res, 502, { ok:false, error:'pool_reset_failed', detail: detail || `ssh_failed_exit_${rr.code}` });
    }

    const ts = nowIso();
    db.prepare(`INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)`).run(
      crypto.randomUUID(), ts, 'delivery', delivery.delivery_id, 'UNBIND_SENT', JSON.stringify({ uuid, instance_id: instance.instance_id })
    );

    return send(res, 200, { ok:true, uuid, instance_id: instance.instance_id, reset:true });
  } catch (e) {
    return send(res, 500, { ok:false, error:'server_error' });
  }
});

async function runOpsWorkerLoop(){
  // Single-process worker loop. Use a lock file to avoid concurrent workers.
  const lockPath = '/tmp/bothook_ops_worker.lock';
  let fd = null;
  try {
    fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lockPath, String(process.pid));
  } catch {
    // Lock exists. Attempt stale-lock recovery (e.g. prior worker crashed).
    try {
      const s = String(fs.readFileSync(lockPath, 'utf8') || '').trim();
      const pid = Number(s);
      if (pid && pid > 1) {
        try {
          process.kill(pid, 0);
          // Another worker is alive.
          return;
        } catch {
          // Stale lock; remove and retry once.
          try { fs.unlinkSync(lockPath); } catch {}
          fd = fs.openSync(lockPath, 'wx');
          fs.writeFileSync(lockPath, String(process.pid));
        }
      } else {
        // Unknown lock contents; best-effort remove.
        try { fs.unlinkSync(lockPath); } catch {}
        fd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(lockPath, String(process.pid));
      }
    } catch {
      // another worker running (or unable to recover)
      return;
    }
  }

  try {
    const { db } = openDb();

    // Mark stale RUNNING jobs as ERROR so ops can re-enqueue. Prevents "forever RUNNING" jobs.
    try {
      const STALE_MS = parseInt(process.env.BOTHOOK_POOL_INIT_STALE_MS || String(30 * 60 * 1000), 10);
      const cutoffIso = new Date(Date.now() - STALE_MS).toISOString();
      const stale = db.prepare(
        "SELECT job_id, log_json FROM pool_init_jobs WHERE status='RUNNING' AND started_at IS NOT NULL AND datetime(started_at) < datetime(?)"
      ).all(cutoffIso);
      for (const r of stale) {
        let log = [];
        try { log = JSON.parse(r.log_json || '[]'); } catch { log = []; }
        log.push({ ts: nowIso(), msg: `stale RUNNING job auto-marked ERROR (cutoff=${cutoffIso})` });
        db.prepare('UPDATE pool_init_jobs SET status=?, ended_at=?, log_json=? WHERE job_id=?')
          .run('ERROR', nowIso(), JSON.stringify(log), String(r.job_id));
      }
    } catch {}

    while (true) {
      const row = db.prepare("SELECT * FROM pool_init_jobs WHERE status='QUEUED' ORDER BY created_at ASC LIMIT 1").get();
      if (!row) break;
      const log = (()=>{ try { return JSON.parse(row.log_json || '[]'); } catch { return []; } })();
      const job = { job_id: row.job_id, instance_id: row.instance_id, mode: row.mode, status: row.status, startedAt: null, endedAt: null, log, _db: db };
      await runPoolInitJob(job);
      // loop continues for next queued job
    }
  } finally {
    try { if (fd) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

async function runCutoverReconcilerOnce(){
  // One-shot reconciler: find deliveries that meet cutover preconditions but are not DELIVERED,
  // then run the idempotent tryCutoverDelivered() path.
  // Use a lock file to avoid concurrent runs (timer overlap).
  const lockPath = '/tmp/bothook_cutover_reconciler.lock';
  let fd = null;
  try {
    fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lockPath, String(process.pid));
  } catch {
    return;
  }

  try {
    const LIMIT = Math.max(1, Math.min(5, Number(process.env.BOTHOOK_CUTOVER_RECONCILER_LIMIT || 2)));
    const { db } = openDb();
    const ts0 = nowIso();

    // Candidates: pinned to an instance with an IP, already linked.
    const rows = db.prepare(
      `SELECT d.provision_uuid AS uuid
         FROM deliveries d
         JOIN instances i ON i.instance_id = d.instance_id
        WHERE d.status IS NOT NULL
          AND d.status != 'DELIVERED'
          AND d.wa_jid IS NOT NULL AND d.wa_jid != ''
          AND d.instance_id IS NOT NULL AND d.instance_id != ''
          AND i.public_ip IS NOT NULL AND i.public_ip != ''
        ORDER BY datetime(d.updated_at) ASC
        LIMIT 80`
    ).all() || [];

    let attempted = 0;
    let delivered = 0;
    for (const r of rows) {
      if (attempted >= LIMIT) break;
      const uuid = String(r.uuid || '').trim();
      if (!uuid) continue;

      // Guard: only attempt when preconditions are met (avoid noisy SSH).
      const linked = true;
      const paid = isPaid(db, uuid);
      const verified = isKeyVerified(db, uuid);
      if (!linked || !paid || !verified) continue;

      attempted += 1;

      // Record attempt event (helps postmortems).
      try {
        db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
          .run(crypto.randomUUID(), ts0, 'delivery', uuid, 'CUTOVER_RECONCILER_ATTEMPT', JSON.stringify({ uuid, paid, verified }));
      } catch {}

      let out = null;
      try { out = tryCutoverDelivered(db, uuid, { reason: 'cutover_reconciler' }); } catch (e) { out = { ok:false, error: e?.message || 'cutover_failed' }; }

      if (out && out.ok && out.delivered) delivered += 1;

      // Record result summary.
      try {
        db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
          .run(crypto.randomUUID(), nowIso(), 'delivery', uuid, 'CUTOVER_RECONCILER_RESULT', JSON.stringify({ uuid, out }));
      } catch {}
    }

    try {
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), nowIso(), 'ops', 'cutover_reconciler', 'CUTOVER_RECONCILER_RUN', JSON.stringify({ attempted, delivered, limit: LIMIT }));
    } catch {}

    console.log(JSON.stringify({ ok:true, attempted, delivered, limit: LIMIT }, null, 2));
  } finally {
    try { if (fd) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

async function runPoolCleanerOnce(){
  // One-shot cleaner: sanitize DIRTY/NEEDS_VERIFY pool instances so they become allocatable again.
  // Strategy: call the existing /api/ops/pool/wa-sanitize endpoint (on the always-on bothook-api.service),
  // then mark the instance READY on success.
  const lockPath = '/tmp/bothook_pool_cleaner.lock';
  let fd = null;
  try {
    fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lockPath, String(process.pid));
  } catch {
    return;
  }

  try {
    const LIMIT = Math.max(1, Math.min(5, Number(process.env.BOTHOOK_POOL_CLEANER_LIMIT || 2)));
    const API_BASE = process.env.BOTHOOK_API_BASE || 'http://127.0.0.1:18998';
    const { db } = openDb();
    const ts0 = nowIso();

    const rows = db.prepare(
      `SELECT instance_id, public_ip, health_status, meta_json
         FROM instances
        WHERE lifecycle_status='IN_POOL'
          AND health_status IN ('DIRTY','NEEDS_VERIFY')
          AND public_ip IS NOT NULL AND public_ip != ''
        ORDER BY datetime(last_probe_at) ASC, datetime(created_at) ASC
        LIMIT 80`
    ).all() || [];

    let attempted = 0;
    let cleaned = 0;
    let failed = 0;

    for (const r of rows) {
      if (attempted >= LIMIT) break;
      const instance_id = String(r.instance_id || '').trim();
      if (!instance_id) continue;
      if (instance_id === 'lhins-npsqfxvn') continue;

      attempted += 1;

      // Call sanitize (best-effort)
      let resp = null;
      try {
        const payload = JSON.stringify({ instance_id });
        const out = sh(`curl -s -X POST ${JSON.stringify(API_BASE + '/api/ops/pool/wa-sanitize')} -H 'content-type: application/json' --data-binary ${JSON.stringify(payload)}`, { timeoutMs: 60000 });
        resp = JSON.parse(String(out.stdout || '{}'));
      } catch (e) {
        resp = { ok:false, sanitized:false, error: String(e?.message || 'wa_sanitize_failed').slice(0,120) };
      }

      const ok = Boolean(resp?.sanitized === true);
      const ts1 = nowIso();

      try {
        db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
          .run(crypto.randomUUID(), ts1, 'instance', instance_id, ok ? 'POOL_CLEANER_OK' : 'POOL_CLEANER_FAILED', JSON.stringify({ instance_id, resp }));
      } catch {}

      if (ok) {
        cleaned += 1;
        try {
          const meta2 = mergeMeta(r.meta_json || null, { provision_ready: true, cleaned_by: 'pool_cleaner', cleaned_at: ts1, wa_sanitized_at: ts1 });
          db.prepare('UPDATE instances SET health_status=?, health_reason=?, health_source=?, last_probe_at=?, last_ok_at=?, meta_json=? WHERE instance_id=?')
            .run('READY', 'pool_cleaned', 'pool_cleaner', ts1, ts1, meta2, instance_id);
        } catch {}
      } else {
        failed += 1;
        try {
          db.prepare('UPDATE instances SET health_status=?, health_reason=?, health_source=?, last_probe_at=? WHERE instance_id=?')
            .run('NEEDS_VERIFY', 'pool_clean_failed', 'pool_cleaner', ts1, instance_id);
        } catch {}
      }
    }

    // Alerting (Telegram): only after N consecutive runs with failures, to avoid noise.
    try {
      const ALERT_AFTER = Math.max(1, Math.min(10, Number(process.env.BOTHOOK_POOL_CLEANER_ALERT_AFTER || 3)));
      const COOLDOWN_MS = Math.max(5*60*1000, Math.min(6*60*60*1000, Number(process.env.BOTHOOK_POOL_CLEANER_ALERT_COOLDOWN_MS || (30*60*1000))));
      const statePath = '/home/ubuntu/.openclaw/workspace/control-plane/data/pool_cleaner_alert_state.json';
      let st = { consecutiveFailRuns: 0, lastAlertAt: null };
      try { st = JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}'); } catch {}
      if (!st || typeof st !== 'object') st = { consecutiveFailRuns: 0, lastAlertAt: null };

      if (failed > 0) st.consecutiveFailRuns = Number(st.consecutiveFailRuns || 0) + 1;
      else st.consecutiveFailRuns = 0;

      const nowMs = Date.now();
      const lastAlertMs = st.lastAlertAt ? Date.parse(String(st.lastAlertAt)) : 0;
      const canAlert = (!lastAlertMs) || (Number.isFinite(lastAlertMs) && (nowMs - lastAlertMs >= COOLDOWN_MS));

      if (failed > 0 && st.consecutiveFailRuns >= ALERT_AFTER && canAlert) {
        // Load Telegram credentials from env file (no secrets logged)
        const envFile = process.env.TELEGRAM_ENV || '/home/ubuntu/.openclaw/credentials/telegram.env';
        let token = '';
        let chatId = '';
        try {
          const raw = fs.readFileSync(envFile, 'utf8');
          for (const line of raw.split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#') || !t.includes('=')) continue;
            const [k, ...rest] = t.split('=');
            const v = rest.join('=').trim();
            if (k === 'TELEGRAM_BOT_TOKEN' || k === 'TELEGRAM_TOKEN') token = token || v;
            if (k === 'TELEGRAM_CHAT_ID' || k === 'OWNER_CHAT_ID') chatId = chatId || v;
          }
        } catch {}

        if (token && chatId) {
          const text = `[bothook][pool-cleaner][WARN] sanitize failures detected\n` +
            `runs_with_failures=${st.consecutiveFailRuns} (alert_after=${ALERT_AFTER})\n` +
            `attempted=${attempted} cleaned=${cleaned} failed=${failed} limit=${LIMIT}\n` +
            `action: investigate instances with health_status=NEEDS_VERIFY (recent POOL_CLEANER_FAILED events)`;
          try {
            sh(`curl -s -X POST https://api.telegram.org/bot${token}/sendMessage -d chat_id=${chatId} -d text=${JSON.stringify(text)} >/dev/null`, { timeoutMs: 15000 });
            st.lastAlertAt = new Date().toISOString();
          } catch {}
        }
      }

      try { fs.writeFileSync(statePath, JSON.stringify(st, null, 2) + '\n'); } catch {}
    } catch {}

    try {
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), nowIso(), 'ops', 'pool_cleaner', 'POOL_CLEANER_RUN', JSON.stringify({ attempted, cleaned, failed, limit: LIMIT }));
    } catch {}

    console.log(JSON.stringify({ ok:true, attempted, cleaned, limit: LIMIT }, null, 2));
  } finally {
    try { if (fd) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

async function runSubscriptionReconcilerOnce(){
  // One-shot subscription reconciler: backfill subscriptions rows for paid/delivered users when webhook upsert was missed.
  // Scope: only fix anomalies (paid_at exists + stripe_event_id exists + no subscriptions row).
  const lockPath = '/tmp/bothook_subscription_reconciler.lock';
  let fd = null;
  try {
    fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lockPath, String(process.pid));
  } catch {
    return;
  }

  try {
    const LIMIT = Math.max(1, Math.min(5, Number(process.env.BOTHOOK_SUB_RECONCILER_LIMIT || 3)));
    const secret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
    if (!secret) {
      console.log(JSON.stringify({ ok:false, error:'stripe_not_configured' }));
      return;
    }

    const { db } = openDb();
    const ts0 = nowIso();

    const rows = db.prepare(
      `SELECT d.provision_uuid AS uuid,
              d.delivery_id AS delivery_id,
              json_extract(d.meta_json,'$.stripe_event_id') AS stripe_event_id,
              json_extract(d.meta_json,'$.paid_at') AS paid_at
         FROM deliveries d
        WHERE d.status IN ('PAID','DELIVERED')
          AND json_extract(d.meta_json,'$.stripe_event_id') IS NOT NULL
          AND datetime(COALESCE(json_extract(d.meta_json,'$.paid_at'), d.updated_at)) >= datetime('now','-7 days')
        ORDER BY datetime(COALESCE(json_extract(d.meta_json,'$.paid_at'), d.updated_at)) DESC
        LIMIT 120`
    ).all() || [];

    let attempted = 0;
    let fixed = 0;
    let skipped = 0;

    for (const r of rows) {
      if (attempted >= LIMIT) break;

      const uuid = String(r.uuid || '').trim();
      const delivery_id = String(r.delivery_id || '').trim();
      const evt = String(r.stripe_event_id || '').trim();
      if (!uuid || !delivery_id || !evt.startsWith('evt_')) { skipped += 1; continue; }

      // Only fix when subscriptions row is missing.
      const hasSub = db.prepare("SELECT provider_sub_id FROM subscriptions WHERE user_id=? AND provider='stripe' ORDER BY datetime(updated_at) DESC LIMIT 1").get(uuid);
      if (hasSub?.provider_sub_id) { skipped += 1; continue; }

      attempted += 1;

      let ok = false;
      let subId = null;
      let err = null;
      try {
        const resp = await fetch(`https://api.stripe.com/v1/events/${encodeURIComponent(evt)}`, {
          headers: { authorization: `Bearer ${secret}` }
        });
        const j = await resp.json().catch(()=>null);
        if (!resp.ok || !j) throw new Error(`stripe_event_fetch_failed_${resp.status}`);
        const obj = (j.data || {}).object || {};
        subId = obj.subscription || null;
        if (!subId) throw new Error('missing_subscription_id');

        const createdAt = String(r.paid_at || ts0);
        db.prepare(
          `INSERT INTO subscriptions(provider_sub_id, provider, user_id, plan, status, current_period_end, cancel_at, canceled_at, ended_at, cancel_at_period_end, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(provider_sub_id) DO UPDATE SET
             status=excluded.status,
             user_id=excluded.user_id,
             plan=excluded.plan,
             updated_at=excluded.updated_at`
        ).run(String(subId), 'stripe', String(uuid), 'standard', 'active', null, null, null, null, 0, createdAt, createdAt);

        ok = true;
        fixed += 1;
      } catch (e) {
        err = String(e?.message || e).slice(0,200);
      }

      try {
        db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
          .run(crypto.randomUUID(), nowIso(), 'delivery', delivery_id, ok ? 'SUB_RECONCILE_OK' : 'SUB_RECONCILE_FAILED', JSON.stringify({ uuid, delivery_id, stripe_event_id: evt, provider_sub_id: subId, error: err }));
      } catch {}
    }

    try {
      db.prepare('INSERT OR IGNORE INTO events(event_id, ts, entity_type, entity_id, event_type, payload_json) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), nowIso(), 'ops', 'sub_reconciler', 'SUB_RECONCILER_RUN', JSON.stringify({ attempted, fixed, skipped, limit: LIMIT }));
    } catch {}

    console.log(JSON.stringify({ ok:true, attempted, fixed, skipped, limit: LIMIT }, null, 2));
  } finally {
    try { if (fd) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

if (String(process.env.BOTHOOK_OUTBOUND_WORKER || '') === '1') {
  runOutboundWorkerLoop().then(()=>process.exit(0)).catch(()=>process.exit(0));
} else if (String(process.env.BOTHOOK_OPS_WORKER || '') === '1') {
  runOpsWorkerLoop().then(()=>process.exit(0)).catch(()=>process.exit(0));
} else if (String(process.env.BOTHOOK_CUTOVER_RECONCILER || '') === '1') {
  runCutoverReconcilerOnce().then(()=>process.exit(0)).catch(()=>process.exit(0));
} else if (String(process.env.BOTHOOK_POOL_CLEANER || '') === '1') {
  runPoolCleanerOnce().then(()=>process.exit(0)).catch(()=>process.exit(0));
} else if (String(process.env.BOTHOOK_SUB_RECONCILER || '') === '1') {
  runSubscriptionReconcilerOnce().then(()=>process.exit(0)).catch(()=>process.exit(0));
} else {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[bothook-api] listening on 127.0.0.1:${PORT}`);
  });
}
