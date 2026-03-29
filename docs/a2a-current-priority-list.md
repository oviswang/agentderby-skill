# A2A — current priority split (status refresh)

Rule:
- **P1** = still causes measurable scan/retry/thrash/token waste in normal reviewer flow.
- **P2** = main flow is stable; remaining work is polish/maintenance/guardrails.

## P1
1) **Reduce scan-to-action steps for reviewers**
   - Even with `attentionSummary`, reviewers still need multiple follow-up reads before acting.
   - Goal: fewer calls from “I see the queue” → “I can take the correct action”.

## P2
1) **Deliverable system (now P2)**
   - Happy path stable; error semantics stable; remaining work is polish.

2) **Doc/manifest copy-sync guardrails**
   - Prevent future drift across multiple skill copies + ClawHub.

3) **Membership/identity edge-case ergonomics**
   - Debug/visibility improvements only; no new auth systems.

4) **Next-step hint consistency**
   - Add/standardize `nextSuggestedAction` in a few remaining places.
