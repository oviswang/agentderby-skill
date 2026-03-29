#!/usr/bin/env node
/**
 * Minimal guardrail: detect drift across skill/doc/manifest multi-copies.
 *
 * Goals:
 * - Strong-consistency group: byte-level equivalence after whitespace normalization.
 * - Contract-consistency group: assert presence of key tokens/strings.
 *
 * No business logic changes; safe to run locally.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function normEol(s) {
  return s.replace(/\r\n/g, '\n');
}

function normStrong(s) {
  // Normalize for "near byte-level" equivalence:
  // - EOL normalization
  // - trim trailing whitespace
  // - ensure trailing newline
  const t = normEol(s)
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trimEnd();
  return t + '\n';
}

function extractFrontmatter(text) {
  const s = normEol(text);
  // Some files have an HTML comment header before the frontmatter.
  const start = s.indexOf('---\n');
  if (start === -1) return null;
  const s2 = s.slice(start);
  if (!s2.startsWith('---\n')) return null;
  const end = s2.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const body = s2.slice(4, end + 1); // include last \n
  const kv = new Map();
  for (const line of body.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!m) continue;
    kv.set(m[1], m[2]);
  }
  return { raw: body, kv };
}

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(msg);
}

const STRONG_GROUP = [
  'a2a-site/docs/public/skill.md',
  'a2a-site/web/public/skill.md',
  'a2a-site/web/src/app/docs/skill.md',
];

// This repo uses skills/a2a/SKILL.md as the OpenClaw skill surface.
// It is not byte-identical to a2a-site/docs/public/skill.md today, so we treat it as
// contract-consistent (version + key contract snippets) instead of forcing a full copy.
const CONTRACT_FILES = {
  manifest: 'a2a-site/web/A2A_SKILL_MANIFEST.json',
  actionMap: 'a2a-site/docs/skill-agent-action-map.md',
  openclawSkill: 'skills/a2a/SKILL.md',
};

// Tokens we consider contract-critical.
const CONTRACT_TOKENS = {
  skillMd: [
    'GET /api/auth/whoami',
    'Do not probe `/api/me`',
    'search-first',
    'join-before-create',
  ],
  actionMap: ['GET /api/auth/whoami', 'GET /api/search', 'POST /api/projects/{slug}/join'],
  // manifest describes attentionSummary shape; may not include the exact JSON key token
  // so we check for the term without quotes.
  manifest: ['"/api/auth/whoami"', '"identity.whoami"', 'attentionSummary'],
};

function rel(p) {
  return p.replace(/^\.?\/?/, '');
}

// 1) Strong consistency: normalized content equivalence.
{
  const missing = STRONG_GROUP.filter((p) => !exists(path.join(ROOT, p)));
  if (missing.length) {
    fail(`Missing strong-consistency files: ${missing.map(rel).join(', ')}`);
  } else {
    const basePath = path.join(ROOT, STRONG_GROUP[0]);
    const base = normStrong(readText(basePath));

    for (const p of STRONG_GROUP.slice(1)) {
      const full = path.join(ROOT, p);
      const cur = normStrong(readText(full));
      if (cur !== base) {
        fail(`DRIFT (strong): ${rel(p)} differs from ${rel(STRONG_GROUP[0])}`);
      }
    }

    ok(`OK (strong): ${STRONG_GROUP.length} files in sync`);

    // Frontmatter check (name/version must match across strong group)
    const fm0 = extractFrontmatter(readText(basePath));
    if (!fm0) {
      fail(`Missing frontmatter in ${rel(STRONG_GROUP[0])}`);
    } else {
      const name0 = fm0.kv.get('name');
      const ver0 = fm0.kv.get('version');
      for (const p of STRONG_GROUP.slice(1)) {
        const fm = extractFrontmatter(readText(path.join(ROOT, p)));
        if (!fm) {
          fail(`Missing frontmatter in ${rel(p)}`);
          continue;
        }
        if (fm.kv.get('name') !== name0) fail(`DRIFT (frontmatter:name): ${rel(p)} != ${JSON.stringify(name0)}`);
        if (fm.kv.get('version') !== ver0) fail(`DRIFT (frontmatter:version): ${rel(p)} != ${JSON.stringify(ver0)}`);
      }
      ok(`OK (frontmatter): name=${name0 ?? '∅'} version=${ver0 ?? '∅'}`);
    }

    // Token presence (skill md must contain a few canonical strings)
    for (const token of CONTRACT_TOKENS.skillMd) {
      if (!base.includes(token)) fail(`Missing token in skill.md strong group: ${JSON.stringify(token)}`);
    }
  }
}

// 2) Contract consistency checks.
{
  // Manifest exists + version alignment suggestion
  const manifestPath = path.join(ROOT, CONTRACT_FILES.manifest);
  if (!exists(manifestPath)) {
    fail(`Missing manifest: ${rel(CONTRACT_FILES.manifest)}`);
  } else {
    const txt = readText(manifestPath);
    for (const token of CONTRACT_TOKENS.manifest) {
      if (!txt.includes(token)) fail(`DRIFT (manifest): missing token ${JSON.stringify(token)}`);
    }
    try {
      const m = JSON.parse(txt);
      const v = String(m.version || '');
      const skillFm = extractFrontmatter(readText(path.join(ROOT, STRONG_GROUP[0])));
      const sv = skillFm?.kv.get('version') || '';
      if (v && sv && v !== sv) {
        // Not failing hard: manifest versioning might be decoupled. But warn loudly.
        console.warn(`WARN: manifest version (${v}) != skill.md version (${sv}). If they are meant to track together, bump manifest.`);
      }
      ok(`OK (manifest): parsed name=${String(m.name || '')} version=${v || '∅'}`);
    } catch (e) {
      fail(`Invalid JSON in manifest: ${rel(CONTRACT_FILES.manifest)} (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // Action map tokens
  const actionMapPath = path.join(ROOT, CONTRACT_FILES.actionMap);
  if (!exists(actionMapPath)) {
    fail(`Missing action map: ${rel(CONTRACT_FILES.actionMap)}`);
  } else {
    const txt = readText(actionMapPath);
    for (const token of CONTRACT_TOKENS.actionMap) {
      if (!txt.includes(token)) fail(`DRIFT (action map): missing token ${JSON.stringify(token)}`);
    }
    ok('OK (action map): key endpoints present');
  }

  // OpenClaw SKILL surface (contract-only)
  const ocSkillPath = path.join(ROOT, CONTRACT_FILES.openclawSkill);
  if (!exists(ocSkillPath)) {
    fail(`Missing OpenClaw skill: ${rel(CONTRACT_FILES.openclawSkill)}`);
  } else {
    const txt = readText(ocSkillPath);
    // Must reference canonical identity and search-first/join rule.
    // OpenClaw SKILL.md may not include the explicit whoami path (it is a product contract, not required for install flow).
    // We treat whoami presence as a warning, while still hard-requiring the workflow rules.
    const required = ['search-first', 'join-before-create'];
    for (const token of required) {
      if (!txt.includes(token)) fail(`DRIFT (OpenClaw SKILL.md): missing token ${JSON.stringify(token)}`);
    }

    if (!txt.includes('/api/auth/whoami')) {
      console.warn('WARN: OpenClaw SKILL.md does not mention /api/auth/whoami (canonical identity path). Consider adding for clarity.');
    }

    // Version alignment: warn if different from canonical skill.md
    const skillFm = extractFrontmatter(readText(path.join(ROOT, STRONG_GROUP[0])));
    const sv = skillFm?.kv.get('version') || '';
    const ocFm = extractFrontmatter(txt);
    const ocv = ocFm?.kv.get('version') || '';
    if (sv && ocv && sv !== ocv) {
      console.warn(`WARN: OpenClaw SKILL.md version (${ocv}) != canonical skill.md version (${sv}). Consider aligning.`);
    }
    ok('OK (OpenClaw SKILL.md): contract tokens present');
  }
}

if (process.exitCode === 1) {
  console.error('\ncheck_skill_surface_sync: FAILED');
} else {
  console.log('\ncheck_skill_surface_sync: OK');
}
