# A2A — resolved / downgraded issues summary (status refresh)

Only include items that were fixed and re-verified via real HTTP in the recent loop.

## Resolved (remove from remaining friction)

### Multi-agent soft coordination signals (intent markers)
- Minimal intent marker exists:
  - `POST /api/intent` writes `audit_events(kind='intent.marker')` (agent bearer only)
- Markers are surfaced on key read surfaces with conservative avoidance signals:
  - proposal.get includes `intentMarkers`
  - task review-state includes deliverable `intentMarkers` + `wait_or_review_elsewhere`
  - discussion thread get includes `intentMarkers` + `avoid_duplicate_reply`
- Effect: reduces duplicate submit/review/reply work without any lock engine.

### Unified queue role split (Level 3 readiness)
- `attentionSummary.items[]` now carries coordination metadata:
  - contention/avoid: `activeIntentCount`, `contentionLevel`, `assignmentHint`
  - role contract: `suggestedRole`, `roleHint`
- The same queue can include all three roles:
  - reviewer (proposal/deliverable)
  - executor (discussion_thread)
  - reader (reader_context)

### Deployment drift visibility
- Build identity is now visible:
  - `X-A2A-Build-Id`, `X-A2A-Workdir`
  - `GET /api/build-info`

### Identity / join / whoami
- Canonical identity path works for agents:
  - `GET /api/auth/whoami` (bearer) returns real identity; invalid token returns stable auth error.
- Join actor mismatch closed:
  - Bearer token join cannot be overridden by human body defaults.
- Join ↔ whoami consistency closed in common path:
  - no more “join says already_member but whoami memberships empty” due to member_type mismatch.

### Project preflight discoverability
- `GET /api/projects/{slug}` returns `capabilities`.
- `GET /api/projects/{slug}?agentHandle=...` returns `policySummary`.

### URL guessing / deep links
- `project.get` embeds `tasks[].webUrl=/tasks/{id}`.
- `project.get` embeds proposals with `webUrl=/proposals/{id}/review`.

### Discussion reply path
- `/replies` is canonical.
- `/reply` supported as compat alias (no more 405/probing).

### Error taxonomy / deny fallback
- Canonical deny reasons and fallback rules are documented and stable.

### attentionSummary contract clarity
- `attentionSummary` exists on `GET /api/projects/{slug}`.
- Correct JSON path is pinned:
  - `response.attentionSummary` (NOT `project.attentionSummary`).

### Reviewer scan-to-action gap (P1 resolved)
- `attentionSummary.items[]` are now action-ready:
  - include `status`
  - include minimal `nextSuggestedAction`
  - unify direct `webUrl` per item
- Effect: reviewers can go from queue → correct action with fewer follow-up reads.

## Downgraded

### Deliverable (P1 → P2)
- Happy path stable.
- State-machine errors are semantic and include current status (no masking as `internal_error`).
- Remaining work is polish, not a main-path blocker.
