#!/usr/bin/env bash
set -euo pipefail

# Enable OpenClaw embedding-based semantic memorySearch using OpenAI embeddings.
# - Does NOT change gateway/channels/models
# - Uses local sqlite store under ~/.openclaw/memory/
# - Safe if OPENAI_API_KEY not present yet (feature will become useful once key is set)

OPENCLAW_JSON="/home/ubuntu/.openclaw/openclaw.json"
MEM_DIR="/home/ubuntu/.openclaw/memory"
MEM_DB="${MEM_DIR}/memory.sqlite"

mkdir -p "${MEM_DIR}"

if [ ! -f "${OPENCLAW_JSON}" ]; then
  echo "[memorySearch] openclaw.json not found at ${OPENCLAW_JSON} (skip)" >&2
  exit 0
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "${OPENCLAW_JSON}" "${OPENCLAW_JSON}.bak.${TS}"

python3 - <<PY
import json
p = ${OPENCLAW_JSON!r}
with open(p,'r') as f:
  cfg = json.load(f)

agents = cfg.setdefault('agents', {})
defs = agents.setdefault('defaults', {})

ms = {
  'enabled': True,
  'sources': ['memory'],
  'provider': 'openai',
  'model': 'text-embedding-3-small',
  'store': { 'driver': 'sqlite', 'path': ${MEM_DB!r} },
  'chunking': { 'tokens': 800, 'overlap': 100 },
  'query': { 'maxResults': 8, 'minScore': 0.35 },
  'sync': { 'onSearch': True, 'watch': False }
}

defs['memorySearch'] = ms

with open(p,'w') as f:
  json.dump(cfg, f, indent=2, ensure_ascii=False)
  f.write('\n')
PY

echo "[memorySearch] enabled (provider=openai, model=text-embedding-3-small, store=${MEM_DB})" >&2
