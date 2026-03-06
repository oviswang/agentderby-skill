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
  # OpenClaw 2026.2.26 requires Node >=22.12.0.
  local v
  v=$(node -v 2>/dev/null | tr -d '\r' || true)
  if [[ -n "$v" ]]; then
    log "node exists: $v"
  fi

  # Hard requirement: Node v22.x. If not, replace it.
  if [[ "$v" =~ ^v22\. ]]; then
    return
  fi

  log "installing nodejs 22.x (NodeSource)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg

  # Remove old distro node/npm if present (prevents staying on v18).
  apt-get remove -y nodejs npm >/dev/null 2>&1 || true
  apt-get autoremove -y >/dev/null 2>&1 || true

  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs

  local v2
  v2=$(node -v 2>/dev/null | tr -d '\r' || true)
  log "node installed: $v2"
  if [[ ! "$v2" =~ ^v22\. ]]; then
    log "FATAL: node version mismatch, expected v22.x got: $v2"
    exit 3
  fi
}

ensure_openclaw(){
  if command -v openclaw >/dev/null 2>&1; then
    log "openclaw exists: $(openclaw --version 2>/dev/null || true)"
    # If an unpinned version exists, replace with pinned to ensure deterministic pre-delivery flow.
    # (Post-delivery can re-enable auto-update.)
    return
  fi
  log "installing openclaw (PINNED)"
  # npm global prefix
  sudo -u ubuntu bash -lc 'mkdir -p /home/ubuntu/.npm-global && npm config set prefix "/home/ubuntu/.npm-global"'
  # Pinned version for pre-delivery deterministic onboarding flow
  sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:$PATH; npm i -g openclaw@2026.2.26'

  # Minimal gateway config to ensure the service can bind on first boot.
  # (OpenClaw 2026.2.26 blocks start if gateway.mode is unset.)
  sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:$PATH; openclaw config set gateway.mode local >/dev/null 2>&1 || true'
  sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:$PATH; openclaw config set gateway.bind loopback >/dev/null 2>&1 || true'
  sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:$PATH; openclaw config set gateway.port 18789 >/dev/null 2>&1 || true'

  # BOTHook patch: ensure whatsapp channel is present so provisioning server can run
  # `openclaw channels login --channel whatsapp` for QR generation.
  sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:$PATH; openclaw config set channels.whatsapp.dmPolicy pairing >/dev/null 2>&1 || true'
  sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:$PATH; openclaw config set channels.whatsapp.groupPolicy allowlist >/dev/null 2>&1 || true'
  sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:$PATH; openclaw config set channels.whatsapp.debounceMs 0 >/dev/null 2>&1 || true'
  sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:$PATH; openclaw config set channels.whatsapp.mediaMaxMb 50 >/dev/null 2>&1 || true'
}

asset_base(){
  # The installer must be runnable on a fresh user machine with NO repo checkout.
  # Convention: ship a folder alongside this script at /tmp/bothook-assets.
  # Allows cloud-init to curl this script + fetch a tarball of assets.
  if [[ -d /tmp/bothook-assets ]]; then
    echo /tmp/bothook-assets
    return
  fi
  # Fallback for legacy dev runs on master.
  if [[ -d /home/ubuntu/.openclaw/workspace/pool ]]; then
    echo /home/ubuntu/.openclaw/workspace/pool
    return
  fi
  echo ""; return 1
}

install_provision_deps(){
  local base; base=$(asset_base)
  if [[ -f "$base/provision/package.json" ]]; then
    log "installing provision deps"

    # Ensure ownership matches systemd runtime user (ubuntu).
    # Otherwise npm/node-gyp rebuilds (e.g. node-pty) can fail with EACCES.
    chown -R ubuntu:ubuntu /opt/bothook/provision

    # Install deps as ubuntu (matches bothook-provision.service User=ubuntu)
    sudo -u ubuntu bash -lc 'cd /opt/bothook/provision && npm i --omit=dev'

    # Ensure node-pty native module is built on the target machine.
    sudo -u ubuntu bash -lc 'cd /opt/bothook/provision && npm rebuild node-pty'

    # Sanity check: pty.node must exist or QR login will crash.
    sudo -u ubuntu bash -lc 'test -f /opt/bothook/provision/node_modules/node-pty/build/Release/pty.node'
  fi
}

place_assets(){
  log "placing /opt/bothook assets"
  local base; base=$(asset_base)
  mkdir -p \
    /opt/bothook/bin \
    /opt/bothook/evidence \
    /opt/bothook/plugins/bothook-onboarding-plugin/dist \
    /opt/bothook/provision

  install -m 755 "$base/postboot_verify.sh" /opt/bothook/bin/postboot_verify.sh
  install -m 755 "$base/openclaw-gateway-start.sh" /opt/bothook/bin/openclaw-gateway-start.sh
  install -m 755 "$base/openclaw_watchdog.sh" /opt/bothook/bin/openclaw_watchdog.sh

  # Provision server (local-only 18999)
  if [[ -f "$base/provision/server.mjs" ]]; then
    install -m 755 "$base/provision/server.mjs" /opt/bothook/provision/server.mjs
  fi
  if [[ -f "$base/provision/package.json" ]]; then
    install -m 644 "$base/provision/package.json" /opt/bothook/provision/package.json
  fi

  install -m 644 "$base/bothook-onboarding-plugin/openclaw.plugin.json" /opt/bothook/plugins/bothook-onboarding-plugin/openclaw.plugin.json
  install -m 644 "$base/bothook-onboarding-plugin/package.json" /opt/bothook/plugins/bothook-onboarding-plugin/package.json
  install -m 644 "$base/bothook-onboarding-plugin/dist/index.js" /opt/bothook/plugins/bothook-onboarding-plugin/dist/index.js
}

install_units(){
  log "installing systemd units"
  local base; base=$(asset_base)
  install -m 644 "$base/openclaw-gateway.service" /etc/systemd/system/openclaw-gateway.service
  install -m 644 "$base/bothook-provision.service" /etc/systemd/system/bothook-provision.service
  install -m 644 "$base/bothook-postboot-verify.service" /etc/systemd/system/bothook-postboot-verify.service
  install -m 644 "$base/bothook-openclaw-watchdog.service" /etc/systemd/system/bothook-openclaw-watchdog.service
  install -m 644 "$base/bothook-openclaw-watchdog.timer" /etc/systemd/system/bothook-openclaw-watchdog.timer

  systemctl daemon-reload
  systemctl enable --now openclaw-gateway.service bothook-provision.service >/dev/null 2>&1 || true
  systemctl enable --now bothook-postboot-verify.service >/dev/null 2>&1 || true
  systemctl enable --now bothook-openclaw-watchdog.timer >/dev/null 2>&1 || true
}

ensure_onboarding_plugins(){
  # Critical path: user must always get deterministic welcome/guide prompts.
  # Ensure autoreply plugin is enabled (best-effort; does not fail bootstrap).
  log "ensuring onboarding plugins enabled"
  sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:$PATH; openclaw plugins enable bothook-wa-autoreply >/dev/null 2>&1 || true'
  sudo systemctl restart openclaw-gateway.service >/dev/null 2>&1 || true
}

main(){
  require_root
  install_deps
  ensure_node
  ensure_openclaw

  place_assets
  install_provision_deps
  install_units
  ensure_onboarding_plugins

  # Verify pinned version
  local v
  v=$(sudo -u ubuntu bash -lc 'export PATH=/home/ubuntu/.npm-global/bin:$PATH; openclaw --version' 2>/dev/null || true)
  if [[ "$v" != "2026.2.26" ]]; then
    log "FATAL: openclaw version mismatch, expected 2026.2.26 got: $v"
    exit 3
  fi

  log "done"
}

main "$@"
