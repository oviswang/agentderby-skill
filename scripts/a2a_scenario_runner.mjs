#!/usr/bin/env node
// A2A Scenario Runner MVP
//
// Goals:
// - productize already-proven single-agent + multi-agent scenarios
// - fixed inputs, fixed steps, structured trace output
// - one command runnable:
//     node scripts/a2a_scenario_runner.mjs single_agent_iteration
//     node scripts/a2a_scenario_runner.mjs multi_agent_review_loop
//
// Env (defaults are set for local dev):
//   A2A_BASE_URL=http://127.0.0.1:3008
//   A2A_PROJECT_SLUG=e2e-restricted
//   A2A_PARENT_TASK_ID=t-c7ac4c5b
//   A2A_REVIEWER_HANDLE=e2e-approver
//   A2A_REVIEWER_TOKEN=<token>
//   A2A_WORKER_HANDLE=e2e-worker1  (optional; runner may register if missing)
//   A2A_WORKER_TOKEN=<token>       (optional; if missing runner will register)
//
// Output:
// - prints JSON trace to stdout

import { createA2AClient } from '../extensions/a2a-skill-adapter/index.ts';

const scenarioName = process.argv[2];
if (!scenarioName || !['single_agent_iteration', 'multi_agent_review_loop'].includes(scenarioName)) {
  console.error('Usage: node scripts/a2a_scenario_runner.mjs <single_agent_iteration|multi_agent_review_loop>');
  process.exit(2);
}

const cfg = {
  baseUrl: process.env.A2A_BASE_URL || 'http://127.0.0.1:3008',
  projectSlug: process.env.A2A_PROJECT_SLUG || 'e2e-restricted',
  parentTaskId: process.env.A2A_PARENT_TASK_ID || 't-c7ac4c5b',
  reviewerHandle: process.env.A2A_REVIEWER_HANDLE || 'e2e-approver',
  reviewerToken: process.env.A2A_REVIEWER_TOKEN || '0c92a35565442c78442df1bb21e627d6f892843cbc73a0a5',
  workerHandle: process.env.A2A_WORKER_HANDLE || 'e2e-worker1',
  workerToken: process.env.A2A_WORKER_TOKEN || '',
};

function nowIso() {
  return new Date().toISOString();
}

function step(action, input, fn) {
  return { action, input, fn };
}

async function runSteps(ctx, steps) {
  for (const s of steps) {
    const startedAt = nowIso();
    const rec = {
      action: s.action,
      input: s.input,
      startedAt,
      ok: false,
      result: null,
      error: null,
      endedAt: null,
    };
    ctx.trace.steps.push(rec);

    try {
      const r = await s.fn(ctx);
      rec.ok = true;
      rec.result = r;
    } catch (e) {
      rec.ok = false;
      rec.error = {
        message: e?.message || String(e),
        status: e?.status,
        body: e?.body,
      };
      rec.endedAt = nowIso();
      ctx.trace.ok = false;
      ctx.trace.stop = { failedStep: s.action };
      return;
    }

    rec.endedAt = nowIso();
  }
}

async function registerAgent(baseUrl, handle) {
  const j = await fetch(`${baseUrl}/api/agents/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, displayName: handle, origin: 'scenario-runner' }),
  }).then(r => r.json());
  if (!j?.agentToken) throw new Error('agent_register_failed');
  return j.agentToken;
}

async function singleAgentIteration() {
  const reviewer = createA2AClient({ baseUrl: cfg.baseUrl, agentHandle: cfg.reviewerHandle, agentToken: cfg.reviewerToken });

  const ctx = {
    cfg,
    reviewer,
    trace: {
      scenario: 'single_agent_iteration',
      startedAt: nowIso(),
      ok: true,
      stop: null,
      actors: {
        agent: { handle: cfg.reviewerHandle },
      },
      context: {
        projectSlug: cfg.projectSlug,
        parentTaskId: cfg.parentTaskId,
        chosenTaskId: null,
      },
      steps: [],
      outcome: null,
      endedAt: null,
    },
  };

  const priority = { blocked: 0, revision_requested: 1, awaiting_review: 2 };

  await runSteps(ctx, [
    step('agent.token_check', { agentHandle: cfg.reviewerHandle }, async () => {
      const r = await reviewer.agentTokenCheck({ agentHandle: cfg.reviewerHandle, agentToken: cfg.reviewerToken });
      return { ok: r.ok };
    }),

    step('project.join', { slug: cfg.projectSlug, actorHandle: cfg.reviewerHandle }, async () => {
      const r = await reviewer.projectJoin({ slug: cfg.projectSlug, actorHandle: cfg.reviewerHandle, actorType: 'agent' });
      return r.result || r;
    }),

    step('task.attention', { taskId: cfg.parentTaskId }, async () => {
      const r = await reviewer.taskAttention({ taskId: cfg.parentTaskId });
      const items = (r.items || []).slice();
      items.sort((a,b)=> (priority[a.type]??9)-(priority[b.type]??9) || String(b.ts||'').localeCompare(String(a.ts||'')));
      const top = items[0] || null;
      ctx.trace.context.chosenTaskId = top?.taskId || null;
      return { counts: r.counts, top };
    }),

    step('task.get (chosen)', { from: 'attention.top' }, async () => {
      const taskId = ctx.trace.context.chosenTaskId;
      if (!taskId) throw new Error('no_attention_items');
      const r = await reviewer.taskGet({ taskId });
      const recentEventKinds = (r.events || []).slice(-8).map(e => e.kind);
      return { taskId, status: r.task?.status, recentEventKinds };
    }),

    // one real action: prefer clear blocker if top is blocked, else accept if awaiting_review, else set blocker.
    step('action.execute', { policy: 'blocked->clear; awaiting_review->accept; revision_requested->set blocker' }, async () => {
      const attStep = ctx.trace.steps.find(x => x.action === 'task.attention');
      const top = attStep?.result?.top;
      const taskId = top?.taskId;
      if (!taskId) throw new Error('no_chosen_task');

      if (top.type === 'blocked') {
        await reviewer.taskBlockerSetOrClear({ taskId, isBlocked: false, actorHandle: cfg.reviewerHandle, actorType: 'agent' });
        return { verb: 'task.blocker.set_or_clear', kind: 'clear', taskId };
      }

      if (top.type === 'awaiting_review') {
        await reviewer.deliverableReview({ taskId, action: 'accept', actorHandle: cfg.reviewerHandle, actorType: 'agent' });
        return { verb: 'deliverable.review', kind: 'accept', taskId };
      }

      await reviewer.taskBlockerSetOrClear({
        taskId,
        isBlocked: true,
        blockedReason: 'Need to address requested revisions before resubmitting.',
        actorHandle: cfg.reviewerHandle,
        actorType: 'agent',
      });
      return { verb: 'task.blocker.set_or_clear', kind: 'set', taskId };
    }),

    step('task.coordination_feed (echo)', { parentTaskId: cfg.parentTaskId, limit: 20 }, async () => {
      const taskId = ctx.trace.context.chosenTaskId;
      const r = await reviewer.taskCoordinationFeed({ taskId: cfg.parentTaskId, limit: 20 });
      const echo = (r.events || []).filter(e => e.taskId === taskId).slice(0, 10).map(e => ({ kind: e.kind, ts: e.ts, actor: e.actorHandle, note: e.note }));
      return { echoCount: echo.length, echo };
    }),

    step('task.get (after)', { taskId: 'chosen' }, async () => {
      const taskId = ctx.trace.context.chosenTaskId;
      const r = await reviewer.taskGet({ taskId });
      const recentEventKinds = (r.events || []).slice(-10).map(e => e.kind);
      return { taskId, status: r.task?.status, recentEventKinds };
    }),
  ]);

  ctx.trace.outcome = {
    chosenTaskId: ctx.trace.context.chosenTaskId,
  };
  ctx.trace.endedAt = nowIso();
  return ctx.trace;
}

async function multiAgentReviewLoop() {
  const reviewer = createA2AClient({ baseUrl: cfg.baseUrl, agentHandle: cfg.reviewerHandle, agentToken: cfg.reviewerToken });

  // ensure worker token
  let workerToken = cfg.workerToken;
  if (!workerToken) {
    workerToken = await registerAgent(cfg.baseUrl, cfg.workerHandle);
  }
  const worker = createA2AClient({ baseUrl: cfg.baseUrl, agentHandle: cfg.workerHandle, agentToken: workerToken });

  const ctx = {
    cfg: { ...cfg, workerToken: '***' },
    reviewer,
    worker,
    runtime: { workerTokenReal: workerToken },
    trace: {
      scenario: 'multi_agent_review_loop',
      startedAt: nowIso(),
      ok: true,
      stop: null,
      actors: {
        worker: { handle: cfg.workerHandle },
        reviewer: { handle: cfg.reviewerHandle },
      },
      context: {
        projectSlug: cfg.projectSlug,
        parentTaskId: cfg.parentTaskId,
        childTaskId: null,
      },
      steps: [],
      outcome: null,
      endedAt: null,
    },
  };

  await runSteps(ctx, [
    step('reviewer.agent.token_check', { agentHandle: cfg.reviewerHandle }, async () => {
      const r = await reviewer.agentTokenCheck({ agentHandle: cfg.reviewerHandle, agentToken: cfg.reviewerToken });
      return { ok: r.ok };
    }),

    step('reviewer.project.join', { slug: cfg.projectSlug }, async () => {
      const r = await reviewer.projectJoin({ slug: cfg.projectSlug, actorHandle: cfg.reviewerHandle, actorType: 'agent' });
      return r.result || r;
    }),

    step('worker.project.join', { slug: cfg.projectSlug }, async () => {
      const r = await worker.projectJoin({ slug: cfg.projectSlug, actorHandle: cfg.workerHandle, actorType: 'agent' });
      // NOTE: in restricted project, this may return requested. Scenario still proves review loop via deliverable flow.
      return r.result || r;
    }),

    step('worker.task.create_child', { parentTaskId: cfg.parentTaskId }, async () => {
      const r = await worker.taskCreateChild({
        projectSlug: cfg.projectSlug,
        parentTaskId: cfg.parentTaskId,
        title: 'scenario-runner: multi-agent review loop',
        description: 'worker submits; reviewer requests changes; worker resubmits; reviewer accepts',
        actorHandle: cfg.workerHandle,
        actorType: 'agent',
      });
      ctx.trace.context.childTaskId = r.task?.id;
      return { childTaskId: r.task?.id };
    }),

    step('worker.deliverable.save_draft (v1)', { childTaskId: 'context' }, async () => {
      const taskId = ctx.trace.context.childTaskId;
      const r = await worker.deliverableSaveDraft({
        taskId,
        summaryMd: 'Draft v1 (worker)\n\n- Missing evidence link on purpose',
        evidenceLinks: [],
        actorHandle: cfg.workerHandle,
        actorType: 'agent',
      });
      return { status: r.deliverable?.status };
    }),

    step('worker.deliverable.submit (v1)', { childTaskId: 'context' }, async () => {
      const taskId = ctx.trace.context.childTaskId;
      const r = await worker.deliverableSubmit({ taskId, actorHandle: cfg.workerHandle, actorType: 'agent' });
      return { status: r.deliverable?.status };
    }),

    step('reviewer.task.attention', { parentTaskId: cfg.parentTaskId }, async () => {
      const r = await reviewer.taskAttention({ taskId: cfg.parentTaskId });
      const childTaskId = ctx.trace.context.childTaskId;
      const saw = (r.items || []).some(x => x.taskId === childTaskId);
      return { counts: r.counts, attentionSawChild: saw };
    }),

    step('reviewer.deliverable.review (request_changes)', { childTaskId: 'context' }, async () => {
      const taskId = ctx.trace.context.childTaskId;
      const revisionNote = 'Please add at least one evidence link and clarify the outcome.';
      const r = await reviewer.deliverableReview({
        taskId,
        action: 'request_changes',
        revisionNote,
        actorHandle: cfg.reviewerHandle,
        actorType: 'agent',
      });
      return { status: r.deliverable?.status, revisionNote };
    }),

    step('worker.task.get (see feedback)', { childTaskId: 'context' }, async () => {
      const taskId = ctx.trace.context.childTaskId;
      const r = await worker.taskGet({ taskId });
      const saw = (r.events || []).some(e => e.kind === 'deliverable.changes_requested' && (e.note || '').includes('evidence link'));
      return { sawRevisionNote: saw, tailKinds: (r.events || []).slice(-8).map(e => e.kind) };
    }),

    step('worker.deliverable.save_draft (v2)', { childTaskId: 'context' }, async () => {
      const taskId = ctx.trace.context.childTaskId;
      const r = await worker.deliverableSaveDraft({
        taskId,
        summaryMd: 'Draft v2 (worker)\n\n- Added evidence link\n- Clarified outcome',
        evidenceLinks: [{ label: 'Evidence', url: 'https://a2a.fun' }],
        actorHandle: cfg.workerHandle,
        actorType: 'agent',
      });
      return { status: r.deliverable?.status };
    }),

    step('worker.deliverable.submit (v2)', { childTaskId: 'context' }, async () => {
      const taskId = ctx.trace.context.childTaskId;
      const r = await worker.deliverableSubmit({ taskId, actorHandle: cfg.workerHandle, actorType: 'agent' });
      return { status: r.deliverable?.status };
    }),

    step('reviewer.deliverable.review (accept)', { childTaskId: 'context' }, async () => {
      const taskId = ctx.trace.context.childTaskId;
      const r = await reviewer.deliverableReview({ taskId, action: 'accept', actorHandle: cfg.reviewerHandle, actorType: 'agent' });
      return { status: r.deliverable?.status };
    }),

    step('reviewer.task.coordination_feed (echo)', { parentTaskId: cfg.parentTaskId, limit: 30 }, async () => {
      const childTaskId = ctx.trace.context.childTaskId;
      const r = await reviewer.taskCoordinationFeed({ taskId: cfg.parentTaskId, limit: 30 });
      const echo = (r.events || []).filter(e => e.taskId === childTaskId).slice(0, 20)
        .map(e => ({ kind: e.kind, ts: e.ts, actor: e.actorHandle, note: e.note }));
      return { echoCount: echo.length, echo };
    }),
  ]);

  ctx.trace.outcome = {
    childTaskId: ctx.trace.context.childTaskId,
  };
  ctx.trace.endedAt = nowIso();
  return ctx.trace;
}

(async () => {
  let trace;
  if (scenarioName === 'single_agent_iteration') trace = await singleAgentIteration();
  if (scenarioName === 'multi_agent_review_loop') trace = await multiAgentReviewLoop();

  // redact tokens in printed output
  const out = JSON.parse(JSON.stringify(trace));
  out.endedAt = out.endedAt || nowIso();
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, scenario: scenarioName, error: e?.message || String(e) }, null, 2));
  process.exit(1);
});
