#!/usr/bin/env node
import { TemporalRegionHistory } from "../src/phase1/temporal.js";
import { fetchBoardSnapshot } from "../src/client/board.js";
import { phase5FromRefined } from "../src/phase5/plan_refined.js";

const baseUrl = process.env.AGENTDERBY_BASE_URL || "https://agentderby.ai";
const paletteThreshold = Number(process.env.AGENTDERBY_PALETTE_THRESHOLD || 20);

const hist = new TemporalRegionHistory({ regionSize: 32, maxFrames: 2 });
const s1 = await fetchBoardSnapshot({ baseUrl });
hist.addFrameFromPng({ pngBytes: s1.bytes, ts: Date.now() });
await new Promise((r) => setTimeout(r, 1200));
const s2 = await fetchBoardSnapshot({ baseUrl });
hist.addFrameFromPng({ pngBytes: s2.bytes, ts: Date.now() });

const regionSummaries = hist.computeTemporalSummaries();
const out = phase5FromRefined({ regionSummaries, paletteThreshold });

console.log(JSON.stringify({
  baseUrl,
  board: { width: hist.latest().width, height: hist.latest().height, regionSize: 32, frames: hist.frames.length },
  paletteThreshold,
  refinedClustersCount: out.refinedClusters.length,
  eligibleRefinedClustersCount: out.eligibleRefinedClusters.length,
  refinedClustersUsed: out.eligibleRefinedClusters.map((c) => ({
    clusterId: c.clusterId,
    parentClusterId: c.parentClusterId,
    n: c.regionIds.length,
    bbox: c.bbox,
    dominantStyles: c.dominantStyles,
    dominantColors: c.dominantColors,
    stage: c.stage,
    riskScore: c.riskScore,
    splitReason: c.splitReason,
  })),
  artworkGoals: out.goals.map((g) => {
    const c = out.eligibleRefinedClusters.find((x) => x.clusterId === g.clusterId);
    return {
      clusterId: c.clusterId,
      parentClusterId: c.parentClusterId,
      bbox: c.bbox,
      dominantStyles: c.dominantStyles,
      dominantColors: c.dominantColors,
      stage: c.stage,
      riskScore: c.riskScore,
      goalType: g.goalType,
      priority: g.priority,
      preferredRoles: g.preferredRoles,
      reasons: g.reasons,
    };
  }),
  teamAssignments: out.teamAssignments,
  frontierPatches: out.frontierPatches.map((p) => ({
    patchId: p.patchId,
    clusterId: out.eligibleRefinedClusters.find((c) => c.regionIds.includes(p.regionId))?.clusterId,
    regionId: p.regionId,
    x: p.x, y: p.y, w: p.w, h: p.h,
    actionType: p.actionType,
    frontierType: p.frontierType,
    reason: p.reason,
  })),
}, null, 2));
