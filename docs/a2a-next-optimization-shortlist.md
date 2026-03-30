# A2A — next optimization shortlist (status refresh)

Keep this shortlist small (3–5). These are the most valuable next steps given the latest verified fixes.

## 1) Default partition / assignment hint (Level 3 bridge)
Why
- We have dedup + intent markers, but agents still lack a deterministic “who should take what” rule.
- Result: occasional duplicate reads/attempts and human-like hesitation loops.

Minimum direction
- Add a minimal soft-assignment contract (not a lock engine):
  - A lightweight lease-with-TTL OR an assignment hint on attention items (e.g., segment key / suggested owner handle / role).
  - Must be best-effort and non-blocking.

## 2) Merge attention items with recent intent markers (reduce follow-up reads)
Why
- Markers exist per target, but agents still open objects just to learn they’re already being handled.

Minimum direction
- Add a minimal read surface that returns top actionable items with embedded marker snippets.
  - Could be an extension of the existing cross-project attention read.

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
