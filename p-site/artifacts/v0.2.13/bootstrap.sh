#!/usr/bin/env bash
set -euo pipefail

# BOTHook bootstrap (public, no secrets)
# Goal: bring a fresh Ubuntu machine to a verifiable "provision-ready" state.
# This version also installs Node.js + OpenClaw and provisions a system-level gateway unit.

ARTIFACT_BASE_URL="${ARTIFACT_BASE_URL:-https://p.bothook.me/artifacts/v0.2.13}"
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
  # Harden: retry transient network failures.
  curl -fsSL --retry 5 --retry-delay 1 --retry-all-errors "$url" -o "$out"
}

verify_sha(){
  local rel="$1" out="$2" sums="$3"
  local expected actual
  expected="$(awk -v r="$rel" '$2==r{print $1}' "$sums" | head -n 1)"
  if [[ -z "$expected" ]]; then
    echo "missing_checksum:$rel" >&2
    exit 9
  fi
  actual="$(sha256sum "$out" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "checksum_mismatch:$rel expected=$expected actual=$actual" >&2
    exit 10
  fi
}

fetch_verified(){
  local rel="$1" out="$2" sums="$3"
  fetch "$ARTIFACT_BASE_URL/$rel" "$out"
  verify_sha "$rel" "$out" "$sums"
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

  local pinned_ver="2026.2.26"
  local tarball_url="https://p.bothook.me/artifacts/openclaw/openclaw-${pinned_ver}.tgz"

  # If already pinned, keep.
  if command -v openclaw >/dev/null 2>&1; then
    local have=""
    have="$(openclaw --version 2>/dev/null || true)"
    if [[ "$have" == "$pinned_ver" ]]; then
      log "openclaw already installed (pinned): $have"
      return 0
    fi
    log "openclaw present but not pinned (have=$have want=$pinned_ver); upgrading"
  fi

  log "Configuring npm prefix for ubuntu: $prefix"
  mkdir -p "$prefix"
  chown -R ubuntu:ubuntu "$prefix"

  # Ensure future `npm i -g` by ubuntu installs into ~/.npm-global.
  sudo -u ubuntu npm config set prefix "$prefix" >/dev/null


  # Harden npm behavior for flaky networks.
  sudo -u ubuntu npm config set fetch-retries 5 >/dev/null || true
  sudo -u ubuntu npm config set fetch-retry-mintimeout 20000 >/dev/null || true
  sudo -u ubuntu npm config set fetch-retry-maxtimeout 120000 >/dev/null || true


  # 1) Prefer npm registry pinned version (unless forced to tarball).
  log "Installing OpenClaw pinned (as ubuntu): openclaw@$pinned_ver"
  local force_tarball="${BOTHOOK_FORCE_OPENCLAW_TARBALL:-0}"

  if [[ "$force_tarball" = "1" ]]; then
    log "BOTHOOK_FORCE_OPENCLAW_TARBALL=1; skipping npm registry"
  else
    # Use a hard timeout so pool init doesn't hang forever on npm.
    if timeout 600 sudo -u ubuntu npm install -g "openclaw@${pinned_ver}"; then
      :
    else
      log "npm registry install failed or timed out; fallback to tarball"
      force_tarball="1"
    fi
  fi

  if [[ "$force_tarball" = "1" ]]; then
    log "Installing OpenClaw from tarball: $tarball_url"
    local tmp=/tmp/openclaw.tgz
    curl -fsSL --retry 5 --retry-delay 1 --retry-all-errors "$tarball_url" -o "$tmp"
    timeout 600 sudo -u ubuntu npm install -g "$tmp"
  fi


  # Hard-validate install completed (npm global install can leave partial dirs on interruption).
  # If this fails, stop bootstrap early so pool init marks NEEDS_VERIFY instead of silently producing a broken READY.
  if [[ ! -x "$prefix/bin/openclaw" ]]; then
    log "FATAL: openclaw binary missing at $prefix/bin/openclaw after install"
    exit 21
  fi
  if ! sudo -u ubuntu "$prefix/bin/openclaw" --version >/dev/null 2>&1; then
    log "FATAL: openclaw --version failed after install"
    exit 22
  fi

  # Ensure the binary is reachable.
  ln -sf "$prefix/bin/openclaw" /usr/local/bin/openclaw || true

  log "openclaw installed: $prefix/bin/openclaw ($(sudo -u ubuntu $prefix/bin/openclaw --version 2>/dev/null || true))"
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

  # Ensure WhatsApp channel plugin is enabled (required for QR login flows)
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins enable whatsapp >/dev/null 2>&1 || true

  # Fetch manifest + checksums (and verify integrity)
  fetch "$ARTIFACT_BASE_URL/sha256sums.txt" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "manifest.json" "$INSTALL_DIR/artifacts/manifest.json" "$INSTALL_DIR/artifacts/sha256sums.txt"

  # Fetch scripts (verified)
  fetch_verified "scripts/healthcheck.sh" "$INSTALL_DIR/healthcheck.sh" "$INSTALL_DIR/artifacts/sha256sums.txt"
  chmod +x "$INSTALL_DIR/healthcheck.sh"

  fetch_verified "scripts/openclaw-gateway-start.sh" "$INSTALL_DIR/bin/openclaw-gateway-start.sh" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "scripts/postboot_verify.sh" "$INSTALL_DIR/bin/postboot_verify.sh" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "scripts/cutover_delivered.sh" "$INSTALL_DIR/bin/cutover_delivered.sh" "$INSTALL_DIR/artifacts/sha256sums.txt"

  # Fetch provisioning server (Baileys) source bundle (verified)
  mkdir -p "$INSTALL_DIR/provision"
  fetch_verified "provision/server.mjs" "$INSTALL_DIR/provision/server.mjs" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "provision/package.json" "$INSTALL_DIR/provision/package.json" "$INSTALL_DIR/artifacts/sha256sums.txt"

  # Fetch BOTHook OpenClaw plugins (verified; B-mode: hook responder + loopback send + sendguard)
  mkdir -p "$INSTALL_DIR/plugins/bothook-wa-loopback"
  fetch_verified "plugins/bothook-wa-loopback/openclaw.plugin.json" "$INSTALL_DIR/plugins/bothook-wa-loopback/openclaw.plugin.json" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "plugins/bothook-wa-loopback/package.json" "$INSTALL_DIR/plugins/bothook-wa-loopback/package.json" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "plugins/bothook-wa-loopback/index.ts" "$INSTALL_DIR/plugins/bothook-wa-loopback/index.ts" "$INSTALL_DIR/artifacts/sha256sums.txt"

  mkdir -p "$INSTALL_DIR/plugins/bothook-wa-sendguard"
  fetch_verified "plugins/bothook-wa-sendguard/openclaw.plugin.json" "$INSTALL_DIR/plugins/bothook-wa-sendguard/openclaw.plugin.json" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "plugins/bothook-wa-sendguard/package.json" "$INSTALL_DIR/plugins/bothook-wa-sendguard/package.json" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "plugins/bothook-wa-sendguard/index.ts" "$INSTALL_DIR/plugins/bothook-wa-sendguard/index.ts" "$INSTALL_DIR/artifacts/sha256sums.txt"


  mkdir -p "$INSTALL_DIR/plugins/bothook-wa-autoreply"
  fetch_verified "plugins/bothook-wa-autoreply/openclaw.plugin.json" "$INSTALL_DIR/plugins/bothook-wa-autoreply/openclaw.plugin.json" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "plugins/bothook-wa-autoreply/package.json" "$INSTALL_DIR/plugins/bothook-wa-autoreply/package.json" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "plugins/bothook-wa-autoreply/index.ts" "$INSTALL_DIR/plugins/bothook-wa-autoreply/index.ts" "$INSTALL_DIR/artifacts/sha256sums.txt"

  # Fetch BOTHook internal hook responder (verified)
  mkdir -p /home/ubuntu/.openclaw/workspace/hooks/bothook-onboarding
  fetch_verified "hooks/bothook-onboarding/handler.ts" /home/ubuntu/.openclaw/workspace/hooks/bothook-onboarding/handler.ts "$INSTALL_DIR/artifacts/sha256sums.txt"
  chown -R ubuntu:ubuntu /home/ubuntu/.openclaw/workspace

  # Fetch BOTHook ops scripts (verified; do NOT auto-run here.)
  mkdir -p "$INSTALL_DIR/ops-scripts"
  fetch_verified "scripts/apply_sendguard_v2_patch.sh" "$INSTALL_DIR/ops-scripts/apply_sendguard_v2_patch.sh" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "scripts/rollback_sendguard_v2_patch.sh" "$INSTALL_DIR/ops-scripts/rollback_sendguard_v2_patch.sh" "$INSTALL_DIR/artifacts/sha256sums.txt"
  chmod +x "$INSTALL_DIR/ops-scripts/apply_sendguard_v2_patch.sh" "$INSTALL_DIR/ops-scripts/rollback_sendguard_v2_patch.sh"

  chmod +x "$INSTALL_DIR/bin/openclaw-gateway-start.sh" "$INSTALL_DIR/bin/postboot_verify.sh" "$INSTALL_DIR/bin/cutover_delivered.sh"

  # Fetch units (verified)
  fetch_verified "systemd/openclaw-gateway.service" "$INSTALL_DIR/artifacts/openclaw-gateway.service" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "systemd/bothook-provision.service" "$INSTALL_DIR/artifacts/bothook-provision.service" "$INSTALL_DIR/artifacts/sha256sums.txt"
  fetch_verified "systemd/bothook-postboot-verify.service" "$INSTALL_DIR/artifacts/bothook-postboot-verify.service" "$INSTALL_DIR/artifacts/sha256sums.txt"

  # Install units
  install -m 0644 "$INSTALL_DIR/artifacts/openclaw-gateway.service" "$SYSTEMD_DIR/openclaw-gateway.service"
  install -m 0644 "$INSTALL_DIR/artifacts/bothook-provision.service" "$SYSTEMD_DIR/bothook-provision.service"
  install -m 0644 "$INSTALL_DIR/artifacts/bothook-postboot-verify.service" "$SYSTEMD_DIR/bothook-postboot-verify.service"

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
  "update": {
    "channel": "stable",
    "checkOnStart": false,
    "auto": {
      "enabled": true,
      "stableDelayHours": 6,
      "stableJitterHours": 12,
      "betaCheckIntervalHours": 1
    }
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

  # Ensure gateway block exists even if later config mutations accidentally drop it.
  # Without this, openclaw-gateway-start.sh will wait forever on "config invalid" and port 18789 never listens.
  python3 - <<'PY'
import json, os, shutil, time, secrets
p='/home/ubuntu/.openclaw/openclaw.json'
if not os.path.exists(p):
  raise SystemExit(0)
with open(p,'r',encoding='utf-8') as f:
  j=json.load(f)
if not isinstance(j, dict):
  raise SystemExit(0)

# Preserve existing token if present
existing_token = None
try:
  g=j.get('gateway') if isinstance(j.get('gateway'), dict) else None
  a=g.get('auth') if isinstance(g, dict) and isinstance(g.get('auth'), dict) else None
  if isinstance(a, dict) and isinstance(a.get('token'), str) and a.get('token'):
    existing_token=a.get('token')
except Exception:
  existing_token=None

g=j.get('gateway') if isinstance(j.get('gateway'), dict) else {}
if not isinstance(g, dict):
  g={}
g.setdefault('mode','local')
g.setdefault('bind','loopback')
g.setdefault('port',18789)
a=g.get('auth') if isinstance(g.get('auth'), dict) else {}
a.setdefault('mode','token')
a['token']= existing_token or secrets.token_hex(24)
g['auth']=a
j['gateway']=g

bak=p+f'.bak.bootstrap.gateway.{int(time.time())}'
try:
  shutil.copy2(p,bak)
except Exception:
  pass
with open(p,'w',encoding='utf-8') as f:
  json.dump(j,f,ensure_ascii=False,indent=2)
  f.write('\n')
PY
  chown ubuntu:ubuntu /home/ubuntu/.openclaw/openclaw.json 2>/dev/null || true
  chmod 600 /home/ubuntu/.openclaw/openclaw.json 2>/dev/null || true

  # Enforce OpenClaw auto-update config (idempotent)
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw config set update.channel stable >/dev/null 2>&1 || true
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw config set update.checkOnStart false >/dev/null 2>&1 || true
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw config set update.auto.enabled true >/dev/null 2>&1 || true
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw config set update.auto.stableDelayHours 6 >/dev/null 2>&1 || true
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw config set update.auto.stableJitterHours 12 >/dev/null 2>&1 || true
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw config set update.auto.betaCheckIntervalHours 1 >/dev/null 2>&1 || true

  # WhatsApp auth store must be writable by ubuntu.
  # If any step previously ran OpenClaw as root, credentials may become root-owned and break linking (QR scan spins).
  mkdir -p /home/ubuntu/.openclaw/credentials/whatsapp/default 2>/dev/null || true
  chown -R ubuntu:ubuntu /home/ubuntu/.openclaw/credentials/whatsapp 2>/dev/null || true
  chmod -R u+rwX,go-rwx /home/ubuntu/.openclaw/credentials/whatsapp 2>/dev/null || true

  # Install + enable BOTHook WA loopback + sendguard plugins (B-mode)
  # Clean stale plugin references first; otherwise openclaw CLI may refuse to run due to invalid config.
  python3 - <<'PY'
import json, os, shutil, time
p='/home/ubuntu/.openclaw/openclaw.json'
if os.path.exists(p):
  with open(p,'r',encoding='utf-8') as f:
    j=json.load(f)
  pl=j.get('plugins') or {}
  ents=pl.get('entries') or {}
  for k in ('bothook-wa-loopback','bothook-wa-sendguard','bothook-wa-autoreply'):
    ents.pop(k, None)
  pl['entries']=ents
  allow=pl.get('allow')
  if not isinstance(allow,list):
    allow=[]
  pl['allow']=[x for x in allow if x not in ('bothook-wa-loopback','bothook-wa-sendguard','bothook-wa-autoreply')]
  j['plugins']=pl
  bak=p+f'.bak.bootstrap.plugins.{int(time.time())}'
  shutil.copy2(p,bak)
  with open(p,'w',encoding='utf-8') as f:
    json.dump(j,f,ensure_ascii=False,indent=2)
    f.write('\n')
  print('bothook plugin refs cleaned:', bak)
PY

  # Remove existing extension dirs so install is deterministic
  rm -rf /home/ubuntu/.openclaw/extensions/bothook-wa-loopback /home/ubuntu/.openclaw/extensions/bothook-wa-sendguard /home/ubuntu/.openclaw/extensions/bothook-wa-autoreply 2>/dev/null || true

  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins install "$INSTALL_DIR/plugins/bothook-wa-loopback" >/dev/null 2>&1 || true
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins enable bothook-wa-loopback >/dev/null 2>&1 || true

  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins install "$INSTALL_DIR/plugins/bothook-wa-sendguard" >/dev/null 2>&1 || true
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins enable bothook-wa-sendguard >/dev/null 2>&1 || true

  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins install "$INSTALL_DIR/plugins/bothook-wa-autoreply" >/dev/null 2>&1 || true
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins enable bothook-wa-autoreply >/dev/null 2>&1 || true

  # Hard-validate BOTHook plugins installed (avoid leaving config invalid with allowlist pointing to missing plugins).
  if [[ ! -f /home/ubuntu/.openclaw/extensions/bothook-wa-loopback/openclaw.plugin.json ]]; then
    log "FATAL: bothook-wa-loopback not installed into extensions"
    exit 31
  fi
  if [[ ! -f /home/ubuntu/.openclaw/extensions/bothook-wa-sendguard/openclaw.plugin.json ]]; then
    log "FATAL: bothook-wa-sendguard not installed into extensions"
    exit 32
  fi
  if [[ ! -f /home/ubuntu/.openclaw/extensions/bothook-wa-autoreply/openclaw.plugin.json ]]; then
    log "FATAL: bothook-wa-autoreply not installed into extensions"
    exit 33
  fi

  # Pin plugin trust allowlist (prevents "untracked local code" warnings)
  # NOTE: do this AFTER hard-validating plugins exist in extensions.
  python3 - <<'PY'
import json, os, shutil, time
p='/home/ubuntu/.openclaw/openclaw.json'
if os.path.exists(p):
  with open(p,'r',encoding='utf-8') as f:
    j=json.load(f)
  pl=j.get('plugins') or {}
  pl['allow']=['bothook-wa-loopback','bothook-wa-sendguard','bothook-wa-autoreply']
  j['plugins']=pl
  bak=p+f'.bak.bootstrap.allow.{int(time.time())}'
  shutil.copy2(p,bak)
  with open(p,'w',encoding='utf-8') as f:
    json.dump(j,f,ensure_ascii=False,indent=2)
    f.write('\n')
  print('bothook plugins allow pinned:', bak)
PY

  # Ensure autoreply plugin is enabled (suppress warnings + repeat welcome until paid)
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins enable bothook-wa-autoreply >/dev/null 2>&1 || true

  # Enable internal onboarding hook responder
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw config set hooks.internal.enabled true >/dev/null 2>&1 || true
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw config set hooks.internal.entries.bothook-onboarding.enabled true >/dev/null 2>&1 || true

  # Enable + start gateway to persist across reboot/idle.
  systemctl enable --now openclaw-gateway.service || true

  # If the service was already running and waiting, restart to pick up the new config.
  systemctl restart openclaw-gateway.service || true

  # Ensure local login authority (pool stage). If control-plane takeover marker exists, remove it.
  rm -f /opt/bothook/LOGIN_AUTHORITY.control-plane 2>/dev/null || true

  # Install provisioning deps + enable service
  # NOTE: install as ubuntu so node_modules is readable by ubuntu and does not require root to update.
  chown -R ubuntu:ubuntu "$INSTALL_DIR/provision"
  sudo -u ubuntu bash -lc "cd '$INSTALL_DIR/provision' && npm install --omit=dev" || true
  systemctl enable --now bothook-provision.service || true

  # Enable post-boot verification (runs automatically after reboot)
  systemctl enable bothook-postboot-verify.service || true

  # Optional: run a one-time reboot acceptance automatically on first bootstrap.
  # This avoids manual reboot testing and proves the machine survives reboot.
  if [[ ! -f "$INSTALL_DIR/evidence/postboot_verify.done" ]]; then
    mkdir -p "$INSTALL_DIR/evidence"
    # Reboot now; systemd will run bothook-postboot-verify.service on next boot.
    log "Triggering one-time reboot for P0.2 acceptance"
    reboot
  fi

  log "Bootstrap done. Gateway + Provision services enabled+started."
}

main "$@"
