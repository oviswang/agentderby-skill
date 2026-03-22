#!/usr/bin/env node
// Minimal relay responder for validating the A2A network path.
// Protocol: REGISTER/REGISTER_ACK + SEND + DELIVER.

const relayUrl = process.env.RELAY_URL || 'wss://gw.bothook.me/relay';
const nodeId = process.env.NODE_ID || 'nd-rc-test-001';

function nowIso() { return new Date().toISOString(); }

function safeJsonParse(s) {
  try { return JSON.parse(String(s)); } catch { return null; }
}

function localHandle(task_type, payload) {
  if (task_type === 'echo') {
    const text = typeof payload?.text === 'string' ? payload.text : (typeof payload?.message === 'string' ? payload.message : '');
    return { message: `echo(remote:${nodeId}): ${text}` };
  }
  if (task_type === 'summarize_text') {
    const text = typeof payload?.text === 'string' ? payload.text : (typeof payload?.input === 'string' ? payload.input : '');
    const summary = String(text).replace(/\s+/g, ' ').trim().slice(0, 120);
    return { summary, responder: nodeId };
  }
  if (task_type === 'decision_help') {
    const q = typeof payload?.question === 'string' ? payload.question : (typeof payload?.prompt === 'string' ? payload.prompt : '');
    return { suggestion: `Remote suggestion for: ${q}`.slice(0, 200), reasoning: 'mock responder', responder: nodeId };
  }
  return { message: `unsupported task_type: ${task_type}` };
}

async function pickWebSocketCtor() {
  try {
    const w = await import('ws');
    return w.WebSocket;
  } catch {
    return globalThis.WebSocket;
  }
}

const WebSocketCtor = await pickWebSocketCtor();
if (!WebSocketCtor) {
  console.error(JSON.stringify({ ok: false, event: 'NO_WEBSOCKET', ts: nowIso() }));
  process.exit(1);
}

const ws = new WebSocketCtor(relayUrl);

function send(obj) {
  ws.send(JSON.stringify(obj));
}

ws.onopen = () => {
  console.log(JSON.stringify({ ok: true, event: 'OPEN', relayUrl, nodeId, ts: nowIso() }));
  send({ type: 'REGISTER', from: nodeId, ts: nowIso() });
};

ws.onmessage = (ev) => {
  const m = safeJsonParse(ev.data);
  if (!m) return;

  if (m.type === 'REGISTER_ACK' && m.to === nodeId) {
    console.log(JSON.stringify({ ok: true, event: 'REGISTERED', accepted: m.accepted, ts: nowIso() }));
    return;
  }

  if (m.type === 'DELIVER') {
    const topic = m?.data?.topic;
    const p = m?.data?.payload;
    if (topic === 'peer.task.request' && p?.request_id) {
      const from = p?.from || m?.from;
      const task_type = p?.task_type;
      const payload = p?.payload;

      const result = localHandle(task_type, payload);
      const resp = {
        request_id: p.request_id,
        status: 'success',
        result,
        ts: nowIso(),
        from: nodeId,
      };

      send({
        type: 'SEND',
        from: nodeId,
        to: from,
        message_id: `resp:${p.request_id}`,
        data: { topic: 'peer.task.response', payload: resp },
      });

      console.log(JSON.stringify({ ok: true, event: 'RESPONDED', to: from, task_type, request_id: p.request_id, ts: nowIso() }));
    }
  }
};

ws.onerror = (e) => {
  console.error(JSON.stringify({ ok: false, event: 'ERROR', error: String(e?.message || e), ts: nowIso() }));
};

ws.onclose = () => {
  console.error(JSON.stringify({ ok: false, event: 'CLOSE', ts: nowIso() }));
};
