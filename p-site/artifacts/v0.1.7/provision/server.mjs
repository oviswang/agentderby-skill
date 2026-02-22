#!/usr/bin/env node
/* BOTHook provisioning server (Baileys)
 * - Local-only HTTP API (bind 127.0.0.1)
 * - Per-uuid WhatsApp session directories
 * - Endpoints:
 *   - GET  /healthz
 *   - POST /api/wa/start { uuid, force }
 *   - GET  /api/wa/qr?uuid=...
 *   - GET  /api/wa/status?uuid=...
 */

import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import QRCode from 'qrcode';

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

const DATA_DIR = process.env.PROVISION_DATA_DIR || '/opt/bothook/provision/data';
const PORT = parseInt(process.env.PROVISION_PORT || '18999', 10);
const HOST = process.env.PROVISION_HOST || '127.0.0.1';

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeUuid(s) {
  const x = String(s || '').trim();
  if (!x) return null;
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(x)) return null;
  return x;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

const sessions = new Map();
// sessions.get(uuid) => { sock, state, saveCreds, lastQrDataUrl, connected, wa_jid, lastUpdateAt }

async function startSession(uuid, { force = false } = {}) {
  const existing = sessions.get(uuid);
  if (existing && existing.sock) return existing;

  const dir = path.join(DATA_DIR, 'wa', uuid);
  if (force) {
    // wipe auth state so a fresh QR is generated
    rmrf(dir);
  }
  ensureDir(dir);

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sess = {
    sock: null,
    state,
    saveCreds,
    lastQrDataUrl: null,
    connected: false,
    wa_jid: null,
    lastUpdateAt: new Date().toISOString(),
  };
  sessions.set(uuid, sess);

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
  });

  sess.sock = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    try {
      sess.lastUpdateAt = new Date().toISOString();
      if (u.qr) {
        sess.lastQrDataUrl = await QRCode.toDataURL(u.qr, { errorCorrectionLevel: 'M', margin: 1, scale: 6 });
      }
      if (u.connection === 'open') {
        sess.connected = true;
        try {
          // best-effort: baileys exposes user id in multiple places
          const id = sock.user?.id || sock.user?.jid || null;
          sess.wa_jid = id ? String(id) : null;
        } catch {
          sess.wa_jid = null;
        }
      }
      if (u.connection === 'close') {
        sess.connected = false;
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          sess.wa_jid = null;
          // keep session; caller can force relink
        }
      }
    } catch {
      // ignore
    }
  });

  return sess;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/api/wa/start', async (req, res) => {
  try {
    const uuid = safeUuid(req.body?.uuid);
    if (!uuid) return res.status(400).json({ ok: false, error: 'uuid_required' });
    const force = Boolean(req.body?.force);

    const sess = await startSession(uuid, { force });
    return res.json({ ok: true, uuid, status: 'starting', connected: Boolean(sess.connected) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

app.get('/api/wa/qr', async (req, res) => {
  try {
    const uuid = safeUuid(req.query?.uuid);
    if (!uuid) return res.status(400).json({ ok: false, error: 'uuid_required' });

    const sess = sessions.get(uuid) || await startSession(uuid, { force: false });

    if (sess.connected) {
      return res.status(200).json({ ok: true, uuid, status: 'connected', qrDataUrl: null });
    }

    if (!sess.lastQrDataUrl) {
      return res.status(409).json({ ok: false, error: 'qr_not_ready' });
    }

    return res.json({ ok: true, uuid, status: 'qr', qrDataUrl: sess.lastQrDataUrl });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

app.get('/api/wa/status', async (req, res) => {
  try {
    const uuid = safeUuid(req.query?.uuid);
    if (!uuid) return res.status(400).json({ ok: false, error: 'uuid_required' });

    const sess = sessions.get(uuid);
    if (!sess) {
      return res.json({ ok: true, uuid, status: 'idle', connected: false, wa_jid: null });
    }

    return res.json({
      ok: true,
      uuid,
      status: sess.connected ? 'connected' : 'linking',
      connected: Boolean(sess.connected),
      wa_jid: sess.wa_jid,
      lastUpdateAt: sess.lastUpdateAt,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[bothook-provision] listening on ${HOST}:${PORT} DATA_DIR=${DATA_DIR}`);
});
