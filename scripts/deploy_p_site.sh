#!/usr/bin/env bash
set -euo pipefail

SRC="/home/ubuntu/.openclaw/workspace/p-site/"
DST="/var/www/p-site/"

if [[ ! -d "$SRC" ]]; then
  echo "[deploy_p_site] FATAL: missing source dir: $SRC" >&2
  exit 2
fi

echo "[deploy_p_site] Syncing p-site -> /var/www/p-site (includes artifacts/)"
# Use sudo because /var/www is root-owned on most systems.
sudo rsync -a --delete "$SRC" "$DST"

echo "[deploy_p_site] Verifying artifacts/latest link + manifest version"
LATEST_LINK="$DST/artifacts/latest"
if [[ ! -L "$LATEST_LINK" ]]; then
  echo "[deploy_p_site] FATAL: expected symlink: $LATEST_LINK" >&2
  ls -lah "$DST/artifacts" >&2 || true
  exit 3
fi

LATEST_TARGET="$(readlink "$LATEST_LINK")"
MANIFEST="$DST/artifacts/latest/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  echo "[deploy_p_site] FATAL: missing manifest: $MANIFEST" >&2
  exit 4
fi

VER="$(jq -r '.version // empty' "$MANIFEST" 2>/dev/null || true)"
if [[ -z "$VER" ]]; then
  echo "[deploy_p_site] FATAL: manifest has no version: $MANIFEST" >&2
  exit 5
fi

# latest -> v0.2.25, manifest version -> 0.2.25
EXPECTED_DIR="v$VER"
if [[ "$LATEST_TARGET" != "$EXPECTED_DIR" ]]; then
  echo "[deploy_p_site] FATAL: artifacts/latest points to '$LATEST_TARGET' but manifest version is '$VER' (expected $EXPECTED_DIR)" >&2
  exit 6
fi

echo "[deploy_p_site] Verifying sha256sums contains manifest.json entry"
SHA_FILE="$DST/artifacts/latest/sha256sums.txt"
if [[ ! -f "$SHA_FILE" ]]; then
  echo "[deploy_p_site] FATAL: missing sha256sums.txt: $SHA_FILE" >&2
  exit 7
fi

if ! grep -Eq '^[0-9a-f]{64}\s+manifest\.json$' "$SHA_FILE"; then
  echo "[deploy_p_site] FATAL: sha256sums.txt missing manifest.json entry" >&2
  tail -n 5 "$SHA_FILE" >&2 || true
  exit 8
fi

echo "[deploy_p_site] OK: deployed artifacts/latest -> $LATEST_TARGET (manifest version=$VER)"
