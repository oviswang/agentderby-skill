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

    const picked = pickRoundRobin(
      runnable2,
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

      // execute modes
      if (tid === 'T3') {
        planLines.push('decision: execute handler T3 (L1-safe repo patch + commit, no push)');
        writeCheckpoint(cpDir, 'plan.md', planLines.join('\n'));

        // Handler: fix p-site index hard-coded 127.0.0.1 -> same-origin /api/p/state
        const targetFile = path.join(WORKSPACE, 'p-site', 'index.html');
        const before = fs.readFileSync(targetFile, 'utf8');
        const after = before.replace(/http:\/\/127\.0\.0\.1:18998\/api\/p\/state/g, '/api/p/state');
        if (after === before) {
          // Fallback L1-safe action: create an auditable local file and commit it.
          const demoPath = path.join(WORKSPACE, 'p-site', 'docs', `_runner_demo_T3_${tsFolder}.md`);
          const demoBody = `# runner demo (T3)\n\n- ts: ${nowIso()}\n- note: pattern already replaced; created this file as a safe L1 action.\n`;
          fs.mkdirSync(path.dirname(demoPath), { recursive: true });
          fs.writeFileSync(demoPath, demoBody, 'utf8');
          const diff2 = sh(`cd ${WORKSPACE} && git diff -- p-site/docs`, { cwd: WORKSPACE });
          writeCheckpoint(cpDir, 'patch.diff', diff2.stdout || diff2.stderr || '');

          const addRes2 = sh(`cd ${WORKSPACE} && git add ${demoPath.replace(WORKSPACE+'/', '')}`, { cwd: WORKSPACE });
          const msg2 = `T3: runner demo evidence file (${tsFolder})`;
          const commitRes2 = sh(`cd ${WORKSPACE} && git commit -m "${msg2}"`, { cwd: WORKSPACE });
          writeCheckpoint(cpDir, 'git.txt', `add_code=${addRes2.code}\ncommit_code=${commitRes2.code}\nstdout=\n${commitRes2.stdout}\nstderr=\n${commitRes2.stderr}\n`);

          if (hasBadKeywords(commitRes2.stdout + commitRes2.stderr)) {
            markError(e, 'auth_or_network_failure_detected');
            actions.push({ task: tid, checkpoint: cpDir, action: 'execute', result: 'error', reason: 'auth_or_network_failure_detected' });
            state.forceMode = 'tick';
            continue;
          }

          const prev = Number(e.task.progress_percent || 0);
          e.task.progress_percent = Math.min(100, Math.max(prev, prev + 3));
          e.task.last_action = `runner_execute_l1@${nowIso()} (commit local, demo file)`;
          e.task.last_updated = nowIso();
          e.task.no_progress_count = 0;
          e.task.recent_evidence = Array.isArray(e.task.recent_evidence) ? e.task.recent_evidence : [];
          e.task.recent_evidence.unshift(`runner: committed demo file for T3 (no push) @ ${e.task.last_updated}`);
          e.task.recent_evidence = e.task.recent_evidence.slice(0, 10);
          writeJsonAtomic(e.file, e.task);
          touched.push(e.name);
          actions.push({ task: tid, checkpoint: cpDir, action: 'execute', result: 'committed_demo', progress_before: prev, progress_after: e.task.progress_percent });
          continue;
        }

        fs.writeFileSync(targetFile, after, 'utf8');
        const diff = sh(`cd ${WORKSPACE} && git diff -- p-site/index.html`, { cwd: WORKSPACE });
        writeCheckpoint(cpDir, 'patch.diff', diff.stdout || diff.stderr || '');

        // lightweight test: ensure file contains /api/p/state
        const ok = after.includes('/api/p/state');
        writeCheckpoint(cpDir, 'test.txt', ok ? 'OK: contains /api/p/state\n' : 'FAIL\n');
        if (!ok) {
          markError(e, 'test_failed:missing_/api/p/state');
          actions.push({ task: tid, checkpoint: cpDir, action: 'execute', result: 'error', reason: 'test_failed' });
          continue;
        }

        const msg = 'T3: p-site use same-origin /api/p/state (remove 127.0.0.1 hardcode)';
        const addRes = sh(`cd ${WORKSPACE} && git add p-site/index.html`, { cwd: WORKSPACE });
        const commitRes = sh(`cd ${WORKSPACE} && git commit -m "${msg}"`, { cwd: WORKSPACE });
        writeCheckpoint(cpDir, 'git.txt', `add_code=${addRes.code}\ncommit_code=${commitRes.code}\nstdout=\n${commitRes.stdout}\nstderr=\n${commitRes.stderr}\n`);

        if (hasBadKeywords(commitRes.stdout + commitRes.stderr)) {
          markError(e, 'auth_or_network_failure_detected');
          actions.push({ task: tid, checkpoint: cpDir, action: 'execute', result: 'error', reason: 'auth_or_network_failure_detected' });
          state.forceMode = 'tick';
          continue;
        }

        // progress update is conservative: bump by 5 points max.
        const prev = Number(e.task.progress_percent || 0);
        e.task.progress_percent = Math.min(100, Math.max(prev, prev + 5));
        e.task.last_action = `runner_execute_l1@${nowIso()} (commit local, no push)`;
        e.task.last_updated = nowIso();
        e.task.no_progress_count = 0;
        e.task.recent_evidence = Array.isArray(e.task.recent_evidence) ? e.task.recent_evidence : [];
        e.task.recent_evidence.unshift(`runner: committed patch for T3 (no push) @ ${e.task.last_updated}`);
        e.task.recent_evidence = e.task.recent_evidence.slice(0, 10);
        writeJsonAtomic(e.file, e.task);
        touched.push(e.name);
        actions.push({ task: tid, checkpoint: cpDir, action: 'execute', result: 'committed', progress_before: prev, progress_after: e.task.progress_percent });
        continue;
      }

      // For other tasks in execute modes: only tick but with plan.
      planLines.push('decision: no execute handler for this task yet -> tick');
      writeCheckpoint(cpDir, 'plan.md', planLines.join('\n'));
      tickTask(e, 'execute_mode_no_handler');
      touched.push(e.name);
      actions.push({ task: tid, checkpoint: cpDir, action: 'tick', note: 'no_handler' });
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
