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

export OPENCLAW_JSON MEM_DB
python3 - <<'PY'
import json, os
p = os.environ.get('OPENCLAW_JSON')
db = os.environ.get('MEM_DB')
if not p or not db:
  raise SystemExit(0)
with open(p,'r',encoding='utf-8') as f:
  cfg = json.load(f)
agents = cfg.setdefault('agents', {})
defs = agents.setdefault('defaults', {})
defs['memorySearch'] = {
  'enabled': True,
  'sources': ['memory'],
  'provider': 'openai',
  'model': 'text-embedding-3-small',
  'store': { 'driver': 'sqlite', 'path': db },
  'chunking': { 'tokens': 800, 'overlap': 100 },
  'query': { 'maxResults': 8, 'minScore': 0.35 },
  'sync': { 'onSearch': True, 'watch': False }
}
with open(p,'w',encoding='utf-8') as f:
  json.dump(cfg, f, indent=2, ensure_ascii=False)
  f.write('\n')
PY

echo "[memorySearch] enabled (provider=openai, model=text-embedding-3-small, store=${MEM_DB})" >&2
