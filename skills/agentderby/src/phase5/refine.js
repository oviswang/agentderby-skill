import { clusterRegions } from "./artwork.js";

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function dist(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function regionKey(r) {
  const i = Math.floor(r.x / r.w);
  const j = Math.floor(r.y / r.h);
  return `${i}_${j}`;
}

function neighborsKeys(r) {
  const i = Math.floor(r.x / r.w);
  const j = Math.floor(r.y / r.h);
  return [`${i-1}_${j}`, `${i+1}_${j}`, `${i}_${j-1}`, `${i}_${j+1}`];
}

function topColorsVec(r, k = 3) {
  return (r.dominantColors || []).slice(0, k).map((d) => d.color);
}

function paletteDistance(r1, r2) {
  const a = topColorsVec(r1);
  const b = topColorsVec(r2);
  if (!a.length || !b.length) return 999;
  // average min-distance between top colors
  const A = a.map(rgb);
  const B = b.map(rgb);
  let sum = 0;
  for (const va of A) {
    let md = Infinity;
    for (const vb of B) md = Math.min(md, dist(va, vb));
    sum += md;
  }
  return sum / A.length;
}

export function refineClustersPaletteSplit({ regionSummaries, coarseClusters, paletteThreshold = 60 }) {
  const byGrid = new Map(regionSummaries.map((r) => [regionKey(r), r]));
  const refined = [];

  for (const c of coarseClusters) {
    const keys = new Set(c.regionIds.map((rid) => {
      const r = regionSummaries.find((x) => x.regionId === rid);
      return r ? regionKey(r) : null;
    }).filter(Boolean));

    const visited = new Set();
    let part = 0;

    for (const k0 of keys) {
      if (visited.has(k0)) continue;
      visited.add(k0);
      const seed = byGrid.get(k0);
      if (!seed) continue;

      const queue = [seed];
      const members = [seed];
      let bbox = { x: seed.x, y: seed.y, w: seed.w, h: seed.h };

      while (queue.length) {
        const cur = queue.pop();
        for (const nk of neighborsKeys(cur)) {
          if (!keys.has(nk) || visited.has(nk)) continue;
          const nr = byGrid.get(nk);
          if (!nr) continue;

          const pd = paletteDistance(cur, nr);
          if (pd <= paletteThreshold) {
            visited.add(nk);
            queue.push(nr);
            members.push(nr);
            const x1 = Math.min(bbox.x, nr.x);
            const y1 = Math.min(bbox.y, nr.y);
            const x2 = Math.max(bbox.x + bbox.w, nr.x + nr.w);
            const y2 = Math.max(bbox.y + bbox.h, nr.y + nr.h);
            bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
          }
        }
      }

      if (members.length >= 2) {
        // summarize styles/colors/stage/risk
        const styleCounts = new Map();
        const colorCounts = new Map();
        const stageCounts = new Map();
        let riskSum = 0;
        for (const m of members) {
          for (const t of m.styleTags || []) styleCounts.set(t, (styleCounts.get(t) || 0) + 1);
          for (const dc of m.dominantColors || []) colorCounts.set(dc.color, (colorCounts.get(dc.color) || 0) + dc.count);
          stageCounts.set(m.stage, (stageCounts.get(m.stage) || 0) + 1);
          riskSum += m.riskScore ?? 0;
        }
        const dominantStyles = [...styleCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([t])=>t);
        const dominantColors = [...colorCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([cc])=>cc);
        const stage = [...stageCounts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0] || 'in_progress';
        const riskScore = members.length ? riskSum / members.length : 0;

        refined.push({
          clusterId: `${c.clusterId}.${part++}`,
          parentClusterId: c.clusterId,
          regionIds: members.map((m) => m.regionId),
          bbox,
          dominantStyles,
          dominantColors,
          stage,
          riskScore,
          splitReason: `paletteSplit(threshold=${paletteThreshold})`,
        });
      }
    }

    // if no split happened, preserve as a single refined cluster
    const kids = refined.filter((r) => r.parentClusterId === c.clusterId);
    if (!kids.length) {
      refined.push({
        clusterId: `${c.clusterId}.0`,
        parentClusterId: c.clusterId,
        regionIds: c.regionIds,
        bbox: c.bbox,
        dominantStyles: c.dominantStyles,
        dominantColors: c.dominantColors,
        stage: c.stage,
        riskScore: c.riskScore,
        splitReason: `paletteSplit(threshold=${paletteThreshold})_no_split`,
      });
    }
  }

  return refined;
}

export function coarseAndRefined({ regionSummaries, paletteThreshold = 60 }) {
  const coarse = clusterRegions({ regionSummaries });
  const refined = refineClustersPaletteSplit({ regionSummaries, coarseClusters: coarse, paletteThreshold });
  return { coarse, refined };
}
