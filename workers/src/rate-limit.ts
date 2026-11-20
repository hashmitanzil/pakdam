/**
 * @pakdam/workers — HTTP rate limiting.
 *
 * Limits come from `HTTP_RATE_LIMITS` in @pakdam/shared (all OPEN
 * placeholders to validate in the field). Per-route keys: per-seat for
 * seat-scoped actions, per-IP for unauthenticated ones, per-room/code for
 * join + by-code (NAT-JOIN — see below).
 *
 * SCOPE WARNING (the per-isolate lesson): this limiter is in-memory PER
 * ISOLATE. That is acceptable for RATE limiting only — a limit is a
 * best-effort abuse control, and an evicted isolate simply resets its
 * windows. It is NEVER used for ticket validation, seat credentials, or any
 * correctness-critical state: those live in the room's DO (or the code
 * registry DO), which is the single owner. If a limit ever needs to survive
 * isolate eviction, move that route's state into the DO.
 *
 * EXCEPTION — WS tickets are DO-enforced: `POST /v1/rooms/:id/ws-ticket`
 * mints credentials, so its 10/min/seat window is ALSO enforced in the
 * room's DO (`RoomStore.registerTicket` → `checkTicketIssueRateLimit`),
 * which every ticket issue passes through on the single DO instance per
 * room. A burst spread across isolates can 429 at the Worker on one
 * isolate and still be stopped by the DO on the next. The Worker limiter
 * stays as the cheap first line. Other seat routes keep Worker-only
 * limits (accepted: they all require a valid seat credential, and the DO
 * already enforces per-message WS limits + idempotency; moving each
 * route's window into its DO op is a wider refactor).
 *
 * NAT-JOIN (fixed): a 30-player roster joining inside a minute from one NAT
 * IP is legitimate, so join + by-code are keyed by room/code at 35/min in
 * the shared table — never per-IP. The old per-IP 5/min join limit 429'd
 * the 6th player on venue WiFi. Seat routes with no playerId yet are keyed
 * per-IP *within* the room (`anon:<roomId>:<ip>` in index.ts), never to one
 * shared `roomId:anonymous` window.
 */
import { HTTP_RATE_LIMITS } from '@pakdam/shared';

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds the caller must wait before retrying (0 when allowed). */
  retryAfterSeconds: number;
}

/** Sliding-window check against an in-memory per-isolate window map. */
export function slidingWindowAllow(
  windows: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): RateLimitResult {
  const cutoff = nowMs - windowMs;
  const seen = (windows.get(key) ?? []).filter((t) => t > cutoff);
  if (seen.length >= limit) {
    const oldest = seen[0] ?? nowMs;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + windowMs - nowMs) / 1000),
    );
    windows.set(key, seen);
    return { allowed: false, retryAfterSeconds };
  }
  seen.push(nowMs);
  windows.set(key, seen);
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Per-route HTTP rate limiter (one instance per isolate, held by the Worker
 * entry module). `routeKey` must be a key of `HTTP_RATE_LIMITS`
 * (e.g. 'POST /v1/rooms/:id/config'). `key` is the per-IP or per-seat key
 * the route's table entry names.
 */
export class HttpRateLimiter {
  private readonly windows = new Map<string, number[]>();

  check(routeKey: string, key: string, nowMs: number = Date.now()): RateLimitResult {
    const entry = (HTTP_RATE_LIMITS as Readonly<Record<string, { limit: number; windowSeconds: number }>>)[
      routeKey
    ];
    // Unknown route: fail closed with a conservative default, never unlimited.
    const limit = entry?.limit ?? 10;
    const windowSeconds = entry?.windowSeconds ?? 60;
    return slidingWindowAllow(
      this.windows,
      `${routeKey}::${key}`,
      limit,
      windowSeconds * 1000,
      nowMs,
    );
  }
}

/** Best client-IP guess: CF-Connecting-IP first, then X-Forwarded-For. */
export function clientIp(req: Request): string {
  const cf = req.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const forwarded = req.headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
  return 'unknown';
}

/** Per-seat key for a seat-scoped route: room + seat, never the token value. */
export function seatKey(roomId: string, playerId: string | undefined | null): string {
  return `${roomId}:${playerId ?? 'anonymous'}`;
}
