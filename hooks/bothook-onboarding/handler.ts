import fs from 'node:fs';
import path from 'node:path';

// Hook handler types are internal; keep it runtime-safe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = async (event: any) => {
  try {
    if (!event || event.type !== 'message' || event.action !== 'received') return;
    const ctx = event.context || {};
    if (ctx.channelId !== 'whatsapp') return;

    const content = String(ctx.content || '').trim();
    const from = String(ctx.from || '').trim();
    const meta = ctx.metadata || {};
    const toE164 = String(meta.to || meta.toE164 || meta.toE164Raw || '').trim();
    const fromE164 = String(meta.senderE164 || meta.sender || from || '').trim();

    // Self-chat heuristic: inbound sender equals the account's own E164.
    const isSelfChat = !!fromE164 && !!toE164 && fromE164 === toE164;

    const UUID = readUuid();
    if (!UUID) return;

    const apiBase = process.env.BOTHOOK_API_BASE || 'https://p.bothook.me';

    // Load state
    const st = loadState(UUID);

    // Fetch delivery status + lang
    const d = await fetchJson(`${apiBase}/api/delivery/status?uuid=${encodeURIComponent(UUID)}`);
    if (!d?.ok) return;

    const paid = Boolean(d.paid);
    const userLang = (d.user_lang || 'en').toString().toLowerCase();

    // Load prompts
    const prompts = await fetchJson(`${apiBase}/api/i18n/whatsapp-prompts?lang=${encodeURIComponent(userLang)}`) || null;
    const p = prompts && prompts.ok ? prompts.prompts : null;
    if (!p) return;

    // External contact promo once
    if (!isSelfChat) {
      const key = fromE164 || from;
      st.promoSentTo = st.promoSentTo || {};
      if (!st.promoSentTo[key]) {
        const msg = render(p.promo_external, await buildVars(apiBase, UUID));
        event.messages.push(msg);
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
      // Always reply with welcome_unpaid (countdown may change).
      const msg = render(p.welcome_unpaid, vars);
      event.messages.push(msg);
      return;
    }

    // Paid but key not verified
    if (!keyVerified) {
      const maybeKey = extractOpenAiKey(content);
      if (maybeKey) {
        const vr = await fetchJson(`${apiBase}/api/key/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ uuid: UUID, provider: 'openai', key: maybeKey })
        });

        if (vr?.ok && vr?.verified) {
          // Install key locally so OpenClaw can respond.
          try { await installOpenAiKeyLocal(maybeKey); } catch {}
          // Tell user success
          event.messages.push(vr.message || '[bothook] OpenAI Key 验证成功 ✅ 现在你可以直接在这里对我说“帮我做什么”。');
          return;
        }

        // Invalid → fall through to guide
      }

      const msg = render(p.guide_key_paid, vars);
      event.messages.push(msg);
      return;
    }

    // Paid + key verified: do nothing; let the model-driven assistant reply.
    return;
  } catch {
    return;
  }
};

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

function loadState(uuid: string): any {
  const p = statePath(uuid);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { promoSentTo: {} };
  }
}

function saveState(uuid: string, obj: any) {
  const p = statePath(uuid);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o755 });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

async function fetchJson(url: string, init?: any) {
  const r = await fetch(url, { redirect: 'follow', ...init });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return null; }
}

function render(tpl: string, vars: Record<string,string>) {
  let out = String(tpl || '');
  for (const [k,v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v ?? ''));
  }
  return out;
}

function extractOpenAiKey(s: string): string | null {
  const t = String(s || '').trim();
  if (!t) return null;
  // common formats: sk-..., also allow sk_...
  const m = t.match(/(sk-[A-Za-z0-9]{20,}|sk_[A-Za-z0-9]{20,})/);
  return m ? m[1] : null;
}

async function buildVars(apiBase: string, uuid: string) {
  const vars: Record<string,string> = {
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

  // p/state contains instance config
  const st = await fetchJson(`${apiBase}/api/p/state?uuid=${encodeURIComponent(uuid)}&lang=en`);
  if (st?.ok) {
    vars.region = String(st.instance?.region || '—');
    vars.public_ip = String(st.instance?.public_ip || '—');
    vars.cpu = String(st.instance?.config?.cpu ?? '—');
    vars.ram_gb = String(st.instance?.config?.memory_gb ?? '—');
    // disk isn't currently exposed; keep placeholder
    vars.p_link = `${apiBase}/p/${encodeURIComponent(uuid)}?lang=en`;
  }

  // pay link
  try {
    const pl = await fetchJson(`${apiBase}/api/pay/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uuid })
    });
    if (pl?.ok && pl?.payUrl) vars.pay_short_link = String(pl.payUrl);
  } catch {}

  // local openclaw version
  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('bash', ['-lc', 'openclaw --version'], { encoding: 'utf8', timeout: 2000 });
    const t = String(r.stdout || '').trim();
    const m = t.match(/OpenClaw\s+([0-9]{4}\.[0-9]+\.[0-9]+-[0-9]+)/i);
    vars.openclaw_version = m ? m[1] : (t || '—');
  } catch {}

  return vars;
}

async function installOpenAiKeyLocal(key: string) {
  // Best-effort: create auth profile store and set default model.
  // Keep it simple; avoid interactive commands.
  const { spawnSync } = await import('node:child_process');

  const agentDir = '/home/ubuntu/.openclaw/agents/main/agent';
  const p = path.join(agentDir, 'auth-profiles.json');
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

  const store = {
    version: 1,
    profiles: {
      'openai:manual': { type: 'api_key', provider: 'openai', key },
    },
    lastGood: { openai: 'openai:manual' },
  };
  fs.writeFileSync(p, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });

  // Switch default model to OpenAI alias
  spawnSync('bash', ['-lc', 'openclaw models set gpt 2>/dev/null || true'], { encoding: 'utf8', timeout: 4000 });
  // Enable self-chat model replies
  spawnSync('bash', ['-lc', 'openclaw config set channels.whatsapp.selfChatMode true 2>/dev/null || true'], { encoding: 'utf8', timeout: 4000 });
  // Restart gateway to pick up auth + config
  spawnSync('bash', ['-lc', 'sudo systemctl restart openclaw-gateway.service 2>/dev/null || true'], { encoding: 'utf8', timeout: 8000 });
}

export default handler;
