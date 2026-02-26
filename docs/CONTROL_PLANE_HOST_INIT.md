# Master init checklist (bothook.me / p.bothook.me)

目标：无手工操作 + 可重复执行（幂等）。

## 必须固化的 3 点

1) **DB 路径固定**
- control-plane API 必须通过 systemd 固化 `BOTHOOK_DB_PATH` 指向：
  - `/home/ubuntu/.openclaw/workspace/control-plane/data/bothook.sqlite`
- 禁止依赖 cwd 的默认路径（会读到空 DB，导致 uuid=unknown_uuid）。

2) **端口单实例（18998）**
- 18998 只允许 systemd 管理（`bothook-control-plane.service`）。
- 初始化/部署后要清理所有手工启动残留的 `api-server.mjs` 进程，避免抢占端口。

3) **HTTP 不阻塞（SSH/tmux 后台化）**
- 任何可能触发 SSH/tmux 的逻辑（如 status/qr/reset/ops worker 清理）必须满足：
  - HTTP 响应先返回（fast path）
  - SSH 操作异步执行（best-effort）
  - 硬超时（建议 2.5s~8s）+ 不重试/少重试
- 目标：前端永远不会白屏/超时转圈。

## 一键脚本
- `/home/ubuntu/.openclaw/workspace/scripts/bootstrap_control_plane_host.sh`
  - 写入/启用 `~/.config/systemd/user/bothook-control-plane.service`
  - 固化 env（DB path / pool ssh key）
  - 清理 stray `api-server.mjs`

