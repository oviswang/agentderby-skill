import { PROFILES, recommendRegions, scoreRegionForProfile } from "./region_scan.js";
import { temporalStageOverride } from "./temporal.js";

export function candidateActionsForProfile({ regionSummaries, profileId, topN = 5 }) {
  const profile = PROFILES[profileId];
  if (!profile) throw new Error(`unknown profile: ${profileId}`);

  // apply temporal stage overrides for scoring and action selection
  const normalized = regionSummaries.map((r) => {
    const baseStage = r.stage;
    const stage = temporalStageOverride({ baseStage, fillRatio: r.fillRatio, edgeDensity: r.edgeDensity, temporal: r.temporal });
    return { ...r, stage, baseStage };
  });

  const scored = normalized
    .map((r) => {
      const s = scoreRegionForProfile(r, profile);
      const stability = r.temporal?.stabilityScore;
      const rcr = r.temporal?.recentChangeRate;

      // expected gain heuristic
      let expectedGain = 0.1;
      if (s.actionType === 'repair') expectedGain = 0.35;
      else if (s.actionType === 'refine') expectedGain = 0.25;
      else if (s.actionType === 'fill') expectedGain = 0.2;
      else if (s.actionType === 'protect') expectedGain = 0.18;
      else if (s.actionType === 'seed') expectedGain = 0.12;

      // reduce gain if very unstable (contested right now)
      if (stability != null && stability < 0.3) expectedGain *= 0.6;
      // increase gain if stable and nearly_done
      if (stability != null && stability > 0.85 && r.stage === 'nearly_done') expectedGain *= 1.2;

      const reasons = [...s.reasons];
      if (rcr != null) reasons.push(`rcr=${rcr.toFixed(4)}/s`);
      if (stability != null) reasons.push(`stability=${stability.toFixed(2)}`);
      if (r.baseStage !== r.stage) reasons.push(`temporalStage:->`);

      return {
        regionId: r.regionId,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        score: s.score,
        actionType: s.actionType,
        expectedGain,
        reasons,
        _region: r,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return scored.map(({ _region, ...rest }) => rest);
}

export function patchPlansFromCandidateActions({ candidateActions, maxPlans = 3 }) {
  // Phase 2 MVP patch planning: choose a smaller patch inside region.
  // - for repair/refine/protect: choose centered 16x16 patch
  // - for seed/fill: choose top-left 16x16 patch
  const plans = [];
  for (let i = 0; i < Math.min(maxPlans, candidateActions.length); i++) {
    const a = candidateActions[i];
    const size = 16;
    let px = a.x;
    let py = a.y;
    if (["repair", "refine", "protect"].includes(a.actionType)) {
      px = a.x + Math.floor((a.w - size) / 2);
      py = a.y + Math.floor((a.h - size) / 2);
    }

    plans.push({
      patchId: `${a.regionId}_p${i}`,
      x: px,
      y: py,
      w: Math.min(size, a.w),
      h: Math.min(size, a.h),
      actionType: a.actionType,
      expectedGain: a.expectedGain,
      reason: a.reasons.slice(0, 4),
    });
  }
  return plans;
}
