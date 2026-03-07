# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## BOTHook key domains (work machine)

Owner-defined roles (memorize):
- `api.bothook.me` — business API entry + webhooks
- `p.bothook.me` — provisioning/opening pages (e.g. `/p/<id>`), QR + onboarding flows
- `s.bothook.me` — shortlink service (`/s/{code}`)
- `gw.bothook.me` — PRO LLM gateway / model proxy (API traffic + auth)
- `bothook.me` — main marketing site

## Hosting (work machine)

- **Work machine hosts bothook.me and p.bothook.me** (and future `s.bothook.me`) — not a deliverable pool machine.
- Web server: **Caddy** (system service)
- Config: `/etc/caddy/Caddyfile`
  - `bothook.me` → static files at `/home/ubuntu/.openclaw/workspace/bothook-site`
  - `p.bothook.me` → static files at `/home/ubuntu/.openclaw/workspace/p-site`
  - `bothook.me` also proxies `handle_path /api/support/*` → `127.0.0.1:18888` (support-server)

## Pool SSH access (control-plane → pool/user machines)

- Shared pool SSH keypair (used by `poolSsh` in control-plane):
  - Private key: `/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519`
  - Public key: `/home/ubuntu/.openclaw/credentials/pool_ssh/id_ed25519.pub`
- Note: This is a shared key for pool machines (not per-user). If we ever move to per-instance/per-user keys, we must persist the mapping (instance_id → key id/fingerprint) in DB and verify on every allocation.

## User machine standard services (pool instances)

### BOTHook provisioning / Baileys
- systemd service: `bothook-provision.service`
- unit file: `/etc/systemd/system/bothook-provision.service`
- working dir: `/opt/bothook/provision`
- data dir env: `PROVISION_DATA_DIR=/opt/bothook/provision/data`
- port env: `PROVISION_PORT=18999` (binds to 127.0.0.1)
- start cmd: `/usr/bin/node /opt/bothook/provision/server.mjs`
- logs: `journalctl -u bothook-provision.service -n 200 --no-pager`
- local HTTP (binds to 127.0.0.1:18999):
  - `GET /healthz` → ok
  - `POST /api/wa/start` body `{ "uuid": "<session-id>", "force": false }`
  - `GET /api/wa/status?uuid=<session-id>`
  - `GET /api/wa/qr?uuid=<session-id>`

### OpenClaw gateway (observed)
- observed process form: `/usr/bin/node /usr/lib/node_modules/openclaw/dist/index.js gateway --port 18789`
- check status: `openclaw status` (shows WhatsApp linked state)

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
