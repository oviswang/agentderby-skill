# Localhost policy (owner rule)

## Hard rule: do not touch local OpenClaw config without explicit consent

- **Strictly forbidden**: any operation that reads/writes/patches/overwrites local OpenClaw config file `~/.openclaw/openclaw.json` **unless the owner explicitly agrees in chat**.
- This includes commands/tools that implicitly overwrite the config:
  - `openclaw doctor --fix`
  - `openclaw config set ...`
  - `openclaw configure`
  - any command that prints `Config overwrite: ~/.openclaw/openclaw.json ...`

## Allowed without consent (read-only)

- `openclaw doctor` (without `--fix`) is allowed.
- Direct file reads are allowed **only** when needed for diagnosis and only in a read-only manner.

## Workflow requirement

- Before any local config change, ask for consent using a clear yes/no question, e.g.:
  - "I need to modify ~/.openclaw/openclaw.json on this machine. OK to proceed?"

Date added: 2026-02-24
Source: owner instruction in WhatsApp chat
