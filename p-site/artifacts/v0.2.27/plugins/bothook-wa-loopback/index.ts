import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

function isLoopback(addr?: string | null) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

async function readJson(req: any, maxBytes = 32_000): Promise<any> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body_too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8');
        resolve(s ? JSON.parse(s) : {});
      } catch { reject(new Error('bad_json')); }
    });
    req.on('error', (e: any) => reject(e));
  });
}

export default {
  id: "bothook-wa-loopback",
  name: "BOTHook WA Loopback",
  description: "Loopback-only WhatsApp send endpoint for onboarding (no rescan)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerHttpRoute({
      path: "/__bothook__/wa/send",
      handler: async (req: any, res: any) => {
        try {
          if (!isLoopback(req?.socket?.remoteAddress)) {
            res.statusCode = 403;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok:false, error:'forbidden' }));
            return;
          }
          if ((req.method || 'GET').toUpperCase() !== 'POST') {
            res.statusCode = 405;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok:false, error:'method_not_allowed' }));
            return;
          }

          const body = await readJson(req);
          const to = String(body?.to || '').trim();
          const text = String(body?.text || '').trim();
          if (!to || !text) {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok:false, error:'to_and_text_required' }));
            return;
          }

          const rt: any = (api as any).runtime;
          const send = rt?.channel?.whatsapp?.sendMessageWhatsApp;
          if (typeof send !== 'function') throw new Error('whatsapp_send_not_available');
          const r = await send(to, text, { verbose: false });

          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok:true, result: r }));
        } catch (e: any) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok:false, error:'send_failed', detail: String(e?.message || e) }));
        }
      }
    });
  }
};
