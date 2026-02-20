# BOTHook 小时级基线 / 增量记录

> 目的：让每小时进展可对账（本小时做了什么、完成定义、产出链接/commit、下一步），并能复盘是否偏离 P0。

## 使用规则（强制）
- 每小时**只追加**一条记录（append-only），不要改历史。
- 每条记录必须包含：
  - 时间窗（起止）
  - 本小时聚焦的 P0 子任务（1 个为主）
  - 完成定义（DoD）
  - 实际产出（commit/PR/文档链接/工单号；若无，写原因）
  - 阻塞（如有）
  - 下一小时 1–2 个明确目标

---

## 模板（复制粘贴填写）

### YYYY-MM-DD HH:00–HH:59 CST
- P0 子任务：
- 完成定义（DoD）：
- 本小时完成：
- 产出链接/commit：
- 阻塞：
- 下一小时目标（1–2 条）：

---

### 2026-02-20 07:00–07:59 CST
- P0 子任务：P0.1 cloud-init artifacts 清单与验收文档（v0.1.0）
- 完成定义（DoD）：在 p-site 下生成可公开拉取的 artifacts 目录（bootstrap/manifest/sha256/systemd/healthcheck）+ 验收文档骨架；不含密钥；并提交 git。
- 本小时完成：已创建 p-site/artifacts/v0.1.0 全套文件 + p-site/docs/cloud-init-artifacts-acceptance.md。
- 产出链接/commit：fb601ba（P0.1: add cloud-init artifacts + acceptance doc (v0.1.0)）
- 阻塞：尚未进行真实新机 cloud-init 端到端验证（需一台全新实例执行 curl|bash 验收）。
- 下一小时目标（1–2 条）：1) 用一台全新机器按验收步骤跑一遍并记录结果；2) 依据结果修正 unit/路径假设。

---

### 2026-02-20 08:00–08:59 CST
- P0 子任务：P0.1 cloud-init artifacts 端到端新机验收（按 v0.1.0 文档跑通）
- 完成定义（DoD）：在一台全新实例上按验收文档从 0 跑通到 provision-ready；记录命令、输出摘要与任何偏差；必要时提交修复。
- 本小时完成：小时开始，尚未完成端到端验收；已明确本小时验收范围与记录要求。
- 产出链接/commit：暂无（原因：端到端验收尚未开始/未完成）。
- 阻塞：需要一台可用于“全新开机自举”的实例（或等价的可重复环境）用于跑验收；否则只能做静态审阅。
- 下一小时目标（1–2 条）：1) 准备/获取一台全新实例并按文档执行验收；2) 若发现路径/unit 假设不一致，提交最小修复并更新验收文档。

---

### 2026-02-20 08:00–08:59 CST
- P0 子任务：P0.1 artifacts 端到端验收（使用池内 IN_POOL 机器）
- 完成定义（DoD）：从一台池内机器完成 curl|bash 执行 bootstrap；确认关键文件/units 落盘；运行 healthcheck 并记录结果。
- 本小时完成：已将除 paid 测试机外的 4 台机器同步为 IN_POOL；选择 lhins-an0746iv(124.156.200.117) 执行 bootstrap 验收；healthcheck 通过（provision /healthz not ready 属于预期：服务未启动）。
- 产出链接/commit：fb601ba（artifacts v0.1.0）+ control-plane DB events: INSTANCE_LIFECYCLE_SYNC（bfmjrdqj/gs58d0eh/d6zdsg19）
- 阻塞：needrestart 提示重启部分服务（systemd-logind deferred）；openclaw gateway unit 路径假设需后续在真实交付镜像/安装方式下再验证。
- 下一小时目标（1–2 条）：1) 再选一台 IN_POOL 机器重复验收，确认一致性；2) 校验 openclaw gateway 的 ExecStart 路径与实际安装一致并形成可配置项。

---
