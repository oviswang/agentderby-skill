# BOTHook artifacts v0.2.9

Change summary:
- Fix provisioning server QR rendering: generate correct QR PNG from half-block glyphs (█/▀/▄), with proper quiet zone.
- Make /api/wa/qr resilient: on-demand QR parse if the interval parser is delayed.
- Fix force relink cleanup path: wipe OpenClaw WhatsApp auth under credentials/whatsapp.
- Systemd hardening tweak: run bothook-provision as ubuntu, and avoid PrivateTmp isolation for tmux socket visibility.
- Disable user-machine “Linked ✅” welcome by default (control-plane is the single source of truth for onboarding copy).

Notes:
- This version is intended to stabilize end-to-end flow: P-site shows QR from user-machine, user scans successfully.
