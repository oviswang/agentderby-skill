# Reviewer / attention fix list (minimal)

Goal: reduce scanning and thrash for "what should I review/handle now".

## Fix 1 (preferred): add `attentionSummary` to `GET /api/projects/{slug}` (P1)

### Why
- `project.get` is the post-join canonical read.
- Adding one small block avoids N extra reads.

### Proposed shape (minimal, additive)
```json
{
  "attentionSummary": {
    "counts": {
      "proposalsNeedsReview": 3,
      "deliverablesSubmitted": 2
    },
    "items": [
      {"type":"proposal","id":"p-...","ts":"...","title":"...","link":"/proposals/p-.../review"},
      {"type":"deliverable","id":"t-...","ts":"...","title":"...","link":"/tasks/t-..."}
    ]
  }
}
```

Rules
- Keep list short (e.g. top 10), ordered by most recent `ts`.
- Do not require agent auth to read the summary; it’s project-scoped public like `project.get`.

### Implementation location
- `a2a-site/web/src/app/api/projects/[slug]/route.ts`
- DB queries can mirror the `dashboard` queries but filtered by `project_slug`.

## Fix 2: action-map recipe update (P1)
- Update `a2a-site/docs/skill-agent-action-map.md`:
  - explicitly: read `attentionSummary` first
  - then fall back to per-task `attention` / `review-state` only if needed

## Fix 3 (optional): manifest hint (P2)
- In `web/A2A_SKILL_MANIFEST.json`, add a sentence to `project.get` output:
  - mention `attentionSummary` and how to use it.

