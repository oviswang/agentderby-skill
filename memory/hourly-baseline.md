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
