#!/usr/bin/env bash
set -euo pipefail

# Basic BOTHook healthcheck (no secrets)
# Intended for automated validation after changes.

log(){ echo "[bothook][healthcheck] $*"; }

main(){
  log "Checking systemd units..."
  systemctl status bothook-provision.service --no-pager >/dev/null 2>&1 || true
  systemctl status openclaw-gateway.service --no-pager >/dev/null 2>&1 || true

  log "Checking local endpoints (best-effort)..."
  # Provision server health (if running)
  curl -fsS --max-time 2 http://127.0.0.1:18999/healthz >/dev/null 2>&1 && log "provision /healthz OK" || log "provision /healthz not ready"

  log "Checking OpenClaw gateway (STRICT gate)..."

  # Gateway service must be active.
  if systemctl is-active --quiet openclaw-gateway.service; then
    log "openclaw-gateway.service active"
  else
    log "FATAL: openclaw-gateway.service not active"
    exit 41
  fi

  # Port must be listening (hard gate).
  if ss -ltn 2>/dev/null | grep -q ':18789'; then
    log "port 18789 listening"
  else
    log "FATAL: port 18789 not listening"
    exit 42
  fi

  # RPC probe must succeed (hard gate). Run as ubuntu so HOME/config/token resolve correctly.
  if [[ -f /home/ubuntu/.openclaw/openclaw.json ]] && command -v openclaw >/dev/null 2>&1; then
    if sudo -u ubuntu -H bash -lc 'export HOME=/home/ubuntu; export OPENCLAW_STATE_DIR=/home/ubuntu/.openclaw; openclaw gateway status >/dev/null 2>&1'; then
      log "openclaw gateway status OK (as ubuntu)"
    else
      log "FATAL: openclaw gateway status failed (as ubuntu)"
      exit 43
    fi
  else
    log "FATAL: openclaw.json missing or openclaw binary not found"
    exit 44
  fi

  log "Healthcheck completed."
}

main "$@"
