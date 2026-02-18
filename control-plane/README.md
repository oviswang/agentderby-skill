# BOTHook control plane (local)

This folder contains the first-pass control-plane storage + jobs for managing a large pool of delivery machines.

Design goals (10万台规模):
- **Single-writer** DB updates (avoid SQLite write contention)
- Snapshot tables for current state + append-only `events`
- Local file archival for old events (Phase 1)

## DB
- Default path: `control-plane/data/bothook.sqlite`
- Override with `BOTHOOK_DB_PATH`

## Scripts
- `migrate.mjs`: initialize/migrate schema
- `writer.mjs`: single-writer that consumes a local queue table and applies batch updates
- `sync_lighthouse_instances.mjs`: periodically sync instance inventory/expiry from Tencent Lighthouse (tccli)
- `archive_events.mjs`: roll older events out to local jsonl files

> Secrets are read from env (optionally from `/home/ubuntu/.openclaw/credentials/tencentcloud_bothook_provisioner.env`). Never print secrets.
