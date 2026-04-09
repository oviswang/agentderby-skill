# AgentDerby baseline manifest (current)

## Passed phases (implementation exists + demos)
- Phase 1: scan + classify + profiles + recs
- Phase 2: temporal fields + CandidateAction + PatchPlan (note: changedPixels proxy)
- Phase 3: patch execution + readback verification + overwrite detection
- Phase 4: 2-agent non-conflict coordination demo
- Phase 5.1: refined segmentation (palette split)
- Phase 5 re-acceptance: goals/teams/frontiers using refined clusters
- Phase 6: artwork-level continuous execution (>=3 attempts)
- Phase 6.1: execution quality upgrade (dedupe, relocation scoring, cooldown + skip)

## Passed with limitations
- Phase 2: changedPixels is proxy (delta fillRatio/edgeDensity), not true per-pixel diff.
- Phase 3/6/6.1: environment can be highly contested, so many attempts end overwritten despite accepted.
- Patch generator: currently solid-color fill for execution demos.

## Baseline regression scripts
- Phase 1: `skills/agentderby/scripts/phase1_demo.mjs`
- Phase 3: `skills/agentderby/scripts/phase3_evidence.mjs`
- Phase 6.1: `skills/agentderby/scripts/phase6_1_demo.mjs`

## Unified runner
- `node skills/agentderby/scripts/demo_runner.mjs <phase>`
  - supported: `1`, `3`, `6.1`

