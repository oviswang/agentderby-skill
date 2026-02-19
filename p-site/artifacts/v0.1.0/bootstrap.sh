#!/usr/bin/env bash
set -euo pipefail

# BOTHook bootstrap (public, no secrets)
# Goal: bring a fresh Ubuntu machine to a verifiable "provision-ready" state.
# This script is designed to be called by cloud-init.

ARTIFACT_BASE_URL="${ARTIFACT_BASE_URL:-https://p.bothook.me/artifacts/v0.1.0}"
INSTALL_DIR="${INSTALL_DIR:-/opt/bothook}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"

log(){ echo "[bothook][bootstrap] $*"; }

need_root(){
  if [[ "$(id -u)" != "0" ]]; then
    echo "Must run as root" >&2
    exit 1
  fi
}

fetch(){
  local url="$1" out="$2"
  log "fetch $url -> $out"
  curl -fsSL "$url" -o "$out"
}

main(){
  need_root

  log "Starting bootstrap. ARTIFACT_BASE_URL=$ARTIFACT_BASE_URL"

  apt-get update -y
  apt-get install -y --no-install-recommends \
    ca-certificates curl jq openssl coreutils

  mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/artifacts"

  # Fetch manifest + checksums
  fetch "$ARTIFACT_BASE_URL/manifest.json" "$INSTALL_DIR/artifacts/manifest.json"
  fetch "$ARTIFACT_BASE_URL/sha256sums.txt" "$INSTALL_DIR/artifacts/sha256sums.txt"

  # Fetch required files
  fetch "$ARTIFACT_BASE_URL/scripts/healthcheck.sh" "$INSTALL_DIR/healthcheck.sh"
  chmod +x "$INSTALL_DIR/healthcheck.sh"

  fetch "$ARTIFACT_BASE_URL/systemd/bothook-provision.service" "$INSTALL_DIR/artifacts/bothook-provision.service"
  fetch "$ARTIFACT_BASE_URL/systemd/openclaw-gateway.service" "$INSTALL_DIR/artifacts/openclaw-gateway.service"

  # Install units
  install -m 0644 "$INSTALL_DIR/artifacts/bothook-provision.service" "$SYSTEMD_DIR/bothook-provision.service"
  install -m 0644 "$INSTALL_DIR/artifacts/openclaw-gateway.service" "$SYSTEMD_DIR/openclaw-gateway.service"

  systemctl daemon-reload

  # NOTE:
  # - We do not start services automatically here because runtime config and WhatsApp linking may happen later.
  # - Cloud-init or subsequent provisioning can enable/start when ready.

  log "Bootstrap done. Next: enable/start services as appropriate and run healthcheck." 
}

main "$@"
