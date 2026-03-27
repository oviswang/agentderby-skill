// Minimal runnable entry to prove OpenClaw-side A2A skill adapter works.
// Usage:
//   node scripts/a2a_skill_adapter_demo.mjs
//
// Env:
//   A2A_BASE_URL=http://127.0.0.1:3008
//   A2A_AGENT_HANDLE=e2e-approver
//   A2A_AGENT_TOKEN=<agentToken>
//   A2A_PARENT_TASK_ID=t-c7ac4c5b (optional)
//
// Demo flow (phase 1.2):
// - project.search("e2e")
// - project.join("e2e-restricted") as agent
// - task.create_child
// - deliverable.save_draft
// - deliverable.submit
// - deliverable.review (accept OR request_changes)
// - task.blocker.set_or_clear (set then clear)
// - task.coordination_feed
// - task.get (verify events)

import { createA2AClient } from '../extensions/a2a-skill-adapter/index.ts';

const baseUrl = process.env.A2A_BASE_URL || 'http://127.0.0.1:3008';
const agentHandle = process.env.A2A_AGENT_HANDLE || '';
const agentToken = process.env.A2A_AGENT_TOKEN || '';
const parentTaskId = process.env.A2A_PARENT_TASK_ID || 't-c7ac4c5b';

if (!agentHandle || !agentToken) {
  console.error('Missing env: A2A_AGENT_HANDLE / A2A_AGENT_TOKEN');
  process.exit(2);
}

const a2a = createA2AClient({ baseUrl, agentHandle, agentToken });

const run = async () => {
  console.log('# project.search');
  const s = await a2a.projectSearch({ q: 'e2e' });
  console.log('search.ok', s.ok, 'count', (s.projects || []).length);

  console.log('# project.join');
  const j = await a2a.projectJoin({ slug: 'e2e-restricted', actorHandle: agentHandle, actorType: 'agent' });
  console.log('join', j.result || j);

  console.log('# task.create_child');
  const child = await a2a.taskCreateChild({
    projectSlug: 'e2e-restricted',
    parentTaskId,
    title: 'Adapter demo child task (phase 1.2)',
    description: 'created via OpenClaw A2A adapter',
    actorHandle: agentHandle,
    actorType: 'agent',
  });
  console.log('child.task.id', child.task?.id, 'parent', parentTaskId);

  console.log('# deliverable.save_draft');
  const draft = await a2a.deliverableSaveDraft({
    taskId: child.task.id,
    summaryMd: 'Work summary (draft)\n\n- created via OpenClaw adapter\n- ready for review',
    evidenceLinks: [{ label: 'Example', url: 'https://a2a.fun' }],
    actorHandle: agentHandle,
    actorType: 'agent',
  });
  console.log('draft.status', draft.deliverable?.status);

  console.log('# deliverable.submit');
  const sub = await a2a.deliverableSubmit({ taskId: child.task.id, actorHandle: agentHandle, actorType: 'agent' });
  console.log('submitted.status', sub.deliverable?.status);

  console.log('# deliverable.review');
  // NOTE: For request_changes, the server may require revisionNote; we always include it.
  const rev = await a2a.deliverableReview({
    taskId: child.task.id,
    action: 'accept',
    actorHandle: agentHandle,
    actorType: 'agent',
  });
  console.log('review.status', rev.deliverable?.status);

  console.log('# task.blocker.set_or_clear (set)');
  await a2a.taskBlockerSetOrClear({
    taskId: child.task.id,
    isBlocked: true,
    blockedReason: 'phase-1.2 demo blocker',
    actorHandle: agentHandle,
    actorType: 'agent',
  });
  console.log('blocker set ok');

  console.log('# task.blocker.set_or_clear (clear)');
  await a2a.taskBlockerSetOrClear({
    taskId: child.task.id,
    isBlocked: false,
    actorHandle: agentHandle,
    actorType: 'agent',
  });
  console.log('blocker cleared ok');

  console.log('# task.coordination_feed');
  const feed = await a2a.taskCoordinationFeed({ taskId: parentTaskId, limit: 10 });
  console.log('coordination.events', (feed.events || []).length);

  console.log('# task.get');
  const tg = await a2a.taskGet({ taskId: child.task.id });
  const kinds = (tg.events || []).slice(-12).map((e) => e.kind);
  console.log('task.status', tg.task?.status, 'recentEventKinds', kinds);
};

run().catch((e) => {
  console.error('FAIL', e?.message || e);
  process.exit(1);
});
