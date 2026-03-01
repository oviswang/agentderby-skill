#!/usr/bin/env bash
set -euo pipefail

# Applies BOTHook WhatsApp send-guard v3 patch to OpenClaw dist bundles.
# Purpose: suppress noisy embedded-agent missing-key warnings (e.g. anthropic) from being auto-replied.
# This version does NOT rely on hashed dist filenames.

DIST_DIR=${DIST_DIR:-/home/ubuntu/.npm-global/lib/node_modules/openclaw/dist}
MARKER="BOTHook: suppress embedded-agent missing-key warning (anthropic)"

# Find candidate JS bundles that contain deliverWebReply call.
mapfile -t CAND < <(grep -RIl "deliverWebReply" "$DIST_DIR" | grep -E '\.js$' | head -n 200)

if [ ${#CAND[@]} -eq 0 ]; then
  echo "no_candidates_found" >&2
  exit 2
fi

patched=0
for src in "${CAND[@]}"; do
  if sudo grep -q "$MARKER" "$src"; then
    continue
  fi

  # Only patch bundles that contain the exact needle.
  if ! grep -q "await deliverWebReply" "$src"; then
    continue
  fi

  STAMP=$(date -Is)
  sudo cp -a "$src" "$src.bak.bothook.sendguardv3.$STAMP"

  tmp=$(mktemp)
  sudo cat "$src" > "$tmp"

  python3 - "$tmp" <<'PY'
import sys
p=sys.argv[1]
s=open(p,'r',encoding='utf-8').read()
marker="\t\t\t\t// BOTHook: suppress embedded-agent missing-key warning (anthropic) before WhatsApp send\n"
block=(
"\t\t\t\ttry {\n"
"\t\t\t\t\tconst t = payload?.text != null ? String(payload.text) : \"\";\n"
"\t\t\t\t\tif (/No API key found for provider \\\"anthropic\\\"/i.test(t) && /Agent failed before reply/i.test(t)) {\n"
"\t\t\t\t\t\treturn;\n"
"\t\t\t\t\t}\n"
"\t\t\t\t} catch {}\n"
)
needle="\t\t\t\tawait deliverWebReply({"
if marker.strip() in s:
  sys.exit(0)
if needle not in s:
  sys.exit(0)
s2=s.replace(needle, marker+block+needle, 1)
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
