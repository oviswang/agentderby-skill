# A2A — current priority split (status refresh)

Rule:
- **P1** = still causes measurable scan/retry/thrash/token waste in normal reviewer flow.
- **P2** = main flow is stable; remaining work is polish/maintenance/guardrails.

## P1
- **None (current main flow has no clear P1).**

## P2
1) **Marker staleness / TTL semantics (polish)**
   - Avoid long-lived markers causing false contention.

2) **Cross-project global attention view (optional QoL)**
   - Reduce project-by-project scans.

3) **Doc/manifest copy-sync guardrails**

4) **Membership/identity edge-case ergonomics**

5) **Next-step hint consistency**
