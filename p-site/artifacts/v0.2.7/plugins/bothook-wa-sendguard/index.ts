import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

function shouldCancel(text: string) {
  const t = String(text || "");
  // Prevent OpenClaw from spamming WhatsApp with missing-key warnings during onboarding.
  // We only cancel the specific embedded-agent warning.
  if (/No API key found for provider\s+"anthropic"/i.test(t) && /Auth store:/i.test(t)) return true;
  if (/Agent failed before reply/i.test(t) && /anthropic/i.test(t)) return true;
  return false;
}

export default function register(api: OpenClawPluginApi) {
  api.on("message_sending", async (event, ctx) => {
    const content = String((event as any)?.content || "");
    // Always log a breadcrumb at INFO so we can confirm the hook fires.
    try {
      api.logger.info(`[bothook-wa-sendguard] message_sending channel=${String((ctx as any)?.channelId||'')} to=${String((event as any)?.to||'').slice(0,40)} len=${content.length} head=${JSON.stringify(content.slice(0,120))}`);
    } catch {}

    // Only cancel for WhatsApp.
    const ch = String((ctx as any)?.channelId || "");
    if (ch !== "whatsapp") return;

    // Cancel ANY missing-api-key warnings (provider may vary by default model).
    if (/No API key found for provider\s+"/i.test(content) && /Auth store:/i.test(content)) {
      try { api.logger.info("[bothook-wa-sendguard] canceled missing-key warning"); } catch {}
      return { cancel: true } as any;
    }

    if (shouldCancel(content)) {
      try { api.logger.info("[bothook-wa-sendguard] canceled anthropic missing-key warning"); } catch {}
      return { cancel: true } as any;
    }
  });
  try { api.logger.info("[bothook-wa-sendguard] registered"); } catch {}
}
