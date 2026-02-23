# WhatsApp 登录（单通道模型：channels login）Runbook

目标：保证 **WhatsApp 登录只有一个真实入口**（`openclaw channels login --channel whatsapp`），二维码只是展示层；所有成功判定以 `openclaw channels status` 为准。

适用：入池机初始化 / 交付机 relink / 排障。

## 原则

- ✅ 真实登录入口：`openclaw channels login --channel whatsapp`
- ✅ 成功判定：`openclaw channels status` 显示 connected/ready（并且 creds 文件 mtime 更新）
- ❌ 禁止并发登录：不要同时触发多个 login 流程（包括任何 gateway/web 侧生成 QR 的 RPC/服务）
- ❌ 网页端不得触发登录：网页只读展示 QR，不参与状态机

## 前置检查（在目标机器上）

1) 确认 openclaw 可用

```bash
openclaw --version
openclaw channels status
```

2) 停止一切可能干扰登录的进程/服务

```bash
# 1) 停止 OpenClaw gateway（如存在）
systemctl --user stop openclaw-gateway.service 2>/dev/null || true
sudo systemctl stop openclaw-gateway.service 2>/dev/null || true

# 2) 停止并禁用自建的 provision/baileys 服务（如存在，必须避免其抢占/干扰 session）
sudo systemctl stop bothook-provision.service 2>/dev/null || true
sudo systemctl disable bothook-provision.service 2>/dev/null || true
```

> 目标：确保只有一个 login 进程写 session。

## 执行登录（必须串行 + 稳定 TTY）

### 方式 A：人工 SSH（最稳）

建议用 SSH 进入并强制分配 TTY：

```bash
ssh -tt ubuntu@<ip>
```

在目标机上执行：

```bash
openclaw channels login --channel whatsapp
```

### 方式 B：网页/控制面自动化（推荐：tmux 承载）

背景：`openclaw channels login` 在“无稳定 TTY 的后台（nohup/script）”场景下，可能只输出一次 QR 或直接退出，导致：
- 二维码不轮换（手机扫时经常提示过期/无效）
- 展示层即使不断刷新也永远是同一张码

解决：用 tmux 创建一个持久 TTY，会话断开不影响进程。

在目标机上（ubuntu 用户）执行：

```bash
# 1) 先停 gateway，避免并发竞争
sudo systemctl stop openclaw-gateway.service 2>/dev/null || true
systemctl --user stop openclaw-gateway.service 2>/dev/null || true

# 2) 用 tmux 承载 login（强制宽终端，避免 ASCII QR 截断）
UUID='<uuid>'
SESSION="wa-login-${UUID}"

tmux kill-session -t "$SESSION" 2>/dev/null || true
COLUMNS=220 LINES=80 tmux new-session -d -s "$SESSION" \
  "bash -lc 'stty cols 220 rows 80 2>/dev/null || true; export COLUMNS=220 LINES=80; openclaw channels login --channel whatsapp'"

# 3) 获取二维码（抓取最新输出）
tmux capture-pane -t "$SESSION" -p -S - | tail -n 260
```

展示层：从 capture-pane 输出中提取“Scan this QR …”下面的 ASCII QR block。

登录成功后：

```bash
# 关闭 tmux 会话（避免占资源）
tmux kill-session -t "$SESSION" 2>/dev/null || true

# 启动 gateway
sudo systemctl start openclaw-gateway.service
```

### 记录/展示二维码（展示层只读）

- 捕获 stdout（保存到文件或 tmux scrollback）
- 从输出中提取二维码 block
- 展示建议：将 ASCII QR 转为 canvas 像素图（避免字体抗锯齿导致“看得见但扫不了/缺角”）
  - 关键：**不要 trim 掉行尾空格**（否则二维码右/下会被裁掉）
  - 关键：确保终端宽度足够（例如 cols=220），避免 block 被折行/截断

## 验收

```bash
openclaw channels status
```

要求：
- WhatsApp: connected/ready
- creds 文件 mtime 有变化（路径随版本而定；以 status 输出/日志为准）
- 重启 gateway 后不报 authentication 错误

## 登录成功后

如需要恢复 gateway：

```bash
systemctl --user start openclaw-gateway.service 2>/dev/null || true
sudo systemctl start openclaw-gateway.service 2>/dev/null || true
```

## 常见坑

- 没有稳定 TTY：在 nohup/script 的后台模式下，可能只出 1 张码或直接退出。推荐用 **tmux** 承载。
- 终端太窄：ASCII QR 会被折行/截断 → 展示层会出现“缺角/不全”。固定 `stty cols 220`。
- 展示层裁剪：canvas 渲染时如果 trim 掉行尾空格，会把二维码右/下裁掉。
- HOME 用户不一致：确保以同一个用户（通常 ubuntu）执行 login，并保证写入到正确的 HOME。
- 多进程竞争：任何“生成二维码”的另一路径都会降低成功率（gateway/web.login.start/baileys/provision 等）。
- 版本/配置：需要确保目标机 openclaw 版本支持 whatsapp channel，并且 openclaw.json 中启用了 whatsapp 插件。
