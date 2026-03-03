#!/usr/bin/env bash
set -euo pipefail

KEY=/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519
KNOWN=/tmp/bothook_pool_known_hosts
URL_BASE=https://p.bothook.me/artifacts/latest

ssh_run(){
  local ip="$1"; shift
  ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$KNOWN" -o GlobalKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ConnectTimeout=8 "ubuntu@${ip}" "$@"
}

sync_one(){
  local ip="$1"
  echo "== sync cutover bin on $ip"
  ssh_run "$ip" "sudo curl -fsS ${URL_BASE}/scripts/cutover_delivered.sh -o /opt/bothook/bin/cutover_delivered.sh && sudo chmod +x /opt/bothook/bin/cutover_delivered.sh && sudo sha256sum /opt/bothook/bin/cutover_delivered.sh | head -n 1"
}

sync_one 43.156.101.233
sync_one 43.134.108.19
sync_one 43.160.215.85
