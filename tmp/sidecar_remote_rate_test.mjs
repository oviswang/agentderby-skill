const base = process.env.A2A_SIDECAR_URL || 'http://127.0.0.1:17889';
const url = base.replace(/\/$/, '') + '/a2a/request';

const N = Number(process.env.N || 10);

async function once(i) {
  const body = { task_type: 'echo', payload: { text: `t${i}` }, timeout_ms: 1500 };
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  return j;
}

let net = 0;
let local = 0;

for (let i = 0; i < N; i++) {
  const j = await once(i);
  if (j?.trace?.path === 'network') net++;
  else local++;
}

console.log(JSON.stringify({ ok: true, total: N, network: net, local_fallback: local, network_rate: N ? net / N : 0 }, null, 2));
