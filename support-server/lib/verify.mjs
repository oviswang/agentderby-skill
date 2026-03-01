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
  // Placeholder: always returns inconclusive.
  return {
    ok: false,
    verified: false,
    mode: 'placeholder',
    dbPath: dbPath || null,
    uuid: uuid || null,
    waE164: waE164 || null,
    reason: 'not_implemented'
  };
}
