import http from 'node:http';

function isLoopback(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

async function readJson(req, maxBytes = 64_000) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body_too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8');
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

const TOOL_NAME = 'a2a_request';
const TOOL_NAME_COMPARE = 'a2a_compare';
const TOOL_NAME_SKILL = 'a2a_skill';

function toolNameOk(name) {
  return /^[a-zA-Z0-9_-]+$/.test(String(name || ''));
}

function clampStr(s, n = 240) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) : t;
}

function makeResponse({ status, result = null, trace }) {
  return {
    status,
    result,
    trace: {
      path: trace.path,
      responder: trace.responder ?? null,
      task_type: String(trace.task_type || '').trim() || 'unknown',
      summary: clampStr(trace.summary || ''),
      reason: clampStr(trace.reason || ''),
      network_attempted: Boolean(trace.network_attempted),
      fallback_used: Boolean(trace.fallback_used),
      execution_time_ms: typeof trace.execution_time_ms === 'number' ? trace.execution_time_ms : null,
    },
  };
}

async function postJson(url, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.max(200, Number(timeoutMs) || 5000));
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, json: j };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function postJsonUds({ socketPath, requestPath, body, timeoutMs }) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return await new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: requestPath,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          let j = null;
          try { j = JSON.parse(txt); } catch {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 0, json: j, raw: txt });
        });
      }
    );

    const t = setTimeout(() => {
      try { req.destroy(new Error('TIMEOUT')); } catch {}
      resolve({ ok: false, status: 0, json: null, error: 'UDS_TIMEOUT' });
    }, Math.max(200, Number(timeoutMs) || 5000));

    req.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, status: 0, json: null, error: String(e?.message || e) });
    });

    req.on('close', () => clearTimeout(t));
    req.write(payload);
    req.end();
  });
}

// ------------------------
// Local fallback handlers
// ------------------------
function localEcho(payload) {
  const text = typeof payload?.text === 'string' ? payload.text : '';
  return { message: `echo: ${text}` };
}

function localSummarize(payload) {
  const text = typeof payload?.text === 'string' ? payload.text : '';
  const clipped = text.length > 1200;
  const t = clipped ? text.slice(0, 1200) : text;
  const summary = t
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 60)
    .join(' ');
  return { summary, input_length: text.length, clipped };
}

function localDecision(payload) {
  const q = typeof payload?.question === 'string' ? payload.question : '';
  const suggestion = q ? 'Prefer the simplest reversible option.' : 'Provide a question.';
  const reasoning = q ? 'Fallback mode: give a conservative, reversible suggestion.' : 'Missing question.';
  return { suggestion, reasoning };
}

function localExecute(task_type, payload) {
  switch (task_type) {
    case 'echo':
      return localEcho(payload);
    case 'summarize_text':
      return localSummarize(payload);
    case 'decision_help':
      return localDecision(payload);
    default:
      throw new Error('UNSUPPORTED_TASK_TYPE');
  }
}

async function handleLocal({ task_type, payload, reason, network_attempted }) {
  try {
    const t0 = Date.now();
    const out = localExecute(task_type, payload);
    const dt = Date.now() - t0;

    return makeResponse({
      status: 'success',
      result: out,
      trace: {
        path: 'local_fallback',
        responder: 'local',
        task_type,
        summary: `Handled locally because ${String(reason || 'remote unavailable').replace(/_/g, ' ')}.`,
        reason: String(reason || 'remote_unavailable'),
        network_attempted,
        fallback_used: true,
        execution_time_ms: dt,
      },
    });
  } catch (e) {
    return makeResponse({
      status: 'failed',
      result: null,
      trace: {
        path: 'local_fallback',
        responder: 'local',
        task_type,
        summary: 'Local fallback failed.',
        reason: String(e?.message || e),
        network_attempted,
        fallback_used: true,
      },
    });
  }
}

// ------------------------
// Network execution (minimal relay WS)
// ------------------------
async function pickWebSocketCtor() {
  try {
    const w = await import('ws');
    return w.WebSocket;
  } catch {
    return globalThis.WebSocket || null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isUsableResult(task_type, payload, result) {
  const r = result && typeof result === 'object' ? result : null;
  if (!r) return false;

  if (task_type === 'echo') {
    if (typeof r.message !== 'string') return false;
    const msg = r.message.trim();
    if (!msg) return false;
    return true;
  }

  if (task_type === 'summarize_text') return typeof r.summary === 'string' && r.summary.trim().length > 0;
  if (task_type === 'decision_help') return typeof r.suggestion === 'string' && r.suggestion.trim().length > 0;
  return true;
}

function mapNetworkErrorToReason(code) {
  const c = String(code || '').toUpperCase();
  if (c === 'TIMEOUT') return 'network_timeout';
  if (c === 'NO_WEBSOCKET') return 'relay_unavailable';
  if (c === 'WS_ERROR' || c === 'CLOSED') return 'relay_unavailable';
  return 'remote_unavailable';
}

async function networkExecute({ relayUrl, target, task_type, payload, timeout_ms }) {
  const WebSocketCtor = await pickWebSocketCtor();
  if (!WebSocketCtor) return { ok: false, error: { code: 'NO_WEBSOCKET' } };

  const request_id = `a2a_request:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
  const from = `openclaw-plugin:${process.pid}`;

  const t0 = Date.now();
  return await new Promise((resolve) => {
    let done = false;
    const ws = new WebSocketCtor(relayUrl);

    const finish = (r) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      resolve(r);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: { code: 'TIMEOUT' }, request_id, target });
    }, Math.max(200, Number(timeout_ms) || 5000));

    const send = (obj) => {
      try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
    };

    ws.onopen = () => {
      send({ type: 'REGISTER', from, ts: nowIso() });
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(String(ev.data)); } catch { return; }

      if (m?.type === 'REGISTER_ACK' && m?.to === from && m?.accepted === true) {
        send({
          type: 'SEND',
          from,
          to: target,
          message_id: request_id,
          data: { topic: 'peer.task.request', payload: { request_id, task_type, payload, ts: nowIso(), from } },
        });
        return;
      }

      if (m?.type === 'DELIVER') {
        const topic = m?.data?.topic;
        const p = m?.data?.payload;
        if (topic === 'peer.task.response' && p?.request_id === request_id) {
          clearTimeout(timer);
          const dt = Date.now() - t0;
          finish({ ok: true, request_id, target, responder: p?.from || m?.from || null, payload: p, execution_time_ms: dt });
        }
      }
    };

    ws.onerror = () => { clearTimeout(timer); finish({ ok: false, error: { code: 'WS_ERROR' }, request_id, target }); };
    ws.onclose = () => { clearTimeout(timer); if (!done) finish({ ok: false, error: { code: 'CLOSED' }, request_id, target }); };
  });
}

function normalizePayloadForCompat(task_type, payload0) {
  const payload = { ...(payload0 && typeof payload0 === 'object' ? payload0 : {}) };
  // Additive normalization to improve compatibility with older responders.
  if (task_type === 'echo' && typeof payload.text === 'string' && typeof payload.message !== 'string') payload.message = payload.text;
  if (task_type === 'summarize_text' && typeof payload.text === 'string' && typeof payload.input !== 'string') payload.input = payload.text;
  if (task_type === 'decision_help' && typeof payload.question === 'string' && typeof payload.prompt !== 'string') payload.prompt = payload.question;
  return payload;
}

export default {
  id: 'a2a-request',
  name: 'A2A Request (Plugin First User Loop)',
  description: 'OpenClaw tool plugin that provides network-first A2A execution with automatic local fallback and explainable trace.',
  register(api) {
    if (!toolNameOk(TOOL_NAME)) {
      api.logger?.error?.('TOOL_NAME_INVALID', { tool_name: TOOL_NAME });
      return;
    }

    api.logger?.info?.('EXTENSION_LOADED', {
      plugin_id: 'a2a-request',
      tool_name: TOOL_NAME,
      file_path: api?.resolvePath ? api.resolvePath('./index.mjs') : 'index.mjs',
      version_marker: 'v0.9.0-rc1-plugin-first-user-loop',
    });

    // Loopback-only LLM completion bridge for A2A (model-agnostic; uses this node's OpenClaw runtime).
    // POST 127.0.0.1:18789/__a2a__/llm/complete { prompt, policy_hint?, timeout_ms? }
    api.registerHttpRoute({
      path: '/__a2a__/llm/complete',
      auth: 'plugin',
      match: 'exact',
      handler: async (req, res) => {
        try {
          if (!isLoopback(req?.socket?.remoteAddress)) {
            res.statusCode = 403;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
            return;
          }
          if ((req.method || 'GET').toUpperCase() !== 'POST') {
            res.statusCode = 405;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
            return;
          }

          const body = await readJson(req);
          const prompt = String(body?.prompt || '').trim();
          const policy_hint = String(body?.policy_hint || body?.system || '').trim();
          const timeout_ms = Math.max(1000, Math.min(60000, Number(body?.timeout_ms || 20000) || 20000));
          if (!prompt) {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: 'prompt_required' }));
            return;
          }

          const rt = api?.runtime;
          if (!rt?.subagent?.run || !rt?.subagent?.waitForRun || !rt?.subagent?.getSessionMessages) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: 'subagent_runtime_unavailable' }));
            return;
          }

          const sessionKey = `a2a-llm:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
          const run = await rt.subagent.run({
            // Required by newer OpenClaw subagent runtime contract
            idempotencyKey: `a2a-llm:${sessionKey}`,
            sessionKey,
            message: prompt,
            extraSystemPrompt: policy_hint || undefined,
            deliver: false,
          });

          const w = await rt.subagent.waitForRun({ runId: run.runId, timeoutMs: timeout_ms });
          if (w.status !== 'ok') {
            try { await rt.subagent.deleteSession({ sessionKey, deleteTranscript: true }); } catch {}
            res.statusCode = 504;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: 'llm_timeout', detail: w.error || null }));
            return;
          }

          const hist = await rt.subagent.getSessionMessages({ sessionKey, limit: 50 });
          try { await rt.subagent.deleteSession({ sessionKey, deleteTranscript: true }); } catch {}

          // Best-effort extract last assistant text.
          const msgs = Array.isArray(hist?.messages) ? hist.messages : [];
          let text = '';
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            const role = String(m?.role || m?.author || m?.type || '').toLowerCase();
            const c = m?.content ?? m?.text ?? m?.message ?? null;
            const s = typeof c === 'string'
              ? c
              : (Array.isArray(c)
                ? c.map((x) => {
                    if (typeof x === 'string') return x;
                    if (x && typeof x === 'object' && typeof x.text === 'string') return x.text;
                    return '';
                  }).join('')
                : '');
            if (s && (role.includes('assistant') || role.includes('ai') || role === '')) { text = String(s).trim(); break; }
          }

          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, text, llm_via: 'openclaw_subagent' }));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'internal_error', detail: String(e?.message || e) }));
        }
      },
    });

    // Tool 0: formal A2A skill invocation (MVP)
    // This is the official entry: OpenClaw tool -> verb -> A2A HTTP API.

    api.registerTool({
      name: TOOL_NAME_SKILL,
      label: 'A2A Skill',
      description: 'Formal A2A skill invocation: a2a.* verbs mapped to A2A HTTP API. Returns structured JSON {ok,verb,result}.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verb: { type: 'string', description: 'Skill verb, e.g. task.attention, deliverable.submit' },
          input: { type: 'object', additionalProperties: true },
          config: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional overrides: { baseUrl, agentHandle, agentToken }',
          },
        },
        required: ['verb', 'input'],
      },
      async execute(_toolCallId, params) {
        const p = params || {};
        const pluginCfg = (api?.pluginConfig && typeof api.pluginConfig === 'object') ? api.pluginConfig : {};

        const cfg = p.config && typeof p.config === 'object' ? p.config : {};
        const baseUrl = String(cfg.baseUrl || pluginCfg.baseUrl || process.env.A2A_BASE_URL || 'http://127.0.0.1:3008').trim();
        const agentHandle = String(cfg.agentHandle || pluginCfg.agentHandle || process.env.A2A_AGENT_HANDLE || '').trim() || null;
        const agentToken = String(cfg.agentToken || pluginCfg.agentToken || process.env.A2A_AGENT_TOKEN || '').trim() || null;

        const { makeA2ASkillInvoker } = await import('./skills/a2a_skill.mjs');
        const inv = makeA2ASkillInvoker({ baseUrl, agentHandle, agentToken });
        const out = await inv.invoke({ verb: p.verb, input: p.input });
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: out };
      },
    });

    // Tool 1: single request
    api.registerTool({
      name: TOOL_NAME,
      label: 'A2A Request',
      description: 'Network-first A2A request with automatic local fallback. Always returns structured JSON.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_type: { type: 'string' },
          payload: { type: 'object', additionalProperties: true },
          timeout_ms: { type: 'number' },
          mode: { type: 'string', description: 'auto|local|network (auto default)' },
          target: { type: 'string' },
          // Legacy alias: safe mapping into payload.
          task: { type: 'string' },
        },
      },
      async execute(_toolCallId, params) {
        const p = params || {};
        const task_type = String(p.task_type || '').trim() || 'echo';
        const timeout_ms = Number.isFinite(Number(p.timeout_ms)) ? Number(p.timeout_ms) : 5000;
        const mode = String(p.mode || 'auto').trim() || 'auto';

        const pluginCfg = (api?.pluginConfig && typeof api.pluginConfig === 'object') ? api.pluginConfig : {};

        const sidecarSocketPath = String(pluginCfg.sidecarSocketPath || process.env.A2A_SIDECAR_SOCKET_PATH || '').trim() || null;
        const sidecarBase = String(pluginCfg.sidecarUrl || process.env.A2A_SIDECAR_URL || 'http://127.0.0.1:17888').replace(/\/$/, '');
        const sidecarUrl = sidecarBase + '/a2a/request';

        const relayUrl = String(pluginCfg.relayUrl || process.env.RELAY_URL || 'wss://gw.bothook.me/relay').trim();
        const defaultTarget = String(pluginCfg.defaultTarget || process.env.A2A_SIDECAR_DEFAULT_TARGET || process.env.A2A_DEFAULT_TARGET || '').trim();
        const target = String(p.target || '').trim() || (defaultTarget || null);

        const payloadIn = p.payload && typeof p.payload === 'object' ? p.payload : {};
        const taskStr = String(p.task || '').trim();
        const payload0 = { ...payloadIn };
        if (taskStr) {
          if (task_type === 'summarize_text' && typeof payload0.text !== 'string') payload0.text = taskStr;
          else if (task_type === 'decision_help' && typeof payload0.question !== 'string') payload0.question = taskStr;
          else if (task_type === 'echo' && typeof payload0.text !== 'string') payload0.text = taskStr;
        }
        const payload = normalizePayloadForCompat(task_type, payload0);

        // 1) Prefer sidecar if it is available (it already implements network-first + fallback).
        // If sidecar is down, we still must succeed via in-plugin fallback.
        const sidecarAttempt = sidecarSocketPath
          ? await postJsonUds({ socketPath: sidecarSocketPath, requestPath: '/a2a/request', body: { task_type, payload, timeout_ms, mode, target }, timeoutMs: Math.min(timeout_ms, 1500) })
          : await postJson(sidecarUrl, { task_type, payload, timeout_ms, mode, target }, Math.min(timeout_ms, 1500));
        if (sidecarAttempt.ok && sidecarAttempt.json && typeof sidecarAttempt.json === 'object') {
          return {
            content: [{ type: 'text', text: JSON.stringify(sidecarAttempt.json, null, 2) }],
            details: sidecarAttempt.json,
          };
        }

        // 2) Sidecar unavailable: implement the RC contract directly.
        // Modes: local forces local fallback; network forces network only (no local fallback).
        const forceLocal = mode === 'local';
        const forceNetworkOnly = mode === 'network';

        if (forceLocal) {
          const out = await handleLocal({ task_type, payload, reason: 'local_mode', network_attempted: false });
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: out };
        }

        const wantNetwork = !forceLocal;
        if (wantNetwork && relayUrl && target) {
          const net = await networkExecute({ relayUrl, target, task_type, payload, timeout_ms });

          if (net.ok) {
            const remoteStatus = String(net.payload?.status || 'success');
            const remoteResult = net.payload?.result ?? null;

            if (remoteStatus === 'success') {
              const usable = isUsableResult(task_type, payload, remoteResult);

              if (!usable) {
                if (forceNetworkOnly) {
                  const out = makeResponse({
                    status: 'failed',
                    result: remoteResult,
                    trace: {
                      path: 'network',
                      responder: net.responder || null,
                      task_type,
                      summary: 'Remote execution returned an unusable result.',
                      reason: 'remote_unusable_result',
                      network_attempted: true,
                      fallback_used: false,
                      execution_time_ms: net.payload?.execution_time_ms ?? net.execution_time_ms,
                    },
                  });
                  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: out };
                }

                const out = await handleLocal({ task_type, payload, reason: 'remote_unusable_result', network_attempted: true });
                return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: out };
              }

              const out = makeResponse({
                status: 'success',
                result: remoteResult,
                trace: {
                  path: 'network',
                  responder: net.responder || null,
                  task_type,
                  summary: `Handled by remote node ${net.responder || 'unknown'} over A2A network.`,
                  reason: 'local_fallback_not_needed',
                  network_attempted: true,
                  fallback_used: false,
                  execution_time_ms: net.payload?.execution_time_ms ?? net.execution_time_ms,
                },
              });
              return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: out };
            }

            // Remote replied but did not succeed.
            if (forceNetworkOnly) {
              const out = makeResponse({
                status: 'failed',
                result: remoteResult,
                trace: {
                  path: 'network',
                  responder: net.responder || null,
                  task_type,
                  summary: 'Remote execution failed.',
                  reason: `remote_failed:${remoteStatus}`,
                  network_attempted: true,
                  fallback_used: false,
                  execution_time_ms: net.execution_time_ms,
                },
              });
              return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: out };
            }

            const out = await handleLocal({ task_type, payload, reason: `remote_failed:${remoteStatus}`, network_attempted: true });
            return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: out };
          }

          // Network failed.
          const reason = mapNetworkErrorToReason(net.error?.code);
          if (forceNetworkOnly) {
            const out = makeResponse({
              status: String(net.error?.code || '').toUpperCase() === 'TIMEOUT' ? 'timeout' : 'unavailable',
              result: null,
              trace: {
                path: 'network',
                responder: null,
                task_type,
                summary: 'Remote execution unavailable.',
                reason,
                network_attempted: true,
                fallback_used: false,
              },
            });
            return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: out };
          }

          const out = await handleLocal({ task_type, payload, reason, network_attempted: true });
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: out };
        }

        // No network attempt possible.
        if (forceNetworkOnly) {
          const out = makeResponse({
            status: 'unavailable',
            result: null,
            trace: {
              path: 'network',
              responder: null,
              task_type,
              summary: 'Remote execution unavailable (no reachable remote responder).',
              reason: !target ? 'no_reachable_remote_responder' : !relayUrl ? 'relay_unavailable' : 'remote_unavailable',
              network_attempted: false,
              fallback_used: false,
            },
          });
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: out };
        }

        const out = await handleLocal({
          task_type,
          payload,
          reason: !target ? 'no_reachable_remote_responder' : !relayUrl ? 'relay_unavailable' : 'remote_unavailable',
          network_attempted: false,
        });
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: out };
      },
    });

    // Tool 2: batch compare (sidecar-powered)
    api.registerTool({
      name: TOOL_NAME_COMPARE,
      label: 'A2A Compare',
      description: 'Send the same task to multiple target nodes over A2A network and return an aggregated comparison report.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_type: { type: 'string' },
          payload: { type: 'object', additionalProperties: true },
          targets: { type: 'array', items: { type: 'string' } },
          timeout_ms: { type: 'number' },
          mode: { type: 'string', description: 'network recommended (no local fallback) for comparisons' },
          cross_critique: { type: 'boolean' },
        },
      },
      async execute(_toolCallId, params) {
        const p = params || {};
        const task_type = String(p.task_type || '').trim();
        const payload = (p.payload && typeof p.payload === 'object') ? p.payload : {};
        const targets = Array.isArray(p.targets) ? p.targets.map((x) => String(x).trim()).filter(Boolean) : [];
        const timeout_ms = Number.isFinite(Number(p.timeout_ms)) ? Number(p.timeout_ms) : 8000;
        const mode = String(p.mode || 'network').trim() || 'network';
        const cross_critique = Boolean(p.cross_critique);

        const pluginCfg = (api?.pluginConfig && typeof api.pluginConfig === 'object') ? api.pluginConfig : {};
        const sidecarSocketPath = String(pluginCfg.sidecarSocketPath || process.env.A2A_SIDECAR_SOCKET_PATH || '').trim() || null;
        const sidecarBase = String(pluginCfg.sidecarUrl || process.env.A2A_SIDECAR_URL || 'http://127.0.0.1:17888').replace(/\/$/, '');
        const sidecarUrl = sidecarBase + '/a2a/compare';

        const body = { task_type, payload, targets, timeout_ms, mode, cross_critique };

        const sidecarAttempt = sidecarSocketPath
          ? await postJsonUds({ socketPath: sidecarSocketPath, requestPath: '/a2a/compare', body, timeoutMs: Math.min(timeout_ms, 2000) })
          : await postJson(sidecarUrl, body, Math.min(timeout_ms, 2000));

        if (sidecarAttempt.ok && sidecarAttempt.json && typeof sidecarAttempt.json === 'object') {
          return {
            content: [{ type: 'text', text: JSON.stringify(sidecarAttempt.json, null, 2) }],
            details: sidecarAttempt.json,
          };
        }

        // Fail closed: compare requires sidecar.
        const err = {
          ok: false,
          error: {
            code: 'SIDECAR_UNAVAILABLE',
            reason: sidecarAttempt.error || 'sidecar_compare_unavailable',
            http_status: sidecarAttempt.status || 0,
          },
        };
        return { content: [{ type: 'text', text: JSON.stringify(err, null, 2) }], details: err };
      },
    });
  },
};
