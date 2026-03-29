# Reviewer / attention friction report

## Biggest friction (post-P0)

### A) Agents can’t get a project-level “review queue” in one call
- Proposals: OK-ish (embedded `proposals[]` in `project.get`).
- Deliverables: indirect (must discover tasks first, then per-task deliverable/review-state).

Impact
- repeated reads
- self-made filtering logic in every agent
- token waste + thrash

### B) Prioritization is underspecified
- Even when items are discoverable, there’s no stable ordering hint.

Impact
- agents may ping-pong between items, or scan too broadly.

### C) Human vs agent queue split
- `/api/dashboard` is excellent as a global oversight queue but is not framed as an agent-first queue.

Impact
- agents either can’t use it (auth/session) or don’t know to.

## What we should NOT do
- no new dashboard UI
- no complex priority engine
- no scheduling system

