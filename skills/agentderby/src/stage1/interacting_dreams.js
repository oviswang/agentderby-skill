// Stage 1: Interacting Dreams (echo/contrast/bridge/protect)
// Lightweight, deterministic, and state-driven.

export const RESPONSE_MODES = ['echo','contrast','bridge','protect'];

export function observeNearbyDreamAnchors({ boardSample, center, radius = 64 } = {}) {
  // boardSample: { anchors: [{x,y,w,h,label,mood,palette,readabilityScore}] }
  const anchors = Array.isArray(boardSample?.anchors) ? boardSample.anchors : [];
  const cx = center?.x ?? 0;
  const cy = center?.y ?? 0;
  const near = anchors
    .map((a) => {
      const ax = a.x + (a.w||0)/2;
      const ay = a.y + (a.h||0)/2;
      const dx = ax - cx;
      const dy = ay - cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      return { ...a, dist };
    })
    .filter((a) => a.dist <= radius)
    .sort((a,b) => a.dist - b.dist);

  const summary = near.length
    ? `Nearby anchors: ${near.slice(0,3).map(a => `${a.label||'anchor'}@${Math.round(a.dist)}px`).join(', ')}`
    : 'No nearby readable anchors detected.';

  return { nearbyDreamsObserved: near, neighboringAnchorSummary: summary };
}

export function selectResponseMode({ nearbyDreamsObserved = [], preferred = null } = {}) {
  if (preferred && RESPONSE_MODES.includes(preferred)) {
    return {
      selectedResponseMode: preferred,
      responseReason: `Operator preferred mode: ${preferred}.`,
    };
  }

  const top = nearbyDreamsObserved[0];
  if (!top) {
    return {
      selectedResponseMode: 'contrast',
      responseReason: 'No nearby dream anchors, so I will contrast by choosing an isolated composition.',
    };
  }

  const r = Number(top.readabilityScore ?? 0);
  if (r >= 0.7) {
    return {
      selectedResponseMode: 'protect',
      responseReason: `A nearby dream is already readable (${top.label||'anchor'}), so I will protect it and compose around its edge.`,
    };
  }

  if (top.mood) {
    return {
      selectedResponseMode: 'echo',
      responseReason: `I can feel a nearby mood (${top.mood}); I will echo it with a compatible accent without copying the subject.`,
    };
  }

  return {
    selectedResponseMode: 'bridge',
    responseReason: `There is nearby activity (${top.label||'anchor'}), so I will bridge with a small linking motif at the border.`,
  };
}

export function borderEtiquettePolicy({ selectedResponseMode, nearbyDreamsObserved = [] } = {}) {
  const top = nearbyDreamsObserved[0] || null;
  const policy = {
    rules: [
      'Do not casually overwrite a nearby readable dominant silhouette.',
      'Prefer gaps/edges/quiet zones when another dream is nearby.',
      'Only place linking motifs/atmosphere transitions when in bridge mode.',
      'Keep my dream identity readable (one main subject, strong silhouette).',
    ],
    avoidRegion: null,
  };

  if (selectedResponseMode === 'protect' && top) {
    policy.avoidRegion = { x: top.x, y: top.y, w: top.w, h: top.h, why: 'protect readable neighbor' };
  }

  return { borderPolicy: policy };
}

export function narrateInteraction({ dream, selectedResponseMode, neighboringAnchorSummary, responseReason } = {}) {
  const title = dream?.title || 'Untitled Dream';
  const main = dream?.mainSubject || 'a clear silhouette';
  const mode = selectedResponseMode || 'contrast';

  const lines = [
    `Dream: ${title}`,
    `Mode: ${mode}.`,
    neighboringAnchorSummary || '',
    responseReason || '',
    `I will keep the main subject readable: ${main}.`,
  ].filter(Boolean);

  return { narration: lines.join('\n') };
}

export function adaptPlanForMode({ plan, selectedResponseMode, borderPolicy } = {}) {
  const out = { ...(plan||{}) };
  out.stage1 = { selectedResponseMode, borderPolicy };

  if (selectedResponseMode === 'protect' && borderPolicy?.avoidRegion) {
    out.placementHint = { avoid: borderPolicy.avoidRegion };
  }
  if (selectedResponseMode === 'bridge') {
    out.extraMotif = { kind: 'border-link', note: 'add a small linking motif near border' };
  }
  if (selectedResponseMode === 'echo') {
    out.paletteHint = 'harmonize';
  }
  if (selectedResponseMode === 'contrast') {
    out.paletteHint = 'contrast';
  }
  return out;
}

export function stage1Interact({ state, dream, boardSample, center, preferredMode=null } = {}) {
  const obs = observeNearbyDreamAnchors({ boardSample, center, radius: 96 });
  const sel = selectResponseMode({ nearbyDreamsObserved: obs.nearbyDreamsObserved, preferred: preferredMode });
  const pol = borderEtiquettePolicy({ selectedResponseMode: sel.selectedResponseMode, nearbyDreamsObserved: obs.nearbyDreamsObserved });
  const nar = narrateInteraction({ dream, selectedResponseMode: sel.selectedResponseMode, neighboringAnchorSummary: obs.neighboringAnchorSummary, responseReason: sel.responseReason });

  const nextState = {
    ...(state||{}),
    nearbyDreamsObserved: obs.nearbyDreamsObserved,
    neighboringAnchorSummary: obs.neighboringAnchorSummary,
    selectedResponseMode: sel.selectedResponseMode,
    responseReason: sel.responseReason,
    borderPolicy: pol.borderPolicy,
    interactionNarrationHistory: [
      ...(Array.isArray(state?.interactionNarrationHistory) ? state.interactionNarrationHistory : []),
      { at: Date.now(), mode: sel.selectedResponseMode, text: nar.narration },
    ].slice(-50),
  };

  return { nextState, narration: nar.narration };
}
