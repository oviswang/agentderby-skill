# BOTHook — Next actions (ordered easy → hard)

Last updated: 2026-02-20

## 0) Hard rules (owner)
- Hourly reports + all ops messages must go to Telegram only; do not relay to WhatsApp.

## 1) Telegram hourly report delivery — fix & harden (easy)
- Symptom: cron announce delivery sometimes fails with `pairing required`.
- Required: root-cause and harden so hourly delivery is reliable.
- DoD:
  - cron run results in a Telegram message to owner every hour.
  - If delivery fails, an automatic retry path exists + emits a clear error event.
  - Document the fix.

## 2) P0.2 Gateway systemd solidification — evidence chain (medium)
- Current: artifacts exist; some test machines show port conflicts (stray gateway process) and systemd restart noise.
- DoD:
  - On 1 IN_POOL machine: bootstrap → services enabled → reboot → idle → WhatsApp remains stable.
  - Record outputs (timestamps + instance id + key commands).
  - Update acceptance doc with the exact verification steps.

## 3) P0.3 Two-phase cutover — finish E2E rollback (medium-hard)
- Current artifacts/doc:
  - `p-site/docs/p0.3-two-phase-cutover.md`
  - `p-site/artifacts/v0.1.6/scripts/cutover.sh`
- DoD:
  - Success path: key verify OK + WA health OK + send-test OK + stop provision + post-check OK.
  - Failure path: force post-check failure → automatic rollback restores provision (and gateway if needed).
  - Write auditable evidence (logs/events) and update doc.

## 4) P0.4 Delivered mode policy enforcement (hard)
- Enforce: after delivery complete, respond only to self-chat; ignore external contacts.
- DoD: regression tests across direct chats + groups + external inbound.

## 5) P0.5 Strong health checks + auto rollback SOP (hard)
- Engineering: backup→change→validate→minimal restart→strong health check→auto rollback.
- Strong health check must include: RPC probe OK + WhatsApp connected/ready + real send/receive test.

## 6) Pool replenisher automation (hard)
- Every 5 min; at most 1 create/run; cap=5 counting all unpaid/temporary states.
- Full events audit.

## 7) Relink (paid only, original machine only, anti-theft) (hardest)
- Entry: `p.bothook.me/p/<uuid>`
- Must verify scanned account matches expected `wa_jid`.
- CN/EN UX; write security events on mismatch.

## Paused (do not advance)
- P-site 15 languages
- Base image C
