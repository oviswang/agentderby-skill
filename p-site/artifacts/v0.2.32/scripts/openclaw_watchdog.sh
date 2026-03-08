#!/usr/bin/env bash
set -euo pipefail

# BOTHook watchdog: mitigate pathological high-CPU openclaw login loops on pool machines.
# Policy: best-effort only; never hard-fail the system.
# Intended to run via systemd timer.

LOG_DIR="/opt/bothook/evidence"
LOG_FILE="$LOG_DIR/openclaw_watchdog.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

now(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
log(){ echo "[$(now)] $*" >> "$LOG_FILE"; }

CPU_THRESHOLD=${WATCHDOG_OPENCLAW_CPU_THRESHOLD:-90}
# Number of consecutive breaches before action (timer interval should be 10s by default)
BREACH_N=${WATCHDOG_OPENCLAW_CPU_BREACH_N:-6}
STATE_FILE="/run/bothook_openclaw_watchdog.state"

# --- Availability guardrails (run every tick; best-effort) ---
# 1) Ensure gateway is listening on loopback (otherwise user messages can be silently dropped).
# Use a restart cooldown to avoid restart storms during slow startups.
GATEWAY_COOLDOWN_SEC=${WATCHDOG_GATEWAY_RESTART_COOLDOWN_SEC:-45}
GATEWAY_STATE_FILE="/run/bothook_gateway_restart.ts"

if command -v ss >/dev/null 2>&1; then
  if ! ss -lnt 2>/dev/null | grep -qE '127\.0\.0\.1:18789|\[::1\]:18789|:18789'; then
    now_s=$(date +%s)
    last_s=0
    if [[ -f "$GATEWAY_STATE_FILE" ]]; then
      last_s=$(cat "$GATEWAY_STATE_FILE" 2>/dev/null || echo 0)
    fi
    age=$(( now_s - last_s ))
    if (( age < GATEWAY_COOLDOWN_SEC )); then
      log "WARN gateway_not_listening: cooldown active (${age}s < ${GATEWAY_COOLDOWN_SEC}s), skip restart"
    else
      # Startup grace: don't restart during the first moments of service boot.
      # If we restart too early, we can create a self-inflicted restart loop where 18789 never comes up.
      grace_sec=${WATCHDOG_GATEWAY_STARTUP_GRACE_SEC:-90}
      svc_age_ok=1
      try_age() {
        local now_ms start_us age_ms
        now_ms=$(awk '{print int($1*1000)}' /proc/uptime 2>/dev/null || echo 0)
        start_us=$(systemctl show -p ExecMainStartTimestampMonotonic --value openclaw-gateway.service 2>/dev/null || echo 0)
        if [[ -z "$now_ms" || -z "$start_us" ]]; then return 1; fi
        if ! [[ "$now_ms" =~ ^[0-9]+$ && "$start_us" =~ ^[0-9]+$ ]]; then return 1; fi
        age_ms=$(( now_ms - (start_us/1000) ))
        if (( age_ms < grace_sec*1000 )); then
          svc_age_ok=0
        fi
        return 0
      }
      try_age || true

      if (( svc_age_ok == 0 )); then
        log "WARN gateway_not_listening: within startup grace (${grace_sec}s), skip restart"
      else
        echo "$now_s" > "$GATEWAY_STATE_FILE" 2>/dev/null || true
        log "WARN gateway_not_listening: restarting openclaw-gateway.service"
        systemctl restart openclaw-gateway.service 2>/dev/null || true
      fi
    fi
  fi
fi

# 2) Ensure provisioning server is healthy (QR generation depends on it).
if ! curl -fsS --max-time 2 http://127.0.0.1:18999/healthz >/dev/null 2>&1; then
  log "WARN provision_healthz_fail: restarting bothook-provision.service"
  systemctl restart bothook-provision.service 2>/dev/null || true
fi

# 3) Self-heal credential permissions (prevents WhatsApp send failures due to EACCES).
CRED_ROOT="/home/ubuntu/.openclaw/credentials"
if [[ -d "$CRED_ROOT" ]]; then
  owner=$(stat -c %U:%G "$CRED_ROOT" 2>/dev/null || echo unknown)
  if [[ "$owner" != "ubuntu:ubuntu" ]]; then
    log "WARN creds_owner_not_ubuntu ($owner): running fix_openclaw_credentials_perms"
    bash /opt/bothook/ops-scripts/fix_openclaw_credentials_perms.sh >/dev/null 2>&1 || true
  fi
fi

# Return highest %cpu among openclaw processes (integer)
max_cpu(){
  ps -eo comm,pcpu --sort=-pcpu \
    | awk '$1=="openclaw"{gsub(/\..*/,"",$2); print int($2); exit} END{ if (NR==0) print 0; }'
}

breaches=0
if [[ -f "$STATE_FILE" ]]; then
  breaches=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fi

cpu=$(max_cpu || echo 0)

if [[ "$cpu" =~ ^[0-9]+$ ]] && (( cpu >= CPU_THRESHOLD )); then
  breaches=$((breaches+1))
  echo "$breaches" > "$STATE_FILE" 2>/dev/null || true
  log "breach cpu=${cpu}% breaches=${breaches}/${BREACH_N}"
else
  # decay/reset
  if (( breaches != 0 )); then
    log "recover cpu=${cpu}% breaches=${breaches}->0"
  fi
  breaches=0
  echo 0 > "$STATE_FILE" 2>/dev/null || true
fi

if (( breaches < BREACH_N )); then
  exit 0
fi

# Action: kill login tmux sessions and restart provision.
# This targets pool-machine behavior; delivered machines may not use provisioning server.
log "ACTION cpu=${cpu}%: killing tmux wa-* sessions + restarting bothook-provision"

# Best-effort: kill tmux sessions matching wa-*
if command -v tmux >/dev/null 2>&1; then
  tmux ls 2>/dev/null | awk -F: '{print $1}' | grep -E '^wa-[A-Za-z0-9-]+' | while read -r s; do
    tmux kill-session -t "$s" 2>/dev/null || true
  done
fi

# Kill openclaw processes (best-effort)
pkill -x openclaw 2>/dev/null || true

# Restart provision to restore clean state
systemctl restart bothook-provision.service 2>/dev/null || true

# Reset breach counter after action
echo 0 > "$STATE_FILE" 2>/dev/null || true
log "ACTION done"
