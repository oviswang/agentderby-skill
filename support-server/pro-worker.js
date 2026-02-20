#!/usr/bin/env node
/**
 * bothook support worker (pro)
 * - runs periodically (systemd timer)
 * - reads tickets.jsonl
 * - processes each ticket once (idempotent via state.json)
 * - sends a professional email reply via SendGrid
 * - syncs Q&A + result to owner Telegram
 *
 * Safety:
 * - No shell exec
 * - No credential echo
 * - Rate-limited per run
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SUPPORT_DATA_DIR || '/home/ubuntu/.openclaw/workspace/support';
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HANDLED_LOG = path.join(DATA_DIR, 'handled.jsonl');

const SENDGRID_ENV = process.env.SENDGRID_ENV || '/home/ubuntu/.openclaw/credentials/sendgrid.env';
const TELEGRAM_ENV = process.env.TELEGRAM_ENV || '/home/ubuntu/.openclaw/credentials/telegram.env';

const MAX_PER_RUN = parseInt(process.env.SUPPORT_MAX_PER_RUN || '10', 10);

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

function loadState(){
  try {
    if (!fs.existsSync(STATE_FILE)) return { processed: {} };
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.processed) s.processed = {};
    return s;
  } catch {
    return { processed: {} };
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

function hasHan(s){ return /[\u4E00-\u9FFF]/.test(s || ''); }

function detectLang(ticket){
  if (ticket.page_lang && String(ticket.page_lang).toLowerCase().startsWith('zh')) return 'zh';
  return hasHan(ticket.message) ? 'zh' : 'en';
}

function summarizeCategory(message){
  const m = String(message || '').toLowerCase();
  if (m.includes('relink') || m.includes('续') || m.includes('到期') || m.includes('renew')) return 'billing/relink';
  if (m.includes('qr') || m.includes('scan') || m.includes('扫码') || m.includes('关联')) return 'whatsapp/linking';
  if (m.includes('timeout') || m.includes('timed out') || m.includes('不回') || m.includes('没回复')) return 'stability/timeout';
  if (m.includes('domain') || m.includes('域名') || m.includes('caddy') || m.includes('https')) return 'domain/hosting';
  return 'general';
}

function escapeHtml(s){
  return String(s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function renderReply(ticket){
  const lang = detectLang(ticket);
  const id = ticket.ticket_id;
  const uuid = ticket.uuid ? String(ticket.uuid).trim() : '';
  const category = summarizeCategory(ticket.message);

  if (lang === 'zh') {
    const subject = `[#${id}] BOTHook 支持回复`;
    const text = `你好，\n\n我们已收到你的问题（工单号：${id}）。\n\n【问题分类】${category}\n\n【你提交的内容】\nEmail: ${ticket.email}${uuid ? `\nUUID: ${uuid}` : ''}\n\n${ticket.message}\n\n【建议与下一步】\n1) 如果是 WhatsApp 关联/扫码：请用另一台设备打开二维码页面，然后在 WhatsApp → 已关联的设备 → 关联新设备扫码。\n2) 如果是“消息不回复/超时”：请提供触发时间点（大概到分钟）、你发送的内容类型（文本/图片/语音），以及是否是自聊。\n3) 如果是续费/Relink：请提供 UUID（如有），我们会核对付费状态并给出下一步。\n\n我们会继续跟进，你也可以直接回复本邮件补充信息。\n\n— BOTHook Support`;

    const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.6;color:#111">
  <p>你好，</p>
  <p>我们已收到你的问题（工单号：<strong>${escapeHtml(id)}</strong>）。</p>
  <p><strong>问题分类：</strong>${escapeHtml(category)}</p>
  <hr style="border:none;border-top:1px solid #eee"/>
  <p><strong>你提交的内容</strong></p>
  <pre style="white-space:pre-wrap;background:#f7f7f8;padding:12px;border-radius:10px;">Email: ${escapeHtml(ticket.email)}${uuid ? `\nUUID: ${escapeHtml(uuid)}` : ''}\n\n${escapeHtml(ticket.message)}</pre>
  <p><strong>建议与下一步</strong></p>
  <ol>
    <li>WhatsApp 关联/扫码：用另一台设备打开二维码页面；WhatsApp → 已关联的设备 → 关联新设备扫码。</li>
    <li>消息不回复/超时：提供触发时间点（到分钟）、消息类型（文本/图片/语音）、是否自聊。</li>
    <li>续费/Relink：提供 UUID（如有），我们将核对付费状态并给出下一步。</li>
  </ol>
  <p style="color:#6b7280;font-size:12px">回复本邮件可继续沟通。</p>
</div>`;

    return { lang, subject, text, html, category };
  }

  const subject = `[#${id}] BOTHook Support Reply`;
  const text = `Hi,\n\nWe received your request (Ticket: ${id}).\n\nCategory: ${category}\n\nWhat you submitted:\nEmail: ${ticket.email}${uuid ? `\nUUID: ${uuid}` : ''}\n\n${ticket.message}\n\nNext steps:\n1) WhatsApp linking/QR: open the QR page on another device, then WhatsApp → Linked devices → Link a device and scan.\n2) Timeouts/no reply: share the approximate time (to minute), message type (text/image/voice), and whether it was self-chat.\n3) Billing/Relink: share UUID (if any) and we’ll verify payment status and advise.\n\nReply to this email to add details.\n\n— BOTHook Support`;

  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.6;color:#111">
  <p>Hi,</p>
  <p>We received your request (Ticket: <strong>${escapeHtml(id)}</strong>).</p>
  <p><strong>Category:</strong> ${escapeHtml(category)}</p>
  <hr style="border:none;border-top:1px solid #eee"/>
  <p><strong>What you submitted</strong></p>
  <pre style="white-space:pre-wrap;background:#f7f7f8;padding:12px;border-radius:10px;">Email: ${escapeHtml(ticket.email)}${uuid ? `\nUUID: ${escapeHtml(uuid)}` : ''}\n\n${escapeHtml(ticket.message)}</pre>
  <p><strong>Next steps</strong></p>
  <ol>
    <li>WhatsApp linking/QR: open the QR page on another device, then WhatsApp → Linked devices → Link a device and scan.</li>
    <li>Timeouts/no reply: share the approximate time (to minute), message type (text/image/voice), and whether it was self-chat.</li>
    <li>Billing/Relink: share UUID (if any) and we’ll verify payment status and advise.</li>
  </ol>
  <p style="color:#6b7280;font-size:12px">Reply to this email to continue.</p>
</div>`;

  return { lang, subject, text, html, category };
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
      from: { email: from, name: 'BOTHook Support' },
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

async function sendTelegram({ botToken, chatId, text }) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(()=> '');
    throw new Error(`Telegram error: ${resp.status} ${t}`);
  }
}

function appendHandled(entry){
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(HANDLED_LOG, JSON.stringify(entry) + '\n', 'utf8');
}

async function main(){
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const sg = loadEnv(SENDGRID_ENV);
  const apiKey = sg.SENDGRID_API_KEY;
  const from = sg.SENDGRID_FROM;
  const replyTo = sg.SENDGRID_REPLY_TO;

  const tg = loadEnv(TELEGRAM_ENV);
  const botToken = tg.TELEGRAM_BOT_TOKEN;
  const ownerChatId = tg.TELEGRAM_OWNER_CHAT_ID;

  if (!apiKey || !from || !replyTo) {
    console.error('[support-pro-worker] missing SendGrid env');
    process.exit(2);
  }
  if (!botToken || !ownerChatId) {
    console.error('[support-pro-worker] missing Telegram env');
    process.exit(2);
  }

  const state = loadState();
  const tickets = readTickets();

  let processed = 0;
  for (const t of tickets) {
    const id = t.ticket_id;
    if (!id) continue;
    if (state.processed[id]) continue;

    const { lang, subject, text, html, category } = renderReply(t);

    // 1) send email
    await sendEmail({ apiKey, to: t.email, from, replyTo, subject, text, html });

    // 2) mark processed + log
    const result = {
      ticket_id: id,
      at: nowIso(),
      to: t.email,
      lang,
      category,
      uuid: t.uuid || '',
    };
    state.processed[id] = result;
    saveState(state);
    appendHandled({ ...result, message: t.message });

    // 3) notify owner telegram
    const tgText = [
      `[support] ticket ${id} processed`,
      `email: ${t.email}`,
      t.uuid ? `uuid: ${t.uuid}` : null,
      `category: ${category}`,
      `lang: ${lang}`,
      `---`,
      `question:`,
      String(t.message || '').slice(0, 1200),
      `---`,
      `result: auto-replied via SendGrid`,
    ].filter(Boolean).join('\n');

    await sendTelegram({ botToken, chatId: ownerChatId, text: tgText });

    processed += 1;
    if (processed >= MAX_PER_RUN) break;
  }

  console.log(`[support-pro-worker] processed=${processed}`);
}

main().catch((e) => {
  console.error('[support-pro-worker] error', e);
  process.exit(1);
});
