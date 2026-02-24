#!/usr/bin/env bash
set -euo pipefail

# BOTHook bootstrap (public, no secrets)
# Goal: bring a fresh Ubuntu machine to a verifiable "provision-ready" state.
# This version also installs Node.js + OpenClaw and provisions a system-level gateway unit.

ARTIFACT_BASE_URL="${ARTIFACT_BASE_URL:-https://p.bothook.me/artifacts/v0.2.7}"
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
  # Install OpenClaw under the ubuntu user's npm prefix (NOT system-global).
  # Rationale:
  # - systemd service runs as User=ubuntu
  # - service hardening may mount /usr read-only (ProtectSystem=full)
  # - chat-driven updates must work without sudo and without writing to /usr
  local uhome="/home/ubuntu"
  local prefix="$uhome/.npm-global"

  if command -v openclaw >/dev/null 2>&1; then
    log "openclaw already installed: $(openclaw --version 2>/dev/null || true)"
    return 0
  fi

  log "Configuring npm prefix for ubuntu: $prefix"
  mkdir -p "$prefix"
  chown -R ubuntu:ubuntu "$prefix"

  # Ensure future `npm i -g` by ubuntu installs into ~/.npm-global.
  sudo -u ubuntu npm config set prefix "$prefix" >/dev/null

  log "Installing OpenClaw via npm (as ubuntu): $OPENCLAW_NPM_VERSION"
  sudo -u ubuntu npm install -g "$OPENCLAW_NPM_VERSION"

  # Ensure the binary is reachable.
  if [[ -x "$prefix/bin/openclaw" ]]; then
    ln -sf "$prefix/bin/openclaw" /usr/local/bin/openclaw || true
  fi

  log "openclaw installed: $prefix/bin/openclaw"
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
  # Fetch BOTHook ops scripts (send-guard apply/rollback). Do NOT auto-run here.
  mkdir -p "$INSTALL_DIR/ops-scripts"
  fetch "$ARTIFACT_BASE_URL/scripts/apply_sendguard_v2_patch.sh" "$INSTALL_DIR/ops-scripts/apply_sendguard_v2_patch.sh"
  fetch "$ARTIFACT_BASE_URL/scripts/rollback_sendguard_v2_patch.sh" "$INSTALL_DIR/ops-scripts/rollback_sendguard_v2_patch.sh"
  chmod +x "$INSTALL_DIR/ops-scripts/apply_sendguard_v2_patch.sh" "$INSTALL_DIR/ops-scripts/rollback_sendguard_v2_patch.sh"

  chmod +x "$INSTALL_DIR/bin/openclaw-gateway-start.sh"

  # Fetch units
  fetch "$ARTIFACT_BASE_URL/systemd/openclaw-gateway.service" "$INSTALL_DIR/artifacts/openclaw-gateway.service"

  # Install units
  install -m 0644 "$INSTALL_DIR/artifacts/openclaw-gateway.service" "$SYSTEMD_DIR/openclaw-gateway.service"

  systemctl daemon-reload

  # Write a minimal OpenClaw config so the gateway can actually come up.
  # NOTE: No secrets here. Token is randomly generated per machine.
  mkdir -p /home/ubuntu/.openclaw
  chown -R ubuntu:ubuntu /home/ubuntu/.openclaw
  chmod 700 /home/ubuntu/.openclaw

  if [[ ! -f /home/ubuntu/.openclaw/openclaw.json ]]; then
    local token
    token="$(openssl rand -hex 24)"
    cat > /home/ubuntu/.openclaw/openclaw.json <<JSON
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": 18789,
    "auth": { "mode": "token", "token": "${token}" }
  },
  "agents": {
    "defaults": {
      "workspace": "/home/ubuntu/.openclaw/workspace"
    }
  },
  "plugins": {
    "entries": {
      "whatsapp": { "enabled": false },
      "telegram": { "enabled": false }
    }
  }
}
JSON
    chown ubuntu:ubuntu /home/ubuntu/.openclaw/openclaw.json
    chmod 600 /home/ubuntu/.openclaw/openclaw.json
  fi

  # Enable + start gateway to persist across reboot/idle.
  systemctl enable --now openclaw-gateway.service || true

  # If the service was already running and waiting, restart to pick up the new config.
  systemctl restart openclaw-gateway.service || true

  log "Bootstrap done. Gateway service enabled+started."
}

main "$@"
