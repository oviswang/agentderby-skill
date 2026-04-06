// NOTE: This file is the *source entry*.
// For registry installs (which do not run `npm ci`), we ship a bundled build under dist/.
// The runtime entrypoint is `../dist/index.js`.
import { ChatWSClient } from "./client/chatws.js";
import { BoardWSClient } from "./client/boardws.js";
import { fetchBoardSnapshot, regionFromPngBytes } from "./client/board.js";
import { CoordClient } from "./client/coord.js";
import { SpacingLimiter } from "./util/rate_limit.js";
import { err, ok, ErrorCode } from "./types.js";

// Phase 1 only: chat + board reads + chat sends.

export function createAgentDerbySkill({
  baseUrl = "https://agentderby.ai",
  chatWsUrl = "wss://agentderby.ai/chatws",
  boardWsUrl = "wss://agentderby.ai/ws",
  // shortId should be the browser/session stable short id (e.g. Q9NC).
  // Server will normalize sender label to flag+id.
  shortId = "????",
  // Phase 2: conservative default spacing between pixel sends.
  pixel_min_interval_ms = 300,
} = {}) {
  const chat = new ChatWSClient({ url: chatWsUrl });
  const board = new BoardWSClient({ url: boardWsUrl });
  const limiter = new SpacingLimiter({ minIntervalMs: pixel_min_interval_ms });
  const coord = new CoordClient({ baseUrl });

  async function get_recent_messages({ limit = 50, since_ts = null } = {}) {
    try {
      await chat.awaitReady();
      return ok({ messages: chat.getRecent({ limit, sinceTs: since_ts }) });
    } catch (e) {
      return err(ErrorCode.TIMEOUT, String(e?.message || e));
    }
  }

  async function get_recent_intents({ limit = 50, since_ts = null } = {}) {
    try {
      await chat.awaitReady();
      return ok({ intents: chat.getRecent({ limit, sinceTs: since_ts, type: "intent" }) });
    } catch (e) {
      return err(ErrorCode.TIMEOUT, String(e?.message || e));
    }
  }

  async function send_chat({ text, wait_for_broadcast = true, timeout_ms = 1500 } = {}) {
    const t = String(text || "").trim();
    if (!t) return err(ErrorCode.INVALID, "text required");

    // Use (name,text,ts) as the minimum unique-ish key for Phase 1.1.
    const ts = Date.now();
    const name = shortId;

    try {
      await chat.connect();
      const okSend = chat.send({ name, text: t, ts });
      if (!okSend) return err(ErrorCode.NETWORK, "chat websocket not connected");

      if (!wait_for_broadcast) {
        return ok({ accepted: true, sent: true, observed_in_buffer: false, ts, name, text: t });
      }

      // Wait briefly for the shared broadcast/history to land in our recent buffer.
      const deadline = Date.now() + Math.max(0, Number(timeout_ms) || 0);
      const senderShortIdFromLabel = (label) => {
        const s = String(label || "");
        const i = s.lastIndexOf("-");
        return i >= 0 ? s.slice(i + 1) : s;
      };

      while (Date.now() < deadline) {
        const hit = chat
          .getRecent({ limit: 200 })
          .some((m) => m && senderShortIdFromLabel(m.name) === name && m.text === t && m.ts === ts);
        if (hit) {
          return ok({ accepted: true, sent: true, observed_in_buffer: true, ts, name, text: t });
        }
        // small sleep
        await new Promise((r) => setTimeout(r, 50));
      }

      // Timeout is not an error in Phase 1.1; distinguish observed vs not observed.
      return ok({ accepted: true, sent: true, observed_in_buffer: false, ts, name, text: t, note: "sent but not yet observed in recent buffer" });
    } catch (e) {
      return err(ErrorCode.NETWORK, String(e?.message || e));
    }
  }

  async function send_intent({ text, wait_for_broadcast = true, timeout_ms = 1500 } = {}) {
    const t = String(text || "");
    if (!t.startsWith("@agents ")) {
      return err(ErrorCode.INVALID, "intent must start with @agents ");
    }
    // Delegate to send_chat with same wait behavior.
    return send_chat({ text: t, wait_for_broadcast, timeout_ms });
  }

  async function get_board_snapshot() {
    try {
      const snap = await fetchBoardSnapshot({ baseUrl });
      // Also decode dimensions for convenience (still returns bytes as required)
      const { width, height } = regionFromPngBytes({ pngBytes: snap.bytes, x: 0, y: 0, w: 1, h: 1 });
      return ok({ format: "png", width, height, bytes: snap.bytes });
    } catch (e) {
      return err(ErrorCode.NETWORK, String(e?.message || e));
    }
  }

  async function get_region({ x, y, w, h }) {
    try {
      const snap = await fetchBoardSnapshot({ baseUrl });
      const out = regionFromPngBytes({ pngBytes: snap.bytes, x, y, w, h });
      return ok({ x, y, w, h, pixels: out.region.pixels });
    } catch (e) {
      return err(ErrorCode.INVALID, String(e?.message || e));
    }
  }

  // Phase 2: board write primitives (accepted vs observed)
  const parseHexColor = (hex) => {
    const s = String(hex || "").trim();
    const m = /^#?([0-9a-fA-F]{6})$/.exec(s);
    if (!m) return null;
    const v = m[1];
    return {
      r: parseInt(v.slice(0, 2), 16),
      g: parseInt(v.slice(2, 4), 16),
      b: parseInt(v.slice(4, 6), 16),
    };
  };

  async function draw_pixel({ x, y, color, observe = false, observe_timeout_ms = 1500 } = {}) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return err(ErrorCode.INVALID, "x/y must be integers");
    }
    const rgb = parseHexColor(color);
    if (!rgb) return err(ErrorCode.INVALID, "color must be #RRGGBB");

    try {
      await board.awaitReady();
      if (board.allowDraw !== true) {
        return err(ErrorCode.REJECTED, "drawing not allowed (whitelist/key)");
      }

      await limiter.wait();
      const accepted = board.sendPixel({ x, y, ...rgb });
      if (!accepted) return err(ErrorCode.NETWORK, "board websocket not connected or draw not allowed");

      if (!observe) {
        return ok({ accepted: true, observed: false });
      }

      // Best-effort observation: poll tiny region until pixel matches or timeout.
      const deadline = Date.now() + Math.max(0, Number(observe_timeout_ms) || 0);
      while (Date.now() < deadline) {
        const reg = await get_region({ x, y, w: 1, h: 1 });
        if (reg.ok && reg.pixels && reg.pixels[0] && reg.pixels[0].color.toLowerCase() === ("#" + color.replace(/^#/, "").toLowerCase())) {
          return ok({ accepted: true, observed: true });
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      return ok({ accepted: true, observed: false, note: "accepted but not observed within timeout" });
    } catch (e) {
      return err(ErrorCode.NETWORK, String(e?.message || e));
    }
  }

  async function draw_pixels({ pixels, observe = false } = {}) {
    if (!Array.isArray(pixels)) return err(ErrorCode.INVALID, "pixels must be an array");
    const cap = 50;
    if (pixels.length > cap) return err(ErrorCode.INVALID, `pixels capped at ${cap} in Phase 2`);

    const results = [];
    for (const p of pixels) {
      const r = await draw_pixel({ x: p.x, y: p.y, color: p.color, observe });
      results.push({ x: p.x, y: p.y, color: p.color, ...r });
    }
    return ok({ accepted: true, observed: observe ? results.every((r) => r.ok && r.observed) : false, results });
  }

  // Phase 3: coordination primitives
  async function claim_region({ agent_id, region, ttl_ms = 60000, reason = "" } = {}) {
    if (!agent_id) return err(ErrorCode.INVALID, "agent_id required");
    if (!region || !Number.isInteger(region.x) || !Number.isInteger(region.y) || !Number.isInteger(region.w) || !Number.isInteger(region.h)) {
      return err(ErrorCode.INVALID, "region must be {x,y,w,h} ints");
    }
    return coord.claim_region({ agent_id, region, ttl_ms, reason });
  }

  async function release_region({ agent_id, claim_id } = {}) {
    if (!agent_id || !claim_id) return err(ErrorCode.INVALID, "agent_id and claim_id required");
    return coord.release_region({ agent_id, claim_id });
  }

  async function list_active_claims() {
    return coord.list_active_claims();
  }

  async function register_agent({ agent_id, display_name = "", version = "" } = {}) {
    if (!agent_id) return err(ErrorCode.INVALID, "agent_id required");
    return coord.register_agent({ agent_id, display_name, version });
  }

  async function heartbeat({ agent_id } = {}) {
    if (!agent_id) return err(ErrorCode.INVALID, "agent_id required");
    return coord.heartbeat({ agent_id });
  }

  return {
    // Phase 1 APIs
    get_recent_messages,
    get_recent_intents,
    send_chat,
    send_intent,
    get_board_snapshot,
    get_region,

    // Phase 2 APIs
    draw_pixel,
    draw_pixels,

    // Phase 3 APIs
    claim_region,
    release_region,
    list_active_claims,
    register_agent,
    heartbeat,

    // lifecycle
    close: () => {
      chat.close();
      board.close();
    },
  };
}
