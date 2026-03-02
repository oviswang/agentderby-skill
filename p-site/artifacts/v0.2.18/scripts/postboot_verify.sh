#!/usr/bin/env bash
set -euo pipefail

# BOTHook post-boot verification (P0.2 reboot acceptance)
# Runs after a reboot to ensure services come back automatically.
# Writes evidence to /opt/bothook/evidence/postboot_verify.json

EVID_DIR="/opt/bothook/evidence"

# Write stable server specs for control-plane welcome rendering
SPECS_PATH="/opt/bothook/SPECS.json"
CPU="$(nproc 2>/dev/null || echo '?')"
RAM_GB="$(free -m 2>/dev/null | awk '/Mem:/{printf "%.0f", $2/1024}' || echo '?')"
DISK_GB="$(df -BG / 2>/dev/null | awk 'NR==2{gsub(/G/,"",$2); print $2}' || echo '?')"
TS_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p /opt/bothook
cat > "$SPECS_PATH" <<JSON
{
  "cpu": ${CPU:-0},
  "ram_gb": ${RAM_GB:-0},
  "disk_gb": ${DISK_GB:-0},
  "captured_at": "$TS_ISO"
}
JSON
chmod 644 "$SPECS_PATH" || true

OUT="$EVID_DIR/postboot_verify.json"
mkdir -p "$EVID_DIR"

now(){ date -u +%Y-%m-%dT%H:%M:%SZ; }

ok=true
errs=()

svc_active(){ systemctl is-active --quiet "$1"; }
port_listen(){ ss -ltn 2>/dev/null | grep -q ":$1"; }

# Config sanity gate (prevents gateway from getting stuck in "Config invalid. Waiting...")
# Common cause: user/agent writes openclaw.json containing ${VAR} which triggers env substitution.
fix_config_if_needed(){
  local p="/home/ubuntu/.openclaw/openclaw.json"
  # Ensure readable by ubuntu
  chown ubuntu:ubuntu "$p" 2>/dev/null || true
  chmod 600 "$p" 2>/dev/null || true

  if grep -Eq '\$\{[A-Za-z_][A-Za-z0-9_]*\}' "$p" 2>/dev/null; then
    errs+=("openclaw.json contains env-style \${VAR} placeholders; auto-rollback")
    local bak
    bak=$(ls -t /home/ubuntu/.openclaw/openclaw.json.bak.* 2>/dev/null | head -n1 || true)
    if [[ -n "$bak" ]]; then
      cp -a "$bak" "$p" 2>/dev/null || true
      chown ubuntu:ubuntu "$p" 2>/dev/null || true
      chmod 600 "$p" 2>/dev/null || true
    fi
  fi

  # Apply doctor fixes (best-effort) to keep schema-valid config.
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw doctor --fix >/dev/null 2>&1 || true
}

# NEW: ensure agent baseline does not crash due to missing auth store.
# - Force default model to OpenAI
# - Ensure auth-profiles.json exists (empty key placeholder)
ensure_agent_baseline(){
  local OPENCLAW_BIN="/home/ubuntu/.npm-global/bin/openclaw"
  local AGENT_DIR="/home/ubuntu/.openclaw/agents/main/agent"
  local AUTH_PROFILES="$AGENT_DIR/auth-profiles.json"

  install -d -m 700 -o ubuntu -g ubuntu "$AGENT_DIR" 2>/dev/null || true

  # Force default model to OpenAI (user will provide key later)
  sudo -u ubuntu "$OPENCLAW_BIN" models set openai/gpt-5.2 >/dev/null 2>&1 || true

  if [[ ! -f "$AUTH_PROFILES" ]]; then
    cat > /tmp/auth-profiles.json <<'JSON'
{
  "version": 1,
  "profiles": {
    "openai:manual": {
      "type": "api_key",
      "provider": "openai",
      "key": ""
    }
  },
  "order": {
    "openai": ["openai:manual"]
  }
}
JSON
    install -o ubuntu -g ubuntu -m 600 /tmp/auth-profiles.json "$AUTH_PROFILES" 2>/dev/null || true
    rm -f /tmp/auth-profiles.json
  fi
}

# If OpenAI key is missing, send a short guide instead of letting the agent emit provider errors.
# Idempotent: send at most once per boot.
send_openai_key_guide_if_missing(){
  local AGENT_DIR="/home/ubuntu/.openclaw/agents/main/agent"
  local AUTH_PROFILES="$AGENT_DIR/auth-profiles.json"
  local MARKER="/opt/bothook/evidence/openai_key_guide_sent"

  [[ -f "$MARKER" ]] && return 0
  [[ -f "$AUTH_PROFILES" ]] || return 0

  local key
  key=$(python3 - <<'PY'
import json
p='/home/ubuntu/.openclaw/agents/main/agent/auth-profiles.json'
try:
  j=json.load(open(p))
except Exception:
  j={}
prof=(j.get('profiles') or {}).get('openai:manual') or {}
print((prof.get('key') or '').strip())
PY
  )

  if [[ -n "$key" ]]; then
    return 0
  fi

  # If key missing, we should NOT crash. We also avoid spamming WhatsApp with provider errors.
  # NOTE: we do NOT attempt to proactively message the user here, because on a fresh machine we may not
  # yet know the user's self id/e164, and relying on provider status can itself fail.
  # Instead: (a) keep gateway up; (b) write a local marker and let the provisioning UX ask for the key.
  echo "openai_key_missing" > "$EVID_DIR/openai_key_missing" 2>/dev/null || true
  touch "$MARKER" 2>/dev/null || true

  # Optional hardening: restrict unsolicited DMs until key is configured (best-effort, do not fail the script).
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw config set channels.whatsapp.dmPolicy allowlist >/dev/null 2>&1 || true
  sudo systemctl restart openclaw-gateway.service >/dev/null 2>&1 || true
}

fix_config_if_needed
ensure_agent_baseline
send_openai_key_guide_if_missing

# Check services
if ! svc_active openclaw-gateway.service; then ok=false; errs+=("openclaw-gateway.service not active"); fi
if ! svc_active bothook-provision.service; then ok=false; errs+=("bothook-provision.service not active"); fi

# Critical UX gate: autoreply plugin must be enabled so users always get welcome/guide prompts.
# This is a HARD gate for pool readiness: if autoreply cannot be loaded, do NOT report READY.
autoreply_loaded=false
if sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins list 2>/dev/null | grep -q 'bothook-wa-autoreply' \
  && sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins list 2>/dev/null | grep -q 'bothook-wa-autoreply.*loaded'; then
  autoreply_loaded=true
else
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins enable bothook-wa-autoreply >/dev/null 2>&1 || true
  sudo systemctl restart openclaw-gateway.service >/dev/null 2>&1 || true
  # Retry a short window: gateway reload + plugin activation may take a few seconds.
  for _ in $(seq 1 10); do
    if sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins list 2>/dev/null | grep -q 'bothook-wa-autoreply.*loaded'; then
      autoreply_loaded=true
      break
    fi
    sleep 2
  done
fi
if [ "$autoreply_loaded" != true ]; then
  ok=false; errs+=("autoreply plugin not loaded");
fi

# Check ports (18789 can be briefly unavailable after reboot; retry a short window)
port18789_ok=false
for _ in $(seq 1 12); do
  if port_listen 18789; then port18789_ok=true; break; fi
  sleep 5
  done
if [ "$port18789_ok" != true ]; then ok=false; errs+=("port 18789 not listening"); fi

# Provision healthz
prov_ok=false
if curl -fsS --max-time 2 http://127.0.0.1:18999/healthz >/dev/null 2>&1; then
  prov_ok=true
else
  ok=false; errs+=("provision /healthz not ready");
fi

# Export checks for JSON build (avoid bash heredoc-in-substitution issues)
export CHK_GATEWAY=$(svc_active openclaw-gateway.service && echo 1 || echo 0)
export CHK_PROVISION=$(svc_active bothook-provision.service && echo 1 || echo 0)
export CHK_PORT18789=$([ "$port18789_ok" = true ] && echo 1 || echo 0)
export CHK_PROV_HEALTHZ=$([ "$prov_ok" = true ] && echo 1 || echo 0)

# Additional checks
export CHK_TMUX=$([ -x /usr/bin/tmux ] && echo 1 || echo 0)
export CHK_AUTH_PROFILES=$([ -f /home/ubuntu/.openclaw/agents/main/agent/auth-profiles.json ] && echo 1 || echo 0)
export CHK_AUTOREPLY_LOADED=$([ "$autoreply_loaded" = true ] && echo 1 || echo 0)

# Default model check + repair (best-effort)
MODEL_PRIMARY=$(sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw config get agents.defaults.model.primary 2>/dev/null || true)
MODEL_PRIMARY=$(echo "$MODEL_PRIMARY" | tr -d '\r' | tail -n 1)
if [[ "$MODEL_PRIMARY" != "openai/gpt-5.2" ]]; then
  # Drift can happen after upgrades/doctor; enforce user-facing default.
  sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw models set openai/gpt-5.2 >/dev/null 2>&1 || true
  MODEL_PRIMARY=$(sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw config get agents.defaults.model.primary 2>/dev/null || true)
  MODEL_PRIMARY=$(echo "$MODEL_PRIMARY" | tr -d '\r' | tail -n 1)
fi
export CHK_DEFAULT_MODEL_OK=$([ "$MODEL_PRIMARY" = "openai/gpt-5.2" ] && echo 1 || echo 0)

checks_json=$(python3 - <<'PY'
import json,os
j={
  'openclaw_gateway_active': os.environ.get('CHK_GATEWAY')=='1',
  'bothook_provision_active': os.environ.get('CHK_PROVISION')=='1',
  'port_18789_listening': os.environ.get('CHK_PORT18789')=='1',
  'provision_healthz_ok': os.environ.get('CHK_PROV_HEALTHZ')=='1',
  'tmux_installed': os.environ.get('CHK_TMUX')=='1',
  'auth_profiles_present': os.environ.get('CHK_AUTH_PROFILES')=='1',
  'autoreply_loaded': os.environ.get('CHK_AUTOREPLY_LOADED')=='1',
  'default_model_openai_gpt_5_2': os.environ.get('CHK_DEFAULT_MODEL_OK')=='1'
}
print(json.dumps(j,ensure_ascii=False))
PY
)

errors_json=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:],ensure_ascii=False))' "${errs[@]-}")

cat > "$OUT" <<JSON
{
  "ok": ${ok},
  "ts": "$(now)",
  "checks": ${checks_json},
  "errors": ${errors_json}
}
JSON

# Mark completion (even if failed) so operators can see it ran.
touch "$EVID_DIR/postboot_verify.done"

# READY report (push) to control-plane (best-effort)
READY_FILE="/opt/bothook/READY_REPORT.txt"
if $ok && [[ -f "$READY_FILE" ]]; then
  inst_id="$(grep -E '^instance_id=' "$READY_FILE" | head -n1 | cut -d= -f2- | tr -d '\r')"
  token="$(grep -E '^ready_report_token=' "$READY_FILE" | head -n1 | cut -d= -f2- | tr -d '\r')"
  if [[ -n "$inst_id" && -n "$token" ]]; then
    curl -fsS --max-time 5 -H 'content-type: application/json' \
      -d "{\"instance_id\":\"${inst_id}\",\"token\":\"${token}\",\"checks\":$(cat "$OUT" | python3 -c 'import json,sys; j=json.load(sys.stdin); import json as J; print(J.dumps(j.get("checks")))') }" \
      "https://p.bothook.me/api/pool/ready" >/dev/null 2>&1 || true
  fi
fi

if $ok; then
  exit 0
fi
exit 2
