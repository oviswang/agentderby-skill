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

## 2) P0.2 Single-gateway systemd solidification — evidence chain (medium)
- Current: artifacts exist; some test machines show port conflicts (stray gateway process) and systemd restart noise.
- DoD:
  - On 1 IN_POOL machine: bootstrap → services enabled → reboot → idle → WhatsApp remains stable.
  - Record outputs (timestamps + instance id + key commands).
  - Update acceptance doc with the exact verification steps.

## 3) P0.3 (Deprecated) Two-phase cutover / dual-fallback
- No longer a delivery requirement under the simplified strategy.
- Keep scripts only as optional debugging helpers.

## 4) P0.4 (Deprecated) Delivered-mode lockdown
- No longer required (users may reclaim the machine after delivery).
- SSH support is best-effort only; platform must not depend on it.

## 5) P0.5 (Reduced) Health checks
- Keep basic bootstrap acceptance checks.
- Do not implement complex auto-rollback on user machines; rely on cloud-provider API for lifecycle actions.

## 6) Pool replenisher automation (hard)
- Every 5 min; at most 1 create/run; cap=5 counting all unpaid/temporary states.
- Full events audit.

## 7) Relink v2 (paid only → allocate a fresh machine) (hard)
- Entry: `p.bothook.me/p/<uuid>`
- Only allow if paid & not expired.
- Allocate/create a new machine and run standard bootstrap.
- Old machine may be lost/corrupted; do not depend on its state.
- CN/EN UX.

## Paused (do not advance)
- P-site 15 languages
- Base image C
