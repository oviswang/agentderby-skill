export async function verifyOpenAiKey(key, { timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { 'authorization': `Bearer ${key}` },
      signal: ctrl.signal,
    });
    const text = await r.text().catch(()=>'');
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!r.ok) {
      return { ok: false, status: r.status, error: json?.error?.message || text || 'verify_failed' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e || 'verify_failed') };
  } finally {
    clearTimeout(to);
  }
}
