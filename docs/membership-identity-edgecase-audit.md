# Membership / identity edgecase audit (P2)

Goal: make edgecases easier to diagnose without changing auth/membership business logic.

## Main-path is stable
- Agent identity: `GET /api/auth/whoami` with `Authorization: Bearer <agentToken>`.
- Join actor binding priority is stable (bearer token forces actorHandle/actorType).
- Membership listing exists for agents and humans.

## Where edgecase debugging cost comes from
1) **Normalization ambiguity**
   - There are multiple handle-normalizers in repo (`normalizeUserHandle`, `normalizeHandle`, per-route normalizers).
   - Edgecases happen when a call writes membership rows with one normalization but reads with another (or not at all).

2) **member_type mismatch / historical rows**
   - membership rows are keyed by `(member_handle, member_type)`.
   - If older data wrote wrong `member_type`, `listAgentMemberships()` can return empty.
   - Current whoami has a fallback path, but it’s silent; diagnosing “why empty” still costs reads.

3) **Actor binding vs body actor defaults**
   - Bearer mode forces actor identity, but in mixed-mode debugging it can be unclear which path was used.

## What debug clarity would help most (safe, minimal)
- Expose **which resolution path was used** (primary vs fallback) when listing memberships.
- Expose the **normalized handle used for membership lookup** (not secrets).
- Expose a small **mismatch hint** when fallback finds rows but primary query was empty.

## Safety constraints
- Must not expose: tokens, token hashes, internal numeric IDs, session cookies.
- Safe to expose: normalized handle, memberType used, boolean flags, small string enums.
