#!/usr/bin/env bash
set -euo pipefail

# Fix OpenClaw credential permissions safely.
# Goal: prevent "EACCES" that breaks WhatsApp auto-replies while keeping credentials non-world-readable.
# Policy:
# - Ownership: ubuntu:ubuntu
# - Directories: 700
# - Files: 600

ROOT="/home/ubuntu/.openclaw/credentials"

now(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
log(){ echo "[fix_openclaw_credentials_perms][$(now)] $*"; }

if [[ ! -d "$ROOT" ]]; then
  log "skip: missing $ROOT"
  exit 0
fi

log "fixing $ROOT"
chown -R ubuntu:ubuntu "$ROOT" || true
chmod 700 "$ROOT" || true
find "$ROOT" -type d -exec chmod 700 {} \; 2>/dev/null || true
find "$ROOT" -type f -exec chmod 600 {} \; 2>/dev/null || true

# quick sanity
owner=$(stat -c %U:%G "$ROOT" 2>/dev/null || echo unknown)
mode=$(stat -c %a "$ROOT" 2>/dev/null || echo unknown)
log "done owner=$owner mode=$mode"
