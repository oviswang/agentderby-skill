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

write_delivered_marker(){
  local uuid="${BOTHOOK_UUID:-}";
  local controller="${BOTHOOK_CONTROLLER_E164:-}";
  local delivered_at
  delivered_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # IMPORTANT: do NOT overwrite /opt/bothook/state.json; it is used by inbound dedupe.
  cat > "$STATE_DIR/DELIVERED.json" <<JSON
{
  "delivery_status": "DELIVERED",
  "delivered_at": "${delivered_at}",
  "uuid": "${uuid}",
  "controller_e164": "${controller}"
}
JSON
  chmod 644 "$STATE_DIR/DELIVERED.json"

  # Compatibility marker for components that gate on a plain file.
  cp -f "$STATE_DIR/DELIVERED.json" "$STATE_DIR/DELIVERED" 2>/dev/null || true
  chmod 644 "$STATE_DIR/DELIVERED" 2>/dev/null || true

  log "wrote $STATE_DIR/DELIVERED.json"
}

main(){
  need_root

  log "starting cutover"

  backup_file /home/ubuntu/.openclaw/openclaw.json

  # 1) Stop provisioning/onboarding service to avoid prompts/polling.
  # Do not rely on list-unit-files output (can be environment-dependent); best-effort stop/disable.
  systemctl stop bothook-provision.service >/dev/null 2>&1 || true
  systemctl disable bothook-provision.service >/dev/null 2>&1 || true
  log "bothook-provision.service stop+disable attempted"

  # 1b) Stop/disable post-link fixer (should exit after delivery)
  systemctl stop bothook-wa-postlink-fixer.timer bothook-wa-postlink-fixer.path >/dev/null 2>&1 || true
  systemctl disable bothook-wa-postlink-fixer.timer bothook-wa-postlink-fixer.path >/dev/null 2>&1 || true
  log "bothook-wa-postlink-fixer.* stop+disable attempted"

  # 1c) Stop/disable watchdog (high-CPU mitigation). Not needed after delivery and may disrupt normal use.
  systemctl stop bothook-openclaw-watchdog.timer bothook-openclaw-watchdog.service >/dev/null 2>&1 || true
  systemctl disable bothook-openclaw-watchdog.timer >/dev/null 2>&1 || true
  log "bothook-openclaw-watchdog.timer stop+disable attempted"

  # 2) Mark delivered state (for future services to read)
  mkdir -p "$STATE_DIR"
  write_delivered_marker

  # 2b) Marker files for offline/self-consistent state machine.
  # - paid: once delivered, this must be true.
  # - delivered: explicit marker for local checks.
  mkdir -p /opt/bothook/evidence
  touch /opt/bothook/evidence/paid /opt/bothook/evidence/delivered
  chown ubuntu:ubuntu /opt/bothook/evidence/paid /opt/bothook/evidence/delivered || true
  # 3) Delivered-mode hardening:
  # - Disable onboarding responders
  # - Restrict WhatsApp inbound DMs to controller only (dm allowlist)
  # - Disable groups
  if command -v openclaw >/dev/null 2>&1; then
    # IMPORTANT: OpenClaw config must be written as ubuntu.
    # If run as root, openclaw.json becomes root-owned (0600) and breaks subsequent CLI/gateway operations.
    OC="/home/ubuntu/.npm-global/bin/openclaw"

    # Hooks
    sudo -u ubuntu "$OC" config set hooks.internal.entries.bothook-onboarding.enabled false >/dev/null 2>&1 || true
    # Legacy plugin (avoid any more auto prompts)
    sudo -u ubuntu "$OC" plugins disable bothook-wa-autoreply >/dev/null 2>&1 || true

    # Enforce OpenClaw auto-update config (idempotent)
    sudo -u ubuntu "$OC" config set update.channel stable >/dev/null 2>&1 || true
    sudo -u ubuntu "$OC" config set update.checkOnStart false >/dev/null 2>&1 || true
    sudo -u ubuntu "$OC" config set update.auto.enabled true >/dev/null 2>&1 || true
    sudo -u ubuntu "$OC" config set update.auto.stableDelayHours 6 >/dev/null 2>&1 || true
    sudo -u ubuntu "$OC" config set update.auto.stableJitterHours 12 >/dev/null 2>&1 || true
    sudo -u ubuntu "$OC" config set update.auto.betaCheckIntervalHours 1 >/dev/null 2>&1 || true

    # WhatsApp inbound policy (controller-only)
    controller="${BOTHOOK_CONTROLLER_E164:-}"
    if [[ -n "$controller" ]]; then
      sudo -u ubuntu "$OC" config set channels.whatsapp.dmPolicy allowlist >/dev/null 2>&1 || true
      sudo -u ubuntu "$OC" config set channels.whatsapp.allowFrom "[\"$controller\"]" >/dev/null 2>&1 || true
      sudo -u ubuntu "$OC" config set channels.whatsapp.groupPolicy disabled >/dev/null 2>&1 || true
      log "whatsapp inbound restricted to controller: $controller"
    else
      log "BOTHOOK_CONTROLLER_E164 missing; skip whatsapp allowlist"
    fi

    # Ensure config ownership
    chown ubuntu:ubuntu /home/ubuntu/.openclaw/openclaw.json 2>/dev/null || true
    chmod 600 /home/ubuntu/.openclaw/openclaw.json 2>/dev/null || true
  fi

  # 4) Config sanity gate + restart gateway to apply config changes
  # Prevent gateway from getting stuck in "Config invalid. Waiting..." due to env placeholders like ${VAR}.
  if [[ -f /home/ubuntu/.openclaw/openclaw.json ]]; then
    if grep -Eq '\$\{[A-Za-z_][A-Za-z0-9_]*\}' /home/ubuntu/.openclaw/openclaw.json 2>/dev/null; then
      log "WARN: openclaw.json contains env-style placeholders; attempting rollback"
      bak=$(ls -t /home/ubuntu/.openclaw/openclaw.json.bak.* 2>/dev/null | head -n1 || true)
      if [[ -n "$bak" ]]; then
        cp -a "$bak" /home/ubuntu/.openclaw/openclaw.json 2>/dev/null || true
        chown ubuntu:ubuntu /home/ubuntu/.openclaw/openclaw.json 2>/dev/null || true
        chmod 600 /home/ubuntu/.openclaw/openclaw.json 2>/dev/null || true
      fi
    fi
  fi

  # Apply doctor fixes (best-effort)
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw doctor --fix >/dev/null 2>&1 || true

  if systemctl list-unit-files | grep -q '^openclaw-gateway\.service'; then
    systemctl restart openclaw-gateway.service || true
    log "openclaw-gateway.service restarted"
  fi

  # 5) Post-cutover readiness wait + verification (best-effort, non-fatal)
  # Goal: avoid "config written but process not yet synced" confusion after updates/restarts.
  # IMPORTANT: do not block for a long time (SSH cutover is time-bounded).
  if command -v openclaw >/dev/null 2>&1; then
    if openclaw channels status --probe >/tmp/bothook_cutover_probe.txt 2>&1; then
      if grep -qi "not linked" /tmp/bothook_cutover_probe.txt; then
        log "whatsapp not linked; skip connected-wait"
      else
        # Wait up to ~30s for connected (best-effort)
        for i in $(seq 1 6); do
          if grep -qi "whatsapp.*connected" /tmp/bothook_cutover_probe.txt; then
            log "whatsapp connected (probe ok)"
            break
          fi
          sleep 5
          openclaw channels status --probe >/tmp/bothook_cutover_probe.txt 2>&1 || true
        done
      fi
    fi

    # Capture probe output for evidence
    {
      echo "--- channels status --probe ---"
      cat /tmp/bothook_cutover_probe.txt 2>/dev/null || true
      echo "--- gateway probe (timeout=20000) ---"
      openclaw gateway probe --timeout 20000 2>&1 | head -n 80 || true
      echo "--- models status ---"
      openclaw models status --plain 2>&1 | head -n 40 || true
    } >> "$LOG" 2>&1
  fi

  # 6) Evidence snapshot
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
