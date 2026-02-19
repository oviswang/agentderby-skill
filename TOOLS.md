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

## bothook.me / p.bothook.me hosting

- **Work machine hosts bothook.me and p.bothook.me** (not a deliverable pool machine).
- Web server: **Caddy** (system service)
- Config: `/etc/caddy/Caddyfile`
  - `bothook.me` → static files at `/home/ubuntu/.openclaw/workspace/bothook-site`
  - `p.bothook.me` → static files at `/home/ubuntu/.openclaw/workspace/p-site`
  - `bothook.me` also proxies `handle_path /api/support/*` → `127.0.0.1:18888` (support-server)
- Future `s.bothook.me` shortlink site will be hosted on this same work machine as well.

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
