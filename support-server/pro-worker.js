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
    if (!fs.existsSync(STATE_FILE)) return { processed: {}, processedEntries: {}, ticketReplies: {} };
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.processed) s.processed = {}; // legacy
    if (!s.processedEntries) s.processedEntries = {};
    if (!s.ticketReplies) s.ticketReplies = {};
    return s;
  } catch {
    return { processed: {}, processedEntries: {}, ticketReplies: {} };
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
  if (m.includes('relink') || m.includes('续') || m.includes('到期') || m.includes('renew') || m.includes('billing') || m.includes('payment')) return 'billing/relink';
  if (m.includes('qr') || m.includes('scan') || m.includes('扫码') || m.includes('关联') || m.includes('linked device')) return 'whatsapp/linking';
  if (m.includes('timeout') || m.includes('timed out') || m.includes('不回') || m.includes('没回复') || m.includes('request timed out')) return 'stability/timeout';
  if (m.includes('domain') || m.includes('域名') || m.includes('caddy') || m.includes('https') || m.includes('ssl') || m.includes('dns')) return 'domain/hosting';
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

function categoryNextStepsZh(category){
  switch(category){
    case 'whatsapp/linking':
      return [
        '请使用另一台设备（电脑/另一部手机）打开二维码页面。',
        'WhatsApp → 已关联的设备 → 关联新设备，然后扫码。',
        '如果扫码后仍失败，请告知：你所在国家/运营商、是否使用 VPN、以及失败提示截图。'
      ];
    case 'stability/timeout':
      return [
        '请提供：触发时间点（到分钟）、你发送的内容类型（文本/图片/语音）、是否自聊。',
        '如果方便，补充：你连续发送了几条消息、每条大概多长。',
        '我们会据此定位是连接问题还是处理耗时问题。'
      ];
    case 'domain/hosting':
      return [
        '请告知域名（example.com）以及你想指向的服务（网站/接口/控制台）。',
        '确认 DNS 已添加 A/AAAA 记录指向服务器公网 IP。',
        '若需要 HTTPS：请告知是否使用 Caddy（推荐）或 Nginx，我们会给出最小配置建议。'
      ];
    case 'billing/relink':
      return [
        '请提供 UUID（如有）以及付款邮箱/付款时间（大概即可）。',
        '我们会核对付费状态与到期时间，并给出续上/重开方案。'
      ];
    default:
      return [
        '请补充：你期望达成的结果、触发时间点、以及是否能复现。'
      ];
  }
}

function categoryNextStepsEn(category){
  switch(category){
    case 'whatsapp/linking':
      return [
        'Open the QR page on another device (computer/another phone).',
        'WhatsApp → Linked devices → Link a device, then scan the QR.',
        'If it still fails, tell us your country/carrier, whether you use VPN, and the exact error/screenshot.'
      ];
    case 'stability/timeout':
      return [
        'Share: approximate time (to minute), message type (text/image/voice), and whether it was self-chat.',
        'If possible: how many messages you sent in a row and their approximate length.',
        'We will determine if it is connectivity or processing latency.'
      ];
    case 'domain/hosting':
      return [
        'Share the domain (example.com) and what you want to expose (website/API/control UI).',
        'Confirm DNS A/AAAA records point to the server public IP.',
        'For HTTPS: tell us whether you prefer Caddy (recommended) or Nginx.'
      ];
    case 'billing/relink':
      return [
        'Share UUID (if any) and the billing email / approximate payment time.',
        'We will verify payment status & expiry and advise next steps.'
      ];
    default:
      return [
        'Please share the expected outcome, approximate time, and whether it is reproducible.'
      ];
  }
}

function renderReply(ticket){
  const lang = detectLang(ticket);
  const id = ticket.ticket_id;
  const uuid = ticket.uuid ? String(ticket.uuid).trim() : '';
  const category = summarizeCategory(ticket.message);
  const isFollowup = String(ticket.status || '').toLowerCase() === 'followup';

  if (lang === 'zh') {
    const subject = `[#${id}] BOTHook 支持回复${isFollowup ? '（跟进）' : ''}`;
    const steps = categoryNextStepsZh(category);
    const text = `你好，\n\n我们已收到你的${isFollowup ? '补充信息' : '问题'}（工单号：${id}）。\n\n【问题分类】${category}\n\n【你提交的内容】\nEmail: ${ticket.email}${uuid ? `\nUUID: ${uuid}` : ''}\n\n${ticket.message}\n\n【建议与下一步】\n${steps.map((s,i)=>`${i+1}) ${s}`).join('\n')}\n\n你也可以继续补充：在联系表单里填写同一个 ticket_id（${id}），我们会把它作为同一工单跟进。\n\n— BOTHook Support`;

    const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.6;color:#111">
  <p>你好，</p>
  <p>我们已收到你的${isFollowup ? '补充信息' : '问题'}（工单号：<strong>${escapeHtml(id)}</strong>）。</p>
  <p><strong>问题分类：</strong>${escapeHtml(category)}</p>
  <hr style="border:none;border-top:1px solid #eee"/>
  <p><strong>你提交的内容</strong></p>
  <pre style="white-space:pre-wrap;background:#f7f7f8;padding:12px;border-radius:10px;">Email: ${escapeHtml(ticket.email)}${uuid ? `\nUUID: ${escapeHtml(uuid)}` : ''}\n\n${escapeHtml(ticket.message)}</pre>
  <p><strong>建议与下一步</strong></p>
  <ol>
    ${steps.map((s)=>`<li>${escapeHtml(s)}</li>`).join('')}
  </ol>
  <p style="color:#6b7280;font-size:12px">如需继续补充，请在联系表单里填写同一个 ticket_id（${escapeHtml(id)}），我们会作为同一工单跟进。</p>
</div>`;

    return { lang, subject, text, html, category };
  }

  const subject = `[#${id}] BOTHook Support Reply${isFollowup ? ' (Follow-up)' : ''}`;
  const steps = categoryNextStepsEn(category);
  const text = `Hi,\n\nWe received your ${isFollowup ? 'follow-up' : 'request'} (Ticket: ${id}).\n\nCategory: ${category}\n\nWhat you submitted:\nEmail: ${ticket.email}${uuid ? `\nUUID: ${uuid}` : ''}\n\n${ticket.message}\n\nNext steps:\n${steps.map((s,i)=>`${i+1}) ${s}`).join('\n')}\n\nTo add details, submit the contact form again with the same ticket_id (${id}).\n\n— BOTHook Support`;

  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.6;color:#111">
  <p>Hi,</p>
  <p>We received your ${isFollowup ? 'follow-up' : 'request'} (Ticket: <strong>${escapeHtml(id)}</strong>).</p>
  <p><strong>Category:</strong> ${escapeHtml(category)}</p>
  <hr style="border:none;border-top:1px solid #eee"/>
  <p><strong>What you submitted</strong></p>
  <pre style="white-space:pre-wrap;background:#f7f7f8;padding:12px;border-radius:10px;">Email: ${escapeHtml(ticket.email)}${uuid ? `\nUUID: ${escapeHtml(uuid)}` : ''}\n\n${escapeHtml(ticket.message)}</pre>
  <p><strong>Next steps</strong></p>
  <ol>
    ${steps.map((s)=>`<li>${escapeHtml(s)}</li>`).join('')}
  </ol>
  <p style="color:#6b7280;font-size:12px">To add details, submit the contact form again with the same ticket_id (${escapeHtml(id)}).</p>
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

function stableEntryId(t){
  // Idempotency per ticket entry (not just ticket_id): hash a stable subset.
  const raw = JSON.stringify({
    ticket_id: t.ticket_id || '',
    created_at: t.created_at || '',
    email: t.email || '',
    uuid: t.uuid || '',
    message: t.message || '',
    status: t.status || '',
  });
  // simple non-crypto hash (djb2)
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h) + raw.charCodeAt(i);
  return `e${(h >>> 0).toString(16)}`;
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

    const entryId = stableEntryId(t);
    if (state.processedEntries[entryId]) continue; // already handled this specific submission

    const currentReplies = state.ticketReplies[id]?.count ?? 0;
    if (currentReplies >= 10) {
      // mark entry as seen to avoid reprocessing
      state.processedEntries[entryId] = { at: nowIso(), skipped: 'reply_limit_reached', ticket_id: id };
      saveState(state);
      continue;
    }

    const { lang, subject, text, html, category } = renderReply(t);

    // 1) send email
    await sendEmail({ apiKey, to: t.email, from, replyTo, subject, text, html });

    // 2) update state + logs
    const result = {
      ticket_id: id,
      entry_id: entryId,
      at: nowIso(),
      to: t.email,
      lang,
      category,
      uuid: t.uuid || '',
      reply_index: currentReplies + 1,
    };

    state.processedEntries[entryId] = { at: result.at, ticket_id: id };
    state.ticketReplies[id] = {
      count: currentReplies + 1,
      last_at: result.at,
      last_to: t.email,
      last_lang: lang,
      last_category: category,
    };

    // keep legacy field updated for backward compatibility
    state.processed[id] = state.ticketReplies[id];

    saveState(state);
    appendHandled({ ...result, message: t.message });

    // 3) notify owner telegram
    const tgText = [
      `[support] ticket ${id} replied (${result.reply_index}/10)`,
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
