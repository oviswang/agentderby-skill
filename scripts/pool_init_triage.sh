#!/usr/bin/env bash
set -euo pipefail

DB="${BOTHOOK_DB_PATH:-/home/ubuntu/.openclaw/workspace/control-plane/data/bothook.sqlite}"
IID="${1:-}"
if [[ -z "${IID}" ]]; then
  echo "usage: $0 <instance_id>" >&2
  exit 2
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 not found" >&2
  exit 2
fi

echo "== instance =="
sqlite3 -cmd ".mode line" "$DB" \
  "SELECT instance_id, public_ip, lifecycle_status, health_status, health_reason, health_source, last_probe_at, last_ok_at, assigned_user_id, assigned_at, expired_at
     FROM instances
    WHERE instance_id='$IID';"

echo

echo "== latest pool_init_jobs for instance =="
sqlite3 -cmd ".mode line" "$DB" \
  "SELECT job_id, mode, status, created_at, started_at, ended_at
     FROM pool_init_jobs
    WHERE instance_id='$IID'
    ORDER BY datetime(created_at) DESC
    LIMIT 5;"

echo

echo "== latest init job logs (tail) =="
python3 - "$DB" "$IID" <<'PY2'
import json, sqlite3, sys

db_path = sys.argv[1]
iid = sys.argv[2]
con = sqlite3.connect(db_path)
cur = con.cursor()
row = cur.execute(
    "SELECT job_id, status, created_at, started_at, ended_at, log_json FROM pool_init_jobs WHERE instance_id=? ORDER BY datetime(created_at) DESC LIMIT 1",
    (iid,),
).fetchone()
if not row:
    print("(no jobs)")
    raise SystemExit(0)
job_id, status, created_at, started_at, ended_at, log_json = row
print(f"job_id={job_id}")
print(f"status={status}")
print(f"created_at={created_at}")
print(f"started_at={started_at}")
print(f"ended_at={ended_at}")
try:
    logs = json.loads(log_json or '[]')
except Exception:
    logs = []
print("--- log tail (last 30) ---")
if isinstance(logs, list):
    for line in logs[-30:]:
        print(line)
PY2

echo

echo "== recent events mentioning instance_id =="
sqlite3 -cmd ".mode line" "$DB" \
  "SELECT ts, event_type, entity_type, entity_id, substr(payload_json,1,240) AS payload_head
     FROM events
    WHERE entity_id='$IID'
       OR payload_json LIKE '%\"instance_id\":\"$IID\"%'
    ORDER BY ts DESC
    LIMIT 30;"
