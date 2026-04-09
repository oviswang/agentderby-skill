import { TemporalRegionHistory } from "../phase1/temporal.js";
import { fetchBoardSnapshot } from "../client/board.js";
import { coarseAndRefined } from "../phase5/refine.js";
import { goalsForClusters, frontierPatchesForGoal } from "../phase5/artwork.js";
import { executePatchPlan } from "../phase3/executor.js";

function patchKey(p) {
  return `${p.x},${p.y},${p.w},${p.h}`;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function initArtworkExecutionState61({ clusterId, goalType }) {
  return {
    clusterId,
    goalType,
    status: "active", // active|blocked|cooldown|completed|abandoned
    totalFrontierPatchesTried: 0,
    totalPatchesSucceeded: 0,
    totalPatchesOverwritten: 0,
    progressScore: 0,
    lastPatchId: null,
    attemptedPatchIds: [], // ordered
    attemptsByPatchId: {}, // patchId -> {clusterId,status,attemptedAt,matchRatio}
    cooldownUntil: null,
  };
}

export function recordAttempt(state, { patchId, clusterId, status, attemptedAt, matchRatio }) {
  const s = { ...state };
  s.attemptedPatchIds = [...s.attemptedPatchIds, patchId];
  s.attemptsByPatchId = { ...s.attemptsByPatchId, [patchId]: { patchId, clusterId, status, attemptedAt, matchRatio } };
  return s;
}

export function isPatchRecentlyAttempted(state, patchId, nowMs, windowMs = 5 * 60 * 1000) {
  const a = state.attemptsByPatchId?.[patchId];
  if (!a) return false;
  return nowMs - a.attemptedAt < windowMs;
}

export function relocationScore({ patch, state, lastPatch, regionRisk = 1, expectedGain = 0.2, nowMs }) {
  const reasons = [];
  let score = 0;

  // prefer not recently attempted
  if (isPatchRecentlyAttempted(state, patch.patchId, nowMs)) {
    score -= 2.0;
    reasons.push("recently_attempted_penalty");
  } else {
    score += 0.5;
    reasons.push("not_recently_attempted");
  }

  // lower risk better
  score += (1 - Math.min(1, regionRisk)) * 0.8;
  reasons.push(`risk=${regionRisk.toFixed(2)}`);

  // expected gain
  score += expectedGain * 0.8;
  reasons.push(`expectedGain=${expectedGain.toFixed(2)}`);

  // farther from last failed patch
  if (lastPatch) {
    const d = manhattan({ x: patch.x, y: patch.y }, { x: lastPatch.x, y: lastPatch.y });
    score += Math.min(1.5, d / 128) * 0.6;
    reasons.push(`distFromLast=${d}`);
  }

  // frontier type preference
  if (patch.frontierType === "damaged_hotspot") {
    score += 0.2;
    reasons.push("frontier=damaged_hotspot");
  }

  return { relocationScore: score, relocationReasons: reasons };
}

export function updateArtworkState61(state, patchResult) {
  let s = { ...state };
  s.totalFrontierPatchesTried += 1;
  s.lastPatchId = patchResult.patchId;

  // richer progress scoring
  if (patchResult.status === "success") {
    s.totalPatchesSucceeded += 1;
    s.progressScore += 1.0;
  } else if (patchResult.status === "partial") {
    s.progressScore += 0.2 + 0.8 * (patchResult.matchRatio ?? 0);
  } else if (patchResult.status === "overwritten") {
    s.totalPatchesOverwritten += 1;
    s.progressScore -= 0.3 + (0.2 * (1 - (patchResult.matchRatio ?? 0)));
  } else {
    s.progressScore -= 0.2;
  }

  // completion / blocking / cooldown
  if (s.totalPatchesSucceeded >= 2) s.status = "completed";

  if (s.totalPatchesOverwritten >= 3 && s.totalPatchesSucceeded === 0) {
    s.status = "cooldown";
    s.cooldownUntil = Date.now() + 10 * 60 * 1000; // 10 min
  }

  if (s.totalFrontierPatchesTried >= 6 && s.totalPatchesSucceeded === 0 && s.progressScore < -1.5) s.status = "abandoned";

  return s;
}

export function shouldSkipGoal(state, nowMs) {
  if (state.status === "cooldown" && state.cooldownUntil && nowMs < state.cooldownUntil) return true;
  return false;
}

export async function runArtworkExecutionLoop61({ baseUrl, boardWsUrl, paletteThreshold = 20, maxAttempts = 3 }) {
  const now0 = Date.now();

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

  const goals = goalsForClusters({ clusters: refinedEligible });
  const goal = goals[0];

  let state = initArtworkExecutionState61({ clusterId: goal.clusterId, goalType: goal.goalType });
  const schedulerEvidence = [];

  // scheduler skipping evidence: simulate a second pass right away
  schedulerEvidence.push({ pass: 1, goalClusterId: goal.clusterId, skipped: shouldSkipGoal(state, Date.now()), status: state.status, cooldownUntil: state.cooldownUntil });

  // build candidate frontier list, then select using relocation scoring + dedupe
  const frontierBase = frontierPatchesForGoal({ goal, clusters: refinedEligible, regionSummaries });

  const inCluster = regionSummaries.filter((r) => refinedEligible.find((c) => c.clusterId === goal.clusterId)?.regionIds.includes(r.regionId));
  const riskByRegion = new Map(inCluster.map((r) => [r.regionId, r.riskScore ?? 1]));

  const frontierAll = [...frontierBase];
  // add extra candidates (different ids) for relocation
  for (const p of frontierBase) {
    frontierAll.push({ ...p, patchId: `${p.patchId}_alt`, x: p.x + 16, frontierType: p.frontierType, reason: [...(p.reason||[]), 'alt=+16x'] });
  }

  const attempts = [];
  let lastPatch = null;

  for (let i = 0; i < maxAttempts; i++) {
    if (state.status !== "active") break;

    // score candidates
    const scored = frontierAll
      .filter((p) => !isPatchRecentlyAttempted(state, p.patchId, Date.now(), 10 * 60 * 1000))
      .map((p) => {
        const regionRisk = riskByRegion.get(p.regionId) ?? 1;
        const expectedGain = goal.goalType === "repair" ? 0.35 : 0.2;
        const sc = relocationScore({ patch: p, state, lastPatch, regionRisk, expectedGain, nowMs: Date.now() });
        return { patch: p, ...sc };
      })
      .sort((a, b) => b.relocationScore - a.relocationScore);

    const picked = scored[0];
    if (!picked) break;

    // ensure no immediate duplicate
    if (state.lastPatchId === picked.patch.patchId) {
      // drop and pick next
      scored.shift();
    }

    const p = picked.patch;
    const exec = await executePatchPlan({ baseUrl, boardWsUrl, patchPlan: { ...p, clusterId: goal.clusterId }, color: "#ffffff", chunkSize: 50 });

    const attempt = {
      patchId: exec.patchId,
      clusterId: goal.clusterId,
      x: exec.x,
      y: exec.y,
      w: exec.w,
      h: exec.h,
      actionType: p.actionType,
      accepted: exec.accepted,
      matched: exec.matched,
      matchRatio: exec.matchRatio,
      status: exec.status,
      overwritten: exec.overwritten,
      relocationCandidate: null,
    };

    // record attempt for dedupe
    state = recordAttempt(state, { patchId: attempt.patchId, clusterId: attempt.clusterId, status: attempt.status, attemptedAt: Date.now(), matchRatio: attempt.matchRatio });

    // if overwritten very low match, compute next relocation candidate evidence
    if (attempt.status === "overwritten" || (attempt.matchRatio ?? 0) < 0.2) {
      const next = scored.find((x) => x.patch.patchId !== attempt.patchId);
      if (next) {
        attempt.relocationCandidate = {
          patchId: next.patch.patchId,
          relocationScore: next.relocationScore,
          relocationReasons: next.relocationReasons,
        };
      }
    }

    const stateBefore = state;
    state = updateArtworkState61(state, attempt);
    attempts.push({ attempt, stateAfter: state });

    lastPatch = { x: attempt.x, y: attempt.y };

    if (state.status !== "active") break;
  }

  // scheduler skipping evidence: second pass after loop
  schedulerEvidence.push({ pass: 2, goalClusterId: goal.clusterId, skipped: shouldSkipGoal(state, Date.now()), status: state.status, cooldownUntil: state.cooldownUntil });

  // explicit cooldown skip evidence (simulate)
  const now = Date.now();
  const skipEvidence = {
    now,
    status: state.status,
    cooldownUntil: state.cooldownUntil,
    shouldSkip: shouldSkipGoal(state, now),
  };

  return { baseUrl, boardWsUrl, paletteThreshold, chosenGoal: goal, attempts, finalState: state, schedulerEvidence, cooldownSkipEvidence: skipEvidence };
}
