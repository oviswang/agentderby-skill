#!/usr/bin/env bash
set -euo pipefail

# Start OpenClaw gateway in a robust way.
# - Runs as a systemd service (system-level)
# - Waits for the OpenClaw config to exist
# - Avoids hard-coding the openclaw binary path

PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
USER_HOME="${OPENCLAW_HOME:-/home/ubuntu}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$USER_HOME/.openclaw/openclaw.json}"

log(){ echo "[openclaw-gateway] $*"; }

find_openclaw(){
  if command -v openclaw >/dev/null 2>&1; then
    command -v openclaw
    return 0
  fi
  for p in /usr/local/bin/openclaw /usr/bin/openclaw /home/ubuntu/.npm-global/bin/openclaw; do
    if [[ -x "$p" ]]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

wait_for_config(){
  local i=0
  until [[ -f "$CONFIG_PATH" ]]; do
    i=$((i+1))
    if (( i % 30 == 0 )); then
      log "Waiting for config: $CONFIG_PATH"
    fi
    sleep 2
  done
}

config_valid(){
  "$1" config get gateway.port >/dev/null 2>&1
}

main(){
  log "Starting (port=$PORT, config=$CONFIG_PATH)"

  local bin
  bin="$(find_openclaw)" || {
    log "openclaw binary not found in PATH/common locations"
    exit 1
  }

  export HOME="$USER_HOME"
  export OPENCLAW_STATE_DIR="$USER_HOME/.openclaw"

  while true; do
    wait_for_config
    if ! config_valid "$bin"; then
      log "Config exists but is invalid. Waiting (no crash loop). Run: openclaw doctor --fix"
      sleep 10
      continue
    fi
    exec "$bin" gateway --port "$PORT" --force --allow-unconfigured
  done
}

main "$@"
