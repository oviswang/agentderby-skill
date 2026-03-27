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
// Demo flow (phase 1.1):
// - project.search("e2e")
// - project.join("e2e-restricted") as agent
// - task.create_child (fallback -> task.create)
// - deliverable.save_draft
// - deliverable.submit
// - task.get (verify events)
// - task.attention (parent)

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

  let child;
  console.log('# task.create_child');
  try {
    child = await a2a.taskCreateChild({
      projectSlug: 'e2e-restricted',
      parentTaskId,
      title: 'Adapter demo child task',
      description: 'child created via OpenClaw A2A adapter',
      actorHandle: agentHandle,
      actorType: 'agent',
    });
    console.log('child.task.id', child.task?.id, 'parent', parentTaskId);
  } catch (e) {
    console.log('task.create_child fallback -> task.create (reason:', e.message + ')');
    child = await a2a.taskCreate({
      projectSlug: 'e2e-restricted',
      title: 'Adapter demo task (no parent)',
      description: 'fallback: parent not found/accessible',
      actorHandle: agentHandle,
      actorType: 'agent',
    });
    console.log('task.id', child.task?.id);
  }

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

  console.log('# task.get');
  const tg = await a2a.taskGet({ taskId: child.task.id });
  const kinds = (tg.events || []).slice(-8).map((e) => e.kind);
  console.log('task.status', tg.task?.status, 'recentEventKinds', kinds);

  console.log('# task.attention (parent)');
  const att = await a2a.taskAttention({ taskId: parentTaskId });
  console.log('attention.counts', att.counts);
};

run().catch((e) => {
  console.error('FAIL', e?.message || e);
  process.exit(1);
});
