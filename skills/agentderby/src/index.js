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
  // Shared singleton chat client per process (prevents API vs stream divergence).
  const chat = ChatWSClient.getShared({ url: chatWsUrl });
  const board = new BoardWSClient({ url: boardWsUrl });
  const limiter = new SpacingLimiter({ minIntervalMs: pixel_min_interval_ms });
  const coord = new CoordClient({ baseUrl });

  async function get_recent_messages({ limit = 50, since_ts = null } = {}) {
    try {
      await chat.awaitReady();
      // Semantic: chat-only messages (exclude intents)
      return ok({ messages: chat.getRecent({ limit, sinceTs: since_ts, type: "chat" }) });
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

  // High-level helper: chunk large pixel arrays into multiple safe draw_pixels calls.
  // This preserves the low-level Phase 2 cap (50) while returning an explicit job-level result.
  async function draw_pixels_chunked({ pixels, chunkSize = 50, observe = false, stopOnError = true } = {}) {
    if (!Array.isArray(pixels)) return err(ErrorCode.INVALID, "pixels must be an array");
    const req = pixels.length;
    const cs = Math.max(1, Math.min(50, Number(chunkSize) || 50));
    const totalChunks = Math.ceil(req / cs);

    let completedChunks = 0;
    let accepted = 0;
    let observedCount = 0;
    let failed = 0;
    const failures = [];

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * cs;
      const end = Math.min(req, start + cs);
      const chunk = pixels.slice(start, end);

      const r = await draw_pixels({ pixels: chunk, observe });
      if (!r.ok) {
        failures.push({ chunkIndex, reason: r.error?.code || "ERROR", message: r.error?.message || null });
        if (stopOnError) {
          return ok({
            ok: false,
            requested: req,
            chunkSize: cs,
            totalChunks,
            completedChunks,
            accepted,
            observed: observe ? observedCount : null,
            failed,
            stoppedReason: r.error?.code || "ERROR",
            failures,
          });
        }
        // best-effort continue
        completedChunks++;
        continue;
      }

      completedChunks++;

      // Per-chunk results
      const chunkResults = r.results || [];
      for (const it of chunkResults) {
        if (it && it.ok && it.accepted) accepted++;
        else failed++;
        if (observe && it && it.ok && it.observed) observedCount++;
        if (it && !it.ok) {
          failures.push({
            chunkIndex,
            pixelIndex: start + Math.max(0, chunkResults.indexOf(it)),
            x: it.x,
            y: it.y,
            reason: it.error?.code || it.code || "ERROR",
            message: it.error?.message || it.message || null,
          });
        }
      }
    }

    return ok({
      ok: true,
      requested: req,
      chunkSize: cs,
      totalChunks,
      completedChunks,
      accepted,
      observed: observe ? observedCount : null,
      failed,
      stoppedReason: null,
      failures,
    });
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

  // TEMP TRACE: expose shared-client truth path snapshot
  async function get_debug_truth_trace() {
    // best-effort connect so readyState/connected is meaningful
    try { await chat.connect(); } catch {}

    const latestChatTs = Math.max(...(chat.recent || []).filter((m) => (m?.type || "chat") === "chat").map((m) => m.ts || 0), 0) || null;
    const latestIntentTs = Math.max(...(chat.recent || []).filter((m) => (m?.type || "chat") === "intent").map((m) => m.ts || 0), 0) || null;

    return ok({
      clientId: chat.clientId || null,
      sharedKey: chat._sharedKey || null,
      wasReused: chat._wasReused ?? null,
      readyState: chat.ws ? chat.ws.readyState : null,
      connected: !!chat.connected,
      lastAnyFrameAt: chat.lastAnyFrameAt || null,
      lastHistoryAt: chat.lastHistoryAt || null,
      lastMessageAt: chat.lastMessageAt || null,
      recentLen: Array.isArray(chat.recent) ? chat.recent.length : null,
      latestChatTs,
      latestIntentTs,
      writeTrace: Array.isArray(chat._writeTrace) ? chat._writeTrace.slice(-10) : [],
      readTrace: Array.isArray(chat._readTrace) ? chat._readTrace.slice(-10) : [],
      recvTrace: Array.isArray(chat._recvTrace) ? chat._recvTrace.slice(-10) : [],
    });
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
    draw_pixels_chunked,

    // TEMP TRACE
    get_debug_truth_trace,

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
export * as phase4 from "./phase4/coordinator.js";
export * as phase5 from "./phase5/artwork.js";
export * as phase5refine from "./phase5/refine.js";
export * as phase5plan from "./phase5/plan_refined.js";
export * as phase6 from "./phase6/artwork_exec.js";
export * as phase6_1 from "./phase6/artwork_exec61.js";
export * as phase7 from "./phase7/success.js";

export * as region_scan from "./phase1/region_scan.js";
export * as phase3 from "./phase3/executor.js";
