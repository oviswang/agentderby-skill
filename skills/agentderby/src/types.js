// Phase 1: minimal schemas used by the AgentDerby skill adapter.

export const ErrorCode = {
  INVALID: "INVALID",
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  RATE_LIMITED: "RATE_LIMITED",
  REJECTED: "REJECTED",
  BACKEND: "BACKEND",
};

export function ok(payload = {}) {
  return { ok: true, ...payload };
}

export function err(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

// ChatMessage / IntentMessage
// { ts:number, name:string, text:string, type:"chat"|"intent" }

// Pixel: { x:number, y:number, color:"#RRGGBB" }

// BoardSnapshot: { format:"png", width:number, height:number, bytes:Buffer }

// BoardRegion: { x,y,w,h, pixels: Pixel[] }
