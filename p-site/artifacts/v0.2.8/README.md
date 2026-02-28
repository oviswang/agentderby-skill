# BOTHook artifacts v0.2.8

Change summary:
- Fix provisioning server tmux capture bug (use `tmux capture-pane -p` output directly; do not rely on `tmux show-buffer` without `save-buffer`).
- Make QR block extraction tolerant to partial captures (accept unclosed tail blocks when sufficient QR rows present).

Notes:
- This version is intended to improve stability of "user-machine generates QR" (M1).
