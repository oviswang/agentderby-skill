# P0.1 — cloud-init 拉取版 artifacts：清单与验收

目标：把「p 发工件、cloud-init/bootstrap 拉取、从 0 到 provision-ready」这条链路工程化落盘。

## 1) Artifacts 目录（不含密钥）

发布目录（示例版本）：
- `https://p.bothook.me/artifacts/v0.1.0/`

文件清单：
- `bootstrap.sh`
  - 作用：cloud-init 主入口；拉取 manifest + units + healthcheck，落盘并安装 systemd unit。
- `manifest.json`
  - 作用：机器可读的清单（文件路径 + sha256）。
- `sha256sums.txt`
  - 作用：完整性校验（sha256sum 输出）。
- `systemd/bothook-provision.service`
  - 作用：BOTHook provisioning server（Baileys）服务单元模板。
- `systemd/openclaw-gateway.service`
  - 作用：OpenClaw gateway 的 system-level 服务单元模板（后续 P0.2 会继续固化）。
- `scripts/healthcheck.sh`
  - 作用：基础健康检查脚本（best-effort，不依赖密钥）。

约束：
- **严禁**在上述目录放任何密钥（OpenAI key、cloud provider key、Turnstile secret、Stripe webhook secret 等）。

## 2) 验收定义（从 0 到 provision-ready）

### 前置
- OS：Ubuntu（与当前交付一致版本）
- 网络：可访问 `p.bothook.me` 与 apt 源

### 步骤
1. 在一台全新机器上通过 cloud-init（或手动）以 root 运行：
   - `curl -fsSL https://p.bothook.me/artifacts/v0.1.0/bootstrap.sh | bash`

2. 预期结果（文件落盘）
- `/opt/bothook/healthcheck.sh` 存在且可执行
- `/opt/bothook/artifacts/manifest.json` 与 `sha256sums.txt` 存在
- `/etc/systemd/system/bothook-provision.service` 存在
- `/etc/systemd/system/openclaw-gateway.service` 存在

3. 预期结果（systemd 级别）
- `systemctl daemon-reload` 已执行（bootstrap 内执行）
- 单元文件语法可被 systemd 识别：
  - `systemctl cat bothook-provision.service`
  - `systemctl cat openclaw-gateway.service`

4. （可选）启用服务（当运行时目录就绪后）
- `systemctl enable --now bothook-provision.service`
- `systemctl enable --now openclaw-gateway.service`

5. 运行健康检查（best-effort）
- `/opt/bothook/healthcheck.sh`

### provision-ready 定义（当前阶段）
- artifacts 已落盘
- systemd units 已安装并可被识别
- healthcheck 脚本可运行

> 注：真正的端到端交付稳定性（WhatsApp linked/保持在线、两阶段切换/回滚、强健康检查）由 P0.2–P0.5 覆盖。

## 3) 版本化与回滚
- 每次变更 artifacts：
  1) 新建版本目录（例如 `v0.1.1/`）
  2) 更新 `manifest.json` 与 `sha256sums.txt`
  3) 保留旧版本以支持快速回滚

## 4) 当前实现位置（repo）
- `/home/ubuntu/.openclaw/workspace/p-site/artifacts/v0.1.0/`
- `/home/ubuntu/.openclaw/workspace/p-site/docs/cloud-init-artifacts-acceptance.md`
