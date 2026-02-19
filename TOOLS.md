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

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
