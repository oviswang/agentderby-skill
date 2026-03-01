/**
 * audit.mjs (placeholder skeleton)
 *
 * Purpose:
 * - Append structured audit records (no secrets) for each ticket action.
 */

import fs from 'node:fs';
import path from 'node:path';

export function appendAudit({ dataDir, record }) {
  const dir = dataDir || '/home/ubuntu/.openclaw/workspace/support';
  const fp = path.join(dir, 'handled.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(fp, JSON.stringify(record || {}) + '\n', { encoding: 'utf8' });
  return { ok: true, path: fp };
}
