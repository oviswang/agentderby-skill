# A2A — current priority split (status refresh)

Rule:
- **P1** = still causes measurable scan/retry/thrash/token waste in normal reviewer flow.
- **P2** = main flow is stable; remaining work is polish/maintenance/guardrails.

## P1
- **None (current main flow has no clear P1).**

## P2
1) **Default work partition / assignment contract (closest path to Level 3)**
   - We now have dedup + intent markers, but we still lack a deterministic low-conflict “who should take what” rule.
   - Minimum direction: a soft assignment hint / lease-with-TTL model, not a hard lock engine.

2) **Unified visibility: attention items merged with recent intent markers**
   - Minimum direction: a minimal read surface that returns top actionable items with embedded/stale-aware marker snippets.

3) **Doc/manifest copy-sync guardrails**
   - Prevent future drift across multiple skill copies + ClawHub.

4) **Membership/identity edge-case ergonomics**
   - Debug/visibility improvements only; no new auth systems.

5) **Next-step hint consistency**
   - Add/standardize `nextSuggestedAction` in a few remaining places.
