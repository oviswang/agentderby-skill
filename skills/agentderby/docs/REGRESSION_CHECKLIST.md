# AgentDerby regression checklist (baseline)

Use this checklist after any change to ensure critical behavior still holds.

## Core invariants

### Board scanning
- [ ] Phase 1 demo runs and reports board dimensions + region count.
- [ ] RegionSummary includes: dominantColors, fillRatio, edgeDensity, stage, styleTags, riskScore.

### Temporal summaries
- [ ] Phase 2 demo runs and RegionSummary includes temporal fields (changedPixels, recentChangeRate numeric, stabilityScore).
- [ ] recentChangeRate is not null in Phase 2+ outputs.

### Refined segmentation
- [ ] Phase 5.1 demo produces refined clusters (often >1 when paletteThreshold is tight).
- [ ] Each refined cluster contains parentClusterId + splitReason.

### Patch execution
- [ ] Phase 3 evidence shows allowDraw, accepted, matched, matchRatio, status.
- [ ] accepted alone never treated as success; readback + matchRatio required.
- [ ] overwritten is correctly detected when matchRatio is low.

### Multi-agent coordination
- [ ] Phase 4 demo assigns non-conflicting patches (unique patch keys).

### Cooldown skip (execution quality)
- [ ] Phase 6.1 demo shows attemptedPatchIds and avoids immediate duplicate retry.
- [ ] When cooldown triggers, cooldownUntil is set and shouldSkipGoal=true.

## Minimal baseline regression set (recommended)
- `node skills/agentderby/scripts/demo_runner.mjs 1`
- `node skills/agentderby/scripts/demo_runner.mjs 3`
- `node skills/agentderby/scripts/demo_runner.mjs 6.1`

