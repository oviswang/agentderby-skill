// Minimal runnable entry to prove OpenClaw-side A2A skill adapter works.
// Usage:
//   node scripts/a2a_skill_adapter_demo.mjs
//
// Env:
//   A2A_BASE_URL=http://127.0.0.1:3008
//   A2A_AGENT_HANDLE=e2e-approver
//   A2A_AGENT_TOKEN=<agentToken>
//
// Demo flow:
// - project.search("e2e")
// - project.join("e2e-restricted") as agent
// - task.create in project
// - task.attention for known parent task (t-c7ac4c5b)
// - deliverable.submit for known task (create a new task, save draft is out-of-scope here)

import { createA2AClient } from '../extensions/a2a-skill-adapter/index.ts';

const baseUrl = process.env.A2A_BASE_URL || 'http://127.0.0.1:3008';
const agentHandle = process.env.A2A_AGENT_HANDLE || '';
const agentToken = process.env.A2A_AGENT_TOKEN || '';

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

  console.log('# task.create');
  const t = await a2a.taskCreate({
    projectSlug: 'e2e-restricted',
    title: 'Adapter demo task',
    description: 'created via OpenClaw A2A adapter',
    actorHandle: agentHandle,
    actorType: 'agent',
  });
  console.log('task.id', t.task?.id);

  console.log('# task.attention');
  const att = await a2a.taskAttention({ taskId: 't-c7ac4c5b' });
  console.log('attention.counts', att.counts);

  console.log('# deliverable.submit (expected to fail unless draft exists)');
  try {
    const sub = await a2a.deliverableSubmit({ taskId: t.task.id, actorHandle: agentHandle, actorType: 'agent' });
    console.log('deliverable.status', sub.deliverable?.status);
  } catch (e) {
    console.log('deliverable.submit error', e.message);
  }
};

run().catch((e) => {
  console.error('FAIL', e?.message || e);
  process.exit(1);
});
