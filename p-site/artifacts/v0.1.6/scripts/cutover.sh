#!/usr/bin/env bash
set -euo pipefail

# BOTHook P0.3 two-phase cutover (no black hole)
# Phase A (hard gate): verify OpenAI key + WhatsApp send-test ACK (delivery success)
# Phase B: stop provisioning responder (rollback on failure)
#
# Requirements:
# - run as root (needs systemctl), but will execute openclaw checks as ubuntu
# - OPENAI_API_KEY provided via env or --key-file
# - SELF_E164 provided via env or --self (E.164, e.g. +6598xxxxxxx)

usage() {
  cat <<'EOF'
Usage:
  sudo ./cutover.sh --self +6598xxxxxxx [--key-file /path/to/key] [--provision-service bothook-provision.service]

Env:
  OPENAI_API_KEY     OpenAI key (if not using --key-file)
  SELF_E164          Self WhatsApp E.164 target (if not using --self)

What it does:
  1) Verify OpenAI key (GET /v1/models)
  2) Strong-check WhatsApp gateway: openclaw gateway status
  3) Phase A hard gate: send a test message to SELF_E164 and require send success
  4) Phase B: stop provisioning service
  5) Re-check gateway status
  6) On any failure after stopping provision: rollback (start provision service)
EOF
}

log() { echo "[cutover] $*"; }

require_root() {
  if [[ "$(id -u)" != "0" ]]; then
    echo "ERROR: must run as root (use sudo)" >&2
    exit 2
  fi
}

KEY_FILE=""
PROVISION_SERVICE="bothook-provision.service"
SELF=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key-file) KEY_FILE="$2"; shift 2;;
    --provision-service) PROVISION_SERVICE="$2"; shift 2;;
    --self) SELF="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

require_root

if [[ -z "$SELF" ]]; then SELF="${SELF_E164:-}"; fi
if [[ -z "$SELF" ]]; then
  echo "ERROR: missing --self / SELF_E164" >&2
  exit 2
fi

OPENAI_KEY="${OPENAI_API_KEY:-}"
if [[ -z "$OPENAI_KEY" && -n "$KEY_FILE" ]]; then
  OPENAI_KEY="$(cat "$KEY_FILE" | tr -d '\r\n')"
fi
if [[ -z "$OPENAI_KEY" ]]; then
  echo "ERROR: missing OPENAI_API_KEY or --key-file" >&2
  exit 2
fi

# ---------- Phase 0: verify key ----------
log "Verifying OpenAI API key..."
if ! curl -fsS --max-time 10 \
  -H "Authorization: Bearer ${OPENAI_KEY}" \
  https://api.openai.com/v1/models >/dev/null; then
  echo "ERROR: OpenAI key verification failed" >&2
  exit 10
fi
log "OpenAI key OK"

# ---------- helpers (run as ubuntu) ----------
as_ubuntu() {
  sudo -u ubuntu -H bash -lc "$*"
}

strong_gateway_check() {
  log "Checking gateway status (ubuntu)..."
  as_ubuntu "openclaw gateway status" >/dev/null
}

send_test_message() {
  local msg
  msg="BOTHook P0.3 send-test $(date -Is)"
  log "Phase A send-test to ${SELF} ..."
  # Hard gate: require the send call to succeed quickly.
  as_ubuntu "openclaw message send --channel whatsapp --target '${SELF}' --message '${msg}' --json" >/dev/null
  log "send-test OK"
}

# ---------- Phase A: WhatsApp OK (hard gate) ----------
strong_gateway_check
send_test_message

# ---------- Phase B: stop provisioning responder ----------
log "Stopping provision service: ${PROVISION_SERVICE}"
if systemctl is-enabled --quiet "${PROVISION_SERVICE}"; then
  systemctl stop "${PROVISION_SERVICE}"
else
  log "WARN: ${PROVISION_SERVICE} not enabled; attempting stop anyway"
  systemctl stop "${PROVISION_SERVICE}" || true
fi

rollback() {
  log "ROLLBACK: starting provision service: ${PROVISION_SERVICE}"
  systemctl start "${PROVISION_SERVICE}" || true
}

# If any subsequent step fails, rollback.
set +e
strong_gateway_check
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
  echo "ERROR: gateway check failed after stopping provision; rolling back" >&2
  rollback
  exit 30
fi

log "Cutover complete: key verified + whatsapp send-test ok + provision stopped"
