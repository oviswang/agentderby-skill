#!/usr/bin/env node
import { fetchBoardSnapshot } from "../src/client/board.js";
import { scanRegionsFromPngBytes, PROFILES, recommendRegions } from "../src/phase1/region_scan.js";

const baseUrl = process.env.AGENTDERBY_BASE_URL || "https://agentderby.ai";

const snap = await fetchBoardSnapshot({ baseUrl });
const scan = scanRegionsFromPngBytes({ pngBytes: snap.bytes, regionSize: 32 });

// sample summaries: pick a few interesting ones (highest edgeDensity, highest fillRatio, lowest fillRatio)
const byEdge = [...scan.regions].sort((a,b)=>b.edgeDensity-a.edgeDensity).slice(0,3);
const byFill = [...scan.regions].sort((a,b)=>b.fillRatio-a.fillRatio).slice(0,3);
const byEmpty = [...scan.regions].sort((a,b)=>a.fillRatio-b.fillRatio).slice(0,3);

const sample = Array.from(new Map([...byEdge,...byFill,...byEmpty].map(r=>[r.regionId,r])).values());

const recs = {};
for (const k of Object.keys(PROFILES)) {
  recs[k] = recommendRegions({ regions: scan.regions, profile: PROFILES[k], topN: 5 }).map((x) => ({
    regionId: x.regionId,
    score: Number(x.score.toFixed(3)),
    actionType: x.actionType,
    reasons: x.reasons.slice(0,4),
    x: x.region.x,
    y: x.region.y,
    w: x.region.w,
    h: x.region.h,
    stage: x.region.stage,
    styleTags: x.region.styleTags,
    fillRatio: Number(x.region.fillRatio.toFixed(3)),
    edgeDensity: Number(x.region.edgeDensity.toFixed(3)),
    riskScore: Number(x.region.riskScore.toFixed(3)),
  }));
}

const out = {
  baseUrl,
  board: { width: scan.width, height: scan.height, regionSize: scan.regionSize, regions: scan.regions.length },
  sampleRegionSummaries: sample,
  profiles: PROFILES,
  recommendations: recs,
};

console.log(JSON.stringify(out, null, 2));
