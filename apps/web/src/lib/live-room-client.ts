'use client';

/**
 * Live-room REST client — split out of lib/websocket.ts (recovery 2026-11-17).
 *
 * websocket.ts must keep ZERO runtime imports beyond type-only
 * @pakdam/shared imports: the engine ws-protocol test
 * (packages/engine/test/ws-protocol.test.ts) transpiles websocket.ts in
 * isolation and loads it from a `data:` URL in memory, so any value
 * import of ./demo-store, ./session-credentials or react there breaks
 * the test with ERR_MODULE_NOT_FOUND. Everything that needs those
 * imports lives here.
 * What lives here now (2026-11-18 cleanup): the live-room REST
 * helpers only — fetchLiveRoomState, fetchHostToken, startLiveMatch,
 * updateLiveRoomConfig, removeLivePlayer, regenerateLiveRoomCode,
 * resolveLiveCatch, fetchLiveCatchToken. The room page calls four of
 * them directly (app/room/[roomId]/page.tsx:19) and the reconnect
 * tests cover the rest (lib/__tests__/websocket-reconnect.test.ts).
 * The old LiveRoomClient class and useRoom() hook were deleted
 * 2026-11-18: no page ever called them — the room/play/catch/results
 * pages drive createLivePakdamSocket() from websocket.ts directly —
 * and neither did the deleted hooks/useLiveRoom.ts (the "ONE shared
 * live hook" that no page used). Do not re-add a wrapper hook or
 * client class here without wiring a page to it in the same change.
 */

// ===========================================================================
// LIVE ROOM WIRING (2026-11-17) — the PWA's primary path to the real
// Worker / Durable Object backend. The demo store (demo-store.ts) is
// ONLY the offline fallback now: it is used when no Worker URL is
// configured, or when a create/join hits a Worker that is UNREACHABLE
// (network failure, not a server error). A live session is NEVER
// silently downgraded to demo mid-room — once a room is live, the
// pages stay live and show the connection state instead.
//
// Rules enforced here, not just in comments:
//  - Rooms are created/joined over HTTPS (POST /v1/rooms, /join);
//    the raw reconnect token is returned ONCE and kept in
//    sessionStorage only (session-credentials.ts) — never localStorage,
//    never a URL, never logged.
//  - The DO is the SOLE authority: presence, match state, timers,
//    teams, ping distribution, catch confirmation, zone transitions,
//    completion. The client NEVER sets phase, roles, timers or
//    ejection locally in live mode — it applies the server snapshot
//    as the whole truth and patches only from server messages.
//  - Snapshots carry NO raw coordinates (HNT-068): a snapshot has
//    lastFixAt + locationQuality only. Ping areas (coarse, 150 m
//    radius) are the only coordinates a Hunter ever sees, and they
//    are drawn as areas — lat/lng numbers are never shown in the UI.
//  - Guest-only: no account, no login. Host powers come from the
//    host token (POST /host/token, minted with the host seat's
//    reconnect token; Worker 5, SEC-06) — never from the reconnect
//    token itself and never from a display name.
//  - No demo route, no catch code, Classic + Infection only (the
//    Worker validates the mode), outside-zone 30 s → ejection is
//    enforced by the DO alarm, not by the client.
// ===========================================================================

import { getSessionForRoom } from './session-credentials';
import type { Player, Room, RoomConfig } from '@pakdam/shared';

/** The Worker could not be reached at all (DNS / network / offline).
 *  Callers treat this as "use the offline demo fallback"; any HTTP
 *  status from the Worker is a real server answer, never this. */
export class WorkerUnreachableError extends Error {
  constructor(message = 'Worker unreachable') {
    super(message);
    this.name = 'WorkerUnreachableError';
  }
}

/** The Worker answered with an error status. `status` is the HTTP
 *  status; `message` is the server's plain-language error (or a
 *  status-based fallback) — never a token, ticket or coordinate. */
export class WorkerResponseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'WorkerResponseError';
    this.status = status;
  }
}

function isNetworkFailure(e: unknown): boolean {
  return e instanceof TypeError
    || (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'NetworkError');
}

async function workerFetch(apiUrl: string, path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, init);
  } catch (e) {
    if (isNetworkFailure(e)) throw new WorkerUnreachableError();
    throw e;
  }
  let body: unknown = null;
  try { body = await res.json() as unknown; } catch { body = null; }
  if (!res.ok) {
    const msg = typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>)['error'] === 'string'
      ? (body as Record<string, unknown>)['error'] as string
      : `The game server answered ${res.status} — try again.`;
    throw new WorkerResponseError(res.status, msg);
  }
  return body;
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** GET /v1/rooms/:id?playerId= — recipient-filtered lobby state
 *  (HNT-038: own role only in the lobby, no coordinates, no hashes).
 *  Used for the first paint before the socket connects; the WS
 *  snapshot supersedes it. Returns null when this seat is not in the
 *  room (404 — the DO's IDOR guard).
 *  Auth (Worker 5, SEC-06): a playerId alone no longer opens the
 *  room — the seat proves itself with the raw reconnect token as
 *  `Authorization: Bearer <token>` (the server also accepts
 *  `?reconnectToken=`, but it is never used here: tokens must not
 *  land in edge access logs). The token is the explicit 4th argument
 *  when the caller already holds it (a page that holds it passes
 *  it explicitly); otherwise it is read from the canonical session
 *  store (getSessionForRoom, session-credentials.ts). With no token
 *  available at all the call is sent unauthenticated and the Worker
 *  400s. */
export async function fetchLiveRoomState(
  apiUrl: string, roomId: string, playerId: string, reconnectToken?: string,
): Promise<{ room: Room; players: Player[]; version: number } | null> {
  const token = reconnectToken ?? getSessionForRoom(roomId)?.reconnectToken;
  const init: RequestInit | undefined = token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : undefined;
  try {
    const body = await workerFetch(apiUrl, `/v1/rooms/${roomId}?playerId=${encodeURIComponent(playerId)}`, init);
    return body as { room: Room; players: Player[]; version: number };
  } catch (e) {
    if (e instanceof WorkerResponseError && e.status === 404) return null;
    throw e;
  }
}

/** POST /v1/rooms/:id/host/token — mint (or rotate) the host token
 *  for the CURRENT host seat. The caller proves the seat with the raw
 *  reconnect token; the Worker returns the raw host token ONCE over
 *  HTTPS. Host-only actions (start, config, remove-player,
 *  catch-resolve, lifecycle) prove host authority with this token,
 *  never with the reconnect token (Worker 5, SEC-06). The create
 *  response also carries a hostToken and the create client stores
 *  it (live-client.ts `storeLiveSeat`) — this endpoint is the
 *  recovery path for a host seat that holds no stored token (join
 *  never returns one, a restored seat, or a successor host after a
 *  transfer). */
export async function fetchHostToken(
  apiUrl: string, roomId: string, playerId: string, reconnectToken: string,
): Promise<string> {
  const body = await workerFetch(apiUrl, `/v1/rooms/${roomId}/host/token`, jsonInit({ playerId, reconnectToken }));
  const token = (body as { hostToken?: unknown }).hostToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new WorkerResponseError(500, 'The game server did not return a host token.');
  }
  return token;
}

/** POST /v1/rooms/:id/start — host starts the match (DO enforces
 *  host-only, 3+ players, all ready, role assignment). Auth is the
 *  HOST token (Worker 5, SEC-06), not the reconnect token. */
export async function startLiveMatch(
  apiUrl: string, roomId: string, playerId: string, hostToken: string,
): Promise<{ phase: string; startedAt: string; endsAt: string }> {
  const body = await workerFetch(apiUrl, `/v1/rooms/${roomId}/start`, jsonInit({ playerId, hostToken }));
  return body as { phase: string; startedAt: string; endsAt: string };
}

/** POST /v1/rooms/:id/config — host changes the lobby settings.
 *  Auth is the HOST token (Worker 5, SEC-06). */
export async function updateLiveRoomConfig(
  apiUrl: string, roomId: string, playerId: string, hostToken: string, config: RoomConfig,
): Promise<Room> {
  const body = await workerFetch(apiUrl, `/v1/rooms/${roomId}/config`, jsonInit({ playerId, hostToken, config }));
  return (body as { room: Room }).room;
}

/** POST /v1/rooms/:id/remove-player — host removes a lobby player.
 *  Auth is the HOST token (Worker 5, SEC-06). */
export async function removeLivePlayer(
  apiUrl: string, roomId: string, playerId: string, hostToken: string, targetPlayerId: string,
): Promise<void> {
  await workerFetch(apiUrl, `/v1/rooms/${roomId}/remove-player`, jsonInit({ playerId, hostToken, targetPlayerId }));
}

/** POST /v1/rooms/:id/regenerate-code — host regenerates the room
 *  code (D-M2). Auth is the HOST token (Worker 5, SEC-06). The server
 *  generates the fresh code, so the client never picks one. Answers
 *  `{ ok, roomCode, oldRoomCode }` — the old code is dead from that
 *  moment, the new code is the one to share. */
export async function regenerateLiveRoomCode(
  apiUrl: string, roomId: string, playerId: string, hostToken: string,
): Promise<{ roomCode: string; oldRoomCode: string }> {
  const body = await workerFetch(apiUrl, `/v1/rooms/${roomId}/regenerate-code`, jsonInit({ playerId, hostToken }));
  const roomCode = (body as { roomCode?: unknown }).roomCode;
  const oldRoomCode = (body as { oldRoomCode?: unknown }).oldRoomCode;
  if (typeof roomCode !== 'string' || roomCode.length === 0
    || typeof oldRoomCode !== 'string' || oldRoomCode.length === 0) {
    throw new WorkerResponseError(500, 'The game server did not return a new room code.');
  }
  return { roomCode, oldRoomCode };
}

/** POST /v1/rooms/:id/catches/:cid/resolve — host resolves a
 *  DISPUTED catch (Worker 5). decision 'confirmed' applies the mode
 *  rule; 'rejected' voids the claim. Auth is the HOST token. */
export async function resolveLiveCatch(
  apiUrl: string, roomId: string, playerId: string, hostToken: string,
  catchId: string, decision: 'confirmed' | 'rejected',
): Promise<void> {
  await workerFetch(apiUrl, `/v1/rooms/${roomId}/catches/${catchId}/resolve`, jsonInit({
    playerId, hostToken, decision, reason: `Host resolved the dispute in person — ${decision}.`,
  }));
}

/** POST /v1/rooms/:id/catch-token — the RUNNER fetches the raw
 *  one-time catch token for an open catch, to show as a QR. The token
 *  is returned once over HTTPS and never logged; it is NOT stored in
 *  the client beyond the QR on screen. */
export async function fetchLiveCatchToken(
  apiUrl: string, roomId: string, playerId: string, reconnectToken: string, catchId: string,
): Promise<string> {
  const body = await workerFetch(apiUrl, `/v1/rooms/${roomId}/catch-token`, jsonInit({ playerId, reconnectToken, catchId }));
  return (body as { token: string }).token;
}
