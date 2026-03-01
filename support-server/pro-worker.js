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
const { pathToFileURL } = require('url');

// seg1c: minimal verify/state-machine/audit wiring (ESM modules loaded from CommonJS)
let __seg1cMods = null;
async function seg1cLoadMods(){
  // NOTE: cache lives in __seg1cMods (avoid accidental typos like *seg1cMods)
  if (__seg1cMods) return __seg1cMods;
  const verify = await import(pathToFileURL(path.join(__dirname, 'lib', 'verify.mjs')).href);
  const sm = await import(pathToFileURL(path.join(__dirname, 'lib', 'state-machine.mjs')).href);
  const audit = await import(pathToFileURL(path.join(__dirname, 'lib', 'audit.mjs')).href);
  __seg1cMods = { verify, sm, audit };
  return __seg1cMods;
}

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

// Note: we intentionally do NOT auto-detect language from message contents.
// Use page_lang from the form; default to English.
function hasHan(s){ return /[\u4E00-\u9FFF]/.test(s || ''); }

function detectLang(ticket){
  // Policy: trust page_lang from the form; default to English if absent.
  const pl = (ticket.page_lang || '').toString().trim().toLowerCase();
  if (!pl) return 'en';
  if (pl.startsWith('zh')) return 'zh';
  // Extend later for more languages; for now only zh/en are supported.
  return 'en';
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

function loadI18n(lang){
  try {
    const safe = String(lang||'').trim().toLowerCase();
    if (!safe) return null;
    const p = path.join(__dirname, 'i18n', safe + '.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function tpl(str, vars){
  let out = String(str||'');
  for (const [k,v] of Object.entries(vars||{})) {
    out = out.replace(new RegExp('\\{\\{\\s*'+k+'\\s*\\}\\}', 'g'), String(v));
  }
  return out;
}

function renderNeedsInfoReply(ticket, { reason, expectedE164 } = {}){
  const lang = detectLang(ticket);
  const id = ticket.ticket_id;
  const i18n = loadI18n(lang);
  if (i18n && i18n.needsInfo && i18n.needsInfo.subject && i18n.needsInfo.body) {
    let extra = '';
    if (reason === 'wa_not_bound') {
      extra = '\n\n下一步：請先完成 WhatsApp 裝置關聯（Link）。完成後再回覆本郵件，我們才能核驗並協助處理。';
    } else if (reason === 'wa_mismatch') {
      extra = `\n\n核驗失敗：你填的 WhatsApp 手機號碼與此 UUID 綁定的號碼不一致。\n預期號碼：${expectedE164 || '（未知）'}\n請確認後再提交。`;
    }
    return {
      lang,
      subject: tpl(i18n.needsInfo.subject, { ticket_id: id }),
      text: tpl(i18n.needsInfo.body, { ticket_id: id }) + extra,
      html: null,
      category: 'needs_info'
    };
  }

  // fallback: English
  const subject = `[#${id}] BOTHook Support — More info needed`;
  const text = `We received your message (Ticket: ${id}).\n\nTo verify and help you safely, please reply with:\n- Your WhatsApp phone number (E.164, e.g. +1...)\n- Your UUID / delivery link\n\nReason: ${reason || 'needs_info'}${expectedE164 ? `\nExpected phone: ${expectedE164}` : ''}`;
  return { lang, subject, text, html: null, category: 'needs_info' };
}

async function seg1eProcessTicketForTest(ticket){
  // Offline simulation: compute audit records only.
  const { verify, sm } = await seg1cLoadMods();
  const id = ticket.ticket_id;
  const entryId = stableEntryId(ticket);
  let state = 'NEEDS_INFO';
  const records = [];

  const waNorm = verify.normalizeE164(ticket.wa || '');
  if (!waNorm.ok) {
    records.push({ ts: nowIso(), ticket_id: id, entry_id: entryId, action:'state', from:'NEEDS_INFO', to:'NEEDS_INFO', reason: waNorm.error || 'wa_invalid' });
    return { state:'NEEDS_INFO', records, reply: renderNeedsInfoReply(ticket, { reason: waNorm.error || 'wa_invalid' }) };
  }

  state = sm.nextState(state, 'INFO_COMPLETE'); // VERIFIED
  records.push({ ts: nowIso(), ticket_id: id, entry_id: entryId, action:'state', from:'NEEDS_INFO', to: state, reason:'wa_ok', wa_e164: waNorm.e164 });

  const vres = await verify.verifyUuidWaBinding({ uuid: String(ticket.uuid||'').trim(), waE164: waNorm.e164 });
  records.push({ ts: nowIso(), ticket_id: id, entry_id: entryId, action:'verify_uuid_wa', uuid: ticket.uuid||null, wa_e164: waNorm.e164, ok: !!vres.ok, verified: !!vres.verified, reason: vres.reason||'unknown', expectedE164: vres.expectedE164||null });

  if (vres.ok && vres.verified) {
    const prev = state;
    state = sm.nextState(state, 'START'); // IN_PROGRESS
    records.push({ ts: nowIso(), ticket_id: id, entry_id: entryId, action:'state', from: prev, to: state, reason:'verified_uuid_wa', expectedE164: vres.expectedE164||null, uuid: ticket.uuid||null });
    return { state, records, reply: { lang: detectLang(ticket), subject:'', text:'', html:null, category:'in_progress' } };
  }

  // vres ok but not verified => NEEDS_INFO
  records.push({ ts: nowIso(), ticket_id: id, entry_id: entryId, action:'state', from: state, to:'NEEDS_INFO', reason: vres.reason||'verify_failed', expectedE164: vres.expectedE164||null, uuid: ticket.uuid||null });
  return { state:'NEEDS_INFO', records, reply: renderNeedsInfoReply(ticket, { reason: vres.reason||'verify_failed', expectedE164: vres.expectedE164||null }) };
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
  const dryRun = String(process.env.SUPPORT_DRY_RUN || '').trim() === '1';
  if (dryRun) {
    // Print reply for acceptance tests; do not send.
    console.log('[support-pro-worker][dry-run] subject:', subject);
    console.log('[support-pro-worker][dry-run] text:', String(text || '').slice(0, 1200));
    return;
  }

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
        ...(html ? [{ type: 'text/html', value: html }] : []),
      ],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(()=> '');
    throw new Error(`SendGrid error: ${resp.status} ${t}`);
  }
}

async function sendTelegram({ botToken, chatId, text }) {
  const dryRun = String(process.env.SUPPORT_DRY_RUN || "").trim() === "1";
  if (dryRun) {
    console.log("[support-pro-worker][dry-run] telegram skipped");
    return;
  }
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

    // seg1c: minimal state machine (wa E.164 validation only)
    let ticketStateFrom = 'NEEDS_INFO';
    let ticketStateTo = 'NEEDS_INFO';
    let waNorm = null;
    let waReason = 'wa_missing_or_invalid';
    // seg1f: keep these in outer scope for reply/audit
    let verifyReason = null;
    let expectedE164 = null;
    try {
      const { verify, sm, audit } = await seg1cLoadMods();
      waNorm = verify.normalizeE164(t.wa || '');
      if (waNorm.ok) {
        ticketStateTo = sm.nextState(ticketStateFrom, 'INFO_COMPLETE'); // -> VERIFIED
        waReason = 'wa_ok';
      } else {
        ticketStateTo = 'NEEDS_INFO';
        waReason = waNorm.error || 'wa_invalid';
      }

      // seg1e: verify uuid↔wa binding against control-plane DB and drive state
      if (ticketStateTo === 'VERIFIED') {
        const vres = await verify.verifyUuidWaBinding({ uuid: String(t.uuid||'').trim(), waE164: waNorm.e164 });
        verifyReason = (vres && vres.reason) ? String(vres.reason) : 'unknown';
        expectedE164 = (vres && vres.expectedE164) ? String(vres.expectedE164) : null;

        audit.appendAudit({
          dataDir: DATA_DIR,
          record: {
            ts: nowIso(),
            ticket_id: id,
            entry_id: entryId,
            action: 'verify_uuid_wa',
            uuid: t.uuid || null,
            wa_e164: waNorm.e164,
            ok: Boolean(vres && vres.ok),
            verified: Boolean(vres && vres.verified),
            reason: verifyReason,
            expectedE164: expectedE164
          }
        });

        if (vres && vres.ok && vres.verified) {
          const prev2 = ticketStateTo;
          ticketStateTo = sm.nextState(ticketStateTo, 'START'); // VERIFIED -> IN_PROGRESS
          audit.appendAudit({
            dataDir: DATA_DIR,
            record: {
              ts: nowIso(),
              ticket_id: id,
              entry_id: entryId,
              action: 'state',
              from: prev2,
              to: ticketStateTo,
              reason: 'verified_uuid_wa',
              uuid: t.uuid || null,
              expectedE164: expectedE164
            }
          });
        } else {
          // uuid_invalid/wa_invalid/wa_not_bound/wa_mismatch -> NEEDS_INFO
          const prev2 = ticketStateTo;
          ticketStateTo = 'NEEDS_INFO';
          audit.appendAudit({
            dataDir: DATA_DIR,
            record: {
              ts: nowIso(),
              ticket_id: id,
              entry_id: entryId,
              action: 'state',
              from: prev2,
              to: ticketStateTo,
              reason: verifyReason || 'verify_failed',
              uuid: t.uuid || null,
              expectedE164: expectedE164
            }
          });
        }
      }

      // seg1e: Needs-info replies are generated later; this audit line is kept as final state snapshot.
      audit.appendAudit({
        dataDir: DATA_DIR,
        record: {
          ts: nowIso(),
          ticket_id: id,
          entry_id: entryId,
          action: 'state',
          from: ticketStateFrom,
          to: ticketStateTo,
          reason: waReason,
          wa: t.wa || null,
          wa_e164: (waNorm && waNorm.e164) ? waNorm.e164 : null,
        }
      });
    } catch {
      // audit best-effort
    }

    const currentReplies = state.ticketReplies[id]?.count ?? 0;
    if (currentReplies >= 10) {
      // mark entry as seen to avoid reprocessing
      state.processedEntries[entryId] = { at: nowIso(), skipped: 'reply_limit_reached', ticket_id: id };
      saveState(state);
      continue;
    }

    // seg1e: choose reply based on computed state
    let reply;
    if (ticketStateTo === 'NEEDS_INFO') {
      reply = renderNeedsInfoReply(t, { reason: verifyReason || waReason || 'needs_info', expectedE164 });
    } else {
      reply = renderReply(t);
    }

    const { lang, subject, text, html, category } = reply;

    // seg1f: record needs-info reply intent in state + audit (idempotent by entryId)
    if (category === 'needs_info') {
      try {
        // Track per-ticket reply rounds (cap remains enforced by currentReplies check above)
        state.ticketReplies[id] = {
          count: currentReplies + 1,
          last_at: nowIso(),
          last_lang: lang,
          last_category: category,
          last_subject: String(subject || '').slice(0, 200),
        };
        saveState(state);

        const { audit } = await seg1cLoadMods();
        audit.appendAudit({
          dataDir: DATA_DIR,
          record: {
            ts: nowIso(),
            ticket_id: id,
            entry_id: entryId,
            action: 'reply_needs_info',
            lang,
            reason: verifyReason || waReason || 'needs_info',
            expectedE164: expectedE164 || null,
            uuid: t.uuid || null,
            wa: t.wa || null,
            subject: String(subject || '').slice(0, 120),
            text_len: String(text || '').length,
          }
        });
      } catch {}
    }

    // 1) send email (or dry-run print)
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

// seg1e: offline test hook (no side effects unless invoked explicitly)
module.exports._seg1eProcessTicketForTest = seg1eProcessTicketForTest;
