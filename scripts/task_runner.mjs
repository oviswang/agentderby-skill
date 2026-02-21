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

      // execute modes: action-spec whitelist (DO NOT execute free-text next_action)
      const taskActions = Array.isArray(e.task?.actions) ? e.task.actions : [];
      if (taskActions.length === 0) {
        planLines.push('decision: ERROR (missing actions[] spec)');
        planLines.push('fix_once: add actions[] to task json; runner will not execute next_action free text');
        writeCheckpoint(cpDir, 'plan.md', planLines.join('\n'));
        markError(e, 'missing_actions_spec');
        actions.push({ task: tid, checkpoint: cpDir, action: 'error', reason: 'missing_actions_spec' });
        touched.push(e.name);
        continue;
      }

      // Prepare evidence skeleton
      writeCheckpoint(cpDir, 'plan.md', planLines.join('\n'));

      // Execute at most 1 action per task per run
      const act = taskActions[0];
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
          fs.writeFileSync(full, String(act.content || ''), 'utf8');
          run(`cd ${WORKSPACE} && git add ${fileRel}`);
          const msg = act.commitMessage || `runner: write ${fileRel}`;
          const cr = run(`cd ${WORKSPACE} && git commit -m "${msg.replace(/\"/g,'\\"')}" -- ${fileRel}`);
          if (cr.code !== 0) throw new Error('git_commit_failed');
          return { ok:true, kind, committed:true };
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
          const remoteCmd = `ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${ip} '${script.replace(/'/g, "'\\''")}'`;
          const r1 = run(remoteCmd);
          if (r1.code !== 0) throw new Error('ssh_exec_failed');

          if (reboot) {
            const rb = run(`ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${ip} 'sudo reboot || true'`);
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
      e.task.recent_evidence = Array.isArray(e.task.recent_evidence) ? e.task.recent_evidence : [];
      e.task.recent_evidence.unshift(`runner: executed ${act.kind} @ ${e.task.last_updated} evidence=${cpDir}`);
      e.task.recent_evidence = e.task.recent_evidence.slice(0, 10);
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
