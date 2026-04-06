// Simple spacing-based rate limiter for Phase 2.
// Ensures at least `minIntervalMs` between sends.

export class SpacingLimiter {
  constructor({ minIntervalMs = 250 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this._nextAt = 0;
  }

  async wait() {
    const now = Date.now();
    const t = Math.max(now, this._nextAt);
    const delay = t - now;
    this._nextAt = t + this.minIntervalMs;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
}
