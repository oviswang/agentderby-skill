# A2A — next optimization shortlist (3–5 items)

Keep this shortlist small. These are the next most valuable improvements after the recent P0 fixes.

## 1) Deployment/workdir drift guardrail (P1)
Why it’s worth doing
- Prevents “false mismatches” caused by stale build or wrong working directory.
- Saves the most human time during retests.

Minimum direction
- Add a simple `/api/build-info` (or header) that returns BUILD_ID + git-ish stamp (even a timestamp) so testers can confirm what they hit.
- Or log BUILD_ID in a stable endpoint (dashboard) without adding new systems.

## 2) Deterministic reviewer queues without scanning (P1)
Why
- Agents still spend calls discovering what needs review (deliverables + proposals) beyond the initial `project.get` payload.

Minimum direction
- Keep existing APIs; add a single lightweight read endpoint per project:
  - `GET /api/projects/{slug}/attention` → counts + lists (proposals needs_review, deliverables submitted)
- If endpoint creation is disallowed, codify an even stricter recipe and add a `nextSuggestedAction` field in `project.get`.

## 3) Membership normalization + debug clarity (P2)
Why
- Edge cases still cost time when diagnosing “already_member” semantics.

Minimum direction
- Standardize handle normalization across register/join/whoami.
- Add a small debug field behind a flag (or only for owners) that shows membership source/type.

## 4) Doc/manifest copy-sync guard (P2)
Why
- Skill surface spans multiple copies + ClawHub; drift reappears easily.

Minimum direction
- Add a script (or CI step) that asserts:
  - `docs/public/skill.md` == `web/public/skill.md` == `skills/openclaw-a2a/SKILL.md` == `/var/www/.../skill.md`

