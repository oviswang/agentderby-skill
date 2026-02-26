# BOTHook — Cloud-init bootstrap (user machine) TODO

Goal: cloud-init as primary. No control-plane bottleneck. User provides OpenAI key.

## Definition
- Control-plane host: p.bothook.me + control-plane API (18998). Should only coordinate + store state.
- User machine: delivered instance running OpenClaw gateway + bothook-provision (18999). Should do the heavy work (QR/login, messages, self-heal).

## Work items (checklist)

### Phase 0 — Baseline capture (done)
- [x] Identify user-machine init entrypoints (systemd units, scripts)
  - bothook-provision.service -> /opt/bothook/provision/server.mjs
  - openclaw-gateway.service -> /opt/bothook/bin/openclaw-gateway-start.sh
  - bothook-postboot-verify.service -> /opt/bothook/bin/postboot_verify.sh

### Phase 1 — Fix LLM auth/key behavior on user machine (no more anthropic error)
- [~] Ensure agent never defaults to anthropic on fresh machine.
  - note: on test machine, `openclaw models set openai/gpt-5.2` works and models list now includes openai.
- [~] Ensure /home/ubuntu/.openclaw/agents/main/agent/auth-profiles.json exists.
  - implemented in pool/postboot_verify.sh (self-heal)
- [ ] If OpenAI key missing:
  - [ ] Agent should NOT crash; should send a short guide asking user to provide OpenAI key.
  - [ ] Do not send provider error messages.
- [ ] Add postboot verify check: "auth store present + default provider OK".

### Phase 2 — Welcome/guide messages must be sent locally (no exit_code=127)
- [ ] Move welcome_unpaid send execution to user machine (local openclaw message send).
- [ ] Add idempotency (uuid + template_version) to avoid duplicates.
- [ ] Add retry with backoff; record result to local state + control-plane event.

### Phase 3 — READY gate automation (pool admission)
- [ ] Expand /opt/bothook/bin/postboot_verify.sh checks:
  - [ ] openclaw-gateway active + port 18789
  - [ ] bothook-provision active + /healthz
  - [ ] tmux installed
  - [ ] whatsapp creds dir writable
  - [ ] (optional) minimal send test disabled by default
- [ ] Only when ok==true: ready report to control-plane.

### Phase 4 — Cloud-init packaging
- [ ] Produce a single cloud-init payload or install script that:
  - [ ] Installs dependencies (node/openclaw/tmux)
  - [ ] Places /opt/bothook/* assets
  - [ ] Installs systemd units
  - [ ] Enables + starts services
  - [ ] Runs postboot verify (or waits for systemd)
- [ ] Document rerun/rollback.

## Progress log
- 2026-02-26: started
- 2026-02-26: Phase0 done; began Phase1 baseline (model default fix on test box)
