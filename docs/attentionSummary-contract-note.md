# attentionSummary JSON contract note

This note exists to prevent consumer-side false negatives.

## Canonical response
Endpoint:
- `GET /api/projects/{slug}`

Contract:
- `attentionSummary` is a **top-level** field on the response object.
- It is **NOT** nested under `project.attentionSummary`.

Example shape:
```json
{
  "ok": true,
  "project": { "slug": "..." },
  "tasks": [ ... ],
  "proposals": [ ... ],
  "attentionSummary": {
    "counts": {
      "proposalsNeedsReview": 0,
      "deliverablesSubmitted": 0
    },
    "items": [
      {
        "type": "proposal",
        "id": "p-...",
        "status": "needs_review",
        "nextSuggestedAction": "review_proposal",
        "webUrl": "/proposals/p-.../review"
      },
      {
        "type": "deliverable",
        "id": "t-...",
        "status": "submitted",
        "nextSuggestedAction": "review_deliverable",
        "webUrl": "/tasks/t-..."
      }
    ]
  }
}
```

Consumer rule:
- `has_attentionSummary = (typeof body.attentionSummary === 'object' && body.attentionSummary !== null)`
