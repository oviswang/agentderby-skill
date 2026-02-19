# Long-term memory (bothook)

## Secrets / credentials handling
- Owner will provide required keys; store them locally under `/home/ubuntu/.openclaw/credentials/*.env` (chmod 600) or `~/.openclaw/.env` when required by OpenClaw.
- Never echo secrets back into chat.

## Stored credentials (as of 2026-02-18)
- Tencent Cloud sub-account credentials are stored at `/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env`.
- Cloudflare Turnstile credentials are stored at `/home/ubuntu/.openclaw/credentials/cloudflare_turnstile.env`.
- Brave Search API key is configured via `BRAVE_API_KEY` in `/home/ubuntu/.openclaw/.env`.
- SendGrid API key + mail settings are stored at `/home/ubuntu/.openclaw/credentials/sendgrid.env`.
- Stripe webhook secret + live key + standard price id are stored at `/home/ubuntu/.openclaw/credentials/stripe.env`.
- SocialData API key is stored at `/home/ubuntu/.openclaw/credentials/socialdata.env`.
- Telegram bot token + owner chat id are stored at `/home/ubuntu/.openclaw/credentials/telegram.env`.

## Stability/Safety SOP (high-risk changes)
- Treat any operation that can break WhatsApp connectivity as HIGH RISK.
- Always: backup → change → validate → restart/reload minimally → strong health checks → auto-rollback on failure.
- Strong health checks must include `openclaw gateway status` RPC probe ok + WhatsApp connected/ready + real send/receive test.
- New channels require end-to-end acceptance before declaring success.

## Reporting / comms routing (owner preference)
- Keep WhatsApp chat clean: WhatsApp is for owner↔agent work coordination.
- Send hourly work reports + future ops/cron-generated updates (customer support replies, new machines added to pool, subscription/paid events, etc.) to the owner via **Telegram**.

## Delivery state machine (owner spec)
- Delivery complete only when: WhatsApp linked (bind by `wa_jid`) + paid + OpenAI API key provided & verified (direct mode; proxy later).
- Before delivery complete:
  - Self-chat gets welcome/onboarding copy.
  - External contacts get promo copy.
  - 20-min timeout after bind (if unpaid): auto-unbind + cleanup + return to pool.
- After delivery complete: machine becomes **self-chat control mode** (owner is the user's own WhatsApp number); external contacts must be ignored (no response).
