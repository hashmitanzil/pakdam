import { WsTicketStore } from './auth.js';
import { RateLimiter, HTTP_RATE_LIMITS } from './rate-limit.js';
import { z } from '@pakdam/shared';
/**
 * Pure HTTP helpers for the Worker entry (skeleton — NOT deployed).
 * Kept in this module — not in index.ts — so the unit tests can import
 * them under plain Node: index.ts re-exports the Durable Object class,
 * and that class imports 'cloudflare:workers', which plain Node cannot
 * load (ERR_UNSUPPORTED_ESM_URL_SCHEME). Routes:
 *  POST /v1/rooms                 create room (host)
 *  POST /v1/rooms/:id/join        join via code (guest)
 *  GET  /v1/rooms/by-code/:code   code → roomId lookup (Worker F,
 *    2026-11-17 — 200 { ok, roomId, roomCode }, 404 unknown code)
 *  POST /v1/rooms/:id/ws-ticket   single-use WS ticket over HTTPS (17 §2.5)
 *  POST /v1/rooms/:id/ws-ticket/revoke  revoke WS tickets (17 §2.6)
 *  GET  /v1/rooms/:id             recipient-specific lobby state (HNT-038)
 *  WS   /v1/rooms/:id/ws?ticket=<ticket>  realtime (17 §3)
 *  POST /v1/rooms/:id/lifecycle  start/pause/resume/end (Worker 5 — REST,
 *    see below; pause is any player, the rest are host-only via host token)
 *  POST /v1/rooms/:id/host/token issue/rotate the host token (Worker 5)
 *  POST /v1/rooms/:id/host/transfer  explicit host transfer (Worker 5)
 *  POST /v1/rooms/:id/catches/:cid/resolve  host resolves a disputed catch (Worker 5)
 *  GET  /v1/rooms/:id/results    match result, participant-only (Worker 5)
 *  POST /v1/reports              report/block — audit record only (Worker 5)
 *  POST /v1/support/bugs         bug report, no location (Worker 5)
 *  POST /v1/support/grievances   Rule 20 grievance (Worker 5)
 * WS auth: the ticket travels ONLY in the handshake query string and is
 * consumed on upgrade. `hello` carries NO credential. The only WS message
 * that carries a ticket is `auth.refresh` (renewal).
 * Game authority stays in the Durable Object. This Worker never trusts
 * client-provided roles, timestamps or scores.
 *
 * REST-vs-WS (Worker 5, 2026-11-17 — the missing REST routes in
 * docs/API.md, one decision per route):
 *  - /lifecycle → REST (new). start/pause/resume/end had no REST
 *    surface; pause/resume also exist as WS messages and stay
 *    server-authoritative either way (the DO lifecycle op reuses the
 *    WS handler for pause/resume).
 *  - /catches, /catches/:cid/confirm, /catches/:cid/dispute → WS ONLY.
 *    catch.request / catch.confirm / catch.dispute already exist in
 *    the §3.3 catalogue, are server-authoritative, idempotent
 *    (commandId) and tested — a parallel REST surface would double
 *    the validation surface for no gain. No REST route is registered
 *    for them; they 404 over HTTP by design.
 *  - /safety/sos → WS ONLY (safety.sos message, same reason).
 *  - /leave → WS ONLY ('leave' message, same reason; it also drives
 *    the automatic host transfer, which no REST call can claim).
 *  - /reports, /support/bugs, /support/grievances → REST (new).
 *    They need no DO authority — they are Supabase intake only.
 *  - /results → REST (new). Reads room.result from the DO via the
 *    existing get-state op; 404 until the match has a result.
 *
 * Ticket store limit (Worker 5): WsTicketStore is Worker-in-memory
 * PER ISOLATE — a module-level singleton (see auth.ts). Tickets do
 * not survive an isolate eviction and are not shared across
 * isolates: after a cold start or a scale-out, every seat must fetch
 * a fresh ticket (close 4401 → fresh ticket → reconnect once, 17
 * §3.4). That is the documented behaviour, not a bug to work around
 * by persisting ticket values anywhere (ticket VALUES are never
 * stored — only their hashes, in memory).
 */
const limiter = new RateLimiter();
export const ticketStore = new WsTicketStore();
export function createTicketStore(): WsTicketStore {
  return new WsTicketStore();
}
export function route(path: string): string {
  if (path === '/v1/rooms') return 'create-room';
  if (path.endsWith('/ws-ticket/revoke')) return 'ws-ticket-revoke';
  if (path.endsWith('/ws-ticket')) return 'ws-ticket';
  if (path.endsWith('/ticket')) return 'ws-ticket'; // legacy alias — canonical path is /ws-ticket
  if (path.endsWith('/ws')) return 'websocket';
  if (path.endsWith('/join')) return 'join';
  if (path.endsWith('/start')) return 'start'; // QA BE-11: host starts the match (was unreachable)
  if (path.endsWith('/config')) return 'config'; // WIRING 2026-11-17: host changes lobby settings (was demo-only)
  if (path.endsWith('/remove-player')) return 'remove-player'; // WIRING 2026-11-17: host removes a lobby player (was demo-only)
  if (path.endsWith('/regenerate-code')) return 'regenerate-code'; // D-M2: host regenerates the room code from the lobby
  if (path.endsWith('/catch-token')) return 'catch-token'; // WIRING 2026-11-17: Runner fetches the raw QR token for an open catch (DO op existed, no Worker route)
  if (path.endsWith('/lifecycle')) return 'lifecycle'; // Worker 5: start/pause/resume/end over REST
  if (path.endsWith('/host/transfer')) return 'host-transfer'; // Worker 5: explicit host transfer
  if (path.endsWith('/host/token')) return 'host-token'; // Worker 5: issue/rotate the host token
  if (/\/catches\/[^/]+\/resolve$/.test(path)) return 'catch-resolve'; // Worker 5: host resolves a disputed catch
  if (path.endsWith('/results')) return 'results'; // Worker 5: match result (participant-only)
  if (path === '/v1/reports') return 'reports'; // Worker 5: report/block intake (audit only)
  if (path === '/v1/support/bugs') return 'bugs'; // Worker 5: bug reports (HNT-117)
  if (path === '/v1/support/grievances') return 'grievances'; // Worker 5: Rule 20 grievances
  if (/^\/v1\/rooms\/by-code\/[^/]+$/.test(path)) return 'by-code'; // Worker F: code → roomId lookup (must precede get-state)
  if (/^\/v1\/rooms\/[^/]+$/.test(path)) return 'get-state';
  return 'not-found';
}
/** Issue a ticket for a seat. TTL is OPEN calibration (17 §7) — the
 *  60_000 ms here is a placeholder the API mission must replace with a
 *  measured value; it is not a fixed requirement. */
export function newTicket(roomId: string, playerId: string): string {
  return ticketStore.issue(roomId, playerId, 'connect', 60_000, Date.now()).ticket;
}
/** Per-IP join limit — default 5/min (OPEN HNT-071). `limit`
 *  overrides the default ONLY when the caller passes an explicit
 *  env-resolved value (see `parsePerMinuteLimit`); the default is
 *  never raised silently. */
export function joinAllowed(key: string, nowMs: number, limit: number = HTTP_RATE_LIMITS['room.join'].limit): boolean {
  return limiter.allow(`join:${key}`, limit, HTTP_RATE_LIMITS['room.join'].windowMs, nowMs); // placeholder limit — OPEN (HNT-071)
}
/** Per-IP room-create limit (SEC-12): stops room spam from one client. */
export function createAllowed(key: string, nowMs: number, limit: number = HTTP_RATE_LIMITS['room.create'].limit): boolean {
  return limiter.allow(`create:${key}`, limit, HTTP_RATE_LIMITS['room.create'].windowMs, nowMs);
}
/** Per-IP code-lookup limit (Worker F, SEC-12): the lookup is an
 *  unauthenticated oracle over the code space, so it gets the same
 *  5/min per-IP placeholder as joins (OPEN HNT-071). A 30-player
 *  roster behind one NAT IP can hit this together with the join
 *  cap — the same trade-off as joins, to be measured. */
export function lookupAllowed(key: string, nowMs: number, limit = 5): boolean {
  return limiter.allow(`lookup:${key}`, limit, 60_000, nowMs);
}
/** Per-seat WS-ticket limit (SEC-12): stops ticket farming for a seat. */
export function ticketAllowed(roomId: string, playerId: string, nowMs: number): boolean {
  return limiter.allow(`ticket:${roomId}:${playerId}`, HTTP_RATE_LIMITS['ws.ticket'].limit, HTTP_RATE_LIMITS['ws.ticket'].windowMs, nowMs);
}
/** Per-seat ticket-revoke limit (SEC-12). */
export function ticketRevokeAllowed(roomId: string, playerId: string, nowMs: number): boolean {
  return limiter.allow(`ticket-revoke:${roomId}:${playerId}`, HTTP_RATE_LIMITS['ws.ticket.revoke'].limit, HTTP_RATE_LIMITS['ws.ticket.revoke'].windowMs, nowMs);
}
/** Per-seat start limit (SEC-12): stops start-spam hammering the DO. */
export function startAllowed(roomId: string, playerId: string, nowMs: number): boolean {
  return limiter.allow(`start:${roomId}:${playerId}`, HTTP_RATE_LIMITS['room.start'].limit, HTTP_RATE_LIMITS['room.start'].windowMs, nowMs);
}
/** Support-intake rate limit (Worker 5): reports/bugs/grievances are
 *  unauthenticated-ish intake, so they are limited per CLIENT IP
 *  (5/min — same placeholder as joins, OPEN HNT-071). */
export function reportAllowed(key: string, nowMs: number): boolean {
  return limiter.allow(`report:${key}`, 5, 60_000, nowMs);
}

/** Validate a WS upgrade (17 §3.1, §3.4). Consumes the ticket on success.
 *  On failure nothing is consumed and the caller must close the upgrade
 *  with the returned code. The ticket VALUE is never logged — callers log
 *  only `ticketId` (see WsTicketStore.logRef). */
export function handleWsUpgrade(
  store: WsTicketStore, presentedTicket: string | null,
  roomId: string, playerId: string, nowMs: number,
): { ok: true; ticketId: string } | { ok: false; code: 'TICKET_INVALID' | 'TICKET_REUSED' | 'TICKET_EXPIRED'; closeCode: 4401; message: string } {
  if (!presentedTicket) {
    return { ok: false, code: 'TICKET_INVALID', closeCode: 4401, message: 'WS ticket is required in the handshake query string' };
  }
  const result = store.redeem(presentedTicket, roomId, playerId, nowMs);
  if (!result.ok) {
    const message = result.code === 'TICKET_REUSED'
      ? 'WS ticket already redeemed — request a fresh ticket'
      : result.code === 'TICKET_EXPIRED'
        ? 'WS ticket expired — request a fresh ticket'
        : 'WS ticket is not valid for this room and seat';
    return { ok: false, code: result.code, closeCode: 4401, message };
  }
  // SEC-11: a 'renew' ticket is for `auth.refresh` on an EXISTING
  // socket only — it must never open a new socket. The peek in the
  // caller already rejects renew tickets before redeem, so reaching
  // here with one is a defence-in-depth check (the ticket is already
  // consumed by the redeem above, so it cannot be reused either way).
  if (result.purpose !== 'connect') {
    return { ok: false, code: 'TICKET_INVALID', closeCode: 4401, message: 'WS ticket is not valid for this room and seat' };
  }
  return { ok: true, ticketId: result.ticketId };
}

// ---------------------------------------------------------------------------
// HTTP request-body schemas (real Zod 4.6.7 — founder-approved final stack,
// 2026-11-17). These validate SHAPE only (types, ranges, unknown-key
// rejection — every schema is STRICT, via `.strict()`, preserving the
// behaviour of the old zod-shim, which rejected unknown keys; plain
// Zod `.object()` would silently strip them instead). Domain rules live
// in `validateRoomConfig` / `isValidDisplayName` (shared) and in the DO,
// which re-validates everything — the Worker never trusts the client.
// `z` is real Zod, re-exported from '@pakdam/shared'.
// ---------------------------------------------------------------------------

const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
}).strict();
/** A polygon is an array of points. The shim's array has no `.min()`,
 *  so the ">= 3 points" rule is NOT enforced here — it is enforced by
 *  `validateRoomConfig` (zone boundary) and by the engine at use. */
const geoPolygonSchema = z.array(geoPointSchema);
const zoneConfigSchema = z.object({
  boundary: geoPolygonSchema,
  shrinkPhases: z.array(z.object({
    atSeconds: z.number().int().min(0),
    boundary: geoPolygonSchema,
  }).strict()),
}).strict();

/** Full RoomConfig shape (shared types.ts). Ranges mirror
 *  HOST_RANGES / validation.ts; the DO's `validateRoomConfig` is
 *  still the authority on the domain rules (e.g. hostOnSiteConfirmed
 *  must be true, zone diameter limits, selectedHunterIds bounds). */
export const roomConfigSchema = z.object({
  mode: z.enum(['classic', 'infection']),
  teamAssignment: z.enum(['random', 'selected']),
  maxPlayers: z.number().int().min(3).max(30),
  hunterCount: z.number().int().min(1),
  durationSeconds: z.number().int().min(300).max(10800),
  headStartSeconds: z.number().int().min(0).max(1800),
  pingIntervalSeconds: z.number().int().min(0).max(1800),
  zoneShrinkEnabled: z.boolean(),
  zoneShrinkIntervalSeconds: z.number().int().min(0),
  catchConfirmationRequired: z.boolean(),
  balanceHunters: z.boolean().optional(),
  randomDraw: z.boolean().optional(),
  playZoneEnabled: z.boolean().optional(),
  huntersCanTalk: z.boolean().optional(),
  finalSizePercent: z.number().nullable().optional(),
  showPingHistory: z.boolean().optional(),
  zone: zoneConfigSchema,
  zoneShape: z.enum(['circle', 'draw']).optional(), // FIX 2026-11-18: the web app always sends zoneShape (draftToConfig); strict() rejected every lobby create without it ("Unrecognized key: zoneShape"). Optional so older clients still pass.
  safeAreas: z.array(geoPolygonSchema),
  noGoAreas: z.array(geoPolygonSchema),
  selectedHunterIds: z.array(z.string()),
  hostOnSiteConfirmed: z.boolean(),
}).strict();

/** GET /v1/rooms/by-code/:code — the :code path segment (Worker F).
 *  The regex is the same as shared `isValidRoomCode` (6 chars
 *  A-Z0-9): the server's canonical code shape, used by the DO
 *  `create` op too. It is deliberately WIDER than the 32-char
 *  generation alphabet (no 0/O/1/I) — a code the server accepted at
 *  creation must always stay lookable-up, and generation never
 *  emits the excluded four. Lowercase is malformed (400), not
 *  unknown (404): the web client uppercases before calling. */
export const roomCodeSchema = z.string().regex(/^[A-Z0-9]{6}$/, 'room code must be 6 characters A-Z0-9');

/** POST /v1/rooms — the host creates a room. `kind` is the host's
 *  account kind ('guest' for the guest-only pilot, 'host-account'
 *  when accounts exist); the server always makes this seat the host
 *  — a caller cannot claim host powers for another seat. */
export const createRoomBody = z.object({
  displayName: z.string().min(1).max(30),
  kind: z.enum(['guest', 'host-account'] as const),
  config: roomConfigSchema,
  ageGatePassed: z.boolean(),
}).strict();

/** POST /v1/rooms/:id/join — a guest joins with the room CODE (the
 *  invite proof; the Worker verifies it against the DO before
 *  forwarding the join). The roomId in the path is the UUID from the
 *  host's invite link. `reconnectToken` is OPTIONAL for a brand-new
 *  join and REQUIRED to restore an existing seat by display name
 *  (SEC-06 fix, Worker 5): a restore with a missing or wrong token
 *  is 403 and restores nothing. */
export const joinBody = z.object({
  displayName: z.string().min(1).max(30),
  kind: z.enum(['guest', 'host-account'] as const),
  roomCode: z.string().min(6).max(6),
  reconnectToken: z.string().min(1).optional(),
}).strict();

/** POST /v1/rooms/:id/ws-ticket and .../ws-ticket/revoke — prove the
 *  seat with the raw reconnect token received at join/create (the DO
 *  verifies it against the stored hash; the token is never logged).
 *  The ticket itself is issued by the Worker, never by the client.
 *  SEC-11: `purpose` is 'connect' (default — opens a new socket) or
 *  'renew' (a fresh ticket for `auth.refresh` on an EXISTING socket;
 *  a renew ticket can never open a socket). */
export const ticketBody = z.object({
  playerId: z.string().min(1),
  reconnectToken: z.string().min(1),
  purpose: z.enum(['connect', 'renew'] as const).optional(),
}).strict();

/** POST /v1/rooms/:id/config — host-only lobby settings change
 *  (WIRING 2026-11-17). `config` is the full new RoomConfig; the DO
 *  re-validates it with validateRoomConfig and enforces host-only +
 *  LOBBY-only. Host authority is proven with the HOST token (Worker
 *  5, SEC-06) — the per-seat host token issued at room creation —
 *  not with the reconnect token: the reconnect token proves a seat,
 *  the host token proves host authority. */
export const updateConfigBody = z.object({
  playerId: z.string().min(1),
  hostToken: z.string().min(1),
  config: roomConfigSchema,
}).strict();

/** POST /v1/rooms/:id/remove-player — host-only lobby removal
 *  (WIRING 2026-11-17). The DO enforces host-only, LOBBY-only, and
 *  never removes the host seat. Auth is the HOST token (Worker 5,
 *  SEC-06), same as config/start. */
export const removePlayerBody = z.object({
  playerId: z.string().min(1),
  hostToken: z.string().min(1),
  targetPlayerId: z.string().min(1),
}).strict();

/** POST /v1/rooms/:id/regenerate-code — host-only room-code change
 *  (D-M2). No code in the body: the Worker generates the fresh code
 *  (same alphabet as create), checks it is free in the index, and
 *  registers it before the DO swaps it in. Auth is the HOST token
 *  (Worker 5, SEC-06), same as config/remove-player/start. */
export const regenerateCodeBody = z.object({
  playerId: z.string().min(1),
  hostToken: z.string().min(1),
}).strict();

/** Host-only actions (Worker 5, SEC-06) prove host authority with
 *  the host token: `{ playerId, hostToken }`. The Worker verifies it
 *  against the DO (`verify-host-token` op) before forwarding; the DO
 *  re-checks actorId === room.hostPlayerId. A missing field is 400
 *  (strict schema); a wrong token, or a non-host seat, is 403. */
export const hostTokenBody = z.object({
  playerId: z.string().min(1),
  hostToken: z.string().min(1),
}).strict();

/** POST /v1/rooms/:id/lifecycle — start / pause / resume / end
 *  (Worker 5). start, resume and end are host-only and require
 *  `hostToken`; pause is any player (safety is not host-gated) and
 *  requires `reconnectToken`. Exactly the credential the action
 *  needs must be present; the other may be omitted. */
export const lifecycleBody = z.object({
  action: z.enum(['start', 'pause', 'resume', 'end']),
  playerId: z.string().min(1),
  hostToken: z.string().min(1).optional(),
  reconnectToken: z.string().min(1).optional(),
}).strict();

/** POST /v1/rooms/:id/host/transfer — explicit host transfer
 *  (Worker 5). The current host names the successor seat; the old
 *  host's token entry is deleted and the successor holds NO host
 *  token until they call POST .../host/token with their reconnect
 *  token. Auth is the CURRENT host's host token. */
export const transferBody = z.object({
  playerId: z.string().min(1),
  hostToken: z.string().min(1),
  newHostPlayerId: z.string().min(1),
}).strict();

/** POST /v1/rooms/:id/catches/:cid/resolve — host resolves a
 *  DISPUTED catch (Worker 5, "host resolves disputes"). `decision`
 *  'confirmed' counts the tag (mode + win rules apply);
 *  'rejected' voids the claim. `reason` is recorded nowhere on the
 *  wire beyond the DO audit log; it is accepted for the client's
 *  own record (max 500 chars). Auth is the host token. */
export const resolveBody = z.object({
  playerId: z.string().min(1),
  hostToken: z.string().min(1),
  decision: z.enum(['confirmed', 'rejected']),
  reason: z.string().max(500).optional(),
}).strict();

/** POST /v1/support/bugs (HNT-117, Worker 5). No location is ever
 *  attached to a bug report. roomId/playerId are optional context;
 *  deviceInfo + appVersion + description are required. */
export const bugReportBody = z.object({
  roomId: z.string().min(1).nullable().optional(),
  playerId: z.string().min(1).nullable().optional(),
  deviceInfo: z.string().min(1).max(500),
  appVersion: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
}).strict();

/** POST /v1/support/grievances (Rule 20, Worker 5 — distinct from
 *  bugs). No auth: anyone may file; the complainant reference is a
 *  free-text handle the filer supplies (never an email/password). */
export const grievanceBody = z.object({
  complainantRef: z.string().min(1).max(200),
  channel: z.enum(['in-app', 'email']),
  summary: z.string().min(1).max(2000),
}).strict();

/** POST /v1/reports (HNT-064, Worker 5). The reporter must be a
 *  participant: playerId + reconnectToken are verified against the
 *  DO before the audit record is written. A 'block' is recorded
 *  only — it does NOT itself remove or silence anyone (no block
 *  list exists in the DO yet; enforcement is a follow-up). */
export const reportBody = z.object({
  roomId: z.string().min(1),
  playerId: z.string().min(1),
  reconnectToken: z.string().min(1),
  targetPlayerId: z.string().min(1).nullable().optional(),
  kind: z.enum(['report', 'block']),
  reason: z.string().min(1).max(500),
}).strict();

/** POST /v1/rooms/:id/catch-token — the RUNNER's seat fetches the raw
 *  one-time catch token for an open catch, to show as a QR (WIRING
 *  2026-11-17 — the DO `get-catch-token` op existed but no Worker
 *  route exposed it, so a Runner on the live backend could never show
 *  a QR). The DO enforces runner-only + open-catch-only; the token is
 *  returned once over HTTPS and never logged. */
export const catchTokenBody = z.object({
  playerId: z.string().min(1),
  reconnectToken: z.string().min(1),
  catchId: z.string().min(1),
}).strict();
