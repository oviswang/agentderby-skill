#!/usr/bin/env bash
set -euo pipefail

KEY=/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519
KNOWN=/tmp/bothook_pool_known_hosts
URL_BASE=https://p.bothook.me/artifacts/latest

PROMPTS=(ar de en es fr hi id ja ko pt-br ru th tr vi zh zh-tw)

ssh_run(){
  local ip="$1"; shift
  ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$KNOWN" -o GlobalKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ConnectTimeout=8 "ubuntu@${ip}" "$@"
}

sync_one(){
  local ip="$1"
  local region="$2"
  echo "== sync $ip (region=$region)"

  ssh_run "$ip" "sudo mkdir -p /opt/bothook/prompts/whatsapp_prompts /opt/bothook/evidence /opt/bothook; sudo chown ubuntu:ubuntu /opt/bothook/evidence || true; sudo chmod 775 /opt/bothook/evidence || true"

  # plugin
  ssh_run "$ip" "sudo curl -fsS ${URL_BASE}/plugins/bothook-wa-autoreply/index.ts -o /home/ubuntu/.openclaw/extensions/bothook-wa-autoreply/index.ts && sudo chown -R ubuntu:ubuntu /home/ubuntu/.openclaw/extensions/bothook-wa-autoreply"

  # local prompts (offline fallback)
  for lang in "${PROMPTS[@]}"; do
    ssh_run "$ip" "sudo curl -fsS ${URL_BASE}/prompts/whatsapp_prompts/${lang}.json -o /opt/bothook/prompts/whatsapp_prompts/${lang}.json"
  done
  ssh_run "$ip" "sudo chmod -R a+rX /opt/bothook/prompts/whatsapp_prompts"

  # instance info for offline template vars
  ssh_run "$ip" "printf '%s\n' '{\"region\":\"${region}\",\"public_ip\":\"${ip}\"}' | sudo tee /opt/bothook/INSTANCE.json >/dev/null; sudo chmod 644 /opt/bothook/INSTANCE.json"

  # restart gateway to load new plugin
  ssh_run "$ip" "sudo systemctl restart openclaw-gateway.service"

  # quick check
  ssh_run "$ip" "sleep 3; echo '-- plugin'; sudo -u ubuntu /home/ubuntu/.npm-global/bin/openclaw plugins list 2>/dev/null | egrep 'bothook-wa-autoreply' -n | head -n 2 || true; echo '-- marker'; ls -l /opt/bothook/evidence/autoreply_loaded /opt/bothook/evidence/paid 2>/dev/null || true; echo '-- prompts'; ls -1 /opt/bothook/prompts/whatsapp_prompts/en.json 2>/dev/null || true"
}

sync_one 43.156.101.233 ap-singapore
sync_one 43.134.108.19 ap-singapore
sync_one 43.160.215.85 ap-singapore
