import fs from 'node:fs';
import crypto from 'node:crypto';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk';

const UUID_PATH = '/opt/bothook/UUID.txt';
const STATE_PATH = '/opt/bothook/state.json';
const EVID_DIR = '/opt/bothook/evidence';
const AUTOREPLY_LOADED_MARK = `${EVID_DIR}/autoreply_loaded`;

function nowIso(){ return new Date().toISOString(); }

function markAutoreplyLoaded() {
  try {
    fs.mkdirSync(EVID_DIR, { recursive: true });
    // A cheap marker that postboot_verify can read without invoking openclaw CLI.
    fs.writeFileSync(AUTOREPLY_LOADED_MARK, nowIso() + '\n');
  } catch {}
}

function safeRead(path: string) {
  try { return fs.readFileSync(path, 'utf8'); } catch { return null; }
}

function readUuidFromFile(): { uuid: string | null, link: string | null } {
  const t = safeRead(UUID_PATH) || '';
  const m = t.match(/uuid=([a-zA-Z0-9-]{8,80})/);
  const uuid = m ? m[1] : null;
  const link = (t.match(/https?:\/\/\S+/) || [null])[0];
  return { uuid, link };
}

function loadState(): any {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function loadLocalPrompts(lang: string): any {
  const safe = String(lang || '').trim().toLowerCase() || 'en';
  const dir = '/opt/bothook/prompts/whatsapp_prompts';
  const pick = fs.existsSync(`${dir}/${safe}.json`) ? safe : 'en';
  try {
    return JSON.parse(fs.readFileSync(`${dir}/${pick}.json`, 'utf8'));
  } catch {
    return null;
  }
}

function readSpecs(): any {
  try { return JSON.parse(fs.readFileSync('/opt/bothook/SPECS.json', 'utf8')); } catch { return {}; }
}

function readInstanceInfo(): any {
  try { return JSON.parse(fs.readFileSync('/opt/bothook/INSTANCE.json', 'utf8')); } catch { return {}; }
}

function saveState(obj: any) {
  try {
    fs.mkdirSync('/opt/bothook', { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2) + '\n');
  } catch {}
}

function sha256(s: string) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function renderTplVars(tpl: string, vars: Record<string, any>) {
  // Minimal template support for known prompts.
  // Replace {{var}} occurrences with provided values.
  let out = String(tpl || '');
  for (const [k, v] of Object.entries(vars || {})) {
    const re = new RegExp('\\{\\{\\s*' + k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s*\\}\\}', 'g');
    out = out.replace(re, String(v ?? ''));
  }
  return out;
}

function minimalWelcomeUnpaid(lang: string, uuid: string) {
  const lc = String(lang || '').toLowerCase();
  const link = `https://p.bothook.me/p/${encodeURIComponent(uuid)}?lang=${encodeURIComponent(lc || 'en')}`;
  if (lc === 'zh' || lc === 'zh-cn' || lc === 'zh-hans') {
    return [
      '[bothook] 设备已关联 ✅',
      '',
      '下一步：',
      `1) 打开控制页完成付款：${link}`,
      '2) 付款后，把你的 OpenAI API Key（以 sk- 开头的一整行）直接发到这里',
      '',
      '如果你没看到其它欢迎词也没关系：只要按上面步骤走就能完成开通。'
    ].join('\n');
  }
  return [
    '[bothook] Device linked ✅',
    '',
    'Next steps:',
    `1) Open your control page and complete payment: ${link}`,
    '2) After payment, paste your OpenAI API key here (ONE line starting with sk-)',
    '',
    'If you didn’t receive the long welcome yet, that’s OK — following the steps above will still complete setup.'
  ].join('\n');
}

function looksLikeOpenAiKey(line: string) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (!t.startsWith('sk-')) return false;
  return t.length >= 20;
}

function digits(s: string) {
  return String(s || '').replace(/\D+/g, '');
}

function isSelfMessage(from: string, selfE164: string | null) {
  if (!selfE164) return false;
  const a = digits(from);
  const b = digits(selfE164);
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

function shouldSuppressOutbound(text: string) {
  const t = String(text || '');
  if (/Embedded agent failed before reply/i.test(t)) return true;
  if (/Agent failed before reply/i.test(t)) return true;
  if (/No API key found for provider\s+"/i.test(t) && /Auth store:/i.test(t)) return true;
  return false;
}

async function postJson(url: string, body: any, timeoutMs = 12000): Promise<any> {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
  } finally {
    clearTimeout(tm);
  }
}

async function getJson(url: string, timeoutMs = 12000): Promise<any> {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
  } finally {
    clearTimeout(tm);
  }
}

async function sendWhatsApp(api: OpenClawPluginApi, to: string, text: string) {
  const send = (api.runtime as any)?.channel?.whatsapp?.sendMessageWhatsApp;
  if (typeof send !== 'function') throw new Error('whatsapp_send_not_available');
  return await send(to, text, { verbose: false });
}

function writeEvidence(name: string, payload: any) {
  try {
    fs.mkdirSync(EVID_DIR, { recursive: true });
    fs.writeFileSync(`${EVID_DIR}/${name}`, JSON.stringify(payload || {}, null, 2) + '\n');
  } catch {}
}

function readSelfE164FromCreds(): string | null {
  // Fallback for cases where runtime readWebSelfId is temporarily unavailable.
  try {
    const p = '/home/ubuntu/.openclaw/credentials/whatsapp/default/creds.json';
    const j = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    const me = j?.me || {};
    const jid = String(me?.id || me?.jid || '').trim();
    if (!jid) return null;
    const num = jid.split('@')[0].split(':')[0];
    const d = digits(num);
    if (!d) return null;
    return d.startsWith('+') ? d : ('+' + d);
  } catch {
    return null;
  }
}

async function getSelfE164(api: OpenClawPluginApi): Promise<string | null> {
  try {
    const readSelf = (api.runtime as any)?.channel?.whatsapp?.readWebSelfId;
    if (typeof readSelf === 'function') {
      const r = await readSelf();
      if (r?.e164 && String(r.e164).startsWith('+')) return String(r.e164);
    }
  } catch {}

  // Fallback: read from Baileys creds.json
  return readSelfE164FromCreds();
}

export default {
  id: 'bothook-wa-autoreply',
  name: 'BOTHook WhatsApp Autoreply',
  description: 'Onboarding: unpaid repeat welcome; paid repeat guide_key_paid on any non-key message until key verified; suppress agent warnings',
  configSchema: emptyPluginConfigSchema(),

  activate(api: OpenClawPluginApi) {
    const logger = api.logger;

    // Evidence for readiness gates (avoid expensive CLI loops in postboot_verify).
    markAutoreplyLoaded();

    // Welcome strategy (instance-side):
    // - If full welcome is available, send full only (never send short).
    // - If full welcome is not available, send short once and schedule full after ~30s.
    // - Always reply to ANY inbound self-chat message (use minimal fallback with light throttling).
    const SHORT_WELCOME_EN = [
      'Device linked successfully ✅',
      "We’re initializing your dedicated assistant server now…",
      'This usually takes ~30 seconds.',
      'You’ll receive the full welcome message shortly.'
    ].join('\n');

    const SHORT_WELCOME_ZH = [
      '[bothook] 设备已关联 ✅',
      '',
      '正在初始化你的专属助手服务器…',
      '通常需要约 30 秒。',
      '稍后会发送完整欢迎信息。'
    ].join('\n');

    function shortWelcomeForLang(lang: string) {
      const lc = String(lang || '').toLowerCase();
      if (lc === 'zh' || lc === 'zh-cn' || lc === 'zh-hans') return SHORT_WELCOME_ZH;
      return SHORT_WELCOME_EN;
    }

    function shouldThrottle(tsIso: any, minMs: number) {
      try {
        if (!tsIso) return false;
        const t = Date.parse(String(tsIso));
        if (!Number.isFinite(t)) return false;
        return (Date.now() - t) < minMs;
      } catch {
        return false;
      }
    }

    async function proactivePushTick() {
      const { uuid, link } = readUuidFromFile();
      if (!uuid) return;

      const st = loadState();
      st.autoreply ||= {};

      const controlPlane = String(process.env.BOTHOOK_API_BASE || 'https://p.bothook.me').replace(/\/$/, '');
      const dr = await getJson(`${controlPlane}/api/delivery/status?uuid=${encodeURIComponent(uuid)}`, 12000);
      if (!dr?.ok) return;

      const status = String(dr?.json?.status || '').trim().toUpperCase();
      const lang = String(dr?.json?.user_lang || '').trim().toLowerCase() || 'en';
      const paid = Boolean(dr?.json?.paid || status === 'PAID' || status === 'DELIVERED');

      const self = await getSelfE164(api);
      if (!self) return;

      // (3) Key verified success (may happen out-of-band via web)
      if (paid) {
        const ks = await getJson(`${controlPlane}/api/key/status?uuid=${encodeURIComponent(uuid)}`, 12000);
        const verified = Boolean(ks?.json?.verified);
        if (verified && !st.autoreply.key_verified_success_sent_at) {
          const pr = await getJson(`${controlPlane}/api/i18n/whatsapp-prompts?lang=${encodeURIComponent(lang)}`, 12000);
          const tpl = String(pr?.json?.prompts?.key_verified_success || '').trim();
          const pLink = link || `https://p.bothook.me/p/${encodeURIComponent(uuid)}?lang=${encodeURIComponent(lang)}`;
          if (tpl) {
            const msg = renderTplVars(tpl, { uuid, p_link: pLink });
            if (msg) await sendWhatsApp(api, self, msg);
          }
          st.autoreply.key_verified_success_sent_at = nowIso();
          st.autoreply.last_any_reply_at = nowIso();
          saveState(st);
          writeEvidence('proactive_push_last.json', { ts: nowIso(), uuid, kind: 'key_verified_success' });
          return;
        }

        // (2) Paid but not verified -> push guide once (even if user hasn't messaged)
        if (!verified && !st.autoreply.proactive_paid_guide_sent_at) {
          const pr = await getJson(`${controlPlane}/api/i18n/whatsapp-prompts?lang=${encodeURIComponent(lang)}`, 12000);
          const tpl = String(pr?.json?.prompts?.guide_key_paid || '').trim();
          if (tpl) {
            const msg = renderTplVars(tpl, { uuid });
            if (msg) await sendWhatsApp(api, self, msg);
          }
          st.autoreply.proactive_paid_guide_sent_at = nowIso();
          st.autoreply.last_any_reply_at = nowIso();
          saveState(st);
          writeEvidence('proactive_push_last.json', { ts: nowIso(), uuid, kind: 'guide_key_paid' });
          return;
        }
      }

      // (1) Unpaid welcome proactive push: only when control-plane says BOUND_UNPAID.
      if (!paid && status === 'BOUND_UNPAID' && !st.autoreply.welcome_full_sent_at) {
        const wr = await getJson(`${controlPlane}/api/wa/welcome_unpaid_text?uuid=${encodeURIComponent(uuid)}`, 15000);
        const text = String(wr?.json?.text || '').trim();
        if (wr.ok && text) {
          await sendWhatsApp(api, self, text);
          st.autoreply.cachedWelcomeUnpaidText = text;
          st.autoreply.cachedWelcomeUnpaidAt = nowIso();
          st.autoreply.cachedWelcomeUnpaidUuid = uuid;
          st.autoreply.welcome_full_sent_at = nowIso();
          st.autoreply.welcome_full_scheduled_at = null;
          st.autoreply.last_any_reply_at = nowIso();
          saveState(st);
          writeEvidence('proactive_push_last.json', { ts: nowIso(), uuid, kind: 'welcome_unpaid' });
          return;
        }
      }
    }

    // Background scheduler: best-effort send full welcome when scheduled.
    const __welcomeFullTimer = setInterval(async () => {
      try {
        const { uuid } = readUuidFromFile();
        if (!uuid) return;
        const st = loadState();
        st.autoreply ||= {};

        // A) scheduled full welcome (legacy path)
        if (!st.autoreply.welcome_full_sent_at) {
          const scheduledAt = st.autoreply.welcome_full_scheduled_at;
          if (scheduledAt) {
            writeEvidence('autoreply_last_tick.json', { ts: nowIso(), uuid, scheduledAt });
            const t = Date.parse(String(scheduledAt));
            if (Number.isFinite(t) && Date.now() >= t) {
              const controlPlane = String(process.env.BOTHOOK_API_BASE || 'https://p.bothook.me').replace(/\/$/, '');
              const wr = await getJson(`${controlPlane}/api/wa/welcome_unpaid_text?uuid=${encodeURIComponent(uuid)}`, 15000);
              const text = String(wr?.json?.text || '').trim();
              if (wr.ok && text) {
                const self = await getSelfE164(api);
                if (self) await sendWhatsApp(api, self, text);
                st.autoreply.welcome_full_sent_at = nowIso();
                st.autoreply.welcome_full_scheduled_at = null;
                saveState(st);
                return;
              }
              // If still not available, push schedule forward (avoid hot loop).
              st.autoreply.welcome_full_scheduled_at = new Date(Date.now() + 30_000).toISOString();
              saveState(st);
            }
          }
        }

        // B) proactive push (unpaid welcome / paid guide / key verified success)
        try { await proactivePushTick(); } catch {}
      } catch {}
    }, 5000);
    // IMPORTANT: do not keep the Node process alive during `openclaw plugins install`.
    // In gateway runtime this is harmless; during install/scan it prevents the command from exiting.
    try { (__welcomeFullTimer as any)?.unref?.(); } catch {}

    api.on('message_sending', async (event, ctx) => {
      if (ctx?.channelId && ctx.channelId !== 'whatsapp') return;
      const content = String((event as any)?.content || '');
      if (shouldSuppressOutbound(content)) return { cancel: true } as any;
    });

    api.on('before_message_write', (event) => {
      try {
        const msg: any = (event as any)?.message;
        const content = String(msg?.content || msg?.text || '').trim();
        if (shouldSuppressOutbound(content)) return { block: true } as any;
      } catch {}
    });

    api.on('message_received', async (event, ctx) => {
      try {
        if (ctx?.channelId !== 'whatsapp') return;

        const from = String((event as any)?.from || '').trim();
        const content = String((event as any)?.content || '').trim();
        if (!from || !content) return;

        const { uuid } = readUuidFromFile();
        if (!uuid) {
          writeEvidence('autoreply_last_skip.json', { ts: nowIso(), reason: 'uuid_missing', from, content_head: content.slice(0, 120) });
          return;
        }

        const self = await getSelfE164(api);
        if (!self) {
          writeEvidence('autoreply_last_skip.json', { ts: nowIso(), reason: 'self_id_null', uuid, from, content_head: content.slice(0, 120) });
          return;
        }

        const isSelf = isSelfMessage(from, self);
        if (!isSelf) {
          // External contact: reply ONCE per sender as a lightweight promo / redirect.
          // This also acts as an inbound liveness proof (if this doesn't send, inbound isn't reaching the gateway).
          st.autoreply ||= {};
          st.autoreply.externalReplied ||= {};
          const k = String(from);
          const last = st.autoreply.externalReplied[k];
          if (!shouldThrottle(last, 24 * 60 * 60 * 1000)) {
            const msg = [
              '[bothook] This assistant is private.',
              'If you want your own assistant, visit: https://bothook.me'
            ].join('\n');
            try { await sendWhatsApp(api, from, msg); } catch {}
            st.autoreply.externalReplied[k] = nowIso();
            saveState(st);
          }
          writeEvidence('autoreply_last_skip.json', { ts: nowIso(), reason: 'external_replied_or_throttled', uuid, from, self });
          return;
        }

        const controlPlane = String(process.env.BOTHOOK_API_BASE || 'https://p.bothook.me').replace(/\/$/, '');

        const st = loadState();
        st.autoreply ||= {};
        const now = Date.now();

        // Fetch delivery status once (paid + lang)
        const dr = await getJson(`${controlPlane}/api/delivery/status?uuid=${encodeURIComponent(uuid)}`, 12000);
        let paid = Boolean(dr?.json?.paid || dr?.json?.status === 'PAID');
        const lang = String(dr?.json?.user_lang || '').trim().toLowerCase() || 'en';

        // Offline fallback: if control-plane is down/unreachable, use a local paid marker.
        // This keeps the state machine self-consistent: after payment, we should show guide not welcome.
        if (!dr?.ok) {
          try {
            if (fs.existsSync('/opt/bothook/evidence/paid')) paid = true;
          } catch {}
        }

        // 1) Paid + key-looking input: verify FIRST.
        //    - verified: send success message and stop repeating.
        //    - not verified: fall through to guide repeat.
        if (paid && looksLikeOpenAiKey(content)) {
          const key = content.split(/\s+/)[0];
          const keyHash = sha256(key);
          if (st.autoreply.lastKeyHash !== keyHash) {
            st.autoreply.lastKeyHash = keyHash;
            st.autoreply.lastKeyAt = nowIso();
            saveState(st);
          }

          const vr = await postJson(`${controlPlane}/api/key/verify`, { uuid, provider: 'openai', key }, 15000);
          if (vr?.json?.verified === true) {
            const okMsg = String(vr?.json?.message || '').trim();
            if (okMsg) await sendWhatsApp(api, self!, okMsg);
            // Mark success so proactive tick won't duplicate.
            st.autoreply.key_verified_success_sent_at = nowIso();
            saveState(st);
            return;
          }

          // Verification failed: send an explicit failure hint once per attempted key hash,
          // then fall through to guide repeat (so the user always sees the next step).
          try {
            const err = String(vr?.json?.error || '').trim();
            if (err === 'key_invalid') {
              st.autoreply ||= {};
              if (st.autoreply.lastKeyVerifyFailHash !== keyHash) {
                st.autoreply.lastKeyVerifyFailHash = keyHash;
                st.autoreply.lastKeyVerifyFailAt = nowIso();
                saveState(st);
                await sendWhatsApp(api, self!, '[bothook] Key verification failed ❌\n\nPlease double-check and paste your OpenAI API key again as ONE line starting with sk-.');
              }
            }
          } catch {}
          // else: continue to guide repeat below
        }

        // 2) Unpaid: stateful welcome (short->full) with de-dupe + "always reply" fallback.
        if (!paid) {
          st.autoreply ||= {};

          const fullSent = Boolean(st.autoreply.welcome_full_sent_at);
          const shortSent = Boolean(st.autoreply.welcome_short_sent_at);

          // (A) Try full welcome first.
          if (!fullSent) {
            const wr = await getJson(`${controlPlane}/api/wa/welcome_unpaid_text?uuid=${encodeURIComponent(uuid)}`, 15000);
            const text = String(wr?.json?.text || '').trim();
            if (wr.ok && text) {
              st.autoreply.cachedWelcomeUnpaidText = text;
              st.autoreply.cachedWelcomeUnpaidAt = nowIso();
              st.autoreply.cachedWelcomeUnpaidUuid = uuid;
              await sendWhatsApp(api, self!, text);
              st.autoreply.welcome_full_sent_at = nowIso();
              st.autoreply.welcome_full_scheduled_at = null;
              st.autoreply.last_any_reply_at = nowIso();
              saveState(st);
              return;
            }
          }

          // (B) If full not available: send short ONCE and schedule full after ~30s.
          if (!fullSent && !shortSent) {
            const shortMsg = shortWelcomeForLang(lang);
            await sendWhatsApp(api, self!, shortMsg);
            st.autoreply.welcome_short_sent_at = nowIso();
            st.autoreply.welcome_full_scheduled_at = new Date(Date.now() + 30_000).toISOString();
            st.autoreply.last_any_reply_at = nowIso();
            saveState(st);
            return;
          }

          // (C) Always reply: if we cannot send full yet and short is already sent,
          // reply with a minimal ack but throttle to avoid spamming.
          if (!fullSent) {
            if (!shouldThrottle(st.autoreply.last_any_reply_at, 15_000)) {
              await sendWhatsApp(api, self!, shortWelcomeForLang(lang));
              st.autoreply.last_any_reply_at = nowIso();
              saveState(st);
              return;
            }
            // Throttled: do nothing.
            return;
          }

          // (D) Full already sent: do NOT spam the full welcome (it contains a short-lived pay link).
          // However, proactive sends are not 100% reliable; if the user pings after linking,
          // echo the same full welcome ONCE as a delivery-confirmation fallback.
          // This should reuse the previously generated pay shortlink when possible.
          if (!st.autoreply.welcome_full_echo_after_user_msg_at) {
            // Only reuse cache if it matches the current UUID context.
            let echoText = (st.autoreply.cachedWelcomeUnpaidUuid === uuid)
              ? String(st.autoreply.cachedWelcomeUnpaidText || '').trim()
              : '';

            // If not cached (rare), fetch once best-effort.
            // NOTE: control-plane will reuse an unexpired pay shortlink; if expired, it will create a new one.
            if (!echoText) {
              const wr = await getJson(`${controlPlane}/api/wa/welcome_unpaid_text?uuid=${encodeURIComponent(uuid)}`, 15000);
              const t = String(wr?.json?.text || '').trim();
              if (wr.ok && t) {
                echoText = t;
                st.autoreply.cachedWelcomeUnpaidText = t;
                st.autoreply.cachedWelcomeUnpaidAt = nowIso();
                st.autoreply.cachedWelcomeUnpaidUuid = uuid;
              }
            }

            if (echoText) {
              await sendWhatsApp(api, self!, echoText);
            } else {
              // Last-resort offline fallback (no pay shortlink generation).
              await sendWhatsApp(api, self!, minimalWelcomeUnpaid(lang, uuid));
            }

            st.autoreply.welcome_full_echo_after_user_msg_at = nowIso();
            st.autoreply.last_any_reply_at = nowIso();
            saveState(st);
          }
        }

        // 3) Paid: if key not verified -> repeat guide_key_paid for ANY non-verified-key message.
        if (paid) {
          const ks = await getJson(`${controlPlane}/api/key/status?uuid=${encodeURIComponent(uuid)}`, 12000);
          const verified = Boolean(ks?.json?.verified);
          if (!verified) {
            // Paid but key not verified: ALWAYS repeat guide_key_paid on any inbound self message.
            // No rate limiting: goal is to guarantee the user always sees the next-step instructions.
            const pr = await getJson(`${controlPlane}/api/i18n/whatsapp-prompts?lang=${encodeURIComponent(lang)}`, 12000);
            const guideTpl = String(pr?.json?.prompts?.guide_key_paid || '').trim();
            if (pr.ok && guideTpl) {
              // Cache last known guide template for offline fallback.
              st.autoreply.cachedGuideKeyPaidTpl = guideTpl;
              st.autoreply.cachedGuideKeyPaidLang = lang;
              st.autoreply.cachedGuideKeyPaidAt = nowIso();
            }

            let tpl = String(guideTpl || st.autoreply.cachedGuideKeyPaidTpl || '').trim();
            if (!tpl) {
              // Offline fallback: load local prompts shipped with artifacts.
              const lp = loadLocalPrompts(lang);
              tpl = String(lp?.guide_key_paid || '').trim();
            }
            if (tpl) {
              const msg = renderTplVars(tpl, { uuid });
              if (msg) {
                await sendWhatsApp(api, self!, msg);
                st.autoreply.lastGuideAt = nowIso();
                saveState(st);
              }
            }
            return;
          }
        }

        // Otherwise: do nothing (normal assistant behavior).
      } catch (e: any) {
        try { logger.warn?.(`[bothook-wa-autoreply] error: ${String(e?.message || e)}`); } catch {}
      }
    });

    logger.info?.('[bothook-wa-autoreply] activated');
  }
};
