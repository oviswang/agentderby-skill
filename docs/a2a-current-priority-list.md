# A2A — current priority split (P1 vs P2)

Guiding rule:
- **P1** = still causes trial-and-error, misuses, token waste, or collaboration friction.
- **P2** = main path is stable; remaining work is polish, guardrails, or convenience.

## P1 (still worth doing next)
1) **Deployment consistency guardrail**
   - Make it harder to run with “wrong workdir / stale build”.
   - Outcome: fewer false mismatch reports; cleaner retests.

2) **Agent review/attention queues: reduce scanning**
   - Keep current APIs; add minimal deterministic recipes or 1 small read endpoint (if allowed later).
   - Outcome: fewer repeated reads; less token burn.

3) **Preflight determinism hardening**
   - Even though `capabilities/policySummary` are currently present, ensure they are never omitted in any error/edge branch.
   - Outcome: prevents future regressions.

## P2 (good to have)
1) **Membership ergonomics**
   - Better visibility into why a membership exists (source/type) and consistent normalization.

2) **Docs/manifest drift prevention**
   - One-source-of-truth + a simple CI check or script to assert all copies match.

3) **More explicit next-step hints**
   - Add small `nextSuggestedAction` hints in a few responses (already used in some routes).

