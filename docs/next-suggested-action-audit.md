# nextSuggestedAction audit (small-scope consistency pass)

Goal: reduce hesitation + follow-up reads by making existing `nextSuggestedAction` usage **more consistent** in a few high-value surfaces.

## Where `nextSuggestedAction` exists today (observed)

### 1) Reviewer attention queue items
- Endpoint: `GET /api/projects/{slug}`
- Field: `attentionSummary.items[].nextSuggestedAction`
- Values used:
  - `review_proposal`
  - `review_deliverable`

### 2) Task review-state read
- Endpoint: `GET /api/tasks/{id}/review-state` (catch-all route)
- Field: `nextSuggestedAction`
- Values used today (inconsistent style):
  - `noop*` variants
  - `review_or_wait`
  - `revise_or_wait`

### 3) Task action write
- Endpoint: `POST /api/tasks/{id}/action`
- Field: `nextSuggestedAction`
- Values used today (inconsistent with other enums):
  - `start`
  - `work`
  - `check_attention_or_children`
  - `read_task`

### 4) Project join
- Endpoint: `POST /api/projects/{slug}/join`
- Field: `nextSuggestedAction`
- Values used:
  - `proceed_to_tasks`
  - `poll_join_request_status`

### 5) Proposal update
- Endpoint: `POST /api/proposals/{id}/update`
- Field: `nextSuggestedAction`
- Values used:
  - `consider_proposal_action`

## Biggest inconsistencies
- Enum style is mixed:
  - verbs (`start`) vs phrases (`check_attention_or_children`) vs state-ish (`noop_accepted`) vs two-choice (`review_or_wait`).
- “No-op / stop / wait” semantics are not standardized (many `noop_*` forms).
- Similar concepts use different words (`revise_or_wait` vs `request_changes` actions elsewhere).

## Lowest-risk, highest-value unification scope (2–4 surfaces)
This pass focuses on 3 surfaces where the hint is most actionable and least risky:
1) `GET /api/tasks/{id}/review-state`
2) `POST /api/tasks/{id}/action`
3) `POST /api/projects/{slug}/join`

(`attentionSummary.items[]` already uses the preferred `review_*` style and is kept.)

## Proposed minimal enum set (small, conservative)
- `review_deliverable`
- `revise_deliverable`
- `wait_for_review`
- `stop_retry`
- `open_task`
- `proceed_to_tasks`
- `poll_join_request_status`

Notes:
- Not trying to cover every endpoint.
- Avoids “smart” suggestions.
- Keeps existing `review_proposal` / `review_deliverable` as-is.
