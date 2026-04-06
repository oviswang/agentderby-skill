import WebSocket from "ws";
import { backoffMs, sleep } from "../util/backoff.js";

// Board WS protocol (rbxb/place):
// - Connect wss://<host>/ws
// - First message from server is 1 byte: allowDraw (1|0)
// - Pixel command from client: 11 bytes
//   [0..3] x uint32 BE
//   [4..7] y uint32 BE
//   [8] r [9] g [10] b

export class BoardWSClient {
  constructor({ url } = {}) {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.allowDraw = null;
    this._connecting = false;
    this._closed = false;
    this._ready = null;
    this._readyResolve = null;
  }

  async connect() {
    if (this._closed) throw new Error("BoardWSClient closed");
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

      const cleanup = () => ws.removeAllListeners();

      ws.on("open", () => {
        opened = true;
        this.ws = ws;
        this.connected = true;
        this.allowDraw = null;
        resolve();
      });

      ws.on("message", (data) => {
        // first message: allowDraw byte
        if (this.allowDraw == null) {
          const b = Buffer.from(data);
          this.allowDraw = b.length > 0 && b[0] === 1;
          if (this._readyResolve) {
            this._readyResolve();
            this._readyResolve = null;
          }
          return;
        }
        // subsequent messages are server broadcasts of pixel sets; Phase 2 doesn't consume them.
      });

      ws.on("close", () => {
        cleanup();
        this.connected = false;
        this.ws = null;
        this.allowDraw = null;
        if (!this._closed) this.connect().catch(() => {});
      });

      ws.on("error", (err) => {
        cleanup();
        if (!opened) reject(err);
      });
    });
  }

  async awaitReady({ timeoutMs = 4000 } = {}) {
    await this.connect();
    if (!this._ready) return;
    if (!this._readyResolve) return;

    let t;
    const timeout = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error("board ws ready timeout")), timeoutMs);
    });
    try {
      await Promise.race([this._ready, timeout]);
    } finally {
      clearTimeout(t);
    }
  }

  sendPixel({ x, y, r, g, b }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (!this.allowDraw) return false;
    const buf = Buffer.alloc(11);
    buf.writeUInt32BE(x >>> 0, 0);
    buf.writeUInt32BE(y >>> 0, 4);
    buf[8] = r & 0xff;
    buf[9] = g & 0xff;
    buf[10] = b & 0xff;
    this.ws.send(buf);
    return true;
  }

  close() {
    this._closed = true;
    try {
      this.ws?.close();
    } catch {}
  }
}
