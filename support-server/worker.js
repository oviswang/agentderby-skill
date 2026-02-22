#!/usr/bin/env node
/**
 * bothook support worker (minimal)
 * - runs periodically
 * - reads tickets.jsonl
 * - sends at most 1 auto-reply per ticket
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SUPPORT_DATA_DIR || '/home/ubuntu/.openclaw/workspace/support';
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function nowIso(){ return new Date().toISOString(); }

function loadEnv(file){
  const out = {};
  if (!fs.existsSync(file)) return out;
  const txt = fs.readFileSync(file, 'utf8');
  for (const line of txt.split(/\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2];
  }
  return out;
}

function hasHan(s){
  return /[\u4E00-\u9FFF]/.test(s || '');
}

function getLanguage(ticket){
  // explicit page language wins if present
  if (ticket.page_lang && String(ticket.page_lang).toLowerCase().startsWith('zh')) return 'zh';
  return hasHan(ticket.message) ? 'zh' : 'en';
}

async function sendEmail({ apiKey, to, from, replyTo, subject, html, text }) {
  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: 'bothook support' },
      reply_to: { email: replyTo },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(()=> '');
    throw new Error(`SendGrid error: ${resp.status} ${t}`);
  }
}

function loadState(){
  try {
    if (!fs.existsSync(STATE_FILE)) return { replied: {} };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { replied: {} };
  }
}

function saveState(state){
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function readTickets(){
  if (!fs.existsSync(TICKETS_FILE)) return [];
  const lines = fs.readFileSync(TICKETS_FILE, 'utf8').split(/\n/).filter(Boolean);
  const out = [];
  for (const ln of lines) {
    try { out.push(JSON.parse(ln)); } catch {}
  }
  return out;
}

function renderReply(ticket, lang){
  const id = ticket.ticket_id;
  const uuid = ticket.uuid ? `\nUUID: ${ticket.uuid}` : '';
  const wa = ticket.wa ? `\nWhatsApp: ${ticket.wa}` : '';

  if (lang === 'zh') {
    const subject = `[#${id}] BOTHook 支持 — 已收到`;
    const text = `[bothook] 我们已收到你的消息（工单号：${id}）。\n\n我们会尽快处理并回复。\n\n你提交的信息：\n邮箱：${ticket.email}${wa}${uuid}\n内容：\n${ticket.message}\n\n如需我们执行“操作型请求”（如取消订阅、配置 DNS 等），请确保你在表单里同时提供：\n- WhatsApp 手机号码\n- UUID/交付链接\n\n如果你是关于 WhatsApp 关联交付：\n- 请确认你使用另一台设备（电脑/另一部手机）来显示二维码\n- 并在 WhatsApp → 已关联的设备 → 关联新设备 扫码\n\n（直接回复本邮件即可继续沟通。）`;

    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.6;color:#111">
        <p><strong>[bothook]</strong> 我们已收到你的消息（工单号：<strong>${id}</strong>）。</p>
        <p>我们会尽快处理并回复。</p>
        <hr style="border:none;border-top:1px solid #eee"/>
        <p><strong>你提交的信息</strong></p>
        <pre style="white-space:pre-wrap;background:#f7f7f8;padding:12px;border-radius:10px;">Email: ${escapeHtml(ticket.email)}${ticket.wa ? `\nWhatsApp: ${escapeHtml(ticket.wa)}` : ''}${ticket.uuid ? `\nUUID: ${escapeHtml(ticket.uuid)}` : ''}\n\nMessage:\n${escapeHtml(ticket.message)}</pre>
        <p style="color:#6b7280;font-size:12px">如需我们执行取消订阅、配置 DNS 等操作型请求，请确保你提供 WhatsApp 手机号码 + UUID/交付链接，用于校验。</p>
        <p><strong>常见排查（WhatsApp 关联）</strong></p>
        <ul>
          <li>请使用另一台设备（电脑/另一部手机）来显示二维码</li>
          <li>WhatsApp → 已关联的设备 → 关联新设备，然后扫码</li>
        </ul>
        <p style="color:#6b7280;font-size:12px">直接回复本邮件即可继续沟通。</p>
      </div>
    `;
    return { subject, text, html };
  }

  const subject = `[#${id}] BOTHook Support — Received`;
  const text = `[bothook] We received your message (Ticket: ${id}).\n\nWe’ll get back to you as soon as possible.\n\nWhat you submitted:\nEmail: ${ticket.email}${wa}${uuid}\nMessage:\n${ticket.message}\n\nFor account actions (cancellation, DNS changes, etc.), please include both:\n- Your WhatsApp phone number\n- Your UUID/delivery link\n\nIf this is about WhatsApp linking:\n- Please open the QR page on another device (computer/another phone)\n- WhatsApp → Linked devices → Link a device, then scan\n\n(Reply to this email to continue.)`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.6;color:#111">
      <p><strong>[bothook]</strong> We received your message (Ticket: <strong>${id}</strong>).</p>
      <p>We’ll get back to you as soon as possible.</p>
      <hr style="border:none;border-top:1px solid #eee"/>
      <p><strong>What you submitted</strong></p>
      <pre style="white-space:pre-wrap;background:#f7f7f8;padding:12px;border-radius:10px;">Email: ${escapeHtml(ticket.email)}${ticket.wa ? `\nWhatsApp: ${escapeHtml(ticket.wa)}` : ''}${ticket.uuid ? `\nUUID: ${escapeHtml(ticket.uuid)}` : ''}\n\nMessage:\n${escapeHtml(ticket.message)}</pre>
      <p style="color:#6b7280;font-size:12px">For account actions (cancellation, DNS changes, etc.), please include both your WhatsApp phone + UUID/delivery link for verification.</p>
      <p><strong>Quick checks (WhatsApp linking)</strong></p>
      <ul>
        <li>Open the QR page on another device (computer/another phone)</li>
        <li>WhatsApp → Linked devices → Link a device, then scan</li>
      </ul>
      <p style="color:#6b7280;font-size:12px">Reply to this email to continue.</p>
    </div>
  `;
  return { subject, text, html };
}

function escapeHtml(s){
  return String(s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

async function main(){
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const sg = loadEnv('/home/ubuntu/.openclaw/credentials/sendgrid.env');
  const apiKey = sg.SENDGRID_API_KEY;
  const from = sg.SENDGRID_FROM;
  const replyTo = sg.SENDGRID_REPLY_TO;

  if (!apiKey || !from || !replyTo) {
    console.error('[support-worker] missing SendGrid env');
    process.exit(2);
  }

  const state = loadState();
  const tickets = readTickets();

  let sent = 0;
  for (const t of tickets) {
    const id = t.ticket_id;
    if (!id) continue;
    if (state.replied[id]) continue; // already auto-replied

    const lang = getLanguage(t);
    const { subject, text, html } = renderReply(t, lang);

    await sendEmail({ apiKey, to: t.email, from, replyTo, subject, text, html });
    state.replied[id] = { at: nowIso(), to: t.email, lang };
    sent++;

    // safety: don't blast too many in one run
    if (sent >= 20) break;
  }

  saveState(state);
  console.log(`[support-worker] sent=${sent}`);
}

main().catch((e) => {
  console.error('[support-worker] error', e);
  process.exit(1);
});
