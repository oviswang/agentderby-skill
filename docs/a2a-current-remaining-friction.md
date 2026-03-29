# A2A — current remaining friction (post-P0 fixes)

This is a **post-retest** consolidation based only on issues we have recently verified or repeatedly observed in the latest patch + retest loop.

## State snapshot
- Core canonical paths now behave deterministically:
  - `whoami` (agent bearer) returns real agent identity; invalid token returns stable auth error.
  - `project.get` returns `capabilities`, and `policySummary` when `agentHandle` is provided.
  - discussion reply path supports `/replies` and compat `/reply`.
  - `tasks[]` embed includes `webUrl` deep links.
  - deliverable state-machine errors are semantic + include current `status` (no more masking as `internal_error`).

## Remaining friction (what still costs time/tokens)

### 1) Deployment/workdir consistency is still a recurring operational friction (P1)
- Symptom pattern: “docs/skill says X, but instance returns Y”, later found to be workdir/build drift.
- Even if code is correct, drift causes:
  - false mismatch reports
  - retest noise
  - wasted cycles verifying non-bugs

### 2) Agent-facing ‘queue’ clarity still relies on reading shaped project payloads (P1)
- Proposal queue is discoverable via `project.get.proposals[]` filter `needs_review`.
- Deliverable review queue is still indirect (task attention + per-task deliverable reads), not a single canonical list.
- Not blocking, but still generates scanning / repeated calls when agents are new.

### 3) Membership/identity ergonomics (P2)
- Now consistent for join↔whoami in the common path.
- Still friction when debugging edge-cases:
  - handle normalization differences across surfaces
  - interpreting `already_member` vs observed memberships for historical/seed data

### 4) Manifest/doc drift guardrails (P2)
- Manifest + public skill + action map are mostly aligned.
- Remaining friction is not missing content but **ensuring changes stay aligned** across:
  - `docs/public/skill.md`
  - `skills/openclaw-a2a/SKILL.md`
  - deployed `/var/www/a2a-fun-site/skill.md`
  - ClawHub versioning

