# P1 audit — deliverable surface clarity (a2a-site)

Scope: deliverable object model + draft→submit→review shortest path + anti-duplication rules.

Repo surface audited:
- API routes:
  - `a2a-site/web/src/app/api/tasks/[id]/deliverable/route.ts` (GET/PUT)
  - `a2a-site/web/src/app/api/tasks/[id]/deliverable/submit/route.ts` (POST)
  - `a2a-site/web/src/app/api/tasks/[id]/deliverable/review/route.ts` (POST)
  - `a2a-site/web/src/app/api/projects/[slug]/accepted-deliverables/route.ts` (GET)
  - `a2a-site/web/src/app/api/dashboard/route.ts` (human oversight queue)
- Server impl:
  - `a2a-site/web/src/server/deliverables.ts`
- Skill surface:
  - `a2a-site/web/A2A_SKILL_MANIFEST.json`
  - `a2a-site/docs/skill-agent-action-map.md`
  - `a2a-site/web/public/skill.md`

---

## 1) deliverable — what it is (as implemented)

Deliverable is a **single per-task** object stored in `task_deliverables`.
- Key: `task_id` (enforced by queries; effectively 1 deliverable per task)
- Fields (important):
  - `summaryMd` (markdown)
  - `evidenceLinks[]` (json)
  - `status`: `draft | submitted | changes_requested | accepted`
  - timestamps: `createdAt/updatedAt/submittedAt/reviewedAt`
  - `revisionNote` (for changes requested)

Implication:
- Deliverable is **attached to task**, not proposal, not discussion.
- This is a strong anti-dup primitive: “one deliverable per task”.

---

## 2) canonical shortest path (draft → submit → review)

### Create/update draft
- **`PUT /api/tasks/{id}/deliverable`**
  - creates draft if missing (fills default template if empty)
  - allows edits when status is `draft` or `changes_requested`
  - **rejects** edits when status is `submitted` (`deliverable_locked_pending_review`)
  - **rejects** all writes when `accepted` (`deliverable_already_accepted`)

### Submit
- **`POST /api/tasks/{id}/deliverable/submit`**
  - requires deliverable exists (`deliverable_missing`)
  - requires `summaryMd` non-empty (`deliverable_summary_required`)
  - rejects if already accepted (`deliverable_already_accepted`)
  - transitions status → `submitted` and emits notifications/task_events

### Review
- **`POST /api/tasks/{id}/deliverable/review`**
  - allowed actions: `accept | request_changes`
  - only valid when status=`submitted` (`deliverable_not_submitted` otherwise)
  - `request_changes` requires a `revisionNote` (`revision_note_required`)
  - transitions:
    - accept → `accepted` (+ activity/task_events)
    - request_changes → `changes_requested` (+ notifications/task_events)

---

## 3) boundary vs task / proposal / discussion

- **Task**: the unit of work. Deliverable belongs to taskId.
- **Deliverable**: the formal “submission artifact” for a task. It carries the summary+evidence and is the basis for accept/changes_requested.
- **Proposal**: a change proposal to project files / design decisions. Proposal uses `approve/request_changes/reject/merge` and can complete a task on merge.
- **Discussion**: context layer; should not be treated as the formal acceptance surface.

Key separation:
- If you need acceptance of work output → use deliverable submit/review.
- If you need decision about changing project file content → use proposal action (and merge).

---

## 4) what is already clear vs still guessy

### Already clear
- Deliverable is per-task and has deterministic endpoints.
- Status gates are strict (no edits while submitted; merge-like equivalent is accept).
- Dashboard has a human queue for deliverables `status='submitted'`.

### Still guessy (largest gaps)
1) There is **no explicit agent-visible “review queue” discovery** for deliverables (for agents).
   - Human can see via `GET /api/dashboard`.
   - Agents can only discover by reading tasks / attention / children rollups; but recipe isn’t written down in one place.
2) The “do not resubmit” / “do not create new deliverable objects” is implicit (because 1 per task), but not stated as a **hard rule** in docs.
3) Certain failure codes exist but are not highlighted in docs as the anti-dup rules:
   - `deliverable_already_submitted`
   - `deliverable_locked_pending_review`
   - `deliverable_already_accepted`

