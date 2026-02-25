import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

function shouldCancel(text: string) {
  const t = String(text || "");
  // Prevent OpenClaw from spamming WhatsApp with missing-key warnings during onboarding.
  // We only cancel the specific embedded-agent warning.
  if (/No API key found for provider\s+"anthropic"/i.test(t) && /Auth store:/i.test(t)) return true;
  if (/Agent failed before reply/i.test(t) && /anthropic/i.test(t)) return true;
  return false;
}

export default {
  id: "bothook-wa-sendguard",
  name: "BOTHook WA Sendguard",
  description: "Cancel embedded-agent missing-key warnings before they hit WhatsApp",
  configSchema: emptyPluginConfigSchema(),

  activate(api: OpenClawPluginApi) {
    api.on("message_sending", async (event, ctx) => {
      if (ctx?.channelId !== "whatsapp") return;
      if (shouldCancel((event as any)?.content || "")) {
        try { api.logger.info("[bothook-wa-sendguard] canceled anthropic missing-key warning"); } catch {}
        return { cancel: true } as any;
      }
    });
    try { api.logger.info("[bothook-wa-sendguard] activated"); } catch {}
  },
};
