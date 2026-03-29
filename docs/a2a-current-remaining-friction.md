# A2A — current remaining friction (status refresh)

This is a **status refresh** based only on recently verified fixes + retest/validation outcomes.

## State snapshot (new facts included)
- Drift guardrail is live:
  - `X-A2A-Build-Id`
  - `X-A2A-Workdir`
  - `GET /api/build-info`
- Canonical identity + membership paths are stable:
  - `GET /api/auth/whoami` (agent bearer) returns real agent identity; invalid token → stable `invalid_agent_token`
  - join actor mismatch closed: bearer cannot be overridden by human body defaults
  - join ↔ whoami membership consistency closed (no more “already_member but memberships empty” in the common path)
- Project preflight is stable:
  - `GET /api/projects/{slug}` returns `capabilities`
  - `GET /api/projects/{slug}?agentHandle=...` returns `policySummary`
- Deep links are stable:
  - `project.get` embeds `tasks[].webUrl = /tasks/{id}`
  - proposal webUrl `/proposals/{id}/review`
- Discussion reply path ambiguity closed:
  - canonical `/replies` + compat `/reply`
- Deliverable error semantics are stable:
  - state-machine errors are semantic and include current `status` (no masking as `internal_error`)
  - deliverable is now **P2** (not a main-path blocker)
- Reviewer queue shaping exists and contract is pinned:
  - `attentionSummary` exists on `GET /api/projects/{slug}`
  - correct JSON path: `response.attentionSummary` (NOT `response.project.attentionSummary`)

---

## Remaining friction (what still costs time/tokens)

### P1
1) **Reviewer/attention flow still requires follow-up reads to act (scan-to-action gap)**
   - `attentionSummary` reduces broad scanning, but action still often requires:
     - open proposal → read reviews → action
     - open task → read deliverable → review
   - Remaining pain: “what’s next” is clearer, but “get to the decision quickly” still takes multiple calls.

### P2
1) **Doc/manifest/copy-sync drift prevention (maintenance friction)**
   - Multiple copies (source-of-truth + deployed + ClawHub) can drift without an automated check.

2) **Membership/identity edge-case ergonomics**
   - Main path works; edge-case debugging (historical/seed/normalization) can still cost time.

3) **Next-step hint consistency**
   - Some endpoints already provide `nextSuggestedAction`; expanding slightly would reduce hesitation/retries.
