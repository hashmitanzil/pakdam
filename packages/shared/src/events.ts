/**
 * GAME EVENTS — the validated event architecture (founder-approved
 * final stack, 2026-11-17). Every gameplay fact is one of these 10
 * events, validated by a Zod schema before it is accepted anywhere:
 *
 *   PLAYER_JOINED, PLAYER_READY, MATCH_STARTED, LOCATION_UPDATED,
 *   LOCATION_PING_SENT, PLAYER_TAGGED, ZONE_UPDATED,
 *   PLAYER_DISCONNECTED, PLAYER_RECONNECTED, MATCH_COMPLETED
 *
 * Envelope (every event): `id` (UUID, unique per event),
 * `timestamp` (ISO date-time, when the event happened),
 * `roomId` (the room it belongs to), `actorId` (the player who
 * caused it), `type`, `payload`. `seq` is assigned by the Durable
 * Object on receipt (monotonic per room) and is NOT client-set.
 *
 * AUTHORISATION: the schema validates SHAPE only. Authority is the
 * Durable Object's job — it checks the actor's per-player secret
 * token and the room phase before applying an event (see
 * workers/src/room-do.ts). A well-formed event from the wrong player
 * or the wrong phase is rejected there, not here.
 *
 * DEDUPLICATION: event `id`s are unique; the DO keeps a set of seen
 * ids per room (in-memory + in the hibernation snapshot) and drops
 * repeats. `dedupeEvents` is the same rule for any consumer that
 * replays a log. Retried WebSocket messages and retried HTTP
 * commands must therefore reuse the same event `id` — a retry with
 * a fresh id is a NEW event, not a dedup hit.
 *
 * PRIVACY (HNT-068 vs HNT-120): raw coordinates appear ONLY in
 * LOCATION_UPDATED / LOCATION_PING_SENT payloads, which live in
 * active-room state and are purged at match end. Persistent logs and
 * recovery snapshots carry the event WITHOUT its coordinates (see
 * `redactForLog` / `redactForSnapshot`): the fact that a fix or a
 * ping happened, and its quality tier, survive — the position does
 * not.
 *
 * Zod note: this file imports real `zod` (packages/shared depends on
 * `zod@4.6.7`, installed in node_modules). The old `./zod-shim.js`
 * stopgap was deleted 2026-11-17 once real Zod was verified installed
 * and importable. All schemas are `.strict()` — unknown keys are
 * rejected, exactly as the shim behaved — so a misspelled field fails
 * loudly instead of being silently dropped.
 */
import { z, type ZodType } from 'zod';

const uuid = () => z.string().uuid();
const isoDateTime = () => z.string().datetime();
const playerId = () => z.string().min(1);
const roomId = () => z.string().min(1);

const locationFixSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyMeters: z.number().positive().finite(),
  at: isoDateTime(),
});

function envelope<LT extends string, P extends ZodType<unknown>>(type: LT, payload: P) {
  return z.strictObject({
    id: uuid(),
    timestamp: isoDateTime(),
    roomId: roomId(),
    actorId: playerId(),
    type: z.literal(type),
    seq: z.number().int().min(0).optional(),
    payload,
  });
}

export const PlayerJoinedEvent = envelope('PLAYER_JOINED', z.strictObject({
  displayName: z.string().min(1).max(30),
  kind: z.enum(['host-account', 'guest']),
}));
export const PlayerReadyEvent = envelope('PLAYER_READY', z.strictObject({
  playerId: playerId(),
}));
export const MatchStartedEvent = envelope('MATCH_STARTED', z.strictObject({
  mode: z.enum(['classic', 'infection']),
  hunterIds: z.array(playerId()),
  headStartSeconds: z.number().int().min(0).max(1800),
  durationSeconds: z.number().int().min(300).max(10800),
}));
export const LocationUpdatedEvent = envelope('LOCATION_UPDATED', z.strictObject({
  fix: locationFixSchema,
  quality: z.enum(['good', 'fair', 'poor', 'stale', 'suspicious', 'unknown']),
}));
export const LocationPingSentEvent = envelope('LOCATION_PING_SENT', z.strictObject({
  pingId: uuid(),
  runnerId: playerId(),
  /** Coarse area label only ("~120 m north") — never coordinates. */
  areaLabel: z.string().min(1),
  distanceMeters: z.number().min(0),
  bearingDegrees: z.number().min(0).max(360),
}));
export const PlayerTaggedEvent = envelope('PLAYER_TAGGED', z.strictObject({
  runnerId: playerId(),
  hunterId: playerId(),
  catchId: uuid(),
  // 'qr' = Hunter scan completed the claim; 'manual' = Runner confirmed
  // themself (camera unavailable); 'no-confirmation' = the host turned
  // Runner confirmation OFF, so the tag counted at once (QA BE-07,
  // 2026-11-17: the DO auto-confirm path logged 'no-confirmation' here
  // and the strict schema threw ZodError, so every catch in a
  // no-confirmation room crashed the WS handler with no reply).
  method: z.enum(['qr', 'manual', 'no-confirmation']),
}));
export const ZoneUpdatedEvent = envelope('ZONE_UPDATED', z.strictObject({
  boundary: z.array(z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })),
  reason: z.enum(['shrink', 'host-edit', 'next-zone']),
  shrinkStep: z.number().int().min(0).optional(),
}));
export const PlayerDisconnectedEvent = envelope('PLAYER_DISCONNECTED', z.strictObject({
  playerId: playerId(),
  reason: z.enum(['tab-closed', 'network', 'timeout', 'ejected', 'left']),
}));
export const PlayerReconnectedEvent = envelope('PLAYER_RECONNECTED', z.strictObject({
  playerId: playerId(),
}));
export const MatchCompletedEvent = envelope('MATCH_COMPLETED', z.strictObject({
  result: z.enum(['hunters-win', 'runners-win', 'aborted']),
  caughtCount: z.number().int().min(0),
  durationSeconds: z.number().int().min(0),
}));

export const GameEventSchema = z.union([
  PlayerJoinedEvent,
  PlayerReadyEvent,
  MatchStartedEvent,
  LocationUpdatedEvent,
  LocationPingSentEvent,
  PlayerTaggedEvent,
  ZoneUpdatedEvent,
  PlayerDisconnectedEvent,
  PlayerReconnectedEvent,
  MatchCompletedEvent,
]);

export type GameEvent = z.infer<typeof GameEventSchema>;
export type GameEventType = GameEvent['type'];

export const GAME_EVENT_TYPES: GameEventType[] = [
  'PLAYER_JOINED', 'PLAYER_READY', 'MATCH_STARTED', 'LOCATION_UPDATED',
  'LOCATION_PING_SENT', 'PLAYER_TAGGED', 'ZONE_UPDATED',
  'PLAYER_DISCONNECTED', 'PLAYER_RECONNECTED', 'MATCH_COMPLETED',
];

/** Parse any unknown value as a game event (throws ZodError). */
export function parseGameEvent(input: unknown): GameEvent {
  return GameEventSchema.parse(input);
}

/** Safe-parse variant (returns { success, data | error }). */
export function safeParseGameEvent(input: unknown) {
  return GameEventSchema.safeParse(input);
}

/** Build a new event envelope for a payload. `id` is a fresh UUID,
 *  `timestamp` is now; `seq` is left for the Durable Object. */
export function createGameEvent<T extends GameEventType>(
  type: T,
  roomIdValue: string,
  actorIdValue: string,
  payload: Extract<GameEvent, { type: T }>['payload'],
): Extract<GameEvent, { type: T }> {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    roomId: roomIdValue,
    actorId: actorIdValue,
    type,
    payload,
  } as Extract<GameEvent, { type: T }>;
}

/** Deduplicate an event log by `id`, keeping first-seen order. A
 *  retry that reuses its event id is dropped; a retry with a fresh
 *  id is (correctly) a new event. */
export function dedupeEvents(events: GameEvent[]): GameEvent[] {
  const seen = new Set<string>();
  const out: GameEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** Drop events whose ids are already seen (mutates the seen set). */
export function filterNewEvents(events: GameEvent[], seen: Set<string>): GameEvent[] {
  const out: GameEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** Strip raw coordinates for persistent logs (HNT-068): the event
 *  survives, the position does not. The quality tier and the fact
 *  survive — enough to audit "a fix arrived" without storing where. */
export function redactForLog(event: GameEvent): Record<string, unknown> {
  const { payload, ...rest } = event as unknown as { payload: Record<string, unknown> } & Record<string, unknown>;
  if (event.type === 'LOCATION_UPDATED') {
    const fix = payload.fix as { accuracyMeters: number; at: string } | undefined;
    return { ...rest, payload: { quality: payload.quality, accuracyMeters: fix?.accuracyMeters ?? null, at: fix?.at ?? null } };
  }
  if (event.type === 'LOCATION_PING_SENT') {
    return { ...rest, payload: { pingId: payload.pingId, runnerId: payload.runnerId, areaLabel: payload.areaLabel } };
  }
  if (event.type === 'ZONE_UPDATED') {
    const boundary = payload.boundary as unknown[];
    return { ...rest, payload: { reason: payload.reason, shrinkStep: payload.shrinkStep, pointCount: boundary.length } };
  }
  return { ...rest, payload };
}

/** Recovery snapshots carry the same redaction as logs, plus no
 *  `seq` (the DO reassigns it on recovery). */
export function redactForSnapshot(event: GameEvent): Record<string, unknown> {
  const redacted = redactForLog(event);
  delete redacted.seq;
  return redacted;
}
