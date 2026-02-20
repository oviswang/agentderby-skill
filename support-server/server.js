#!/usr/bin/env node
/**
 * bothook support server (minimal)
 * - Accepts contact form submissions
 * - Stores tickets on disk (jsonl)
 * - Exposes health endpoint
 */

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.SUPPORT_PORT || '18888', 10);
const DATA_DIR = process.env.SUPPORT_DATA_DIR || '/home/ubuntu/.openclaw/workspace/support';
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.jsonl');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function makeTicketId() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `BH-${y}${m}${day}-${rand}`;
}

function readJsonBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function sanitizeText(s, maxLen) {
  if (typeof s !== 'string') return '';
  let t = s.replace(/\r\n/g, '\n');
  t = t.replace(/\u0000/g, '');
  t = t.trim();
  if (t.length > maxLen) t = t.slice(0, maxLen);
  return t;
}

ensureDir(DATA_DIR);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && u.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (req.method === 'POST' && u.pathname === '/ticket') {
    try {
      const body = await readJsonBody(req);
      const email = sanitizeText(body.email, 200);
      const uuid = sanitizeText(body.uuid || '', 200);
      const message = sanitizeText(body.message, 8000);
      const pageLang = sanitizeText(body.pageLang || '', 20);
      const ticketIdFromClient = sanitizeText(body.ticket_id || '', 64);

      if (!isEmail(email)) return send(res, 400, { ok: false, error: 'Invalid email' });
      if (!message) return send(res, 400, { ok: false, error: 'Message required' });

      // Simple persistent rate-limit per email (max 10 submissions/hour)
      const stateFile = path.join(DATA_DIR, 'state.json');
      let state = {};
      try { if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
      if (!state.submissions) state.submissions = {};
      const now = Date.now();
      const key = email.toLowerCase();
      const windowMs = 60 * 60 * 1000;
      const arr = Array.isArray(state.submissions[key]) ? state.submissions[key] : [];
      const recent = arr.filter((t) => typeof t === 'number' && now - t < windowMs);
      if (recent.length >= 10) return send(res, 429, { ok: false, error: 'Too many submissions. Please try again later.' });
      recent.push(now);
      state.submissions[key] = recent;
      try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch {}

      const ticket = {
        ticket_id: ticketIdFromClient || makeTicketId(),
        created_at: nowIso(),
        email,
        uuid,
        message,
        page_lang: pageLang,
        status: ticketIdFromClient ? 'followup' : 'new',
        // meta
        remote_ip: req.socket?.remoteAddress || null,
        user_agent: req.headers['user-agent'] || null,
      };

      fs.appendFileSync(TICKETS_FILE, JSON.stringify(ticket) + '\n', { encoding: 'utf8' });

      return send(res, 200, { ok: true, ticket_id: ticket.ticket_id });
    } catch (err) {
      return send(res, err.statusCode || 500, { ok: false, error: err.message || 'Server error' });
    }
  }

  send(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[support-server] listening on 127.0.0.1:${PORT}`);
});
