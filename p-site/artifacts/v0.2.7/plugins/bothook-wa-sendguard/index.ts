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
    if (ctx?.channelId !== "whatsapp") return;
    const content = String((event as any)?.content || "");
    // Debug breadcrumb (truncate to avoid log bloat)
    try {
      api.logger.debug?.(`[bothook-wa-sendguard] message_sending to=${String((event as any)?.to || '').slice(0,40)} len=${content.length} head=${JSON.stringify(content.slice(0,120))}`);
    } catch {}

    if (shouldCancel(content)) {
      try { api.logger.info("[bothook-wa-sendguard] canceled anthropic missing-key warning"); } catch {}
      return { cancel: true } as any;
    }
  });
  try { api.logger.info("[bothook-wa-sendguard] registered"); } catch {}
}
