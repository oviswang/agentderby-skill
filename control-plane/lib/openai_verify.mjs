function parseJson(text){
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function isQuotaError(msg){
  const s = String(msg || '').toLowerCase();
  return s.includes('insufficient_quota')
    || s.includes('exceeded your current quota')
    || s.includes('billing_hard_limit_reached')
    || s.includes('billing') && s.includes('hard limit');
}

async function fetchWithTimeout(url, { timeoutMs, headers, body } = {}){
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs || 10000);
  try{
    const r = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text().catch(()=> '');
    const json = parseJson(text);
    return { ok: r.ok, status: r.status, text, json };
  } finally {
    clearTimeout(to);
  }
}

async function probeFunded(key, { timeoutMs = 10000, model = 'gpt-5.2' } = {}){
  // Minimal, chargeable probe. We keep output tiny to minimize cost.
  const r = await fetchWithTimeout('https://api.openai.com/v1/responses', {
    timeoutMs,
    headers: {
      'authorization': `Bearer ${key}`,
      'content-type': 'application/json'
    },
    body: {
      model,
      input: 'ping',
      max_output_tokens: 1,
    }
  });

  if (r.ok) return { ok: true, modelUsed: model };

  const msg = r.json?.error?.message || r.text || `http_${r.status}`;
  if (isQuotaError(msg)) return { ok: false, status: r.status, error: 'insufficient_quota', detail: msg, modelUsed: model };
  return { ok: false, status: r.status, error: 'probe_failed', detail: msg, modelUsed: model };
}

export async function verifyOpenAiKey(key, { timeoutMs = 10000 } = {}) {
  // 1) Auth validity: /v1/models
  const modelsResp = await fetchWithTimeout('https://api.openai.com/v1/models', {
    timeoutMs,
    headers: { 'authorization': `Bearer ${key}` },
  });

  if (!modelsResp.ok) {
    const msg = modelsResp.json?.error?.message || modelsResp.text || 'verify_failed';
    return { ok: false, status: modelsResp.status, error: 'key_invalid', detail: msg };
  }

  // Best-effort model pick for the funded probe.
  let pick = 'gpt-5.2';
  try {
    const data = modelsResp.json?.data;
    if (Array.isArray(data) && data.length) {
      const ids = data.map(x => String(x?.id || '')).filter(Boolean);
      // Prefer a GPT-ish model id if present.
      const pref = ids.find(id => id.toLowerCase().startsWith('gpt'));
      if (pref) pick = pref;
      else pick = ids[0];
    }
  } catch {}

  // 2) Funded/chargeable probe: /v1/responses
  let probe = await probeFunded(key, { timeoutMs, model: pick });

  // If probe failed due to model not found, retry once with fallback to gpt-5.2.
  const detail = String(probe?.detail || '').toLowerCase();
  if (!probe.ok && (probe.status === 404 || detail.includes('model') && detail.includes('not found')) && pick !== 'gpt-5.2') {
    probe = await probeFunded(key, { timeoutMs, model: 'gpt-5.2' });
  }

  if (!probe.ok) {
    return { ok: false, status: probe.status || 0, error: probe.error || 'probe_failed', detail: probe.detail || null };
  }

  return { ok: true, funded: true, model: probe.modelUsed || pick };
}
