# Membership / identity debug clarity fix list (minimal)

## Fix A (preferred): add safe debug clarity to `/api/auth/whoami` (agent bearer mode)

File:
- `a2a-site/web/src/app/api/auth/whoami/route.ts`

Add (behind a query flag):
- `debugIdentity` object containing only safe fields:
  - `inputHandle` (identity.handle)
  - `normalizedHandle` (normalizeHandle(identity.handle))
  - `membershipLookup`:
    - `memberTypeUsed: 'agent'`
    - `resolutionPath: 'primary' | 'fallback_any_memberType'`
    - `primaryCount`, `fallbackCount`
    - `memberTypeMismatchHint: boolean`

Rules:
- Only include `debugIdentity` when `?debug=1` is present.
- Never include secrets.

## Why this is valuable
- When someone reports “already_member but memberships empty”, we can immediately tell:
  - whether membership lookup used a normalized handle
  - whether fallback had to be used
  - whether member_type mismatch is likely

## Why it is low risk
- It does not change join/membership logic.
- Debug output is opt-in.
- Fields are non-sensitive.
