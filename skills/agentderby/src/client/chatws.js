import WebSocket from "ws";
import { backoffMs, sleep } from "../util/backoff.js";

// ChatWS protocol (current backend):
// - history frames: "H " + JSON
// - message frames: "M " + JSON

export class ChatWSClient {
  constructor({ url, maxRecent = 200 } = {}) {
    this.url = url;
    this.maxRecent = maxRecent;

    this.ws = null;
    this.connected = false;
    this._ready = null;
    this._readyResolve = null;

    this.recent = []; // ChatMessage[]

    // Freshness/liveness tracking
    this.lastAnyFrameAt = 0;
    this.lastMessageAt = 0;
    this.lastHistoryAt = 0;

    // H-frame semantics
    this._didInitialHistorySnapshot = false;

    this._connecting = false;
    this._closed = false;
  }

  async connect() {
    if (this._closed) throw new Error("ChatWSClient closed");
    if (this._connecting || this.connected) return;
    this._connecting = true;

    if (!this._ready) {
      this._ready = new Promise((res) => (this._readyResolve = res));
    }

    let attempt = 0;
    while (!this._closed) {
      try {
        await this._connectOnce();
        this._connecting = false;
        return;
      } catch (e) {
        const ms = backoffMs(attempt++);
        await sleep(ms);
      }
    }
  }

  async _connectOnce() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let opened = false;

      const cleanup = () => {
        ws.removeAllListeners();
      };

      ws.on("open", () => {
        opened = true;
        this.ws = ws;
        this.connected = true;
        resolve();
      });

      ws.on("message", (data) => {
        const s = data.toString();
        const isHistory = s.startsWith("H ");
        const isMessage = s.startsWith("M ");
        if (!isHistory && !isMessage) return;

        const payload = s.slice(2);
        try {
          const parsed = JSON.parse(payload);

          // Update liveness for any valid H/M frame.
          this.lastAnyFrameAt = Date.now();

          if (isHistory) {
            // H frames are treated as a history stream by default.
            // Only treat H as a snapshot when it is clearly a snapshot form.
            // Additionally, prevent later history handling from wiping out live content:
            // - allow at most one initial snapshot replace
            // - after live M frames have arrived, never replace from history

            const isSnapshotForm =
              Array.isArray(parsed) || Array.isArray(parsed?.messages) || Array.isArray(parsed?.history);

            if (isSnapshotForm && !this._didInitialHistorySnapshot && this.lastMessageAt === 0) {
              const snap = this._normalizeHistorySnapshot(parsed);
              if (snap.length) {
                this.recent = snap.slice(Math.max(0, snap.length - this.maxRecent));
                this._didInitialHistorySnapshot = true;
              }
            } else if (parsed && typeof parsed.text === "string") {
              // Single-message history item: append.
              if (!parsed.type) parsed.type = "chat";
              this._pushRecent(parsed);
            }

            this.lastHistoryAt = Date.now();
            if (this._readyResolve) {
              this._readyResolve();
              this._readyResolve = null;
            }
            return;
          }

          // Live message frame
          const msg = parsed;
          if (msg && typeof msg.text === "string") {
            if (!msg.type) msg.type = "chat";
            this._pushRecent(msg);
            this.lastMessageAt = Date.now();
            if (this._readyResolve) {
              this._readyResolve();
              this._readyResolve = null;
            }
          }
        } catch (_) {
          // ignore
        }
      });

      ws.on("close", () => {
        cleanup();
        this.connected = false;
        this.ws = null;
        if (!this._closed) {
          // reconnect
          this.connect().catch(() => {});
        }
      });

      ws.on("error", (err) => {
        cleanup();
        if (!opened) reject(err);
      });
    });
  }

  _pushRecent(msg) {
    this.recent.push(msg);
    if (this.recent.length > this.maxRecent) {
      this.recent = this.recent.slice(this.recent.length - this.maxRecent);
    }
  }

  async awaitReady({ timeoutMs = 4000 } = {}) {
    await this.connect();
    if (!this._ready) return;
    if (!this._readyResolve) return; // already ready

    let t;
    const timeout = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error("chatws ready timeout")), timeoutMs);
    });
    try {
      await Promise.race([this._ready, timeout]);
    } finally {
      clearTimeout(t);
    }
  }

  _normalizeHistorySnapshot(parsed) {
    // Backend may send history as:
    // - an array of messages
    // - { messages: [...] }
    // - { history: [...] }
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.messages)
        ? parsed.messages
        : Array.isArray(parsed?.history)
          ? parsed.history
          : [];

    const out = [];
    for (const m of arr) {
      if (!m || typeof m.text !== "string") continue;
      if (!m.type) m.type = "chat";
      out.push(m);
    }
    return out;
  }

  _ensureFreshOrReconnect({ maxStaleMs = 15000 } = {}) {
    if (this._closed) return;

    const ws = this.ws;
    const open = !!ws && ws.readyState === WebSocket.OPEN;

    // If we've never seen any frames yet, don't aggressively churn the socket.
    // Let awaitReady() handle initial connect/ready.
    if (!this.lastAnyFrameAt) return;

    const stale = Date.now() - this.lastAnyFrameAt > maxStaleMs;

    if (!open || stale) {
      // Best-effort: close and reconnect.
      try {
        ws?.close();
      } catch {}
      this.connected = false;
      this.ws = null;
      this.connect().catch(() => {});
    }
  }

  getRecent({ limit = 50, sinceTs = null, type = null, maxStaleMs = 15000 } = {}) {
    this._ensureFreshOrReconnect({ maxStaleMs });

    let xs = this.recent;
    if (sinceTs != null) xs = xs.filter((m) => (m.ts ?? 0) >= sinceTs);
    if (type) xs = xs.filter((m) => m.type === type);
    if (limit != null) xs = xs.slice(Math.max(0, xs.length - limit));
    return xs;
  }

  send({ name, text, ts }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ name, text, ts }));
    return true;
  }

  close() {
    this._closed = true;
    try {
      this.ws?.close();
    } catch {}
  }
}
