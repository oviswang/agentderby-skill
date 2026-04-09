import { TemporalRegionHistory } from "../phase1/temporal.js";
import { fetchBoardSnapshot } from "../client/board.js";
import { coarseAndRefined } from "../phase5/refine.js";
import { goalsForClusters, frontierPatchesForGoal } from "../phase5/artwork.js";
import { executePatchPlan } from "../phase3/executor.js";

export function initArtworkExecutionState({ clusterId, goalType }) {
  return {
    clusterId,
    goalType,
    status: "active",
    totalFrontierPatchesTried: 0,
    totalPatchesSucceeded: 0,
    totalPatchesOverwritten: 0,
    progressScore: 0,
    lastPatchId: null,
  };
}

export function updateArtworkState(state, patchResult) {
  const s = { ...state };
  s.totalFrontierPatchesTried += 1;
  s.lastPatchId = patchResult.patchId;

  if (patchResult.status === "success") {
    s.totalPatchesSucceeded += 1;
    s.progressScore += 1.0;
  } else if (patchResult.status === "overwritten") {
    s.totalPatchesOverwritten += 1;
    s.progressScore -= 0.2;
  } else if (patchResult.status === "partial") {
    s.progressScore += 0.3;
  } else {
    s.progressScore -= 0.1;
  }

  // completion / blocking
  if (s.totalPatchesSucceeded >= 2) s.status = "completed";
  if (s.totalPatchesOverwritten >= 3 && s.totalPatchesSucceeded === 0) s.status = "blocked";
  if (s.totalFrontierPatchesTried >= 5 && s.totalPatchesSucceeded === 0 && s.progressScore < 0) s.status = "abandoned";

  return s;
}

export async function runArtworkExecutionLoop({ baseUrl, boardWsUrl, paletteThreshold = 20, maxAttempts = 3 }) {
  // build refined clusters from live board
  const hist = new TemporalRegionHistory({ regionSize: 32, maxFrames: 2 });
  const s1 = await fetchBoardSnapshot({ baseUrl });
  hist.addFrameFromPng({ pngBytes: s1.bytes, ts: Date.now() });
  await new Promise((r) => setTimeout(r, 1200));
  const s2 = await fetchBoardSnapshot({ baseUrl });
  hist.addFrameFromPng({ pngBytes: s2.bytes, ts: Date.now() });

  const regionSummaries = hist.computeTemporalSummaries();
  const { refined } = coarseAndRefined({ regionSummaries, paletteThreshold });
  const refinedEligible = refined.filter((c) => (c.regionIds?.length || 0) >= 2);

  // pick a real goal: highest priority among refined clusters
  const goals = goalsForClusters({ clusters: refinedEligible });
  const goal = goals[0];
  const state0 = initArtworkExecutionState({ clusterId: goal.clusterId, goalType: goal.goalType });

  // frontier patches for this goal
  const frontier = frontierPatchesForGoal({ goal, clusters: refinedEligible, regionSummaries });

  // ensure enough frontier patches for demo: if frontier list is short, add centered patches from next high-risk regions
  const cluster = refinedEligible.find((c) => c.clusterId === goal.clusterId);
  const inCluster = cluster ? regionSummaries.filter((r) => cluster.regionIds.includes(r.regionId)) : [];
  inCluster.sort((a,b)=>(b.riskScore??0)-(a.riskScore??0));
  const extraFrontier = [];
  for (const r of inCluster.slice(0, 10)) {
    const pid = `${r.regionId}_frontX`;
    if (frontier.find((p)=>p.patchId===pid) || extraFrontier.find((p)=>p.patchId===pid)) continue;
    extraFrontier.push({
      patchId: pid,
      regionId: r.regionId,
      x: r.x + 8,
      y: r.y + 8,
      w: 16,
      h: 16,
      actionType: goal.goalType === "repair" ? "repair" : "fill",
      frontierType: "damaged_hotspot",
      reason: [`cluster=${goal.clusterId}`, `goal=${goal.goalType}`, `frontierType=damaged_hotspot`, `regionRisk=${(r.riskScore??0).toFixed(2)}`],
    });
    if (frontier.length + extraFrontier.length >= maxAttempts) break;
  }
  const frontierAll = [...frontier, ...extraFrontier];

  const trace = [];
  let state = state0;

  for (let i = 0; i < Math.min(maxAttempts, frontierAll.length); i++) {
    if (state.status !== "active") break;

    const p = frontierAll[i];
    const res = await executePatchPlan({ baseUrl, boardWsUrl, patchPlan: { ...p, clusterId: goal.clusterId }, color: "#ffffff", chunkSize: 50 });

    const attempt = {
      patchId: res.patchId,
      clusterId: goal.clusterId,
      x: res.x,
      y: res.y,
      w: res.w,
      h: res.h,
      actionType: p.actionType,
      accepted: res.accepted,
      matched: res.matched,
      matchRatio: res.matchRatio,
      status: res.status,
      overwritten: res.overwritten,
    };
    trace.push({ attempt, stateBefore: state, stateAfter: null });

    state = updateArtworkState(state, res);
    trace[trace.length - 1].stateAfter = state;

    // decision logic demonstration
    if (state.status === "blocked" || state.status === "abandoned" || state.status === "completed") break;
  }

  return {
    baseUrl,
    boardWsUrl,
    paletteThreshold,
    chosenGoal: goal,
    initialState: state0,
    attempts: trace,
    finalState: state,
  };
}
