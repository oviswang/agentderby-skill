import { goalsForClusters, assignTeam, frontierPatchesForGoal } from "./artwork.js";
import { coarseAndRefined } from "./refine.js";

export function goalsForRefinedClusters({ refinedClusters }) {
  // reuse goalsForClusters by treating refined clusters as clusters
  return goalsForClusters({ clusters: refinedClusters });
}

export function teamAssignmentsForGoals({ goals, maxTeams = 2 }) {
  return goals.slice(0, maxTeams).map((g) => assignTeam({ goal: g }));
}

export function frontierPatchesForRefinedGoals({ goals, refinedClusters, regionSummaries, maxPatches = 6 }) {
  // frontierPatchesForGoal expects (goal, clusters, regionSummaries)
  const patches = goals.flatMap((g) => frontierPatchesForGoal({ goal: g, clusters: refinedClusters, regionSummaries }));
  // attach clusterId
  return patches.map((p) => ({ ...p, clusterId: goals.find((g) => g.clusterId === p.clusterId)?.clusterId || p.clusterId })).slice(0, maxPatches);
}

export function eligibleRefinedClusters({ refinedClusters, minRegions = 2 }) {
  return refinedClusters.filter((c) => (c.regionIds?.length || 0) >= minRegions);
}

export function phase5FromRefined({ regionSummaries, paletteThreshold = 20 }) {
  const { coarse, refined } = coarseAndRefined({ regionSummaries, paletteThreshold });
  const eligible = eligibleRefinedClusters({ refinedClusters: refined, minRegions: 2 });
  const goals = goalsForRefinedClusters({ refinedClusters: eligible }).slice(0, 6);
  const teamAssignments = teamAssignmentsForGoals({ goals, maxTeams: 2 });
  const frontierPatches = goals.flatMap((g) => frontierPatchesForGoal({ goal: g, clusters: eligible, regionSummaries })).slice(0, 6);

  return { coarseClusters: coarse, refinedClusters: refined, eligibleRefinedClusters: eligible, goals: goals.slice(0, 3), teamAssignments, frontierPatches: frontierPatches.slice(0, 6) };
}
