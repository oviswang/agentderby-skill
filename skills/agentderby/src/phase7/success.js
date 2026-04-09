import { TemporalRegionHistory } from "../phase1/temporal.js";
import { fetchBoardSnapshot } from "../client/board.js";
import { coarseAndRefined } from "../phase5/refine.js";
import { goalsForClusters } from "../phase5/artwork.js";
import { patchPlansFromCandidateActions, candidateActionsForProfile } from "../phase1/actions.js";
import { executePatchPlan } from "../phase3/executor.js";

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function initArtworkSuccessState({ clusterId, goalType }) {
  return {
    clusterId,
    goalType,
    visibleSuccessCount: 0,
    probeSuccessCount: 0,
    survivabilityAdjustedProgress: 0,
    overwriteHotspots: [], // [{x,y,ts}]
    attemptedPatchIds: [],
  };
}

export function survivabilityScoreFrontier({ region, patch, state, expectedGain }) {
  const reasons = [];
  const risk = region.riskScore ?? 1;
  const rcr = region.temporal?.recentChangeRate ?? 0.02;
  const stab = region.temporal?.stabilityScore ?? 0.5;

  let hotspotPenalty = 0;
  if (state.overwriteHotspots.length) {
    const d = Math.min(...state.overwriteHotspots.map((h) => manhattan({ x: patch.x, y: patch.y }, h)));
    hotspotPenalty = clamp01(1 - Math.min(1, d / 256));
    reasons.push(`distToHotspot=${d}`);
  }

  const survivability = clamp01(
    (1 - risk) * 0.35 + (1 - clamp01(rcr / 0.05)) * 0.25 + stab * 0.3 + (1 - hotspotPenalty) * 0.1
  );

  reasons.push(`risk=${risk.toFixed(2)}`);
  reasons.push(`rcr=${rcr.toFixed(4)}/s`);
  reasons.push(`stability=${stab.toFixed(2)}`);
  reasons.push(`expectedGain=${expectedGain.toFixed(2)}`);

  const combined = clamp01(expectedGain * 0.4 + survivability * 0.6);
  return { expectedGain, survivabilityScore: survivability, combinedScore: combined, reasons };
}

export function adaptivePatchSize({ survivabilityScore, riskScore }) {
  if (riskScore >= 0.85 || survivabilityScore < 0.25) return { size: 8, reason: "high_risk_or_low_survivability" };
  if (riskScore >= 0.6 || survivabilityScore < 0.55) return { size: 16, reason: "medium_risk" };
  return { size: 24, reason: "lower_risk" };
}

export async function phase7aDemo({ baseUrl, boardWsUrl, paletteThreshold = 20 }) {
  const hist = new TemporalRegionHistory({ regionSize: 32, maxFrames: 2 });
  const s1 = await fetchBoardSnapshot({ baseUrl });
  hist.addFrameFromPng({ pngBytes: s1.bytes, ts: Date.now() });
  await new Promise((r) => setTimeout(r, 1200));
  const s2 = await fetchBoardSnapshot({ baseUrl });
  hist.addFrameFromPng({ pngBytes: s2.bytes, ts: Date.now() });

  const regionSummaries = hist.computeTemporalSummaries();
  const { refined } = coarseAndRefined({ regionSummaries, paletteThreshold });
  const refinedEligible = refined.filter((c) => (c.regionIds?.length || 0) >= 2);
  const goal = goalsForClusters({ clusters: refinedEligible })[0];

  const agentId = goal.goalType === "repair" ? "wave-restorer" : "starry-finisher";
  const actions = candidateActionsForProfile({ regionSummaries, profileId: agentId, topN: 8 });
  const plans = patchPlansFromCandidateActions({ candidateActions: actions, maxPlans: 6 }).map((p, i) => ({
    ...p,
    regionId: actions[i]?.regionId,
    frontierType: goal.goalType === "repair" ? "damaged_hotspot" : "expansion_boundary",
  }));

  const state = initArtworkSuccessState({ clusterId: goal.clusterId, goalType: goal.goalType });
  const regionById = new Map(regionSummaries.map((r) => [r.regionId, r]));

  const scored = plans
    .filter((p) => p.regionId && regionById.has(p.regionId))
    .map((p) => {
      const region = regionById.get(p.regionId);
      const expectedGain = goal.goalType === "repair" ? 0.35 : 0.2;
      const s = survivabilityScoreFrontier({ region, patch: p, state, expectedGain });
      return { patch: p, region, ...s };
    })
    .sort((a, b) => b.combinedScore - a.combinedScore);

  const picked = scored[0];
  const sizePick = adaptivePatchSize({ survivabilityScore: picked.survivabilityScore, riskScore: picked.region.riskScore ?? 1 });

  const highRisk = (picked.region.riskScore ?? 1) >= 0.85 || picked.survivabilityScore < 0.25;
  const probeSize = 8;
  const fullSize = sizePick.size;
  const basePatch = picked.patch;

  const makePatch = (sz, suffix) => ({
    patchId: `${basePatch.patchId}_${suffix}`,
    regionId: basePatch.regionId,
    x: basePatch.x,
    y: basePatch.y,
    w: sz,
    h: sz,
    actionType: basePatch.actionType,
  });

  const execution = [];
  let decision = null;

  if (highRisk) {
    const probePatch = makePatch(probeSize, "probe");
    const probeRes = await executePatchPlan({ baseUrl, boardWsUrl, patchPlan: probePatch, color: "#ffffff", chunkSize: 50 });
    execution.push({ kind: "probe", patch: probePatch, result: probeRes });

    const probeVisible = probeRes.status === "success" || (probeRes.status === "partial" && probeRes.matchRatio >= 0.7);
    if (probeVisible) {
      const fullPatch = makePatch(fullSize, "full");
      const fullRes = await executePatchPlan({ baseUrl, boardWsUrl, patchPlan: fullPatch, color: "#ffffff", chunkSize: 50 });
      execution.push({ kind: "full", patch: fullPatch, result: fullRes });
      decision = "probe_succeeded_continue_full";
    } else {
      decision = "probe_failed_relocate_or_skip";
    }
  } else {
    const fullPatch = makePatch(fullSize, "full");
    const fullRes = await executePatchPlan({ baseUrl, boardWsUrl, patchPlan: fullPatch, color: "#ffffff", chunkSize: 50 });
    execution.push({ kind: "full", patch: fullPatch, result: fullRes });
    decision = "direct_full";
  }

  for (const e of execution) {
    const r = e.result;
    const visible = (r.matchRatio ?? 0) >= 0.7;
    if (e.kind === "probe" && visible) state.probeSuccessCount += 1;
    if (visible) state.visibleSuccessCount += 1;
    state.survivabilityAdjustedProgress += picked.survivabilityScore * (r.matchRatio ?? 0);
    state.attemptedPatchIds.push(r.patchId);
    if (r.status === "overwritten") state.overwriteHotspots.push({ x: r.x, y: r.y, ts: Date.now() });
  }

  return {
    baseUrl,
    boardWsUrl,
    chosenGoal: goal,
    agentId,
    frontierScoringSample: {
      patchId: picked.patch.patchId,
      regionId: picked.patch.regionId,
      expectedGain: picked.expectedGain,
      survivabilityScore: picked.survivabilityScore,
      combinedScore: picked.combinedScore,
      reasons: picked.reasons,
    },
    adaptiveSizing: {
      selectedSize: fullSize,
      reason: sizePick.reason,
      highRisk,
    },
    probeBeforeCommit: {
      enabled: highRisk,
      probeSize,
      decision,
    },
    execution: execution.map((e) => ({
      kind: e.kind,
      patch: e.patch,
      accepted: e.result.accepted,
      matched: e.result.matched,
      matchRatio: e.result.matchRatio,
      status: e.result.status,
      overwritten: e.result.overwritten,
    })),
    artworkSuccessState: state,
  };
}
