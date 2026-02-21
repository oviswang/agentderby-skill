# BOTHook 任务安排 + 任务自治推进模式（落盘）

> 本文档用于把当前的三条主线任务（A/B/C）以及“任务自治推进（TASK 模式）”的运行约定落盘，便于重启后可恢复、可审计、可回滚。

## 0. 关键硬规则（Owner）

- **小时级工作日报/定时报告/运营信息：只发 Telegram（owner chatId=7095719535）**。
  - WhatsApp 仅用于临时协调/指令/确认。
- 任何可能影响 WhatsApp 连接稳定性的动作视为 **高风险**：必须备份→变更→验证→最小重启→强健康检查→失败回滚。

## 1. 当前任务看板（ABC 三条主线）

任务文件为事实源：`/home/ubuntu/.openclaw/tasks/T1.json` ~ `T3.json`

### T1（A线）Pool READY 标准化（P0.2）
- 目标：所有 `IN_POOL` 机器完成 P0.2 reboot 验收 + evidence 落盘，并标记 READY（后续进入分配逻辑仅用 READY）。
- DONE 标准（来自 task 文件）：
  1) KeyIds 绑定 bothook_pool_key；
  2) bootstrap 完成（openclaw+systemd unit）；
  3) 最小 config 存在（gateway 不再 waiting for config）；
  4) 完成 P0.2 reboot evidence log 落盘；
  5) `instances.health_status=READY`。
- 当前 next_action：见 `T1.json.next_action`。

### T2（B线）生命周期状态机（24h grace → reimage 回池 / 超量 terminate）
- 目标：支持 subscription invalidation → 24h grace → 执行 lifecycle_action（reimage/terminate）并写入 events 审计。
- 安全闸门：不可逆动作必须显式 `--confirm`，默认 dry-run。
- 当前 next_action：见 `T2.json.next_action`。

### T3（C线）Relink v2（p/<uuid> 状态页 + busy/排队 + paid(valid)→新机续上入口）
- 目标：p-site 对 uuid 展示状态分支（NEW/LINKING/ACTIVE/INACTIVE/BUSY）；busy 时显示排队；lang 贯穿。
- 当前 next_action：见 `T3.json.next_action`。

## 2. 任务自治推进模式（TASK 模式）

### 2.1 入口与状态文件
- tasks 目录：`/home/ubuntu/.openclaw/tasks/`
- 任务文件：`T1.json` / `T2.json` / `T3.json`
- 触发文件（workspace）：`/home/ubuntu/.openclaw/workspace/HEARTBEAT.md`
  - **必须非空**，否则 heartbeat 会被当作 empty-heartbeat-file 跳过。
  - 当前内容要求：至少包含一行 `RUN_TASKS`。
- 自治状态：`/home/ubuntu/.openclaw/autonomous_state.json`
  - 预期：`{"autonomous_state":"ACTIVE","mode":"TASK",...}`

### 2.2 调度策略（约定）
- Heartbeat 周期：3 分钟（由 openclaw.json 配置）。
- 每轮最多推进 3 个任务（按 priority，高→低；Round-Robin）。
- 每个任务每轮最多推进 3 个“最小单元”（一般=一次工具调用/一条命令）。
- 同资源加锁串行。
- 同一任务失败 ≥2 次：标记 BLOCKED，并只提出 1 个最小问题。

### 2.3 输出策略（约定）
- Heartbeat 输出：仅在 **告警/阻塞/进度变化** 时向 Telegram 汇报摘要；若无变化则 HEARTBEAT_OK（或 silent）。

### 2.4 当前已知问题（事实）
- Heartbeat 已恢复运行（不再 skipped），但 **任务推进 runner 尚未落地**：
  - 三个任务在 heartbeat 扫描时被判定 runnable，但实际为 `runner_missing`。
  - 体现为：`T1/T2/T3.json` 的 mtime/last_updated 长时间不变。

## 3. 小时报表（Telegram only）

- OpenClaw cron job：`bothook-hourly-work-report`
- 事实源脚本：`/home/ubuntu/.openclaw/workspace/scripts/hourly_facts.sh`
  - 已增强包含：heartbeat last 事件 + T1/T2/T3 任务快照（status/%/next_action/是否 1 小时内更新）。

## 4. 重启后恢复 checklist（建议）

1) `openclaw gateway status` 确认 RPC probe ok。
2) 检查 `HEARTBEAT.md` 非空且含 `RUN_TASKS`。
3) `openclaw system heartbeat last --json` 确认 status 非 skipped（例如 ok-*）。
4) 观察 `T1/T2/T3.json` 是否在 1-2 个 heartbeat 周期内更新（mtime/last_updated）。

## 5. 回滚方法（最小）

- 停止 heartbeat 自动运行（不改 openclaw.json 的情况下）：
  - 将 `HEARTBEAT.md` 恢复为空/仅注释即可（会触发 empty-heartbeat-file 跳过）。
  - 示例：
    - 保留文件但只写注释行。

---

最后更新：2026-02-21
