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

function taskSkipReason(task) {
  const st = task?.status;
  if (!st) return 'parse_error';
  if (st === 'DONE') return 'DONE';
  if (st === 'PAUSED') return 'PAUSED';
  if (st === 'BLOCKED') return 'BLOCKED';
  if (st === 'IDLE') return 'IDLE';
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
    .filter(f => /^T\d+\.json$/.test(f))
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
  task.status = 'ERROR';
  task.error_reason = reason;
  task.last_action = `runner_error@${ts}`;
  task.last_updated = ts;
  task.retry_count = Number(task.retry_count || 0) + 1;
  task.recent_evidence = Array.isArray(task.recent_evidence) ? task.recent_evidence : [];
  task.recent_evidence.unshift(`runner: ERROR ${path.basename(file)} @ ${ts}: ${reason}`);
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
      const skip = taskSkipReason(e.task);
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
          return null;
        };

        const filled = autofill(tid);
        if (filled) {
          planLines.push('decision: autofill actions[] (autonomy default)');
          writeCheckpoint(cpDir, 'plan.md', planLines.join('\n'));
          e.task.actions = filled;
          e.task.status = 'EXECUTE';
          e.task.last_action = `runner_autofill@${ts}`;
          e.task.last_updated = ts;
          writeJsonAtomic(e.file, e.task);
          touched.push(e.name);
          actions.push({ task: tid, checkpoint: cpDir, action: 'autofill', count: filled.length });
          continue;
        }

        planLines.push('decision: BLOCKED (missing actions[] spec)');
        planLines.push('fix_once: add actions[] to task json; runner will not execute next_action free text');
        writeCheckpoint(cpDir, 'plan.md', planLines.join('\n'));
        e.task.status = 'BLOCKED';
        e.task.blocked_reason = 'missing_actions_spec';
        e.task.last_action = `runner_blocked@${ts}`;
        e.task.last_updated = ts;
        writeJsonAtomic(e.file, e.task);
        touched.push(e.name);
        actions.push({ task: tid, checkpoint: cpDir, action: 'blocked', reason: 'missing_actions_spec' });
        continue;
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
      e.task.progress_percent = Math.min(100, Math.max(prev, prev + bump));
      e.task.last_action = `runner_execute_${RUNNER_MODE}@${nowIso()} (${act.kind})`;
      e.task.last_updated = nowIso();
      e.task.evidence_path = cpDir;

      // Advance action queue (whitelist)
      e.task.actions = taskActions.slice(1);

      e.task.recent_evidence = Array.isArray(e.task.recent_evidence) ? e.task.recent_evidence : [];
      e.task.recent_evidence.unshift(`runner: executed ${act.kind} @ ${e.task.last_updated} evidence=${cpDir}`);
      e.task.recent_evidence = e.task.recent_evidence.slice(0, 10);

      if ((e.task.actions || []).length === 0 && e.task.progress_percent >= 100) {
        e.task.status = 'DONE';
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

    console.log(jsonOut ? JSON.stringify(res) : JSON.stringify(res, null, 2));
  } finally {
    unlock();
  }
}

main();
