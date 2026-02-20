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
const { parseMultipart } = require('./multipart');

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

function readBody(req, limitBytes = 1024 * 1024) {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJsonBody(req, limitBytes = 256 * 1024) {
  return readBody(req, limitBytes).then((buf) => {
    const raw = buf.toString('utf8');
    if (!raw) return {};
    try { return JSON.parse(raw); }
    catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
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

  // SendGrid Inbound Parse webhook: handle_path /api/support/* strips prefix, so this may arrive as /inbound.
  if (req.method === 'POST' && (u.pathname === '/inbound' || u.pathname === '/api/support/inbound')) {
    try {
      const token = sanitizeText(u.searchParams.get('token') || '', 256);
      const expected = process.env.SUPPORT_INBOUND_TOKEN || '';
      if (!expected || token !== expected) return send(res, 403, { ok: false, error: 'Forbidden' });

      const ct = String(req.headers['content-type'] || '');
      const m = ct.match(/boundary=(.+)$/i);
      if (!m) return send(res, 400, { ok: false, error: 'Expected multipart/form-data' });
      const boundary = m[1].replace(/^"|"$/g, '');

      const buf = await readBody(req, 1024 * 1024);
      const form = parseMultipart(buf, boundary);

      // Fields we care about: from, subject, text
      const fromRaw = sanitizeText(form.from || '', 400);
      const subject = sanitizeText(form.subject || '', 400);
      const text = sanitizeText(form.text || form.html || '', 12000);

      // Extract sender email from "Name <email@x>".
      const fromEmailMatch = fromRaw.match(/<([^>]+)>/) || fromRaw.match(/([^\s<>]+@[^\s<>]+\.[^\s<>]+)/);
      const fromEmail = (fromEmailMatch ? fromEmailMatch[1] : '').trim();
      if (!isEmail(fromEmail)) return send(res, 400, { ok: false, error: 'Invalid from email' });

      // Extract ticket id BH-YYYYMMDD-XXXXXX from subject/body
      const ticketIdMatch = (subject + '\n' + text).match(/\bBH-\d{8}-[A-Z0-9]{6}\b/);
      if (!ticketIdMatch) return send(res, 200, { ok: true, ignored: true, reason: 'no_ticket_id' });
      const ticketId = ticketIdMatch[0];

      // Load state to reuse last language for this ticket if present; default en.
      const stateFile = path.join(DATA_DIR, 'state.json');
      let state = {};
      try { if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
      const lastLang = state.ticketReplies?.[ticketId]?.last_lang || 'en';

      const ticket = {
        ticket_id: ticketId,
        created_at: nowIso(),
        email: fromEmail,
        uuid: '',
        message: `[email follow-up]\nSubject: ${subject}\n\n${text}`,
        page_lang: lastLang,
        status: 'followup',
        remote_ip: req.socket?.remoteAddress || null,
        user_agent: req.headers['user-agent'] || null,
      };

      fs.appendFileSync(TICKETS_FILE, JSON.stringify(ticket) + '\n', { encoding: 'utf8' });

      // Best-effort: kick the worker now; otherwise timer will pick it up.
      try { require('child_process').spawn('systemctl', ['start', 'bothook-support-worker.service'], { stdio: 'ignore' }); } catch {}

      return send(res, 200, { ok: true, ticket_id: ticketId });
    } catch (err) {
      return send(res, err.statusCode || 500, { ok: false, error: err.message || 'Server error' });
    }
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
