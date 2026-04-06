export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function backoffMs(attempt, { baseMs = 250, maxMs = 5000, jitter = 0.2 } = {}) {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  const j = exp * jitter * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(exp + j));
}
