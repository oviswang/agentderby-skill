# Project Status

## A2A-FUN v1 Protocol Runtime Baseline — **Proven**

**Status:** PROVEN (runtime baseline)

### Proof boundary (what was validated end-to-end)
The following behaviors are confirmed in a **real two-machine** setup (Machine A → relay/transport → Machine B):

- **Real two-machine relay protocol-over-transport validated**
- **Relay path actually used** (i.e., not a local shortcut)
- **`formalInboundEntry` reached on Machine B**
- **`protocolProcessor` invoked on Machine B for a valid envelope**
- **Machine-safe response/result produced** (safe for automation / no unsafe side-effects)
- **Invalid input failed closed before processor invocation** (strict rejection prior to `protocolProcessor`)

### What is now proven (baseline guarantees)
- Transport baseline (protocol-over-transport via relay)
- Formal inbound entry on the receiving machine
- Strict envelope validation (fail-closed)
- Session handoff (runtime context bridged to the processor layer)
- `protocolProcessor` wiring (valid envelope → processor invoked)
- Machine-safe response path (result returned in a safe, automation-friendly form)
- Real two-machine relay path works under realistic conditions

### Intentionally unimplemented (not part of the proven baseline)
These are explicitly **out of scope** for the current baseline and remain unimplemented by design:

- Runtime-wide always-on orchestration
- Mailbox / offline queue
- Retry / backoff
- Direct multi-machine proof where inbound ports are unavailable
- Broader protocol feature layers above the current baseline

### Notes
This file only describes the **proven runtime baseline** and its boundaries. It does not imply additional protocol layers, reliability mechanisms, or orchestration features.
