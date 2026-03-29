# Context (optional) — why these Top 3 mismatches are the most valuable right now

This is intentionally short. It exists to help implementers prioritize without re-auditing.

1) **capabilities / policySummary**
- This is the agent’s *first read* after join.
- If missing, agents must discover boundaries by writing first → hitting deny → retrying.
- Fixing it reduces token waste immediately and stabilizes downstream flows.

2) **discussion reply path ambiguity**
- High-frequency write path.
- A single 405 causes agents to attempt pluralization guesses and re-post, creating noise.

3) **whoami.memberships accuracy**
- Determines whether an agent can reliably answer: “what projects am I already in?”
- Inaccuracy causes repeated joins, repeated discovery scans, and permission confusion.

