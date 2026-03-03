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

async function getSelfE164(api: OpenClawPluginApi): Promise<string | null> {
  try {
    const readSelf = (api.runtime as any)?.channel?.whatsapp?.readWebSelfId;
    if (typeof readSelf === 'function') {
      const r = await readSelf();
      if (r?.e164 && String(r.e164).startsWith('+')) return String(r.e164);
    }
  } catch {}
  return null;
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
        if (!uuid) return;

        const self = await getSelfE164(api);
        const isSelf = isSelfMessage(from, self);
        if (!isSelf) return;

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
            return;
          }
          // else: continue to guide repeat below
        }

        // 2) Unpaid: ALWAYS repeat welcome_unpaid on any inbound self message.
        // No rate limiting: goal is to guarantee the user always sees the onboarding instructions.
        if (!paid) {
          const wr = await getJson(`${controlPlane}/api/wa/welcome_unpaid_text?uuid=${encodeURIComponent(uuid)}`, 15000);
          const text = String(wr?.json?.text || '').trim();
          if (wr.ok && text) {
            // Cache last known welcome text for offline fallback.
            st.autoreply.cachedWelcomeUnpaidText = text;
            st.autoreply.cachedWelcomeUnpaidAt = nowIso();
            await sendWhatsApp(api, self!, text);
            st.autoreply.lastWelcomeAt = nowIso();
            saveState(st);
            return;
          }

          // Fallback 1: reuse cached welcome text.
          const cached = String(st.autoreply.cachedWelcomeUnpaidText || '').trim();
          if (cached) {
            await sendWhatsApp(api, self!, cached);
            st.autoreply.lastWelcomeAt = nowIso();
            saveState(st);
            return;
          }

          // Fallback 2: use local prompts shipped with artifacts.
          const lp = loadLocalPrompts(lang);
          const tpl = String(lp?.welcome_unpaid || '').trim();
          if (tpl) {
            const specs = readSpecs();
            const instInfo = readInstanceInfo();
            const msg = renderTplVars(tpl, {
              uuid,
              p_link: `https://p.bothook.me/p/${encodeURIComponent(uuid)}?lang=${encodeURIComponent(lang)}`,
              pay_countdown_minutes: 15,
              pay_short_link: '',
              region: String(instInfo.region || ''),
              public_ip: String(instInfo.public_ip || ''),
              cpu: String(specs.cpu ?? ''),
              ram_gb: String(specs.ram_gb ?? ''),
              disk_gb: String(specs.disk_gb ?? ''),
              openclaw_version: String(specs.openclaw_version || '')
            });
            if (msg) {
              await sendWhatsApp(api, self!, msg);
              st.autoreply.lastWelcomeAt = nowIso();
              saveState(st);
              return;
            }
          }

          // No cached/local copy available; fall through.
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
