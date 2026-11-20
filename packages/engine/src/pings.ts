/**
 * Pakdam engine — pings.
 *
 * A ping is a coarse area, never an exact pin — with one honest caveat:
 * the area's centre IS the subject's exact latest fix (lat/lng), and the
 * 150 m radius is the coarseness. "Coarse area" means the recipient sees
 * a 150 m circle around the subject's true position, not a jittered or
 * sector-rounded position — the uncertainty is the radius, not the
 * centre. Mutual: a ping for a Runner goes to Hunters, and a ping for a
 * Hunter goes to Runners, so both sides learn the other's location when
 * it fires. No fix = no ping, never an invented position.
 * (Mechanic unchanged — mutual pings are intended; only the docstring
 * was dishonest about what the centre is.)
 *
 * Schedule: ACTIVE phase only, play zone ON, `pingIntervalSeconds > 0`;
 * one ping per free player per interval; the first ping lands one interval
 * after match start (`lastPingAtMs` defaults to `startedAt`).
 *
 * Display rule (founder decision): once a ping IS delivered and shown, it
 * stays on the recipient's map until the next ping replaces it — the client
 * never removes a shown ping on a timer. The pending-ping TTL governs
 * UNDELIVERED pings only.
 */
import {
  PENDING_PING_TTL_SECONDS,
  PING_AREA_RADIUS_M,
  type GeoPoint,
  type LocationFix,
  type LocationQuality,
  type Ping,
} from '@pakdam/shared';

export { PING_AREA_RADIUS_M, PENDING_PING_TTL_SECONDS };

/** Is this ping due yet? First ping lands one interval after match start. */
export function isPingDue(
  lastPingAtMs: number | null,
  startedAtMs: number,
  intervalSeconds: number,
  nowMs: number,
): boolean {
  if (intervalSeconds <= 0) return false;
  const last = lastPingAtMs ?? startedAtMs;
  return nowMs - last >= intervalSeconds * 1000;
}

/** Epoch ms of the next scheduled ping after `nowMs`. */
export function nextPingAtMs(
  lastPingAtMs: number | null,
  startedAtMs: number,
  intervalSeconds: number,
): number | null {
  if (intervalSeconds <= 0) return null;
  const last = lastPingAtMs ?? startedAtMs;
  return last + intervalSeconds * 1000;
}

/**
 * Build one ping for a free player (a Runner or a Hunter) from their latest
 * server-held fix. Returns null when there is no fix — never an invented
 * position. `pingId` is supplied by the caller (a fresh id per ping).
 * `recipientRole` is the opposing team: a Runner ping goes to 'hunters',
 * a Hunter ping goes to 'runners'.
 */
export function buildPing(input: {
  pingId: string;
  roomId: string;
  subjectPlayerId: string;
  recipientRole: 'hunters' | 'runners';
  fix: LocationFix | null;
  qualityAtPing: LocationQuality | null;
  nowMs: number;
}): Ping | null {
  if (input.fix === null) return null;
  const centre: GeoPoint = { lat: input.fix.lat, lng: input.fix.lng };
  const createdAt = new Date(input.nowMs).toISOString();
  return {
    pingId: input.pingId,
    roomId: input.roomId,
    subjectPlayerId: input.subjectPlayerId,
    recipientRole: input.recipientRole,
    uncertainty: { centre, radiusMeters: PING_AREA_RADIUS_M },
    ageSeconds: 0,
    qualityAtPing: input.qualityAtPing,
    createdAt,
    expiresAt: new Date(input.nowMs + PENDING_PING_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * Is an undelivered ping still deliverable? The pending-ping TTL (300 s)
 * governs UNDELIVERED pings only — a delivered ping is never removed on a
 * timer.
 */
export function isPingDeliverable(
  ping: Ping,
  nowMs: number,
  ttlSeconds: number = PENDING_PING_TTL_SECONDS,
): boolean {
  return nowMs - Date.parse(ping.createdAt) < ttlSeconds * 1000;
}

/** Drop undelivered pings past their TTL. Delivered pings are not in this list. */
export function purgeExpiredPings(
  pendingPings: readonly Ping[],
  nowMs: number,
  ttlSeconds: number = PENDING_PING_TTL_SECONDS,
): Ping[] {
  return pendingPings.filter((p) => isPingDeliverable(p, nowMs, ttlSeconds));
}

/**
 * Replace a delivered ping for one player with the fresh one. A delivered
 * ping stays until the next ping replaces it — it is never removed on a
 * timer, and a snapshot cycle never carries pending pings (a recovered room
 * re-computes them).
 */
export function replaceDeliveredPing(
  delivered: readonly Ping[],
  next: Ping,
): Ping[] {
  return [
    ...delivered.filter((p) => p.subjectPlayerId !== next.subjectPlayerId),
    next,
  ];
}

/** Age of a delivered ping in whole seconds, for the `m:ss ago` label. */
export function pingAgeSeconds(ping: Ping, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(ping.createdAt)) / 1000));
}

/** A delivered ping with its age filled in at render time. */
export function withAge(ping: Ping, nowMs: number): Ping {
  return { ...ping, ageSeconds: pingAgeSeconds(ping, nowMs) };
}

/** Shared due-check: free players with a fix whose interval has elapsed. */
function dueSubjectIds(input: {
  freePlayerIds: readonly string[];
  fixes: Readonly<Record<string, LocationFix | null>>;
  lastPingAtMs: Readonly<Record<string, number | null>>;
  startedAtMs: number;
  intervalSeconds: number;
  nowMs: number;
}): string[] {
  return input.freePlayerIds.filter((id) => {
    if (input.fixes[id] === undefined || input.fixes[id] === null) return false;
    const last = input.lastPingAtMs[id] ?? null;
    return isPingDue(last, input.startedAtMs, input.intervalSeconds, input.nowMs);
  });
}

/**
 * Which free Runners are due a ping right now? One ping per free Runner per
 * interval; Runners with no fix are skipped (no ping, never invented).
 */
export function dueRunnerIds(input: {
  freeRunnerIds: readonly string[];
  fixes: Readonly<Record<string, LocationFix | null>>;
  lastPingAtMs: Readonly<Record<string, number | null>>;
  startedAtMs: number;
  intervalSeconds: number;
  nowMs: number;
}): string[] {
  return dueSubjectIds({ ...input, freePlayerIds: input.freeRunnerIds });
}

/**
 * Which free Hunters are due a ping right now? Mirror of `dueRunnerIds`:
 * one ping per free Hunter per interval; Hunters with no fix are skipped
 * (no ping, never invented). A Hunter ping goes to Runners.
 */
export function dueHunterIds(input: {
  freeHunterIds: readonly string[];
  fixes: Readonly<Record<string, LocationFix | null>>;
  lastPingAtMs: Readonly<Record<string, number | null>>;
  startedAtMs: number;
  intervalSeconds: number;
  nowMs: number;
}): string[] {
  return dueSubjectIds({ ...input, freePlayerIds: input.freeHunterIds });
}
