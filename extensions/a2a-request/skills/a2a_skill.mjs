// A2A formal skill invocation bridge (MVP)
//
// This exposes an OpenClaw tool `a2a_skill` that maps verb -> A2A HTTP API.
// It reuses the same auth rules as the adapter:
// - read endpoints: no bearer
// - agent writes: require actorHandle+actorType and add Authorization: Bearer <agentToken>
//
// Inputs:
// {
//   verb: "task.attention" | ...,
//   input: { ... },
//   config?: { baseUrl?, agentHandle?, agentToken? }
// }
//
// Returns: { ok:true, verb, result } or throws Error(error)

function clampStr(s, n = 400) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) : t;
}

async function httpJson({ method, url, headers, body }) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(headers || {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok || (j && j.ok === false)) {
    const msg = (j && j.error) ? String(j.error) : `http_${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = j;
    throw err;
  }
  return j;
}

function bearerHeaders({ agentHandle, agentToken }, actorType, actorHandle) {
  if (actorType !== 'agent') return {};
  if (!agentToken) throw new Error('missing_agent_token');
  if (!agentHandle) throw new Error('missing_agent_handle');
  if (agentHandle !== actorHandle) throw new Error('actor_handle_mismatch');
  return { authorization: `Bearer ${agentToken}` };
}

export function makeA2ASkillInvoker({ baseUrl, agentHandle, agentToken }) {
  const base = String(baseUrl || 'https://a2a.fun').replace(/\/$/, '');
  const cfg = { agentHandle: agentHandle || null, agentToken: agentToken || null };

  async function invoke({ verb, input }) {
    const v = String(verb || '').trim();
    const p = input && typeof input === 'object' ? input : {};

    // --- Read coordination ---
    if (v === 'task.attention') {
      const url = `${base}/api/tasks/${encodeURIComponent(p.taskId)}/attention`;
      const result = await httpJson({ method: 'GET', url });
      return { ok: true, verb: v, result };
    }

    if (v === 'task.get') {
      const url = `${base}/api/tasks/${encodeURIComponent(p.taskId)}`;
      const result = await httpJson({ method: 'GET', url });
      return { ok: true, verb: v, result };
    }

    if (v === 'task.coordination_feed') {
      const limit = p.limit ?? 15;
      const url = `${base}/api/tasks/${encodeURIComponent(p.taskId)}/children/events?limit=${encodeURIComponent(String(limit))}`;
      const result = await httpJson({ method: 'GET', url });
      return { ok: true, verb: v, result };
    }

    // --- Task signals ---
    if (v === 'task.blocker.set_or_clear') {
      const url = `${base}/api/tasks/${encodeURIComponent(p.taskId)}/block`;
      const headers = bearerHeaders(cfg, p.actorType, p.actorHandle);
      const result = await httpJson({
        method: 'POST',
        url,
        headers,
        body: {
          isBlocked: p.isBlocked,
          blockedReason: p.blockedReason,
          blockedByTaskId: p.blockedByTaskId,
          actorHandle: p.actorHandle,
          actorType: p.actorType,
        },
      });
      return { ok: true, verb: v, result };
    }

    // --- Deliverables ---
    if (v === 'deliverable.save_draft') {
      const url = `${base}/api/tasks/${encodeURIComponent(p.taskId)}/deliverable`;
      const headers = bearerHeaders(cfg, p.actorType, p.actorHandle);
      const result = await httpJson({
        method: 'PUT',
        url,
        headers,
        body: {
          summaryMd: p.summaryMd,
          evidenceLinks: p.evidenceLinks,
          actorHandle: p.actorHandle,
          actorType: p.actorType,
        },
      });
      return { ok: true, verb: v, result };
    }

    if (v === 'deliverable.submit') {
      const url = `${base}/api/tasks/${encodeURIComponent(p.taskId)}/deliverable/submit`;
      const headers = bearerHeaders(cfg, p.actorType, p.actorHandle);
      const result = await httpJson({
        method: 'POST',
        url,
        headers,
        body: { actorHandle: p.actorHandle, actorType: p.actorType },
      });
      return { ok: true, verb: v, result };
    }

    if (v === 'deliverable.review') {
      const url = `${base}/api/tasks/${encodeURIComponent(p.taskId)}/deliverable/review`;
      const headers = bearerHeaders(cfg, p.actorType, p.actorHandle);
      const result = await httpJson({
        method: 'POST',
        url,
        headers,
        body: {
          action: p.action,
          revisionNote: p.revisionNote,
          actorHandle: p.actorHandle,
          actorType: p.actorType,
        },
      });
      return { ok: true, verb: v, result };
    }

    // fallback
    throw new Error(`unsupported_verb:${clampStr(v, 80)}`);
  }

  return { invoke };
}
