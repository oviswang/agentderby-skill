#!/usr/bin/env node
/* Minimal E2E smoketest (no human) for BOTHook control-plane.
 * Requires BOTHOOK_TEST_MODE=1 on bothook-api.service.
 */

import crypto from 'node:crypto';

const BASE = process.env.BOTHOOK_API_BASE || 'http://127.0.0.1:18998';

async function req(method, path, body) {
  const url = BASE + path;
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function getOutbox(uuid){
  const r = await fetch(`${BASE}/api/test/outbox?uuid=${encodeURIComponent(uuid)}`);
  const j = await r.json();
  return j.items || [];
}

async function waitForKind(uuid, kind, { timeoutMs = 8000, stepMs = 300 } = {}){
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const items = await getOutbox(uuid);
    const hit = items.find(x => x.kind === kind);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error(`timeout waiting for outbox kind=${kind}`);
}

async function main(){
  const uuid = crypto.randomUUID();
  console.log('uuid', uuid);

  // Ensure delivery exists and is allocated (best-effort).
  const s = await req('POST', '/api/wa/start', { uuid, force: false });
  console.log('wa_start', s.status, s.json?.ok, s.json?.status);
  if (!s.json?.ok) process.exit(2);

  await req('POST', '/api/test/wa/link', { uuid, wa_e164: '+10000000000', wa_jid: 'test@wa' });
  const w = await waitForKind(uuid, 'welcome_linked');
  console.log('welcome_linked', w.ts, w.text_hash);

  await req('POST', '/api/test/pay/confirm', { uuid });
  const p = await waitForKind(uuid, 'guide_paid');
  console.log('guide_paid', p.ts, p.text_hash);

  await req('POST', '/api/test/openai/key_verified', { uuid, ok: true });
  const k = await waitForKind(uuid, 'key_verified_success');
  console.log('key_verified_success', k.ts, k.text_hash);

  console.log('SMOKE_OK');
}

main().catch((e) => {
  console.error('SMOKE_FATAL', e?.stack || e);
  process.exit(1);
});
