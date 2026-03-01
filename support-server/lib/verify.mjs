/**
 * verify.mjs (placeholder skeleton)
 *
 * Purpose:
 * - Normalize WhatsApp phone number to E.164
 * - Verify (uuid, wa_e164) binding against control-plane SQLite (deliveries.wa_jid)
 *
 * NOTE: Skeleton only; implementation filled in later segments.
 */

export function normalizeE164(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, e164: null, error: 'wa_required' };
  // Minimal: accept +<digits>
  const m = raw.match(/^\+\d{6,18}$/);
  if (!m) return { ok: false, e164: null, error: 'wa_must_be_e164' };
  return { ok: true, e164: raw, error: null };
}

export async function verifyUuidWaBinding({ dbPath, uuid, waE164 }) {
  const safeUuid = String(uuid || '').trim();
  const safeWa = String(waE164 || '').trim();
  const safeDb = String(dbPath || '/home/ubuntu/.openclaw/workspace/control-plane/data/bothook.sqlite').trim();

  if (!/^[a-f0-9-]{16,64}$/i.test(safeUuid)) {
    return { ok: false, verified: false, mode: 'sqlite3_cli', reason: 'uuid_invalid', uuid: safeUuid, waE164: safeWa };
  }
  if (!/^\+\d{6,18}$/.test(safeWa)) {
    return { ok: false, verified: false, mode: 'sqlite3_cli', reason: 'wa_invalid', uuid: safeUuid, waE164: safeWa };
  }

  // Read from control-plane SQLite via sqlite3 CLI (no node native deps).
  // Table: deliveries(provision_uuid, wa_jid)
  let waJid = '';
  try {
    const { spawnSync } = await import('node:child_process');
    const q = `SELECT wa_jid FROM deliveries WHERE provision_uuid='${safeUuid}' LIMIT 1;`;
    const r = spawnSync('sqlite3', [safeDb, q], { encoding: 'utf8', timeout: 2500 });
    if (r.error) {
      return { ok: false, verified: false, mode: 'sqlite3_cli', reason: 'sqlite3_error', detail: String(r.error.message || r.error), uuid: safeUuid, waE164: safeWa };
    }
    if (r.status !== 0) {
      return { ok: false, verified: false, mode: 'sqlite3_cli', reason: 'sqlite3_failed', detail: String(r.stderr || '').slice(0, 200), uuid: safeUuid, waE164: safeWa };
    }
    waJid = String(r.stdout || '').trim();
  } catch (e) {
    return { ok: false, verified: false, mode: 'sqlite3_cli', reason: 'spawn_failed', detail: String(e?.message || e), uuid: safeUuid, waE164: safeWa };
  }

  if (!waJid) {
    // Not linked yet.
    return { ok: true, verified: false, mode: 'sqlite3_cli', reason: 'wa_not_bound', uuid: safeUuid, waE164: safeWa };
  }

  // wa_jid examples: "6583441737:2@s.whatsapp.net"
  const left = String(waJid).split('@')[0];
  const num = left.split(':')[0];
  const expectedE164 = num ? ('+' + num) : '';

  if (!expectedE164 || !/^\+\d{6,18}$/.test(expectedE164)) {
    return { ok: false, verified: false, mode: 'sqlite3_cli', reason: 'wa_jid_unparseable', uuid: safeUuid, waE164: safeWa, wa_jid: waJid };
  }

  if (expectedE164 !== safeWa) {
    return { ok: true, verified: false, mode: 'sqlite3_cli', reason: 'wa_mismatch', uuid: safeUuid, waE164: safeWa, expectedE164, wa_jid: waJid };
  }

  return { ok: true, verified: true, mode: 'sqlite3_cli', reason: 'verified', uuid: safeUuid, waE164: safeWa, expectedE164, wa_jid: waJid };
}
