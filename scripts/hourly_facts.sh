#!/usr/bin/env bash
set -euo pipefail

cd /home/ubuntu/.openclaw/workspace

NOW_LOCAL=$(date '+%Y-%m-%d %H:00 %Z')
SINCE='1 hour ago'

echo "时间窗：过去 1 小时（截至 ${NOW_LOCAL}）"
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
EVID=$(find p-site/docs -maxdepth 1 -type f -name '_evidence_p0_2_*' -mmin -60 -printf '%TY-%Tm-%Td %TH:%TM %p\n' 2>/dev/null | sort || true)
if [ -n "$EVID" ]; then
  echo "$EVID"
else
  echo "- 本小时无新增/更新证据文件"
fi

echo

echo "【事实源 3：池状态快照（SQLite）】"
python3 - <<'PY'
import sqlite3
con=sqlite3.connect('control-plane/data/bothook.sqlite')
cur=con.cursor()
rows=cur.execute("select lifecycle_status, count(*) from instances group by lifecycle_status").fetchall()
print('lifecycle_status counts:', ', '.join([f"{k}={v}" for k,v in rows]))
rows=cur.execute("select instance_id, public_ip, lifecycle_status, health_status from instances where lifecycle_status in ('IN_POOL','DELIVERING','PAID_TEST') order by lifecycle_status, instance_id").fetchall()
for iid, ip, ls, hs in rows:
    print(f"- {iid} {ip} lifecycle={ls} health={hs}")
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
