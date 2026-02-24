#!/usr/bin/env bash
set -euo pipefail

# Deploy BOTHook systemd timers/services for control-plane workers.
# Intended to be run on the control-plane host.

ROOT="/home/ubuntu/.openclaw/workspace"

install_unit() {
  local name="$1"; shift
  local tmp="/tmp/${name}.$$.tmp"
  cat >"$tmp"
  sudo install -m 0644 "$tmp" "/etc/systemd/system/${name}"
  rm -f "$tmp"
}

PATH_LINE='Environment=PATH=/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
TG_LINE='Environment=TELEGRAM_ENV=/home/ubuntu/.openclaw/credentials/telegram.env'

install_unit bothook-stripe-reconcile.service <<UNIT
[Unit]
Description=BOTHook Stripe Reconcile Worker (backfill subscription timestamps)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=ubuntu
Group=ubuntu
WorkingDirectory=${ROOT}/control-plane
Environment=BOTHOOK_DB_PATH=${ROOT}/control-plane/data/bothook.sqlite
EnvironmentFile=/home/ubuntu/.openclaw/credentials/stripe.env
${PATH_LINE}
${TG_LINE}
ExecStart=/usr/bin/flock -n /tmp/bothook-stripe-reconcile.lock /usr/bin/node ${ROOT}/control-plane/workers/stripe_reconcile.mjs
UNIT

install_unit bothook-stripe-reconcile.timer <<UNIT
[Unit]
Description=Run BOTHook Stripe Reconcile Worker every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
RandomizedDelaySec=30
Unit=bothook-stripe-reconcile.service

[Install]
WantedBy=timers.target
UNIT

install_unit bothook-subscription-reclaim.service <<UNIT
[Unit]
Description=BOTHook Subscription Reclaim Worker (reimage/terminate expired instances)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=ubuntu
Group=ubuntu
WorkingDirectory=${ROOT}/control-plane
Environment=BOTHOOK_DB_PATH=${ROOT}/control-plane/data/bothook.sqlite
Environment=BOTHOOK_API_BASE=http://127.0.0.1:18998
Environment=BOTHOOK_CLOUD_REGION=ap-singapore
Environment=BOTHOOK_REIMAGE_BLUEPRINT_ID=lhbp-1l4ptuvm
Environment=BOTHOOK_POOL_TARGET_READY=5
EnvironmentFile=/home/ubuntu/.openclaw/credentials/stripe.env
${PATH_LINE}
${TG_LINE}
ExecStart=/usr/bin/flock -n /tmp/bothook-subscription-reclaim.lock /usr/bin/node ${ROOT}/control-plane/workers/subscription_reclaim.mjs
UNIT

install_unit bothook-subscription-reclaim.timer <<UNIT
[Unit]
Description=Run BOTHook Subscription Reclaim Worker every 5 minutes

[Timer]
OnBootSec=4min
OnUnitActiveSec=5min
RandomizedDelaySec=30
Unit=bothook-subscription-reclaim.service

[Install]
WantedBy=timers.target
UNIT

install_unit bothook-cloud-reconcile.service <<UNIT
[Unit]
Description=BOTHook Cloud Reconcile Worker (DescribeInstances + keypair drift fix)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=ubuntu
Group=ubuntu
WorkingDirectory=${ROOT}/control-plane
Environment=BOTHOOK_DB_PATH=${ROOT}/control-plane/data/bothook.sqlite
Environment=BOTHOOK_CLOUD_REGION=ap-singapore
Environment=BOTHOOK_POOL_KEY_ID=lhkp-q1oc3vdz
${PATH_LINE}
${TG_LINE}
ExecStart=/usr/bin/flock -n /tmp/bothook-cloud-reconcile.lock /usr/bin/node ${ROOT}/control-plane/workers/cloud_reconcile.mjs
UNIT

install_unit bothook-cloud-reconcile.timer <<UNIT
[Unit]
Description=Run BOTHook Cloud Reconcile Worker every 10 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
RandomizedDelaySec=30
Unit=bothook-cloud-reconcile.service

[Install]
WantedBy=timers.target
UNIT

install_unit bothook-pool-replenish.service <<UNIT
[Unit]
Description=BOTHook Pool Replenisher (maintain IN_POOL READY target)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=ubuntu
Group=ubuntu
WorkingDirectory=${ROOT}/control-plane
Environment=BOTHOOK_DB_PATH=${ROOT}/control-plane/data/bothook.sqlite
Environment=BOTHOOK_API_BASE=http://127.0.0.1:18998
Environment=BOTHOOK_CLOUD_REGION=ap-singapore
Environment=BOTHOOK_POOL_KEY_ID=lhkp-q1oc3vdz
Environment=BOTHOOK_REIMAGE_BLUEPRINT_ID=lhbp-1l4ptuvm
Environment=BOTHOOK_POOL_ZONES=ap-singapore-1,ap-singapore-3
Environment=BOTHOOK_POOL_TARGET_READY=5
Environment=BOTHOOK_POOL_CAP_TOTAL=20
Environment=BOTHOOK_POOL_WARN_TOTAL=18
Environment=BOTHOOK_POOL_MIN_CPU=2
Environment=BOTHOOK_POOL_MIN_MEM_GB=2
${PATH_LINE}
${TG_LINE}
ExecStart=/usr/bin/flock -n /tmp/bothook-pool-replenish.lock /usr/bin/node ${ROOT}/control-plane/workers/pool_replenish.mjs
UNIT

install_unit bothook-pool-replenish.timer <<UNIT
[Unit]
Description=Run BOTHook Pool Replenisher every 1 minute

[Timer]
OnBootSec=90s
OnUnitActiveSec=1min
RandomizedDelaySec=10
Unit=bothook-pool-replenish.service

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now \
  bothook-stripe-reconcile.timer \
  bothook-subscription-reclaim.timer \
  bothook-cloud-reconcile.timer \
  bothook-pool-replenish.timer

echo "[ok] deployed bothook timers"
