import { TemporalRegionHistory } from "../phase1/temporal.js";
import { fetchBoardSnapshot } from "../client/board.js";
import { PROFILES } from "../phase1/region_scan.js";
import { candidateActionsForProfile, patchPlansFromCandidateActions } from "../phase1/actions.js";

function regionKey(r) {
  const i = Math.floor(r.x / r.w);
  const j = Math.floor(r.y / r.h);
  return `${i}_${j}`;
}

function neighborsOf(r) {
  const i = Math.floor(r.x / r.w);
  const j = Math.floor(r.y / r.h);
  return [
    `${i - 1}_${j}`,
    `${i + 1}_${j}`,
    `${i}_${j - 1}`,
    `${i}_${j + 1}`,
  ];
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 0;
}

function mergeBbox(b, r) {
  const x1 = Math.min(b.x, r.x);
  const y1 = Math.min(b.y, r.y);
  const x2 = Math.max(b.x + b.w, r.x + r.w);
  const y2 = Math.max(b.y + b.h, r.y + r.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function clusterRegions({ regionSummaries }) {
  const byKey = new Map(regionSummaries.map((r) => [regionKey(r), r]));
  const visited = new Set();
  const clusters = [];

  const compatibleStage = (s) => (s === "in_progress" || s === "nearly_done" || s === "damaged" || s === "contested" || s === "finished");

  for (const r of regionSummaries) {
    const k0 = regionKey(r);
    if (visited.has(k0)) continue;
    visited.add(k0);

    if (!compatibleStage(r.stage)) continue;

    const queue = [r];
    const members = [r];
    let bbox = { x: r.x, y: r.y, w: r.w, h: r.h };

    while (queue.length) {
      const cur = queue.pop();
      for (const nk of neighborsOf(cur)) {
        if (visited.has(nk)) continue;
        const nr = byKey.get(nk);
        if (!nr) continue;

        // compatibility: similar style tags OR both are geometric/text_like-ish, and stages not wildly different
        const styleSim = jaccard(cur.styleTags || [], nr.styleTags || []);
        const stageOk = !(cur.stage === "empty" || nr.stage === "empty");
        const colorOk = true; // Phase 5 MVP: skip expensive color distance

        if (stageOk && colorOk && (styleSim >= 0.25 || (cur.styleTags?.includes("geometric") && nr.styleTags?.includes("geometric")))) {
          visited.add(nk);
          queue.push(nr);
          members.push(nr);
          bbox = mergeBbox(bbox, nr);
        }
      }
    }

    if (members.length >= 3) {
      // summarize
      const styleCounts = new Map();
      const colorCounts = new Map();
      let riskSum = 0;
      const stageCounts = new Map();

      for (const m of members) {
        for (const t of m.styleTags || []) styleCounts.set(t, (styleCounts.get(t) || 0) + 1);
        for (const dc of m.dominantColors || []) colorCounts.set(dc.color, (colorCounts.get(dc.color) || 0) + dc.count);
        riskSum += m.riskScore ?? 0;
        stageCounts.set(m.stage, (stageCounts.get(m.stage) || 0) + 1);
      }

      const dominantStyles = [...styleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
      const dominantColors = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c);
      const stage = [...stageCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "in_progress";
      const riskScore = members.length ? riskSum / members.length : 0;

      clusters.push({
        clusterId: `c${clusters.length}`,
        regionIds: members.map((x) => x.regionId),
        bbox,
        dominantStyles,
        dominantColors,
        stage,
        riskScore,
      });
    }
  }

  return clusters;
}

export function goalsForClusters({ clusters }) {
  const goals = [];
  for (const c of clusters) {
    let goalType = "expand";
    let priority = 0.5;
    let preferredRoles = ["fill", "refine"];
    const reasons = [];

    if (c.stage === "damaged" || c.stage === "contested") {
      goalType = "repair";
      priority = Math.min(1, 0.6 + c.riskScore * 0.4);
      preferredRoles = ["repair", "protect", "refine"];
      reasons.push(`stage=${c.stage}`);
      reasons.push(`risk=${c.riskScore.toFixed(2)}`);
    } else if (c.stage === "nearly_done") {
      goalType = "complete";
      priority = 0.75;
      preferredRoles = ["refine", "protect", "fill"];
      reasons.push("nearly_done cluster");
    } else if (c.stage === "finished") {
      goalType = "protect";
      priority = 0.65;
      preferredRoles = ["protect"];
      reasons.push("finished cluster");
    } else {
      goalType = "expand";
      priority = 0.55;
      preferredRoles = ["fill", "refine"];
      reasons.push("in_progress cluster");
    }

    goals.push({ clusterId: c.clusterId, goalType, priority, preferredRoles, reasons });
  }

  goals.sort((a, b) => b.priority - a.priority);
  return goals;
}

export function assignTeam({ goal, agentIds = ["wave-restorer", "starry-finisher", "portrait-refiner"] }) {
  // pick 2 agents with different roles based on their profile preferences
  const roles = goal.preferredRoles;
  const pick = [];
  for (const role of roles) {
    const agent = agentIds.find((id) => PROFILES[id]?.preferredRoles?.includes(role) && !pick.find((p) => p.agentId === id));
    if (agent) pick.push({ agentId: agent, role });
    if (pick.length >= 2) break;
  }
  if (pick.length < 2) {
    // fallback: just pick two distinct agents
    for (const id of agentIds) {
      if (!pick.find((p) => p.agentId === id)) pick.push({ agentId: id, role: roles[pick.length] || "refine" });
      if (pick.length >= 2) break;
    }
  }

  return { goalClusterId: goal.clusterId, goalType: goal.goalType, members: pick };
}

export function frontierPatchesForGoal({ goal, clusters, regionSummaries }) {
  const cluster = clusters.find((c) => c.clusterId === goal.clusterId);
  if (!cluster) return [];

  // pick frontier regions: for repair/protect, choose highest risk regions in cluster.
  const inCluster = regionSummaries.filter((r) => cluster.regionIds.includes(r.regionId));
  inCluster.sort((a, b) => (b.riskScore ?? 0) - (a.riskScore ?? 0));
  const topRegions = inCluster.slice(0, 3);

  const patches = [];
  for (const r of topRegions) {
    // choose a 16x16 centered patch
    const size = 16;
    patches.push({
      patchId: `${r.regionId}_front0`,
      regionId: r.regionId,
      x: r.x + Math.floor((r.w - size) / 2),
      y: r.y + Math.floor((r.h - size) / 2),
      w: Math.min(size, r.w),
      h: Math.min(size, r.h),
      actionType: goal.goalType === "repair" ? "repair" : goal.goalType === "protect" ? "protect" : goal.goalType === "complete" ? "refine" : "fill",
      reason: [`cluster=${cluster.clusterId}`, `goal=${goal.goalType}`, `regionRisk=${(r.riskScore ?? 0).toFixed(2)}`],
    });
  }

  return patches;
}

export async function phase5Demo({ baseUrl, snapshotIntervalMs = 1200 }) {
  const hist = new TemporalRegionHistory({ regionSize: 32, maxFrames: 3 });
  const s1 = await fetchBoardSnapshot({ baseUrl });
  hist.addFrameFromPng({ pngBytes: s1.bytes, ts: Date.now() });
  await new Promise((r) => setTimeout(r, snapshotIntervalMs));
  const s2 = await fetchBoardSnapshot({ baseUrl });
  hist.addFrameFromPng({ pngBytes: s2.bytes, ts: Date.now() });

  const regionSummaries = hist.computeTemporalSummaries();
  const clusters = clusterRegions({ regionSummaries });
  const goals = goalsForClusters({ clusters }).slice(0, 3);
  const teamAssignment = goals.length ? assignTeam({ goal: goals[0] }) : null;
  const frontier = goals.flatMap((g) => frontierPatchesForGoal({ goal: g, clusters, regionSummaries })).slice(0, 6);

  return { baseUrl, board: { width: hist.latest().width, height: hist.latest().height, regionSize: 32, frames: hist.frames.length }, clusters: clusters.slice(0, 6), goals, teamAssignment, frontierPatches: frontier.slice(0, 3) };
}
