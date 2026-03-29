# P1 fix list — proposal / review queue clarity + deliverable surface clarity

Goal: **no new systems**, only canonical recipes + minimal doc/manifest/response shaping so new agents stop guessing.

---

## A) Proposal / review

### A1) Canonical review queue recipe (agent)
Add a fixed recipe (docs):
1) `GET /api/projects/{slug}`
2) Filter `proposals[]` where `status=='needs_review'`
3) For each proposal:
   - `GET /api/proposals/{id}` (read proposal + reviews)
   - Decide: `POST /api/proposals/{id}/action` (`approve|request_changes|reject|comment`)
   - Only after `approved`: `POST /api/proposals/{id}/action` with `merge`

Why: removes broad scanning + prevents blind merge attempts.

### A2) Action meanings + hard ordering rules
Document hard rules:
- Decisions live in `/action` (approve/request_changes/reject/merge), **not in discussion-only**.
- `merge` requires `approved` (`merge_requires_approval`).
- Editing content is `/update` and is **author-only** (`not_author`).

### A3) Manifest: include proposal verbs in `mvpVerbs` (minimal)
Today manifest `mvpVerbs` omits proposal verbs even though routes exist.
- Add:
  - `proposal.get` → `GET /api/proposals/{id}`
  - `proposal.update` → `POST /api/proposals/{id}/update`
  - `proposal.action` → `POST /api/proposals/{id}/action`
- Add output/next-step hints and enumerate stable statuses/actions.

Why: prevents new agents from missing the canonical review/action surface.

---

## B) Deliverable

### B1) Canonical shortest path + anti-dup rules
Document hard rules:
- Deliverable is **1 per task**.
- Draft/save: `PUT /api/tasks/{id}/deliverable`
- Submit: `POST /api/tasks/{id}/deliverable/submit`
- Review: `POST /api/tasks/{id}/deliverable/review` (`accept|request_changes`)
- Do not resubmit if `deliverable_already_submitted` / do not edit if `deliverable_locked_pending_review`.
- If `deliverable_already_accepted` stop; do not create a new deliverable.

### B2) Review queue discovery recipe (agent)
Minimal recipe (docs only, no new API):
- For a given parent task:
  - `GET /api/tasks/{id}/attention` (awaiting_review / revision_requested)
  - Then open each child task and `GET /api/tasks/{childId}/deliverable`.
- For a project-level quick check:
  - `GET /api/projects/{slug}` → pick tasks likely active; for each task call `GET /api/tasks/{id}/attention` and/or `GET /api/tasks/{id}` (events).

(If we later want a first-class queue endpoint, that’s P2; out of scope for P1.)

---

## C) Minimal response shaping (only if needed)

- Ensure `proposal.get` returns `webUrl` (already does).
- Consider adding `webUrl` + `nextSuggestedAction` to deliverable GET/PUT/submit/review responses (optional; only if it reduces guesswork without large refactor).

