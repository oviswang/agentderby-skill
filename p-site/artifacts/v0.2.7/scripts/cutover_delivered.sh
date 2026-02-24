#!/usr/bin/env bash
set -euo pipefail

# BOTHook cutover to DELIVERED mode
# Goal: after (linked + paid + OpenAI key verified), stop onboarding/provisioning behavior
# and leave the machine in "user chat" mode.
#
# Idempotent: safe to re-run.

STATE_DIR="/opt/bothook"
EVID_DIR="/opt/bothook/evidence"
TS="$(date -u +%Y%m%d-%H%M%S)"
LOG="$EVID_DIR/cutover_${TS}.log"

mkdir -p "$EVID_DIR"

log(){ echo "[cutover] $*" | tee -a "$LOG"; }

need_root(){
  if [[ "$(id -u)" != "0" ]]; then
    echo "Must run as root" >&2
    exit 2
  fi
}

backup_file(){
  local p="$1"
  if [[ -f "$p" ]]; then
    cp -a "$p" "$p.bak.$TS"
    log "backup: $p -> $p.bak.$TS"
  fi
}

write_state(){
  local uuid="${BOTHOOK_UUID:-}";
  local controller="${BOTHOOK_CONTROLLER_E164:-}";
  cat > "$STATE_DIR/state.json" <<JSON
{
  "delivery_status": "DELIVERED",
  "delivered_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "uuid": "${uuid}",
  "controller_e164": "${controller}"
}
JSON
  chmod 644 "$STATE_DIR/state.json"
  log "wrote $STATE_DIR/state.json"
}

main(){
  need_root

  log "starting cutover"

  backup_file /home/ubuntu/.openclaw/openclaw.json

  # 1) Stop provisioning/onboarding service to avoid prompts/polling.
  if systemctl list-unit-files | grep -q '^bothook-provision\.service'; then
    systemctl stop bothook-provision.service || true
    systemctl disable bothook-provision.service || true
    log "bothook-provision.service stopped+disabled"
  else
    log "bothook-provision.service not installed (skip)"
  fi

  # 2) Mark delivered state (for future services to read)
  mkdir -p "$STATE_DIR"
  write_state

  # 3) Restart gateway to ensure clean runtime (optional but keeps behavior deterministic)
  if systemctl list-unit-files | grep -q '^openclaw-gateway\.service'; then
    systemctl restart openclaw-gateway.service || true
    log "openclaw-gateway.service restarted"
  fi

  # 4) Evidence snapshot
  {
    echo "--- systemctl ---"
    systemctl is-active openclaw-gateway.service 2>/dev/null || true
    systemctl is-active bothook-provision.service 2>/dev/null || true
    echo "--- ports ---"
    ss -ltnp 2>/dev/null | egrep ':18789\b|:18999\b' || true
  } >> "$LOG" 2>&1

  log "cutover done (see $LOG)"
}

main "$@"
