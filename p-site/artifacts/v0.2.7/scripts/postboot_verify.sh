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

checks_json=$(python3 - <<'PY'
import json,sys
import os
j={
  'openclaw_gateway_active': os.environ.get('CHK_GATEWAY')=='1',
  'bothook_provision_active': os.environ.get('CHK_PROVISION')=='1',
  'port_18789_listening': os.environ.get('CHK_PORT18789')=='1',
  'provision_healthz_ok': os.environ.get('CHK_PROV_HEALTHZ')=='1'
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
      -d "{\"instance_id\":\"${inst_id}\",\"token\":\"${token}\",\"checks\":$(cat "$OUT" | python3 -c 'import json,sys; j=json.load(sys.stdin); import json as J; print(J.dumps(j.get("checks")))') }" \
      "https://p.bothook.me/api/pool/ready" >/dev/null 2>&1 || true
  fi
fi

if $ok; then
  exit 0
fi
exit 2
