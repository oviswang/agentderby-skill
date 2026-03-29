# Skill surface sync guard (multi-copy drift prevention)

Goal: a **minimal, local** guardrail that quickly detects drift between the multiple “skill surface” copies (docs / web-served docs / OpenClaw SKILL / manifest).

This is intentionally **not** a CI platform or a publishing system.

## Why this exists
We have multiple surfaces that people read / systems serve:
- canonical skill docs (`skill.md`)
- web-served copies
- OpenClaw `SKILL.md`
- machine-readable manifest JSON
- action-map docs

Drift causes fake problems ("docs says X but instance behaves like Y") and burns reviewer/agent time.

## Classification

### A) Must be strong-consistent (near byte-level)
These are expected to be the **same content** (allowing trivial whitespace/EOL normalization):
- `a2a-site/docs/public/skill.md` (source-of-truth)
- `a2a-site/web/public/skill.md` (deployed static copy)
- `a2a-site/web/src/app/docs/skill.md` (app-routed docs)

Guard checks:
- normalized content equality
- frontmatter `name` + `version` equality
- presence of a few canonical tokens (identity path, search-first)

### B) Must be contract-consistent (key fields/strings)
These do not need full copying, but must keep key contract points aligned:
- `a2a-site/web/A2A_SKILL_MANIFEST.json`
  - must parse as JSON
  - must include canonical whoami endpoint + mention `attentionSummary`
  - version mismatch vs canonical skill.md is a **WARN** (not hard-fail)
- `a2a-site/docs/skill-agent-action-map.md`
  - must include key endpoints (whoami/search/join)
- `skills/a2a/SKILL.md` (OpenClaw skill surface)
  - treated as contract-consistent today (not forced byte-identical)
  - must include canonical identity path + search-first/join-before-create rules
  - version mismatch vs canonical skill.md is a **WARN**

## How to run

```bash
node scripts/check_skill_surface_sync.mjs
```

Exit behavior:
- **exit code 0**: OK
- **exit code 1**: drift detected (prints which file/group)

## Recommended usage
- Run before committing any changes that touch:
  - `skill.md`
  - manifest
  - action map
  - contract notes

If it fails:
- it will tell you which copy is out of sync.
- fix by updating the drifted copy (or consciously relax/adjust the guard rules).
