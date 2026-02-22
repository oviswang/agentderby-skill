#!/usr/bin/env node
/* BOTHook provisioning server (OpenClaw single-login model)
 *
 * This implements the owner-required WhatsApp login model:
 * - The ONLY login mechanism is: `openclaw channels login --channel whatsapp`
 * - Success is determined ONLY by: `openclaw channels status`
 * - Web/API is display/control only: it does NOT run a second login mechanism
 *
 * Endpoints (local-only, 127.0.0.1):
 * - GET  /healthz
 * - POST /api/wa/start { uuid, force }
 * - GET  /api/wa/qr?uuid=...
 * - GET  /api/wa/status?uuid=...
 *
 * Notes:
 * - We run one login PTY process per uuid.
 * - We parse the ANSI/TTY output for the ASCII QR blocks ("▄▄▄" borders).
 * - We convert the ASCII QR to a PNG data URL for stable scanning in browsers.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import express from 'express';
import pty from 'node-pty';
import { PNG } from 'pngjs';

const DATA_DIR = process.env.PROVISION_DATA_DIR || '/opt/bothook/provision/data';
const PORT = parseInt(process.env.PROVISION_PORT || '18999', 10);
const HOST = process.env.PROVISION_HOST || '127.0.0.1';

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/ubuntu';
const OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.join(OPENCLAW_HOME, '.openclaw');
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(OPENCLAW_STATE_DIR, 'openclaw.json');

const LOGIN_DEDUP_MS = parseInt(process.env.PROVISION_LOGIN_DEDUP_MS || '15000', 10);
const QR_PARSE_INTERVAL_MS = parseInt(process.env.PROVISION_QR_PARSE_INTERVAL_MS || '800', 10);

function nowIso(){ return new Date().toISOString(); }

function safeUuid(s) {
  const x = String(s || '').trim();
  if (!x) return null;
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(x)) return null;
  return x;
}

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }

function sh(cmd, { timeoutMs = 8000 } = {}) {
  const res = spawnSync('bash', ['-lc', cmd], {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env, HOME: OPENCLAW_HOME, OPENCLAW_STATE_DIR }
  });
  return { code: res.status ?? 0, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function stopGateway(){
  // Avoid login competition. Must be fast/non-blocking.
  // systemctl can hang on some systems; bound it hard.
  sh('timeout 2 systemctl stop openclaw-gateway.service || true', { timeoutMs: 4000 });
  sh('timeout 2 systemctl --user stop openclaw-gateway.service || true', { timeoutMs: 4000 });
}

function startGateway(){
  sh('timeout 2 systemctl start openclaw-gateway.service || true', { timeoutMs: 4000 });
  sh('timeout 2 systemctl --user start openclaw-gateway.service || true', { timeoutMs: 4000 });
}

function stripAnsi(s){
  return String(s).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

function extractQrBlocksFromLines(lines){
  // Find blocks starting with a line of "▄▄▄" and ending with another such line.
  // Keep all complete blocks.
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const l = String(line).replace(/\s+$/,'');
    const isBorder = l.startsWith('▄▄▄▄') && l.includes('▄');
    if (isBorder) {
      if (!cur) cur = [l];
      else {
        cur.push(l);
        blocks.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur) {
      if (l.length > 0) cur.push(l);
    }
  }
  return blocks;
}

function asciiQrToPngDataUrl(blockLines, { scale = 6, border = 2 } = {}) {
  // Convert the ASCII QR (with box drawing chars) to a monochrome PNG.
  // Heuristic: treat any non-space char as black.
  const lines = blockLines.slice();
  const w = Math.max(...lines.map(l => l.length));
  const h = lines.length;

  const imgW = (w + border*2) * scale;
  const imgH = (h + border*2) * scale;
  const png = new PNG({ width: imgW, height: imgH });

  function setPixel(x,y,r,g,b,a=255){
    const idx = (png.width*y + x) << 2;
    png.data[idx]=r; png.data[idx+1]=g; png.data[idx+2]=b; png.data[idx+3]=a;
  }

  // fill white
  for (let y=0;y<imgH;y++) for (let x=0;x<imgW;x++) setPixel(x,y,255,255,255,255);

  for (let yy=0; yy<h; yy++) {
    const line = lines[yy].padEnd(w, ' ');
    for (let xx=0; xx<w; xx++) {
      const ch = line[xx];
      const black = (ch !== ' ');
      if (!black) continue;
      const px0 = (xx + border) * scale;
      const py0 = (yy + border) * scale;
      for (let sy=0; sy<scale; sy++) {
        for (let sx=0; sx<scale; sx++) {
          setPixel(px0+sx, py0+sy, 0,0,0,255);
        }
      }
    }
  }

  const buf = PNG.sync.write(png);
  return 'data:image/png;base64,' + buf.toString('base64');
}

function parseWhatsappStatus(text){
  const t = stripAnsi(text);
  const lower = t.toLowerCase();
  const connected = lower.includes('connected') || lower.includes('ready');
  // very rough; we mainly need a boolean.
  return { connected, raw: t.trim() };
}

const sessions = new Map();
// uuid -> { pty, buf, lastQrDataUrl, lastQrAt, lastLoginAt, status, lastStatusAt, lastStatusRaw, qrSeq, _pendingQr, _lastQrHash }

function ensureSession(uuid){
  let s = sessions.get(uuid);
  if (!s) {
    s = {
      pty: null,
      buf: '',
      lastQrDataUrl: null,
      lastQrAt: null,
      lastLoginAt: 0,
      status: false,
      lastStatusAt: null,
      lastStatusRaw: null,
      qrSeq: 0,
      _pendingQr: false,
      _lastQrHash: null,
    };
    sessions.set(uuid, s);
  }
  return s;
}

function killLogin(uuid){
  const s = sessions.get(uuid);
  if (s?.pty) {
    try { s.pty.kill(); } catch {}
  }
  if (s) {
    s.pty = null;
    s.buf = '';
    s.lastQrDataUrl = null;
    s.lastQrAt = null;
    s.qrSeq = 0;
  }
}

function startLogin(uuid, { force=false } = {}){
  const s = ensureSession(uuid);
  const now = Date.now();
  if (!force && s.pty && (now - s.lastLoginAt) < LOGIN_DEDUP_MS) {
    return;
  }

  // enforce single-login model: stop gateway first.
  stopGateway();

  if (force) {
    // wipe whatsapp auth dir to force new QR rotation from scratch
    const authDir = path.join(OPENCLAW_STATE_DIR, 'channels', 'whatsapp');
    try { fs.rmSync(authDir, { recursive:true, force:true }); } catch {}
  }

  killLogin(uuid);
  s.lastLoginAt = now;

  // Use PTY so OpenClaw prints rotating QR blocks.
  const env = {
    ...process.env,
    HOME: OPENCLAW_HOME,
    OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH,
    // make logs more deterministic
    FORCE_COLOR: '0'
  };

  const term = pty.spawn('bash', ['-lc', 'openclaw channels login --channel whatsapp'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: OPENCLAW_HOME,
    env
  });

  s.pty = term;
  s.buf = '';

  term.onData((d) => {
    // Only append; do NOT parse/encode QR in the hot path (it can block the event loop).
    s.buf += d;
    // keep buffer bounded (tail only) to avoid heavy parsing work
    if (s.buf.length > 60000) s.buf = s.buf.slice(-30000);
    s._pendingQr = true;
  });

  term.onExit(() => {
    s.pty = null;
    // do not auto-restart here; UI can call start again.
  });
}

function pollStatus(uuid){
  const s = ensureSession(uuid);
  const r = sh('openclaw channels status', { timeoutMs: 5000 });
  const out = (r.stdout || r.stderr || '').trim();
  const st = parseWhatsappStatus(out);
  s.status = Boolean(st.connected);
  s.lastStatusRaw = st.raw;
  s.lastStatusAt = nowIso();
  if (s.status) {
    // Once connected, gateway can be started.
    startGateway();
  }
}

setInterval(() => {
  // poll status for active sessions only
  for (const [uuid, s] of sessions.entries()) {
    if (s.pty || s.lastQrDataUrl) {
      try { pollStatus(uuid); } catch {}
    }
  }
}, 2500);

// Parse latest QR from PTY output at a fixed interval to avoid event-loop stalls.
setInterval(() => {
  for (const [uuid, s] of sessions.entries()) {
    if (!s._pendingQr) continue;
    s._pendingQr = false;

    try {
      const tailLines = stripAnsi(s.buf).split(/\r?\n/).slice(-240);
      const blocks = extractQrBlocksFromLines(tailLines);
      if (!blocks.length) continue;
      const last = blocks[blocks.length - 1];
      const h = crypto.createHash('sha1').update(last.join('\n')).digest('hex');
      if (s._lastQrHash === h) continue;
      s._lastQrHash = h;

      // Generate PNG data URL (bounded workload)
      // Keep PNG generation cheap; browser scanning doesn't need huge scale.
      s.lastQrDataUrl = asciiQrToPngDataUrl(last, { scale: 3, border: 2 });
      s.lastQrAt = nowIso();
      s.qrSeq += 1;
    } catch {
      // ignore
    }
  }
}, QR_PARSE_INTERVAL_MS);

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok:true }));

app.post('/api/wa/start', async (req, res) => {
  try {
    const uuid = safeUuid(req.body?.uuid);
    if (!uuid) return res.status(400).json({ ok:false, error:'uuid_required' });
    const force = Boolean(req.body?.force);

    startLogin(uuid, { force });
    return res.json({ ok:true, uuid, status:'starting' });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'server_error' });
  }
});

app.get('/api/wa/qr', async (req, res) => {
  try {
    const uuid = safeUuid(req.query?.uuid);
    if (!uuid) return res.status(400).json({ ok:false, error:'uuid_required' });

    const s = ensureSession(uuid);
    if (!s.lastQrDataUrl) {
      return res.status(409).json({ ok:false, error:'qr_not_ready' });
    }
    return res.json({ ok:true, uuid, status:'qr', qrDataUrl: s.lastQrDataUrl, qrSeq: s.qrSeq, qrAt: s.lastQrAt });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'server_error' });
  }
});

app.get('/api/wa/status', async (req, res) => {
  try {
    const uuid = safeUuid(req.query?.uuid);
    if (!uuid) return res.status(400).json({ ok:false, error:'uuid_required' });

    const s = ensureSession(uuid);
    return res.json({
      ok:true,
      uuid,
      status: s.status ? 'connected' : 'linking',
      connected: Boolean(s.status),
      wa_jid: null,
      lastUpdateAt: s.lastStatusAt || s.lastQrAt || null,
      qrSeq: s.qrSeq,
      qrAt: s.lastQrAt || null
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'server_error' });
  }
});

app.listen(PORT, HOST, () => {
  ensureDir(DATA_DIR);
  console.log(`[bothook-provision] openclaw-login model listening on ${HOST}:${PORT} (state=${OPENCLAW_STATE_DIR})`);
});
