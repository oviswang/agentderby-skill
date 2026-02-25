#!/usr/bin/env bash
set -euo pipefail

# BOTHook inboundguard v2
# Fix v1: v1 injected into checkInboundAccessControl but incorrectly referenced params.msg.*.
# v2 uses params.from/params.selfE164/params.body (or params.text) where available.

DIST_DIR=${DIST_DIR:-/home/ubuntu/.npm-global/lib/node_modules/openclaw/dist}
MARKER_V1="BOTHook: inboundguard v1 (whatsapp)"
MARKER_V2="BOTHook: inboundguard v2 (whatsapp)"
MARKER_V21="BOTHook: inboundguard v2.1 (whatsapp)"
MARKER_V22="BOTHook: inboundguard v2.2 (whatsapp)"
MARKER_V23="BOTHook: inboundguard v2.3 (whatsapp)"

if [ ! -d "$DIST_DIR" ]; then
  echo "dist_dir_not_found=$DIST_DIR" >&2
  exit 2
fi

# Candidate bundles:
# - If v1 exists: patch those bundles.
# - Else (fresh install): patch bundles containing checkInboundAccessControl.
mapfile -t CAND < <(
  grep -RIl "$MARKER_V1" "$DIST_DIR" 2>/dev/null \
    | grep -E '\.js$' \
    | grep -v '/plugin-sdk/' \
    | grep -v '\.bak\.' \
    | sort -u || true
)

if [ ${#CAND[@]} -eq 0 ]; then
  mapfile -t CAND < <(
    grep -RIl "function checkInboundAccessControl" "$DIST_DIR" \
      | grep -E '\.js$' \
      | grep -v '/plugin-sdk/' \
      | grep -v '\.bak\.' \
      | sort -u
  )
fi

if [ ${#CAND[@]} -eq 0 ]; then
  echo "no_candidates_found" >&2
  exit 3
fi

patched=0
for src in "${CAND[@]}"; do
  # Always enforce readable perms; previous patch runs may have left 0600/root.
  # Only skip if v2.3 is already present.
  if grep -q "$MARKER_V23" "$src"; then
    sudo chown ubuntu:ubuntu "$src" || true
    sudo chmod 644 "$src" || true
    continue
  fi

  STAMP=$(date -Is)
  sudo cp -a "$src" "$src.bak.bothook.inboundguardv2.$STAMP"

  tmp=$(mktemp)
  sudo cat "$src" > "$tmp"

  python3 - "$tmp" <<'PY'
import sys,re
p=sys.argv[1]
s=open(p,'r',encoding='utf-8').read()

if 'BOTHook: inboundguard v2.3 (whatsapp)' in s:
  sys.exit(0)

# Replace the entire v1 try{} block with v2.
# Match from v1 comment to the closing catch block.
pat = re.compile(r"\n[ \t]*// BOTHook: inboundguard v1 \(whatsapp\)\n[ \t]*try \{.*?\n[ \t]*\} catch \{\}\n", re.S)

m=pat.search(s)
# If v1 doesn't exist (fresh install), we'll insert v2 after the `const isSelfChat` line.

v2 = "\n\t\t\t\t// BOTHook: inboundguard v2 (whatsapp)\n\t\t\t\ttry {\n\t\t\t\t\tconst raw = String((params.body ?? params.text ?? '').toString());\n\t\t\t\t\tconst text = raw.trim();\n\t\t\t\t\tconst selfE164 = params.selfE164 ? String(params.selfE164) : null;\n\t\t\t\t\tconst fromE164 = params.from ? String(params.from) : null;\n\t\t\t\t\tconst isGroup = Boolean(params.group);\n\t\t\t\t\tconst isSelf = !isGroup && Boolean(selfE164) && Boolean(fromE164) && normalizeE164(fromE164) === normalizeE164(selfE164);\n\t\t\t\t\tlet uuid = null;\n\t\t\t\t\tlet pLink = null;\n\t\t\t\t\ttry {\n\t\t\t\t\t\tconst fs = await import('node:fs');\n\t\t\t\t\t\tconst t = fs.readFileSync('/opt/bothook/UUID.txt','utf8');\n\t\t\t\t\t\tconst m = t.match(/uuid=([a-zA-Z0-9-]{8,80})/);\n\t\t\t\t\t\tuuid = m ? m[1] : null;\n\t\t\t\t\t\tconst lm = t.match(/https?:\\/\\/\\S+/);\n\t\t\t\t\t\tpLink = lm ? lm[0] : null;\n\t\t\t\t\t} catch {}\n\t\t\t\t\tconst cpBase = (process.env.BOTHOOK_API_BASE || 'https://p.bothook.me').replace(/\\/$/, '');\n\t\t\t\t\tlet st = {};\n\t\t\t\t\ttry {\n\t\t\t\t\t\tconst fs = await import('node:fs');\n\t\t\t\t\t\tst = JSON.parse(fs.readFileSync('/opt/bothook/state.json','utf8'));\n\t\t\t\t\t} catch { st = {}; }\n\t\t\t\t\tst.autoreply = st.autoreply || {};\n\t\t\t\t\tst.autoreply.externalReplied = st.autoreply.externalReplied || {};\n\t\t\t\t\tconst saveState = async () => {\n\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\tconst fs = await import('node:fs');\n\t\t\t\t\t\t\tfs.mkdirSync('/opt/bothook', { recursive: true });\n\t\t\t\t\t\t\tfs.writeFileSync('/opt/bothook/state.json', JSON.stringify(st, null, 2) + '\\n');\n\t\t\t\t\t\t} catch {}\n\t\t\t\t\t};\n\t\t\t\t\tconst sendText = async (to, body) => {\n\t\t\t\t\t\tawait deliverWebReply({\n\t\t\t\t\t\t\t...params,\n\t\t\t\t\t\t\tto,\n\t\t\t\t\t\t\tpayload: { text: body },\n\t\t\t\t\t\t\tresponsePrefix,\n\t\t\t\t\t\t\tprefixOptions,\n\t\t\t\t\t\t\ttableMode,\n\t\t\t\t\t\t\tchunkMode,\n\t\t\t\t\t\t\ttextLimit,\n\t\t\t\t\t\t\tmediaLocalRoots\n\t\t\t\t\t\t});\n\t\t\t\t\t\treturn true;\n\t\t\t\t\t};\n\t\t\t\t\tif (isSelf && text && (/^(hi|hello|你好|嗨|h+i+)$/i.test(text))) {\n\t\t\t\t\t\t\t\t\t\t\t\tlet lang = 'en';\n\t\t\t\t\t\ttry { const mm = String(pLink || '').match(/[?&]lang=([^&#]+)/i); if (mm) lang = decodeURIComponent(mm[1] || 'en').toLowerCase(); } catch {}\n\t\t\t\t\t\tlet msg = `[bothook] Next: paste your OpenAI API key here as ONE line starting with sk- (self-chat only).\\nLink: ${pLink || (uuid ? `https://p.bothook.me/p/${uuid}?lang=${lang}` : '')}`;\n\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\tconst rr = await fetch(`${cpBase}/api/i18n/whatsapp-prompts?lang=${encodeURIComponent(lang)}`, { redirect: 'follow' });\n\t\t\t\t\t\t\tconst tt = await rr.text();\n\t\t\t\t\t\t\tconst jj = JSON.parse(tt);\n\t\t\t\t\t\t\tconst pp = jj && jj.ok ? (jj.prompts || {}) : {};\n\t\t\t\t\t\t\tconst vars = { uuid: uuid || '', p_link: pLink || (uuid ? `https://p.bothook.me/p/${uuid}?lang=${lang}` : '') };\n\t\t\t\t\t\t\tif (pp.guide_key_paid) {\n\t\t\t\t\t\t\t\tmsg = String(pp.guide_key_paid);\n\t\t\t\t\t\t\t\tfor (const k of Object.keys(vars)) msg = msg.split(`{{${k}}}`).join(String(vars[k]));\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t} catch {}\n\t\t\t\t\t\tawait sendText(selfE164, hint);\n\t\t\t\t\t\tdidSendReply = true;\n\t\t\t\t\t\treturn true;\n\t\t\t\t\t}\n\t\t\t\t\tif (isSelf && text.startsWith('sk-') && uuid) {\n\t\t\t\t\t\tconst key = text.split(/\\s+/)[0];\n\t\t\t\t\t\tlet msg = '[bothook] Verifying OpenAI key…';\n\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\tconst r = await fetch(`${cpBase}/api/key/verify`, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ uuid, provider: 'openai', key }) });\n\t\t\t\t\t\t\tconst j = await r.json().catch(() => ({}));\n\t\t\t\t\t\t\tmsg = j.message || (j.verified ? '[bothook] OpenAI Key verified ✅' : `[bothook] OpenAI Key verify failed: ${j.detail || j.error || 'unknown'}`);\n\t\t\t\t\t\t} catch {\n\t\t\t\t\t\t\tmsg = '[bothook] OpenAI Key verify failed: network/server error';\n\t\t\t\t\t\t}\n\t\t\t\t\t\tawait sendText(selfE164, msg);\n\t\t\t\t\t\tdidSendReply = true;\n\t\t\t\t\t\treturn true;\n\t\t\t\t\t}\n\t\t\t\t\tif (!isSelf && !isGroup && text && fromE164) {\n\t\t\t\t\t\tconst k = String(fromE164);\n\t\t\t\t\t\tif (!st.autoreply.externalReplied[k]) {\n\t\t\t\t\t\t\tst.autoreply.externalReplied[k] = new Date().toISOString();\n\t\t\t\t\t\t\tawait saveState();\n\t\t\t\t\t\t\tawait sendText(fromE164, `[bothook] The owner is activating a private WhatsApp AI assistant (dedicated server).\\n\\nLearn more: https://bothook.me`);\n\t\t\t\t\t\t\tdidSendReply = true;\n\t\t\t\t\t\t\treturn true;\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n\t\t\t\t} catch {}\n"

if m:
  s2 = s[:m.start()] + v2 + s[m.end():]
else:
  idx = s.find('function checkInboundAccessControl')
  if idx < 0:
    sys.exit(0)
  is_idx = s.find('const isSelfChat', idx)
  if is_idx < 0:
    sys.exit(0)
  semi = s.find(';', is_idx)
  if semi < 0:
    sys.exit(0)
  insert_at = semi + 1
  s2 = s[:insert_at] + v2 + s[insert_at:]

# v2.3: intercept after message body extraction (handleMessagesUpsert)
if 'BOTHook: inboundguard v2.3 (whatsapp)' not in s2:
  anchor = "\t\t\tconst replyContext = describeReplyContext(msg.message);"
  pos = s2.find(anchor)
  if pos > 0:
    v21 = "\n\t\t\t// BOTHook: inboundguard v2.3 (whatsapp)\n\t\t\ttry {\n\t\t\t\tif (!group) {\n\t\t\t\t\tconst rawBody = String(body || '').trim();\n\t\t\t\t\tconst isSelf = Boolean(selfE164 && from && normalizeE164(from) === normalizeE164(selfE164));\n\t\t\t\t\tif (!isSelf && Boolean(msg.key?.fromMe)) {\n\t\t\t\t\t\t// skip\n\t\t\t\t\t} else {\n\t\t\t\t\t\tlet uuid = null;\n\t\t\t\t\t\tlet pLink = null;\n\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\tconst fs = await import('node:fs');\n\t\t\t\t\t\t\tconst t = fs.readFileSync('/opt/bothook/UUID.txt','utf8');\n\t\t\t\t\t\t\tconst m = t.match(/uuid=([a-zA-Z0-9-]{8,80})/);\n\t\t\t\t\t\t\tuuid = m ? m[1] : null;\n\t\t\t\t\t\t\tconst lm = t.match(/https?:\\/\\/\\S+/);\n\t\t\t\t\t\t\tpLink = lm ? lm[0] : null;\n\t\t\t\t\t\t} catch {}\n\t\t\t\t\t\tconst cpBase = (process.env.BOTHOOK_API_BASE || 'https://p.bothook.me').replace(/\\/$/, '');\n\t\t\t\t\t\tlet st = {};\n\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\tconst fs = await import('node:fs');\n\t\t\t\t\t\t\tst = JSON.parse(fs.readFileSync('/opt/bothook/state.json','utf8'));\n\t\t\t\t\t\t} catch { st = {}; }\n\t\t\t\t\t\tst.autoreply = st.autoreply || {};\n\t\t\t\t\t\tst.autoreply.externalReplied = st.autoreply.externalReplied || {};\n\t\t\t\t\t\tconst saveState = async () => {\n\t\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\t\tconst fs = await import('node:fs');\n\t\t\t\t\t\t\t\tfs.mkdirSync('/opt/bothook', { recursive: true });\n\t\t\t\t\t\t\t\tfs.writeFileSync('/opt/bothook/state.json', JSON.stringify(st, null, 2) + '\\n');\n\t\t\t\t\t\t\t} catch {}\n\t\t\t\t\t\t};\n\t\t\t\t\t\tconst sendText = async (jid, text) => {\n\t\t\t\t\t\t\tawait sock.sendMessage(jid, { text });\n\t\t\t\t\t\t};\n\t\t\t\t\t\tif (isSelf && rawBody && (/^(hi|hello|你好|嗨|h+i+)$/i.test(rawBody))) {\n\t\t\t\t\t\t\tconst hint = `[bothook] Next: paste your OpenAI API key here as ONE line starting with sk- (self-chat only).\\nLink: ${pLink || (uuid ? `https://p.bothook.me/p/${uuid}` : '')}`;\n\t\t\t\t\t\t\tawait sendText(remoteJid, hint);\n\t\t\t\t\t\t\tcontinue;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tif (isSelf && rawBody.startsWith('sk-') && uuid) {\n\t\t\t\t\t\t\tconst key = rawBody.split(/\\s+/)[0];\n\t\t\t\t\t\t\tlet msg2 = '[bothook] Verifying OpenAI key…';\n\t\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\t\tconst r = await fetch(`${cpBase}/api/key/verify`, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ uuid, provider: 'openai', key }) });\n\t\t\t\t\t\t\t\tconst j = await r.json().catch(() => ({}));\n\t\t\t\t\t\t\t\tmsg2 = j.message || (j.verified ? '[bothook] OpenAI Key verified ✅' : `[bothook] OpenAI Key verify failed: ${j.detail || j.error || 'unknown'}`);\n\t\t\t\t\t\t\t} catch {\n\t\t\t\t\t\t\t\tmsg2 = '[bothook] OpenAI Key verify failed: network/server error';\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\tawait sendText(remoteJid, msg2);\n\t\t\t\t\t\t\tcontinue;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tif (!isSelf && senderE164) {\n\t\t\t\t\t\t\tconst k = String(senderE164);\n\t\t\t\t\t\t\tif (!st.autoreply.externalReplied[k]) {\n\t\t\t\t\t\t\t\tst.autoreply.externalReplied[k] = new Date().toISOString();\n\t\t\t\t\t\t\t\tawait saveState();\n\t\t\t\t\t\t\t\tawait sendText(remoteJid, `[bothook] The owner is activating a private WhatsApp AI assistant (dedicated server).\\n\\nLearn more: https://bothook.me`);\n\t\t\t\t\t\t\t\tcontinue;\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t} catch {}\n"
    s2 = s2[:pos] + v21 + s2[pos:]

open(p,'w',encoding='utf-8').write(s2)
print('patched')
PY

  # IMPORTANT: do NOT preserve mktemp perms/owner (mktemp defaults to 0600 root when copied with sudo).
  # If we accidentally leave bundles as 0600/root, whatsapp provider will die with EACCES.
  sudo install -o ubuntu -g ubuntu -m 0644 "$tmp" "$src"
  rm -f "$tmp"
  patched=$((patched+1))
done

echo "patched_files=$patched"
echo "Restarting gateway..."
sudo systemctl restart openclaw-gateway.service
sudo systemctl is-active openclaw-gateway.service

# Reduce probe noise: gateway RPC may take time to become responsive after restart.
for i in $(seq 1 12); do
  if sudo -u ubuntu openclaw gateway probe --timeout 20000 >/tmp/bothook_gateway_probe.txt 2>&1; then
    cat /tmp/bothook_gateway_probe.txt | head -n 40
    exit 0
  fi
  sleep 2
done
cat /tmp/bothook_gateway_probe.txt | head -n 80 || true
exit 0
