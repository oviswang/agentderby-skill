# BOTHook artifacts v0.2.10

Change summary:
- Provision server stability: remove heavy PNG generation from interval loop; cache ASCII QR text and generate PNG on-demand (cached by hash) to avoid event-loop stalls.
- Keep QR PNG correct (half-block glyphs █/▀/▄) + quiet zone.
- /api/wa/qr remains resilient with on-demand parsing.
- Force relink cleanup path: wipe OpenClaw WhatsApp auth under credentials/whatsapp.
- Systemd: run bothook-provision as ubuntu, PrivateTmp=false.
- User-machine does not send onboarding welcome by default (control-plane is source of truth).

Notes:
- This version is intended to stabilize end-to-end flow: P-site shows QR from user-machine, user scans successfully.
