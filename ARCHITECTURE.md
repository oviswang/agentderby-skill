# Architecture

## Baseline: A2A-FUN v1 Protocol Runtime Baseline — **Proven**

This document describes the **current proven runtime baseline** for the A2A-FUN v1 protocol when executed across **two real machines** using a relay/transport.

---

## Proven end-to-end boundary (what happened in the proof)
Validated in a **real two-machine** run:

1. **Machine A** emitted a protocol message over a **relay-backed transport**.
2. The **relay path was actually used** (not a local/in-process shortcut).
3. **Machine B** received the message and reached **`formalInboundEntry`**.
4. A **valid envelope** passed **strict validation** and then invoked **`protocolProcessor`**.
5. The runtime produced a **machine-safe response/result**.
6. **Invalid input failed closed** and was rejected **before** any `protocolProcessor` invocation.

---

## What is now proven (baseline components)

### 1) Transport baseline
- The protocol can be carried over the transport layer via a relay in a real two-machine environment.
- This establishes the **minimum viable transport/runtime plumbing** needed for multi-machine execution.

### 2) Formal inbound entry
- The receiving runtime on Machine B deterministically reaches **`formalInboundEntry`** for inbound traffic.

### 3) Strict envelope validation (fail-closed)
- Invalid inputs are rejected early.
- The system fails closed **before** any protocol processing logic is invoked.

### 4) Session handoff
- The inbound runtime context is handed off cleanly to the protocol layer such that processing can proceed.

### 5) `protocolProcessor` wiring
- For valid envelopes, `protocolProcessor` is invoked on Machine B.

### 6) Machine-safe response path
- The response/result produced is safe for automation (bounded, structured, and not side-effectful beyond what the baseline allows).

### 7) Real two-machine relay protocol-over-transport path
- This is not a simulated or single-host proof: the baseline is validated across **two machines** with the relay in the path.

---

## Intentionally unimplemented (explicit non-goals for this baseline)
The following are **not** claimed by the baseline and remain intentionally unimplemented:

- **Runtime-wide always-on orchestration** (no always-on supervisor coordinating multiple agents/machines)
- **Mailbox / offline queue** (no durable store-and-forward)
- **Retry / backoff** (no delivery guarantees, no automatic resend)
- **Direct multi-machine proof where inbound ports are unavailable** (NAT/firewall constrained environments are not yet proven)
- **Broader protocol feature layers above the baseline** (capabilities negotiation, richer verbs, auth layers, etc.)

---

## Implications
- This baseline is sufficient to build higher-level features on top of a **known-good** transport + validation + processor wiring core.
- Reliability and orchestration features must be added deliberately and proven separately.
