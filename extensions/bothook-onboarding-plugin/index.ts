import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import fs from "node:fs";
import path from "node:path";

function readUuidAndLang(): { uuid: string | null; lang: string } {
  try {
    const t = fs.readFileSync("/opt/bothook/UUID.txt", "utf8");
    const mu = t.match(/uuid\s*=\s*([a-zA-Z0-9-]{8,80})/);
    const mp = t.match(/p_link\s*=\s*(\S+)/);
    const uuid = mu ? mu[1] : null;
    let lang = "en";
    if (mp && mp[1]) {
      try {
        const u = new URL(mp[1]);
        const ql = (u.searchParams.get("lang") || "").toLowerCase();
        if (ql) lang = ql;
      } catch {}
    }
    return { uuid, lang };
  } catch {
    return { uuid: null, lang: "en" };
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, { redirect: "follow", ...init });
  const txt = await r.text();
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function render(tpl: string, vars: Record<string, string>): string {
  let out = String(tpl || "");
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v ?? ""));
  }
  return out;
}

async function buildVars(apiBase: string, uuid: string, lang: string): Promise<Record<string, string>> {
  const vars: Record<string, string> = {
    cpu: "—",
    ram_gb: "—",
    disk_gb: "—",
    region: "—",
    public_ip: "—",
    openclaw_version: "—",
    gateway_port: "18789",
    uuid,
    p_link: `${apiBase}/p/${encodeURIComponent(uuid)}?lang=${encodeURIComponent(lang || "en")}`,
    pay_short_link: "",
    pay_countdown_minutes: "15",
  };

  try {
    const st = await fetchJson(`${apiBase}/api/p/state?uuid=${encodeURIComponent(uuid)}&lang=${encodeURIComponent(lang || "en")}`);
    if (st?.ok) {
      vars.region = String(st.instance?.region || "—");
      vars.public_ip = String(st.instance?.public_ip || "—");
      vars.cpu = String(st.instance?.config?.cpu ?? "—");
      vars.ram_gb = String(st.instance?.config?.memory_gb ?? "—");
    }
  } catch {}

  try {
    const pl = await fetchJson(`${apiBase}/api/pay/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uuid }),
    });
    if (pl?.ok && pl?.payUrl) vars.pay_short_link = String(pl.payUrl);
  } catch {}

  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("bash", ["-lc", "openclaw --version"], { encoding: "utf8", timeout: 2000 });
    vars.openclaw_version = String(r.stdout || "").trim() || "—";
  } catch {}

  return vars;
}

const plugin = {
  id: "bothook-onboarding-plugin",
  name: "BOTHook Onboarding (WhatsApp)",
  description: "Replace default WhatsApp auto-reply errors with BOTHook onboarding prompts",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const apiBase = (process.env.BOTHOOK_API_BASE || "https://p.bothook.me").replace(/\/$/, "");

    api.on("message_sending", async (event, ctx) => {
      try {
        if (ctx.channelId !== "whatsapp") return;
        const body = String(event.content || "");

        // Only intercept the known default warning.
        if (!body.includes("No API key found for provider") && !body.includes("Embedded agent failed before reply")) {
          return;
        }

        const { uuid, lang } = readUuidAndLang();
        if (!uuid) return;

        const d = await fetchJson(`${apiBase}/api/delivery/status?uuid=${encodeURIComponent(uuid)}`);
        if (!d?.ok) return;

        const paid = Boolean(d.paid);
        const userLang = String(d.user_lang || lang || "en").toLowerCase();

        const pr = await fetchJson(`${apiBase}/api/i18n/whatsapp-prompts?lang=${encodeURIComponent(userLang)}`);
        const prompts = pr?.ok ? pr.prompts : null;
        if (!prompts) return;

        const vars = await buildVars(apiBase, uuid, userLang);

        if (!paid) {
          return { content: render(prompts.welcome_unpaid, vars) };
        }

        // Paid: guide key unless already verified
        const ks = await fetchJson(`${apiBase}/api/key/status?uuid=${encodeURIComponent(uuid)}`);
        const verified = Boolean(ks?.ok && ks?.verified);
        if (verified) {
          // If verified, stop intercepting; let normal assistant reply.
          return;
        }
        return { content: render(prompts.guide_key_paid, vars) };
      } catch (err) {
        api.logger.warn?.(`bothook-onboarding-plugin: message_sending hook failed: ${String(err)}`);
        return;
      }
    });
  },
};

export default plugin;
