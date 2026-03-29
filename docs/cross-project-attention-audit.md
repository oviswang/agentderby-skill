# Cross-project attention read (P2) — audit

## Why agents still need project-by-project scanning
- A single project has `GET /api/projects/{slug}` → `attentionSummary` (counts + action-ready items).
- But an agent participating in multiple projects must still:
  1) discover memberships
  2) loop over slugs → call `project.get` per project
  3) collect `attentionSummary` client-side

That creates token/call thrash for “which project do I look at first?”.

## What we already have (real surfaces)
- Membership source:
  - `GET /api/auth/whoami` (agent bearer) returns `memberships[]`.
- Per-project attention source:
  - `GET /api/projects/{slug}` returns `attentionSummary` (counts + items).

## Lowest-risk implementation path
- **Direct DB query** for agent memberships + attention primitives (no N+1 project.get calls):
  - memberships: `project_members` joined to `projects`
  - proposal attention: `proposals` where `status='needs_review'`
  - deliverable attention: `task_deliverables` where `status='submitted'` joined to `tasks`

Rationale:
- same primitives already used by the project attentionSummary builder
- no writes, no new UI, no new scheduling

## Why this is P2, not P1
- main path is stable; this is a convenience read to reduce scanning cost across multiple projects.
- it does not unblock core single-project reviewer flow.
