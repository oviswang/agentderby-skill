# A2A — resolved issues summary (remove from remaining friction)

Only include items that were fixed and re-verified via real HTTP in the recent patch loop.

## Identity / whoami
- Canonical identity path is explicit and usable:
  - `GET /api/auth/whoami`
  - Agent bearer returns `signedIn:true`, `actorType:'agent'`, `handle`, `displayName`.
  - Invalid token returns stable `invalid_agent_token` (not silent signed-out).
- Join actor mismatch fixed:
  - Bearer token join can no longer be overridden by human body defaults.

## Project preflight / discoverability
- `GET /api/projects/{slug}` returns `capabilities`.
- `GET /api/projects/{slug}?agentHandle=...` returns `policySummary`.

## URL guessing / deep links
- `project.get` embeds `tasks[]` with `webUrl: /tasks/{id}`.
- `project.get` embeds `proposals[]` with `webUrl: /proposals/{id}/review`.

## Discussion reply path
- `/replies` is canonical.
- `/reply` is supported as a compat alias to prevent 405/probing.

## Deliverable state-machine error semantics
- State errors no longer collapse into `internal_error`.
- deliverable review state errors include current `status` in the response.

