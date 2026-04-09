# AgentDerby demos / acceptance registry (current)

This is the authoritative list of the **implemented** demo/acceptance scripts and what evidence they print.

## Phase 1
- Script: `skills/agentderby/scripts/phase1_demo.mjs`
- Demonstrates:
  - full-board scan (1024 regions at 32×32)
  - RegionSummary samples
  - 3 AgentProfiles
  - top-5 region recommendations per profile
- Evidence must include:
  - RegionSummary fields (dominantColors/fillRatio/edgeDensity/stage/styleTags/riskScore)
  - recommendations per profile
- Does NOT count as success:
  - printing only a file path without output

## Phase 2
- Script: `skills/agentderby/scripts/phase2_demo.mjs`
- Demonstrates:
  - 2 snapshots + temporal fields per region summary
  - temporal classifier rules
  - CandidateAction top-5 per profile
  - PatchPlans top-3 per profile
- Evidence must include:
  - `changedPixels`, `recentChangeRate` (numeric), `stabilityScore`
  - CandidateAction: score/actionType/expectedGain/reasons
  - PatchPlans: patchId/x/y/w/h/actionType
- Does NOT count as success:
  - `recentChangeRate=null`

## Phase 3
- Script: `skills/agentderby/scripts/phase3_evidence.mjs`
- Demonstrates:
  - live WS connect + allowDraw
  - before/after readback
  - matchRatio and overwrite detection
- Evidence must include:
  - allowDraw observed value
  - accepted vs matched vs matchRatio
  - status assignment where accepted alone is NOT success

## Phase 4
- Script: `skills/agentderby/scripts/phase4_demo.mjs`
- Demonstrates:
  - two-agent patch coordination
  - non-conflict assignment (unique patch keys)
  - execution results per agent
  - expansion/relocation followups

## Phase 5.1
- Script: `skills/agentderby/scripts/phase5_1_demo.mjs`
- Demonstrates:
  - coarse clusters
  - refined clusters (palette split)
  - per refined cluster splitReason

## Phase 5 (re-acceptance using refined clusters)
- Script: `skills/agentderby/scripts/phase5_reaccept_demo.mjs`
- Demonstrates:
  - refined clusters used as artwork units
  - ArtworkGoals (>=3)
  - TeamAssignments (>=2)
  - FrontierPatches (>=3)

## Phase 6
- Script: `skills/agentderby/scripts/phase6_demo.mjs`
- Demonstrates:
  - one artwork goal continuous execution
  - >=3 patch attempts
  - readback validation per patch
  - artwork state updates

## Phase 6.1
- Script: `skills/agentderby/scripts/phase6_1_demo.mjs`
- Demonstrates:
  - frontier dedupe (no immediate duplicate)
  - relocation scoring + reasons
  - cooldownUntil and scheduler skip evidence

