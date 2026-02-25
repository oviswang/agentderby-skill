#!/usr/bin/env bash
set -euo pipefail

# Applies BOTHook WhatsApp send-guard v2 patch to OpenClaw dist bundles.
# Stopgap only; long-term fix should be a supported config toggle.

DIST_DIR=/usr/lib/node_modules/openclaw/dist

# OpenClaw dist filenames are content-hashed and may change across versions.
# Discover targets dynamically instead of hardcoding exact names.
mapfile -t FILES < <(
  cd "$DIST_DIR" 2>/dev/null && {
    ls -1 web-*.js channel-web-*.js plugin-sdk/channel-web-*.js 2>/dev/null || true;
  }
)

if (( ${#FILES[@]} == 0 )); then
  echo "no target dist files found under $DIST_DIR"
  exit 2
fi

STAMP=$(date -Is)
MARKER="BOTHook: suppress embedded-agent missing-key warning (anthropic)"

echo "targets=${#FILES[@]}"
for f in "${FILES[@]}"; do
  src="$DIST_DIR/$f"
  [ -f "$src" ] || { echo "skip_missing: $src"; continue; }

  sudo cp -a "$src" "$src.bak.bothook.sendguardv2.$STAMP"

  if sudo grep -q "$MARKER" "$src"; then
    echo "already patched: $f"
    continue
  fi

  tmp=$(mktemp)
  sudo cat "$src" > "$tmp"

  python3 - "$tmp" <<'PY'
import sys
p=sys.argv[1]
s=open(p,'r',encoding='utf-8').read()
needles=[
  "\t\t\t\tawait deliverWebReply({",
  "\t\t\t\tawait deliverWebReply\\(\\{",
  "\t\t\t\tawait deliverWebReply\(\{",
]
marker="\t\t\t\t// BOTHook: suppress embedded-agent missing-key warning (anthropic) before WhatsApp send\n"
block=(
"\t\t\t\ttry {\n"
"\t\t\t\t\tconst t = payload?.text != null ? String(payload.text) : \"\";\n"
"\t\t\t\t\tif (/No API key found for provider \\\"anthropic\\\"/i.test(t) && /Agent failed before reply/i.test(t)) {\n"
"\t\t\t\t\t\treturn;\n"
"\t\t\t\t\t}\n"
"\t\t\t\t} catch {}\n"
)
if "BOTHook: suppress embedded-agent missing-key warning (anthropic)" in s:
  print('already')
  sys.exit(0)
for needle in needles:
  if needle in s:
    s2=s.replace(needle, marker+block+needle, 1)
    open(p,'w',encoding='utf-8').write(s2)
    print('patched')
    sys.exit(0)
raise SystemExit('needle_not_found')
PY

  sudo cp -a "$tmp" "$src"
  rm -f "$tmp"
  echo "patched: $f"
done

echo "Restarting gateway..."
sudo systemctl restart openclaw-gateway.service
sudo systemctl is-active openclaw-gateway.service
