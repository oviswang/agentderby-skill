# HEARTBEAT.md

TASK 模式（降噪版）

触发约定（为了不打断聊天）：
- 你发送：RUNNER
  我才执行本文件的 TASK/runner 流程。
- 其他普通消息一律按“聊天式任务/询问”处理，我会正常回复与推进，不会只回 HEARTBEAT_OK。

事实源：
- tasks: /home/ubuntu/.openclaw/tasks/*.json
- checkpoints: /home/ubuntu/.openclaw/workspace/checkpoints/<ts>/<task_id>/
- 去重状态：/home/ubuntu/.openclaw/workspace/memory/task-runner-state.json

执行步骤：
1) 运行 runner：
   node /home/ubuntu/.openclaw/workspace/scripts/task_runner.mjs --json
2) 解析输出 JSON：
   - 若 ok=false 或 status 不以 "ok" 开头：
     - 向 Telegram（owner chatId=7095719535）发送告警摘要（必须包含 status + picked/touched + 最近 checkpoint）。
   - 否则（runner 正常）：
     - 若 changed=false：回复 HEARTBEAT_OK。
     - 若 changed=true：只发“增量（delta）”，不要复读 DONE 看板。

增量（delta）发送规则（changed=true）：
A) 向 Telegram **只发送本轮 picked/touched 的自治任务**的摘要（每个任务只引用任务文件字段）：
   - task_id
   - status
   - progress_percent
   - next_action
   - last_updated
   - evidence_path（若任务文件有）

B) **禁止**在汇报里包含与本轮无关的已完成任务（例如 T1/T2/T3）。
   - 即便历史上有“固定列 T1/T2/T3”的模板，也必须视为已废弃。

C) Telegram 去重：
   - 将将要发送的消息文本计算一个 hash（例如 sha256）并写入 memory/task-runner-state.json 的 lastSentHash。
   - 若本次 hash 与 lastSentHash 相同：跳过发送（当作无增量），并回复 HEARTBEAT_OK。

硬规则：
- 所有定时/报表/运营信息只发 Telegram；WhatsApp 仅协调。
- 不编造进度；只引用 tasks/*.json 的字段。
- runner 内部已限速（最多推进 3 个任务），无需额外循环调用。
