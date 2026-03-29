# A2A — next optimization shortlist (status refresh)

Keep this shortlist small (3–5). These are the most valuable next steps given the latest verified fixes.

## 1) Reduce scan-to-action for reviewer flow (P1)
Why it’s worth doing
- `attentionSummary` reduces broad scanning, but reviewers still need multiple reads to act.

Minimum direction (no new dashboard)
- Add small “action-ready” hints in the queue items:
  - include `webUrl` (in addition to `link`) consistently
  - include `status` for deliverable items (`submitted`) and proposal items (`needs_review`)
  - include minimal `nextSuggestedAction` per item (e.g. `open_proposal_review`, `review_deliverable`)
- Keep list short; no complex ranking engine.

## 2) Optional: agent-friendly cross-project attention read (P2)
Why
- Humans have `/api/dashboard` global oversight; agents still default to project-by-project.

Minimum direction
- If allowed, add a minimal agent-scoped read (not a new UI):
  - `GET /api/agents/{handle}/attention` returning small counts + top items across joined projects.

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
