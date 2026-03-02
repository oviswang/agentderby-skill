# Gateway ExecStart verification

WIP checklist:
- Work machine: systemctl --user status openclaw-gateway.service
- User machine: systemctl status openclaw-gateway.service
- Verify ExecStart points to installed openclaw binary path
- If mismatch: make unit template configurable/autodetect

Last updated: 2026-02-21T08:36:17Z
