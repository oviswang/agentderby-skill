import { PNG } from "pngjs";

function rgbToHex(r, g, b) {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b
    .toString(16)
    .padStart(2, "0")}`;
}

function luminance(r, g, b) {
  // relative luminance (sRGB approx)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function decodePng(pngBytes) {
  const png = PNG.sync.read(pngBytes);
  return { png, width: png.width, height: png.height };
}

export function scanRegionsFromPngBytes({ pngBytes, regionSize = 32 }) {
  const { png, width, height } = decodePng(pngBytes);
  const regions = [];

  const rx = Math.ceil(width / regionSize);
  const ry = Math.ceil(height / regionSize);

  for (let j = 0; j < ry; j++) {
    for (let i = 0; i < rx; i++) {
      const x = i * regionSize;
      const y = j * regionSize;
      const w = Math.min(regionSize, width - x);
      const h = Math.min(regionSize, height - y);
      const id = `r${i}_${j}`;

      // histograms
      const colorCounts = new Map();
      let nonBg = 0;
      let edges = 0;
      let lumSum = 0;
      let lumSumSq = 0;

      // simple background heuristic: most common color in region
      // first pass: count colors
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const idx = (yy * width + xx) * 4;
          const r = png.data[idx];
          const g = png.data[idx + 1];
          const b = png.data[idx + 2];
          const hex = rgbToHex(r, g, b);
          colorCounts.set(hex, (colorCounts.get(hex) || 0) + 1);
          const lum = luminance(r, g, b);
          lumSum += lum;
          lumSumSq += lum * lum;
        }
      }

      let bgColor = null;
      let bgCount = -1;
      for (const [c, n] of colorCounts.entries()) {
        if (n > bgCount) {
          bgCount = n;
          bgColor = c;
        }
      }

      const total = w * h;
      nonBg = total - bgCount;
      const fillRatio = total > 0 ? nonBg / total : 0;

      // edge density: count pixel-to-right and pixel-to-down color changes
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const idx = (yy * width + xx) * 4;
          const r = png.data[idx];
          const g = png.data[idx + 1];
          const b = png.data[idx + 2];
          const cur = (r << 16) | (g << 8) | b;
          if (xx + 1 < x + w) {
            const idx2 = (yy * width + (xx + 1)) * 4;
            const c2 = (png.data[idx2] << 16) | (png.data[idx2 + 1] << 8) | png.data[idx2 + 2];
            if (c2 !== cur) edges++;
          }
          if (yy + 1 < y + h) {
            const idx2 = ((yy + 1) * width + xx) * 4;
            const c2 = (png.data[idx2] << 16) | (png.data[idx2 + 1] << 8) | png.data[idx2 + 2];
            if (c2 !== cur) edges++;
          }
        }
      }
      const maxEdges = (w - 1) * h + (h - 1) * w;
      const edgeDensity = maxEdges > 0 ? edges / maxEdges : 0;

      // dominant colors: top 5
      const dominantColors = Array.from(colorCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([color, count]) => ({ color, count, pct: total ? count / total : 0 }));

      const lumMean = total ? lumSum / total : 0;
      const lumVar = total ? Math.max(0, lumSumSq / total - lumMean * lumMean) : 0;

      // Phase 1 change rate: not available without history; use 0 + note
      const recentChangeRate = null;

      const { stage, styleTags, riskScore } = classifyRegion({ fillRatio, edgeDensity, dominantColors, lumVar });

      regions.push({
        regionId: id,
        x,
        y,
        w,
        h,
        dominantColors,
        fillRatio,
        edgeDensity,
        recentChangeRate,
        stage,
        styleTags,
        riskScore,
      });
    }
  }

  return { width, height, regionSize, regions };
}

export function classifyRegion({ fillRatio, edgeDensity, dominantColors, lumVar }) {
  // stage heuristics
  let stage = "in_progress";
  if (fillRatio < 0.02) stage = "empty";
  else if (fillRatio < 0.12) stage = "seeded";
  else if (fillRatio < 0.65) stage = "in_progress";
  else if (fillRatio < 0.9) stage = "nearly_done";
  else stage = "finished";

  // damaged/contested heuristic: very high edge density in a mostly filled region
  if (fillRatio > 0.5 && edgeDensity > 0.25) stage = "damaged";
  if (fillRatio > 0.65 && edgeDensity > 0.35) stage = "contested";

  // style tags heuristics
  const styleTags = [];
  const nColors = dominantColors?.length || 0;
  const topPct = dominantColors?.[0]?.pct ?? 0;

  if (edgeDensity > 0.22 && fillRatio > 0.25) styleTags.push("text_like");
  if (edgeDensity > 0.18 && nColors >= 3) styleTags.push("geometric");
  if (lumVar > 900 && fillRatio > 0.2) styleTags.push("starry");
  if (nColors >= 4 && topPct < 0.55 && fillRatio > 0.25) styleTags.push("abstract");
  if (fillRatio > 0.35 && edgeDensity < 0.08) styleTags.push("landscape");
  if (fillRatio > 0.25 && edgeDensity < 0.12 && nColors <= 3) styleTags.push("portrait");
  if (fillRatio > 0.2 && edgeDensity < 0.18 && nColors >= 3) styleTags.push("wave");
  if (fillRatio > 0.25 && edgeDensity < 0.2 && nColors <= 4) styleTags.push("icon");

  // risk score 0..1
  // More risk when contested/damaged, or high edge density, or very sparse (easy to overwrite)
  let riskScore = 0;
  if (stage === "contested") riskScore += 0.6;
  if (stage === "damaged") riskScore += 0.45;
  riskScore += Math.min(0.4, edgeDensity * 1.2);
  riskScore += fillRatio < 0.1 ? 0.15 : 0;
  riskScore = Math.max(0, Math.min(1, riskScore));

  // de-dupe tags
  const tags = Array.from(new Set(styleTags));
  return { stage, styleTags: tags, riskScore };
}

export const PROFILES = {
  "wave-restorer": {
    id: "wave-restorer",
    preferredStyles: ["wave", "landscape", "geometric"],
    preferredPalette: ["#0b3d91", "#1e90ff", "#00c2ff", "#ffffff", "#111111"],
    preferredRoles: ["repair", "refine", "protect"],
    stageAffinity: { damaged: 1.0, contested: 0.9, in_progress: 0.7, seeded: 0.4, nearly_done: 0.6, finished: 0.2, empty: 0.3 },
  },
  "starry-finisher": {
    id: "starry-finisher",
    preferredStyles: ["starry", "abstract"],
    preferredPalette: ["#0a0a1a", "#111133", "#2d2d7a", "#f8f8ff", "#ffd27d"],
    preferredRoles: ["fill", "refine", "protect"],
    stageAffinity: { nearly_done: 1.0, in_progress: 0.8, seeded: 0.5, finished: 0.4, damaged: 0.6, contested: 0.5, empty: 0.2 },
  },
  "portrait-refiner": {
    id: "portrait-refiner",
    preferredStyles: ["portrait", "icon", "text_like"],
    preferredPalette: ["#000000", "#ffffff", "#f2c9a0", "#c68642", "#8d5524"],
    preferredRoles: ["refine", "repair", "protect"],
    stageAffinity: { in_progress: 1.0, nearly_done: 0.9, finished: 0.6, seeded: 0.5, damaged: 0.8, contested: 0.7, empty: 0.2 },
  },
};

export function scoreRegionForProfile(region, profile) {
  const reasons = [];
  let score = 0;

  // stage affinity
  const stageW = profile.stageAffinity?.[region.stage] ?? 0.4;
  score += 0.35 * stageW;
  reasons.push(`stage=${region.stage} affinity=${stageW.toFixed(2)}`);

  // style match
  const match = region.styleTags.filter((t) => profile.preferredStyles.includes(t));
  const styleScore = Math.min(1, match.length / Math.max(1, profile.preferredStyles.length));
  score += 0.35 * styleScore;
  if (match.length) reasons.push(`styleMatch=${match.join(',')}`);
  else reasons.push('styleMatch=none');

  // risk preference: for MVP, prefer medium risk (0.2..0.6), penalize extremes
  const r = region.riskScore;
  const riskScore = 1 - Math.min(1, Math.abs(r - 0.4) / 0.6);
  score += 0.15 * riskScore;
  reasons.push(`risk=${r.toFixed(2)}`);

  // fill/edge heuristics by role
  if (profile.id === 'wave-restorer') {
    const repairish = region.stage === 'damaged' || region.stage === 'contested';
    score += repairish ? 0.15 : 0;
    if (repairish) reasons.push('needs_repair');
  }
  if (profile.id === 'starry-finisher') {
    const finishish = region.stage === 'nearly_done' || region.stage === 'finished';
    score += finishish ? 0.08 : 0;
    if (finishish) reasons.push('finish_candidate');
  }
  if (profile.id === 'portrait-refiner') {
    const refineish = region.edgeDensity > 0.12 && region.fillRatio > 0.25;
    score += refineish ? 0.1 : 0;
    if (refineish) reasons.push('detail_edges');
  }

  score = Math.max(0, Math.min(1, score));

  // suggested action type
  let actionType = 'wait';
  if (region.stage === 'empty') actionType = 'seed';
  else if (region.stage === 'seeded') actionType = 'fill';
  else if (region.stage === 'in_progress') actionType = 'refine';
  else if (region.stage === 'nearly_done') actionType = 'protect';
  else if (region.stage === 'damaged') actionType = 'repair';
  else if (region.stage === 'contested') actionType = 'protect';

  return { score, actionType, reasons };
}

export function recommendRegions({ regions, profile, topN = 5 }) {
  const scored = regions.map((r) => {
    const s = scoreRegionForProfile(r, profile);
    return { regionId: r.regionId, score: s.score, actionType: s.actionType, reasons: s.reasons, region: r };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}
