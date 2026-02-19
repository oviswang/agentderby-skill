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

  # OpenClaw gateway status endpoint is not standardized here; rely on systemctl status and external checks.

  log "Healthcheck completed."
}

main "$@"
