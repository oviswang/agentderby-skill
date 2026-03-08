#!/usr/bin/env bash
set -euo pipefail

# Roll back BOTHook WhatsApp send-guard v2 patch.
# Strategy:
# 1) Prefer restoring the most recent backup that does NOT contain the BOTHook marker.
# 2) If no such backup exists, strip the injected guard block from the current file in-place.

DIST_DIR=/usr/lib/node_modules/openclaw/dist
FILES=(
  web-tbmTLGBn.js
  web-BHPg4pGj.js
  web-BCbBlAe7.js
  plugin-sdk/channel-web-BD3nsk4K.js
  channel-web-GHPBNjVW.js
)

MARKER="BOTHook: suppress embedded-agent missing-key warning (anthropic)"

pick_clean_backup() {
  local src="$1"
  # newest -> oldest
  ls -1 "${src}.bak.bothook.sendguardv2."* 2>/dev/null | sort -r | while read -r bk; do
    if ! grep -q "$MARKER" "$bk"; then
      echo "$bk"
      return 0
    fi
  done
  return 1
}

strip_in_place() {
  local src="$1"
  python3 - "$src" <<'PY'
import sys,re
p=sys.argv[1]
s=open(p,'r',encoding='utf-8').read()
marker=r"\t\t\t\t// BOTHook: suppress embedded-agent missing-key warning \(anthropic\) before WhatsApp send\n"
block=r"\t\t\t\ttry \{\n\t\t\t\t\tconst t = payload\?\.text != null \? String\(payload\.text\) : \"\";\n\t\t\t\t\tif \(/No API key found for provider \\\"anthropic\\\"/i\.test\(t\) && /Agent failed before reply/i\.test\(t\)\) \{\n\t\t\t\t\t\treturn;\n\t\t\t\t\t\}\n\t\t\t\t\} catch \{\}\n"
needle=r"\t\t\t\tawait deliverWebReply\(\{"
pat=re.compile(marker+block+needle)
if not re.search(pat,s):
    # already clean or format changed
    print('no_strip_match')
    sys.exit(0)
s2=re.sub(pat, needle, s, count=1)
open(p,'w',encoding='utf-8').write(s2)
print('stripped')
PY
}

for f in "${FILES[@]}"; do
  src="$DIST_DIR/$f"
  [ -f "$src" ] || { echo "missing: $src"; exit 2; }

  if bk=$(pick_clean_backup "$src"); then
    echo "restore(clean): $bk -> $src"
    sudo cp -a "$bk" "$src"
  else
    echo "no clean backup found for: $src ; stripping in place"
    sudo cp -a "$src" "$src.bak.bothook.rollbackstrip.$(date -Is)"
    sudo python3 -c "import runpy; runpy.run_path('/dev/stdin')" <<'PY'
PY
    # run strip using unprivileged python but with sudo not available; easiest: copy to tmp, strip, then sudo cp back
    tmp=$(mktemp)
    sudo cat "$src" > "$tmp"
    python3 - "$tmp" <<'PY'
import sys,re
p=sys.argv[1]
s=open(p,'r',encoding='utf-8').read()
marker=r"\t\t\t\t// BOTHook: suppress embedded-agent missing-key warning \(anthropic\) before WhatsApp send\n"
block=r"\t\t\t\ttry \{\n\t\t\t\t\tconst t = payload\?\.text != null \? String\(payload\.text\) : \"\";\n\t\t\t\t\tif \(/No API key found for provider \\\"anthropic\\\"/i\.test\(t\) && /Agent failed before reply/i\.test\(t\)\) \{\n\t\t\t\t\t\treturn;\n\t\t\t\t\t\}\n\t\t\t\t\} catch \{\}\n"
needle=r"\t\t\t\tawait deliverWebReply\(\{"
pat=re.compile(marker+block+needle)
if not re.search(pat,s):
    print('no_strip_match')
    sys.exit(0)
s2=re.sub(pat, needle, s, count=1)
open(p,'w',encoding='utf-8').write(s2)
print('stripped')
PY
    sudo cp -a "$tmp" "$src"
    rm -f "$tmp"
  fi
done

echo "Restarting gateway..."
sudo systemctl restart openclaw-gateway.service
sudo systemctl is-active openclaw-gateway.service
