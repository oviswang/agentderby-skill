# BOTHook engineering roadmap (working)

Last updated: 2026-02-19

## Guiding principles (owner)
- Delivery engineering strategy: **A (cloud-init / bootstrapping) primary, C (base image) secondary**. No manual on-machine ops (B) in delivery.
- WhatsApp stability is HIGH RISK: backup → change → validate → minimal restart → strong health checks → auto-rollback.
- WhatsApp chat hygiene: hourly work reports to **Telegram**.

## Hard constraints (owner)
- Pool cap = **max 5 machines** counts *all unpaid/temporary instances*:
  - creating
  - provision-ready
  - allocated / in-progress
  - bound-but-unpaid
  Never exceed without explicit owner approval.
- Replenisher schedule: **every 5 minutes**, **at most 1 new machine per run**, write events for audit.
- Pool cloud provider: **Tencent Cloud only** (for now).

---

## P0 — Make delivery reproducible (A-primary)
### P0.1 “p serves artifacts, api serves instructions” bootstrap
- Host versioned artifacts under `p.bothook.me` (no secrets):
  - `bootstrap.sh`, `manifest.json`, `sha256sums.txt`, systemd unit templates, healthcheck scripts
- Provide dynamic per-uuid config via `api.bothook.me`:
  - returns recommended version + download URLs + per-uuid parameters
- cloud-init flow: api → p → execute

**Done when**: a brand-new VM can bootstrap unattended and report `provision-ready`.

### P0.2 Gateway hardening: system-level service
- Run OpenClaw gateway as **system** systemd service (not user session), to avoid `linked but disconnected`.

**Done when**: reboot + idle do not break WhatsApp connectivity.

### P0.3 Key verification → two-phase cutover (no black hole)
- Verify key with minimal OpenAI call.
- Phase 1: start OpenClaw + confirm WhatsApp State=OK.
- Phase 2: stop provisioning responder.
- Timeout path: user gets progress + auto retry/rollback.

**Done when**: after key verified, user’s `hi` always gets a response within ~20s.

### P0.4 “Delivered mode” policy enforcement
- After delivery complete: respond only to self-chat; ignore external contacts.

### P0.5 Strong health checks + auto rollback
- Must include: gateway RPC probe ok + WhatsApp connected/ready + real send/receive test.

---

## P0 — Pool replenisher automation (every 5 minutes)
- Single job, runs every 5 minutes.
- Computes pool size using the cap counting rules above.
- If below cap: create **at most 1** Tencent Cloud instance and run standard init.
- Write events for all actions.

**Done when**: after a machine is delivered/removed, pool auto-refills without exceeding cap.

---

## P0 — Relink (paid + not expired only)
### Requirements
- Entry remains `p.bothook.me/p/<uuid>`.
- Only allow if paid and not expired.
- Must attach to the user’s **original machine** (never allocate a new pool machine).
- Allow new device.

### Anti-theft rule
- QR-scanned WhatsApp account must match `expected wa_jid` stored for that uuid.
- If mismatch: deny relink, disconnect, write security event.

### UX
- All copy is **Chinese + English**.

**Done when**: (1) correct account relink succeeds; (2) wrong account relink is denied.

---

## P1 — Speed/robustness improvements
- C base image: preinstall heavy deps; cloud-init injects uuid/config.
- Better alerts, rate limiting, cool-downs for relink attempts.
- More observability dashboards and automated incident notes.
