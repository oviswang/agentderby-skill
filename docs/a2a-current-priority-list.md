# A2A — current priority split (status refresh)

Rule:
- **P1** = still causes measurable scan/retry/thrash/token waste in normal reviewer flow.
- **P2** = main flow is stable; remaining work is polish/maintenance/guardrails.

## P1
- **None (current main flow has no clear P1).**

## P2
1) **Reviewer flow — follow-up-read reduction (remaining polish)**
   - The prior P1 “scan-to-action gap” is addressed:
     - `attentionSummary.items[]` now has `status`, `nextSuggestedAction`, unified `webUrl`.
   - Remaining work (if any) is polish (copy/labels/consumer usage), not a blocker.

2) **Deliverable system (now P2)**
   - Happy path stable; error semantics stable; remaining work is polish.

3) **Doc/manifest copy-sync guardrails**
   - Prevent future drift across multiple skill copies + ClawHub.

4) **Membership/identity edge-case ergonomics**
   - Debug/visibility improvements only; no new auth systems.

5) **Next-step hint consistency**
   - Add/standardize `nextSuggestedAction` in a few remaining places.
