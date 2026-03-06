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
