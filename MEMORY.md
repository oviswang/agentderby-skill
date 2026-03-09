# Long-term memory (bothook)

## Secrets / credentials handling
- Owner will provide required keys; store them locally under `/home/ubuntu/.openclaw/credentials/*.env` (chmod 600) or `~/.openclaw/.env` when required by OpenClaw.
- Never echo secrets back into chat.

## Stored credentials (as of 2026-02-18)
- Tencent Cloud sub-account credentials are stored at `/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env`.
- Cloudflare Turnstile credentials are stored at `/home/ubuntu/.openclaw/credentials/cloudflare_turnstile.env`.
- Brave Search API key is configured via `BRAVE_API_KEY` in `/home/ubuntu/.openclaw/.env`.
- SendGrid API key + mail settings are stored at `/home/ubuntu/.openclaw/credentials/sendgrid.env`.
  - Policy: `SENDGRID_FROM=support@bothook.me` and `SENDGRID_REPLY_TO=support@bothook.me` (do not use owner Gmail for support flows).
- Stripe webhook secret + live key + standard price id are stored at `/home/ubuntu/.openclaw/credentials/stripe.env`.
- SocialData API key is stored at `/home/ubuntu/.openclaw/credentials/socialdata.env`.
- Telegram bot token + owner chat id are stored at `/home/ubuntu/.openclaw/credentials/telegram.env`.
- Google Ads API credentials (developer token + OAuth client + refresh token) are stored at `/home/ubuntu/.openclaw/credentials/google_ads.env`.
  - Working call structure (verified): Python `google-ads==29.2.0` SearchStream or REST v23 `googleAds:searchStream` with `login-customer-id` header set to MCC when accessing client customer.

## Stability/Safety SOP (high-risk changes)
- Treat any operation that can break WhatsApp connectivity as HIGH RISK.
- Always: backup → change → validate → restart/reload minimally → strong health checks → auto-rollback on failure.
- Strong health checks must include `openclaw gateway status` RPC probe ok + WhatsApp connected/ready + real send/receive test.
- New channels require end-to-end acceptance before declaring success.

## Pool provisioning constraint (owner)

### Pool READY gate (owner)
- Only mark a machine as ready-for-allocation when:
  1) Cloud keypair binding is correct (Lighthouse `LoginSettings.KeyIds` includes `bothook_pool_key`).
  2) Bootstrap completed (node/openclaw installed; systemd units present).
  3) Minimal config present (gateway does not hang on missing config; QR flow can start).
  4) P0.2 reboot acceptance passed and evidence log saved.
- Use statuses like `IN_POOL_NOT_READY` vs `IN_POOL_READY` (or `health_status`) to avoid allocating half-initialized machines.

### SSH keypair drift handling (owner)
- Treat SSH reachability as a preflight gate for READY.
- On every scheduler tick, cheaply audit Lighthouse instances for keypair drift (`LoginSettings.KeyIds`). If missing, auto-run `AssociateInstancesKeyPairs` to re-bind `bothook_pool_key` and re-probe SSH.

- Pool cap (current config) = **max 10 machines** (`BOTHOOK_POOL_CAP_TOTAL=10`) counts *all unpaid/temporary instances*, including creating + provision-ready + allocated/in-progress + bound-but-unpaid.
  - Warn threshold: `BOTHOOK_POOL_WARN_TOTAL=8`
  - Target READY: `BOTHOOK_POOL_TARGET_READY=2`
- Replenisher schedule: every 5 minutes; at most 1 new machine per run; write events for audit.
- Pool cloud provider is **Tencent Cloud only** right now (this is the only API credentials available).
- Future: may add other providers, but do not assume; implement provider layer with Tencent first.
- Unpaid/provision-ready server pool cap: governed by `BOTHOOK_POOL_CAP_TOTAL` (currently **10**); adjust only with explicit owner confirmation.

### Pool auto-renew policy (owner)
- New pool instances default to **auto-renew ON** (monthly) to avoid cloud-expiry vs subscription-period mismatch.
- Subscription invalidation policy: payment_failed/past_due grace=**24h**. After grace: reimage→return to pool; if pool exceeds target size, terminate some instances to reduce cost.

### Pool replenisher schedule (owner)
- Scheduler tick: **every 1 minute** (fast detection).
- Heavy actions (create/bootstrap/reimage/terminate) must run via a queued worker with global locks + concurrency limits (do not increase heavy concurrency just because tick is faster).

## Workstation / master host (MUST NOT TOUCH)
- Tencent Lighthouse instance: `lhins-npsqfxvn` (ap-singapore-1)
  - Public IP: `43.160.236.20`
  - Role: **workstation/master** (this is where the agent runs; hosts bothook.me / p.bothook.me)
  - **Hard rule:** never treat this instance as a pool/deliverable machine; never recycle/terminate it as part of pool ops.
  - **Reporting rule:** when listing “user machines / undelivered machines / pool machines”, DO NOT include this host; only mention it if explicitly asked about the workstation.

## Reporting / comms routing (owner preference)
- Keep WhatsApp chat clean: WhatsApp is for owner↔agent work coordination（仅临时讨论/指令/确认）。
- **硬规则**：所有“小时级工作日报/定时报告”以及**未来所有运营信息**（客服回复、入池/回收、订阅/支付、cron 产出等）一律发到 **Telegram（owner）**；**不要**再发到 WhatsApp。
- 执行要求：即便服务器/agent 重启也必须遵守；当 WhatsApp 收到 cron 提醒触发时，主会话不再转发/复述（除非 owner 明确要求）。

## Internationalization (owner spec)
- Language must be first-class state: main-site selected language propagates end-to-end (p-site pages, relink, onboarding/welcome/promo copy, support replies, and **WhatsApp onboarding prompts (incl. OpenAI key setup)**).
- Implementation: carry `lang` in URLs/forms, persist to DB per uuid (e.g. `deliveries.user_lang`), and default to `en` if missing.

## Persistent user recovery link (owner spec)
- On delivered machines, write a fixed local file containing the user's UUID + p-site link for recovery/control:
  - Path: `/opt/bothook/UUID.txt`
  - Content includes: `uuid=<uuid>` and `https://p.bothook.me/p/<uuid>?lang=<lang>`
- Do **not** rely on Stripe email receipt/checkout email for this in the current phase.
- FAQ must document how to retrieve this link; users may also ask OpenClaw to print it.

## Delivery state machine (owner spec)
- 交付工程化策略：**A(Cloud-init/开机自举)为主，C(基础镜像)为辅**；不允许需要人工上机操作的交付流程（B）。
- Delivery complete only when: WhatsApp linked (bind by `wa_jid`) + paid + OpenAI API key provided & verified (direct mode; proxy later).
- Before delivery complete:
  - Self-chat gets welcome/onboarding copy.
  - External contacts get promo copy.
  - 20-min timeout after bind (if unpaid): auto-unbind + cleanup + return to pool.
- After delivery complete: machine becomes **self-chat control mode** (owner is the user's own WhatsApp number); external contacts must be ignored (no response).
- Post-delivery: no platform welcome copy; the user's own model drives the conversation. Platform exits except for retention of SSH rights for lifecycle ops (cancel/expiry reclaim) and support interventions.
- OpenAI key verification should be minimal: a lightweight API call (e.g., `GET /v1/models`) to confirm the key works; user can rotate/change key later via a documented chat command.
- Before exiting on delivery, write a small persistent “constitution” on the user machine: includes UUID + rules (prefer solving via chat; user has no SSH) while keeping it minimal to avoid impacting user experience.
