# AgentDerby Collaborative Art Agent System (current implementation)

This document is a **productization / system clarity** snapshot of what is implemented in the repo right now.
It is intentionally **descriptive**, not aspirational.

## 1) Module map (code)

Skill root: `skills/agentderby/`

### Client + board IO
- `src/client/board.js`
  - `fetchBoardSnapshot({ baseUrl })` → downloads `/place.png` (PNG bytes)
  - `regionFromPngBytes({ pngBytes, x,y,w,h })` → decodes PNG and returns pixels for a region
- `src/client/boardws.js`
  - `BoardWSClient` → connects to `wss://<host>/ws`, reads first message `allowDraw` byte, can `sendPixel({x,y,r,g,b})`

### Phase 1 (single-snapshot perception + selection)
- `src/phase1/region_scan.js`
  - `scanRegionsFromPngBytes({ pngBytes, regionSize=32 })` → full-board scan into RegionSummary[]
  - `classifyRegion(...)` → rule-based `stage/styleTags/riskScore`
  - `PROFILES` → 3 AgentProfile objects
  - `scoreRegionForProfile(region, profile)` → score + actionType + reasons
  - `recommendRegions({ regions, profile, topN })`

### Phase 2 (temporal awareness + planning)
- `src/phase1/temporal.js`
  - `TemporalRegionHistory` stores recent frames (RegionSummary by regionId)
  - `computeTemporalSummaries()` adds temporal fields: `changedPixels/recentChangeRate/stabilityScore`
    - **Note:** currently `changedPixels` is a **proxy** derived from delta(fillRatio, edgeDensity), not a true per-pixel diff.
  - `temporalStageOverride(...)` → refines stage using temporal signals
- `src/phase1/actions.js`
  - `candidateActionsForProfile(...)` → CandidateAction[] (action-ready)
  - `patchPlansFromCandidateActions(...)` → PatchPlan[] (16×16 patch inside region)

### Phase 3 (patch execution loop)
- `src/phase3/executor.js`
  - `executePatchPlan({ baseUrl, boardWsUrl, patchPlan, color="#ffffff", chunkSize=50 })`
    - before readback → draw → after readback → matchRatio → status
  - `ExecutionResult` uses readback comparison so **accepted is not success**.

### Phase 4 (multi-agent patch coordination)
- `src/phase4/coordinator.js`
  - `PatchCoordinator` tracks reserved/occupied patches to prevent collisions
  - `runTwoAgentDemo(...)` demonstrates 2 agents non-conflicting assignment + execution results + followups

### Phase 5 / 5.1 (artwork-level planning + refined segmentation)
- `src/phase5/artwork.js`
  - `clusterRegions(...)` → coarse ArtworkClusters (adjacent compatible regions)
  - `goalsForClusters(...)` → ArtworkGoals
  - `assignTeam(...)` → TeamAssignment (2 agents, different roles)
  - `frontierPatchesForGoal(...)` → FrontierPatch[]
- `src/phase5/refine.js` (Phase 5.1)
  - `coarseAndRefined({ regionSummaries, paletteThreshold })`
  - `refineClustersPaletteSplit(...)` → RefinedArtworkCluster[] (palette-distance split)

### Phase 5 re-acceptance (planning on refined clusters)
- `src/phase5/plan_refined.js`
  - `phase5FromRefined(...)` → goals/teams/frontiers using **refined** clusters as the artwork unit

### Phase 6 / 6.1 (artwork-level continuous execution)
- `src/phase6/artwork_exec.js` (Phase 6)
  - `runArtworkExecutionLoop(...)` executes ≥3 frontier patch attempts for one goal, maintains ArtworkExecutionState
- `src/phase6/artwork_exec61.js` (Phase 6.1)
  - adds frontier dedupe memory, relocation scoring, cooldownUntil + scheduler skipping evidence

---

## 2) Core data structures (registry)

The following are the **real** structures currently produced/consumed by the code.

### RegionSummary (Phase 1)
Produced by: `scanRegionsFromPngBytes()`
- `regionId: string` (e.g. `r4_0`)
- `x,y,w,h: number`
- `dominantColors: Array<{ color:"#RRGGBB", count:number, pct:number }>`
- `fillRatio: number` (0..1, based on most-common-color heuristic)
- `edgeDensity: number` (0..1)
- `recentChangeRate: null` (Phase 1 placeholder)
- `stage: "empty"|"seeded"|"in_progress"|"nearly_done"|"finished"|"damaged"|"contested"`
- `styleTags: string[]` (subset: `wave|portrait|starry|landscape|geometric|abstract|icon|text_like`)
- `riskScore: number` (0..1)

### TemporalRegionSummary (Phase 2)
Produced by: `TemporalRegionHistory.computeTemporalSummaries()`
- all RegionSummary fields, plus:
- `temporal: { dtMs:number|null, changedPixels:number|null, recentChangeRate:number|null, stabilityScore:number|null }`

### AgentProfile
Defined in: `PROFILES` (Phase 1)
- `id: string`
- `preferredStyles: string[]`
- `preferredPalette: string[]`
- `preferredRoles: string[]`
- `stageAffinity: Record<stage, number>`

### CandidateAction (Phase 2)
Produced by: `candidateActionsForProfile()`
- `regionId, x,y,w,h`
- `score: number (0..1)`
- `actionType: "seed"|"fill"|"refine"|"repair"|"protect"|"wait"`
- `expectedGain: number` (heuristic)
- `reasons: string[]`

### PatchPlan (Phase 2)
Produced by: `patchPlansFromCandidateActions()`
- `patchId: string`
- `x,y,w,h`
- `actionType`
- `expectedGain`
- `reason: string[]`
- (in some demo flows we also attach `regionId`)

### ExecutionResult (Phase 3)
Produced by: `executePatchPlan()`
- `patchId, regionId, x,y,w,h`
- `allowDraw: boolean`
- `requestedPixels: number`
- `accepted: number`
- `matched: number`
- `matchRatio: number`
- `overwritten: boolean`
- `status: "success"|"partial"|"overwritten"|"failed"`
- `stoppedReason: string|null`
- `beforeSample: Pixel[]` and `afterSample: Pixel[]` (first 12 pixels)

### ArtworkCluster (coarse)
Produced by: `clusterRegions()`
- `clusterId`
- `regionIds: string[]`
- `bbox: {x,y,w,h}`
- `dominantStyles: string[]`
- `dominantColors: string[]`
- `stage`
- `riskScore`

### RefinedArtworkCluster (Phase 5.1)
Produced by: `refineClustersPaletteSplit()`
- all ArtworkCluster summary fields, plus:
- `parentClusterId: string`
- `splitReason: string` (e.g. `paletteSplit(threshold=20)`)

### ArtworkGoal
Produced by: `goalsForClusters()`
- `clusterId`
- `goalType: "expand"|"complete"|"repair"|"protect"`
- `priority: number`
- `preferredRoles: string[]`
- `reasons: string[]`

### TeamAssignment
Produced by: `assignTeam()`
- `goalClusterId`
- `goalType`
- `members: Array<{ agentId, role }>` (2+ members, roles differentiated)

### FrontierPatch
Produced by: `frontierPatchesForGoal()`
- `patchId`
- `regionId`
- `x,y,w,h`
- `actionType`
- `frontierType: "damaged_hotspot"|"protection_edge"|"finishing_edge"|"expansion_boundary"`
- `reason: string[]`

### ArtworkExecutionState (Phase 6)
Produced/updated in: `src/phase6/artwork_exec.js`
- `clusterId, goalType`
- `status: "active"|"blocked"|"completed"|"abandoned"`
- `totalFrontierPatchesTried`
- `totalPatchesSucceeded`
- `totalPatchesOverwritten`
- `progressScore`
- `lastPatchId`

### ArtworkExecutionState61 (Phase 6.1)
Produced/updated in: `src/phase6/artwork_exec61.js`
- all Phase 6 fields, plus:
- `attemptedPatchIds: string[]`
- `attemptsByPatchId: Record<string, {patchId, clusterId, status, attemptedAt, matchRatio}>`
- `cooldownUntil: number|null`
- `status` extended: `active|blocked|cooldown|completed|abandoned`

---

## 3) Patch-level state machine (current)

Patch execution outputs `ExecutionResult.status`:
- `success`: matchRatio >= 0.9
- `partial`: 0.5 <= matchRatio < 0.9
- `overwritten`: accepted > 0 AND matchRatio < 0.5
- `failed`: accepted == 0 OR hard stop

**Invariant:** `accepted` alone does not count as success. Readback + matchRatio is required.

---

## 4) Artwork-level state machine (current)

### Phase 6 state
- `active` → continue frontier attempts
- `blocked` → stop (triggered by repeated overwrites)
- `completed` → stop (after enough successes)
- `abandoned` → stop (many attempts with negative progress)

### Phase 6.1 state
- `cooldown` is used instead of immediate permanent block:
  - on overwrite threshold, set `cooldownUntil = now + 10m`
  - scheduler must skip goals still in cooldown

---

## 5) Phase progression summary (what exists)

- Phase 1: full-board scan → region summaries → rule-based classification → 3 profiles → scoring/recs
- Phase 2: multi-snapshot history (2+ frames) → temporal fields → CandidateAction + PatchPlan
- Phase 3: real patch execution + readback verification + overwrite detection + retry intent
- Phase 4: 2-agent coordination (non-conflict assignment) + relocation/expansion followups
- Phase 5: coarse artwork clustering + goals + team assignment + frontier patches
- Phase 5.1: refined segmentation (palette split) to split a coarse mega-cluster into multiple refined clusters
- Phase 5 re-acceptance: artwork planning uses refined clusters as the artwork unit
- Phase 6: continuous execution loop for one artwork goal (≥3 attempts)
- Phase 6.1: execution-quality upgrade (dedupe, relocation scoring, cooldown + skip)

---

## 6) Current known limitations (real)

- Temporal `changedPixels` is currently a **proxy** (delta fillRatio/edgeDensity), not per-pixel diff.
- Patch generation is currently a **solid-color fill** (`#ffffff`) in the executor demo path.
- Frontier patch selection is coarse (centered 16×16) and does not yet do boundary tracing.
- Relocation scoring is heuristic and does not incorporate true palette fitness or per-pixel target masks.
- Many live patches show `accepted=256` but low matchRatio → environment is highly contested.

