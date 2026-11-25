/**
 * v34 (R2-6): device-clock skew vs the server clock.
 *
 * The server validates every GPS fix against the SERVER clock and
 * rejects a fix >60 s old on arrival (`STALE_LOCATION`). The client
 * validates against its own (possibly skewed) clock, so a phone
 * >60 s behind keeps "sending" fixes the server rejects one by
 * one — the seat never gets a dot, drifts toward the missing-fix
 * ejection, and every self-confirm fails, with no message naming
 * the clock. A retry cannot fix it; only fixing the clock can.
 *
 * Every server envelope carries the DO's `serverTs` (ISO-8601,
 * `WsServerEnvelope.serverTs`), so the client can compare its own
 * clock against the server's with no server change: warn when the
 * gap exceeds 30 s (half the 60 s rejection bound — early enough
 * to act, late enough not to cry wolf over normal jitter).
 */

/** Warn when the device clock is this far from the server clock. */
export const CLOCK_SKEW_WARN_MS = 30_000;

/**
 * Device clock minus server clock, when the gap is big enough to
 * break GPS freshness. Null when in sync, when the server
 * timestamp is missing, or when it does not parse. Positive =
 * device ahead of the server; negative = device behind.
 */
export function detectClockSkew(
  serverTsIso: string | undefined,
  nowMs: number,
): number | null {
  if (!serverTsIso) return null;
  const serverMs = Date.parse(serverTsIso);
  if (!Number.isFinite(serverMs)) return null;
  const skew = nowMs - serverMs;
  return Math.abs(skew) > CLOCK_SKEW_WARN_MS ? skew : null;
}

/** Plain-words banner line for a detected skew (device-minus-server ms). */
export function clockSkewNotice(skewMs: number): string {
  const mins = Math.max(1, Math.round(Math.abs(skewMs) / 60000));
  const direction = skewMs < 0 ? 'behind' : 'ahead';
  return `Your phone's clock is about ${mins} minute${mins === 1 ? '' : 's'} ${direction} — GPS and tagging may not work until it's right. Turn on automatic date & time in Settings.`;
}
