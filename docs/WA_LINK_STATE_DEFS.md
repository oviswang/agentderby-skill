# BOTHook WhatsApp linking — state definitions (first-link vs relink)

Goal: Make the QR/linking flow scalable and consistent for **all users**, not just one test machine.

## Terms (stable definitions)

### first-link
A UUID is **first-link** if it has **never successfully bound** a WhatsApp identity before.

Operational definition (control-plane DB):
- `deliveries.wa_jid IS NULL` **and** `deliveries.bound_at IS NULL` for the current/most recent delivery record (or no delivery record exists).

### relink
A UUID is **relink** if it **has successfully bound** a WhatsApp identity at least once in the past, and now needs to restore/reconnect.

Operational definition (control-plane DB):
- `deliveries.wa_jid IS NOT NULL` **or** `deliveries.bound_at IS NOT NULL` (historical or current delivery record).

> Note: do **not** rely on `deliveries.status` alone for this decision.
> We have observed cases where status becomes `PAYMENT_TIMEOUT` (or similar) **after** a successful WhatsApp bind, i.e. `wa_jid` exists.
>
> Watchdog timeouts write additional details to `deliveries.meta_json`:
> - `timeout_stage`: `PRE_BIND` | `POST_BIND`
> - `timeout_stage_detail`: policy stage label (e.g. `HARD_UNPAID_20M`)
> - `reclaim_plan`: `release_only` | `reimage_and_init`

## Responsibilities (control-plane vs user machine)

### Control-plane (UI routing / orchestration)
When the user clicks “Get QR”, the control-plane should:
1) Decide **page branch**:
   - relink → show relink UX copy (restore/replace)
   - first-link → show first-time UX copy
2) Allocate a **READY** pool instance to run the linking workload.
3) Enforce **uuid-level idempotency/locking** so repeated clicks reuse the same allocation/session.

### User machine (truth source for whether a QR is needed)
The user machine should decide whether a QR must be displayed:
- If WhatsApp session is already logged-in/connected → no QR (return “already linked”).
- If not connected → generate and return QR.

Preferred interface: local provision API on the user machine (e.g. `:18999`) rather than scraping tmux.

## Why keep both terms?
- Different UX: relink should warn about replacing/restoring and avoid confusing returning users.
- Different safety semantics: relink typically requires stricter locking and session reuse.
- Prevents state drift bugs: last-minute confirmation should consult user machine state before timeout/recycle.
