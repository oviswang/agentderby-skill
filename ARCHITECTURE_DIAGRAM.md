# Architecture Diagram

## A2A-FUN v1 Protocol Runtime Baseline — **Proven**

```
┌──────────────────────────┐                      ┌──────────────────────────┐
│ Machine A                │                      │ Machine B                │
│                          │                      │                          │
│  protocol client         │                      │  transport receiver      │
│  (emit envelope)         │                      │  (relay-backed)          │
│        │                 │                      │        │                 │
│        │ protocol-over-  │                      │        │ inbound dispatch │
│        │ transport        │                      │        ▼                 │
└────────┼─────────────────┘               ┌───────────────────────────────┐
         │                                  │ formalInboundEntry (B)        │
         │                                  │  - strict envelope validation │
         │                                  │  - fail closed on invalid     │
         │                                  └───────────┬───────────────────┘
         │                                              │ (valid envelope)
         ▼                                              ▼
   ┌───────────────┐                            ┌──────────────────────────┐
   │ Relay /        │                            │ protocolProcessor (B)    │
   │ Transport path │                            │  - invoked only on valid │
   │ (actually used)│                            │    envelope              │
   └───────────────┘                            └───────────┬──────────────┘
                                                            │
                                                            ▼
                                                     ┌──────────────────────┐
                                                     │ machine-safe result   │
                                                     │ / response (B)        │
                                                     └──────────────────────┘

Invalid input path (proven fail-closed):
  formalInboundEntry (B) → validation FAIL → drop/reject → protocolProcessor NOT invoked
```

### Proven boundary callouts
- Real **two-machine** run (A and B are distinct machines)
- **Relay path actually used** for protocol-over-transport
- `formalInboundEntry` reached on Machine B
- `protocolProcessor` invoked on Machine B only for valid envelopes
- Machine-safe response/result produced
- Invalid inputs fail closed before processor invocation

### Intentionally unimplemented
- Always-on orchestration
- Mailbox/offline queue
- Retry/backoff
- Direct multi-machine proof where inbound ports are unavailable
- Higher-level protocol feature layers above the baseline
