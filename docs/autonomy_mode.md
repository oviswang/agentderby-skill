# BOTHook Autonomy Mode (Task Runner SOP)

Updated: 2026-02-23

This document is the **source of truth** for how the agent runs autonomous work via the task runner.

## 1) Default execution model

- All complex work must be represented as tasks under:
  - `/home/ubuntu/.openclaw/tasks/T*.json`
- The agent advances work using:
  - `RUNNER_MODE=execute_l2 node /home/ubuntu/.openclaw/workspace/scripts/task_runner.mjs --json`
- The runner advances **at most 3 tasks per run** (runner internal limit) and **at most 1 action per task per run**.

## 2) Autonomy rule: never stall on missing actions

- If a task has `actions: []` or missing `actions`, the runner MUST:
  1) **autofill** actions for known task_ids when possible; otherwise
  2) inject a minimal scaffold `repo_write_file` action (docs/_autofill_<tid>.md)
  3) persist the updated task file immediately
  4) execute the first action **in the same run**

This prevents tasks from getting stuck in `missing_actions_spec`.

## 3) Where reports go (channel routing)

- Telegram is **only** for:
  - scheduled daily/hourly reports
  - runner deltas (changed=true)
  - operational alerts (runner errors, cron outputs, etc.)

- WhatsApp is **only** for:
  - owner ↔ agent coordination
  - requests that need owner action/verification (manual testing steps)

**Hard rule:** Do NOT send normal conversational replies to Telegram.

## 4) Reporting rules for TASK mode

When the owner triggers TASK mode:

1) Run the runner:
   - `node /home/ubuntu/.openclaw/workspace/scripts/task_runner.mjs --json`

2) Parse JSON:
   - If `ok=false` OR `status` is not ok* → send a Telegram alert summary.
   - Else if `changed=true` → send Telegram **delta summary for only picked/touched tasks**.
   - Else (changed=false, no alert) → reply `HEARTBEAT_OK` in WhatsApp.

**Important:** Never include unrelated DONE tasks (e.g. T1/T2/T3) in the report template.
## 5) Deltas must go to Telegram

Owner policy:
- When there is progress/delta, **report it to Telegram**.
- Only ask for owner assistance on WhatsApp when needed.

## 6) Owner assistance handshake

- If the runner needs manual steps (e.g., phone scan, WhatsApp message verification), it should:
  - write clear instructions into the task `next_action`
  - ping the owner on WhatsApp with **one** actionable request and expected outcome

## 7) Safety boundaries (unchanged)

- L3 actions are forbidden by the runner (no destructive remote/cloud actions).
- High-risk changes require explicit owner confirmation.

