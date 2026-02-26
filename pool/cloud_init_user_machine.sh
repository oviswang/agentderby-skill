#!/usr/bin/env bash
set -euo pipefail

# BOTHook user-machine bootstrap (cloud-init primary)
# Idempotent installer for pool machines.

log(){ echo "[bothook-cloudinit] $*"; }

require_root(){
  if [[ "$(id -u)" != "0" ]]; then
    echo "must_run_as_root" >&2
    exit 2
  fi
}

install_deps(){
  export DEBIAN_FRONTEND=noninteractive
  log "installing deps"
  apt-get update -y
  apt-get install -y curl ca-certificates jq tmux
}

ensure_node(){
  if command -v node >/dev/null 2>&1; then
    log "node exists: $(node -v)"
    return
  fi
  log "node missing; install nodejs (ubuntu repo)"
  apt-get install -y nodejs npm
}

ensure_openclaw(){
  if command -v openclaw >/dev/null 2>&1; then
    log "openclaw exists: $(openclaw --version 2>/dev/null || true)"
    return
  fi
  log "installing openclaw"
  # npm global prefix
  sudo -u ubuntu bash -lc 'mkdir -p /home/ubuntu/.npm-global && npm config set prefix "/home/ubuntu/.npm-global"'
  sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:$PATH; npm i -g openclaw'
}

place_assets(){
  log "placing /opt/bothook assets"
  mkdir -p /opt/bothook/bin /opt/bothook/evidence /opt/bothook/plugins/bothook-onboarding-plugin/dist
  install -m 755 /home/ubuntu/.openclaw/workspace/pool/postboot_verify.sh /opt/bothook/bin/postboot_verify.sh
  install -m 755 /home/ubuntu/.openclaw/workspace/pool/openclaw-gateway-start.sh /opt/bothook/bin/openclaw-gateway-start.sh
  install -m 644 /home/ubuntu/.openclaw/workspace/pool/bothook-onboarding-plugin/openclaw.plugin.json /opt/bothook/plugins/bothook-onboarding-plugin/openclaw.plugin.json
  install -m 644 /home/ubuntu/.openclaw/workspace/pool/bothook-onboarding-plugin/package.json /opt/bothook/plugins/bothook-onboarding-plugin/package.json
  install -m 644 /home/ubuntu/.openclaw/workspace/pool/bothook-onboarding-plugin/dist/index.js /opt/bothook/plugins/bothook-onboarding-plugin/dist/index.js
}

install_units(){
  log "installing systemd units"
  install -m 644 /home/ubuntu/.openclaw/workspace/pool/openclaw-gateway.service /etc/systemd/system/openclaw-gateway.service
  install -m 644 /home/ubuntu/.openclaw/workspace/pool/bothook-provision.service /etc/systemd/system/bothook-provision.service
  install -m 644 /home/ubuntu/.openclaw/workspace/pool/bothook-postboot-verify.service /etc/systemd/system/bothook-postboot-verify.service

  systemctl daemon-reload
  systemctl enable --now openclaw-gateway.service bothook-provision.service >/dev/null 2>&1 || true
  systemctl enable --now bothook-postboot-verify.service >/dev/null 2>&1 || true
}

main(){
  require_root
  install_deps
  ensure_node
  ensure_openclaw
  place_assets
  install_units
  log "done"
}

main "$@"
