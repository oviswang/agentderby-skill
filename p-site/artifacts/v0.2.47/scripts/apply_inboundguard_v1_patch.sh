#!/usr/bin/env bash
set -euo pipefail

# BOTHook inboundguard v1
# Stopgap: patch OpenClaw dist bundles to add deterministic WhatsApp inbound rules:
# - Self-chat "hi" -> send key guide
# - Self-chat paste sk-... -> call control-plane /api/key/verify and reply with result
# - External sender -> one-time promo
# Also avoids relying on plugin message_received hooks.

DIST_DIR=${DIST_DIR:-/home/ubuntu/.npm-global/lib/node_modules/openclaw/dist}
MARKER="BOTHook: inboundguard v1 (whatsapp)"

# Find candidate bundles containing WhatsApp inbound handler (look for isSelfChat + Inbound message log).
mapfile -t CAND < <(grep -RIl "const isSelfChat =" "$DIST_DIR" | grep -E '\.js$' | head -n 200)

if [ ${#CAND[@]} -eq 0 ]; then
  echo "no_candidates_found" >&2
  exit 2
fi

patched=0
for src in "${CAND[@]}"; do
  if sudo grep -q "$MARKER" "$src"; then
    continue
  fi
  # Must also contain the inbound log format
  if ! grep -q "whatsappInboundLog.info(\`Inbound message" "$src"; then
    continue
  fi

  STAMP=$(date -Is)
  sudo cp -a "$src" "$src.bak.bothook.inboundguardv1.$STAMP"

  tmp=$(mktemp)
  sudo cat "$src" > "$tmp"

  python3 - "$tmp" <<'PY'
import sys, re
p=sys.argv[1]
s=open(p,'r',encoding='utf-8').read()
if 'BOTHook: inboundguard v1 (whatsapp)' in s:
  sys.exit(0)

needle = "const isSelfChat = "
idx = s.find(needle)
if idx < 0:
  sys.exit(0)

# Insert right after the isSelfChat line (end of statement ';')
semi = s.find(';', idx)
if semi < 0:
  sys.exit(0)
insert_at = semi+1

block = r"""

\t\t\t\t// BOTHook: inboundguard v1 (whatsapp)
\t\t\t\ttry {
\t\t\t\t\tconst raw = String(params.msg.body ?? "");
\t\t\t\t\tconst text = raw.trim();
\t\t\t\t\tconst selfE164 = params.msg.selfE164 ? String(params.msg.selfE164) : null;
\t\t\t\t\tconst fromE164 = params.msg.senderE164 ? String(params.msg.senderE164) : (params.msg.from?.includes("@") ? jidToE164(params.msg.from) : normalizeE164(params.msg.from));
\t\t\t\t\tconst isSelf = params.msg.chatType !== "group" && Boolean(selfE164) && normalizeE164(fromE164) === normalizeE164(selfE164 ?? "");
\t\t\t\t\t// Load uuid from local file
\t\t\t\t\tlet uuid = null;
\t\t\t\t\tlet pLink = null;
\t\t\t\t\ttry {
\t\t\t\t\t\tconst fs = await import("node:fs");
\t\t\t\t\t\tconst t = fs.readFileSync("/opt/bothook/UUID.txt", "utf8");
\t\t\t\t\t\tconst m = t.match(/uuid=([a-zA-Z0-9-]{8,80})/);
\t\t\t\t\t\tuuid = m ? m[1] : null;
\t\t\t\t\t\tconst lm = t.match(/https?:\/\/\S+/);
\t\t\t\t\t\tpLink = lm ? lm[0] : null;
\t\t\t\t\t} catch {}
\t\t\t\t\tconst cpBase = (process.env.BOTHOOK_API_BASE || "https://p.bothook.me").replace(/\/$/, "");
\t\t\t\t\t// One-time promo state
\t\t\t\t\tlet st = {};
\t\t\t\t\ttry {
\t\t\t\t\t\tconst fs = await import("node:fs");
\t\t\t\t\t\tst = JSON.parse(fs.readFileSync("/opt/bothook/state.json","utf8"));
\t\t\t\t\t} catch { st = {}; }
\t\t\t\t\tst.autoreply = st.autoreply || {};
\t\t\t\t\tst.autoreply.externalReplied = st.autoreply.externalReplied || {};
\t\t\t\t\tconst saveState = async () => {
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\tconst fs = await import("node:fs");
\t\t\t\t\t\t\tfs.mkdirSync("/opt/bothook", { recursive: true });
\t\t\t\t\t\t\tfs.writeFileSync("/opt/bothook/state.json", JSON.stringify(st, null, 2) + "\n");
\t\t\t\t\t\t} catch {}
\t\t\t\t\t};

\t\t\t\t\tconst sendText = async (to, body) => {
\t\t\t\t\t\t// deliverWebReply is in scope below; use it for consistent formatting.
\t\t\t\t\t\tawait deliverWebReply({
\t\t\t\t\t\t\t...params,
\t\t\t\t\t\t\tto,
\t\t\t\t\t\t\tpayload: { text: body },
\t\t\t\t\t\t\tresponsePrefix,
\t\t\t\t\t\t\tprefixOptions,
\t\t\t\t\t\t\ttableMode,
\t\t\t\t\t\t\tchunkMode,
\t\t\t\t\t\t\ttextLimit,
\t\t\t\t\t\t\tmediaLocalRoots
\t\t\t\t\t\t});
\t\t\t\t\t\treturn true;
\t\t\t\t\t};

\t\t\t\t\tif (isSelf && text && (/^(hi|hello|你好|嗨|h+i+)$/i.test(text))) {
\t\t\t\t\t\tconst hint = `[bothook] Next: paste your OpenAI API key here as ONE line starting with sk- (self-chat only).\nLink: ${pLink || (uuid ? `https://p.bothook.me/p/${uuid}` : '')}`;
\t\t\t\t\t\tawait sendText(selfE164, hint);
\t\t\t\t\t\tdidSendReply = true;
\t\t\t\t\t\treturn true;
\t\t\t\t\t}

\t\t\t\t\tif (isSelf && text.startswith("sk-") && uuid) {
\t\t\t\t\t\t// verify key
\t\t\t\t\t\tconst key = text.split(/\s+/)[0];
\t\t\t\t\t\tlet msg = "[bothook] Verifying OpenAI key…";
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\tconst r = await fetch(`${cpBase}/api/key/verify`, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ uuid, provider: 'openai', key }) });
\t\t\t\t\t\t\tconst j = await r.json().catch(() => ({}));
\t\t\t\t\t\t\tmsg = j.message || (j.verified ? '[bothook] OpenAI Key verified ✅' : `[bothook] OpenAI Key verify failed: ${j.detail || j.error || 'unknown'}`);
\t\t\t\t\t\t} catch {
\t\t\t\t\t\t\tmsg = "[bothook] OpenAI Key verify failed: network/server error";
\t\t\t\t\t\t}
\t\t\t\t\t\tawait sendText(selfE164, msg);
\t\t\t\t\t\tdidSendReply = true;
\t\t\t\t\t\treturn true;
\t\t\t\t\t}

\t\t\t\t\t// External promo: one-time per sender
\t\t\t\t\tif (!isSelf && text && fromE164) {
\t\t\t\t\t\tconst k = String(fromE164);
\t\t\t\t\t\tif (!st.autoreply.externalReplied[k]) {
\t\t\t\t\t\t\tst.autoreply.externalReplied[k] = new Date().toISOString();
\t\t\t\t\t\t\tawait saveState();
\t\t\t\t\t\t\tawait sendText(fromE164, `[bothook] The owner is activating a private WhatsApp AI assistant (dedicated server).\n\nLearn more: https://bothook.me`);
\t\t\t\t\t\t\tdidSendReply = true;
\t\t\t\t\t\t\treturn true;
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t} catch {}
"""

# Minor fix: Python string startswith not valid in JS; replace in block after insertion.
block = block.replace('text.startswith', 'text.startsWith')

s2 = s[:insert_at] + block + s[insert_at:]
open(p,'w',encoding='utf-8').write(s2)
print('patched')
PY

  sudo cp -a "$tmp" "$src"
  rm -f "$tmp"
  patched=$((patched+1))

done

echo "patched_files=$patched"
echo "Restarting gateway..."
sudo systemctl restart openclaw-gateway.service
sudo systemctl is-active openclaw-gateway.service
