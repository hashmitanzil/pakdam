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
 * request/confirm/self-confirm/dispute, safety pause/resume (WS), leave.
 * Do not add REST twins. No leaderboard route exists.
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
import { isReconnectHashBlocked } from './admin-db.js';
import { getRuntimeFlags } from './admin-flags.js';
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
 *
 * v34 (Diya R3-N1) — verify-then-limit (SUPERSEDES the v18 F5 /
 * v23 S5 / v34 Zara 10b seat-keyed pre-auth bucket): keying the
 * pre-auth bucket by room + seat let ANY room member burn the HOST's
 * bucket — playerIds are in every snapshot, so 5 unauthenticated
 * `start` calls with the host's playerId 429'd the host's real Start
 * for up to 60 s. The seat bucket is now touched ONLY after the DO
 * has verified the credential (`verifyHostThenLimit` /
 * `verifySeatThenLimit` below): an unverified attempt never consumes
 * the victim's budget, and a verified holder still gets the same
 * per-seat limit as before. The pre-auth bucket that remains is
 * keyed per PRESENTED credential (`preAuthKey`), so hammering with
 * one (stale/leaked) credential is still throttled; rotating
 * credentials get fresh pre-auth buckets — accepted, because host /
 * reconnect tokens are 128-bit and guessing is infeasible, and the
 * DO verify still refuses each attempt. The old F5 tests that pinned
 * "rotating guessed tokens share one bucket" (v18 F5, v23 T6, Zara
 * 10b) were re-pinned to this design; see those tests.
 */
const seatLimiter = new HttpRateLimiter();

/**
 * v34 (Diya R3-N1) — the seat bucket is keyed by room+seat
 * (`seatKey(roomId, playerId)`) and is touched ONLY by a verified
 * holder (see `verifyHostThenLimit` / `verifySeatThenLimit` below).
 * Seat routes keyed by a presented RECONNECT hash (ws-ticket,
 * get-state, results, catch-token) keep their hash key — the
 * reconnect token is the seat credential itself, and ws-ticket
 * issue/revoke carry a second DO-enforced window. Those routes are
 * NOT vulnerable to R3-N1: an attacker who does not know the
 * victim's token hash cannot address the victim's bucket at all.
 */
async function checkSeatLimit(
  routeKey: string,
  roomId: string,
  tokenHash: string,
  bucketKey: string = seatKey(roomId, tokenHash),
): Promise<Response | null> {
  const check = seatLimiter.check(routeKey, bucketKey);
  if (check.allowed) return null;
  const res = err('Too many tries — slow down.', 429);
  const headers = new Headers(res.headers);
  headers.set('Retry-After', String(check.retryAfterSeconds));
  return new Response(res.body, { status: 429, headers });
}

/**
 * v34 (Diya R3-N1) — pre-auth bucket key: room + seat + the PRESENTED
 * credential hash. An unauthenticated caller chooses the playerId in
 * the body, so no pre-auth key may be addressable by playerId alone —
 * otherwise the caller burns the victim seat's budget (the R3-N1
 * hole). Binding the key to the presented credential means a forged
 * attempt consumes only its own credential's budget, never the host's
 * seat bucket; the host's real token has its own pre-auth bucket.
 * The `preauth:` prefix keeps these keys out of the seat-bucket
 * namespace (`roomId:playerId`) entirely.
 */
function preAuthKey(roomId: string, playerId: string, tokenHash: string): string {
  return `preauth:${roomId}:${playerId}:${tokenHash}`;
}

/**
 * v34 (Diya R3-N1) — verify-then-limit for host-token routes.
 * Order matters, and each stage has a different job:
 *   1. Pre-auth bucket (per presented credential, route limit):
 *      throttles hammering with ONE credential (stale/leaked token,
 *      buggy retry loop). Rotating credentials get fresh buckets —
 *      accepted (128-bit tokens; guessing is infeasible).
 *   2. DO `verify-host-token`: the credential is proven BEFORE the
 *      seat bucket is touched, so an unverified attempt can never
 *      consume the host's budget. A failed verify 403s here and the
 *      real op is never called.
 *   3. Seat bucket (room+seat, route limit): the real per-seat limit,
 *      consumable only by a verified holder — and it still binds
 *      across token rotations by that holder (a fresh host token gets
 *      a fresh pre-auth bucket but the SAME seat bucket).
 * Returns a 429 / 403 Response when the call must stop, else null.
 */
async function verifyHostThenLimit(
  ctx: HttpContext,
  routeKey: string,
  roomId: string,
  playerId: string,
  hostTokenHash: string,
): Promise<Response | null> {
  const preAuth = await checkSeatLimit(routeKey, roomId, hostTokenHash, preAuthKey(roomId, playerId, hostTokenHash));
  if (preAuth) return preAuth;
  const verified = await callDo(ctx.env, roomId, 'verify-host-token', {
    playerId,
    hostTokenHash,
  });
  if (!verified.ok) return doError(verified);
  if (verified['valid'] !== true) {
    return err('Only the host can do that.', 403, undefined, 'FORBIDDEN');
  }
  return checkSeatLimit(routeKey, roomId, hostTokenHash, seatKey(roomId, playerId));
}

/**
 * v34 (Diya R3-N1) — verify-then-limit for reconnect-proven routes
 * (`host/token` mint/rotate, lifecycle `pause`). Same three stages
 * as `verifyHostThenLimit`, but the credential proven in the DO is
 * the seat's reconnect token (`verify-reconnect`), not the host
 * token — a forged reconnect token must not burn the seat's budget
 * either.
 */
async function verifySeatThenLimit(
  ctx: HttpContext,
  routeKey: string,
  roomId: string,
  playerId: string,
  reconnectTokenHash: string,
): Promise<Response | null> {
  const preAuth = await checkSeatLimit(routeKey, roomId, reconnectTokenHash, preAuthKey(roomId, playerId, reconnectTokenHash));
  if (preAuth) return preAuth;
  const verified = await callDo(ctx.env, roomId, 'verify-reconnect', {
    playerId,
    reconnectTokenHash,
  });
  if (!verified.ok) return doError(verified);
  if (verified['valid'] !== true) {
    return err('Seat not found or reconnect token does not match.', 403, undefined, 'FORBIDDEN');
  }
  return checkSeatLimit(routeKey, roomId, reconnectTokenHash, seatKey(roomId, playerId));
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

/**
 * v29 (Gap 4) — the HTTP error envelope now carries an optional `code`
 * alongside `error`: `{ error, code }`. Additive — existing clients
 * read `error` only and ignore the extra field. `doError` passes the
 * DO's code through instead of dropping it, so a client can branch on
 * RATE_LIMITED / FORBIDDEN / ROOM_NOT_FOUND without parsing text.
 * No new codes are introduced by this change.
 *
 * v34 (delivery gate, zero-break bar) — `code` now defaults from the
 * status, so EVERY error envelope carries a code the client can
 * surface. A caller may still pass an explicit code to override the
 * default (e.g. a 400 that is really a RATE_LIMITED is never
 * mislabelled by the default). Previously `err()` without a code
 * produced a codeless `{ error }` body — parse errors included — so
 * a client branching on `code` saw nothing.
 */
const DEFAULT_ERROR_CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'BODY_TOO_LARGE',
  429: 'RATE_LIMITED',
  500: 'SERVER_ERROR',
  502: 'SERVER_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

export function err(message: string, status: number, issues?: string[], code?: string): Response {
  const body: Record<string, unknown> =
    issues ? { error: message, issues } : { error: message };
  body['code'] = code ?? DEFAULT_ERROR_CODE_BY_STATUS[status] ?? 'SERVER_ERROR';
  return json(body, status);
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
    return { ok: false, response: err('Body too large (max 1 MB).', 413) };
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

// Fix round n9: DO_OP_SECRET unset is fail-LOUD, not silent. The DO
// is only reachable through this Worker's binding (never the public
// internet), so an unset secret cannot be exploited remotely — but it
// removes the defense-in-depth check on the /op channel, and the
// founder must know. Logged once per isolate (ERROR, not warn) and
// surfaced in the admin overview (secretsConfigured.doOpSecret).
// Unlike the admin session secret, the Worker CANNOT refuse here:
// refusing /op calls would break the entire game. The control is
// the loud log + the health signal + the deploy checklist.
let doOpSecretWarned = false;

function warnDoOpSecretUnset(): void {
  if (doOpSecretWarned) return;
  doOpSecretWarned = true;
  console.error(
    'DO_OP_SECRET is not set — Worker<->DO /op calls carry no shared secret (the DO skips its check in dev). Set it (wrangler secret put DO_OP_SECRET). The DO is only reachable via this Worker, so this is defense-in-depth, not a public hole — but do not ship without it.',
  );
}

/** Call one DO op; maps DO failures onto HTTP errors. Exported for the admin handlers (workers/src/admin.ts). */
export async function callDo(
  env: Env,
  roomId: string,
  op: string,
  payload: Record<string, unknown>,
): Promise<DoResponse> {
  if (!env.DO_OP_SECRET) warnDoOpSecretUnset();
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
  // Fix round 5 (M3-1): the DO's op-error bodies carry `code` but
  // NO `status` field (room-do-class.ts:1261 — status is HTTP-only),
  // and `callDo` never read `res.status`, so `doError` mapped every
  // such failure through its default branch to 400 — a real HTTP 503
  // from the DO answered 400. Propagate the HTTP status into the
  // returned object when the body lacks a numeric status — never
  // overriding a body status that is present. Only for non-success
  // bodies with an error HTTP status: success bodies carry no status
  // today and no caller reads one off a success (they stay
  // byte-identical), and an HTTP-200 envelope around an ok:false
  // body must never become a status (`doError` would answer 200 for
  // an error — the real DO never 200-envelopes errors, so the guard
  // only ever filters stub-shaped replies).
  if (data.ok !== true && typeof data.status !== 'number' && res.status >= 400) {
    return { ...data, status: res.status };
  }
  return data;
}

/**
 * v29 (Gap 4) — read the `Idempotency-Key` request header for POST
 * routes and forward it into the DO op payload. A key is an
 * opaque client-minted token (max 64 chars, non-empty); an absent or
 * over-long header means "no key" — the op executes normally with no
 * caching (never an error). Keys are minted once per user action by
 * the client; the server mints nothing (no Date.now() in key
 * generation — a fresh key per retry would defeat dedupe).
 */
export function idempotencyKeyFromRequest(req: Request): string | null {
  const raw = req.headers.get('Idempotency-Key');
  if (raw === null) return null;
  const key = raw.trim();
  if (key.length === 0 || key.length > 64) return null;
  return key;
}

async function callRegistry(
  env: Env,
  op: string,
  payload: Record<string, unknown>,
): Promise<DoResponse> {
  if (!env.DO_OP_SECRET) warnDoOpSecretUnset();
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

/** Turn a DO failure into an HTTP error response. Exported for the admin handlers. A DO rate limit carries
 * `Retry-After` (seconds) so the client backs off the same way it does for
 * the Worker-side limiter. */
export function doError(r: DoResponse): Response {
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
  // v29 (Gap 4) — pass the DO code through into the envelope
  // instead of dropping it (additive; existing clients read `error`).
  const res = err(r.error ?? 'Room operation failed.', status, undefined, r.code);
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
/**
 * v34 (Diya R2-10) — per-leg server timings for the join/create legs.
 * The founder's repro ("guest join is slow, host is fast") was never
 * measured per leg: the join ticket removed one leg (POST ws-ticket)
 * but nothing said which leg was slow. Each join/create response now
 * carries `serverTimings` — the Worker-side milliseconds per leg
 * (registry lookup, DO call, handler total) — so the client can log
 * which leg is slow on a real phone. Server-side only: the client
 * still owns the network + first-paint legs (socket connect, snapshot
 * fetch), which no server timing can see. Timings are rounded whole
 * ms; a leg that did not run is omitted, never zero-filled.
 */
function legTimings(startedAtMs: number, legs: Record<string, number>): Record<string, number> {
  return { ...legs, totalMs: Math.max(0, Math.round(performance.now() - startedAtMs)) };
}

export async function handleCreateRoom(req: Request, ctx: HttpContext): Promise<Response> {
  const startedAtMs = performance.now();
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
  let registryMs = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    roomCode = generateRoomCode();
    const regStartedAtMs = performance.now();
    const reg = await callRegistry(ctx.env, 'register', { code: roomCode, roomId });
    registryMs += performance.now() - regStartedAtMs;
    if (reg.ok) {
      registered = true;
      break;
    }
    if (reg.code === 'CONFLICT') continue;
    return err('Code registry unavailable — try again.', 503);
  }
  if (!registered || !roomCode) return err('Could not allocate a room code — try again.', 503);

  const doStartedAtMs = performance.now();
  const created = await callDo(ctx.env, roomId, 'create', {
    roomId,
    roomCode,
    hostPlayerId,
    displayName: displayName.trim(),
    config: config as RoomConfig,
    reconnectTokenHash: await hashReconnectToken(reconnectToken),
    hostTokenHash: await hashHostToken(hostToken),
  });
  const doMs = Math.round(performance.now() - doStartedAtMs);
  if (!created.ok) {
    // Roll the code registration back so the code can be reused.
    await callRegistry(ctx.env, 'unregister', { code: roomCode, roomId });
    return doError(created);
  }
  recordTelemetry('player_games', 1);
  return json(
    { ok: true, roomId, roomCode, hostPlayerId, reconnectToken, hostToken,
      // v34 (slow entry) — join-time WS ticket minted by the DO at
      // create (see `mintJoinTicket`): the setup page's first socket
      // connect spends it instead of POSTing ws-ticket. Absent only
      // when the best-effort mint failed — the client falls back.
      ...(created['wsTicket'] !== undefined ? { wsTicket: created['wsTicket'] } : {}),
      // v34 (Diya R2-10) — per-leg server timings (see `legTimings`).
      serverTimings: legTimings(startedAtMs, {
        registryMs: Math.round(registryMs),
        doMs,
      }),
    },
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
  const startedAtMs = performance.now();
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
  // Admin console (Mission Control): a seat whose reconnect-token
  // hash is blocked (ban/suspend) cannot rejoin with that token.
  // A fresh join with no token cannot be matched to a block — there
  // is no device key in the game today; see docs/admin-console.md.
  if (rawReconnect) {
    const blocked = await isReconnectHashBlocked(ctx.env, await hashReconnectToken(rawReconnect));
    if (blocked) {
      return err('This player is blocked.', 403, undefined, 'FORBIDDEN');
    }
  }
  const doStartedAtMs = performance.now();
  const joined = await callDo(ctx.env, roomId, 'add-player', {
    displayName: displayName.trim(),
    roomCode,
    reconnectTokenHash: rawReconnect ? await hashReconnectToken(rawReconnect) : null,
    // v29 (Gap 4) — HTTP idempotency: a retried join with the same key
    // returns the cached reply, including the ORIGINAL reconnectToken.
    idempotencyKey: idempotencyKeyFromRequest(req),
  });
  const doMs = Math.round(performance.now() - doStartedAtMs);
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
    // v34 (slow entry) — join-time WS ticket minted by the DO at
    // add-player (see `mintJoinTicket`): the room page's first socket
    // connect spends it instead of POSTing ws-ticket. Absent only when
    // the best-effort mint failed — the client falls back.
    ...(joined['wsTicket'] !== undefined ? { wsTicket: joined['wsTicket'] } : {}),
    // v34 (Diya R2-10) — per-leg server timings (see `legTimings`).
    serverTimings: legTimings(startedAtMs, { doMs }),
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
  const startedAtMs = performance.now();
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
  const registryStartedAtMs = performance.now();
  const found = await callRegistry(ctx.env, 'lookup', { code: roomCode.trim().toUpperCase() });
  const registryMs = Math.round(performance.now() - registryStartedAtMs);
  if (!found.ok) {
    return err('No live room for that code.', 404);
  }
  const roomId = found['roomId'] as string;
  const rawReconnect = asString(body['reconnectToken']);
  // Admin console: same block gate as handleJoin (see there).
  if (rawReconnect) {
    const blocked = await isReconnectHashBlocked(ctx.env, await hashReconnectToken(rawReconnect));
    if (blocked) {
      return err('This player is blocked.', 403, undefined, 'FORBIDDEN');
    }
  }
  const doStartedAtMs = performance.now();
  const joined = await callDo(ctx.env, roomId, 'add-player', {
    displayName: displayName.trim(),
    roomCode: roomCode.trim().toUpperCase(),
    reconnectTokenHash: rawReconnect ? await hashReconnectToken(rawReconnect) : null,
    // v29 (Gap 4) — same as handleJoin.
    idempotencyKey: idempotencyKeyFromRequest(req),
  });
  const doMs = Math.round(performance.now() - doStartedAtMs);
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
    // v34 (slow entry) — join-time WS ticket, same as handleJoin.
    ...(joined['wsTicket'] !== undefined ? { wsTicket: joined['wsTicket'] } : {}),
    // v34 (Diya R2-10) — per-leg server timings (see `legTimings`).
    serverTimings: legTimings(startedAtMs, { registryMs, doMs }),
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

/** POST /v1/rooms/:id/replay — v18: host resets a FINISHED room to LOBBY (same room/code, fresh game). */
export async function handleReplay(
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
  // v34 (Diya R3-N1) — verify-then-limit: the DO proves the host
  // token BEFORE the seat bucket is touched, so forged attempts with
  // the host's playerId cannot burn the host's budget.
  const limited = await verifyHostThenLimit(ctx, 'POST /v1/rooms/:id/replay', roomId, playerId, hostTokenHash);
  if (limited) return limited;
  const replayed = await callDo(ctx.env, roomId, 'replay', {
    playerId,
    hostTokenHash,
    // v29 (Gap 4) — HTTP idempotency (phase 2: start/replay).
    idempotencyKey: idempotencyKeyFromRequest(req),
  });
  if (!replayed.ok) return doError(replayed);
  return json({ ok: true, ...stripDoEnvelope(replayed) });
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
  // Admin console (Mission Control): the `gameStart` feature flag is
  // consulted server-side at runtime, BEFORE any DO work. When OFF,
  // no new match may start; games already running are untouched.
  // The flag read is cached 60 s and fails OPEN to ON, so a Supabase
  // outage cannot block starts. Order matters (merge, 2026-11-27):
  // v34's verify-then-limit below calls the DO, so the kill-switch
  // must come first — otherwise a switched-off game still touches
  // the DO (and during a DO outage answers the wrong 503).
  const flags = await getRuntimeFlags(ctx.env);
  if (flags['gameStart'] === false) {
    return err('New games are turned off by the admin.', 503, undefined, 'FEATURE_DISABLED');
  }
  // v34 (Diya R3-N1) — verify-then-limit (see `verifyHostThenLimit`).
  const limited = await verifyHostThenLimit(ctx, 'POST /v1/rooms/:id/start', roomId, playerId, hostTokenHash);
  if (limited) return limited;
  const started = await callDo(ctx.env, roomId, 'start', {
    playerId,
    hostTokenHash,
    // v29 (Gap 4) — HTTP idempotency (phase 2: start/replay).
    idempotencyKey: idempotencyKeyFromRequest(req),
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
  // v34 (Diya R3-N1) — verify-then-limit (see `verifyHostThenLimit`).
  const limited = await verifyHostThenLimit(ctx, 'POST /v1/rooms/:id/config', roomId, playerId, hostTokenHash);
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
  // v34 (Diya R3-N1) — verify-then-limit (see `verifyHostThenLimit`).
  const limited = await verifyHostThenLimit(ctx, 'POST /v1/rooms/:id/remove-player', roomId, playerId, hostTokenHash);
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
  // v34 (Diya R3-N1) — verify-then-limit (see `verifyHostThenLimit`).
  // The verify here ALSO serves the old verify-then-register (P2):
  // host authority is confirmed BEFORE the new code is registered,
  // so a failed host check never squats a code (and a failure after
  // registration leaves no orphan mapping — the fresh code is
  // unregistered below).
  const limited = await verifyHostThenLimit(ctx, 'POST /v1/rooms/:id/regenerate-code', roomId, playerId, hostTokenHash);
  if (limited) return limited;
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
  // v34 (Diya R3-N1) — verify-then-limit on the RECONNECT credential
  // (see `verifySeatThenLimit`): a forged reconnect token must not
  // burn this seat's host/token budget.
  const limited = await verifySeatThenLimit(ctx, 'POST /v1/rooms/:id/host/token', roomId, playerId, reconnectTokenHash);
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
  // v34 (Diya R3-N1) — verify-then-limit (see `verifyHostThenLimit`).
  const limited = await verifyHostThenLimit(ctx, 'POST /v1/rooms/:id/host/transfer', roomId, playerId, hostTokenHash);
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
  // v34 (Diya R3-N1) — verify-then-limit (see `verifyHostThenLimit`).
  const limited = await verifyHostThenLimit(ctx, 'POST /v1/rooms/:id/catches/:cid/resolve', roomId, playerId, hostTokenHash);
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
 * `start` is refused with 503 FEATURE_DISABLED while the admin
 * `gameStart` kill-switch is OFF — same consult as handleStart, so
 * the lifecycle route cannot bypass it.
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
  // Admin console (Mission Control): the `gameStart` feature flag is
  // consulted server-side at runtime, BEFORE any DO work — same
  // kill-switch as handleStart (fix round, 2026-11-27: lifecycle
  // start used to bypass it entirely). Only `start` is gated;
  // pause/resume/end must keep working while new games are off.
  // The flag read is cached 60 s and fails OPEN to ON, so a Supabase
  // outage cannot block starts.
  if (action === 'start') {
    const flags = await getRuntimeFlags(ctx.env);
    if (flags['gameStart'] === false) {
      return err('New games are turned off by the admin.', 503, undefined, 'FEATURE_DISABLED');
    }
  }
  // v34 (Diya R3-N1) — verify-then-limit. Host actions (start /
  // resume / end) prove the HOST token; pause proves the RECONNECT
  // token (safety is not host-gated). Either way the credential is
  // proven in the DO before the seat bucket is touched, so a forged
  // call with the host's playerId cannot burn the host's budget.
  const hostTokenHash = rawHost ? await hashHostToken(rawHost) : null;
  const reconnectTokenHash = rawReconnect ? await hashReconnectToken(rawReconnect) : null;
  const limited = hostTokenHash !== null
    ? await verifyHostThenLimit(ctx, 'POST /v1/rooms/:id/lifecycle', roomId, playerId, hostTokenHash)
    : await verifySeatThenLimit(ctx, 'POST /v1/rooms/:id/lifecycle', roomId, playerId, reconnectTokenHash ?? '');
  if (limited) return limited;
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
      if (data.code === 'ROOM_NOT_FOUND') {
        // v31 (FIX 1) — room truly gone is NOT a ticket problem: a
        // distinct close code so the client can tell "room gone, go
        // home" from "ticket invalid, retry once" (4401) and "seat
        // removed" (4403). The DO answers ROOM_NOT_FOUND both when no
        // room exists for the id and when the room was host-deleted.
        // See WS_CLOSE_CODE_ACTION[4404] (do-not-reconnect).
        code = 4404;
        reason = 'Room not found — the game has ended.';
      } else if (data.code === 'FORBIDDEN') {
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
