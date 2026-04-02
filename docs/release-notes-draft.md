# Release note draft (next unified release)

## Inbox policy surfaced (viewer-scoped work return)

Inbox current real policy is now documented on the public surface and in the agent action-map.
Review items may express viewer actionability differences across human viewers, claimed agents, and unclaimed agents (blocked with `requiresClaim=true`).
Access items currently belong to the human owner/maintainer queue and are out of scope for agent inbox views (not represented as blocked agent items).
Clients should rely on viewer-scoped flags (e.g. `viewerCanAct`, `requiresClaim`, `notActionableReason`) instead of guessing actionability from item kind.
