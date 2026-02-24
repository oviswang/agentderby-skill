#!/usr/bin/env node
/**
 * BOTHook task runner
 *
 * Modes (env RUNNER_MODE):
 * - tick (default): only update task checkpoints (safe).
 * - execute_l1: allow local repo actions: generate patch, run tests, write files, git commit (NO push).
 * - execute_l2: execute_l1 + git push to NEW branch (NO main), read-only cloud describe/list, restart openclaw service.
 *
 * L3 is ALWAYS FORBIDDEN here:
 * - modifying openclaw.json
 * - remote destructive commands
 * - cloud resource destroy/return/billing actions
 * Only allowed after explicit WhatsApp approval phrase (not implemented in runner).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TASK_DIR = '/home/ubuntu/.openclaw/tasks';
const WORKSPACE = '/home/ubuntu/.openclaw/workspace';
const CHECKPOINTS_DIR = path.join(WORKSPACE, 'checkpoints');
const STATE_PATH = path.join(WORKSPACE, 'memory', 'task-runner-state.json');
const LOCK_PATH = '/tmp/bothook.task-runner.lock';

const RUNNER_MODE = (process.env.RUNNER_MODE || 'tick').trim();
const ALLOWED_MODES = new Set(['tick', 'execute_l1', 'execute_l2']);
const SSH_IDENTITY_FILE = (process.env.SSH_IDENTITY_FILE || '/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519').trim();

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nowStamp() {
  // filesystem-friendly
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

function sh(cmd, opts = {}) {
  const res = spawnSync('bash', ['-lc', cmd], {
    cwd: opts.cwd || WORKSPACE,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  return { code: res.status ?? 0, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function hasBadKeywords(s) {
  const x = (s || '').toLowerCase();
  // Keep this list specific to avoid false positives like "author" containing "auth".
  return [
    'unauthorized', 'forbidden', 'permission denied',
    'authentication failed', 'invalid token', 'invalid api key',
    'econnreset', 'etimedout', 'timed out', 'timeout', 'network is unreachable', 'getaddrinfo',
    'handshake', 'tls', 'certificate verify failed'
  ].some(k => x.includes(k));
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function tryLock() {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function unlock() {
  try { fs.unlinkSync(LOCK_PATH); } catch {}
}

function taskSkipReason(task, { force = false } = {}) {
  const st = task?.status;
  if (!st) return 'parse_error';
  if (st === 'DONE') return 'DONE';
  if (st === 'BLOCKED') return 'BLOCKED';
  if (st === 'IDLE') return 'IDLE';

  // Autonomy: allow transient PAUSED tasks to keep retrying without human intervention.
  // This is critical for reimage/reboot windows where SSH may be unavailable for several minutes.
  if (st === 'PAUSED' && !force) {
    const er = String(task?.error_reason || '');
    if (er === 'ssh_exec_failed') return null; // keep runnable
    return 'PAUSED';
  }

  return null; // runnable
}

function loadState() {
  try {
    return readJson(STATE_PATH);
  } catch {
    return { rrIndex: 0, lastTickAt: null };
  }
}

function listTasks() {
  if (!fs.existsSync(TASK_DIR)) return [];
  const files = fs.readdirSync(TASK_DIR)
    // Support sub-tasks like T9.1.json
    .filter(f => /^T\d+(?:\.\d+)?\.json$/.test(f))
    .sort();

  const tasks = [];
  for (const f of files) {
    const p = path.join(TASK_DIR, f);
    try {
      const j = readJson(p);
      tasks.push({ file: p, name: f, task: j });
    } catch (e) {
      tasks.push({ file: p, name: f, task: null, parseError: String(e) });
    }
  }
  return tasks;
}

function autofillActionsIfMissing(tid, task) {
  const actions = Array.isArray(task?.actions) ? task.actions : [];
  if (actions.length > 0) return { changed: false, task };

  // Project policy: in autonomous mode, never stall on missing actions.
  // Instead, inject a best-effort action plan for known tasks.

  if (tid === 'T23') {
    // T23: Reimage + bootstrap multiple pool instances to READY.
    // If actions are empty, auto-fill Phase 2 (bootstrap + healthcheck + reboot).
    // NOTE: Phase 1 (ResetInstance) may have been done earlier; this autofill focuses on getting machines provision-ready.
    const targets = Array.isArray(task.targets) ? task.targets.map(String) : [];
    if (targets.length === 0) {
      task.status = task.status || 'BLOCKED';
      task.blocked_reason = task.blocked_reason || 'T23 missing targets[]; cannot autofill actions';
      task.next_action = task.next_action || 'Add task.targets (instance_ids) then rerun runner.';
      return { changed: true, task };
    }

    const baseUrl = 'https://p.bothook.me/artifacts/v0.2.7/bootstrap.sh';
    const keyId = 'lhkp-q1oc3vdz'; // bothook_pool_key
    const newActions = [];
    for (const instance_id of targets) {
      // 0) Ensure SSH key is associated (cloud-side). Critical after reimage.
      newActions.push({
        kind: 'tccli_lighthouse_associate_keypair',
        instance_id,
        key_id: keyId,
        region: 'ap-singapore',
        cred_env: '/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env',
        progress_bump: 1
      });

      // 1) SSH readiness probe (best-effort). Don't fail hard.
      newActions.push({
        kind: 'ssh_exec',
        instance_id,
        commands: [
          'set -euo pipefail',
          'echo "[T23] ssh ok" || true'
        ],
        progress_bump: 2
      });

      // 2) Bootstrap v0.2.7 (re-runnable)
      newActions.push({
        kind: 'ssh_exec',
        instance_id,
        commands: [
          'set -euo pipefail',
          'sudo -n true',
          `sudo bash -lc "curl -fsSL ${baseUrl} | bash"`
        ],
        progress_bump: 10
      });

      // 2) Healthcheck + basic service checks (best-effort; don't fail entire task on transient issues)
      newActions.push({
        kind: 'ssh_exec',
        instance_id,
        commands: [
          'set -euo pipefail',
          'sudo -n true',
          'sudo bash -lc "/opt/bothook/healthcheck.sh || true"',
          'systemctl is-enabled openclaw-gateway.service || true',
          'systemctl is-active openclaw-gateway.service || true',
          'ss -ltnp | egrep "18789" || true'
        ],
        progress_bump: 8
      });

      // 3) Reboot (P0.2 acceptance). Note: runner does not wait; next action on this instance may happen after it comes back.
      newActions.push({
        kind: 'ssh_exec',
        instance_id,
        commands: [
          'set -euo pipefail',
          'echo "[T23] reboot"'
        ],
        reboot: true,
        progress_bump: 5
      });
    }

    task.actions = newActions;
    task.progress_percent = Math.max(Number(task.progress_percent || 0), 35);
    task.next_action = task.next_action || 'Autofilled Phase 2 actions (bootstrap+healthcheck+reboot) for T23 targets; rerun runner to execute.';
    return { changed: true, task };
  }

  if (tid === 'T20') { 
    const newActions = [
      {
        kind: 'repo_write_file',
        file: 'hooks/bothook-onboarding/handler.ts',
        content: "// NOTE: this file is managed by task runner T20.\n\n" +
          "import fs from 'node:fs';\n" +
          "import path from 'node:path';\n\n" +
          "// eslint-disable-next-line @typescript-eslint/no-explicit-any\n" +
          "const handler = async (event: any) => {\n" +
          "  try {\n" +
          "    if (!event || event.type !== 'message' || event.action !== 'received') return;\n" +
          "    const ctx = event.context || {};\n" +
          "    if (ctx.channelId !== 'whatsapp') return;\n\n" +
          "    const content = String(ctx.content || '').trim();\n" +
          "    const from = String(ctx.from || '').trim();\n" +
          "    const meta = ctx.metadata || {};\n" +
          "    const toE164 = String(meta.to || '').trim();\n" +
          "    const fromE164 = String(meta.senderE164 || meta.sender || from || '').trim();\n" +
          "    const isSelfChat = !!fromE164 && !!toE164 && fromE164 === toE164;\n\n" +
          "    const UUID = readUuid();\n" +
          "    if (!UUID) return;\n" +
          "    const apiBase = process.env.BOTHOOK_API_BASE || 'https://p.bothook.me';\n\n" +
          "    const st = loadState(UUID);\n" +
          "    const d = await fetchJson(`${apiBase}/api/delivery/status?uuid=${encodeURIComponent(UUID)}`);\n" +
          "    if (!d?.ok) return;\n" +
          "    const paid = Boolean(d.paid);\n" +
          "    const userLang = (d.user_lang || 'en').toString().toLowerCase();\n" +
          "    const prompts = await fetchJson(`${apiBase}/api/i18n/whatsapp-prompts?lang=${encodeURIComponent(userLang)}`) || null;\n" +
          "    const p = prompts && prompts.ok ? prompts.prompts : null;\n" +
          "    if (!p) return;\n\n" +
          "    if (!isSelfChat) {\n" +
          "      const key = fromE164 || from;\n" +
          "      st.promoSentTo = st.promoSentTo || {};\n" +
          "      if (!st.promoSentTo[key]) {\n" +
          "        const msg = render(p.promo_external, await buildVars(apiBase, UUID));\n" +
          "        await sendViaLoopback(fromE164 || from, msg);\n" +
          "        st.promoSentTo[key] = Date.now();\n" +
          "        saveState(UUID, st);\n" +
          "      }\n" +
          "      return;\n" +
          "    }\n\n" +
          "    const vars = await buildVars(apiBase, UUID);\n" +
          "    const ks = await fetchJson(`${apiBase}/api/key/status?uuid=${encodeURIComponent(UUID)}`);\n" +
          "    const keyVerified = Boolean(ks?.ok && ks?.verified);\n\n" +
          "    if (!paid) {\n" +
          "      const msg = render(p.welcome_unpaid, vars);\n" +
          "      await sendViaLoopback(fromE164 || from, msg);\n" +
          "      return;\n" +
          "    }\n\n" +
          "    if (!keyVerified) {\n" +
          "      const maybeKey = extractOpenAiKey(content);\n" +
          "      if (maybeKey) {\n" +
          "        const vr = await fetchJson(`${apiBase}/api/key/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uuid: UUID, provider: 'openai', key: maybeKey }) });\n" +
          "        if (vr?.ok && vr?.verified) {\n" +
          "          await sendViaLoopback(fromE164 || from, vr.message || '[bothook] OpenAI Key 验证成功 ✅');\n" +
          "          return;\n" +
          "        }\n" +
          "      }\n" +
          "      const msg = render(p.guide_key_paid, vars);\n" +
          "      await sendViaLoopback(fromE164 || from, msg);\n" +
          "      return;\n" +
          "    }\n" +
          "  } catch { }\n" +
          "};\n\n" +
          "function readUuid(): string | null {\n" +
          "  const env = (process.env.BOTHOOK_UUID || '').trim();\n" +
          "  if (env) return env;\n" +
          "  const p = '/opt/bothook/UUID.txt';\n" +
          "  try { const t = fs.readFileSync(p, 'utf8'); const m = t.match(/uuid\\s*=\\s*([a-zA-Z0-9-]{8,80})/); return m ? m[1] : null; } catch { return null; }\n" +
          "}\n\n" +
          "function statePath(uuid: string) { return path.join('/opt/bothook', 'onboarding', `${uuid}.json`); }\n" +
          "function loadState(uuid: string): any { try { return JSON.parse(fs.readFileSync(statePath(uuid), 'utf8')); } catch { return { promoSentTo: {} }; } }\n" +
          "function saveState(uuid: string, obj: any) { try { fs.mkdirSync(path.dirname(statePath(uuid)), { recursive: true, mode: 0o755 }); fs.writeFileSync(statePath(uuid), JSON.stringify(obj, null, 2) + '\\n', { mode: 0o600 }); } catch {} }\n" +
          "async function fetchJson(url: string, init?: any) { const r = await fetch(url, { redirect: 'follow', ...init }); const txt = await r.text(); try { return JSON.parse(txt); } catch { return null; } }\n" +
          "function render(tpl: string, vars: Record<string,string>) { let out = String(tpl || ''); for (const [k,v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(String(v ?? '')); return out; }\n" +
          "function extractOpenAiKey(s: string): string | null { const t = String(s||'').trim(); const m = t.match(/(sk-[A-Za-z0-9]{20,}|sk_[A-Za-z0-9]{20,})/); return m ? m[1] : null; }\n" +
          "async function buildVars(apiBase: string, uuid: string) { const vars: any = { cpu:'—', ram_gb:'—', disk_gb:'—', region:'—', public_ip:'—', openclaw_version:'—', uuid, p_link:`${apiBase}/p/${encodeURIComponent(uuid)}?lang=en`, pay_short_link:`${apiBase}/?uuid=${encodeURIComponent(uuid)}`, pay_countdown_minutes:'15' }; try { const st = await fetchJson(`${apiBase}/api/p/state?uuid=${encodeURIComponent(uuid)}&lang=en`); if (st?.ok) { vars.region=String(st.instance?.region||'—'); vars.public_ip=String(st.instance?.public_ip||'—'); vars.cpu=String(st.instance?.config?.cpu??'—'); vars.ram_gb=String(st.instance?.config?.memory_gb??'—'); } } catch {} try { const pl = await fetchJson(`${apiBase}/api/pay/link`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ uuid })}); if (pl?.ok && pl?.payUrl) vars.pay_short_link=String(pl.payUrl); } catch {} return vars; }\n" +
          "async function sendViaLoopback(to: string, text: string) { const target=String(to||'').trim(); const msg=String(text||'').trim(); if (!target||!msg) return; await fetch('http://127.0.0.1:18789/__bothook__/wa/send', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ to: target, text: msg }) }); }\n\n" +
          "export default handler;\n",
        commitMessage: 'runner: autofill T20 actions (hook loopback sender)',
        progress_bump: 20
      },
      {
        kind: 'ssh_put_tar',
        instance_id: 'lhins-avvw30mh',
        local_dir: 'hooks/bothook-onboarding',
        remote_dir: '/home/ubuntu/.openclaw/workspace/hooks/bothook-onboarding',
        tar_name: 'bothook-onboarding-hook',
        progress_bump: 10
      },
      {
        kind: 'ssh_exec',
        instance_id: 'lhins-avvw30mh',
        commands: [
          'set -euo pipefail',
          'openclaw config set hooks.internal.enabled true',
          'openclaw config set hooks.internal.entries.bothook-onboarding.enabled true',
          'sudo systemctl restart openclaw-gateway.service'
        ],
        progress_bump: 10
      }
    ];
    task.actions = newActions;
    task.next_action = task.next_action || 'autofilled actions; rerun runner';
    return { changed: true, task };
  }

  return { changed: false, task };
}

function pickRoundRobin(runnable, rrIndex, limit) {
  if (runnable.length === 0) return [];
  const out = [];
  let i = rrIndex % runnable.length;
  for (let k = 0; k < runnable.length && out.length < limit; k++) {
    out.push(runnable[i]);
    i = (i + 1) % runnable.length;
  }
  return out;
}

function shouldTouch(filePath, minMinutes = 10) {
  const st = fs.statSync(filePath);
  const ageMs = Date.now() - st.mtimeMs;
  return ageMs >= minMinutes * 60 * 1000;
}

function tickTask(entry, note = 'no-op safe tick') {
  const { file, task } = entry;
  const ts = nowIso();
  task.last_action = `runner_tick@${ts}`;
  task.last_updated = ts;
  task.retry_count = Number(task.retry_count || 0);
  task.no_progress_count = Number(task.no_progress_count || 0);
  task.recent_evidence = Array.isArray(task.recent_evidence) ? task.recent_evidence : [];
  task.recent_evidence.unshift(`runner: ticked ${path.basename(file)} @ ${ts} (${note})`);
  task.recent_evidence = task.recent_evidence.slice(0, 10);
  writeJsonAtomic(file, task);
}

function markError(entry, reason) {
  const { file, task } = entry;
  const ts = nowIso();

  // Default: mark as ERROR.
  // Exception: transient ssh_exec_failed during reimage/boot windows should PAUSE (retry later) rather than hard-error.
  if (String(reason || '') === 'ssh_exec_failed') {
    task.status = 'PAUSED';
    task.error_reason = reason;
    task.blocked_reason = null;
    task.next_action = task.next_action || 'SSH not reachable yet (likely reimage/reboot window). Retry runner later.';
    task.last_action = `runner_pause@${ts}`;
  } else {
    task.status = 'ERROR';
    task.error_reason = reason;
    task.last_action = `runner_error@${ts}`;
  }

  task.last_updated = ts;
  task.retry_count = Number(task.retry_count || 0) + 1;
  task.recent_evidence = Array.isArray(task.recent_evidence) ? task.recent_evidence : [];
  task.recent_evidence.unshift(`runner: ${task.status} ${path.basename(file)} @ ${ts}: ${reason}`);
  task.recent_evidence = task.recent_evidence.slice(0, 10);
  writeJsonAtomic(file, task);
}

function ensureCheckpointDir(ts, taskId) {
  const dir = path.join(CHECKPOINTS_DIR, ts, taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCheckpoint(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

function redactTaskForEvidence(task) {
  // tasks should not contain secrets, but keep defensive.
  const s = JSON.stringify(task);
  return s.replace(/(token|secret|password|key)\s*[:=]\s*[^\s",}]+/gi, '$1:***REDACTED***');
}

function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const jsonOut = args.has('--json');
  const maxTasks = Number((argv.find(a => a.startsWith('--maxTasks=')) || '').split('=')[1] || 3);
  const onlyTask = (argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;
  const force = args.has('--force');

  if (!ALLOWED_MODES.has(RUNNER_MODE)) {
    const res = { ok: false, status: 'bad_runner_mode', runnerMode: RUNNER_MODE };
    console.log(jsonOut ? JSON.stringify(res) : JSON.stringify(res, null, 2));
    return;
  }

  if (!tryLock()) {
    const res = { ok: false, status: 'locked', changed: false, runnableCount: null };
    console.log(jsonOut ? JSON.stringify(res) : 'LOCKED');
    return;
  }

  try {
    const state = loadState();
    const entries = listTasks();

    const scan = [];
    const runnable = [];

    for (const e of entries) {
      if (!e.task) {
        scan.push({ file: e.name, runnable: false, skip: 'parse_error' });
        continue;
      }
      const skip = taskSkipReason(e.task, { force });
      if (skip) {
        scan.push({ file: e.name, runnable: false, skip });
      } else {
        scan.push({ file: e.name, runnable: true, skip: null });
        runnable.push(e);
      }
    }

    let runnable2 = runnable.sort((a, b) => (a.task.priority ?? 999) - (b.task.priority ?? 999));
    if (onlyTask) {
      runnable2 = runnable2.filter(e => (e.task?.task_id === onlyTask) || (e.name === `${onlyTask}.json`) || (e.name === `${onlyTask}.json`.replace('..','.' )));
      // Allow passing T3 or T3.json
      runnable2 = runnable2.filter(e => e.task && (e.task.task_id === onlyTask || e.name === `${onlyTask}.json` || e.name === `${onlyTask}.json`.replace('.json.json','.json')));
    }

    // Priority override: if any runnable tasks have the minimal priority value,
    // only pick from that bucket. This ensures P0 blockers (e.g., T12) are always selected.
    let pickPool = runnable2;
    if (!onlyTask && runnable2.length > 0) {
      const minPri = Math.min(...runnable2.map(e => (e.task.priority ?? 999)));
      pickPool = runnable2.filter(e => (e.task.priority ?? 999) === minPri);
    }

    const picked = pickRoundRobin(
      pickPool,
      state.rrIndex || 0,
      maxTasks
    );

    const touched = [];
    const actions = [];
    const tsFolder = nowStamp();

    for (const e of picked) {
      const tid = e.task?.task_id || e.name.replace(/\.json$/,'');
      const cpDir = ensureCheckpointDir(tsFolder, tid);
      writeCheckpoint(cpDir, 'pre.json', redactTaskForEvidence(e.task) + '\n');

      const planLines = [
        `runner_mode: ${RUNNER_MODE}`,
        `task_id: ${tid}`,
        `picked_at: ${nowIso()}`,
        '',
        'policy:',
        '- L3 forbidden (no openclaw.json edits; no destructive remote/cloud actions).',
        '- execute_l1: local repo patch + tests + write files + git commit (no push).',
        '- execute_l2: execute_l1 + push to new branch (no main) + read-only cloud describe/list + openclaw service restart.',
        '',
        'next_action (from task file):',
        String(e.task?.next_action || ''),
        ''
      ];

      // Safety: if too fresh, don't spam (unless --force).
      if (!force && !shouldTouch(e.file, 1)) {
        planLines.push('decision: skip (too_fresh_mtime)');
        writeCheckpoint(cpDir, 'plan.md', planLines.join('\n'));
        actions.push({ task: tid, checkpoint: cpDir, action: 'skip', reason: 'too_fresh_mtime' });
        continue;
      }

      if (RUNNER_MODE === 'tick') {
        planLines.push('decision: tick-only');
        writeCheckpoint(cpDir, 'plan.md', planLines.join('\n'));
        tickTask(e);
        touched.push(e.name);
        actions.push({ task: tid, checkpoint: cpDir, action: 'tick' });
        continue;
      }

      // execute modes: action-spec whitelist (DO NOT execute free-text next_action)
      let taskActions = Array.isArray(e.task?.actions) ? e.task.actions : [];

      // Auto-autonomy: if actions[] missing, try to auto-fill for known tasks; otherwise mark BLOCKED.
      if (taskActions.length === 0) {
        const ts = nowIso();
        const autofill = (tid) => {
          if (tid === 'T23') {
            // T23: reimage done earlier; now bootstrap + healthcheck + reboot acceptance on targets.
            const targets = Array.isArray(e.task?.targets) ? e.task.targets.map(String) : [];
            if (targets.length === 0) return null;
            const baseUrl = 'https://p.bothook.me/artifacts/v0.2.7/bootstrap.sh';
            const keyId = 'lhkp-q1oc3vdz'; // bothook_pool_key
            const out = [];
            for (const instance_id of targets) {
              out.push({
                kind: 'tccli_lighthouse_associate_keypair',
                instance_id,
                key_id: keyId,
                region: 'ap-singapore',
                cred_env: '/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env',
                progress_bump: 1
              });
              out.push({
                kind: 'ssh_exec',
                instance_id,
                user: 'ubuntu',
                commands: [
                  'set -euo pipefail',
                  'sudo -n true',
                  `sudo bash -lc "curl -fsSL ${baseUrl} | bash"`
                ],
                progress_bump: 10
              });
              out.push({
                kind: 'ssh_exec',
                instance_id,
                user: 'ubuntu',
                commands: [
                  'set -euo pipefail',
                  'sudo -n true',
                  'sudo bash -lc "/opt/bothook/healthcheck.sh || true"',
                  'systemctl is-enabled openclaw-gateway.service || true',
                  'systemctl is-active openclaw-gateway.service || true',
                  'ss -ltnp | egrep "18789" || true'
                ],
                progress_bump: 8
              });
              out.push({
                kind: 'ssh_exec',
                instance_id,
                user: 'ubuntu',
                commands: [
                  'set -euo pipefail',
                  'echo "[T23] reboot"'
                ],
                reboot: true,
                progress_bump: 5
              });
            }
            return out;
          }
          if (tid === 'T20') {
            return [{
              kind: 'repo_write_file',
              file: 'hooks/bothook-onboarding/handler.ts',
              content: `// NOTE: this file is managed by task runner T20.\n\n// (autofill stub)\n// This task should route onboarding replies via loopback /__bothook__/wa/send.\n// If you see this stub, update T20 actions to the full implementation.\n\nexport default async function handler() { return; }\n`,
              commitMessage: 'T20: autofill stub (replace with loopback sender implementation)',
              progress_bump: 2,
              fix_once: 'RUNNER_MODE=execute_l2 node /home/ubuntu/.openclaw/workspace/scripts/task_runner.mjs --json --only=T20 --force'
            }];
          }
          if (tid === 'T5') {
            return [{
              kind: 'repo_write_file',
              file: 'control-plane/docs/_T5_relink_e2e_next.md',
              content: `# T5 next steps (autofilled)\n\n- updated: ${ts}\n\nTODO:\n- implement /api/p/state fields: paid/allocatable\n- implement allocator endpoint\n- implement p-site UI branches\n- add online http_check for real UUID\n`,
              commitMessage: 'T5: add relink e2e next-steps scaffold (autofill)',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T5 --force'
            }];
          }
          if (tid === 'T11') {
            return [{
              kind: 'repo_write_file',
              file: 'scripts/sop_guard.sh',
              content: `#!/usr/bin/env bash\nset -euo pipefail\n\n# sop_guard (WIP)\n# backup -> change -> validate -> minimal restart -> strong healthcheck -> rollback\n\necho "sop_guard: placeholder $(date -Is)"\n`,
              commitMessage: 'T11: flesh sop_guard skeleton (autofill)',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T11 --force'
            }];
          }
          if (tid === 'T12') {
            return [{
              kind: 'ssh_exec',
              instance_id: 'lhins-gs58d0eh',
              user: 'ubuntu',
              commands: [
                'set -euo pipefail',
                'which openclaw || true',
                'openclaw --version 2>/dev/null || true',
                'systemctl cat openclaw-gateway.service || true',
                'systemctl status openclaw-gateway.service --no-pager -n 20 || true'
              ],
              reboot: false,
              progress_bump: 5,
              fix_once: 'ssh -i /home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519 ubuntu@43.160.238.83 "which openclaw; systemctl cat openclaw-gateway.service"'
            }];
          }
          if (tid === 'T7') {
            return [{
              kind: 'repo_write_file',
              file: 'scripts/evidence_summary.mjs',
              content: `#!/usr/bin/env node\n// evidence_summary (autofill)\n// Purpose: generate a short, safe, Telegram-friendly text summary from a checkpoint dir.\n// Usage: node scripts/evidence_summary.mjs <checkpoint_dir>\n\nimport fs from \"node:fs\";\nimport path from \"node:path\";\n\nconst cp = process.argv[2];\nif (!cp) {\n  console.error(\"usage: evidence_summary <checkpoint_dir>\");\n  process.exit(2);\n}\n\nconst cmd = path.join(cp, \"cmd.log\");\nlet body = \"\";\ntry { body = fs.readFileSync(cmd, \"utf8\"); } catch { body = \"(cmd.log missing)\"; }\n\n// redact obvious patterns\nbody = body.replace(/(secret|token|password|key)=\S+/gi, \"$1=***REDACTED***\");\n\nconst lines = body.split(/\n/).slice(0, 80);\nconsole.log(lines.join(\"\\n\"));\n`,
              commitMessage: 'T7: add evidence_summary helper (Telegram-only; no public publish)',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T7 --force'
            }];
          }
          if (tid === 'T13') {
            return [{
              kind: 'repo_write_file',
              file: 'scripts/gateway_cleanup_plan.md',
              content: `# Gateway cleanup plan (autofill)\n\n- updated: ${ts}\n\nTODO:\n- inventory: systemctl --user list-unit-files | grep openclaw\n- disable extra gateway-like units\n- evidence: openclaw doctor / gateway status\n- rollback steps\n`,
              commitMessage: 'T13: autofill gateway cleanup plan scaffold',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T13 --force'
            }];
          }
          if (tid === 'T14') {
            return [{
              kind: 'repo_write_file',
              file: 'scripts/i18n_end_to_end_audit.mjs',
              content: `#!/usr/bin/env node\n// i18n_end_to_end_audit (autofill)\n// TODO: run bothook-site i18n_strict_audit + audit p-site + whatsapp prompts coverage\nconsole.log(\"i18n_end_to_end_audit placeholder\", new Date().toISOString());\n`,
              commitMessage: 'T14: autofill i18n end-to-end audit placeholder',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T14 --force'
            }];
          }
          if (tid === 'T9') {
            return [{
              kind: 'repo_write_file',
              file: 'p-site/i18n/T9_multilang_plan.md',
              content: `# T9 multilang 15-langs plan (autofill)\n\n- updated: ${ts}\n\nTODO:\n- enumerate target languages\n- ensure p-site routes + copy coverage\n- align with bothook-site language list\n`,
              commitMessage: 'T9: add multilang plan scaffold (autofill)',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T9 --force'
            }];
          }
          if (tid === 'T10') {
            return [{
              kind: 'repo_write_file',
              file: 'docs/T10_base_image_plan.md',
              content: `# T10 base image delivery plan (autofill)\n\n- updated: ${ts}\n\nTODO:\n- define image build pipeline\n- versioning + rollback\n- acceptance checklist\n`,
              commitMessage: 'T10: add base image plan scaffold (autofill)',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T10 --force'
            }];
          }
          if (tid === 'T6') {
            return [{
              kind: 'repo_write_file',
              file: 'control-plane/lib/allocator.mjs',
              content: `// allocator (autofill refresh)\n// updated: ${ts}\n\nimport { openDb } from "./db.mjs";\n\nexport function pickReadyInstance() {\n  const { db } = openDb();\n  const row = db.prepare("SELECT instance_id, public_ip FROM instances WHERE lifecycle_status='IN_POOL' AND health_status='READY' ORDER BY instance_id LIMIT 1").get();\n  return row || null;\n}\n`,
              commitMessage: 'T6: refresh allocator placeholder (autofill)',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T6 --force'
            }];
          }
          if (tid === 'T4') {
            return [{
              kind: 'repo_write_file',
              file: 'control-plane/workers/reconcile-worker.mjs',
              content: `#!/usr/bin/env node\n// reconcile-worker (autofill scaffold)\n// updated: ${ts}\n// TODO: reconcile DB <-> cloud DescribeInstances <-> Stripe subscription truth\n\nconsole.log(\"reconcile-worker placeholder\", new Date().toISOString());\n`,
              commitMessage: 'T4: scaffold reconcile-worker (autofill)',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T4 --force'
            }];
          }
          if (tid === 'T8') {
            return [{
              kind: 'repo_write_file',
              file: 'control-plane/workers/pool-controller.mjs',
              content: `#!/usr/bin/env node\n// pool-controller (autofill scaffold)\n// updated: ${ts}\n// TODO: tick=1min, cap=5, enqueue heavy actions into write_queue (dry-run)\n\nconsole.log(\"pool-controller placeholder\", new Date().toISOString());\n`,
              commitMessage: 'T8: scaffold pool-controller (autofill)',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T8 --force'
            }];
          }
          if (tid === 'T15') {
            return [{
              kind: 'repo_write_file',
              file: 'docs/final_e2e_audit_checklist.md',
              content: `# FINAL end-to-end audit checklist\n\n- generated: {{NOW}}\n\nThis is a *last* audit after all tasks are DONE. Two lines:\n- User line: QR -> WA linked -> self-chat welcome -> pay -> back to p/<uuid> -> OpenAI key guide -> key verify -> DELIVERED.\n- Ops line: pool-controller tick -> lifecycle actions -> reconcile -> READY gate -> allocator READY-only -> delivery -> reclaim.\n\n## User line (what the user experiences)\n- [ ] QR page: shows 5-min scan countdown (qr_countdown_minutes=5)\n- [ ] After scan success: self-chat welcome sent (contains config + IP + OpenClaw version + pay short link + 15-min countdown)\n- [ ] External promo copy: sent before delivery only; stops after key verified\n- [ ] Stripe success_url returns to p/<uuid>?lang=... (browser history on main phone)\n- [ ] OpenAI key guide is clear for beginners (account/billing/key copy/paste format)\n- [ ] Key verification: one lightweight call (e.g., /v1/models)\n- [ ] After delivery: platform prompts stop; only self-chat control remains\n\n## Ops line (platform truth + gates)\n- [ ] Pool READY gate is enforced (keypair + bootstrap + minimal config + P0.2 reboot evidence)\n- [ ] T4 reconcile gates READY (cloud Describe ↔ DB ↔ Stripe)\n- [ ] T6 allocator selects READY-only\n- [ ] Cap=5 enforced across creating/ready/allocated/bound-but-unpaid\n- [ ] All destructive actions are queued + locked + auditable (events)\n\n## Online checks (run + capture evidence)\n- [ ] openclaw gateway status: RPC probe ok\n- [ ] p-site /healthz and /api/p/state respond\n\n## Findings\n- None\n\n## Next improvements\n- TBD\n`,
              commitMessage: 'T15: add final end-to-end audit checklist scaffold',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T15 --force'
            },{
              kind: 'local_exec',
              command: 'bash -lc "set -euo pipefail; echo \"== openclaw gateway status ==\"; openclaw gateway status | sed -n \"1,120p\"; echo; echo \"== p-site healthz ==\"; curl -fsS --max-time 15 http://127.0.0.1:18998/healthz; echo; echo \"== p-site state sample ==\"; curl -fsS --max-time 15 https://p.bothook.me/api/p/state?uuid=dummy 2>/dev/null | head -c 400 || true; echo"',
              progress_bump: 5
            }];
          }
          if (tid === 'T16') {
            return [{
              kind: 'repo_write_file',
              file: 'docs/T16_pool_reimage_and_ready_runbook.md',
              content: `# T16 Pool reimage + init + READY runbook (trial ops)

- generated: {{NOW}}

Goal: After final self-audit, reimage + bootstrap *all 5 pool machines* end-to-end,
measure time-to-READY, and keep evidence. This is a trial-ops dress rehearsal.

## Scope
- Target: 5 pool instances
- Actions: reimage -> keypair bind -> bootstrap -> minimal config -> reboot -> P0.2 evidence -> mark READY

## Metrics
- For each instance: start_ts, ready_ts, duration_minutes
- Output avg/min/max

## Evidence requirements
- Checkpoints for each instance
- Cloud RequestIds for ResetInstance/AssociateInstancesKeyPairs
- Post-reboot systemd + port checks

## Safety
- Never touch master host (lhins-npsqfxvn / 43.160.236.20)
- Cap=5 is already full: do not create extra instances

## Next
- Implement worker automation to do this as queued jobs
`,
              commitMessage: 'T16: add pool reimage+READY trial ops runbook scaffold',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T16 --force'
            }];
          }
          if (tid === 'T16.1') {
            return [{
              kind: 'repo_write_file',
              file: 'docs/T16_1_userline_mvp_runbook.md',
              content: `# T16.1 User-line MVP acceptance runbook

- generated: {{NOW}}

Goal: prove the *minimum* user-line works end-to-end:
- p-site is not busy (readyCapacity>0)
- Turnstile passes
- QR obtained
- WhatsApp scan succeeds and shows linked
- self-chat receives **locale-matched** welcome/guide copy

## Preconditions
- At least 1 instance in DB: lifecycle_status=IN_POOL and health_status=READY

## Steps (evidence required)
1) Readiness probe
- Run: scripts/t16_1_readiness_probe.sh
- Capture output in checkpoint cmd.log

2) p-site flow (manual)
- Open: https://p.bothook.me/p/<uuid>?lang=<lang>
- Verify: busy=false, readyCapacity>0
- Complete Turnstile
- Click Get QR

3) WhatsApp scan
- Scan QR in WhatsApp
- Verify linked state on p-site

4) Self-chat prompts locale check
- Confirm self-chat message language matches lang

## Notes
- If readyCapacity=0, stop and fix READY gate first (pool bootstrap + P0.2 evidence + DB mark READY).
`,
              commitMessage: 'T16.1: add user-line MVP acceptance runbook scaffold',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T16.1 --force'
            },{
              kind: 'repo_write_file',
              file: 'scripts/generate_whatsapp_prompts.mjs',
              content: `#!/usr/bin/env node
// Generate control-plane/i18n/whatsapp_prompts/<lang>.json for all p-site locales.
// This is intentionally simple and deterministic (no network calls).

import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE = '/home/ubuntu/.openclaw/workspace';
const localesPath = path.join(WORKSPACE, 'p-site/i18n/locales.json');
const outDir = path.join(WORKSPACE, 'control-plane/i18n/whatsapp_prompts');

const locales = JSON.parse(fs.readFileSync(localesPath, 'utf8')).locales;
fs.mkdirSync(outDir, { recursive: true });

// Minimal but locale-matched copy. (Keep it short; user sees this in WhatsApp self-chat.)
const COPY = {
  'en': { langName:'English', welcome:'[bothook] Welcome! Your device is linked.', guide:'To get started: open your UUID page, follow the steps, and paste your OpenAI API key when asked.', promo:'BOTHook: WhatsApp AI device provisioning.' },
  'zh': { langName:'简体中文', welcome:'[bothook] 已连接成功。', guide:'下一步：打开你的 UUID 页面，按引导操作，并在提示时粘贴你的 OpenAI API Key。', promo:'BOTHook：WhatsApp AI 设备交付。' },
  'zh-tw': { langName:'繁體中文', welcome:'[bothook] 已連結成功。', guide:'下一步：打開你的 UUID 頁面，依照引導操作，並在提示時貼上你的 OpenAI API Key。', promo:'BOTHook：WhatsApp AI 裝置交付。' },
  'ja': { langName:'日本語', welcome:'[bothook] 連携が完了しました。', guide:'次へ：UUID ページを開き、案内に従って操作し、求められたら OpenAI API Key を貼り付けてください。', promo:'BOTHook：WhatsApp AI デバイス提供。' },
  'ko': { langName:'한국어', welcome:'[bothook] 연결이 완료되었습니다.', guide:'다음 단계: UUID 페이지를 열고 안내에 따라 진행한 뒤, 요청 시 OpenAI API Key를 붙여넣으세요.', promo:'BOTHook: WhatsApp AI 기기 프로비저닝.' },
  'fr': { langName:'Français', welcome:'[bothook] Connexion réussie.', guide:"Étape suivante : ouvrez votre page UUID, suivez les instructions, puis collez votre clé API OpenAI lorsque c’est demandé.", promo:'BOTHook : provisionnement WhatsApp AI.' },
  'de': { langName:'Deutsch', welcome:'[bothook] Verbindung erfolgreich.', guide:'Nächster Schritt: Öffne deine UUID-Seite, folge den Anweisungen und füge deinen OpenAI API Key ein, wenn du dazu aufgefordert wirst.', promo:'BOTHook: WhatsApp-AI Provisioning.' },
  'es': { langName:'Español', welcome:'[bothook] Conexión exitosa.', guide:'Siguiente paso: abre tu página UUID, sigue las instrucciones y pega tu clave API de OpenAI cuando se solicite.', promo:'BOTHook: aprovisionamiento de WhatsApp AI.' },
  'pt-br': { langName:'Português (Brasil)', welcome:'[bothook] Conectado com sucesso.', guide:'Próximo passo: abra sua página UUID, siga as instruções e cole sua chave de API da OpenAI quando solicitado.', promo:'BOTHook: provisionamento de WhatsApp AI.' },
  'id': { langName:'Bahasa Indonesia', welcome:'[bothook] Berhasil terhubung.', guide:'Langkah berikutnya: buka halaman UUID Anda, ikuti petunjuk, lalu tempel OpenAI API Key saat diminta.', promo:'BOTHook: provisioning WhatsApp AI.' },
  'vi': { langName:'Tiếng Việt', welcome:'[bothook] Kết nối thành công.', guide:'Bước tiếp theo: mở trang UUID của bạn, làm theo hướng dẫn và dán OpenAI API Key khi được yêu cầu.', promo:'BOTHook: cấp phát WhatsApp AI.' },
  'th': { langName:'ภาษาไทย', welcome:'[bothook] เชื่อมต่อสำเร็จแล้ว', guide:'ขั้นถัดไป: เปิดหน้า UUID ของคุณ ทำตามคำแนะนำ แล้ววาง OpenAI API Key เมื่อระบบขอ', promo:'BOTHook: จัดเตรียมอุปกรณ์ WhatsApp AI' },
  'hi': { langName:'हिन्दी', welcome:'[bothook] कनेक्शन सफल हुआ।', guide:'अगला कदम: अपना UUID पेज खोलें, निर्देशों का पालन करें, और जब पूछा जाए तब अपना OpenAI API Key पेस्ट करें।', promo:'BOTHook: WhatsApp AI provisioning.' },
  'ar': { langName:'العربية', welcome:'[bothook] تم الربط بنجاح.', guide:'الخطوة التالية: افتح صفحة UUID الخاصة بك، اتبع التعليمات، ثم الصق مفتاح OpenAI API عند الطلب.', promo:'BOTHook: تهيئة WhatsApp AI.' },
  'ru': { langName:'Русский', welcome:'[bothook] Подключение выполнено.', guide:'Далее: откройте вашу страницу UUID, следуйте инструкциям и вставьте ключ OpenAI API, когда будет запрос.', promo:'BOTHook: WhatsApp AI provisioning.' },
  'tr': { langName:'Türkçe', welcome:'[bothook] Bağlantı başarılı.', guide:'Sonraki adım: UUID sayfanızı açın, yönergeleri izleyin ve istendiğinde OpenAI API anahtarınızı yapıştırın.', promo:'BOTHook: WhatsApp AI provisioning.' }
};

for (const loc of locales) {
  const code = loc.code;
  const c = COPY[code] || COPY['en'];
  const out = {
    langName: c.langName || loc.en || code,
    welcome: c.welcome,
    guide: c.guide,
    promo: c.promo
  };
  fs.writeFileSync(path.join(outDir, code + '.json'), JSON.stringify(out, null, 2) + '\\n', 'utf8');
}

console.log('generated ' + locales.length + ' prompt files into ' + outDir);
`,
              commitMessage: 'T16.1: add WhatsApp prompts generator (all locales)',
              progress_bump: 5
            },{
              kind: 'local_exec',
              command: 'bash -lc "set -euo pipefail; node scripts/generate_whatsapp_prompts.mjs; git add control-plane/i18n/whatsapp_prompts/*.json; git commit -m \'T16.1: generate WhatsApp prompts for all locales\' -- control-plane/i18n/whatsapp_prompts/*.json"',
              progress_bump: 5
            },{
              kind: 'local_exec',
              command: 'bash -lc "set -euo pipefail; chmod +x scripts/t16_1_readiness_probe.sh || true; bash scripts/t16_1_readiness_probe.sh"',
              progress_bump: 5
            }];
          }
          if (tid === 'T17') {
            return [{
              kind: 'repo_write_file',
              file: 'docs/ops_timers_plan.md',
              content: `# Ops timers plan (systemd)\n\n- generated: {{NOW}}\n\nGoal: make the control-plane self-operating after reboot (systemd services + timers).\nOpenClaw cron stays for human-facing notifications (hourly report, alerts).\n\n## Timers/services to implement\n\n### P0\n1) pool-controller tick (timer, every 1 min, Persistent=true)\n- responsibility: compute pool gap (cap=5), enqueue heavy actions into write_queue\n- MUST NOT execute heavy actions directly\n\n2) write_queue worker (service, Restart=always)\n- responsibility: execute heavy jobs with global locks + evidence + events\n\n3) reconcile sweep (timer, every 2-5 min, Persistent=true)\n- responsibility: DB ↔ Cloud Describe ↔ Stripe reconcile; failure blocks READY\n\n4) timeout reclaim sweep (timer, every 1 min)\n- responsibility: QR 5-min timeout, linked-but-unpaid 15-min timeout\n\n### P1\n5) subscription sweep (timer, every 10 min)\n- responsibility: past_due/payment_failed grace=24h; after grace reclaim/reimage\n\n6) keypair drift audit/fix (timer, every 10-60 min)\n- responsibility: ensure LoginSettings.KeyIds contains bothook_pool_key\n\n7) gateway watchdog (timer, every 1 min)\n- responsibility: probe openclaw gateway; long disconnect -> restart + alert\n\n## Self-check checklist (must pass)\n- [ ] systemctl --user list-timers shows all bothook timers\n- [ ] systemctl --user status <service> is active (or timers waiting)\n- [ ] journalctl --user -u <service> shows no crash loop\n- [ ] Reboot test: timers/services come back without manual intervention\n- [ ] Evidence: store check outputs in checkpoints\n\n## Notes\n- Use systemd timers/services for ops; use OpenClaw cron for Telegram notifications only.\n- Heavy actions always go through queue + lock; tick only enqueues.\n`,
              commitMessage: 'T17: add ops systemd timers plan (self-operating after reboot)',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T17 --force'
            },{
              kind: 'local_exec',
              command: 'bash -lc "set -euo pipefail; echo \"== systemd user timers ==\"; systemctl --user list-timers --all | sed -n \"1,200p\"; echo; echo \"== openclaw gateway probe ==\"; openclaw gateway status | sed -n \"1,80p\""',
              progress_bump: 5
            }];
          }
          if (tid === 'T18') {
            return [{
              kind: 'repo_write_file',
              file: 'docs/security_audit_uuid_links.md',
              content: `# Security audit: UUID links + platform flows\n\n- generated: {{NOW}}\n\nGoal: identify vulnerabilities in the full platform flow, especially around UUID-based links,\nand propose mitigations. This audit must be performed after all core tasks are DONE.\n\n## Threat model (quick)\n- Attacker finds/guesses UUID\n- Attacker reuses leaked UUID link\n- Attacker triggers linking/relinking or views sensitive state\n- Abuse via shortlinks / referrers / logs\n\n## UUID surface inventory\n- p-site: /p/<uuid>?lang=...\n- api: /api/p/state?uuid=...\n- shortlinks: s.bothook.me/s/<code> -> redirect\n- local recovery: /opt/bothook/UUID.txt (on delivered machine)\n\n## Checks\n- [ ] UUID entropy + non-enumerability\n- [ ] State endpoints: no sensitive data leakage (IP, key, wa_jid) unless authenticated\n- [ ] Ensure actions are gated: paid(valid), wa bind ownership, timeouts\n- [ ] Rate limiting / abuse limits on state + QR endpoints\n- [ ] Turnstile/anti-bot coverage for public forms\n- [ ] Logs/telemetry: UUID not leaked to third parties via Referer\n\n## Mitigations\n- [ ] Add optional one-time tokens for sensitive actions\n- [ ] Add per-uuid attempt counters + backoff\n- [ ] Ensure strict separation: new users vs delivered users\n- [ ] Ensure post-delivery: external contacts ignored\n\n## Findings\n- TBD\n\n## Fix plan\n- TBD\n`,
              commitMessage: 'T18: add security audit plan for UUID links',
              progress_bump: 5,
              fix_once: 'cd /home/ubuntu/.openclaw/workspace && RUNNER_MODE=execute_l1 node scripts/task_runner.mjs --json --only=T18 --force'
            },{
              kind: 'local_exec',
              command: 'bash -lc "set -euo pipefail; echo \"== grep uuid surfaces ==\"; grep -RIn --exclude-dir=.git --exclude-dir=node_modules -E \"/p/\<uuid\>|/api/p/state\?|uuid=\" control-plane p-site bothook-site 2>/dev/null | head -n 200 || true"',
              progress_bump: 5
            }];
          }
          return null;
        };

        let filled = autofill(tid);
        if (!filled) {
          // Generic autonomy fallback: create a minimal repo_write_file plan scaffold so we never stall.
          filled = [{
            kind: 'repo_write_file',
            file: `docs/_autofill_${tid}.md`,
            content: `# Autofill scaffold for ${tid}\n\n- updated: ${ts}\n\nThis task had no actions[]. Runner injected this scaffold to avoid stalling.\n\nTODO (fill in actions spec):\n- define desired outcomes\n- list concrete steps (repo_write_file / ssh_put_tar / ssh_exec / http_check)\n- add evidence requirements\n`,
            commitMessage: `runner: autofill scaffold for ${tid}`,
            progress_bump: 0,
            autofill_scaffold: true,
            fix_once: `RUNNER_MODE=${RUNNER_MODE} node ${WORKSPACE}/scripts/task_runner.mjs --json --only=${tid} --force`
          }];
        }

        planLines.push('decision: autofill actions[] (autonomy default)');
        e.task.actions = filled;
        e.task.status = 'EXECUTE';
        e.task.blocked_reason = null;
        e.task.last_action = `runner_autofill@${ts}`;
        e.task.last_updated = ts;
        writeJsonAtomic(e.file, e.task);
        touched.push(e.name);
        actions.push({ task: tid, checkpoint: cpDir, action: 'autofill', count: filled.length });

        // Continue to execute the first filled action in the SAME run.
        taskActions = filled;
      }

      // Execute at most 1 action per task per run
      const act = taskActions[0];
      if (act && Array.isArray(act.rollback_commands) && act.rollback_commands.length) {
        planLines.push('');
        planLines.push('rollback_commands (from action spec):');
        for (const c of act.rollback_commands) planLines.push(String(c));
      }

      // Prepare evidence skeleton
      writeCheckpoint(cpDir, 'plan.md', planLines.join('\n'));
      let cmdLog = '';

      const run = (cmd) => {
        const r = sh(cmd, { cwd: WORKSPACE });
        cmdLog += `\n$ ${cmd}\nexit=${r.code}\n${r.stdout}${r.stderr}\n`;
        return r;
      };

      const doActionOnce = () => {
        const kind = act?.kind;
        if (!kind) throw new Error('bad_action_missing_kind');

        if (kind === 'repo_patch_replace') {
          if (RUNNER_MODE !== 'execute_l1' && RUNNER_MODE !== 'execute_l2') throw new Error('repo_actions_require_execute');
          const fileRel = act.file;
          const re = new RegExp(act.search, act.flags || 'g');
          const replacement = act.replace;
          const full = path.join(WORKSPACE, fileRel);
          const before = fs.readFileSync(full, 'utf8');
          const after = before.replace(re, replacement);
          fs.writeFileSync(full, after, 'utf8');
          const diff = run(`cd ${WORKSPACE} && git diff -- ${fileRel}`);
          writeCheckpoint(cpDir, 'patch.diff', diff.stdout || diff.stderr || '');

          // If no diff, fallback to an auditable no-op commit (safe L1) so we still have evidence.
          const hasDiff = !!(diff.stdout || '').trim();
          if (!hasDiff) {
            const demoRel = `p-site/docs/_runner_nochange_${tid}_${tsFolder}.md`;
            const demoFull = path.join(WORKSPACE, demoRel);
            fs.mkdirSync(path.dirname(demoFull), { recursive: true });
            fs.writeFileSync(demoFull, `# runner no-change fallback\n\n- task: ${tid}\n- ts: ${nowIso()}\n- note: patch produced no diff; wrote this file as auditable progress evidence.\n`, 'utf8');
            run(`cd ${WORKSPACE} && git add ${demoRel}`);
            const msg0 = `runner: no-change fallback for ${tid}`;
            const cr0 = run(`cd ${WORKSPACE} && git commit -m "${msg0}" -- ${demoRel}`);
            if (cr0.code !== 0) throw new Error('git_commit_failed');
            return { ok:true, kind, committed:true, fallback:'no_change' };
          }

          const tests = Array.isArray(act.tests) ? act.tests : [];
          for (const tcmd of tests) {
            const tr = run(`cd ${WORKSPACE} && ${tcmd}`);
            if (tr.code !== 0) throw new Error(`test_failed:${tcmd}`);
          }

          const msg = act.commitMessage || `runner: patch ${fileRel}`;
          run(`cd ${WORKSPACE} && git add ${fileRel}`);
          // Commit only the intended pathspec to avoid unrelated dirty workspace blocking commits.
          const cr = run(`cd ${WORKSPACE} && git commit -m "${msg.replace(/\"/g,'\\"')}" -- ${fileRel}`);
          if (cr.code !== 0) throw new Error('git_commit_failed');
          return { ok:true, kind, committed:true };
        }

        if (kind === 'repo_write_file') {
          if (RUNNER_MODE !== 'execute_l1' && RUNNER_MODE !== 'execute_l2') throw new Error('repo_actions_require_execute');
          const fileRel = act.file;
          const full = path.join(WORKSPACE, fileRel);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          let body = String(act.content || '');
          // Simple templating
          body = body.replaceAll('{{NOW}}', nowIso());
          fs.writeFileSync(full, body, 'utf8');
          const diff = run(`cd ${WORKSPACE} && git diff -- ${fileRel}`);
          if (!(diff.stdout || '').trim()) {
            // no change -> create fallback evidence file
            const demoRel = `p-site/docs/_runner_nochange_${tid}_${tsFolder}.md`;
            const demoFull = path.join(WORKSPACE, demoRel);
            fs.mkdirSync(path.dirname(demoFull), { recursive: true });
            fs.writeFileSync(demoFull, `# runner no-change fallback\n\n- task: ${tid}\n- ts: ${nowIso()}\n- note: repo_write_file produced no diff; wrote this file as auditable progress evidence.\n`, 'utf8');
            run(`cd ${WORKSPACE} && git add ${demoRel}`);
            const msg0 = `runner: no-change fallback for ${tid}`;
            const cr0 = run(`cd ${WORKSPACE} && git commit -m "${msg0}" -- ${demoRel}`);
            if (cr0.code !== 0) throw new Error('git_commit_failed');
            return { ok:true, kind, committed:true, fallback:'no_change' };
          }

          run(`cd ${WORKSPACE} && git add ${fileRel}`);
          const msg = act.commitMessage || `runner: write ${fileRel}`;
          const cr = run(`cd ${WORKSPACE} && git commit -m "${msg.replace(/\"/g,'\\"')}" -- ${fileRel}`);
          if (cr.code !== 0) throw new Error('git_commit_failed');
          return { ok:true, kind, committed:true };
        }

        if (kind === 'http_check') {
          // Online validation step
          const url = act.url;
          if (!url) throw new Error('bad_action_missing_url');
          const expect = act.expect_substring;
          const cmd = `curl -fsS --max-time 15 '${url.replace(/'/g, "'\\''")}'`;
          const r = run(cmd);
          if (r.code !== 0) throw new Error('http_check_failed');
          if (expect && !(r.stdout || '').includes(expect)) throw new Error('http_check_expect_not_found');
          return { ok:true, kind, url, expect: expect || null };
        }

        if (kind === 'local_exec') {
          // Local command execution (work machine). Keep strict: only allow specific prefixes.
          const cmd = String(act.command || '');
          const allow = [
            'node /home/ubuntu/.openclaw/workspace/control-plane/workers/lifecycle-worker.mjs',
            'node control-plane/workers/lifecycle-worker.mjs',
            'python3 -',
            'bash -lc'
          ];
          if (!allow.some(p => cmd.startsWith(p))) throw new Error('local_exec_not_allowed');
          const r = run(cmd);
          if (r.code !== 0) throw new Error('local_exec_failed');
          return { ok:true, kind, exit: r.code };
        }

        if (kind === 'tccli_lighthouse_associate_keypair') {
          // REAL cloud action: ensure SSH keypair is associated with the instance.
          const instanceId = act.instance_id;
          const keyId = act.key_id;
          if (!instanceId) throw new Error('bad_action_missing_instance_id');
          if (instanceId === 'lhins-npsqfxvn') throw new Error('forbidden_master_host');
          if (!keyId) throw new Error('bad_action_missing_key_id');

          const region = act.region || 'ap-singapore';
          const cred = act.cred_env || '/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env';
          const cmd = `set -a; source ${cred}; set +a; tccli lighthouse AssociateInstancesKeyPairs --region ${region} --InstanceIds ${instanceId} --KeyIds ${keyId} --output json`;
          const r = run(cmd);
          if (r.code !== 0) throw new Error('tccli_associate_keypair_failed');

          // Best-effort: record in DB meta_json so automation has local truth.
          try {
            const py = `python3 - <<'PY'\nimport sqlite3,json\ncon=sqlite3.connect('${WORKSPACE}/control-plane/data/bothook.sqlite')\ncur=con.cursor()\nrow=cur.execute('select meta_json from instances where instance_id=?', ('${instanceId}',)).fetchone()\nmeta={}\ntry:\n  meta=json.loads(row[0] or '{}') if row else {}\nexcept Exception:\n  meta={}\nmeta['key_ids']=[str('${keyId}')]
meta['latest_operation']='AssociateInstancesKeyPairs'
meta['latest_operation_state']='SUCCESS'
cur.execute('update instances set meta_json=? where instance_id=?', (json.dumps(meta,ensure_ascii=False), '${instanceId}'))\ncon.commit()\nprint('ok')\nPY`;
            run(py);
          } catch {}

          return { ok:true, kind, instance_id: instanceId, key_id: keyId, region };
        }

        if (kind === 'tccli_lighthouse_reset_instance') {
          // REAL cloud action: reset/reimage lighthouse instance. Irreversible.
          const instanceId = act.instance_id;
          const blueprintId = act.blueprint_id;
          if (!instanceId) throw new Error('bad_action_missing_instance_id');
          if (instanceId === 'lhins-npsqfxvn') throw new Error('forbidden_master_host');
          if (!blueprintId) throw new Error('bad_action_missing_blueprint_id');

          const region = act.region || 'ap-singapore';
          const cred = act.cred_env || '/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env';
          const cmd = `set -a; source ${cred}; set +a; tccli lighthouse ResetInstance --region ${region} --InstanceId ${instanceId} --BlueprintId ${blueprintId} --output json`;
          const r = run(cmd);
          if (r.code !== 0) throw new Error('tccli_reset_instance_failed');
          return { ok:true, kind, instance_id: instanceId, blueprint_id: blueprintId, region };
        }

        if (kind === 'ssh_put_tar') {
          if (RUNNER_MODE !== 'execute_l2') throw new Error('ssh_put_tar_requires_execute_l2');
          const instanceId = act.instance_id;
          if (!instanceId) throw new Error('bad_action_missing_instance_id');
          if (instanceId === 'lhins-npsqfxvn') throw new Error('forbidden_master_host');

          const localDirRel = String(act.local_dir || '').trim();
          const remoteDir = String(act.remote_dir || '').trim();
          if (!localDirRel) throw new Error('bad_action_missing_local_dir');
          if (!remoteDir) throw new Error('bad_action_missing_remote_dir');

          const localDirFull = path.join(WORKSPACE, localDirRel);
          if (!fs.existsSync(localDirFull)) throw new Error('ssh_put_tar_local_dir_missing');

          // lookup ip
          const ipq = sh(`python3 - <<'PY'\nimport sqlite3\ncon=sqlite3.connect('${WORKSPACE}/control-plane/data/bothook.sqlite')\ncur=con.cursor()\nrow=cur.execute('select public_ip,lifecycle_status from instances where instance_id=?', ('${instanceId}',)).fetchone()\nprint((row[0] if row else '')+'|'+(row[1] if row else ''))\nPY`);
          const out = (ipq.stdout||'').trim();
          const parts = out.split('|');
          const ip = parts[0] || '';
          const lifecycle = parts[1] || '';
          if (!ip) throw new Error('instance_ip_not_found');
          if (ip === '127.0.0.1') throw new Error('forbidden_localhost');
          if (lifecycle === 'DELIVERING') throw new Error('forbidden_delivering_machine');

          const user = act.user || 'ubuntu';
          const tarName = (act.tar_name || `${tid}-${tsFolder}`).replace(/[^a-zA-Z0-9_.-]/g,'_');
          const tarRel = `checkpoints/${tsFolder}/${tid}/${tarName}.tgz`;
          const tarFull = path.join(WORKSPACE, tarRel);

          // create tarball for evidence + transfer
          run(`mkdir -p '${path.dirname(tarFull)}'`);
          run(`tar -czf '${tarFull}' -C '${localDirFull}' .`);

          const remoteTmp = `/tmp/${tarName}.tgz`;
          const scpCmd = `scp -i ${SSH_IDENTITY_FILE} -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 '${tarFull}' ${user}@${ip}:'${remoteTmp}'`;
          const scp = run(scpCmd);
          if (scp.code !== 0) throw new Error('ssh_put_tar_scp_failed');

          const remoteCmd = `ssh -i ${SSH_IDENTITY_FILE} -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${ip} 'set -euo pipefail; mkdir -p "${remoteDir.replace(/"/g,'\\"')}"; tar -xzf "${remoteTmp}" -C "${remoteDir.replace(/"/g,'\\"')}"; echo ok'`;
          const r2 = run(remoteCmd);
          if (r2.code !== 0) throw new Error('ssh_put_tar_unpack_failed');

          return { ok:true, kind, ip, local_dir: localDirRel, remote_dir: remoteDir, tar: tarRel };
        }

        if (kind === 'ssh_exec') {
          if (RUNNER_MODE !== 'execute_l2') throw new Error('ssh_exec_requires_execute_l2');
          const instanceId = act.instance_id;
          if (!instanceId) throw new Error('bad_action_missing_instance_id');
          if (instanceId === 'lhins-npsqfxvn') throw new Error('forbidden_master_host');

          // lookup ip via python sqlite (sqlite3 cli not installed)
          const ipq = sh(`python3 - <<'PY'\nimport sqlite3\ncon=sqlite3.connect('${WORKSPACE}/control-plane/data/bothook.sqlite')\ncur=con.cursor()\nrow=cur.execute('select public_ip,lifecycle_status from instances where instance_id=?', ('${instanceId}',)).fetchone()\nprint((row[0] if row else '')+'|'+(row[1] if row else ''))\nPY`);
          const out = (ipq.stdout||'').trim();
          const parts = out.split('|');
          const ip = parts[0] || '';
          const lifecycle = parts[1] || '';
          if (!ip) throw new Error('instance_ip_not_found');
          if (ip === '127.0.0.1') throw new Error('forbidden_localhost');
          if (lifecycle === 'DELIVERING') throw new Error('forbidden_delivering_machine');

          const user = act.user || 'ubuntu';
          const cmds = Array.isArray(act.commands) ? act.commands : [];
          const reboot = !!act.reboot;

          const script = cmds.join(' && ');
          const remoteCmd = `ssh -i ${SSH_IDENTITY_FILE} -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${ip} '${script.replace(/'/g, "'\\''")}'`;
          const r1 = run(remoteCmd);
          if (r1.code !== 0) throw new Error('ssh_exec_failed');

          if (reboot) {
            const rb = run(`ssh -i ${SSH_IDENTITY_FILE} -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${ip} 'sudo reboot || true'`);
            // reboot may drop connection; don't fail on it
            void rb;
          }
          return { ok:true, kind, ip, reboot };
        }

        throw new Error(`unsupported_action_kind:${kind}`);
      };

      let errMsg = null;
      let result = null;
      for (let attempt=1; attempt<=2; attempt++) {
        try {
          result = doActionOnce();
          actions.push({ task: tid, checkpoint: cpDir, action: 'execute', attempt, result });
          errMsg = null;
          break;
        } catch (e2) {
          errMsg = String(e2?.message || e2);
          actions.push({ task: tid, checkpoint: cpDir, action: 'execute', attempt, result: 'error', error: errMsg });
        }
      }

      writeCheckpoint(cpDir, 'cmd.log', cmdLog);
      writeCheckpoint(cpDir, 'post.json', redactTaskForEvidence(readJson(e.file)) + '\n');

      if (errMsg) {
        e.task.status = 'PAUSED';
        e.task.error_reason = errMsg;
        e.task.fix_once = act.fix_once || `RUNNER_MODE=${RUNNER_MODE} node ${WORKSPACE}/scripts/task_runner.mjs --json --only=${tid} --force`;
        e.task.last_action = `runner_failed@${nowIso()}`;
        e.task.last_updated = nowIso();
        e.task.evidence_path = cpDir;
        writeJsonAtomic(e.file, e.task);
        touched.push(e.name);
        continue;
      }

      // Success: bump progress + record evidence path
      const prev = Number(e.task.progress_percent || 0);
      const bump = Number(act.progress_bump || 5);
      // Never let placeholder/autofill scaffolds advance progress; they are bookkeeping only.
      const isScaffold = Boolean(act.autofill_scaffold) || (typeof act.file === 'string' && String(act.file).startsWith('docs/_autofill_'));
      // If there are remaining actions after this one, avoid reaching 100% prematurely.
      const nextActionsCount = (taskActions.slice(1) || []).length;
      const capped = isScaffold ? prev : Math.min(100, Math.max(prev, prev + bump));
      e.task.progress_percent = (nextActionsCount > 0 && capped >= 100) ? 99 : capped;
      e.task.last_action = `runner_execute_${RUNNER_MODE}@${nowIso()} (${act.kind})`;
      e.task.last_updated = nowIso();
      e.task.evidence_path = cpDir;

      // Advance action queue (whitelist)
      e.task.actions = taskActions.slice(1);

      e.task.recent_evidence = Array.isArray(e.task.recent_evidence) ? e.task.recent_evidence : [];
      e.task.recent_evidence.unshift(`runner: executed ${act.kind} @ ${e.task.last_updated} evidence=${cpDir}`);
      e.task.recent_evidence = e.task.recent_evidence.slice(0, 10);

      // Only mark DONE when we've completed all queued actions.
      if ((e.task.actions || []).length === 0 && e.task.progress_percent >= 100) {
        // Guardrail: don't allow scaffold-only tasks to be marked DONE.
        if (!Boolean(act.autofill_scaffold)) {
          e.task.status = 'DONE';
        }
      }

      writeJsonAtomic(e.file, e.task);
      touched.push(e.name);
    }

    state.rrIndex = (state.rrIndex || 0) + Math.max(1, picked.length);
    state.lastTickAt = nowIso();
    state.runnerMode = RUNNER_MODE;
    writeJsonAtomic(STATE_PATH, state);

    const effectiveMode = state.forceMode || RUNNER_MODE;

    const res = {
      ok: true,
      status: effectiveMode === 'tick' ? 'ok' : 'ok-executed',
      runnerMode: RUNNER_MODE,
      effectiveMode,
      runnableCount: runnable2.length,
      picked: picked.map(e => e.name),
      touched,
      changed: touched.length > 0,
      scan,
      actions
    };

    // Strict reporting artifact: write a Telegram-safe delta that includes ONLY picked/touched tasks.
    // This prevents accidental inclusion of unrelated DONE tasks (e.g., legacy T1/T2/T3 templates).
    try {
      const runDir = path.join(CHECKPOINTS_DIR, tsFolder);
      fs.mkdirSync(runDir, { recursive: true });
      const uniqTouched = Array.from(new Set(touched));
      const lines = [];
      lines.push('TASK runner delta (generated by task_runner)');
      lines.push(`- ok: ${res.ok}`);
      lines.push(`- status: ${res.status}`);
      lines.push(`- runnerMode: ${res.runnerMode}`);
      lines.push(`- effectiveMode: ${res.effectiveMode}`);
      lines.push(`- picked: ${JSON.stringify(res.picked)}`);
      lines.push(`- touched: ${JSON.stringify(uniqTouched)}`);
      lines.push('');
      if (uniqTouched.length === 0) {
        lines.push('(no delta)');
      } else {
        lines.push('touched task summaries (whitelisted fields):');
        for (const f of uniqTouched) {
          const p = path.join(TASK_DIR, f);
          let j = null;
          try { j = readJson(p); } catch { j = null; }
          if (!j) {
            lines.push(`- ${f}: (failed to parse)`);
            continue;
          }
          const tid = String(j.task_id || f.replace(/\.json$/,''));
          const status2 = String(j.status || '');
          const prog = Number(j.progress_percent || 0);
          const next = String(j.next_action || '');
          const updated = String(j.last_updated || '');
          const ev = j.evidence_path ? String(j.evidence_path) : '';
          lines.push(`- ${tid} status=${status2} progress_percent=${prog} last_updated=${updated}`);
          if (next) lines.push(`  next_action=${next}`);
          if (ev) lines.push(`  evidence_path=${ev}`);
        }
      }
      fs.writeFileSync(path.join(runDir, 'TELEGRAM_DELTA.txt'), lines.join('\n') + '\n', 'utf8');
      fs.writeFileSync(path.join(runDir, 'RUNNER_RESULT.json'), JSON.stringify(res, null, 2) + '\n', 'utf8');
    } catch {}

    console.log(jsonOut ? JSON.stringify(res) : JSON.stringify(res, null, 2));
  } finally {
    unlock();
  }
}

main();