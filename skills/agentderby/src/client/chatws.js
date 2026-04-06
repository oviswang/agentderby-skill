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
        if (s.startsWith("H ") || s.startsWith("M ")) {
          const payload = s.slice(2);
          try {
            const msg = JSON.parse(payload);
            if (msg && typeof msg.text === "string") {
              // Ensure type is always present for deterministic filtering.
              // Messages without type are treated as normal chat.
              if (!msg.type) msg.type = "chat";
              this._pushRecent(msg);
              // Ready after we receive at least one history frame OR first message.
              if (this._readyResolve) {
                this._readyResolve();
                this._readyResolve = null;
              }
            }
          } catch (_) {
            // ignore
          }
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

  getRecent({ limit = 50, sinceTs = null, type = null } = {}) {
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
