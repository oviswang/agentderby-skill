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
  const baseEnv = { ...process.env };
  // Ensure systemd services can find tmux/openclaw.
  baseEnv.PATH = baseEnv.PATH || '';
  if (!baseEnv.PATH.includes('/home/ubuntu/.npm-global/bin')) {
    baseEnv.PATH = `/home/ubuntu/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${baseEnv.PATH}`;
  }

  const res = spawnSync('bash', ['-lc', cmd], {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...baseEnv, HOME: OPENCLAW_HOME, OPENCLAW_STATE_DIR }
  });
  return { code: res.status ?? 0, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function startGateway(){
  sh('timeout 2 systemctl start openclaw-gateway.service || true', { timeoutMs: 4000 });
  sh('timeout 2 systemctl --user start openclaw-gateway.service || true', { timeoutMs: 4000 });
}

function tmuxHasSession(name){
  const r = sh(`tmux has-session -t ${JSON.stringify(name)} 2>/dev/null`, { timeoutMs: 2000 });
  return r.code === 0;
}

function tmuxProbe(){
  const r = sh('tmux -V; tmux ls 2>&1 || true', { timeoutMs: 2000 });
  return (r.stdout || r.stderr || '').trim();
}

function tmuxKillSession(name){
  sh(`tmux kill-session -t ${JSON.stringify(name)} 2>/dev/null || true`, { timeoutMs: 3000 });
}

function tmuxStartLoginSession(uuid, { force=false } = {}){
  const session = `wa-${uuid}`;

  if (force) {
    // wipe whatsapp auth dir to force new QR rotation from scratch
    const authDir = path.join(OPENCLAW_STATE_DIR, 'channels', 'whatsapp');
    try { fs.rmSync(authDir, { recursive:true, force:true }); } catch {}
    tmuxKillSession(session);
  }

  if (tmuxHasSession(session)) return { ok:true, session, reused:true };

  const OPENCLAW_BIN = process.env.OPENCLAW_BIN || path.join(OPENCLAW_HOME, '.npm-global', 'bin', 'openclaw');
  const cmd = `${OPENCLAW_BIN} channels login --channel whatsapp`;

  // Start gateway to ensure plugin environment is ready.
  try { startGateway(); } catch {}

  // Launch in tmux to ensure a real terminal.
  const r = sh(`tmux new-session -d -s ${JSON.stringify(session)} -x 200 -y 60 ${JSON.stringify(cmd)}`, { timeoutMs: 4000 });
  if (r.code !== 0) {
    return {
      ok:false,
      session,
      error: `tmux new-session failed (code=${r.code})`,
      stdout: (r.stdout||'').slice(-2000),
      stderr: (r.stderr||'').slice(-2000),
      probe: tmuxProbe()
    };
  }

  return { ok:true, session, reused:false };
}

function tmuxCaptureTail(uuid, lines=320){
  const session = `wa-${uuid}`;
  // Use capture-pane output directly.
  // NOTE: `tmux show-buffer` requires a prior `tmux save-buffer`; the previous implementation
  // could return empty output and prevent QR parsing.
  const r = sh(`tmux capture-pane -pt ${JSON.stringify(session)} -S -${lines} 2>/dev/null`, { timeoutMs: 4000 });
  if (r.code !== 0) return '';
  return r.stdout || '';
}

function stripAnsi(s){
  return String(s).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

function extractQrBlocksFromLines(lines){
  // Extract QR blocks from OpenClaw terminal output.
  // Supported formats:
  // 1) Bordered blocks (common): a top border line starting with "▄▄▄▄" and an ending border line.
  // 2) Unclosed/tail-only blocks: we may capture only the top border + body without the closing border.
  //    In that case, treat a sufficiently tall block as usable.
  const blocks = [];
  let cur = null;
  let seenRows = 0;
  for (const line of lines) {
    const l = String(line).replace(/\s+$/,'');
    const isBorder = l.startsWith('▄▄▄▄') && l.includes('▄');

    if (isBorder) {
      if (!cur) {
        cur = [l];
        seenRows = 0;
      } else {
        cur.push(l);
        blocks.push(cur);
        cur = null;
        seenRows = 0;
      }
      continue;
    }

    if (cur) {
      if (l.length > 0) {
        cur.push(l);
        // Count QR-ish rows (box drawing / block glyphs). Helps decide if partial capture is usable.
        if (/[█▄▀]{5,}/.test(l) || l.includes('█') || l.includes('▄') || l.includes('▀')) {
          seenRows += 1;
        }
      }
    }
  }

  // If we ended while inside a block (no closing border), accept it if it looks complete enough.
  if (cur && seenRows >= 20) {
    blocks.push(cur);
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

  // We treat "linked" as sufficient signal that login succeeded.
  // After login, the gateway may still be stopped (we start it once we detect this).
  const linked = lower.includes('linked') && !lower.includes('not linked');
  const connected = linked || lower.includes('connected') || lower.includes('ready');

  return { connected, raw: t.trim() };
}

const sessions = new Map();
// uuid -> { pty, buf, lastQrDataUrl, lastQrAt, lastLoginAt, status, lastStatusAt, lastStatusRaw, qrSeq, welcomeSentAt, _pendingQr, _lastQrHash, lastError, lastExit, loginMode, lastStartAt }

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
      welcomeSentAt: null,
      _pendingQr: false,
      _lastQrHash: null,
      lastError: null,
      lastExit: null,
      _logPath: null,
      loginMode: null,
      lastStartAt: null,
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

  // Preflight tmux availability (surface failures to status instead of silently looping).
  try {
    const pr = sh('tmux -V', { timeoutMs: 1500 });
    if ((pr.code ?? 1) !== 0) {
      s.lastError = `tmux preflight failed (code=${pr.code})\nstdout:\n${(pr.stdout||'').slice(-400)}\nstderr:\n${(pr.stderr||'').slice(-800)}`;
      s.lastExit = { stage: 'tmux_preflight', at: nowIso() };
      return;
    }
  } catch (e) {
    s.lastError = `tmux preflight exception: ${String(e?.message||e)}`;
    s.lastExit = { stage: 'tmux_preflight', at: nowIso() };
    return;
  }

  // IMPORTANT: keep gateway running.
  // Stopping the gateway can prevent WhatsApp QR generation under this deployment model.
  setTimeout(() => { try { startGateway(); } catch {} }, 0);

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

  // Use absolute openclaw path + explicit PATH to avoid `command not found`
  // under systemd environments.
  const OPENCLAW_BIN = process.env.OPENCLAW_BIN || path.join(OPENCLAW_HOME, '.npm-global', 'bin', 'openclaw');
  env.PATH = `${path.dirname(OPENCLAW_BIN)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

  // Preflight: verify OPENCLAW_BIN is executable in this environment.
  try {
    const v = sh(`${OPENCLAW_BIN} --version`, { timeoutMs: 3000 });
    if (v.code !== 0) {
      s.lastError = `openclaw preflight failed (code=${v.code})\nstdout:\n${(v.stdout||'').slice(-800)}\nstderr:\n${(v.stderr||'').slice(-800)}`;
    }
  } catch (e) {
    s.lastError = `openclaw preflight exception: ${String(e?.message||e)}`;
  }

  // Use tmux to run login in a real terminal session.
  // This avoids OpenClaw suppressing QR output in non-terminal contexts.
  const tr = tmuxStartLoginSession(uuid, { force });
  if (!tr.ok) {
    s.lastError = JSON.stringify(tr, null, 2);
    s.lastExit = { stage: 'tmuxStartLoginSession', at: nowIso() };
    return;
  }

  // Record session info for observability.
  s.loginMode = 'tmux';
  s.lastStartAt = nowIso();
  s._tmuxSession = tr.session;
  s._tmuxReused = Boolean(tr.reused);

  s.pty = null;
  s.buf = '';
  s._logPath = null;
}

function shellReadUuidLink(uuid){
  // Best-effort: read from /opt/bothook/UUID.txt if present.
  // Fallback: construct from uuid.
  const p = '/opt/bothook/UUID.txt';
  try {
    const t = fs.readFileSync(p, 'utf8');
    const m = t.match(/https?:\/\/\S+/);
    if (m) return m[0];
  } catch {}
  return `https://p.bothook.me/p/${encodeURIComponent(uuid)}?lang=en`;
}

function getSelfE164(){
  // Prefer channels status JSON (fast, does not depend on agent auth).
  try {
    const r = sh('openclaw channels status --probe --json', { timeoutMs: 8000 });
    const raw = (r.stdout || '').trim();
    if (raw) {
      const j = JSON.parse(raw);
      const w = j?.channels?.whatsapp || j?.whatsapp || null;
      const e164 = w?.self?.e164 ? String(w.self.e164) : null;
      if (e164 && e164.startsWith('+')) return e164;
    }
  } catch {}

  // Fallback: parse from `openclaw status --json --deep` channelSummary line.
  try {
    const r = sh('openclaw status --json --deep', { timeoutMs: 8000 });
    const raw = (r.stdout || '').trim();
    if (!raw) return null;
    const j = JSON.parse(raw);
    const arr = Array.isArray(j.channelSummary) ? j.channelSummary : [];
    for (const line of arr) {
      const m = String(line).match(/WhatsApp:\s+linked\s+(\+\d{6,20})/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

function sendWelcomeIfNeeded(uuid){
  const s = ensureSession(uuid);
  if (s.welcomeSentAt) return;

  const self = getSelfE164();
  if (!self) return;

  const link = shellReadUuidLink(uuid);
  const msg = [
    '[bothook] Linked ✅',
    '',
    'Next step:',
    `1) Open: ${link}`,
    '2) Follow the setup steps (payment + OpenAI key) shown on the page.',
    '',
    'If you need to relink later, you can come back to the same UUID page and scan again.'
  ].join('\n');

  // Use OpenClaw to send a self-chat message.
  const cmd = `openclaw message send --channel whatsapp --target ${self} --message ${JSON.stringify(msg)} --json`;
  const r = sh(cmd, { timeoutMs: 10000 });
  if ((r.stdout || '').includes('"ok":true')) {
    s.welcomeSentAt = nowIso();
  }
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
    // Autoresponder/onboarding: send welcome + relink guidance to self-chat (best-effort).
    try { sendWelcomeIfNeeded(uuid); } catch {}
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

// Parse latest QR from terminal output at a fixed interval to avoid event-loop stalls.
setInterval(() => {
  for (const [uuid, s] of sessions.entries()) {
    if (s.loginMode !== 'tmux') continue;

    try {
      const text = tmuxCaptureTail(uuid, 420);
      if (!text) continue;

      const tailLines = stripAnsi(text).split(/\r?\n/).slice(-340);
      const blocks = extractQrBlocksFromLines(tailLines);
      if (!blocks.length) continue;

      const last = blocks[blocks.length - 1];
      const h = crypto.createHash('sha1').update(last.join('\n')).digest('hex');
      if (s._lastQrHash === h) continue;
      s._lastQrHash = h;

      s.lastQrDataUrl = asciiQrToPngDataUrl(last, { scale: 3, border: 2 });
      s.lastQrAt = nowIso();
      s.qrSeq += 1;
    } catch (e) {
      s.lastError = s.lastError || String(e?.message || e);
    }
  }
}, QR_PARSE_INTERVAL_MS);

const BUILD_ID = process.env.PROVISION_BUILD_ID || `dev-${nowIso()}`;

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok:true }));
app.get('/version', (req, res) => res.json({ ok:true, buildId: BUILD_ID }));

app.post('/api/wa/start', async (req, res) => {
  try {
    const uuid = safeUuid(req.body?.uuid);
    if (!uuid) return res.status(400).json({ ok:false, error:'uuid_required' });
    const force = Boolean(req.body?.force);

    console.log(`[bothook-provision] wa.start uuid=${uuid} force=${force}`);

    // Respond immediately; login work happens in background.
    // NOTE: errors are reported via /api/wa/status lastError/lastExit.
    res.json({ ok:true, uuid, status:'starting' });
    setTimeout(() => {
      try {
        startLogin(uuid, { force });
        const s = ensureSession(uuid);
        console.log(`[bothook-provision] wa.start dispatched uuid=${uuid} loginMode=${s.loginMode} lastError=${s.lastError ? 'yes' : 'no'}`);
      } catch (e) {
        console.log(`[bothook-provision] wa.start exception uuid=${uuid} err=${String(e?.message||e)}`);
      }
    }, 0);
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
      qrAt: s.lastQrAt || null,
      lastError: s.lastError || null,
      lastExit: s.lastExit || null,
      loginMode: s.loginMode || null,
      tmuxSession: s._tmuxSession || null,
      tmuxReused: (typeof s._tmuxReused === 'boolean') ? s._tmuxReused : null,
      bufTail: stripAnsi(s.buf || '').slice(-2000) || null,
      logPath: s._logPath || null,
      logExists: s._logPath ? fs.existsSync(s._logPath) : null,
      logSize: (s._logPath && fs.existsSync(s._logPath)) ? (fs.statSync(s._logPath).size) : null
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'server_error' });
  }
});

app.listen(PORT, HOST, () => {
  ensureDir(DATA_DIR);
  console.log(`[bothook-provision] openclaw-login model listening on ${HOST}:${PORT} (state=${OPENCLAW_STATE_DIR})`);
});
