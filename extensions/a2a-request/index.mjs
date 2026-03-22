const TOOL_NAME = 'a2a_request';

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
        const sidecarAttempt = await postJson(sidecarUrl, { task_type, payload, timeout_ms, mode, target }, Math.min(timeout_ms, 1500));
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
  },
};
