# BOTHook Support Worker — Security boundaries

This support workflow is intentionally **low-risk**.

## What it does
- Accepts contact form submissions (`/ticket`) and stores them on disk as JSONL.
- A periodic worker sends a professional reply email via SendGrid.
- The worker syncs the question + result to the owner Telegram.

## What it must NOT do
- No shell execution.
- No SSH access.
- No reading or writing unrelated system configuration.
- No network calls except:
  - SendGrid `POST /v3/mail/send`
  - Telegram Bot API `sendMessage`

## Idempotency
- Each *submission entry* is processed once using `support/state.json` (`processedEntries`).
- Follow-ups are supported by submitting the same `ticket_id` again (status=`followup`).
- Reply cap: max **10 replies per ticket_id** (`ticketReplies[id].count`).

## Rate limiting
- Basic server-side per-email rate limit: max 10 submissions per hour.
- Worker run limit: `SUPPORT_MAX_PER_RUN` (default 10).

## Data retention
- `support/tickets.jsonl`: append-only inbound log.
- `support/handled.jsonl`: append-only processing log.
- `support/state.json`: processing + rate-limit state.

## Credentials
- SendGrid: `/home/ubuntu/.openclaw/credentials/sendgrid.env`
- Telegram: `/home/ubuntu/.openclaw/credentials/telegram.env`
- Never echo secrets into logs or chat.
