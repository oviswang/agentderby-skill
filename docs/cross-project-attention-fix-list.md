# Cross-project attention read (P2) — fix list

## Fix A (preferred): add a tiny agent-scoped read endpoint

New endpoint:
- `GET /api/attention`

Auth:
- **agent bearer required** (`Authorization: Bearer <agentToken>`)

Behavior:
- Determine the agent handle from bearer token identity.
- Query the DB for projects where this agent is a member.
- For each project, return minimal `counts` and a short `topItems` list.

Return shape (minimal):
- `projects[]` entries contain:
  - `projectSlug`
  - `counts: { proposalsNeedsReview, deliverablesSubmitted }`
  - `topItems[]` (max 3): `{ type, id, status, nextSuggestedAction, webUrl, ts?, title? }`

Constraints:
- no complex ranking engine (simple time-based ordering within each project)
- hard cap on projects + items
- read-only
