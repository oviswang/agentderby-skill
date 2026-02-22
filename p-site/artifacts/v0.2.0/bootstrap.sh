#!/usr/bin/env bash
set -euo pipefail

# BOTHook bootstrap (public, no secrets)
# Goal: bring a fresh Ubuntu machine to a verifiable "provision-ready" state.
# This version also installs Node.js + OpenClaw and provisions a system-level gateway unit.

ARTIFACT_BASE_URL="${ARTIFACT_BASE_URL:-https://p.bothook.me/artifacts/v0.2.0}"
INSTALL_DIR="${INSTALL_DIR:-/opt/bothook}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"

OPENCLAW_NPM_VERSION="${OPENCLAW_NPM_VERSION:-openclaw}"
NODE_MAJOR="${NODE_MAJOR:-22}"

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

ensure_node(){
  if command -v node >/dev/null 2>&1; then
    log "node already installed: $(node -v)"
    return 0
  fi
  log "Installing Node.js (major=$NODE_MAJOR) via NodeSource"
  apt-get update -y
  apt-get install -y --no-install-recommends ca-certificates curl gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  log "node installed: $(node -v)"
}

ensure_openclaw(){
  if command -v openclaw >/dev/null 2>&1; then
    log "openclaw already installed: $(openclaw --version 2>/dev/null || true)"
    return 0
  fi
  log "Installing OpenClaw via npm: $OPENCLAW_NPM_VERSION"
  npm install -g "$OPENCLAW_NPM_VERSION"
  log "openclaw installed: $(command -v openclaw)"
}

main(){
  need_root

  log "Starting bootstrap. ARTIFACT_BASE_URL=$ARTIFACT_BASE_URL"

  apt-get update -y
  apt-get install -y --no-install-recommends \
    ca-certificates curl jq openssl coreutils \
    build-essential python3 make g++

  mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/artifacts" "$INSTALL_DIR/bin"

  # Install Node.js + OpenClaw (P0.2 requirement)
  ensure_node
  ensure_openclaw

  # Fetch manifest + checksums
  fetch "$ARTIFACT_BASE_URL/manifest.json" "$INSTALL_DIR/artifacts/manifest.json"
  fetch "$ARTIFACT_BASE_URL/sha256sums.txt" "$INSTALL_DIR/artifacts/sha256sums.txt"

  # Fetch scripts
  fetch "$ARTIFACT_BASE_URL/scripts/healthcheck.sh" "$INSTALL_DIR/healthcheck.sh"
  chmod +x "$INSTALL_DIR/healthcheck.sh"

  fetch "$ARTIFACT_BASE_URL/scripts/openclaw-gateway-start.sh" "$INSTALL_DIR/bin/openclaw-gateway-start.sh"
  chmod +x "$INSTALL_DIR/bin/openclaw-gateway-start.sh"

  # Fetch provisioning server bundle
  fetch "$ARTIFACT_BASE_URL/provision/provision.tgz" "$INSTALL_DIR/artifacts/provision.tgz"
  mkdir -p "$INSTALL_DIR/provision"
  tar -xzf "$INSTALL_DIR/artifacts/provision.tgz" -C "$INSTALL_DIR/provision"
  (cd "$INSTALL_DIR/provision" && npm install --omit=dev)

  # Fetch units
  fetch "$ARTIFACT_BASE_URL/systemd/bothook-provision.service" "$INSTALL_DIR/artifacts/bothook-provision.service"
  fetch "$ARTIFACT_BASE_URL/systemd/openclaw-gateway.service" "$INSTALL_DIR/artifacts/openclaw-gateway.service"

  # Install units
  install -m 0644 "$INSTALL_DIR/artifacts/bothook-provision.service" "$SYSTEMD_DIR/bothook-provision.service"
  install -m 0644 "$INSTALL_DIR/artifacts/openclaw-gateway.service" "$SYSTEMD_DIR/openclaw-gateway.service"

  systemctl daemon-reload

  # Enable + start gateway to persist across reboot/idle.
  # The service will block waiting for config file before launching the gateway.
  systemctl enable --now openclaw-gateway.service || true

  # Enable + start provisioning server (Baileys)
  systemctl enable --now bothook-provision.service || true

  log "Bootstrap done. Gateway+Provision services enabled+started."
}

main "$@"
