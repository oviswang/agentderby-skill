import WebSocket from "ws";
import { backoffMs, sleep } from "../util/backoff.js";

// ChatWS protocol (current backend):
// - history frames: "H " + JSON
// - message frames: "M " + JSON

const _globalClients = globalThis.__agentderby_chatws_clients || (globalThis.__agentderby_chatws_clients = new Map());
const _nextClientId = (() => {
  const k = "__agentderby_chatws_next_id";
  globalThis[k] = globalThis[k] || 1;
  return () => globalThis[k]++;
})();

function _ringPush(arr, item, cap = 50) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

export class ChatWSClient {
  static getShared({ url, maxRecent = 200 } = {}) {
    const key = String(url || "");
    if (!key) throw new Error("chatws url required");

    const existing = _globalClients.get(key);
    if (existing && !existing._closed) {
      existing._sharedKey = key;
      existing._wasReused = true;
      return existing;
    }

    const c = new ChatWSClient({ url: key, maxRecent });
    c._sharedKey = key;
    c._wasReused = false;
    _globalClients.set(key, c);
    return c;
  }

  constructor({ url, maxRecent = 200 } = {}) {
    this.url = url;
    this.maxRecent = maxRecent;

    // TEMP TRACE identity
    this.clientId = `chatws_${_nextClientId()}`;
    this._sharedKey = null;
    this._wasReused = null;

    // TEMP TRACE rings
    this._writeTrace = [];
    this._readTrace = [];

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
    // Backend protocol may stream messages via H frames continuously.

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
            // Observed protocol on affected instances: H is the active message stream
            // and M may be absent entirely. Therefore treat H as a valid incoming
            // message update.
            //
            // Rules:
            // - snapshot forms (array / {messages:[...]} / {history:[...]}) -> append each item
            // - single-message object -> append

            const snap = this._normalizeHistorySnapshot(parsed);
            if (snap.length) {
              for (const m of snap) this._pushRecent(m, { kind: "H" });
            } else if (parsed && typeof parsed.text === "string") {
              if (!parsed.type) parsed.type = "chat";
              this._pushRecent(parsed, { kind: "H" });
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
            this._pushRecent(msg, { kind: "M" });
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

  _pushRecent(msg, meta = null) {
    this.recent.push(msg);
    if (this.recent.length > this.maxRecent) {
      this.recent = this.recent.slice(this.recent.length - this.maxRecent);
    }

    // TEMP TRACE: record write
    const latestChatTs = Math.max(...this.recent.filter((m) => (m?.type || "chat") === "chat").map((m) => m.ts || 0), 0) || 0;
    const latestIntentTs = Math.max(...this.recent.filter((m) => (m?.type || "chat") === "intent").map((m) => m.ts || 0), 0) || 0;
    _ringPush(this._writeTrace, {
      at: Date.now(),
      clientId: this.clientId,
      kind: meta?.kind || null,
      type: msg?.type || null,
      ts: msg?.ts || null,
      appended: true,
      recentLen: this.recent.length,
      latestChatTs,
      latestIntentTs,
    }, 50);
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

    // TEMP TRACE: record read
    const latestChatTs = Math.max(...this.recent.filter((m) => (m?.type || "chat") === "chat").map((m) => m.ts || 0), 0) || 0;
    const latestIntentTs = Math.max(...this.recent.filter((m) => (m?.type || "chat") === "intent").map((m) => m.ts || 0), 0) || 0;
    const retMaxTs = Math.max(...xs.map((m) => m.ts || 0), 0) || 0;
    _ringPush(this._readTrace, {
      at: Date.now(),
      clientId: this.clientId,
      sharedKey: this._sharedKey,
      readyState: this.ws ? this.ws.readyState : null,
      connected: !!this.connected,
      recentLen: this.recent.length,
      latestChatTs,
      latestIntentTs,
      filter: { limit, sinceTs, type },
      retCount: xs.length,
      retMaxTs,
    }, 50);

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
