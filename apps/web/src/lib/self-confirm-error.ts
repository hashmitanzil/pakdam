/**
 * Self-confirm error matching (Scope C follow-up A, R2-14 seam 2).
 *
 * The server's error envelopes now echo the failed command's
 * `requestId` (the `commandId` the client sent). When the envelope
 * carries one, match on it exactly: a `location.update`
 * STALE_LOCATION arriving within 15 s of an OK tap must NOT surface
 * as the confirm's failure. When the envelope carries no `requestId`
 * (old server, or an envelope the server never tied to a command),
 * fall back to the existing 15 s receipt-time window — that behaviour
 * is never broken.
 *
 * Pure function so the unit suite can pin the seam without a socket.
 */
export interface ConfirmErrorMatchInput {
  /** `requestId` on the error envelope, when the server sent one. */
  errorRequestId?: string | null;
  /** `commandId` sent with the pending self-confirm, when known. */
  pendingRequestId?: string | null;
  /** Receipt time of the error envelope (epoch ms). */
  errorAtMs: number;
  /** Send time of the pending self-confirm (epoch ms). */
  pendingAtMs: number;
}

/**
 * True when this error envelope answers the pending self-confirm.
 * A mismatched `requestId` never matches, however recent — the error
 * belongs to another command.
 */
export function confirmErrorMatches(input: ConfirmErrorMatchInput): boolean {
  const { errorRequestId, pendingRequestId, errorAtMs, pendingAtMs } = input;
  if (errorRequestId !== undefined && errorRequestId !== null && errorRequestId !== '') {
    // The server tied this error to a command: only that command's
    // error matches. A pending confirm with no recorded id cannot
    // claim an id-carrying error either — the fallback below is for
    // id-less envelopes only.
    if (pendingRequestId === undefined || pendingRequestId === null || pendingRequestId === '') {
      return false;
    }
    return errorRequestId === pendingRequestId;
  }
  // No id on the envelope: the old 15 s receipt-time window.
  return errorAtMs >= pendingAtMs && errorAtMs - pendingAtMs < 15_000;
}
