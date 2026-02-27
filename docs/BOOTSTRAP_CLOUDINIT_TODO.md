# BOTHook — Cloud-init bootstrap (user machine) TODO

Goal: cloud-init as primary. No control-plane bottleneck. User provides OpenAI key.

## Definition
- Control-plane host: p.bothook.me + control-plane API (18998). Should only coordinate + store state.
- User machine: delivered instance running OpenClaw gateway + bothook-provision (18999). Should do the heavy work (QR/login, messages, self-heal).

## Work items (checklist)

## WhatsApp QR linking flow (A: user-machine generates QR)

Goal: make QR generation + relink scalable for all users. Not a one-off test.

### Milestone M1 — User machine can return QR as qrDataUrl (API-level)
Acceptance:
- On a READY pool instance:
  - `POST /api/wa/start {uuid, force:true}` returns ok
  - `GET /api/wa/qr?uuid=...` returns `{ ok:true, qrDataUrl: "data:image/png;base64,..." }`
Evidence:
- curl output saved + relevant journal tail

Steps:
- [PENDING] Fix provision transcript path: write script transcript to `PROVISION_DATA_DIR` (not /tmp); expose `logExists/logSize` in `/api/wa/status`
- [PENDING] Ensure `LOGIN_AUTHORITY.control-plane` is not created in A-mode; keep provision running on pool instances
- [PENDING] Verify QR parsing from transcript increments `qrSeq` and returns `qrDataUrl`

### Milestone M2 — Web page shows QR reliably
Acceptance:
- p-site page no longer stuck at "正在等待 QR 碼..."
- QR renders within timeout window

Steps:
- [PENDING] Control-plane polling/push correctly fetches qrDataUrl and renders in UI
- [PENDING] Align expiry windows (QR_GENERATED expires_at vs UI polling) to avoid premature RECYCLE

### Milestone M3 — Scan results persist (bind success)
Acceptance:
- After scan, control-plane persists `deliveries.wa_jid` + `bound_at`
- UI transitions to success state only for the current linking session

Steps:
- [PENDING] Fix success condition: do not treat historical `wa_jid/bound_at` as current success; tie to linking session
- [PENDING] Add idempotency lock per uuid to prevent concurrent QR sessions

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
  - [~] Agent should NOT crash; should send a short guide asking user to provide OpenAI key.
    - 2026-02-27: hardened pool/postboot_verify.sh to avoid provider error spam + set local marker; still need UX-level guide delivery via provision flow.
  - [~] Do not send provider error messages.
    - 2026-02-27: pool/postboot_verify.sh best-effort dmPolicy allowlist + restart gateway; still need end-to-end validation.
- [x] Add postboot verify check: "auth store present + default provider OK".
  - checks: tmux_installed + auth_profiles_present + default_model_openai_gpt_5_2

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
- [~] Produce a single cloud-init payload or install script that:
  - started: pool/cloud_init_user_machine.sh (now includes systemd units + gateway start script)
  - [~] Installs dependencies (node/openclaw/tmux)
  - 2026-02-27: verified deps install works on fresh box.
  - [~] Places /opt/bothook/* assets
  - 2026-02-27: fixed installer to be self-contained via /tmp/bothook-assets (commit fafbf19); needs full E2E confirm.
  - [~] Installs systemd units
  - [~] Enables + starts services
  - [~] Runs postboot verify (or waits for systemd)
- [ ] Document rerun/rollback.

## Progress log
- 2026-02-26: started
- 2026-02-26: Phase0 done; began Phase1 baseline (model default fix on test box)
