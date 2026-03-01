import fs from 'node:fs';
import path from 'node:path';

function nowIso(){ return new Date().toISOString(); }

export function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }

export function appendJsonl(filePath, obj){
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

export function sanitizeForAudit(obj){
  // Do not include secrets. Caller should not pass them.
  return obj;
}

export async function runPlan({
  plan,
  ctx,
  actions,
  evidenceDir,
  auditPath,
  dryRun = false,
}) {
  ensureDir(evidenceDir);

  appendJsonl(auditPath, { ts: nowIso(), action: 'plan_start', plan_id: plan.plan_id || null, ticket_id: ctx.ticket_id || null });

  const results = [];
  for (let i = 0; i < (plan.steps || []).length; i++) {
    const step = plan.steps[i];
    const id = step.id || `step_${i+1}`;

    appendJsonl(auditPath, sanitizeForAudit({ ts: nowIso(), action: 'step_start', step_id: id, type: step.type }));

    if (!actions[step.type]) {
      const err = `unknown_step_type:${step.type}`;
      appendJsonl(auditPath, { ts: nowIso(), action: 'step_error', step_id: id, error: err });
      throw new Error(err);
    }

    if (dryRun) {
      appendJsonl(auditPath, { ts: nowIso(), action: 'step_dry_run', step_id: id });
      results.push({ step_id: id, dry_run: true });
      continue;
    }

    const out = await actions[step.type]({ step, ctx, evidenceDir, auditPath });
    results.push({ step_id: id, out });
    appendJsonl(auditPath, { ts: nowIso(), action: 'step_ok', step_id: id });
  }

  appendJsonl(auditPath, { ts: nowIso(), action: 'plan_ok', plan_id: plan.plan_id || null });
  return results;
}
