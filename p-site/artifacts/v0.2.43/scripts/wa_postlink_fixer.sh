#!/usr/bin/env bash
set -euo pipefail

# BOTHook post-link fixer (instance-side)
# Goal: after WhatsApp linking, ensure openclaw-gateway is restarted once so the
# WhatsApp provider enters running+connected state and welcome/autoreply can fire.
#
# Design goals:
# - Safe: best-effort; never crash-loop systemd.
# - Idempotent: run at most once per UUID (marker file).
# - Scoped: only active during delivery window (requires UUID.txt; disabled after /opt/bothook/DELIVERED).

UUID_PATH=/opt/bothook/UUID.txt
DELIVERED_MARK=/opt/bothook/DELIVERED
EVID_DIR=/opt/bothook/evidence
MARKER=$EVID_DIR/postlink_fixer_done.json
LOG=$EVID_DIR/postlink_fixer.log
CREDS=/home/ubuntu/.openclaw/credentials/whatsapp/default/creds.json

mkdir -p "$EVID_DIR" 2>/dev/null || true

now(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
log(){ echo "[$(now)] $*" >> "$LOG"; }

read_uuid(){
  [[ -f "$UUID_PATH" ]] || return 1
  local u
  u=$(grep -Eo 'uuid=[a-zA-Z0-9-]+' "$UUID_PATH" 2>/dev/null | head -n 1 | cut -d= -f2 || true)
  [[ -n "$u" ]] || return 1
  echo "$u"
}

linked_e164(){
  # Return +E164 if creds.json has me.id/jid.
  [[ -f "$CREDS" ]] || return 1
  python3 - <<'PY'
import json, re
p='/home/ubuntu/.openclaw/credentials/whatsapp/default/creds.json'
try:
  j=json.load(open(p))
except Exception:
  raise SystemExit(1)
me=j.get('me') or {}
jid=str(me.get('id') or me.get('jid') or '').strip()
if not jid:
  raise SystemExit(1)
num=jid.split('@')[0].split(':')[0]
d=re.sub(r'\D+','',num)
if not d:
  raise SystemExit(1)
print('+'+d)
PY
}

marker_uuid(){
  [[ -f "$MARKER" ]] || return 1
  python3 - <<'PY'
import json
p='/opt/bothook/evidence/postlink_fixer_done.json'
try:
  j=json.load(open(p))
  print(j.get('uuid') or '')
except Exception:
  pass
PY
}

should_run(){
  [[ -f "$DELIVERED_MARK" ]] && return 1
  [[ -f "$UUID_PATH" ]] || return 1
  return 0
}

main(){
  if ! should_run; then
    exit 0
  fi

  local uuid
  uuid=$(read_uuid) || { log 'skip: uuid_missing'; exit 0; }

  # Only run once per UUID
  local mu
  mu=$(marker_uuid 2>/dev/null || true)
  if [[ "$mu" == "$uuid" ]]; then
    exit 0
  fi

  local self
  self=$(linked_e164 2>/dev/null || true)
  if [[ -z "$self" ]]; then
    log "skip: not_linked_yet uuid=$uuid"
    exit 0
  fi

  # If gateway is already running fine, don't touch.
  # Best-effort: query openclaw for channel status.
  local status_json
  status_json=$(sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH; openclaw channels status --json' 2>/dev/null || true)

  if [[ -n "$status_json" ]]; then
    # Determine running+connected flags (default account).
    local ok
    ok=$(python3 - <<'PY'
import json,sys
j=json.loads(sys.stdin.read() or '{}')
# Prefer per-account status.
accs=((j.get('channelAccounts') or {}).get('whatsapp') or [])
for a in accs:
  if (a.get('accountId') or '')=='default':
    running=bool(a.get('running'))
    connected=bool(a.get('connected'))
    # If both true, healthy.
    print('1' if (running and connected) else '0')
    raise SystemExit(0)
# Fallback to channel-level.
wa=((j.get('channels') or {}).get('whatsapp') or {})
running=bool(wa.get('running'))
connected=bool(wa.get('connected'))
print('1' if (running and connected) else '0')
PY
<<<"$status_json")

    if [[ "$ok" == "1" ]]; then
      # Already healthy.
      exit 0
    fi
  fi

  log "ACTION: restart gateway after link uuid=$uuid self=$self"

  # The exact manual steps we validated.
  systemctl daemon-reload 2>/dev/null || true
  systemctl restart openclaw-gateway.service 2>/dev/null || true

  # Marker for de-dupe.
  cat >"$MARKER" <<JSON
{"ts":"$(now)","uuid":"$uuid","self":"$self","action":"daemon-reload+restart-openclaw-gateway"}
JSON
  log "ACTION done uuid=$uuid"
}

main "$@"
