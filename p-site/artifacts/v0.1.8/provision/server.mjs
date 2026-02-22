#!/usr/bin/env node
/* BOTHook provisioning server (Baileys)
 *
 * Design goals:
 * - Local-only HTTP API (bind 127.0.0.1)
 * - Per-uuid WhatsApp session directories
 * - /api/wa/start is idempotent (repeated calls must NOT kill the current QR)
 * - When a QR expires / refs attempts end, auto-restart socket to obtain a new QR
 *
 * Endpoints:
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

const START_DEDUP_MS = parseInt(process.env.PROVISION_START_DEDUP_MS || '15000', 10);

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

function nowIso(){ return new Date().toISOString(); }

const sessions = new Map();
// sessions.get(uuid) => { uuid, dir, state, saveCreds, sock, lastQrDataUrl, connected, wa_jid, lastUpdateAt, lastStartAt, restarting }

async function createSocket(sess, { wipeAuth = false } = {}) {
  if (sess.restarting) return;
  sess.restarting = true;
  try {
    if (sess.sock) {
      try { sess.sock.end?.(); } catch {}
      try { sess.sock.ws?.close?.(); } catch {}
      sess.sock = null;
    }

    if (wipeAuth) {
      rmrf(sess.dir);
      ensureDir(sess.dir);
      const auth = await useMultiFileAuthState(sess.dir);
      sess.state = auth.state;
      sess.saveCreds = auth.saveCreds;
      sess.lastQrDataUrl = null;
      sess.connected = false;
      sess.wa_jid = null;
    }

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: sess.state,
      version,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
    });

    sess.sock = sock;
    sess.lastUpdateAt = nowIso();

    sock.ev.on('creds.update', sess.saveCreds);

    sock.ev.on('connection.update', async (u) => {
      sess.lastUpdateAt = nowIso();
      try {
        if (u.qr) {
          // Generate QR as data URL; keep the latest in memory.
          sess.lastQrDataUrl = await QRCode.toDataURL(u.qr, { errorCorrectionLevel: 'M', margin: 1, scale: 6 });
        }

        if (u.connection === 'open') {
          sess.connected = true;
          try {
            const id = sock.user?.id || sock.user?.jid || null;
            sess.wa_jid = id ? String(id) : null;
          } catch {
            sess.wa_jid = null;
          }
          return;
        }

        if (u.connection === 'close') {
          sess.connected = false;

          const code = u.lastDisconnect?.error?.output?.statusCode;
          // If logged out, do not auto-restart; require force relink (wipe auth) to generate a new QR.
          if (code === DisconnectReason.loggedOut) {
            sess.wa_jid = null;
            return;
          }

          // For QR expiry / refs ended / transient disconnects, auto-restart to get a new QR.
          // This prevents the UI from flashing a QR for 1s and then dying.
          const msg = String(u.lastDisconnect?.error?.message || '');
          const shouldRestart = (
            !sess.connected &&
            (msg.includes('QR refs attempts ended') || msg.includes('QR') || true)
          );
          if (shouldRestart) {
            setTimeout(() => {
              // recreate socket with same auth state (no wipe)
              createSocket(sess, { wipeAuth: false }).catch(() => {});
            }, 800);
          }
        }
      } catch {
        // ignore
      }
    });
  } finally {
    sess.restarting = false;
  }
}

async function getOrStartSession(uuid, { force = false } = {}) {
  const dir = path.join(DATA_DIR, 'wa', uuid);

  let sess = sessions.get(uuid);
  if (!sess) {
    ensureDir(dir);
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    sess = {
      uuid,
      dir,
      state,
      saveCreds,
      sock: null,
      lastQrDataUrl: null,
      connected: false,
      wa_jid: null,
      lastUpdateAt: nowIso(),
      lastStartAt: 0,
      restarting: false,
    };
    sessions.set(uuid, sess);
  }

  const now = Date.now();
  if (!force && sess.lastStartAt && (now - sess.lastStartAt) < START_DEDUP_MS) {
    // idempotent: do not restart/kill the current QR
    return sess;
  }

  sess.lastStartAt = now;
  await createSocket(sess, { wipeAuth: force });
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

    const sess = await getOrStartSession(uuid, { force });
    return res.json({ ok: true, uuid, status: 'starting', connected: Boolean(sess.connected) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

app.get('/api/wa/qr', async (req, res) => {
  try {
    const uuid = safeUuid(req.query?.uuid);
    if (!uuid) return res.status(400).json({ ok: false, error: 'uuid_required' });

    const sess = sessions.get(uuid);
    if (!sess) {
      return res.status(409).json({ ok: false, error: 'not_started' });
    }

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
