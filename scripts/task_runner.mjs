#!/usr/bin/env node
/**
 * BOTHook task runner (minimal)
 *
 * Purpose: provide a deterministic heartbeat-driven "runner" that:
 * - scans /home/ubuntu/.openclaw/tasks/T*.json
 * - selects up to N runnable tasks (priority asc, round-robin)
 * - performs ONE minimal unit per task: update checkpoint fields + append evidence
 *
 * NOTE: This runner does NOT execute the task's next_action text. That would be unsafe.
 * It only produces auditable heartbeat progression + explicit runner_missing->runner_present transition.
 */

import fs from 'node:fs';
import path from 'node:path';

const TASK_DIR = '/home/ubuntu/.openclaw/tasks';
const STATE_PATH = '/home/ubuntu/.openclaw/workspace/memory/task-runner-state.json';
const LOCK_PATH = '/tmp/bothook.task-runner.lock';

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
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

function tickTask(entry) {
  const { file, task } = entry;
  const ts = nowIso();
  task.last_action = `runner_tick@${ts}`;
  task.last_updated = ts;
  task.retry_count = Number(task.retry_count || 0);
  task.recent_evidence = Array.isArray(task.recent_evidence) ? task.recent_evidence : [];
  task.recent_evidence.unshift(`runner: ticked ${path.basename(file)} @ ${ts} (no-op safe tick)`);
  task.recent_evidence = task.recent_evidence.slice(0, 10);
  writeJsonAtomic(file, task);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const jsonOut = args.has('--json');
  const maxTasks = Number((process.argv.find(a => a.startsWith('--maxTasks=')) || '').split('=')[1] || 3);

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

    const picked = pickRoundRobin(
      runnable.sort((a, b) => (a.task.priority ?? 999) - (b.task.priority ?? 999)),
      state.rrIndex || 0,
      maxTasks
    );

    const touched = [];
    for (const e of picked) {
      // Only touch if file is stale enough to avoid spamming.
      if (!shouldTouch(e.file, 10)) continue;
      tickTask(e);
      touched.push(e.name);
    }

    state.rrIndex = (state.rrIndex || 0) + Math.max(1, picked.length);
    state.lastTickAt = nowIso();
    writeJsonAtomic(STATE_PATH, state);

    const res = {
      ok: true,
      status: 'ok',
      runnableCount: runnable.length,
      picked: picked.map(e => e.name),
      touched,
      changed: touched.length > 0,
      scan
    };

    console.log(jsonOut ? JSON.stringify(res) : JSON.stringify(res, null, 2));
  } finally {
    unlock();
  }
}

main();
