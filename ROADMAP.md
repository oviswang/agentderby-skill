# BOTHook engineering roadmap (working)

Last updated: 2026-02-19

## Guiding principles (owner)
- Internationalization (hard rule): language selected on the main site must propagate end-to-end across the whole journey (p-site, relink, onboarding/welcome copy, promo copy, support). Treat `lang` as first-class state.
- Delivery engineering strategy: **A (cloud-init / bootstrapping) primary, C (base image) secondary**. No manual on-machine ops (B) in delivery.
- WhatsApp stability is HIGH RISK: backup → change → validate → minimal restart → strong health checks → auto-rollback.
- WhatsApp chat hygiene: hourly work reports to **Telegram**.

## Hard constraints (owner)
- Pool instances default: **auto-renew ON** (monthly). Grace for payment failures: **24h**. After grace: reimage→return to pool; if pool exceeds target size, terminate to reduce cost.
- Pool cap = **max 5 machines** counts *all unpaid/temporary instances*:
  - creating
  - provision-ready
  - allocated / in-progress
  - bound-but-unpaid
  Never exceed without explicit owner approval.
- Replenisher schedule: **every 5 minutes**, **at most 1 new machine per run**, write events for audit.
- Pool cloud provider: **Tencent Cloud only** (for now).

---

## P0 — Simplify: one-time delivery + cloud API lifecycle

Owner decision (2026-02-20): after OpenClaw is delivered to the user and the model is configured + verified, platform exits the dual-mode/dual-fallback approach. We do not attempt to fully prevent "power users" from reclaiming the machine; engineering focus is on **cloud-provider API lifecycle** (create/renew/expire/terminate) and reproducible bootstrap.

### P0.1 “p serves artifacts, api serves instructions” bootstrap
- Host versioned artifacts under `p.bothook.me` (no secrets):
  - `bootstrap.sh`, `manifest.json`, `sha256sums.txt`, systemd unit templates, healthcheck scripts
- Provide dynamic per-uuid config via `api.bothook.me`:
  - returns recommended version + download URLs + per-uuid parameters
- cloud-init flow: api → p → execute

**Done when**: a brand-new VM can bootstrap unattended and report `provision-ready`.

### P0.2 Single-gateway systemd (keep the machine "clean")
- Run OpenClaw gateway as a **system** systemd service (not user session).
- Avoid dual-stack responder patterns that compete for the same WhatsApp session/ports.

**Done when**: reboot + idle do not break WhatsApp connectivity.

### P0.3 (Deprecated) Two-phase cutover / dual-fallback
- Previously planned; now **deprecated** under the simplified delivery strategy.
- Keep any scripts as optional debugging tools, not a delivery requirement.

### P0.4 (Deprecated) Delivered-mode hard lockdown
- No longer a platform requirement. Users may reclaim the machine after delivery.
- SSH (if present) is best-effort support only; platform does not depend on it.

### P0.5 (Reduced) Health checks
- Keep basic health checks for bootstrap acceptance.
- Do not build complex auto-rollback on user machines; rely on cloud-provider API for lifecycle actions.

---

## P0 — Pool replenisher automation (every 5 minutes)
- Single job, runs every 5 minutes.
- Computes pool size using the cap counting rules above.
- If below cap: create **at most 1** Tencent Cloud instance and run standard init.
- Write events for all actions.

**Done when**: after a machine is delivered/removed, pool auto-refills without exceeding cap.

---

## P0 — Relink v2 (paid + not expired only, allocate a fresh machine)

Owner decision (2026-02-20): Relink no longer means "re-attach to the original machine". It is a paid-status check + fast continuation path.

### Requirements
- Entry remains `p.bothook.me/p/<uuid>`.
- Only allow if paid and not expired.
- Allocate / create a **fresh machine** and run standard bootstrap.
- The old machine may be considered lost/corrupted; platform should not depend on its state.

### Security rule (minimal)
- Relink must be gated by paid status (and optionally rate limited). Do not implement complex anti-theft wa_jid matching against an old machine.

### UX
- All copy is **Chinese + English**.

**Done when**: paid & valid relink results in a new working machine and the user can chat again.

---

## P1 — Speed/robustness improvements
- C base image: preinstall heavy deps; cloud-init injects uuid/config.
- Better alerts, rate limiting, cool-downs for relink attempts.
- More observability dashboards and automated incident notes.
