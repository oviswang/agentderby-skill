/**
 * state-machine.mjs (placeholder skeleton)
 *
 * Purpose:
 * - Provide ticket processing states:
 *   NEEDS_INFO -> VERIFIED -> IN_PROGRESS -> DONE / FAILED
 */

export const TicketState = Object.freeze({
  NEEDS_INFO: 'NEEDS_INFO',
  VERIFIED: 'VERIFIED',
  IN_PROGRESS: 'IN_PROGRESS',
  DONE: 'DONE',
  FAILED: 'FAILED',
});

export function nextState(current, event) {
  // Minimal deterministic placeholder.
  const c = String(current || 'NEEDS_INFO');
  const e = String(event || '');
  if (c === TicketState.NEEDS_INFO && e === 'INFO_COMPLETE') return TicketState.VERIFIED;
  if (c === TicketState.VERIFIED && e === 'START') return TicketState.IN_PROGRESS;
  if (c === TicketState.IN_PROGRESS && e === 'OK') return TicketState.DONE;
  if (e === 'FAIL') return TicketState.FAILED;
  return c;
}
