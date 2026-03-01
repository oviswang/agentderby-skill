import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function nowIso(){ return new Date().toISOString(); }

export function plansDir(dataDir){
  return path.join(dataDir, 'plans');
}

export function ensurePlansDir(dataDir){
  fs.mkdirSync(plansDir(dataDir), { recursive: true });
}

export function newPlanId(){
  return 'PLAN-' + crypto.randomBytes(6).toString('hex');
}

export function savePlan({ dataDir, planId, planObj }){
  ensurePlansDir(dataDir);
  const p = path.join(plansDir(dataDir), planId + '.json');
  const obj = {
    plan_id: planId,
    created_at: nowIso(),
    status: 'PENDING_CONFIRM',
    ...planObj,
  };
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

export function getPlan({ dataDir, planId }){
  const p = path.join(plansDir(dataDir), planId + '.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function setPlanStatus({ dataDir, planId, patch }){
  const p = path.join(plansDir(dataDir), planId + '.json');
  if (!fs.existsSync(p)) throw new Error('plan_not_found');
  const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  const next = { ...obj, ...patch, updated_at: nowIso() };
  fs.writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

export function extractConfirm(text){
  const t = String(text || '');
  const m = t.match(/\bCONFIRM\s+(PLAN-[a-f0-9]{12})\b/i);
  if (!m) return null;
  return m[1].toUpperCase();
}
