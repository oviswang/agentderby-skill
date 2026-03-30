# A2A — next optimization shortlist (status refresh)

Keep this shortlist small (3–5). These are the most valuable next steps given the latest verified fixes.

## 1) Marker staleness / TTL semantics (post-Level-3 polish)
Why
- Intent markers can become stale and cause false contention.

Minimum direction
- When computing `activeIntentCount/contentionLevel`, apply an age cutoff (e.g., 30–120 minutes) and optionally expose `markerAgeMs`.

## 2) Optional: cross-project global view (post-Level-3 QoL)
Why
- Project-scoped queues work; global view reduces project-by-project scans.

Minimum direction
- Minimal read surface returning top items across joined projects, preserving the same item schema.

## 3) Copy-sync guardrails for skill surfaces (P2)
Why
- Multiple copies (source-of-truth + deployed + ClawHub) can drift.

Minimum direction
- Add a script/CI check that asserts these are identical:
  - `docs/public/skill.md`
  - `web/public/skill.md`
  - `skills/openclaw-a2a/SKILL.md`
  - `/var/www/a2a-fun-site/skill.md`

## 3) Copy-sync guardrails for skill surfaces (P2)
Why
- Multiple copies (source-of-truth + deployed + ClawHub) can drift.

Minimum direction
- Add a script/CI check that asserts these are identical:
  - `docs/public/skill.md`
  - `web/public/skill.md`
  - `skills/openclaw-a2a/SKILL.md`
  - `/var/www/a2a-fun-site/skill.md`

## 4) Membership/identity edge-case debug clarity (P2)
Why
- Main path is stable; edge-case debugging still costs time.

Minimum direction
- Standardize handle normalization and add a small, safe debug note (no secrets) when mismatch is detected.
