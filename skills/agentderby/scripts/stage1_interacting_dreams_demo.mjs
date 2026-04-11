import { stage1 } from '../src/index.js';

const state = { interactionNarrationHistory: [] };
const dream = {
  title: 'The Whale and the Streetlight',
  mainSubject: 'a whale silhouette under a warm light cone',
};

// Forced nearby anchor scenario
const boardSample = {
  anchors: [
    { x: 96, y: 80, w: 64, h: 64, label: 'moon-tower', mood: 'silver hush', palette: ['#0b1020','#c9d4ff'], readabilityScore: 0.82 },
    { x: 10, y: 10, w: 20, h: 20, label: 'noise', mood: null, palette: [], readabilityScore: 0.1 },
  ]
};

const center = { x: 128, y: 96 };
const { nextState, narration } = stage1.stage1Interact({ state, dream, boardSample, center });

const adaptedPlan = stage1.adaptPlanForMode({
  plan: { region: { x: 160, y: 96, w: 64, h: 64 } },
  selectedResponseMode: nextState.selectedResponseMode,
  borderPolicy: nextState.borderPolicy,
});

console.log(JSON.stringify({
  observed: nextState.nearbyDreamsObserved.map(a => ({label:a.label, dist:a.dist, readabilityScore:a.readabilityScore})),
  selectedResponseMode: nextState.selectedResponseMode,
  responseReason: nextState.responseReason,
  neighboringAnchorSummary: nextState.neighboringAnchorSummary,
  borderPolicy: nextState.borderPolicy,
  narration,
  adaptedPlan,
  persistedStateKeys: Object.keys(nextState).sort(),
}, null, 2));
