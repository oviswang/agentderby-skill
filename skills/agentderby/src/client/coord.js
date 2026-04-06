import { err, ok, ErrorCode } from "../types.js";

export class CoordClient {
  constructor({ baseUrl } = {}) {
    this.baseUrl = baseUrl;
  }

  async list_active_claims() {
    try {
      const url = new URL("/claims", this.baseUrl).toString();
      const resp = await fetch(url);
      const j = await resp.json();
      return j?.ok ? ok({ claims: j.claims || [] }) : err(ErrorCode.BACKEND, j?.error?.message || "claims error", { conflicts: j?.conflicts });
    } catch (e) {
      return err(ErrorCode.NETWORK, String(e?.message || e));
    }
  }

  async claim_region({ agent_id, region, ttl_ms = 60000, reason = "" } = {}) {
    try {
      const url = new URL("/claims", this.baseUrl).toString();
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id, region, ttl_ms, reason }),
      });
      const j = await resp.json();
      if (j?.ok) return ok({ claim: j.claim });
      return err(j?.error?.code || ErrorCode.BACKEND, j?.error?.message || "claim conflict", { conflicts: j?.conflicts || [] });
    } catch (e) {
      return err(ErrorCode.NETWORK, String(e?.message || e));
    }
  }

  async release_region({ agent_id, claim_id } = {}) {
    try {
      const u = new URL("/claims", this.baseUrl);
      u.searchParams.set("agent_id", agent_id);
      u.searchParams.set("claim_id", claim_id);
      const resp = await fetch(u.toString(), { method: "DELETE" });
      const j = await resp.json();
      return j?.ok ? ok({}) : err(j?.error?.code || ErrorCode.BACKEND, j?.error?.message || "release error");
    } catch (e) {
      return err(ErrorCode.NETWORK, String(e?.message || e));
    }
  }

  async register_agent({ agent_id, display_name = "", version = "" } = {}) {
    try {
      const url = new URL("/presence", this.baseUrl).toString();
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id, display_name, version }),
      });
      const j = await resp.json();
      return j?.ok ? ok({ presence: j.presence }) : err(ErrorCode.BACKEND, j?.error?.message || "presence error");
    } catch (e) {
      return err(ErrorCode.NETWORK, String(e?.message || e));
    }
  }

  async heartbeat({ agent_id } = {}) {
    return this.register_agent({ agent_id });
  }
}
