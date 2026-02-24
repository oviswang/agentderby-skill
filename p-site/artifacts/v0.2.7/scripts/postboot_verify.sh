#!/usr/bin/env bash
set -euo pipefail

# BOTHook post-boot verification (P0.2 reboot acceptance)
# Runs after a reboot to ensure services come back automatically.
# Writes evidence to /opt/bothook/evidence/postboot_verify.json

EVID_DIR="/opt/bothook/evidence"
OUT="$EVID_DIR/postboot_verify.json"
mkdir -p "$EVID_DIR"

now(){ date -u +%Y-%m-%dT%H:%M:%SZ; }

ok=true
errs=()

svc_active(){ systemctl is-active --quiet "$1"; }
port_listen(){ ss -ltn 2>/dev/null | grep -q ":$1"; }

# Check services
if ! svc_active openclaw-gateway.service; then ok=false; errs+=("openclaw-gateway.service not active"); fi
if ! svc_active bothook-provision.service; then ok=false; errs+=("bothook-provision.service not active"); fi

# Check ports
if ! port_listen 18789; then ok=false; errs+=("port 18789 not listening"); fi

# Provision healthz
prov_ok=false
if curl -fsS --max-time 2 http://127.0.0.1:18999/healthz >/dev/null 2>&1; then
  prov_ok=true
else
  ok=false; errs+=("provision /healthz not ready");
fi

cat > "$OUT" <<JSON
{
  "ok": ${ok},
  "ts": "$(now)",
  "checks": {
    "openclaw_gateway_active": $(svc_active openclaw-gateway.service && echo true || echo false),
    "bothook_provision_active": $(svc_active bothook-provision.service && echo true || echo false),
    "port_18789_listening": $(port_listen 18789 && echo true || echo false),
    "provision_healthz_ok": ${prov_ok}
  },
  "errors": $(python3 - <<'PY'
import json,sys
errs=sys.argv[1:]
print(json.dumps(errs,ensure_ascii=False))
PY "${errs[@]-}")
}
JSON

# Mark completion (even if failed) so operators can see it ran.
touch "$EVID_DIR/postboot_verify.done"

# READY report (push) to control-plane (best-effort)
# Requires /opt/bothook/READY_REPORT.txt written by control-plane.
READY_FILE="/opt/bothook/READY_REPORT.txt"
if $ok && [[ -f "$READY_FILE" ]]; then
  inst_id="$(grep -E '^instance_id=' "$READY_FILE" | head -n1 | cut -d= -f2- | tr -d '\r')"
  token="$(grep -E '^ready_report_token=' "$READY_FILE" | head -n1 | cut -d= -f2- | tr -d '\r')"
  # capture IPs locally
  pub_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  priv_ip="$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2}' | head -n1 | cut -d/ -f1 || true)"
  if [[ -n "$inst_id" && -n "$token" ]]; then
    curl -fsS --max-time 5 -H 'content-type: application/json' \
      -d "{\"instance_id\":\"${inst_id}\",\"token\":\"${token}\",\"public_ip\":\"${pub_ip}\",\"private_ip\":\"${priv_ip}\",\"checks\":$(cat "$OUT" | python3 -c 'import json,sys; j=json.load(sys.stdin); import json as J; print(J.dumps(j.get("checks")))') }" \
      "https://p.bothook.me/api/pool/ready" >/dev/null 2>&1 || true
  fi
fi

if $ok; then
  exit 0
fi
exit 2
