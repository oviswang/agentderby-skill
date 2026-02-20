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

  log "Checking OpenClaw gateway (best-effort)..."
  if systemctl is-active --quiet openclaw-gateway.service; then
    log "openclaw-gateway.service active"
  else
    log "openclaw-gateway.service not active (may be waiting for config)"
  fi
  ss -ltn 2>/dev/null | grep -q ':18789' && log "port 18789 listening" || log "port 18789 not listening"

  if command -v openclaw >/dev/null 2>&1; then
    openclaw gateway status >/dev/null 2>&1 && log "openclaw gateway status OK" || log "openclaw gateway status not ready"
  fi

  log "Healthcheck completed."
}

main "$@"
