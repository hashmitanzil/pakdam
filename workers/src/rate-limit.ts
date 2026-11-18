/** Rate limits are OPEN (HNT-071) — numbers are placeholders to be measured. */
/** Rate-limit bucket names (17 §4). Numeric limits per bucket are OPEN. */
export const RATE_LIMIT_BUCKETS = [
  'room.join', 'room.create', 'ws.ticket', 'catch.request', 'catch.confirm',
  'report', 'sos', 'location.update', 'message.send',
] as const;
export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];
export const RATE_LIMITS_OPEN = { joinPerMinute: 5, catchPerMinute: 10, reportPerMinute: 5 };

/**
 * Per-bucket HTTP limits (SEC-12, 2026-11-17). All numbers are
 * PLACEHOLDERS — OPEN calibration (HNT-071), to be measured in the
 * field before the external pilot. They exist to stop trivial abuse
 * (room-spam, ticket farming, start-spam), not to throttle legitimate
 * play: a 30-player roster joining inside a minute is legitimate,
 * which is why join/create are keyed per CLIENT IP, while ticket and
 * start are keyed per SEAT (roomId + playerId).
 */
export const HTTP_RATE_LIMITS: Record<'room.create' | 'room.join' | 'ws.ticket' | 'ws.ticket.revoke' | 'room.start', { limit: number; windowMs: number }> = {
  'room.create': { limit: 5, windowMs: 60_000 },
  'room.join': { limit: 5, windowMs: 60_000 },
  'ws.ticket': { limit: 10, windowMs: 60_000 },
  'ws.ticket.revoke': { limit: 10, windowMs: 60_000 },
  'room.start': { limit: 5, windowMs: 60_000 },
};

/**
 * Env override for the per-IP placeholder limits (final verification,
 * 2026-11-17 — closes the k6 16-player blocker WITHOUT silently
 * raising the production limit). The production default stays
 * 5/min/IP (OPEN HNT-071, unmeasured placeholder): it changes only
 * when the deployment sets `PAKDAM_JOIN_PER_MINUTE` (or the
 * create/lookup equivalents) as a Worker var — e.g. `npx wrangler
 * dev --var PAKDAM_JOIN_PER_MINUTE:100` for a local load run, or a
 * `workers/.dev.vars` entry (gitignored, never committed). A
 * missing, non-integer or non-positive value falls back to the
 * documented default — a bad env value can never disable the limit
 * or set it to zero. Per-seat limits (ticket, start) are NOT
 * overridable here: a load run needs many joins from one IP, not
 * many tickets from one seat.
 */
export function parsePerMinuteLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  allow(key: string, limit: number, windowMs: number, nowMs: number): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => nowMs - t < windowMs);
    if (arr.length >= limit) return false;
    arr.push(nowMs); this.hits.set(key, arr); return true;
  }
  /** Seconds until the oldest hit in this key's window expires (0 when
   *  the key is currently under the limit). For Retry-After / error
   *  replies — never exposes the hit history itself. */
  retryAfterSeconds(key: string, windowMs: number, nowMs: number): number {
    const arr = (this.hits.get(key) ?? []).filter((t) => nowMs - t < windowMs);
    if (arr.length === 0) return 0;
    return Math.max(0, Math.ceil((Math.min(...arr) + windowMs - nowMs) / 1000));
  }
}
