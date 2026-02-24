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
  // Avoid obvious false positives
  return t.length >= 20;
}

function normalizeFrom(from: string) {
  return String(from || '').trim();
}

function suppressMissingKeyWarning(text: string) {
  const t = String(text || '');
  return /No API key found for provider\s+"anthropic"/i.test(t) && /Agent failed before reply/i.test(t);
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
      // Some implementations return { e164, jid } or jid string
      if (r?.e164 && String(r.e164).startsWith('+')) return String(r.e164);
    }
  } catch {}

  // Fallback: try config-known sender id is not safe; return null.
  return null;
}

export default {
  id: 'bothook-wa-autoreply',
  name: 'BOTHook WhatsApp Autoreply',
  description: 'Self-chat OpenAI key capture+verify and one-time external promo replies; suppress missing-key warnings',
  configSchema: emptyPluginConfigSchema(),

  activate(api: OpenClawPluginApi) {
    const logger = api.logger;

    api.on('message_sending', async (event, ctx) => {
      // Only suppress on WhatsApp
      if (ctx?.channelId !== 'whatsapp') return;
      if (suppressMissingKeyWarning(event?.content || '')) {
        return { cancel: true };
      }
    });

    api.on('message_received', async (event, ctx) => {
      try {
        if (ctx?.channelId !== 'whatsapp') return;

        const from = normalizeFrom(event?.from);
        const content = String(event?.content || '').trim();
        if (!from || !content) return;

        const { uuid, link } = readUuidFromFile();
        if (!uuid) return;

        const self = await getSelfE164(api);

        const st = loadState();
        st.autoreply ||= {};
        st.autoreply.externalReplied ||= {};

        const controlPlane = String(process.env.BOTHOOK_API_BASE || 'https://p.bothook.me').replace(/\/$/, '');

        // Self-chat key capture
        if (self && from.includes(self.replace('+','')) && looksLikeOpenAiKey(content)) {
          const key = content.split(/\s+/)[0];
          const keyHash = sha256(key);
          if (st.autoreply.lastKeyHash === keyHash) {
            // dedup
            return;
          }
          st.autoreply.lastKeyHash = keyHash;
          st.autoreply.lastKeyAt = nowIso();
          saveState(st);

          const vr = await postJson(`${controlPlane}/api/key/verify`, { uuid, provider: 'openai', key }, 15000);
          const msg = vr?.json?.message || (vr?.json?.verified ? '[bothook] OpenAI Key verified ✅' : `[bothook] OpenAI Key verify failed: ${vr?.json?.detail || vr?.json?.error || 'unknown'}`);
          await sendWhatsApp(api, self, msg);
          return;
        }

        // External promo one-time reply
        if (self && !from.includes(self.replace('+',''))) {
          const key = from;
          if (!st.autoreply.externalReplied[key]) {
            st.autoreply.externalReplied[key] = nowIso();
            saveState(st);
            const promo = `[bothook] The owner is activating a private WhatsApp AI assistant (dedicated server).\n\nLearn more: https://bothook.me`;
            await sendWhatsApp(api, from, promo);
          }
        }

        // If self-chat says "hi" and no key verified, remind guide.
        if (self && from.includes(self.replace('+','')) && /^hi$/i.test(content)) {
          const hint = `[bothook] Next: paste your OpenAI API key here as ONE line starting with sk- (self-chat only).\nLink: ${link || `https://p.bothook.me/p/${uuid}`}`;
          await sendWhatsApp(api, self, hint);
        }

      } catch (e: any) {
        try { api.logger.warn(`[bothook-wa-autoreply] error: ${String(e?.message || e)}`); } catch {}
      }
    });

    logger.info('[bothook-wa-autoreply] activated');
  }
};
