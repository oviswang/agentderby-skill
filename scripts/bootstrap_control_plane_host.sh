#!/usr/bin/env bash
set -euo pipefail

# BOTHook master host bootstrap hardening for reliability.
# Ensures control-plane API always points to the correct DB, is single-instanced,
# and never blocks HTTP responses on SSH/tmux operations.

CONTROL_PLANE_DIR="/home/ubuntu/.openclaw/workspace/control-plane"
DB_PATH="/home/ubuntu/.openclaw/workspace/control-plane/data/bothook.sqlite"
SERVICE_PATH="$HOME/.config/systemd/user/bothook-control-plane.service"

mkdir -p "$HOME/.config/systemd/user"

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=bothook control-plane API (p-site /api)
After=network.target

[Service]
Type=simple
WorkingDirectory=${CONTROL_PLANE_DIR}
Environment=BOTHOOK_DB_PATH=${DB_PATH}
Environment=BOTHOOK_REGION=ap-singapore
# Ensure we always use the intended pool SSH key
Environment=BOTHOOK_POOL_SSH_KEY=/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519
ExecStart=/usr/bin/node ${CONTROL_PLANE_DIR}/api-server.mjs
Restart=always
RestartSec=2

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now bothook-control-plane.service

# Enforce single instance: kill any stray api-server.mjs not managed by systemd.
# (Prevents port 18998 being hijacked by old foreground runs.)
if command -v pgrep >/dev/null 2>&1; then
  mapfile -t pids < <(pgrep -af "api-server\\.mjs" | awk '{print $1}' | tr -d '\r' | sort -u)
  for pid in "${pids[@]}"; do
    # Skip the main PID of the systemd service (best-effort)
    main=$(systemctl --user show -p MainPID --value bothook-control-plane.service 2>/dev/null || echo "")
    if [[ -n "$main" && "$pid" == "$main" ]]; then
      continue
    fi
    kill "$pid" 2>/dev/null || true
  done
fi

# Quick verification
curl -sS --max-time 3 http://127.0.0.1:18998/api/wa/status?uuid=test >/dev/null || true

echo "ok"
