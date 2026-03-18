#!/usr/bin/env bash
set -euo pipefail

cd /home/ubuntu/.openclaw/workspace

NOW_LOCAL=$(date '+%Y-%m-%d %H:00 %Z')
HOURS=${BOTHOOK_REPORT_HOURS:-1}
SINCE="${HOURS} hour ago"

# BOTHook SQLite authoritative path (hard rule)
BOTHOOK_DB_REAL="/home/ubuntu/.openclaw/workspace/control-plane/data/bothook.sqlite"
BOTHOOK_DB_LINK="/home/ubuntu/.openclaw/workspace/bothook.sqlite"
export BOTHOOK_DB_REAL

echo "【事实源 -DB：权威 bothook.sqlite 路径】"
echo "- authoritative: ${BOTHOOK_DB_REAL}"
if [ -e "${BOTHOOK_DB_LINK}" ]; then
  if [ -L "${BOTHOOK_DB_LINK}" ]; then
    tgt=$(readlink -f "${BOTHOOK_DB_LINK}" || true)
    echo "- workspace link: ${BOTHOOK_DB_LINK} -> ${tgt}"
    if [ "${tgt}" != "${BOTHOOK_DB_REAL}" ]; then
      echo "- WARNING: workspace bothook.sqlite symlink target mismatch (risk of misread)"
    fi
  else
    sz=$(stat -c%s "${BOTHOOK_DB_LINK}" 2>/dev/null || echo "?")
    echo "- WARNING: ${BOTHOOK_DB_LINK} is a regular file (size=${sz}). Risk of reading placeholder/decoy DB."
  fi
else
  echo "- NOTE: ${BOTHOOK_DB_LINK} not present (ok; scripts should use authoritative path only)"
fi

if [ ! -s "${BOTHOOK_DB_REAL}" ]; then
  echo "- ERROR: authoritative DB missing or empty: ${BOTHOOK_DB_REAL}"
fi

echo

echo "时间窗：过去 ${HOURS} 小时（截至 ${NOW_LOCAL}）"
echo

echo "【事实源 0：Heartbeat 最近一次事件（Gateway）】"
HB_LAST=$(openclaw system heartbeat last --json 2>/dev/null || true)
if [ -n "$HB_LAST" ] && [ "$HB_LAST" != "null" ]; then
  echo "$HB_LAST"
else
  echo "- 无 last heartbeat 事件（null）"
fi

echo

echo "【事实源 0.1：任务进度快照（/home/ubuntu/.openclaw/tasks/T*.json）】"
python3 - <<'PY'
import glob, json, os, time
paths=sorted(glob.glob('/home/ubuntu/.openclaw/tasks/T*.json'))
if not paths:
    print('- tasks 目录无 T*.json')
    raise SystemExit(0)
now=time.time()
window_min=int(os.environ.get('BOTHOOK_REPORT_HOURS','1'))*60
for p in paths:
    st=os.stat(p)
    j=json.load(open(p))
    age_min=(now-st.st_mtime)/60
    touched = 'UPDATED_WITHIN_WINDOW' if age_min <= window_min else 'stale'
    print(f"- {os.path.basename(p)} {touched} mtime={time.strftime('%Y-%m-%d %H:%M:%S %z', time.localtime(st.st_mtime))} status={j.get('status')} progress_percent={j.get('progress_percent')} last_updated={j.get('last_updated')}")
    na=j.get('next_action')
    if na:
        print(f"  next_action: {na}")
PY

echo

echo "【事实源 1：Git commits（过去 1 小时）】"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_LOG=$(git log --since="$SINCE" --pretty=format:'- %h %ad %s' --date=iso --no-merges || true)
  if [ -n "$GIT_LOG" ]; then
    echo "$GIT_LOG"
  else
    echo "- 本小时无 commit"
  fi
else
  echo "- 非 git 仓库"
fi

echo

echo "【事实源 2：P0.2 证据文件（docs/_evidence_p0_2*，过去 1 小时）】"
EVID=$(find p-site/docs -maxdepth 1 -type f -name '_evidence_p0_2_*' -mmin -$((HOURS*60)) -printf '%TY-%Tm-%Td %TH:%TM %p\n' 2>/dev/null | sort || true)
if [ -n "$EVID" ]; then
  echo "$EVID"
else
  echo "- 本小时无新增/更新证据文件"
fi

echo

echo "【事实源 3：池状态快照（SQLite）】"
python3 - <<'PY'
import os, sqlite3
con=sqlite3.connect(os.environ['BOTHOOK_DB_REAL'])
cur=con.cursor()
rows=cur.execute("select lifecycle_status, count(*) from instances group by lifecycle_status").fetchall()
print('lifecycle_status counts:', ', '.join([f"{k}={v}" for k,v in rows]))
rows=cur.execute("select instance_id, public_ip, lifecycle_status, health_status from instances where lifecycle_status in ('IN_POOL','ALLOCATED','DELIVERING','PAID_TEST') order by lifecycle_status, instance_id").fetchall()
for iid, ip, ls, hs in rows:
    print(f"- {iid} {ip} lifecycle={ls} health={hs}")
PY

echo

echo "【事实源 3.1：本小时 Pool 补货/创建事件（SQLite events: POOL_INSTANCE_CREATED）】"
python3 - <<'PY'
import os, sqlite3, json
hours=int(os.environ.get('BOTHOOK_REPORT_HOURS','1'))
con=sqlite3.connect(os.environ['BOTHOOK_DB_REAL'])
cur=con.cursor()
rows=cur.execute("""
  select ts, entity_id, payload_json
    from events
   where event_type='POOL_INSTANCE_CREATED'
     and ts >= datetime('now', ?)
   order by ts asc
""", (f'-{hours} hours',)).fetchall()
if not rows:
    print(f'- 过去 {hours} 小时无 POOL_INSTANCE_CREATED')
else:
    for ts, instance_id, payload_json in rows:
        try:
            p=json.loads(payload_json or '{}')
        except Exception:
            p={}
        print(f"- {ts} instance={instance_id} bundle_id={p.get('bundle_id')} price_cny={p.get('bundle_price_cny')} zone={p.get('zone')}")
PY

echo

echo "【事实源 4：云侧 bothook-pool 实例 RenewFlag / KeyIds（Tencent Lighthouse）】"
if command -v tccli >/dev/null 2>&1 && [ -f /home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env ]; then
  set -a
  source /home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env
  set +a
  tccli lighthouse DescribeInstances --region ap-singapore --Limit 100 --output json 2>&1 | python3 -c 'import sys,json
raw=sys.stdin.read()
start=raw.find("{")
if start!=-1: raw=raw[start:]
raw=raw.strip()
if not raw:
  print("- 云侧快照：tccli 无输出（可能凭据/网络异常）")
  raise SystemExit(0)
try:
  j=json.loads(raw)
except Exception:
  print("- 云侧快照：tccli 输出非 JSON，已跳过")
  print(raw.splitlines()[0][:200] if raw.splitlines() else "")
  raise SystemExit(0)
items=[]
for it in j.get("InstanceSet",[]):
  if it.get("InstanceName")=="bothook-pool":
    items.append((it["InstanceId"], (it.get("PublicAddresses") or [None])[0], it.get("RenewFlag"), len((it.get("LoginSettings",{}) or {}).get("KeyIds") or []), it.get("ExpiredTime")))
for iid, ip, rf, kcnt, exp in sorted(items):
  print(f"- {iid} {ip} RenewFlag={rf} KeyIds={kcnt} Expired={exp}")'
else
  echo "- tccli/credentials 不可用，跳过云侧快照"
fi

echo

echo "【事实源 5：关键服务状态（按实际部署方式判定）】"

unit_exists() {
  local u="$1"
  systemctl list-unit-files --type=service --no-pager 2>/dev/null | awk '{print $1}' | grep -qx "${u}.service"
}

check_systemd() {
  local u="$1"
  if unit_exists "$u"; then
    local st
    st=$(systemctl is-active "${u}.service" 2>/dev/null || true)
    echo "- ${u}: method=systemd status=${st}"
  else
    echo "- ${u}: method=systemd status=not_installed"
  fi
}

check_systemd_or_proc() {
  local u="$1"
  local pat="$2"
  if unit_exists "$u"; then
    local st
    st=$(systemctl is-active "${u}.service" 2>/dev/null || true)
    echo "- ${u}: method=systemd status=${st}"
    return
  fi
  # fallback: process pattern (read-only)
  if ps aux | grep -E "$pat" | grep -v grep >/dev/null 2>&1; then
    echo "- ${u}: method=process status=running"
  else
    echo "- ${u}: method=process status=not_running"
  fi
}

check_openclaw_gateway() {
  # openclaw gateway may be supervised outside systemd; prefer CLI truth
  if unit_exists "openclaw-gateway"; then
    local st
    st=$(systemctl is-active openclaw-gateway.service 2>/dev/null || true)
    echo "- openclaw-gateway: method=systemd status=${st}"
    return
  fi
  if command -v openclaw >/dev/null 2>&1; then
    local out
    out=$(openclaw gateway status 2>/dev/null || true)
    if echo "$out" | grep -qi "running"; then
      echo "- openclaw-gateway: method=openclaw-cli status=running"
    else
      echo "- openclaw-gateway: method=openclaw-cli status=unknown"
    fi
  else
    echo "- openclaw-gateway: method=openclaw-cli status=not_available"
  fi
}

# Web
check_systemd caddy

# BOTHook control-plane
check_systemd_or_proc bothook-api "/control-plane/api-server\\.mjs"
check_systemd_or_proc bothook-support-server "/support-server"
check_systemd_or_proc bothook-ops-worker "bothook-ops-worker|ops-worker"

# Pool/ops background services (may be static/disabled on some hosts)
check_systemd bothook-pool-replenish
check_systemd bothook-delivery-watchdog

# OpenClaw
check_openclaw_gateway

# A2A (informational)
check_systemd a2a-fun-daemon
check_systemd a2a-bootstrap-dev
check_systemd a2a-relay

echo

echo "【事实源 6：最近 6h 错误事件计数（SQLite events / systemd journal）】"
python3 - <<'PY'
import os, sqlite3
con=sqlite3.connect(os.environ['BOTHOOK_DB_REAL'])
cur=con.cursor()
# Generic error-ish event types
rows=cur.execute("""
  select event_type, count(*)
    from events
   where ts >= datetime('now','-6 hours')
     and upper(event_type) like '%ERROR%'
   group by event_type
   order by count(*) desc
   limit 20
""").fetchall()
if not rows:
  print('- SQLite events: past 6h no *ERROR* event_type')
else:
  print('- SQLite events (*ERROR*):')
  for et,c in rows:
    print(f"  - {et}: {c}")
PY

echo

echo "- systemd journal (past 6h, priority=err..alert):"
for s in "${services[@]}"; do
  if systemctl list-unit-files --type=service --no-pager 2>/dev/null | awk '{print $1}' | grep -qx "${s}.service"; then
    n=$(journalctl -u "${s}.service" --since "6 hours ago" -p err..alert --no-pager 2>/dev/null | wc -l | tr -d ' ')
    echo "  - ${s}.service: ${n}"
  fi
done

