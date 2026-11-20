/**
 * @pakdam/workers — HTTP route handlers.
 *
 * The Worker is a thin front door: it validates HTTP bodies, verifies
 * credentials by hash (raw tokens are hashed here, never logged, never
 * stored), and forwards game authority to the room's DO. It NEVER validates
 * a WS ticket against its own store — issuance mints the value and registers
 * only the hash with the DO (see `handleWsTicket`).
 *
 * Success is flat `{ ok: true, ... }`; errors are `{ error: '...' }`
 * (or `{ error, issues }` for a bad body, 400).
 *
 * Deliberately NO REST routes (404 by design — WS only): catch
 * request/confirm/dispute, safety SOS, leave. Do not add REST twins.
 * No leaderboard route exists.
 */
import {
  isValidDisplayName,
  isValidRoomCode,
  isValidCatchToken,
  newId,
  validateRoomConfig,
  type RoomConfig,
} from '@pakdam/shared';
import {
  generateRoomCode,
  hashHostToken,
  hashReconnectToken,
  hashTicketValue,
  hashWsTicket,
  newHostToken,
  newReconnectToken,
  newWsTicket,
} from './auth.js';
import { persistBugReport, persistGrievance, persistReportAudit, type SupabaseEnv } from './supabase.js';
import { HttpRateLimiter, seatKey } from './rate-limit.js';
import { recordTelemetry } from './telemetry.js';
import type { Env } from './index.js';

/** Max request body: 1 MB (P1-16). Larger bodies are rejected with 413. */
export const MAX_BODY_BYTES = 1_048_576;

/** UUID shape (v4-style, case-insensitive) — ids are `crypto.randomUUID()`. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Per-seat HTTP limiter, keyed by the TOKEN HASH (P1-14) — never by the
 * unauthenticated client-supplied playerId. The hash is derived from the
 * presented credential, so rotating playerIds cannot dodge the bucket.
 * The Worker entry skips its pre-handler limit for seat routes; each
 * handler below checks this limiter AFTER parsing the credential and
 * BEFORE calling the DO.
 */
const seatLimiter = new HttpRateLimiter();

async function checkSeatLimit(
  routeKey: string,
  roomId: string,
  tokenHash: string,
): Promise<Response | null> {
  const check = seatLimiter.check(routeKey, seatKey(roomId, tokenHash));
  if (check.allowed) return null;
  const res = err('Too many tries — slow down.', 429);
  const headers = new Headers(res.headers);
  headers.set('Retry-After', String(check.retryAfterSeconds));
  return new Response(res.body, { status: 429, headers });
}

/** 400 when a body id is present but not a UUID (P2, unvalidated ids). */
function badUuid(field: string): Response {
  return err(`${field} must be a valid id.`, 400);
}

export interface HttpContext {
  env: Env;
  ctx: ExecutionContext;
}

export function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function err(message: string, status: number, issues?: string[]): Response {
  return json(
    issues ? { error: message, issues } : { error: message },
    status,
  );
}

export async function parseBody(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: err('Invalid JSON body.', 400) };
  }
  // P1-16: cap the body at 1 MB before parsing it.
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, response: json({ error: 'Body too large (max 1 MB).' }, 413) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, response: err('Invalid JSON body.', 400) };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, response: err('Request body must be a JSON object.', 400) };
  }
  return { ok: true, body: raw as Record<string, unknown> };
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get('Authorization');
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim() || null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// -- DO plumbing ---------------------------------------------------------------

function doStub(env: Env, roomId: string): DurableObjectStub {
  return env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
}

function registryStub(env: Env): DurableObjectStub {
  return env.CODE_REGISTRY_DO.get(env.CODE_REGISTRY_DO.idFromName('pakdam-code-registry'));
}

interface DoResponse {
  ok: boolean;
  error?: string;
  code?: string;
  status?: number;
  [key: string]: unknown;
}

/** Worker -> DO internal calls carry the shared secret (P2, /op auth). */
function opSecretHeaders(env: Env): Record<string, string> {
  return env.DO_OP_SECRET ? { 'x-pakdam-op-secret': env.DO_OP_SECRET } : {};
}

/** Call one DO op; maps DO failures onto HTTP errors. */
async function callDo(
  env: Env,
  roomId: string,
  op: string,
  payload: Record<string, unknown>,
): Promise<DoResponse> {
  const stub = doStub(env, roomId);
  let res: Response;
  try {
    res = await stub.fetch('http://room-do/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opSecretHeaders(env) },
      body: JSON.stringify({ op, ...payload }),
    });
  } catch {
    return { ok: false, error: 'Room service unavailable.', code: 'SERVICE_UNAVAILABLE', status: 503 };
  }
  let data: DoResponse;
  try {
    data = (await res.json()) as DoResponse;
  } catch {
    return { ok: false, error: 'Room service returned an unreadable response.', code: 'SERVER_ERROR', status: 502 };
  }
  return data;
}

async function callRegistry(
  env: Env,
  op: string,
  payload: Record<string, unknown>,
): Promise<DoResponse> {
  const stub = registryStub(env);
  try {
    const res = await stub.fetch('http://code-registry/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opSecretHeaders(env) },
      body: JSON.stringify({ op, ...payload }),
    });
    return (await res.json()) as DoResponse;
  } catch {
    return { ok: false, error: 'Code registry unavailable.', code: 'SERVICE_UNAVAILABLE', status: 503 };
  }
}

/** Turn a DO failure into an HTTP error response. A DO rate limit carries
 * `Retry-After` (seconds) so the client backs off the same way it does for
 * the Worker-side limiter. */
function doError(r: DoResponse): Response {
  const status =
    typeof r.status === 'number'
      ? r.status
      : r.code === 'FORBIDDEN'
        ? 403
        : r.code === 'NOT_FOUND' || r.code === 'ROOM_NOT_FOUND'
          ? 404
          : r.code === 'CONFLICT' || r.code === 'INVALID_STATE'
            ? 409
            : r.code === 'VALIDATION_FAILED'
              ? 400
              : 400;
  const res = err(r.error ?? 'Room operation failed.', status);
  if (r.code === 'RATE_LIMITED' && typeof r['retryAfterSeconds'] === 'number') {
    const headers = new Headers(res.headers);
    headers.set('Retry-After', String(r['retryAfterSeconds']));
    return new Response(res.body, { status, headers });
  }
  return res;
}

function stripDoEnvelope(r: DoResponse): Record<string, unknown> {
  const { ok: _ok, ...rest } = r;
  void _ok;
  return rest;
}

// -- rooms ---------------------------------------------------------------------

/** POST /v1/rooms — create room (host). 201 + roomId, code, host seat, both tokens. */
export async function handleCreateRoom(req: Request, ctx: HttpContext): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const displayName = asString(body['displayName']);
  if (!displayName || !isValidDisplayName(displayName)) {
    return err('Display name must be 1–30 characters.', 400);
  }
  if (body['kind'] !== 'guest') {
    return err("kind must be 'guest'.", 400);
  }
  if (body['ageGatePassed'] !== true) {
    return err('Age gate must be passed to create a room.', 400);
  }
  const config = body['config'];
  if (typeof config !== 'object' || config === null) {
    return err('config is required.', 400);
  }
  const issues = validateRoomConfig(config);
  if (issues.length > 0) {
    return err('Room config is not valid.', 400, issues);
  }

  const roomId = newId();
  const hostPlayerId = newId();
  const reconnectToken = newReconnectToken();
  const hostToken = newHostToken();

  // Register the code synchronously before the 201 returns (retry on collision).
  // After 5 CONFLICT registrations, FAIL (P2) — never proceed with a code
  // that is already taken.
  let roomCode = '';
  let registered = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    roomCode = generateRoomCode();
    const reg = await callRegistry(ctx.env, 'register', { code: roomCode, roomId });
    if (reg.ok) {
      registered = true;
      break;
    }
    if (reg.code === 'CONFLICT') continue;
    return err('Code registry unavailable — try again.', 503);
  }
  if (!registered || !roomCode) return err('Could not allocate a room code — try again.', 503);

  const created = await callDo(ctx.env, roomId, 'create', {
    roomId,
    roomCode,
    hostPlayerId,
    displayName: displayName.trim(),
    config: config as RoomConfig,
    reconnectTokenHash: await hashReconnectToken(reconnectToken),
    hostTokenHash: await hashHostToken(hostToken),
  });
  if (!created.ok) {
    // Roll the code registration back so the code can be reused.
    await callRegistry(ctx.env, 'unregister', { code: roomCode, roomId });
    return doError(created);
  }
  recordTelemetry('player_games', 1);
  return json(
    { ok: true, roomId, roomCode, hostPlayerId, reconnectToken, hostToken },
    201,
  );
}

/** GET /v1/rooms/by-code/:code — resolve a 6-letter invite code to a roomId. */
export async function handleLookupByCode(
  _req: Request,
  ctx: HttpContext,
  code: string,
): Promise<Response> {
  if (!isValidRoomCode(code)) {
    return err('Room code must be 6 characters A–Z0–9.', 400);
  }
  const found = await callRegistry(ctx.env, 'lookup', { code });
  if (!found.ok) {
    return err('No live room for that code.', 404);
  }
  return json({ ok: true, roomId: found['roomId'], roomCode: code });
}

/** POST /v1/rooms/:id/join — join by code; restores a seat on name + token. */
export async function handleJoin(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const displayName = asString(body['displayName']);
  if (!displayName || !isValidDisplayName(displayName)) {
    return err('Display name must be 1–30 characters.', 400);
  }
  if (body['kind'] !== 'guest') {
    return err("kind must be 'guest'.", 400);
  }
  const roomCode = asString(body['roomCode']);
  if (!roomCode || !isValidRoomCode(roomCode)) {
    return err('roomCode must be 6 characters A–Z0–9.', 400);
  }
  const rawReconnect = asString(body['reconnectToken']);
  const joined = await callDo(ctx.env, roomId, 'add-player', {
    displayName: displayName.trim(),
    roomCode,
    reconnectTokenHash: rawReconnect ? await hashReconnectToken(rawReconnect) : null,
  });
  if (!joined.ok) return doError(joined);
  // A restore returns an EMPTY reconnect token — the client must never
  // overwrite a good stored token with it (enforced client-side).
  // Defense in depth: the DO already returns a PlayerView, but the HTTP
  // boundary strips any reconnectTokenHash all the same, so no join
  // response can ever carry one (BEHAVIOUR §4).
  const joinedPlayer = joined['player'];
  const player =
    joinedPlayer !== null && typeof joinedPlayer === 'object'
      ? (({ reconnectTokenHash: _hash, ...rest }) => rest)(
          joinedPlayer as Record<string, unknown>,
        )
      : joinedPlayer;
  recordTelemetry('player_games', 1);
  return json({
    ok: true,
    player,
    reconnectToken: joined['reconnectToken'],
    restored: joined['restored'],
  });
}

/**
 * POST /v1/rooms/join-by-code — join by code in ONE call (Phase 3 #9).
 * The client used to do GET by-code (registry hop) THEN POST join; this
 * folds the lookup into the join on the server side, so the client makes
 * a single request. Same validation, same DO op, same response shape as
 * handleJoin plus the roomId. The two-call path stays for back-compat.
 */
export async function handleJoinByCode(
  req: Request,
  ctx: HttpContext,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const displayName = asString(body['displayName']);
  if (!displayName || !isValidDisplayName(displayName)) {
    return err('Display name must be 1–30 characters.', 400);
  }
  if (body['kind'] !== 'guest') {
    return err("kind must be 'guest'.", 400);
  }
  const roomCode = asString(body['roomCode']);
  if (!roomCode || !isValidRoomCode(roomCode)) {
    return err('roomCode must be 6 characters A–Z0–9.', 400);
  }
  const found = await callRegistry(ctx.env, 'lookup', { code: roomCode.trim().toUpperCase() });
  if (!found.ok) {
    return err('No live room for that code.', 404);
  }
  const roomId = found['roomId'] as string;
  const rawReconnect = asString(body['reconnectToken']);
  const joined = await callDo(ctx.env, roomId, 'add-player', {
    displayName: displayName.trim(),
    roomCode: roomCode.trim().toUpperCase(),
    reconnectTokenHash: rawReconnect ? await hashReconnectToken(rawReconnect) : null,
  });
  if (!joined.ok) return doError(joined);
  const joinedPlayer = joined['player'];
  const player =
    joinedPlayer !== null && typeof joinedPlayer === 'object'
      ? (({ reconnectTokenHash: _hash, ...rest }) => rest)(
          joinedPlayer as Record<string, unknown>,
        )
      : joinedPlayer;
  recordTelemetry('player_games', 1);
  return json({
    ok: true,
    roomId,
    roomCode: roomCode.trim().toUpperCase(),
    player,
    reconnectToken: joined['reconnectToken'],
    restored: joined['restored'],
  });
}

/**
 * POST /v1/rooms/:id/ws-ticket — single-use WS ticket (60 s TTL).
 * ISSUANCE-SIDE ONLY: the Worker mints the value and registers its HASH
 * with the DO. The Worker never validates a ticket against its own store.
 */
export async function handleWsTicket(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const playerId = asString(body['playerId']);
  const rawReconnect = asString(body['reconnectToken']);
  const purpose = body['purpose'] === 'renew' ? 'renew' : 'connect';
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!rawReconnect) return err('reconnectToken is required.', 400);
  const reconnectTokenHash = await hashReconnectToken(rawReconnect);
  const limited = await checkSeatLimit('POST /v1/rooms/:id/ws-ticket', roomId, reconnectTokenHash);
  if (limited) return limited;
  const ticket = newWsTicket();
  const registered = await callDo(ctx.env, roomId, 'register-ticket', {
    playerId,
    reconnectTokenHash,
    ticketId: ticket.ticketId,
    ticketHash: await hashTicketValue(ticket.ticket),
    purpose,
    expiresAtMs: ticket.expiresAtMs,
  });
  if (!registered.ok) return doError(registered);
  return json({
    ok: true,
    ticket: ticket.ticket,
    ticketId: ticket.ticketId,
    expiresAtMs: ticket.expiresAtMs,
  });
}

/** POST /v1/rooms/:id/ws-ticket/revoke — revoke WS tickets for a seat (DO count authoritative). */
export async function handleRevokeTicket(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const playerId = asString(body['playerId']);
  const rawReconnect = asString(body['reconnectToken']);
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!rawReconnect) return err('reconnectToken is required.', 400);
  const reconnectTokenHash = await hashReconnectToken(rawReconnect);
  const limited = await checkSeatLimit('POST /v1/rooms/:id/ws-ticket/revoke', roomId, reconnectTokenHash);
  if (limited) return limited;
  const revoked = await callDo(ctx.env, roomId, 'revoke-tickets', {
    playerId,
    reconnectTokenHash,
  });
  if (!revoked.ok) return doError(revoked);
  return json({ ok: true, revoked: revoked['revoked'] });
}

/**
 * GET /v1/rooms/:id?playerId=… — recipient-filtered room state.
 * Authorization: Bearer <reconnectToken> ONLY (P1-13). The query-string
 * `reconnectToken` fallback is removed — a token in the URL lands in
 * edge access logs. PlayerId alone 400s; a non-seat playerId 404s (IDOR
 * guard); a wrong token 403s.
 */
export async function handleGetState(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const url = new URL(req.url);
  const playerId = url.searchParams.get('playerId');
  const token = bearerToken(req);
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!token) return err('Authorization: Bearer <reconnectToken> is required.', 400);
  const reconnectTokenHash = await hashReconnectToken(token);
  const limited = await checkSeatLimit('GET /v1/rooms/:id', roomId, reconnectTokenHash);
  if (limited) return limited;
  const state = await callDo(ctx.env, roomId, 'get-state', {
    playerId,
    reconnectTokenHash,
  });
  if (!state.ok) return doError(state);
  return json({ ok: true, ...stripDoEnvelope(state) });
}

/** POST /v1/rooms/:id/start — host starts the match (host token; 409 if gate unmet). */
export async function handleStart(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const playerId = asString(body['playerId']);
  const rawHost = asString(body['hostToken']);
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!rawHost) return err('hostToken is required.', 400);
  const hostTokenHash = await hashHostToken(rawHost);
  const limited = await checkSeatLimit('POST /v1/rooms/:id/start', roomId, hostTokenHash);
  if (limited) return limited;
  const started = await callDo(ctx.env, roomId, 'start', {
    playerId,
    hostTokenHash,
  });
  if (!started.ok) return doError(started);
  return json({ ok: true, ...stripDoEnvelope(started) });
}

/** POST /v1/rooms/:id/config — host replaces the full lobby config (lobby only). */
export async function handleUpdateConfig(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const playerId = asString(body['playerId']);
  const rawHost = asString(body['hostToken']);
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!rawHost) return err('hostToken is required.', 400);
  if (typeof body['config'] !== 'object' || body['config'] === null) {
    return err('config is required.', 400);
  }
  // Phase 3 #7: validate ONCE, in the DO (updateConfig ->
  // validateRoomConfig). The Worker used to validate here too, so every
  // debounced keystroke paid for validation twice; the DO's check is
  // unchanged and still rejects a bad config with 400. (Create keeps its
  // Worker-side check: createRoom has no DO yet to validate in.)
  const hostTokenHash = await hashHostToken(rawHost);
  const limited = await checkSeatLimit('POST /v1/rooms/:id/config', roomId, hostTokenHash);
  if (limited) return limited;
  const updated = await callDo(ctx.env, roomId, 'update-config', {
    playerId,
    hostTokenHash,
    config: body['config'],
  });
  if (!updated.ok) return doError(updated);
  return json({ ok: true, room: updated['room'] });
}

/** POST /v1/rooms/:id/remove-player — host removes a lobby player (never the host). */
export async function handleRemovePlayer(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const playerId = asString(body['playerId']);
  const rawHost = asString(body['hostToken']);
  const targetPlayerId = asString(body['targetPlayerId']);
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!rawHost) return err('hostToken is required.', 400);
  if (!targetPlayerId) return err('targetPlayerId is required.', 400);
  if (!isUuid(targetPlayerId)) return badUuid('targetPlayerId');
  const hostTokenHash = await hashHostToken(rawHost);
  const limited = await checkSeatLimit('POST /v1/rooms/:id/remove-player', roomId, hostTokenHash);
  if (limited) return limited;
  const removed = await callDo(ctx.env, roomId, 'remove-player', {
    playerId,
    hostTokenHash,
    targetPlayerId,
  });
  if (!removed.ok) return doError(removed);
  return json({ ok: true, ...stripDoEnvelope(removed) });
}

/** POST /v1/rooms/:id/regenerate-code — host swaps the room code; old code dies at once. */
export async function handleRegenerateCode(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const playerId = asString(body['playerId']);
  const rawHost = asString(body['hostToken']);
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!rawHost) return err('hostToken is required.', 400);
  const hostTokenHash = await hashHostToken(rawHost);
  const limited = await checkSeatLimit('POST /v1/rooms/:id/regenerate-code', roomId, hostTokenHash);
  if (limited) return limited;
  // Verify-then-register (P2): the DO confirms host authority BEFORE the
  // new code is registered, so a failed host check never squats a code
  // (and a failure after registration leaves no orphan mapping — the
  // fresh code is unregistered below).
  const verified = await callDo(ctx.env, roomId, 'verify-host-token', {
    playerId,
    hostTokenHash,
  });
  if (!verified.ok) return doError(verified);
  const newCode = generateRoomCode();
  const reg = await callRegistry(ctx.env, 'register', { code: newCode, roomId });
  if (!reg.ok) {
    return reg.code === 'CONFLICT'
      ? err('Could not allocate a fresh code — try again.', 503)
      : err('Code registry unavailable — try again.', 503);
  }
  const swapped = await callDo(ctx.env, roomId, 'regenerate-code', {
    playerId,
    hostTokenHash,
    newCode,
  });
  if (!swapped.ok) {
    await callRegistry(ctx.env, 'unregister', { code: newCode, roomId });
    return doError(swapped);
  }
  const oldRoomCode = asString(swapped['oldRoomCode']);
  if (oldRoomCode) {
    await callRegistry(ctx.env, 'unregister', { code: oldRoomCode, roomId });
  }
  return json({ ok: true, roomCode: newCode, oldRoomCode });
}

/**
 * POST /v1/rooms/:id/host/token — mint / rotate the host token for the host seat.
 * The caller proves the SEAT with the reconnect token; the previous host
 * token for that seat dies on rotation. Raw token returned ONCE, never logged.
 */
export async function handleHostToken(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const playerId = asString(body['playerId']);
  const rawReconnect = asString(body['reconnectToken']);
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!rawReconnect) return err('reconnectToken is required.', 400);
  const reconnectTokenHash = await hashReconnectToken(rawReconnect);
  const limited = await checkSeatLimit('POST /v1/rooms/:id/host/token', roomId, reconnectTokenHash);
  if (limited) return limited;
  const minted = await callDo(ctx.env, roomId, 'issue-host-token', {
    playerId,
    reconnectTokenHash,
  });
  if (!minted.ok) return doError(minted);
  return json({ ok: true, hostToken: minted['hostToken'] });
}

/** POST /v1/rooms/:id/host/transfer — explicit host transfer (current host's token required). */
export async function handleHostTransfer(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const playerId = asString(body['playerId']);
  const rawHost = asString(body['hostToken']);
  const newHostPlayerId = asString(body['newHostPlayerId']);
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!rawHost) return err('hostToken is required.', 400);
  if (!newHostPlayerId) return err('newHostPlayerId is required.', 400);
  if (!isUuid(newHostPlayerId)) return badUuid('newHostPlayerId');
  const hostTokenHash = await hashHostToken(rawHost);
  const limited = await checkSeatLimit('POST /v1/rooms/:id/host/transfer', roomId, hostTokenHash);
  if (limited) return limited;
  const transferred = await callDo(ctx.env, roomId, 'transfer-host', {
    playerId,
    hostTokenHash,
    newHostPlayerId,
  });
  if (!transferred.ok) return doError(transferred);
  return json({ ok: true, ...stripDoEnvelope(transferred) });
}

/**
 * POST /v1/rooms/:id/catch-token — Runner fetches the raw one-time catch
 * token for their QR. The token is >= 128 bits, single-use, TTL 120 s
 * (OPEN), QR-only carriage — never typed, never shown as text.
 */
export async function handleCatchToken(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const playerId = asString(body['playerId']);
  const rawReconnect = asString(body['reconnectToken']);
  const catchId = asString(body['catchId']);
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!rawReconnect) return err('reconnectToken is required.', 400);
  if (!catchId) return err('catchId is required.', 400);
  if (!isUuid(catchId)) return badUuid('catchId');
  const reconnectTokenHash = await hashReconnectToken(rawReconnect);
  const limited = await checkSeatLimit('POST /v1/rooms/:id/catch-token', roomId, reconnectTokenHash);
  if (limited) return limited;
  const got = await callDo(ctx.env, roomId, 'get-catch-token', {
    playerId,
    reconnectTokenHash,
    catchId,
  });
  if (!got.ok) return doError(got);
  const token = asString(got['token']);
  if (token && !isValidCatchToken(token)) {
    return err('Catch token failed validation.', 500);
  }
  return json({ ok: true, ...stripDoEnvelope(got) });
}

/**
 * POST /v1/rooms/:id/catches/:cid/resolve — host resolves a disputed catch.
 * IMPLEMENTED (decided, not half-wired): 'confirmed' applies the mode rule
 * (Classic: Runner out; Infection: Runner flips to Hunter) and runs the win
 * check; 'rejected' voids the claim. The host's decision is final; a
 * disputed catch can never be re-confirmed by the Runner.
 */
export async function handleResolveCatch(
  req: Request,
  ctx: HttpContext,
  roomId: string,
  catchId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const playerId = asString(body['playerId']);
  const rawHost = asString(body['hostToken']);
  const decision = body['decision'];
  const reason = asString(body['reason']);
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!rawHost) return err('hostToken is required.', 400);
  if (!isUuid(catchId)) return badUuid('catchId');
  if (decision !== 'confirmed' && decision !== 'rejected') {
    return err("decision must be 'confirmed' or 'rejected'.", 400);
  }
  if (reason !== null && reason.length > 500) {
    return err('reason must be at most 500 characters.', 400);
  }
  const hostTokenHash = await hashHostToken(rawHost);
  const limited = await checkSeatLimit('POST /v1/rooms/:id/catches/:cid/resolve', roomId, hostTokenHash);
  if (limited) return limited;
  const resolved = await callDo(ctx.env, roomId, 'resolve-catch', {
    playerId,
    hostTokenHash,
    catchId,
    decision,
    ...(reason !== null ? { reason } : {}),
  });
  if (!resolved.ok) return doError(resolved);
  return json({ ok: true, ...stripDoEnvelope(resolved) });
}

/**
 * POST /v1/rooms/:id/lifecycle — server-only REST lifecycle.
 * start / resume / end are host-only (hostToken); pause is ANY player
 * (reconnectToken) — safety is not host-gated. The web app never calls this
 * (pause/resume go over WS); it exists for server-side control.
 */
export async function handleLifecycle(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const action = body['action'];
  const playerId = asString(body['playerId']);
  const rawHost = asString(body['hostToken']);
  const rawReconnect = asString(body['reconnectToken']);
  if (action !== 'start' && action !== 'pause' && action !== 'resume' && action !== 'end') {
    return err("action must be 'start', 'pause', 'resume' or 'end'.", 400);
  }
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!rawHost && !rawReconnect) {
    return err('hostToken or reconnectToken is required.', 400);
  }
  // Seat limit, keyed by whichever credential is presented (P1-14):
  // host token first, else the reconnect token.
  const hostTokenHash = rawHost ? await hashHostToken(rawHost) : null;
  const reconnectTokenHash = rawReconnect ? await hashReconnectToken(rawReconnect) : null;
  const limitHash = hostTokenHash ?? reconnectTokenHash;
  if (limitHash !== null) {
    const limited = await checkSeatLimit('POST /v1/rooms/:id/lifecycle', roomId, limitHash);
    if (limited) return limited;
  }
  const done = await callDo(ctx.env, roomId, 'lifecycle', {
    action,
    playerId,
    ...(hostTokenHash ? { hostTokenHash } : {}),
    ...(reconnectTokenHash ? { reconnectTokenHash } : {}),
  });
  if (!done.ok) return doError(done);
  return json({ ok: true, ...stripDoEnvelope(done) });
}

/** GET /v1/rooms/:id/results — match result, participant-only; 404 until a result exists. */
export async function handleResults(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const url = new URL(req.url);
  const playerId = url.searchParams.get('playerId');
  // Bearer only (P1-13) — no query-string reconnectToken fallback.
  const token = bearerToken(req);
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (!token) return err('Authorization: Bearer <reconnectToken> is required.', 400);
  const reconnectTokenHash = await hashReconnectToken(token);
  const limited = await checkSeatLimit('GET /v1/rooms/:id/results', roomId, reconnectTokenHash);
  if (limited) return limited;
  const results = await callDo(ctx.env, roomId, 'get-results', {
    playerId,
    reconnectTokenHash,
  });
  if (!results.ok) return doError(results);
  return json({ ok: true, ...stripDoEnvelope(results) });
}

// -- intake (server-only, Supabase best-effort) --------------------------------

/** POST /v1/reports — report/block intake, audit record ONLY (202). A 'block' does NOT remove or silence anyone. */
export async function handleReports(req: Request, ctx: HttpContext): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const roomId = asString(body['roomId']);
  const playerId = asString(body['playerId']);
  const targetPlayerId = asString(body['targetPlayerId']);
  const kind = body['kind'];
  if (!roomId) return err('roomId is required.', 400);
  if (!isUuid(roomId)) return badUuid('roomId');
  if (!playerId) return err('playerId is required.', 400);
  if (!isUuid(playerId)) return badUuid('playerId');
  if (targetPlayerId !== null && !isUuid(targetPlayerId)) return badUuid('targetPlayerId');
  if (kind !== 'report' && kind !== 'block') {
    return err("kind must be 'report' or 'block'.", 400);
  }
  // P1-15: unauthenticated intake is closed — the room must exist and
  // the reporter must be a member of it (the target too, when named).
  // No token is presented here, so this is membership existence, not
  // credential verification; the write stays an audit record only.
  const exists = await callDo(ctx.env, roomId, 'room-exists', {});
  if (!exists.ok || exists['exists'] !== true) {
    return err('No live room for that roomId.', 404);
  }
  const member = await callDo(ctx.env, roomId, 'check-member', { playerId });
  if (!member.ok || member['member'] !== true) {
    return err('The reporter is not a member of this room.', 403);
  }
  if (targetPlayerId !== null) {
    const targetMember = await callDo(ctx.env, roomId, 'check-member', { playerId: targetPlayerId });
    if (!targetMember.ok || targetMember['member'] !== true) {
      return err('The reported player is not a member of this room.', 403);
    }
  }
  ctx.ctx.waitUntil(
    persistReportAudit(ctx.env as SupabaseEnv, {
      roomId,
      playerId,
      targetPlayerId,
      kind,
    }),
  );
  return json({ ok: true }, 202);
}

/** POST /v1/support/bugs — bug intake, no location ever attached (202). */
export async function handleBugReport(req: Request, ctx: HttpContext): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const description = asString(body['description']);
  if (!description || description.trim().length === 0 || description.length > 5000) {
    return err('description must be 1–5000 characters.', 400);
  }
  // P2: free-text caps — deviceInfo / appVersion ≤ 500 chars each.
  const deviceInfo = asString(body['deviceInfo']);
  const appVersion = asString(body['appVersion']);
  if (deviceInfo !== null && deviceInfo.length > 500) {
    return err('deviceInfo must be at most 500 characters.', 400);
  }
  if (appVersion !== null && appVersion.length > 500) {
    return err('appVersion must be at most 500 characters.', 400);
  }
  // P1-15: a named room must exist (roomId is optional — a bug may be
  // filed without a room — but a present one is validated).
  const roomId = asString(body['roomId']);
  const playerId = asString(body['playerId']);
  if (roomId !== null && !isUuid(roomId)) return badUuid('roomId');
  if (playerId !== null && !isUuid(playerId)) return badUuid('playerId');
  if (roomId !== null) {
    const exists = await callDo(ctx.env, roomId, 'room-exists', {});
    if (!exists.ok || exists['exists'] !== true) {
      return err('No live room for that roomId.', 404);
    }
  }
  ctx.ctx.waitUntil(
    persistBugReport(ctx.env as SupabaseEnv, {
      roomId,
      playerId,
      deviceInfo,
      appVersion,
      description: description.trim(),
    }),
  );
  return json({ ok: true }, 202);
}

/** POST /v1/support/grievances — grievance intake, distinct from bugs (202). */
export async function handleGrievance(req: Request, ctx: HttpContext): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const summary = asString(body['summary']);
  const channel = asString(body['channel']) ?? 'in-app';
  if (!summary || summary.trim().length === 0 || summary.length > 5000) {
    return err('summary must be 1–5000 characters.', 400);
  }
  if (channel !== 'in-app' && channel !== 'email') {
    return err("channel must be 'in-app' or 'email'.", 400);
  }
  // P2: complainantRef ≤ 500 chars. (Grievances carry no room/player
  // fields, so no room validation applies here — see the P1-15 note in
  // the report.)
  const complainantRef = asString(body['complainantRef']);
  if (complainantRef !== null && complainantRef.length > 500) {
    return err('complainantRef must be at most 500 characters.', 400);
  }
  ctx.ctx.waitUntil(
    persistGrievance(ctx.env as SupabaseEnv, {
      complainantRef,
      channel,
      summary: summary.trim(),
    }),
  );
  return json({ ok: true }, 202);
}

// -- WS upgrade (Worker side) ---------------------------------------------------

/**
 * GET /v1/rooms/:id/ws?ticket=… — the WS upgrade path.
 *
 * The ticket VALUE arrives in the query string (the one sanctioned
 * exception to "never put a token in a URL"). The Worker hashes it and
 * forwards ONLY the hash to the DO, which validates + redeems atomically.
 * A missing/invalid ticket gets a real WS 4401 close frame, not an HTTP
 * 401 (an HTTP 401 surfaces to browsers as close 1006 and the client
 * mis-handles it).
 */
export async function handleWsUpgrade(
  req: Request,
  ctx: HttpContext,
  roomId: string,
): Promise<Response> {
  const url = new URL(req.url);
  const ticket = url.searchParams.get('ticket');
  if (!ticket) {
    return wsCloseResponse(4401, 'Missing ticket — fetch a fresh ticket and reconnect once.');
  }
  const ticketHash = await hashWsTicket(ticket);
  let doRes: Response;
  try {
    doRes = await doStub(ctx.env, roomId).fetch(
      new Request('http://room-do/ws', {
        headers: {
          Upgrade: 'websocket',
          'x-pakdam-ticket-hash': ticketHash,
        },
      }),
    );
  } catch {
    return wsCloseResponse(4401, 'Room service unavailable — fetch a fresh ticket and reconnect once.');
  }
  if (doRes.status !== 101) {
    let code = 4401;
    let reason = 'Ticket invalid — fetch a fresh ticket and reconnect once.';
    try {
      const data = (await doRes.json()) as { error?: string; code?: string };
      if (data.code === 'FORBIDDEN') {
        code = 4403;
        reason = 'Forbidden — this seat is no longer in the room.';
      } else if (typeof data.error === 'string' && data.error.length > 0) {
        reason = data.error;
      }
    } catch {
      // Keep the default 4401 wording.
    }
    return wsCloseResponse(code, reason);
  }
  return doRes;
}

/** Answer a WS handshake with a real close frame (101 + closing socket). */
export function wsCloseResponse(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const server = pair[1] as WebSocket;
  try {
    server.accept();
    server.close(code, reason);
  } catch {
    // If accept/close fails, the client still sees the 101 + close.
  }
  return new Response(null, { status: 101, webSocket: pair[0] });
}
