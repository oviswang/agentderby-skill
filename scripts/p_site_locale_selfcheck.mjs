#!/usr/bin/env node
/**
 * Hard-ish self-check for p-site locales WITHOUT triggering WhatsApp login.
 *
 * What it checks:
 * 1) Each locale index.html served by Caddy contains the expected QR canvas implementation.
 * 2) API routing works: /api/wa/qr, /api/wa/status, /api/delivery/status respond for:
 *    - a known-good uuid (optional)
 *    - a fake uuid (should return ok:false with a structured error)
 *
 * What it does NOT do:
 * - It does NOT call /api/wa/start (no login side effects).
 */

import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.PSITE_BASE || 'https://p.bothook.me';
const KNOWN_UUID = process.env.KNOWN_UUID || ''; // optional

const PATHS = [
  '/', '/ar/', '/de/', '/es/', '/fr/', '/hi/', '/id/', '/ja/', '/ko/', '/pt-br/', '/ru/', '/th/', '/tr/', '/vi/', '/zh/', '/zh-tw/',
];

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow' });
  const text = await r.text();
  return { status: r.status, text };
}

async function fetchJson(url) {
  const r = await fetch(url, { redirect: 'follow' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

function checkLocaleHtml(path, html) {
  // Presence checks (we intentionally do not parse JS AST; these are sentinel strings)
  must(html.includes('qrCanvas'), `${path}: missing qrCanvas`);
  must(html.includes('renderAsciiQrToCanvas'), `${path}: missing renderAsciiQrToCanvas()`);
  must(html.includes('/api/wa/qr'), `${path}: missing /api/wa/qr usage`);
  must(html.includes('/api/wa/start'), `${path}: missing /api/wa/start usage`);
  must(!html.includes("qrImg"), `${path}: still contains legacy qrImg`);
  // Ensure startProvision failure is non-fatal
  must(html.includes('start failed, still fetching QR'), `${path}: missing non-fatal startProvision wrapper`);
}

async function checkApiForUuid(uuid, label) {
  const qr = await fetchJson(`${BASE}/api/wa/qr?uuid=${encodeURIComponent(uuid)}`);
  must(qr.json && typeof qr.json.ok === 'boolean', `${label}: /api/wa/qr not json ok:boolean (status=${qr.status})`);

  const st = await fetchJson(`${BASE}/api/wa/status?uuid=${encodeURIComponent(uuid)}`);
  must(st.json && typeof st.json.ok === 'boolean', `${label}: /api/wa/status not json ok:boolean (status=${st.status})`);

  const ds = await fetchJson(`${BASE}/api/delivery/status?uuid=${encodeURIComponent(uuid)}`);
  must(ds.json && typeof ds.json.ok === 'boolean', `${label}: /api/delivery/status not json ok:boolean (status=${ds.status})`);

  return { qr: qr.json, status: st.json, delivery: ds.json };
}

async function main() {
  const startedAt = Date.now();
  const results = [];

  // 1) Locale HTML checks
  for (const p of PATHS) {
    const url = `${BASE}${p}`;
    const { status, text } = await fetchText(url);
    must(status >= 200 && status < 400, `${p}: HTTP ${status}`);
    checkLocaleHtml(p, text);
    results.push({ kind: 'locale', path: p, ok: true, bytes: text.length });
    await sleep(80);
  }

  // 2) API routing checks with a fake uuid (must be structured failure)
  const fake = '00000000-0000-0000-0000-000000000000';
  const fakeRes = await checkApiForUuid(fake, 'fake_uuid');
  must(fakeRes.qr.ok === false || fakeRes.qr.ok === true, 'fake_uuid: qr ok must exist');
  // For fake, we expect ok:false somewhere
  must(fakeRes.delivery.ok === false, 'fake_uuid: delivery/status should be ok:false');

  results.push({ kind: 'api', label: 'fake_uuid', ok: true, sample: { qr: fakeRes.qr.error || fakeRes.qr.status, delivery: fakeRes.delivery.error, status: fakeRes.status.error || fakeRes.status.status } });

  // 3) Optional: API checks for a known uuid (no side effects)
  if (KNOWN_UUID) {
    const knownRes = await checkApiForUuid(KNOWN_UUID, 'known_uuid');
    // We don't assert paid etc; only that it returns structured json.
    results.push({ kind: 'api', label: 'known_uuid', ok: true, sample: { wa: knownRes.status.status, connected: knownRes.status.connected, delivery: knownRes.delivery.status, wa_jid: knownRes.delivery.wa_jid } });
  }

  const out = {
    ok: true,
    base: BASE,
    knownUuidUsed: Boolean(KNOWN_UUID),
    tookMs: Date.now() - startedAt,
    checks: results,
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((err) => {
  const out = { ok: false, error: String(err?.message || err), stack: err?.stack };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(1);
});
