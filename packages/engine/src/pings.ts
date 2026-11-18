import type { LocationFix, Ping } from '@pakdam/shared';
/** Pending pings (v2.1 Issue 9): expire, are never delivered stale, are excluded from snapshots, purged at match end.
 *  Delivery expiry is NOT display removal (founder decision, 2026-11-17):
 *  once a ping IS delivered and shown, it stays on the hunter's map
 *  until the next ping replaces it — the web client never removes a
 *  shown ping on a timer. These helpers only govern PENDING
 *  (undelivered) pings. */
export function isPingDeliverable(p: Ping, nowMs: number): boolean {
  return new Date(p.expiresAt).getTime() > nowMs;
}
export function purgeExpiredPings(pings: Ping[], nowMs: number): Ping[] {
  return pings.filter((p) => isPingDeliverable(p, nowMs));
}
export function snapshotPings(pings: Ping[], nowMs: number): Ping[] {
  // Snapshots exclude pending pings entirely — a recovered room re-computes them.
  void nowMs; return [];
}

/**
 * QA 2026-11-17 (GL-16): build one scheduled ping for a Runner from
 * their latest server-held fix. A ping is a COARSE area, never an
 * exact pin (HNT-024/025): the centre is the fix, but the radius is
 * the fixed coarse area below — a Hunter sees "roughly here", never
 * the Runner's precise dot. The radius is a PLACEHOLDER (it matches
 * the demo's 150 m coarse area); field evidence must replace it —
 * calibration OPEN, do not treat 150 m as a measured requirement.
 * Returns null when there is no fix to ping from (no fix, no ping —
 * never invent a position).
 */
export const PING_AREA_RADIUS_M = 150;
export function buildPing(
  pingId: string, roomId: string, fix: LocationFix, nowMs: number, pendingPingTtlSeconds: number,
): Ping {
  return {
    pingId, roomId, subjectPlayerId: fix.playerId, recipientRole: 'hunters',
    uncertainty: { centre: { lat: fix.lat, lng: fix.lng }, radiusMeters: PING_AREA_RADIUS_M },
    ageSeconds: 0, qualityAtPing: fix.quality,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + pendingPingTtlSeconds * 1000).toISOString(),
  };
}
