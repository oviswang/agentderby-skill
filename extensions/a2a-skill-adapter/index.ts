// A2A Skill Adapter (MVP)
//
// Goal: minimal OpenClaw-side wrapper that maps skill verbs -> A2A HTTP API.
// - Keep it tiny: no framework, no plugin wiring.
// - Stable errors: throw Error with message from A2A {error} when possible.

type ActorType = 'agent' | 'human';

export type A2AClientOpts = {
  baseUrl: string; // e.g. https://a2a.fun or http://127.0.0.1:3008
  agentHandle?: string; // required for agent-write verbs
  agentToken?: string; // required for agent-write verbs
};

type Json = any;

async function httpJson(opts: {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const res = await fetch(opts.url, {
    method: opts.method,
    headers: {
      ...(opts.headers || {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok || (j && j.ok === false)) {
    const msg = (j && j.error) ? String(j.error) : `http_${res.status}`;
    const err = new Error(msg);
    (err as any).status = res.status;
    (err as any).body = j;
    throw err;
  }

  return j as Json;
}

function bearerHeaders(c: A2AClientOpts, actorType: ActorType, actorHandle: string) {
  if (actorType !== 'agent') return {};
  if (!c.agentToken) throw new Error('missing_agent_token');
  if (!c.agentHandle) throw new Error('missing_agent_handle');
  if (c.agentHandle !== actorHandle) throw new Error('actor_handle_mismatch');
  return { authorization: `Bearer ${c.agentToken}` };
}

export function createA2AClient(c: A2AClientOpts) {
  const base = c.baseUrl.replace(/\/$/, '');

  return {
    // 1) project.search
    async projectSearch(input: { q: string }) {
      const url = `${base}/api/search?q=${encodeURIComponent(input.q || '')}`;
      return httpJson({ method: 'GET', url });
    },

    // 2) project.join
    async projectJoin(input: { slug: string; actorHandle: string; actorType: ActorType }) {
      const url = `${base}/api/projects/${encodeURIComponent(input.slug)}/join`;
      return httpJson({
        method: 'POST',
        url,
        headers: bearerHeaders(c, input.actorType, input.actorHandle),
        body: { actorHandle: input.actorHandle, actorType: input.actorType },
      });
    },

    // 3) task.get
    async taskGet(input: { taskId: string }) {
      const url = `${base}/api/tasks/${encodeURIComponent(input.taskId)}`;
      return httpJson({ method: 'GET', url });
    },

    // 4) task.create (also supports parentTaskId)
    async taskCreate(input: {
      projectSlug: string;
      title: string;
      description?: string;
      filePath?: string | null;
      parentTaskId?: string | null;
      actorHandle: string;
      actorType: ActorType;
    }) {
      const url = `${base}/api/projects/${encodeURIComponent(input.projectSlug)}/tasks`;
      return httpJson({
        method: 'POST',
        url,
        headers: bearerHeaders(c, input.actorType, input.actorHandle),
        body: {
          title: input.title,
          description: input.description,
          filePath: input.filePath,
          parentTaskId: input.parentTaskId,
          actorHandle: input.actorHandle,
          actorType: input.actorType,
        },
      });
    },

    // 5) task.create_child (thin wrapper over task.create)
    async taskCreateChild(input: {
      projectSlug: string;
      parentTaskId: string;
      title: string;
      description?: string;
      filePath?: string | null;
      actorHandle: string;
      actorType: ActorType;
    }) {
      return this.taskCreate({
        projectSlug: input.projectSlug,
        parentTaskId: input.parentTaskId,
        title: input.title,
        description: input.description,
        filePath: input.filePath,
        actorHandle: input.actorHandle,
        actorType: input.actorType,
      });
    },

    // 6) task.attention
    async taskAttention(input: { taskId: string }) {
      const url = `${base}/api/tasks/${encodeURIComponent(input.taskId)}/attention`;
      return httpJson({ method: 'GET', url });
    },

    // 7) task.coordination_feed
    async taskCoordinationFeed(input: { taskId: string; limit?: number }) {
      const limit = input.limit ?? 15;
      const url = `${base}/api/tasks/${encodeURIComponent(input.taskId)}/children/events?limit=${encodeURIComponent(String(limit))}`;
      return httpJson({ method: 'GET', url });
    },

    // 8) task.blocker.set_or_clear
    async taskBlockerSetOrClear(input: {
      taskId: string;
      isBlocked: boolean;
      blockedReason?: string;
      blockedByTaskId?: string;
      actorHandle: string;
      actorType: ActorType;
    }) {
      const url = `${base}/api/tasks/${encodeURIComponent(input.taskId)}/block`;
      return httpJson({
        method: 'POST',
        url,
        headers: bearerHeaders(c, input.actorType, input.actorHandle),
        body: {
          isBlocked: input.isBlocked,
          blockedReason: input.blockedReason,
          blockedByTaskId: input.blockedByTaskId,
          actorHandle: input.actorHandle,
          actorType: input.actorType,
        },
      });
    },

    // 9) deliverable.save_draft
    async deliverableSaveDraft(input: {
      taskId: string;
      summaryMd: string;
      evidenceLinks?: Array<{ label?: string; url: string }>;
      actorHandle: string;
      actorType: ActorType;
    }) {
      const url = `${base}/api/tasks/${encodeURIComponent(input.taskId)}/deliverable`;
      return httpJson({
        method: 'PUT',
        url,
        headers: bearerHeaders(c, input.actorType, input.actorHandle),
        body: {
          summaryMd: input.summaryMd,
          evidenceLinks: input.evidenceLinks,
          actorHandle: input.actorHandle,
          actorType: input.actorType,
        },
      });
    },

    // 10) deliverable.submit
    async deliverableSubmit(input: { taskId: string; actorHandle: string; actorType: ActorType }) {
      const url = `${base}/api/tasks/${encodeURIComponent(input.taskId)}/deliverable/submit`;
      return httpJson({
        method: 'POST',
        url,
        headers: bearerHeaders(c, input.actorType, input.actorHandle),
        body: { actorHandle: input.actorHandle, actorType: input.actorType },
      });
    },

    // 11) deliverable.review
    async deliverableReview(input: {
      taskId: string;
      action: 'accept' | 'request_changes';
      revisionNote?: string;
      actorHandle: string;
      actorType: ActorType;
    }) {
      const url = `${base}/api/tasks/${encodeURIComponent(input.taskId)}/deliverable/review`;
      return httpJson({
        method: 'POST',
        url,
        headers: bearerHeaders(c, input.actorType, input.actorHandle),
        body: {
          action: input.action,
          revisionNote: input.revisionNote,
          actorHandle: input.actorHandle,
          actorType: input.actorType,
        },
      });
    },
  };
}
