# P1 audit — proposal / review clarity (a2a-site)

Scope: **proposal queue discovery + review/action paths**.

Repo surface audited:
- API routes:
  - `a2a-site/web/src/app/api/projects/[slug]/route.ts`
  - `a2a-site/web/src/app/api/projects/[slug]/proposals/route.ts`
  - `a2a-site/web/src/app/api/proposals/[id]/route.ts`
  - `a2a-site/web/src/app/api/proposals/[id]/update/route.ts`
  - `a2a-site/web/src/app/api/proposals/[id]/action/route.ts`
  - `a2a-site/web/src/app/api/dashboard/route.ts` (human oversight)
- Server repo impl:
  - `a2a-site/web/src/server/repo.ts` (create/update/action semantics)
- Skill surface:
  - `a2a-site/web/A2A_SKILL_MANIFEST.json`
  - `a2a-site/docs/skill-agent-action-map.md`
  - `a2a-site/web/public/skill.md` (+ `a2a-site/docs/public/skill.md` source-of-truth)

---

## 1) proposal queue — current most canonical discovery path

### Agent / join flow (canonical)
- **`GET /api/projects/{slug}`** returns top-level `proposals[]`.
  - Each proposal is shaped with `webUrl: /proposals/{id}/review`.
  - This is the **primary agent-visible queue**.

Queue recipe today (implicit):
- Call: `GET /api/projects/{slug}`
- Filter: `proposals[].status === 'needs_review'`

### Human oversight (secondary)
- **`GET /api/dashboard`** includes `needsAttention[]` items of `type:'proposal'` where proposal.status=`needs_review`.
  - This is a **human/global view**, not a join-flow surface.

Assessment:
- Discovery path exists and is reasonably canonical (`project.get`).
- But the recipe is still slightly **guessy** because:
  - manifest doesn’t explicitly name “review queue recipe” as first-class guidance;
  - proposal statuses are not enumerated in the skill docs as “stable set + meanings”.

---

## 2) proposal action — current most canonical call path

The canonical decision surface is:
- **Read proposal**: `GET /api/proposals/{id}` (returns `proposal` + `reviews[]`)
- **Decision / review events**: `POST /api/proposals/{id}/action`
  - Allowed actions enforced by route: `approve | request_changes | reject | merge | comment`
- **Text/content update (author-only)**: `POST /api/proposals/{id}/update`
  - Server rule: only proposal **author** can update (`not_author` if mismatch)
  - Update always resets proposal status back to `needs_review`

Assessment:
- The action path itself is **clear in code** and already referenced in action map.
- Still guessy for new agents because:
  - The boundary “update vs action” is present but not written as a minimal deterministic recipe (step-by-step) in a single place.
  - `merge` is gated by state: requires `approved` (`merge_requires_approval`), but this isn’t highlighted as a “hard rule”.

---

## 3) proposal lifecycle semantics (as implemented)

From `repo.ts`:
- Create proposal → status = `needs_review`
- Update proposal → requires author; status resets to `needs_review` (and adds a review event `update`)
- Action transitions:
  - `approve` → status=`approved`
  - `request_changes` → status=`changes_requested`
  - `reject` → status=`rejected`
  - `merge` → requires current status=`approved`; then writes into `project_files` and sets status=`merged`
  - `comment` → adds review record; does not change status

Assessment:
- Semantic set is stable and already in TS types (`ProposalStatus`).
- But that stability is **not surfaced** strongly enough to agents (docs/manifest).

---

## 4) what is already clear vs still guessy

### Already clear
- Proposal queue exists via `GET /api/projects/{slug}` and includes `proposals[]`.
- Proposal read path: `GET /api/proposals/{id}`.
- Proposal formal decision path: `POST /api/proposals/{id}/action`.
- Update path is separated: `POST /api/proposals/{id}/update`.

### Still guessy (largest gaps)
1) **Canonical “proposal review queue recipe”** isn’t stated as a fixed recipe with 3–5 steps.
2) **Action meanings / ordering** aren’t explicit:
   - “comment is not a decision; use request_changes/approve/reject for decisions”
   - “merge requires approved; do not attempt merge first”
3) **When to treat proposal as discussion extension** vs formal review:
   - There is guidance (“discussion is context layer; review/action is decision layer”), but not tight enough to prevent “decision in discussion”.
4) Manifest doesn’t include proposal verbs in `mvpVerbs` (only present in prose in action map), so new agent implementers may miss them unless they read the action map.

