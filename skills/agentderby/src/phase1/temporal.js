import { scanRegionsFromPngBytes } from "./region_scan.js";

function nowMs() {
  return Date.now();
}

export class TemporalRegionHistory {
  constructor({ regionSize = 32, maxFrames = 5 } = {}) {
    this.regionSize = regionSize;
    this.maxFrames = maxFrames;
    this.frames = []; // [{ts,width,height, regionsById: Map<string, summary>}]
  }

  addFrameFromPng({ pngBytes, ts = nowMs() } = {}) {
    const scan = scanRegionsFromPngBytes({ pngBytes, regionSize: this.regionSize });
    const regionsById = new Map(scan.regions.map((r) => [r.regionId, r]));
    this.frames.push({ ts, width: scan.width, height: scan.height, regionsById });
    while (this.frames.length > this.maxFrames) this.frames.shift();
    return { ts, width: scan.width, height: scan.height, regionSize: scan.regionSize, regions: scan.regions.length };
  }

  hasAtLeast(n) {
    return this.frames.length >= n;
  }

  latest() {
    return this.frames[this.frames.length - 1] || null;
  }

  previous() {
    return this.frames.length >= 2 ? this.frames[this.frames.length - 2] : null;
  }

  computeTemporalSummaries() {
    const cur = this.latest();
    const prev = this.previous();
    if (!cur) return [];

    const dtMs = prev ? Math.max(1, cur.ts - prev.ts) : null;

    const out = [];
    for (const [id, r] of cur.regionsById.entries()) {
      let changedPixels = null;
      let recentChangeRate = null;
      let stabilityScore = null;

      if (prev) {
        const p = prev.regionsById.get(id);
        if (p) {
          // Phase 2 approximation (no per-pixel diff yet): use change in fillRatio + edgeDensity as proxy.
          const dFill = Math.abs((r.fillRatio ?? 0) - (p.fillRatio ?? 0));
          const dEdge = Math.abs((r.edgeDensity ?? 0) - (p.edgeDensity ?? 0));
          const proxy = Math.min(1, dFill * 2.0 + dEdge * 1.5);

          // interpret proxy as fraction of region pixels changed
          const regionPx = r.w * r.h;
          changedPixels = Math.round(proxy * regionPx);

          // per-second rate
          recentChangeRate = (changedPixels / regionPx) / (dtMs / 1000);

          // stability: inverse of normalized proxy
          stabilityScore = Math.max(0, Math.min(1, 1 - proxy));
        }
      }

      out.push({
        ...r,
        temporal: {
          dtMs,
          changedPixels,
          recentChangeRate,
          stabilityScore,
        },
      });
    }

    return out;
  }
}

export function temporalStageOverride({ baseStage, fillRatio, edgeDensity, temporal }) {
  // Use temporal signals to refine phase1 labels.
  // - contested: high recent change + high edge density
  // - damaged: moderate change + high edge density + lower stability
  // - finished: high fill + low change + high stability
  // - nearly_done: high fill + low-to-medium change
  let stage = baseStage;
  const rcr = temporal?.recentChangeRate;
  const stab = temporal?.stabilityScore;

  if (rcr != null) {
    if ((edgeDensity ?? 0) > 0.25 && rcr > 0.03) stage = "contested";
    else if ((edgeDensity ?? 0) > 0.22 && rcr > 0.015) stage = "damaged";

    if ((fillRatio ?? 0) > 0.9 && rcr < 0.002 && (stab ?? 0) > 0.9) stage = "finished";
    else if ((fillRatio ?? 0) > 0.75 && rcr < 0.01) stage = "nearly_done";
  }

  return stage;
}
