# Localhost policy (owner rule)

## Hard rule: do not touch *localhost* OpenClaw config without explicit consent

**Scope clarification (important):**
- **Localhost** = this control-plane/master host where the agent is running.
- **User machine** = any provisioned/allocated instance (e.g. `43.160.238.29`) accessed over SSH.

### Localhost rule
- **Strictly forbidden**: any operation that reads/writes/patches/overwrites localhost OpenClaw config file `~/.openclaw/openclaw.json` **unless the owner explicitly agrees in chat**.
- This includes commands/tools that implicitly overwrite the config:
  - `openclaw doctor --fix`
  - `openclaw config set ...`
  - `openclaw configure`
  - any command that prints `Config overwrite: ~/.openclaw/openclaw.json ...`

### User machine rule
- On user machines, the agent **may operate with full admin rights as needed** (including editing `/home/ubuntu/.openclaw/openclaw.json`), unless the owner sets a machine-specific restriction.

## Allowed without consent (read-only)

- `openclaw doctor` (without `--fix`) is allowed.
- Direct file reads are allowed **only** when needed for diagnosis and only in a read-only manner.

## Workflow requirement

- Before any local config change, ask for consent using a clear yes/no question, e.g.:
  - "I need to modify ~/.openclaw/openclaw.json on this machine. OK to proceed?"

Date added: 2026-02-24
Source: owner instruction in WhatsApp chat
