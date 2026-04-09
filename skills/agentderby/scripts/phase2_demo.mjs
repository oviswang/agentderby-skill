#!/usr/bin/env node
import { fetchBoardSnapshot } from "../src/client/board.js";
import { TemporalRegionHistory, temporalStageOverride } from "../src/phase1/temporal.js";
import { candidateActionsForProfile, patchPlansFromCandidateActions } from "../src/phase1/actions.js";
import { PROFILES } from "../src/phase1/region_scan.js";

const baseUrl = process.env.AGENTDERBY_BASE_URL || "https://agentderby.ai";
const regionSize = Number(process.env.AGENTDERBY_REGION_SIZE || 32);
const intervalMs = Number(process.env.AGENTDERBY_SNAPSHOT_INTERVAL_MS || 1200);

const hist = new TemporalRegionHistory({ regionSize, maxFrames: 5 });

// take 2 snapshots to get temporal deltas
const snap1 = await fetchBoardSnapshot({ baseUrl });
hist.addFrameFromPng({ pngBytes: snap1.bytes, ts: Date.now() });
await new Promise((r) => setTimeout(r, intervalMs));
const snap2 = await fetchBoardSnapshot({ baseUrl });
hist.addFrameFromPng({ pngBytes: snap2.bytes, ts: Date.now() });

const summaries = hist.computeTemporalSummaries();

// select 10 interesting samples (highest change rate, lowest stability, plus empties)
const withRcr = summaries.filter((r) => r.temporal?.recentChangeRate != null);
const byRcr = [...withRcr].sort((a,b)=> (b.temporal.recentChangeRate - a.temporal.recentChangeRate)).slice(0,4);
const byUnstable = [...withRcr].sort((a,b)=> (a.temporal.stabilityScore - b.temporal.stabilityScore)).slice(0,3);
const empties = summaries.filter((r)=>r.stage==='empty').slice(0,3);
const sample = Array.from(new Map([...byRcr,...byUnstable,...empties].map(r=>[r.regionId,r])).values()).slice(0,10);

const temporalClassifierLogic = {
  contested: "edgeDensity>0.25 AND recentChangeRate>0.03/s",
  damaged: "edgeDensity>0.22 AND recentChangeRate>0.015/s",
  finished: "fillRatio>0.9 AND recentChangeRate<0.002/s AND stabilityScore>0.9",
  nearly_done: "fillRatio>0.75 AND recentChangeRate<0.01/s",
};

const candidateActions = {};
const patchPlans = {};
for (const id of Object.keys(PROFILES)) {
  const acts = candidateActionsForProfile({ regionSummaries: summaries, profileId: id, topN: 5 }).map((a) => ({
    regionId: a.regionId,
    x: a.x, y: a.y, w: a.w, h: a.h,
    score: Number(a.score.toFixed(3)),
    actionType: a.actionType,
    expectedGain: Number(a.expectedGain.toFixed(3)),
    reasons: a.reasons.slice(0,6),
  }));
  candidateActions[id] = acts;
  patchPlans[id] = patchPlansFromCandidateActions({ candidateActions: acts, maxPlans: 3 });
}

console.log(JSON.stringify({
  baseUrl,
  board: { width: hist.latest().width, height: hist.latest().height, regionSize, frames: hist.frames.length },
  temporalClassifierLogic,
  regionSummarySamples: sample.map((r) => ({
    regionId: r.regionId,
    x: r.x, y: r.y, w: r.w, h: r.h,
    dominantColors: r.dominantColors,
    fillRatio: r.fillRatio,
    edgeDensity: r.edgeDensity,
    changedPixels: r.temporal.changedPixels,
    recentChangeRate: r.temporal.recentChangeRate,
    stabilityScore: r.temporal.stabilityScore,
    stage: temporalStageOverride({ baseStage: r.stage, fillRatio: r.fillRatio, edgeDensity: r.edgeDensity, temporal: r.temporal }),
    styleTags: r.styleTags,
    riskScore: r.riskScore,
  })),
  profiles: PROFILES,
  candidateActions,
  patchPlans,
}, null, 2));
