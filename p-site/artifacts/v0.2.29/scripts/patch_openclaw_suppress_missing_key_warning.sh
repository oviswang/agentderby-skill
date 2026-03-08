#!/usr/bin/env bash
set -euo pipefail

# BOTHook patch: suppress OpenClaw embedded-agent missing-key warnings from being sent to users.
#
# Problem:
# - When the embedded agent auto-reply runs without provider auth (e.g. anthropic), OpenClaw emits a user-facing message:
#   "⚠️ Agent failed before reply: No API key found for provider ..."
# - For BOTHook onboarding, this is noise and harms UX. Errors remain in logs.
#
# Approach:
# - Patch OpenClaw dist bundles on the user machine to return an empty text for this specific error.
# - Keep backups next to each file: *.bak.bothook.<ts>
# - Idempotent (safe to run multiple times).

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

OPENCLAW_DIST="/home/ubuntu/.npm-global/lib/node_modules/openclaw/dist"
if [[ ! -d "$OPENCLAW_DIST" ]]; then
  echo "[bothook] openclaw dist not found: $OPENCLAW_DIST" >&2
  exit 0
fi

node - <<'NODE'
import fs from 'fs';
import child_process from 'child_process';

const base = '/home/ubuntu/.npm-global/lib/node_modules/openclaw/dist';
const match = '⚠️ Agent failed before reply:';

const out = child_process.execSync(`grep -RIl "${match}" "${base}" || true`, { encoding: 'utf8' }).trim();
const files = out ? out.split(/\n+/).filter(Boolean).filter(f => !f.includes('.bak.bothook.')) : [];

let patched = 0;
let skipped = 0;

// We patch the template literal used for the user-facing error text.
// In the compiled bundle, it appears as:
//   `⚠️ Agent failed before reply: ${trimmedMessage}.\nLogs: openclaw logs --follow`
const needle = '`⚠️ Agent failed before reply: ${trimmedMessage}.\\nLogs: openclaw logs --follow`';

for (const file of files) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes('BOTHook: suppress missing-key warning')) {
    skipped++;
    continue;
  }
  if (!s.includes(needle)) {
    // Not the expected bundle shape; skip safely.
    skipped++;
    continue;
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + 'Z';
  const bk = `${file}.bak.bothook.${stamp}`;
  fs.copyFileSync(file, bk);

  const replacement = `(/No API key found for provider\\s+\"/i.test(String(message||'')) ? '' : ${needle}) /* BOTHook: suppress missing-key warning */`;
  s = s.split(needle).join(replacement);
  fs.writeFileSync(file, s);
  patched++;
}

console.log(`[bothook] openclaw suppress-missing-key patch: patched=${patched} skipped=${skipped} files=${files.length}`);
NODE

# Best-effort restart; ignore failures (system may not be in systemd context during bootstrap).
if command -v systemctl >/dev/null 2>&1; then
  systemctl restart openclaw-gateway.service >/dev/null 2>&1 || true
fi
