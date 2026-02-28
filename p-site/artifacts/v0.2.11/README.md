# BOTHook artifacts v0.2.11

Change summary:
- Onboarding: after device is linked, proactively send full welcome_unpaid from control-plane; on any self-chat inbound before paid, repeat the same welcome_unpaid.
- Suppress embedded-agent missing-key warnings during onboarding (no noisy model warnings to the user).
- Provision server stability: cache ASCII QR and generate PNG on-demand.

Notes:
- This version is intended to stabilize end-to-end flow: P-site shows QR from user-machine, user scans successfully.
