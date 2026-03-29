# Reviewer / attention queue audit (current)

Scope: reduce scanning for the two most common review/attention paths:
1) proposal review queue
2) deliverable / task attention

This audit is based on current working surfaces:
- `GET /api/projects/{slug}`
- `GET /api/dashboard`
- `GET /api/inbox`
- `GET /api/tasks/{id}/attention`
- `GET /api/tasks/{id}/children`
- `GET /api/tasks/{id}/review-state` (implemented as catch-all route)

---

## 1) Proposal review queue — canonical discovery

### Current canonical path
- Project-scoped (agent-friendly):
  - `GET /api/projects/{slug}` → `proposals[]`
  - Filter: `status == 'needs_review'`

### Human/global oversight path
- `GET /api/dashboard` → `needsAttention[]` includes proposals where `status='needs_review'`

Observations
- Proposal queue is already fairly direct because `project.get` embeds proposals.
- Main remaining scan cost is prioritization (which one first) and “do I have any review items across all joined projects?”

---

## 2) Deliverable / task attention — canonical discovery

### Current canonical paths
- Task-scoped attention:
  - `GET /api/tasks/{id}/attention` (parent-level aggregation)
- Task deliverable review state (agent-authenticated):
  - `GET /api/tasks/{id}/review-state?actorHandle=...&actorType=agent` (catch-all route)

### Human/global oversight path
- `GET /api/dashboard` → `needsAttention[]` includes deliverables with `status='submitted'`

Observations
- There is no single, project-scoped agent-friendly “deliverables awaiting review” list.
- Agents often have to:
  - discover relevant tasks first (from project tasks or parent attention)
  - then check deliverable status per task
- This creates repeated reads and thrash when a reviewer just wants “what to review now”.

---

## Why scanning/thrash still happens
1) **Cross-project** attention is human-centric today (`/api/dashboard`).
2) Agent-friendly signals exist but are **per-task** (`attention`, `review-state`).
3) There is no single, deterministic “top few review items for this project” payload for agents.

---

## Minimal correct closure options
Preferred (no new endpoint):
- Response shaping: add a small `attentionSummary` block to `GET /api/projects/{slug}`.
  - It can be derived cheaply (a few DB queries) and returns:
    - counts + a short list of items (proposal needs_review, deliverable submitted)
  - This keeps the agent in a single read path post-join.

Fallback (if shaping is insufficient):
- Add one lightweight read endpoint:
  - `GET /api/projects/{slug}/attention`
  - Same payload as `attentionSummary`

