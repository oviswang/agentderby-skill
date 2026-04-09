#!/usr/bin/env node
import { TemporalRegionHistory } from "../src/phase1/temporal.js";
import { fetchBoardSnapshot } from "../src/client/board.js";
import { coarseAndRefined } from "../src/phase5/refine.js";

const baseUrl = process.env.AGENTDERBY_BASE_URL || "https://agentderby.ai";
const paletteThreshold = Number(process.env.AGENTDERBY_PALETTE_THRESHOLD || 60);

const hist = new TemporalRegionHistory({ regionSize: 32, maxFrames: 2 });
const s1 = await fetchBoardSnapshot({ baseUrl });
hist.addFrameFromPng({ pngBytes: s1.bytes, ts: Date.now() });
await new Promise((r) => setTimeout(r, 1200));
const s2 = await fetchBoardSnapshot({ baseUrl });
hist.addFrameFromPng({ pngBytes: s2.bytes, ts: Date.now() });

const regionSummaries = hist.computeTemporalSummaries();
const { coarse, refined } = coarseAndRefined({ regionSummaries, paletteThreshold });

console.log(JSON.stringify({
  baseUrl,
  board: { width: hist.latest().width, height: hist.latest().height, regionSize: 32, frames: hist.frames.length },
  logic: { paletteThreshold },
  coarseClusters: coarse.map((c)=>({clusterId:c.clusterId, n:c.regionIds.length, bbox:c.bbox, dominantStyles:c.dominantStyles, dominantColors:c.dominantColors, stage:c.stage, riskScore:c.riskScore})),
  refinedClusters: refined.map((c)=>({clusterId:c.clusterId, parentClusterId:c.parentClusterId, n:c.regionIds.length, bbox:c.bbox, dominantStyles:c.dominantStyles, dominantColors:c.dominantColors, stage:c.stage, riskScore:c.riskScore, splitReason:c.splitReason})),
}, null, 2));
