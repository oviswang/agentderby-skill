import fs from 'node:fs';
import crypto from 'node:crypto';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk';

const UUID_PATH = '/opt/bothook/UUID.txt';
const STATE_PATH = '/opt/bothook/state.json';

function nowIso(){ return new Date().toISOString(); }

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

function saveState(obj: any) {
  try {
    fs.mkdirSync('/opt/bothook', { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2) + '\n');
  } catch {}
}

function sha256(s: string) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
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
  description: 'Onboarding repeat welcome_unpaid until paid + suppress agent warnings',
  configSchema: emptyPluginConfigSchema(),

  activate(api: OpenClawPluginApi) {
    const logger = api.logger;

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

        const { uuid, link } = readUuidFromFile();
        if (!uuid) return;

        const self = await getSelfE164(api);
        const isSelf = isSelfMessage(from, self);
        if (!isSelf) return;

        const controlPlane = String(process.env.BOTHOOK_API_BASE || 'https://p.bothook.me').replace(/\/$/, '');

        // Gate: if not paid, always repeat welcome_unpaid (source of truth: control-plane rendered text)
        const st = loadState();
        st.autoreply ||= {};
        const lastWelcomeAt = st.autoreply.lastWelcomeAt ? Date.parse(st.autoreply.lastWelcomeAt) : 0;
        const now = Date.now();
        // simple rate limit: at most one welcome every 10s
        if (now - lastWelcomeAt > 10_000) {
          const dr = await getJson(`${controlPlane}/api/delivery/status?uuid=${encodeURIComponent(uuid)}`, 12000);
          const paid = Boolean(dr?.json?.paid || dr?.json?.status === 'PAID');
          if (!paid) {
            const wr = await getJson(`${controlPlane}/api/wa/welcome_unpaid_text?uuid=${encodeURIComponent(uuid)}`, 15000);
            const text = String(wr?.json?.text || '').trim();
            if (wr.ok && text) {
              await sendWhatsApp(api, self!, text);
              st.autoreply.lastWelcomeAt = nowIso();
              saveState(st);
              return;
            }
          }
        }

        // Key capture: forward to control-plane verify endpoint.
        if (looksLikeOpenAiKey(content)) {
          const key = content.split(/\s+/)[0];
          const keyHash = sha256(key);
          if (st.autoreply.lastKeyHash == keyHash) return;
          st.autoreply.lastKeyHash = keyHash;
          st.autoreply.lastKeyAt = nowIso();
          saveState(st);
          await postJson(`${controlPlane}/api/key/verify`, { uuid, provider: 'openai', key }, 15000);
          return;
        }

        // Gentle hint
        if (/^(hi|hello|你好|嗨|h+i+)$/i.test(content)) {
          const hint = `[bothook] Next: paste your OpenAI API key here as ONE line starting with sk- (self-chat only).\nLink: ${link || `${controlPlane}/p/${uuid}`}`;
          await sendWhatsApp(api, self!, hint);
          return;
        }
      } catch (e: any) {
        try { logger.warn?.(`[bothook-wa-autoreply] error: ${String(e?.message || e)}`); } catch {}
      }
    });

    logger.info?.('[bothook-wa-autoreply] activated');
  }
};
