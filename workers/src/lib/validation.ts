import { z } from '@pakdam/shared';
/**
 * Inbound WebSocket client-message validation — real Zod (zod@4.6.7,
 * re-exported from `@pakdam/shared`; `workers/package.json` also
 * depends on `zod` directly).
 *
 * This is the file the tooling brief calls `workers/src/lib/validation.ts`:
 * the old Zod shim never lived here — it lived in `packages/shared` and
 * was deleted 2026-11-17 once real Zod landed (see
 * `packages/shared/src/index.ts`). What was still missing was Zod
 * validation for INBOUND WS client messages: HTTP bodies are Zod-validated
 * in `workers/src/http.ts` (`createRoomBody` / `joinBody` / `ticketBody`,
 * all `.strict()`), stored game events are Zod-validated in
 * `packages/shared/src/events.ts` (`parseGameEvent`, called by
 * `logGameEvent` in `workers/src/room-do.ts`), but inbound WS commands
 * were checked by hand-rolled `typeof` guards inside
 * `handleWsClientMessage` / `applyGameCommand` (`workers/src/room-do.ts`).
 * These schemas mirror those guards EXACTLY — same field names, same
 * bounds, no new rules, no invented limits — so wiring them in changes
 * no accepted/rejected decision, only where the check lives.
 * Non-strict `z.object` (strip unknown keys) is DELIBERATE, not an
 * oversight: the DO's guards ignore unknown keys and the DO's store
 * drops them (SEC-07 pins this — a location.update carrying a 100 KB
 * `junk` field on the fix MUST be accepted, with the junk dropped on
 * store). A `strictObject` here would have rejected exactly that
 * message and broken SEC-07 (found by the final-verification wiring,
 * 2026-11-17). Strictness lives where it belongs: the HTTP bodies in
 * `workers/src/http.ts` are `.strict()` by design, and the stored
 * game-event schemas in `packages/shared/src/events.ts` stay strict.
 *
 * WIRING (not done here — `room-do.ts` is outside the tooling worker's
 * file scope): in `handleWsClientMessage`, after the `v: 1` / `type`
 * check and before the `switch`, call `validateWsClientMessage(raw)` and
 * return its `VALIDATION_FAILED` reply when it fails. The DO's domain
 * checks (seat, phase, role, idempotency, rate limits) stay where they
 * are — this file validates SHAPE only, exactly like `http.ts`.
 *
 * Wire shape (frozen, docs/API.md §3.3): every client message is
 * `{ v: 1, type, roomId?, playerId?, clientSeq?, clientTs?,
 * commandId?, payload }`. The web client (`apps/web/src/lib/websocket.ts`
 * `sendCommand`) always nests fields under `payload`; the DO reads
 * `payload['…']`. A top-level field (e.g. a bare `fix` next to `type`)
 * is NOT read by the DO and fails here.
 */

const nonEmptyString = (max: number) => z.string().trim().min(1).max(max);
const optionalReason = () =>
  // safety.pause / safety.sos: the client always sends the `reason` key
  // (a string ≤ 500, or null). The DO rejects a MISSING reason
  // (`undefined !== null` and not a string), so the key is required here.
  z.string().max(500).nullable();

const locationFixSchema = z.object({
  playerId: z.string().min(1),
  roomId: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyMeters: z.number().positive().finite(),
  capturedAt: z.string().datetime(),
  // `receivedAt` is server-stamped (the DO overwrites it); a client may
  // send it, but it is never trusted. `quality` is server-decided and,
  // per the DO's isValidFix, never 'unknown' (LocationFix.quality is
  // Exclude<LocationQuality, 'unknown'>).
  receivedAt: z.string().datetime().optional(),
  quality: z.enum(['good', 'fair', 'poor', 'stale', 'suspicious']).optional(),
});

const payloadSchemas = {
  'location.update': z.object({ fix: locationFixSchema }),
  'catch.request': z.object({ runnerId: z.string().min(1) }),
  'catch.confirm': z.object({
    catchId: z.string().min(1),
    // The client sends `qrToken: ''` (empty string) on a manual confirm
    // (websocket.ts sendCatchConfirm) — the DO treats an empty string
    // as "no token" and falls through to the manual path, so empty is
    // allowed here and rejected only when neither token nor manual is set.
    qrToken: z.string().optional(),
    manualConfirm: z.boolean().optional(),
    // The client may send either `manualConfirm: true` or
    // `resolution: 'manual-confirm'` (room-do.ts applyGameCommand).
    resolution: z.enum(['manual-confirm']).optional(),
  }),
  // The client sends `{ catchId, reason }` on dispute (websocket.ts
  // disputeCatch); the DO reads only catchId and ignores the reason.
  'catch.dispute': z.object({
    catchId: z.string().min(1),
    reason: z.string().max(500).optional(),
  }),
  'safety.pause': z.object({ reason: optionalReason() }),
  'safety.resume': z.object({}),
  'safety.sos': z.object({ reason: optionalReason() }),
  // The client sends `{ reason }` on leave (websocket.ts leave);
  // the DO ignores the payload entirely.
  'leave': z.object({ reason: z.string().nullable().optional() }),
  'signal.send': z.object({ code: nonEmptyString(32) }),
  // Team Radio text (D-M7): free text up to 140 chars (the TeamRadio
  // cap) or a closed-set quick message. The DO stamps the sender's
  // display name itself — a client-supplied name is never trusted —
  // and enforces team-only delivery + the huntersCanTalk host toggle.
  'radio.send': z.object({ text: nonEmptyString(140), kind: z.enum(['quick', 'text']).optional() }),
  // Voice radio (D-M1): signalling only — SDP/ICE for a WebRTC peer
  // connection to ONE teammate. Size-capped so a seat cannot flood
  // the DO with multi-megabyte SDP blobs (SEC-07 pattern); the DO
  // additionally checks kind-specific requirements (offer/answer
  // need sdp, ice needs candidate) and team membership.
  'voice.signal': z.object({
    toPlayerId: z.string().min(1).max(128),
    kind: z.enum(['join', 'leave', 'offer', 'answer', 'ice']),
    sdp: z.string().min(1).max(8192).optional(),
    candidate: z.object({
      candidate: z.string().min(1).max(1024),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().int().nullable().optional(),
    }).optional(),
  }),
  'pin.place': z.object({
    point: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }),
    label: nonEmptyString(80),
  }),
  'announcement.send': z.object({ text: nonEmptyString(280) }),
  // D-M6 "Tell everyone": the revealer's own fix, validated like a
  // location.update fix (same schema — the DO re-validates it with
  // server-side GPS rules before anything is broadcast).
  'reveal.send': z.object({ fix: locationFixSchema }),
  'ready.set': z.object({ isReady: z.boolean() }),
  'briefing.confirm': z.object({}),
  'player.suspended': z.object({
    reason: z.enum(['tab-hidden', 'screen-locked', 'network-lost', 'heartbeat-timeout', 'unknown']).optional(),
  }),
} as const;

export type WsMutatingType = keyof typeof payloadSchemas;
export const WS_MUTATING_TYPES = Object.keys(payloadSchemas) as WsMutatingType[];

/** Non-mutating client messages, validated by shape only (the DO's
 *  `validateHello` stays the authority on the hello protocol rules). */
const helloPayloadSchema = z.object({
  protocolVersion: z.literal(1),
  clientVersion: z.string().min(1),
  lastServerSeq: z.number().int().min(0),
});
const nonMutatingPayloadSchemas = {
  hello: helloPayloadSchema,
  // The client sends `{ lastServerSeq }` on both (websocket.ts
  // requestSnapshot / requestResync); the DO reads nothing from it.
  'snapshot.request': z.object({ lastServerSeq: z.number().int().min(0).optional() }),
  'resync.request': z.object({ lastServerSeq: z.number().int().min(0).optional() }),
  heartbeat: z.object({}),
  'auth.refresh': z.object({ ticket: z.string().min(1) }),
} as const;

const envelopeBase = z.object({
  v: z.literal(1),
  type: z.string().min(1),
  roomId: z.string().min(1).optional(),
  playerId: z.string().min(1).optional(),
  clientSeq: z.number().int().min(0).optional(),
  clientTs: z.number().int().optional(),
  commandId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  // The payload itself is validated per-type below; it may be absent
  // (the DO defaults a missing payload to {}).
  payload: z.unknown().optional(),
});

/** Validate one inbound WS client message (shape only). Returns the
 *  parsed message on success, or the first human-readable failure.
 *  Unknown `type` values and missing `commandId` on mutating commands
 *  are the DO's decision (unknown-type / idempotency errors) and are
 *  NOT rejected here — this function returns `{ ok: true, mutating:
 *  false }` for them so the existing handler keeps its behaviour. */
export function validateWsClientMessage(raw: unknown): (
  | { ok: true; type: string; mutating: boolean; payload: Record<string, unknown> }
  | { ok: false; message: string }
) {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'message must be an object' };
  }
  const envelope = envelopeBase.safeParse(raw);
  if (!envelope.success) {
    return { ok: false, message: 'message requires v: 1 and a type' };
  }
  const { type } = envelope.data;
  const payload = (raw as Record<string, unknown>)['payload'];
  if (type in payloadSchemas) {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, message: `${type} requires a payload object` };
    }
    const parsed = (payloadSchemas as Record<string, z.ZodType>)[type]!.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return { ok: false, message: `${type}: ${first ? `${first.path.join('.')}: ${first.message}` : 'invalid payload'}` };
    }
    return { ok: true, type, mutating: true, payload: parsed.data as Record<string, unknown> };
  }
  if (type in nonMutatingPayloadSchemas) {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, message: `${type} requires a payload object` };
    }
    const parsed = (nonMutatingPayloadSchemas as Record<string, z.ZodType>)[type]!.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return { ok: false, message: `${type}: ${first ? `${first.path.join('.')}: ${first.message}` : 'invalid payload'}` };
    }
    return { ok: true, type, mutating: false, payload: parsed.data as Record<string, unknown> };
  }
  // Unknown type: leave it to the DO (it replies VALIDATION_FAILED with
  // `unknown WS message type: …`). Shape-checking cannot judge it.
  return { ok: true, type, mutating: false, payload: {} };
}
