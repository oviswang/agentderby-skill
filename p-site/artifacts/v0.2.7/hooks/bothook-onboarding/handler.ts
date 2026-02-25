// BOTHook WhatsApp onboarding responder
// Runs inside OpenClaw gateway via internal hooks.
// Sends welcome/guide/promo copy via loopback WhatsApp send endpoint:
//   POST http://127.0.0.1:18789/__bothook__/wa/send
//
// This file intentionally contains no LLM calls.

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = async (event: any) => {
  try {
    if (!event || event.type !== 'message' || event.action !== 'received') return;

    const ctx = event.context || {};
    if (ctx.channelId !== 'whatsapp') return;

    const content = String(ctx.content || '').trim();
    const fromRaw = String(ctx.from || '').trim();
    const meta = ctx.metadata || {};

    const toE164 = normalizeE164(String(meta.to || meta.toE164 || meta.toE164Raw || ''));
    const fromE164 = normalizeE164(String(meta.senderE164 || meta.sender || fromRaw || ''));

    // Self-chat heuristic: inbound sender equals the account's own E164.
    const isSelfChat = !!fromE164 && !!toE164 && fromE164 === toE164;

    try {
      console.log(`[bothook-onboarding] received channel=whatsapp from=${fromE164 || fromRaw} contentLen=${content.length}`);
    } catch {}

    const UUID = readUuid();
    if (!UUID) return;

    // Delivered gate (scheme 1): once /opt/bothook/DELIVERED.json exists, exit onboarding mode.
    // - self-chat: stop sending welcome/guide; let the model-driven assistant reply
    // - external: stay silent
    try {
      if (fs.existsSync('/opt/bothook/DELIVERED.json')) return;
    } catch {}

    const apiBase = process.env.BOTHOOK_API_BASE || 'https://p.bothook.me';

    // Load local state (promo once per external sender)
    const st = loadState(UUID);

    // Determine controller (who owns this delivery after verification)
    const controllerE164 = normalizeE164(String(st.controllerE164 || ''));

    // Fetch delivery status + lang
    const d = await fetchJson(`${apiBase}/api/delivery/status?uuid=${encodeURIComponent(UUID)}`);
    if (!d?.ok) return;

    const paid = Boolean(d.paid);
    const userLang = (d.user_lang || 'en').toString().toLowerCase();

    // Load prompts
    const prompts = await fetchJson(`${apiBase}/api/i18n/whatsapp-prompts?lang=${encodeURIComponent(userLang)}`) || null;
    const p = prompts && prompts.ok ? prompts.prompts : null;
    if (!p) return;

    // External contact: during onboarding, reply promo once. After controller is set (delivery complete), ignore all external DMs.
    if (!isSelfChat) {
      if (controllerE164) return;
      const key = fromE164 || fromRaw;
      st.promoSentTo = st.promoSentTo || {};
      if (!st.promoSentTo[key]) {
        const msg = render(p.promo_external, await buildVars(apiBase, UUID));
        await sendViaLoopback(fromE164 || fromRaw, msg);
        try { console.log('[bothook-onboarding] sent promo_external'); } catch {}
        st.promoSentTo[key] = Date.now();
        saveState(UUID, st);
      }
      return;
    }

    // Self-chat onboarding
    const vars = await buildVars(apiBase, UUID);

    // Determine key status
    const ks = await fetchJson(`${apiBase}/api/key/status?uuid=${encodeURIComponent(UUID)}`);
    const keyVerified = Boolean(ks?.ok && ks?.verified);

    if (!paid) {
      const msg = render(p.welcome_unpaid, vars);
      await sendViaLoopback(fromE164 || fromRaw, msg);
      try { console.log('[bothook-onboarding] sent welcome_unpaid'); } catch {}
      return;
    }

    if (!keyVerified) {
      // If user pasted key, attempt verify
      const maybeKey = extractOpenAiKey(content);
      if (maybeKey) {
        const vr = await fetchJson(`${apiBase}/api/key/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ uuid: UUID, provider: 'openai', key: maybeKey })
        });

        if (vr?.ok && vr?.verified) {
          // Persist controller on first successful verification
          if (!controllerE164 && fromE164) {
            st.controllerE164 = fromE164;
            saveState(UUID, st);
          }
          await sendViaLoopback(fromE164 || fromRaw, vr.message || '[bothook] OpenAI Key 验证成功 ✅');
          return;
        }
      }

      const msg = render(p.guide_key_paid, vars);
      await sendViaLoopback(fromE164 || fromRaw, msg);
      try { console.log('[bothook-onboarding] sent guide_key_paid'); } catch {}
      return;
    }

    // Paid + key verified: do nothing (let model-driven assistant reply).
    return;
  } catch {
    return;
  }
};

function normalizeE164(v: string): string {
  const t = String(v || '').trim();
  if (!t) return '';
  // Already looks like e164
  if (t.startsWith('+') && /\+\d{6,15}/.test(t)) return t.replace(/\s+/g, ' ');

  // WhatsApp JID like 6581194690@s.whatsapp.net
  const m = t.match(/^(\d{6,15})@s\.whatsapp\.net$/);
  if (m) return `+${m[1]}`;

  // bare digits
  const d = t.replace(/\D+/g, '');
  if (d.length >= 6 && d.length <= 15) return `+${d}`;

  return t;
}

function readUuid(): string | null {
  const env = (process.env.BOTHOOK_UUID || '').trim();
  if (env) return env;
  const p = '/opt/bothook/UUID.txt';
  try {
    const t = fs.readFileSync(p, 'utf8');
    const m = t.match(/uuid\s*=\s*([a-zA-Z0-9-]{8,80})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function statePath(uuid: string) {
  return path.join('/opt/bothook', 'onboarding', `${uuid}.json`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadState(uuid: string): any {
  const p = statePath(uuid);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { promoSentTo: {} };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function saveState(uuid: string, obj: any) {
  const p = statePath(uuid);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o755 });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJson(url: string, init?: any) {
  const r = await fetch(url, { redirect: 'follow', ...init });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return null; }
}

function render(tpl: string, vars: Record<string, string>) {
  let out = String(tpl || '');
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v ?? ''));
  }
  return out;
}

function extractOpenAiKey(s: string): string | null {
  // Users may paste keys with line wraps or extra whitespace. Normalize first.
  // New-format keys like `sk-proj-...` can contain hyphens/underscores.
  const raw = String(s || '');
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // 1) Prefer a token that starts with sk- (incl. sk-proj-) and allows [-_A-Za-z0-9]
  //    We also accept the legacy sk_ prefix.
  const m = t.match(/\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_[A-Za-z0-9_-]{20,})\b/);
  if (m) return m[1];

  // 2) Fallback: remove all whitespace and try again (handles hard line breaks).
  const compact = raw.replace(/\s+/g, '');
  const m2 = compact.match(/(sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_[A-Za-z0-9_-]{20,})/);
  return m2 ? m2[1] : null;
}

async function buildVars(apiBase: string, uuid: string) {
  const vars: Record<string, string> = {
    cpu: '—',
    ram_gb: '—',
    disk_gb: '—',
    region: '—',
    public_ip: '—',
    openclaw_version: '—',
    gateway_port: '18789',
    uuid,
    p_link: `${apiBase}/p/${encodeURIComponent(uuid)}?lang=en`,
    pay_short_link: `${apiBase}/?uuid=${encodeURIComponent(uuid)}`,
    pay_countdown_minutes: '15',
  };

  try {
    const st = await fetchJson(`${apiBase}/api/p/state?uuid=${encodeURIComponent(uuid)}&lang=en`);
    if (st?.ok) {
      vars.region = String(st.instance?.region || '—');
      vars.public_ip = String(st.instance?.public_ip || '—');
      vars.cpu = String(st.instance?.config?.cpu ?? '—');
      vars.ram_gb = String(st.instance?.config?.memory_gb ?? '—');
      vars.p_link = `${apiBase}/p/${encodeURIComponent(uuid)}?lang=en`;
    }
  } catch {}

  try {
    const pl = await fetchJson(`${apiBase}/api/pay/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uuid })
    });
    if (pl?.ok && pl?.payUrl) vars.pay_short_link = String(pl.payUrl);
  } catch {}

  return vars;
}

async function sendViaLoopback(to: string, text: string) {
  const target = normalizeE164(String(to || '').trim());
  const msg = String(text || '').trim();
  if (!target || !msg) return;

  await fetch('http://127.0.0.1:18789/__bothook__/wa/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: target, text: msg })
  });
}

export default handler;
