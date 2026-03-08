// BOTHook memory store initializer
// Runs inside OpenClaw gateway via internal hooks.
// Goal: at (or near) gateway startup, ensure the memorySearch SQLite store path exists
// without touching gateway/channels/models.

import fs from 'node:fs';

const MEMORY_DIR = '/home/ubuntu/.openclaw/memory';
const MEMORY_DB = '/home/ubuntu/.openclaw/memory/memory.sqlite';

let ran = false;

function statBrief(p: string) {
  try {
    const st = fs.statSync(p);
    return { ok: true, mode: (st.mode & 0o777).toString(8), uid: st.uid, gid: st.gid, size: st.size };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = async (_event: any) => {
  try {
    if (ran) return;
    ran = true;

    const existed = fs.existsSync(MEMORY_DB);

    // Ensure dir exists
    try {
      fs.mkdirSync(MEMORY_DIR, { recursive: true, mode: 0o700 });
    } catch {}

    // Ensure file exists
    if (!fs.existsSync(MEMORY_DB)) {
      try {
        fs.closeSync(fs.openSync(MEMORY_DB, 'a'));
      } catch {}
    }

    // Best-effort perms (avoid throwing)
    try { fs.chmodSync(MEMORY_DIR, 0o700); } catch {}
    try { fs.chmodSync(MEMORY_DB, 0o600); } catch {}

    const dirStat = statBrief(MEMORY_DIR);
    const dbStat = statBrief(MEMORY_DB);

    // Output initialization result (owner requested)
    console.log(
      `[bothook-memory-init] ${existed ? 'ok: existed' : 'ok: created'} ` +
      `dir=${JSON.stringify(dirStat)} db=${JSON.stringify(dbStat)}`
    );
  } catch (e: any) {
    try {
      console.log(`[bothook-memory-init] error: ${String(e?.message || e)}`);
    } catch {}
  }
};

export default handler;
