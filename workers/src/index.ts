import { closeCodeFor } from './room-do.js';
import { CODE_INDEX_DO_NAME } from './room-do-class.js';
import {
  route, ticketStore, joinAllowed, lookupAllowed, reportAllowed, handleWsUpgrade,
  createAllowed, ticketAllowed, ticketRevokeAllowed, startAllowed,
  createRoomBody, joinBody, roomCodeSchema, ticketBody, updateConfigBody,
  removePlayerBody, regenerateCodeBody, catchTokenBody, hostTokenBody, lifecycleBody,
  transferBody, resolveBody, bugReportBody, grievanceBody, reportBody,
} from './http.js';
import {
  persistRoomCreated, persistBugReport, persistGrievance,
  persistReportAudit, supabaseConfigured, sbUpdate,
} from './supabase.js';
import {
  generateRoomCode, randomHex, sha256Hex, validateRoomConfig,
} from '@pakdam/shared';
import { parsePerMinuteLimit } from './rate-limit.js';
import type { Player, Room, RoomConfig } from '@pakdam/shared';
/**
 * Worker entry — the HTTP front door for the Pakdam Durable Object.
 *
 * Routes (implemented — this file used to be a 501 skeleton):
 *  POST /v1/rooms                 create room (host) — 201 returns
 *    roomId, roomCode, hostPlayerId, reconnectToken AND hostToken
 *    (Worker 5, SEC-06: the host token is a separate credential)
 *  GET  /v1/rooms/by-code/:code   code → roomId lookup (Worker F)
 *  POST /v1/rooms/:id/join        join via code (guest)
 *  POST /v1/rooms/:id/start       start the match (host only, QA BE-11;
 *    host-token auth since Worker 5, SEC-06)
 *  POST /v1/rooms/:id/config      host changes lobby settings (WIRING 2026-11-17;
 *    host-token auth since Worker 5, SEC-06)
 *  POST /v1/rooms/:id/remove-player  host removes a lobby player (WIRING 2026-11-17;
 *    host-token auth since Worker 5, SEC-06)
 *  POST /v1/rooms/:id/regenerate-code host regenerates the room code (D-M2;
 *    host-token auth, SEC-06 — old code stops working, new code works)
 *  POST /v1/rooms/:id/catch-token Runner fetches the raw QR token for an open catch (WIRING 2026-11-17)
 *  POST /v1/rooms/:id/lifecycle  start/pause/resume/end (Worker 5; pause is any
 *    player, the rest are host-only via host token)
 *  POST /v1/rooms/:id/host/token issue/rotate the host token (Worker 5; the
 *    caller proves the host seat with their reconnect token)
 *  POST /v1/rooms/:id/host/transfer  explicit host transfer (Worker 5; host token)
 *  POST /v1/rooms/:id/catches/:cid/resolve  host resolves a disputed catch (Worker 5)
 *  GET  /v1/rooms/:id/results    match result, participant-only (Worker 5)
 *  POST /v1/reports              report/block — audit record only (Worker 5)
 *  POST /v1/support/bugs         bug report, no location (Worker 5)
 *  POST /v1/support/grievances   Rule 20 grievance (Worker 5)
 *  POST /v1/rooms/:id/ws-ticket   single-use WS ticket over HTTPS (17 §2.5)
 *  POST /v1/rooms/:id/ws-ticket/revoke  revoke WS tickets (17 §2.6)
 *  GET  /v1/rooms/:id             recipient-specific lobby state (HNT-038;
 *    reconnect-token auth since Worker 5, SEC-06)
 *  WS   /v1/rooms/:id/ws?ticket=<ticket>  realtime (17 §3)
 *
 * Two credentials, two jobs (Worker 5, SEC-06):
 *  - RECONNECT token: proves a SEAT. Issued once per seat at create /
 *    join (raw value returned once over HTTPS; only the hash is
 *    stored). Used for WS tickets, rejoin/restore, snapshots, the
 *    catch-token route, and lifecycle pause.
 *  - HOST token: proves HOST authority. Issued at room creation (raw
 *    value returned once in the 201) and on rotation via
 *    POST .../host/token. Used for start, config, remove-player, host
 *    transfer, dispute resolution, lifecycle start/resume/end. Only
 *    its hash lives in DO state (hostTokens); it is never on the
 *    Player record, never in a snapshot, never logged.
 * A display name alone proves nothing — restoring a seat by name
 * requires the seat's reconnect token, and no host action accepts a
 * display name or a reconnect token in place of the host token.
 *
 * REST-vs-WS (Worker 5 — the missing REST routes in docs/API.md):
 *  /lifecycle, /results, /reports, /support/bugs, /support/grievances
 *  are REST (implemented here). /catches, /catches/:cid/confirm,
 *  /catches/:cid/dispute, /safety/sos and /leave are WS ONLY — the
 *  §3.3 messages already exist, are server-authoritative and
 *  idempotent; no REST route is registered for them (see http.ts).
 *
 * Supabase (Worker 5): rooms + host seat are persisted best-effort
 * on create (ctx.waitUntil — a Supabase failure never fails the
 * 201); match results, catches and safety events are persisted
 * best-effort from the DO. Support intake (/reports, /support/bugs,
 * /support/grievances) is Supabase-backed and answers 503 while
 * Supabase is unconfigured — a report must never be silently
 * dropped. Credentials come only from the SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY bindings (see supabase.ts).
 *
 * Game authority stays in the Durable Object. This Worker never trusts
 * client-provided roles, timestamps or scores: request bodies are
 * validated with Zod (http.ts — shape only), the domain rules are
 * checked by `validateRoomConfig` here AND in the DO, the room code is
 * verified against the DO before a join, and a WS ticket is issued
 * only after the DO verifies the seat's reconnect token.
 *
 * Join identity: the path :id is the roomId UUID from the host's
 * invite link; the body carries the 6-character roomCode as the
 * invite proof. A code-only invite link resolves code → roomId via
 * GET /v1/rooms/by-code/:code (Worker F, 2026-11-17) against the
 * singleton code index — a RoomDurableObject instance named
 * 'pakdam:code-index' holding ONLY the code → roomId map (see
 * room-do-class.ts); the web app then POSTs .../join with the
 * resolved roomId + the code, and must NOT guess roomIds.
 *
 * WS auth: the ticket travels ONLY in the handshake query string and
 * is consumed on upgrade. `hello` carries NO credential. The only WS
 * message that carries a ticket is `auth.refresh` (renewal).
 *
 * Rate limiting: joins are limited per CLIENT IP (5/min — placeholder,
 * OPEN HNT-071), not per room: a 30-player roster joining inside a
 * minute is legitimate and must not be throttled by a per-room cap.
 * The IP comes from `cf-connecting-ip`; without it the key is
 * 'unknown' (local dev). The 5/min default is overridable ONLY by an
 * explicit Worker var (`PAKDAM_JOIN_PER_MINUTE`, see WorkerEnv) —
 * local load runs set it (k6), deployments leave it unset.
 *
 * NOTE (2026-11-17): this entrypoint must NOT export the ROOM_DO_CLASS
 * string constant (it lives in ./room-do.js for code that needs the
 * name). Workerd rejects a string-valued export from the entrypoint
 * ("Incorrect type for map entry 'ROOM_DO_CLASS'") and then reports
 * the DO class as missing. Only the DO class itself (a function) and
 * the default handler may be exported here.
 *
 * NOT deployed: wrangler.toml says deploy ONLY after founder approves
 * the M00 report + architecture. No secrets here.
 */
export { closeCodeFor };
export { RoomDurableObject } from './room-do-class.js';

/** Worker environment: the ROOM_DO binding (wrangler.toml), the plain
 *  ENVIRONMENT var, and the optional Supabase bindings (Worker 5 —
 *  SUPABASE_URL is a plain var, SUPABASE_SERVICE_ROLE_KEY a secret;
 *  both absent/empty means "run without Supabase persistence", never
 *  an error). No secrets are read here. */
interface WorkerEnv {
  ROOM_DO: DurableObjectNamespace;
  ENVIRONMENT: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /**
   * Per-IP placeholder rate limits (OPEN HNT-071) — env override,
   * 2026-11-17. Defaults are 5/min/IP when unset (the documented
   * production default — NEVER raised silently). Set ONLY for a
   * local load run, e.g. `npx wrangler dev --var
   * PAKDAM_JOIN_PER_MINUTE:100` so 16 k6 VUs sharing 127.0.0.1 can
   * join inside a minute; a deployed Worker leaves these unset.
   * Invalid values fall back to 5 (parsePerMinuteLimit).
   */
  PAKDAM_JOIN_PER_MINUTE?: string;
  PAKDAM_CREATE_PER_MINUTE?: string;
  PAKDAM_LOOKUP_PER_MINUTE?: string;
}

/** Verify a seat's reconnect token against the DO (read-only op).
 *  Returns the DO response unchanged on 404/transport trouble, or
 *  throws nothing — callers check `verified.status` first, then
 *  `{ ok }`. A failed verification is 403 with the shared message. */
async function verifySeat(env: WorkerEnv, roomId: string, playerId: string, token: string): Promise<Response> {
  return doOp(env, roomId, { op: 'verify-reconnect', playerId, token });
}

/** Verify the host token against the DO (read-only op). Same shape
 *  as verifySeat; a failed verification is 403 ('host token does not
 *  match this host seat'). */
async function verifyHost(env: WorkerEnv, roomId: string, playerId: string, token: string): Promise<Response> {
  return doOp(env, roomId, { op: 'verify-host-token', playerId, token });
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
const err = (message: string, status: number): Response => json({ error: message }, status);

/** CORS for the browser game client. The web app runs on a different
 *  origin (Vercel) from this Worker, so every browser fetch is
 *  cross-origin — and a POST with `Content-Type: application/json`
 *  triggers a preflight OPTIONS first. Without these headers the
 *  browser blocks the response and fetch rejects, so the client
 *  reports "Could not reach the game server" even though the Worker
 *  answered (curl works because it does not enforce CORS). Auth
 *  travels in request bodies (per-player secret tokens), never
 *  cookies, so `*` is safe. WebSocket upgrades (101) are not
 *  CORS-gated and pass through untouched. */
const CORS_PREFLIGHT_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json() as unknown;
  } catch {
    return undefined;
  }
}

/** Forward one internal op to the room's Durable Object and pass its
 *  response through (status + body). The DO is the authority — the
 *  Worker does not reinterpret its answers. */
async function doOp(env: WorkerEnv, roomId: string, body: Record<string, unknown>): Promise<Response> {
  const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
  const res = await stub.fetch(new Request('http://do/op', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? 'application/json';
  return new Response(text, { status: res.status, headers: { 'content-type': contentType, 'Access-Control-Allow-Origin': '*' } });
}

/** Forward one internal op to the singleton code-index Durable
 *  Object (idFromName(CODE_INDEX_DO_NAME)) and pass its response
 *  through. Same shape as doOp, different stub: the index instance
 *  holds NO room state, only the code → roomId map (see
 *  room-do-class.ts). */
async function indexOp(env: WorkerEnv, body: Record<string, unknown>): Promise<Response> {
  const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(CODE_INDEX_DO_NAME));
  const res = await stub.fetch(new Request('http://do/op', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? 'application/json';
  return new Response(text, { status: res.status, headers: { 'content-type': contentType, 'Access-Control-Allow-Origin': '*' } });
}

/** Register code → roomId in the index (Worker F). 'ok' on success;
 *  'conflict' when the code already belongs to ANOTHER room — the
 *  caller retries the create with a fresh code; 'error' on a
 *  transport failure or an unexpected status — the caller must NOT
 *  return a 201 for a room nobody can look up. */
async function registerRoomCode(env: WorkerEnv, roomCode: string, roomId: string): Promise<'ok' | 'conflict' | 'error'> {
  let res: Response;
  try {
    res = await indexOp(env, { op: 'register-code', roomCode, roomId });
  } catch {
    return 'error';
  }
  if (res.status === 200) return 'ok';
  if (res.status === 409) return 'conflict';
  return 'error';
}

/** GET /v1/rooms/by-code/:code (Worker F) — resolve an invite code
 *  to its roomId so the join pages can join from a code-only invite
 *  link. Contract: 200 { ok, roomId, roomCode } — roomId + code
 *  ONLY: no player list, no config, no tokens, no location. 400
 *  malformed code, 404 unknown code, 429 per-IP limit. The lookup
 *  needs NO credential: the code itself is the invite proof, and
 *  the answer reveals nothing beyond "this code names this room"
 *  (the roomId UUID is unguessable and useless without the code —
 *  POST .../join still verifies the code against the DO). */
async function handleByCode(req: Request, env: WorkerEnv, code: string): Promise<Response> {
  // Per-client-IP rate limit (5/min default, placeholder — OPEN HNT-071; env override PAKDAM_LOOKUP_PER_MINUTE).
  const clientIp = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!lookupAllowed(clientIp, Date.now(), parsePerMinuteLimit(env.PAKDAM_LOOKUP_PER_MINUTE, 5))) {
    return err('too many code lookups — try again in a minute', 429);
  }
  const parsed = roomCodeSchema.safeParse(code);
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const roomCode = parsed.data;
  let lookedUp: Response;
  try {
    lookedUp = await indexOp(env, { op: 'lookup-code', roomCode });
  } catch {
    return err('could not look up the room code — try again', 502);
  }
  if (lookedUp.status === 404) return err('unknown room code', 404);
  if (lookedUp.status !== 200) return lookedUp;
  const { roomId } = await lookedUp.json() as { roomId: string };
  return json({ ok: true, roomId, roomCode });
}

async function handleCreateRoom(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const parsed = createRoomBody.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { displayName, kind, config, ageGatePassed } = parsed.data;
  // Domain rules (the DO re-checks these in its 'create' op).
  const configErrors = validateRoomConfig(config as RoomConfig);
  if (configErrors.length > 0) {
    return err(`invalid room config: ${configErrors.join('; ')}`, 400);
  }
  // SEC-12: per-client-IP room-create limit (5/min default, placeholder —
  // OPEN HNT-071; env override PAKDAM_CREATE_PER_MINUTE). Stops room spam from one client.
  const clientIp = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!createAllowed(clientIp, Date.now(), parsePerMinuteLimit(env.PAKDAM_CREATE_PER_MINUTE, 5))) {
    return err('too many rooms created — try again in a minute', 429);
  }
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  // Room-code registration (Worker F): the code → roomId index is
  // written SYNCHRONOUSLY before the 201 returns, so a code is
  // always resolvable the moment the host sees it. A code collision
  // (32^6 space — ~1 in a billion per create) retries the whole
  // create with a fresh code (max 3 attempts): the abandoned room
  // DO is never shared with anyone — its code was never returned —
  // and behaves like a room nobody joined. A registration failure
  // that is not a collision is a 502, never a 201 for a room nobody
  // can look up. The index is the lookup authority, NOT Supabase:
  // persistRoomCreated below is best-effort (a failure never fails
  // the 201) and Supabase may be unconfigured, so a Supabase-only
  // lookup could miss a live room.
  let room: Room | null = null;
  let host: Player | null = null;
  let roomId = '';
  let roomCode = '';
  let hostPlayerId = '';
  let reconnectToken = '';
  let hostToken = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    roomId = globalThis.crypto.randomUUID();
    roomCode = generateRoomCode();
    hostPlayerId = globalThis.crypto.randomUUID();
    // The host's reconnect token: raw value returned ONCE in this
    // response (HTTPS only) — the stored record holds the hash only.
    reconnectToken = randomHex(16);
    // The host token (Worker 5, SEC-06): a SEPARATE credential that
    // proves HOST authority (start, config, remove, transfer, resolve,
    // lifecycle start/resume/end). Raw value returned ONCE in this
    // response; only its hash goes to the DO (hostTokens), never the
    // Player record, never a snapshot, never a log.
    hostToken = randomHex(16);
    host = {
      playerId: hostPlayerId, roomId, kind, displayName,
      isHost: true, matchRole: null, team: null,
      reconnectTokenHash: sha256Hex(reconnectToken),
      joinedAt: now, leftAt: null, ejectedAt: null,
      connectionState: 'connected', lastFixAt: null, locationQuality: 'unknown',
      isReady: false, briefingConfirmed: false, ageGatePassed,
      suspensionCount: 0,
    };
    room = {
      roomId, roomCode, hostPlayerId, phase: 'LOBBY', version: 1,
      config: config as RoomConfig, createdAt: now,
      startedAt: null, endsAt: null, pausedAt: null, result: null,
    };
    const created = await doOp(env, roomId, { op: 'create', room, host, hostTokenHash: sha256Hex(hostToken) });
    if (created.status !== 200) return created;
    const registered = await registerRoomCode(env, roomCode, roomId);
    if (registered === 'ok') break;
    if (registered === 'conflict' && attempt < 2) continue;
    return err('could not register the room code — try again', 502);
  }
  if (!room || !host) return err('could not create the room — try again', 502);
  // Best-effort Supabase persistence (Worker 5): the rooms row + the
  // host's players row. waitUntil — a Supabase failure (or an
  // unconfigured Supabase) never fails the 201; the DO stays the
  // authority and the room exists regardless.
  ctx.waitUntil(persistRoomCreated(env, room, host));
  return json({ ok: true, roomId, roomCode, hostPlayerId, reconnectToken, hostToken }, 201);
}

async function handleJoin(req: Request, env: WorkerEnv, roomId: string): Promise<Response> {
  // Per-client-IP rate limit (5/min default, placeholder — OPEN HNT-071; env override PAKDAM_JOIN_PER_MINUTE).
  const clientIp = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!joinAllowed(clientIp, Date.now(), parsePerMinuteLimit(env.PAKDAM_JOIN_PER_MINUTE, 5))) {
    return err('too many join attempts — try again in a minute', 429);
  }
  const parsed = joinBody.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { displayName, kind, roomCode, reconnectToken } = parsed.data;
  // The guest must know the room CODE, not just the roomId: the DO
  // verifies it (read-only op). A wrong code is 403 — the code is
  // the invite proof, and a 404 here would leak room existence by
  // roomId probing (the roomId UUID is unguessable, but the code
  // check is the point of the join).
  const verified = await doOp(env, roomId, { op: 'verify-code', roomCode });
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('room code does not match this room', 403);
  // The DO enforces display-name validation, the LOBBY phase check,
  // the room-full check (maxPlayers 30), and seat restore on a
  // duplicate display name — and returns the raw reconnect token
  // ONCE for a new seat. A restore requires the seat's reconnect
  // token (SEC-06, Worker 5): it is forwarded when the client
  // presents it, and the DO answers 403 without it.
  return doOp(env, roomId, { op: 'add-player', displayName, kind, reconnectToken: reconnectToken ?? null });
}

async function handleWsTicket(req: Request, env: WorkerEnv, roomId: string): Promise<Response> {
  const parsed = ticketBody.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { playerId, reconnectToken, purpose } = parsed.data;
  const verified = await doOp(env, roomId, { op: 'verify-reconnect', playerId, token: reconnectToken });
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('reconnect token does not match this seat', 403);
  // SEC-12: per-seat ticket limit (10/min, placeholder — OPEN
  // HNT-071). Stops ticket farming for a seat.
  if (!ticketAllowed(roomId, playerId, Date.now())) {
    return err('too many ticket requests — try again in a minute', 429);
  }
  // Issuing a new ticket revokes any other unredeemed ticket for the
  // seat (17 §2.5). TTL 60 s is a placeholder — OPEN calibration
  // (17 §7); the API mission must replace it with a measured value.
  // `newTicket` (http.ts) returns only the ticket string; the route
  // needs the ticketId + expiry too, so it issues directly.
  // SEC-11: `purpose` is 'connect' (default — opens a new socket)
  // or 'renew' (a fresh ticket for `auth.refresh` on an EXISTING
  // socket; a renew ticket can never open a socket). The ticket is
  // REGISTERED with the DO (hash only) before it is returned, so
  // the DO can validate renewals and the handshake itself — if the
  // registration fails, the ticket is revoked and no ticket is
  // returned (a ticket the DO never saw must never be usable).
  const ticketPurpose = purpose ?? 'connect';
  const issued = ticketStore.issue(roomId, playerId, ticketPurpose, 60_000, Date.now());
  const record = ticketStore.recordFor(issued.ticketId);
  if (!record) {
    ticketStore.revokeSeat(roomId, playerId);
    return err('could not issue ticket', 502);
  }
  const registered = await doOp(env, roomId, {
    op: 'register-ticket', ticketId: issued.ticketId, hash: record.hash,
    roomId, playerId, purpose: ticketPurpose, expiresAtMs: issued.expiresAtMs,
  });
  if (registered.status === 404) {
    ticketStore.revokeSeat(roomId, playerId);
    return err('room not found', 404);
  }
  if (registered.status !== 200) {
    ticketStore.revokeSeat(roomId, playerId);
    return err('could not register ticket', 502);
  }
  return json({ ok: true, ticket: issued.ticket, ticketId: issued.ticketId, expiresAtMs: issued.expiresAtMs });
}

async function handleStart(req: Request, env: WorkerEnv, roomId: string): Promise<Response> {
  // QA BE-11 (2026-11-17): the match had NO client-reachable start —
  // startMatch existed (pure + tested) and the DO had a `start` op,
  // but the Worker exposed no route for it and the WS protocol has no
  // start message, so a host on the real backend could never start a
  // match. Auth (Worker 5, SEC-06): the HOST token — not the
  // reconnect token, not a display name. The DO enforces host-only
  // (SEC-09, 403) plus min-3 / all-ready / role assignment (GL-03)
  // and returns 409 when the room is not ready to start.
  const parsed = hostTokenBody.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { playerId, hostToken } = parsed.data;
  const verified = await verifyHost(env, roomId, playerId, hostToken);
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('host token does not match this host seat', 403);
  // SEC-12: per-seat start limit (5/min, placeholder — OPEN
  // HNT-071). Stops start-spam hammering the DO.
  if (!startAllowed(roomId, playerId, Date.now())) {
    return err('too many start attempts — try again in a minute', 429);
  }
  return doOp(env, roomId, { op: 'start', actorId: playerId });
}

async function handleWsTicketRevoke(req: Request, env: WorkerEnv, roomId: string): Promise<Response> {
  const parsed = ticketBody.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { playerId, reconnectToken } = parsed.data;
  const verified = await doOp(env, roomId, { op: 'verify-reconnect', playerId, token: reconnectToken });
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('reconnect token does not match this seat', 403);
  // SEC-12: per-seat revoke limit (10/min, placeholder — OPEN HNT-071).
  if (!ticketRevokeAllowed(roomId, playerId, Date.now())) {
    return err('too many ticket revokes — try again in a minute', 429);
  }
  const revoked = ticketStore.revokeSeat(roomId, playerId);
  return json({ ok: true, revoked });
}

/** D-M2: host regenerates the room code from the lobby — POST
 *  /v1/rooms/:id/regenerate-code { playerId, hostToken } (no code in
 *  the body: the server generates it, so a client can never pick a
 *  code that collides or spells something). Host token verified
 *  first (SEC-06); the DO re-checks host-only + LOBBY-only.
 *
 *  Ordering (the old code must stop working, the new code must
 *  work, and a failure mid-flight must never strand the room):
 *  1. Generate a candidate and check it is FREE in the index
 *     (lookup 404). A candidate naming any room — including this
 *     room's current code — is skipped (max 3 attempts).
 *  2. REGISTER the new code → roomId first. If anything after this
 *     fails, the room still answers on the old code (the DO has not
 *     changed) and the new mapping is rolled back; a lookup for the
 *     new code in that window resolves the room, but join still
 *     verifies the code against the DO's old code, so nobody can
 *     join on it early.
 *  3. DO `regenerate-code` swaps the room's code. From this moment
 *     the old code is dead: joins verify against room.roomCode.
 *  4. Unregister the old code (best-effort — even if it fails, the
 *     old code cannot join, per step 3) and mirror the new code to
 *     the Supabase rooms row best-effort (ctx.waitUntil — a failure
 *     never fails the 200; the DO stays the authority).
 *  Answers 200 { ok, roomCode, oldRoomCode }; 403 wrong host token /
 *  non-host; 409 the room is not in LOBBY; 502 index trouble. */
async function handleRegenerateCode(
  req: Request, env: WorkerEnv, ctx: ExecutionContext, roomId: string,
): Promise<Response> {
  const parsed = regenerateCodeBody.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { playerId, hostToken } = parsed.data;
  const verified = await verifyHost(env, roomId, playerId, hostToken);
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('host token does not match this host seat', 403);
  let newCode = '';
  for (let attempt = 0; attempt < 3 && !newCode; attempt++) {
    const candidate = generateRoomCode();
    let lookedUp: Response;
    try {
      lookedUp = await indexOp(env, { op: 'lookup-code', roomCode: candidate });
    } catch {
      return err('could not look up the room code — try again', 502);
    }
    if (lookedUp.status === 200) continue; // taken by some room (or this room's current code) — retry
    if (lookedUp.status !== 404) return err('could not look up the room code — try again', 502);
    const registered = await registerRoomCode(env, candidate, roomId);
    if (registered === 'ok') newCode = candidate;
    else if (registered === 'error') return err('could not register the room code — try again', 502);
    // 'conflict' (raced between lookup and register) — retry with a fresh code.
  }
  if (!newCode) return err('could not find a free room code — try again', 502);
  const swapped = await doOp(env, roomId, { op: 'regenerate-code', actorId: playerId, roomCode: newCode });
  if (swapped.status !== 200) {
    // Roll the new index mapping back so the new code resolves nowhere.
    try { await indexOp(env, { op: 'unregister-code', roomCode: newCode, roomId }); } catch { /* best-effort rollback */ }
    return swapped;
  }
  const { oldRoomCode } = await swapped.json() as { oldRoomCode: string };
  if (oldRoomCode) {
    try { await indexOp(env, { op: 'unregister-code', roomCode: oldRoomCode, roomId }); } catch { /* old code is dead anyway (step 3) */ }
    ctx.waitUntil(sbUpdate(env, 'rooms', { room_id: roomId }, { room_code: newCode }));
  }
  return json({ ok: true, roomCode: newCode, oldRoomCode });
}

/** WIRING 2026-11-17 / Worker 5: verify the HOST token, then forward
 *  a host-only lobby action to the DO. The DO is the authority on
 *  host-only / LOBBY-only / domain rules — the Worker only proves
 *  host authority and forwards. Shared by update-config and
 *  remove-player. (Worker 5 changed this from reconnect-token auth
 *  to host-token auth, SEC-06: a seat credential must never confer
 *  host powers on its own.) */
async function handleSeatAction(
  req: Request, env: WorkerEnv, roomId: string,
  bodySchema: typeof updateConfigBody | typeof removePlayerBody,
  op: string,
): Promise<Response> {
  const parsed = bodySchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { playerId, hostToken } = parsed.data;
  const verified = await verifyHost(env, roomId, playerId, hostToken);
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('host token does not match this host seat', 403);
  const extra = 'config' in parsed.data
    ? { config: parsed.data.config }
    : { targetPlayerId: (parsed.data as { targetPlayerId: string }).targetPlayerId };
  return doOp(env, roomId, { op, actorId: playerId, ...extra });
}

/** WIRING 2026-11-17: Runner fetches the raw one-time catch token for
 *  an open catch (to show as a QR). Seat proven with the reconnect
 *  token first; the DO enforces runner-only + open-catch-only and
 *  returns 404 when there is no token for this catch and seat. */
async function handleCatchToken(req: Request, env: WorkerEnv, roomId: string): Promise<Response> {
  const parsed = catchTokenBody.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { playerId, reconnectToken, catchId } = parsed.data;
  const verified = await doOp(env, roomId, { op: 'verify-reconnect', playerId, token: reconnectToken });
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('reconnect token does not match this seat', 403);
  return doOp(env, roomId, { op: 'get-catch-token', catchId, playerId });
}

async function handleGetState(req: Request, env: WorkerEnv, roomId: string, url: URL): Promise<Response> {
  const playerId = url.searchParams.get('playerId');
  if (!playerId) return err('playerId query parameter is required', 400);
  // Worker 5, SEC-06: a playerId alone no longer opens the room.
  // The caller proves the seat with the raw reconnect token — via
  // `Authorization: Bearer <token>` (preferred: query strings can
  // land in edge access logs) or `?reconnectToken=` as a fallback.
  // The DO verifies the token against the stored hash; the snapshot
  // itself is still recipient-filtered (HNT-038) and returns null
  // (404) for a playerId that is not a seat in this room (SEC-02).
  const auth = req.headers.get('authorization');
  const token = auth?.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : url.searchParams.get('reconnectToken');
  if (!token) return err('reconnectToken is required (Authorization: Bearer <token> or ?reconnectToken=)', 400);
  const verified = await verifySeat(env, roomId, playerId, token);
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('reconnect token does not match this seat', 403);
  // SEC-10: the DO verifies the token itself too (defence in depth)
  // — forward it with the get-state op, never just the playerId.
  return doOp(env, roomId, { op: 'get-state', playerId, token });
}

/** Worker 5 (SEC-06): issue or ROTATE the host token for the current
 *  host seat. The caller proves the host seat with their reconnect
 *  token (ticketBody); the DO checks seat + isHost, then mints a
 *  fresh host token and stores only its hash — the previous host
 *  token for that seat dies on rotation. This is how a successor
 *  host (after an automatic transfer on host-leave, or an explicit
 *  transfer) gets a host token, and how a host who lost theirs
 *  recovers host powers. Response 200: { ok: true, hostToken } —
 *  the raw token, returned ONCE, never logged. 403 when the seat is
 *  not the host or the reconnect token does not match. */
async function handleHostToken(req: Request, env: WorkerEnv, roomId: string): Promise<Response> {
  const parsed = ticketBody.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { playerId, reconnectToken } = parsed.data;
  return doOp(env, roomId, { op: 'issue-host-token', playerId, reconnectToken });
}

/** Worker 5: match lifecycle over REST — POST /v1/rooms/:id/lifecycle
 *  { action, playerId, hostToken?, reconnectToken? }.
 *  - start / resume / end: host-only, `hostToken` required (verified
 *    against the DO first); the DO re-checks actorId === host.
 *  - pause: ANY player (safety is not host-gated), `reconnectToken`
 *    required (verified against the DO first).
 *  The DO `lifecycle` op reuses the WS handler for pause/resume
 *  (same server-authoritative validation) and startMatch / endMatch
 *  for start/end; it returns 409 for a not-ready start or an illegal
 *  phase, 403 for a non-host host action. */
async function handleLifecycle(req: Request, env: WorkerEnv, roomId: string): Promise<Response> {
  const parsed = lifecycleBody.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { action, playerId, hostToken, reconnectToken } = parsed.data;
  if (action === 'start' || action === 'resume' || action === 'end') {
    if (!hostToken) return err('hostToken is required for this action', 400);
    const verified = await verifyHost(env, roomId, playerId, hostToken);
    if (verified.status === 404) return err('room not found', 404);
    if (verified.status !== 200) return verified;
    const { ok } = await verified.json() as { ok: boolean };
    if (!ok) return err('host token does not match this host seat', 403);
  } else {
    if (!reconnectToken) return err('reconnectToken is required to pause', 400);
    const verified = await verifySeat(env, roomId, playerId, reconnectToken);
    if (verified.status === 404) return err('room not found', 404);
    if (verified.status !== 200) return verified;
    const { ok } = await verified.json() as { ok: boolean };
    if (!ok) return err('reconnect token does not match this seat', 403);
  }
  return doOp(env, roomId, { op: 'lifecycle', action, playerId });
}

/** Worker 5: explicit host transfer — POST /v1/rooms/:id/host/transfer
 *  { playerId, hostToken, newHostPlayerId }. The current host names
 *  the successor; the old host's token entry is deleted and the
 *  successor holds NO host token until they call POST .../host/token
 *  with their own reconnect token. (The automatic transfer on
 *  host-leave follows the same rule via the WS `leave` handler.) */
async function handleHostTransfer(req: Request, env: WorkerEnv, roomId: string): Promise<Response> {
  const parsed = transferBody.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { playerId, hostToken, newHostPlayerId } = parsed.data;
  const verified = await verifyHost(env, roomId, playerId, hostToken);
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('host token does not match this host seat', 403);
  return doOp(env, roomId, { op: 'transfer-host', actorId: playerId, newHostPlayerId });
}

/** Worker 5: host resolves a disputed catch — POST
 *  /v1/rooms/:id/catches/:cid/resolve { playerId, hostToken,
 *  decision: 'confirmed' | 'rejected', reason? }. Auth is the host
 *  token; the DO enforces host-only + catch-must-be-disputed, then
 *  applies the mode/win rules for a confirm or voids the claim for
 *  a reject. 404 when the catch does not exist, 409 when it is not
 *  disputed. (Request/confirm/dispute themselves stay WS-only —
 *  see the REST-vs-WS note in http.ts.) */
async function handleCatchResolve(req: Request, env: WorkerEnv, roomId: string, catchId: string): Promise<Response> {
  const parsed = resolveBody.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const { playerId, hostToken, decision, reason } = parsed.data;
  const verified = await verifyHost(env, roomId, playerId, hostToken);
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('host token does not match this host seat', 403);
  return doOp(env, roomId, { op: 'resolve-catch', catchId, actorId: playerId, decision, reason: reason ?? null });
}

/** Worker 5: match result — GET /v1/rooms/:id/results. Same seat
 *  auth as get-state (playerId + reconnect token, Bearer preferred).
 *  Response 200: { ok: true, roomId, phase, result } — the result is
 *  null until the match ends; 404 { error: 'match has no result yet' }
 *  while it is null, so a caller can tell "no result" from "no room".
 *  No routes or coordinate trails are ever returned (HNT-069). */
async function handleResults(req: Request, env: WorkerEnv, roomId: string, url: URL): Promise<Response> {
  const playerId = url.searchParams.get('playerId');
  if (!playerId) return err('playerId query parameter is required', 400);
  const auth = req.headers.get('authorization');
  const token = auth?.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : url.searchParams.get('reconnectToken');
  if (!token) return err('reconnectToken is required (Authorization: Bearer <token> or ?reconnectToken=)', 400);
  const verified = await verifySeat(env, roomId, playerId, token);
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('reconnect token does not match this seat', 403);
  // SEC-10: forward the token to the get-state op too — the DO
  // verifies it itself (defence in depth).
  const stateRes = await doOp(env, roomId, { op: 'get-state', playerId, token });
  if (stateRes.status !== 200) return stateRes;
  // The get-state op returns the engine's AuthorisedSnapshot
  // ({ room, players, version }) — `room` is TOP-LEVEL, not under
  // a `payload` wrapper (the WS snapshot message shape is different).
  // Reading snap.payload.room here 404'd every result (fixed
  // 2026-11-17 after the wrangler dev smoke proved it).
  const snap = await stateRes.json() as { room?: { phase?: string; result?: unknown } };
  const room = snap.room;
  if (!room || room.result === null || room.result === undefined) {
    return err('match has no result yet', 404);
  }
  return json({ ok: true, roomId, phase: room.phase, result: room.result });
}

/** Worker 5: support intake — POST /v1/reports, /v1/support/bugs,
 *  /v1/support/grievances. All three are Supabase intake only (no
 *  DO authority needed) and rate-limited per client IP (5/min).
 *  Unlike game writes, these are NOT best-effort-silent: when
 *  Supabase is unconfigured the route answers 503, and when the
 *  insert fails it answers 503 too — a report, bug or grievance
 *  must never be accepted and then silently dropped. */
async function handleSupportIntake(req: Request, env: WorkerEnv, kind: 'reports' | 'bugs' | 'grievances'): Promise<Response> {
  const clientIp = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!reportAllowed(clientIp, Date.now())) {
    return err('too many reports — try again in a minute', 429);
  }
  if (!supabaseConfigured(env)) {
    return err('support intake is not configured yet (Supabase is not wired)', 503);
  }
  const body = await readJsonBody(req);
  if (kind === 'bugs') {
    const parsed = bugReportBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: 'invalid request', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
    }
    const stored = await persistBugReport(env, {
      roomId: parsed.data.roomId ?? null, playerId: parsed.data.playerId ?? null,
      deviceInfo: parsed.data.deviceInfo, appVersion: parsed.data.appVersion,
      description: parsed.data.description,
    });
    if (!stored) return err('could not store the bug report — try again', 503);
    return json({ ok: true, received: true }, 202);
  }
  if (kind === 'grievances') {
    const parsed = grievanceBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: 'invalid request', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
    }
    const stored = await persistGrievance(env, {
      complainantRef: parsed.data.complainantRef, channel: parsed.data.channel,
      summary: parsed.data.summary,
    });
    if (!stored) return err('could not store the grievance — try again', 503);
    return json({ ok: true, received: true }, 202);
  }
  const parsed = reportBody.safeParse(body);
  if (!parsed.success) {
    return json({ error: 'invalid request', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
  }
  // The reporter must be a participant in the room they report from.
  const verified = await verifySeat(env, parsed.data.roomId, parsed.data.playerId, parsed.data.reconnectToken);
  if (verified.status === 404) return err('room not found', 404);
  if (verified.status !== 200) return verified;
  const { ok } = await verified.json() as { ok: boolean };
  if (!ok) return err('reconnect token does not match this seat', 403);
  const stored = await persistReportAudit(env, parsed.data.roomId, parsed.data.playerId, parsed.data.targetPlayerId ?? null, parsed.data.kind);
  if (!stored) return err('could not store the report — try again', 503);
  return json({ ok: true, received: true }, 202);
}

/** Reject a WebSocket handshake with a real WS close frame. A plain
 *  HTTP 401 in answer to an upgrade request surfaces to browsers and
 *  Node clients as close 1006 (abnormal closure, no close frame) —
 *  the client can then never see the contract's 4401
 *  (TICKET_INVALID / TICKET_REUSED / TICKET_EXPIRED, 17 §3.1/§3.4)
 *  and would mis-handle the failure (1006 = reconnect with backoff,
 *  4401 = fetch a fresh ticket first, then reconnect once). Accepting
 *  the pair and closing it at once delivers the real close code. */
function wsCloseResponse(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

async function handleWebSocket(req: Request, env: WorkerEnv, roomId: string, url: URL): Promise<Response> {
  if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return err('websocket upgrade required', 426);
  }
  const presentedTicket = url.searchParams.get('ticket');
  // Resolve the ticket to its seat first (read-only peek — the
  // ticket is consumed by handleWsUpgrade below, not by the peek).
  const seat = presentedTicket ? ticketStore.peek(presentedTicket) : null;
  if (!seat || seat.roomId !== roomId) {
    // 4401 close frame, not HTTP 401 — see wsCloseResponse above.
    return wsCloseResponse(4401, 'WS ticket is not valid for this room and seat');
  }
  const upgraded = handleWsUpgrade(ticketStore, presentedTicket, roomId, seat.playerId, Date.now());
  if (!upgraded.ok) {
    return wsCloseResponse(upgraded.closeCode, upgraded.message);
  }
  // Forward the upgrade to the DO with the seat headers. The DO
  // sends `welcome` + a recipient-filtered snapshot, then owns the
  // socket (webSocketMessage / webSocketClose). SEC-11: the ticket
  // expiry goes too, so the DO can warn (renewal-required) and
  // enforce the ticket lifetime on the socket itself.
  const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
  const forwarded = await stub.fetch(new Request('http://do/ws', {
    headers: {
      Upgrade: 'websocket',
      'x-pakdam-player-id': seat.playerId,
      'x-pakdam-ticket-id': upgraded.ticketId,
      'x-pakdam-ticket-expires': String(seat.expiresAtMs),
    },
  }));
  return forwarded;
}

export default {
  async fetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight: browsers send OPTIONS before any POST with a
    // JSON body. Answer it here, before routing, or the preflight
    // gets a 405 and the real request never happens.
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
    }
    const url = new URL(req.url);
    const path = url.pathname;
    const kind = route(path);
    if (kind === 'not-found') return err('not found', 404);
    // Room id is the third segment: /v1/rooms/:id/...
    const segments = path.split('/').filter(Boolean);
    const roomId = segments[2] ?? '';
    // Catch id is the fifth segment: /v1/rooms/:id/catches/:cid/...
    const catchId = segments[4] ?? '';

    if (kind === 'create-room') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleCreateRoom(req, env, ctx);
    }
    // Support intake has no room in the path (and /v1/reports carries
    // its roomId in the body) — dispatch it before the roomId check.
    if (kind === 'reports' || kind === 'bugs' || kind === 'grievances') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleSupportIntake(req, env, kind);
    }
    // Code → roomId lookup (Worker F): the third segment is the
    // literal 'by-code' and the code is the fourth — dispatch before
    // the roomId check below, which would otherwise read 'by-code'
    // as a room id.
    if (kind === 'by-code') {
      if (req.method !== 'GET') return err('method not allowed', 405);
      const code = segments[3] ?? '';
      if (!code) return err('room code is required', 400);
      return handleByCode(req, env, code);
    }
    if (!roomId) return err('room id is required', 400);
    if (kind === 'join') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleJoin(req, env, roomId);
    }
    if (kind === 'start') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleStart(req, env, roomId);
    }
    if (kind === 'ws-ticket') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleWsTicket(req, env, roomId);
    }
    if (kind === 'ws-ticket-revoke') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleWsTicketRevoke(req, env, roomId);
    }
    if (kind === 'config') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleSeatAction(req, env, roomId, updateConfigBody, 'update-config');
    }
    if (kind === 'remove-player') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleSeatAction(req, env, roomId, removePlayerBody, 'remove-player');
    }
    if (kind === 'regenerate-code') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleRegenerateCode(req, env, ctx, roomId);
    }
    if (kind === 'catch-token') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleCatchToken(req, env, roomId);
    }
    if (kind === 'lifecycle') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleLifecycle(req, env, roomId);
    }
    if (kind === 'host-token') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleHostToken(req, env, roomId);
    }
    if (kind === 'host-transfer') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      return handleHostTransfer(req, env, roomId);
    }
    if (kind === 'catch-resolve') {
      if (req.method !== 'POST') return err('method not allowed', 405);
      if (!catchId) return err('catch id is required', 400);
      return handleCatchResolve(req, env, roomId, catchId);
    }
    if (kind === 'results') {
      if (req.method !== 'GET') return err('method not allowed', 405);
      return handleResults(req, env, roomId, url);
    }
    if (kind === 'get-state') {
      if (req.method !== 'GET') return err('method not allowed', 405);
      return handleGetState(req, env, roomId, url);
    }
    if (kind === 'websocket') {
      return handleWebSocket(req, env, roomId, url);
    }
    return err('not found', 404);
  },
};
