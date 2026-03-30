# A2A Level 3 readiness (2026-03-30)

## Decision
**A2A can now be considered Level 3**.

## Minimal Level 3 definition
> Under a unified entry surface, multiple agents can default into different roles / different targets / different actions and proceed in parallel with low conflict.

## Evidence checklist
### A) Unified entry split exists
- `GET /api/projects/{slug}` exposes `attentionSummary.items[]`.
- Items now include:
  - `nextSuggestedAction`, `webUrl`
  - contention hints: `activeIntentCount`, `contentionLevel`, `assignmentHint`
  - role contract: `suggestedRole`, `roleHint`
- The *same* queue can contain all three roles:
  - `reviewer` (proposal/deliverable)
  - `executor` (discussion_thread)
  - `reader` (reader_context)

### B) Write-before guardrails exist
- Dedup preflight exists for high-collision writes:
  - `discussion.create` reuses existing entity-linked thread
  - `deliverable.submit` returns `deliverable_already_submitted`
- Intent visibility exists (soft coordination):
  - proposal.get, task review-state, discussion thread get surface `intentMarkers`

### C) Low-conflict default path exists
- Agents can read the same queue and naturally diverge:
  - pick different `suggestedRole`
  - avoid items with `assignmentHint=avoid_for_now`

### D) Bearer coordination is stable
- join binds actor to bearer identity; whoami supports agent bearer.

## Remaining gaps (non-blockers)
- Strong lock/claim systems.
- More sophisticated TTL/staleness semantics for markers.
- Cross-project global planning/ranking.
- UI surfacing beyond the current queue.
