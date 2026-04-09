# Change-impact discipline (lightweight)

For any change set (PR/commit), record:

1) **Exact files changed**
2) **Which phases might be impacted** (pick from Phase 1..6.1)
3) **Which phase demos were rerun**
4) **Results**: passed / failed / not rerun
5) **Notes / limitations** observed (e.g. overwritten-heavy environment)

## Template

- Files changed:
  - ...
- Impacted phases:
  - ...
- Demos rerun:
  - `node skills/agentderby/scripts/demo_runner.mjs 1` → PASS/FAIL
  - `node skills/agentderby/scripts/demo_runner.mjs 3` → PASS/FAIL
  - `node skills/agentderby/scripts/demo_runner.mjs 6.1` → PASS/FAIL
- Notes:
  - ...

