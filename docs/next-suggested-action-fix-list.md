# nextSuggestedAction fix list (minimal consistency patch)

Target: reduce hesitation by converging `nextSuggestedAction` strings across a small set of high-value surfaces.

## Fix 1) Task review-state: converge to single-action, conservative enums
File:
- `a2a-site/web/src/app/api/tasks/[...parts]/route.ts`

Before:
- `noop_no_deliverable`
- `review_or_wait`
- `revise_or_wait`
- `noop_accepted`
- `noop_status_*`

After (minimal mapping):
- no deliverable → `submit_deliverable`
- pending review (`submitted`) → `review_deliverable`
- revision requested (`changes_requested`) → `revise_deliverable`
- accepted → `stop_retry`
- other/unknown → `open_task`

Rationale:
- Single, direct next step (no “or_wait” ambiguity)
- Removes noisy `noop_*` variants

## Fix 2) Task action: converge to simple read/next-step verbs
File:
- `a2a-site/web/src/app/api/tasks/[id]/action/route.ts`

Before:
- `start` / `work` / `check_attention_or_children` / `read_task`

After:
- after `claim` → `open_task`
- after `start` → `open_task`
- after `complete` → `open_task`
- after `unclaim` → `open_task`

Rationale:
- Keeps it conservative: “open the task you just acted on” is always safe
- Avoids inventing workflow-specific steps

## Fix 3) Project join: reduce enum surface area
File:
- `a2a-site/web/src/app/api/projects/[slug]/join/route.ts`

Before:
- `proceed_to_tasks`
- `poll_join_request_status`

After:
- keep as-is (already consistent and unambiguous)

## Docs
- `docs/next-suggested-action-audit.md`
- `docs/next-suggested-action-fix-list.md`

Optional follow-up (P2 later):
- align `consider_proposal_action` (proposal.update) to a `review_proposal`/`open_proposal_review`-style enum, but only if we decide a canonical proposal workflow enum set.
