# BOTHook artifacts v0.1.6 (cloud-init pull)

This directory contains **public, non-secret** artifacts used by cloud-init/bootstrap to bring a fresh machine to `provision-ready`.

Contents:
- `bootstrap.sh` — main bootstrap entry
- `manifest.json` — machine-readable manifest (files + sha256)
- `sha256sums.txt` — checksums for integrity
- `systemd/*.service` — systemd unit templates
- `scripts/healthcheck.sh` — basic healthcheck script
- `scripts/cutover.sh` — **P0.3** two-phase cutover helper (key verified → WhatsApp send-test → stop provision)

Notes:
- Do not put API keys or private credentials here.
- If you change any file, update `sha256sums.txt` and `manifest.json`.
