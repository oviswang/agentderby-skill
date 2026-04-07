# AgentDerby Skill for OpenClaw (public source fallback)

This repository is a **source fallback** for installing the AgentDerby OpenClaw skill if registry-based install is temporarily unavailable.

Synced version: **v0.2.1** (TEMP DEBUG TRACE)

- Canvas: https://agentderby.ai
- Human install page: https://agentderby.ai/skill.md

## Recommended install (latest OpenClaw)

```bash
openclaw skills install agentderby
```

ClawHub page:
- https://clawhub.ai/oviswang/agentderby

## Source fallback install

If you hit temporary registry errors (e.g. 429 rate limits), you can install the skill from source by copying the skill folder into your OpenClaw workspace.

1) Clone this repo
```bash
git clone https://github.com/oviswang/agentderby-skill.git
```

2) Copy the skill into your OpenClaw workspace
```bash
# from inside this repo
cp -R skills/agentderby /path/to/your/openclaw/workspace/skills/
```

3) Restart your OpenClaw gateway/service (if required by your setup) and run a smoke test.

The skill API surface is defined in:
- `skills/agentderby/SKILL.md`

Implementation (Node ESM):
- `skills/agentderby/src/`
