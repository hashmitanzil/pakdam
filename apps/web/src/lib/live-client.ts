/**
 * Live HTTPS client — create / join over the deployed Worker (2026-11-17).
 *
 * NOTE — what changed on the pages, and what did NOT:
 * - When `NEXT_PUBLIC_WORKER_URL` is set, Create now calls
 *   POST /v1/rooms on the Worker and stores the host + reconnect
 *   tokens in sessionStorage (see session-credentials.ts). The lobby
 *   page itself still reads the demo store, so a live-created room
 *   will not render there until the room page is wired to live state
 *   (a later worker's job — this file only owns transport + create/join).
 * - Join by 6-letter code goes live via GET /v1/rooms/by-code/:code
 *   (`resolveRoomByCode` below): the Worker resolves the code to the
 *   roomId, and the join pages call it before `joinLiveRoom`. Demo
 *   and live state are never mixed in one room. `joinLiveRoom` also
 *   still works for any caller that already knows the roomId (e.g.
 *   an invite link carrying `?room=<roomId>`).
 * - Host identity: the Worker mints a SEPARATE host token at create
 *   (POST /v1/rooms 201 `{ ..., reconnectToken, hostToken }`,
 *   workers/src/index.ts `handleCreateRoom`) — it is NOT the
 *   reconnect token. Only its hash lives in the DO
 *   (`RoomDoState.hostTokens`, workers/src/room-do.ts); the raw value
 *   is returned ONCE in the 201 and must be stored as `hostToken`,
 *   separate from `reconnectToken`. Host actions (start, config,
 *   remove-player, resolve-catch, lifecycle start/resume/end,
 *   transfer) prove host authority with the host token, never with
 *   the reconnect token. `isLiveHost()` checks the stored host
 *   token, never the display name. A host seat that lost its host
 *   token recovers one via POST /v1/rooms/:id/host/token, proving
 *   the seat with its reconnect token (see live-room-client.ts
 *   `fetchHostToken` — that recovery path exists because the create
 *   client used to drop the 201 host token; it no longer does).
 * - Restored seats: rejoining with a known display name returns an
 *   EMPTY reconnect token from the Worker (room-do.ts `addPlayer`
 *   restore path). `saveLiveSession` keeps the previously stored
 *   token in that case; this client never overwrites a good token
 *   with an empty one. And the restore itself only happens when the
 *   client presents the seat's reconnect token (room-do.ts SEC-06:
 *   a restore without a matching token throws FORBIDDEN) —
 *   `joinLiveRoom` therefore forwards the stored reconnect token
 *   when this tab already holds a session for the room under the
 *   same display name.
 * - No lat/lng is ever sent by this client except inside the room
 *   config the host already built on the create page (zone centre);
 *   nothing here puts coordinates in the UI. Guest only, Classic +
 *   Infection only, no payment — enforced by the create-page draft
 *   and the server's `roomConfigSchema`, not re-checked here.
 * - No invented URLs: every path below is read from workers/src
 *   (http.ts schemas, index.ts routes). The base URL comes only
 *   from `getWorkerUrl()` — never a guessed default.
 */
import type { Player, RoomConfig } from '@pakdam/shared';
import {
  createLivePakdamSocket, getWorkerUrl, isLiveTransportEnabled,
} from './websocket';
import type {
  PakdamSocket, PakdamSocketCallbacks,
} from './websocket';
import { getSessionForRoom, saveLiveSession } from './session-credentials';

/** True when a Worker URL is configured — the single live/demo switch. */
export function isLiveEnabled(): boolean {
  return isLiveTransportEnabled();
}

/** An error from the live server, already in plain words for the UI.
 *  `status` is kept for callers that branch on it; the message is
 *  what the player sees. */
export class LiveApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LiveApiError';
    this.status = status;
  }
}

function plainMessageForStatus(status: number, fallback: string): string {
  switch (status) {
    case 400:
      return 'The game setup was not accepted by the server. Check the settings and try again.';
    case 403:
      return 'That room code does not match this game. Check the code with your host.';
    case 404:
      return 'That game could not be found on the server. It may have ended, or the link may be wrong.';
    case 409:
      return 'That game is full or no longer open for joining.';
    case 429:
      return 'Too many tries — wait a minute and try again.';
    default:
      return fallback;
  }
}

async function postJson<T>(path: string, body: unknown, fallback: string): Promise<T> {
  const apiUrl = getWorkerUrl();
  if (!apiUrl) throw new LiveApiError('Live play is not set up — no game server address is configured.');
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new LiveApiError('Could not reach the game server. Check your connection and try again.');
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json() as unknown;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    // The Worker answers `{ error: '...' }` (or `{ error, issues }`
    // for a bad body) — the wording is the server's, so the UI gets
    // the plain-words mapping above, not the raw string.
    throw new LiveApiError(plainMessageForStatus(res.status, fallback), res.status);
  }
  // The Worker answers flat (`{ ok, ... }`); tolerate a `data`
  // wrapper the way fetchWsTicket does, but require the fields below.
  const data = (parsed !== null && typeof parsed === 'object' && 'data' in parsed
    ? (parsed as { data: unknown }).data : parsed) as Record<string, unknown> | null;
  if (data === null || typeof data !== 'object') {
    throw new LiveApiError('The game server gave an unexpected reply. Try again.');
  }
  return data as unknown as T;
}

/** GET twin of postJson: same plain-words error mapping, no body.
 *  The Worker answers `{ error: '...' }` on failure; `res.ok === false`
 *  throws a LiveApiError carrying the status, so callers that branch
 *  on it (via plainMessageForStatus) get the right player-facing
 *  wording — 404 → "That game could not be found…", 429 → "Too many
 *  tries…". */
async function getJson<T>(path: string, fallback: string): Promise<T> {
  const apiUrl = getWorkerUrl();
  if (!apiUrl) throw new LiveApiError('Live play is not set up — no game server address is configured.');
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, { method: 'GET' });
  } catch {
    throw new LiveApiError('Could not reach the game server. Check your connection and try again.');
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json() as unknown;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    throw new LiveApiError(plainMessageForStatus(res.status, fallback), res.status);
  }
  const data = (parsed !== null && typeof parsed === 'object' && 'data' in parsed
    ? (parsed as { data: unknown }).data : parsed) as Record<string, unknown> | null;
  if (data === null || typeof data !== 'object') {
    throw new LiveApiError('The game server gave an unexpected reply. Try again.');
  }
  return data as unknown as T;
}

export interface LiveRoomLookupResult {
  roomId: string;
  roomCode: string;
}

/** Resolve a 6-letter invite code to its roomId via the Worker:
 *  GET /v1/rooms/by-code/:code (workers/src/index.ts `handleByCode`,
 *  Worker F). Answers 200 `{ ok, roomId, roomCode }` — roomId + code
 *  ONLY, no player list, config, tokens or location. A 404 means the
 *  code names no live room; 429 means too many lookups from this
 *  client (5/min per IP); 400 a malformed code. The lookup needs no
 *  credential: the code itself is the invite proof. Errors are
 *  LiveApiError with the status, so the plain-words mapping in
 *  plainMessageForStatus applies (404 → "That game could not be
 *  found…", 429 → "Too many tries…"). Callers join with the returned
 *  roomId via `joinLiveRoom`, which still verifies the code against
 *  the DO. */
export async function resolveRoomByCode(code: string): Promise<LiveRoomLookupResult> {
  const data = await getJson<Record<string, unknown>>(
    `/v1/rooms/by-code/${encodeURIComponent(code)}`,
    'Could not look up the game on the server. Try again.',
  );
  const roomId = data['roomId'];
  const roomCode = data['roomCode'];
  if (typeof roomId !== 'string' || roomId.length === 0
    || typeof roomCode !== 'string' || roomCode.length === 0) {
    throw new LiveApiError('The game server gave an unexpected reply. Try again.');
  }
  return { roomId, roomCode };
}

export interface LiveCreateResult {
  roomId: string;
  roomCode: string;
  hostPlayerId: string;
  /** Raw host credential — returned ONCE, stored in sessionStorage
   *  by the caller, never logged. */
  reconnectToken: string;
  /** SEPARATE raw host credential, minted by the Worker at create
   *  (workers/src/index.ts `handleCreateRoom`, 201 `hostToken`).
   *  NOT the reconnect token: only its hash is stored in the DO
   *  (`RoomDoState.hostTokens`), and host actions verify against
   *  that hash — sending the reconnect token as `hostToken` fails
   *  with 403. Stored separately by the caller, never logged. */
  hostToken: string;
}

/** Create a room on the Worker (host). Body shape is exactly
 *  `createRoomBody` (workers/src/http.ts): displayName 1–30,
 *  kind 'guest' (guest-only pilot), full RoomConfig, ageGatePassed.
 *  Answers 201 `{ ok, roomId, roomCode, hostPlayerId,
 *  reconnectToken, hostToken }` — the two tokens are separate
 *  credentials; both are required, neither is invented here. */
export async function createLiveRoom(input: {
  displayName: string;
  config: RoomConfig;
  ageGatePassed: boolean;
}): Promise<LiveCreateResult> {
  const data = await postJson<Record<string, unknown>>('/v1/rooms', {
    displayName: input.displayName,
    kind: 'guest',
    config: input.config,
    ageGatePassed: input.ageGatePassed,
  }, 'Could not create the game on the server. Try again.');
  const roomId = data['roomId'];
  const roomCode = data['roomCode'];
  const hostPlayerId = data['hostPlayerId'];
  const reconnectToken = data['reconnectToken'];
  const hostToken = data['hostToken'];
  if (typeof roomId !== 'string' || typeof roomCode !== 'string'
    || typeof hostPlayerId !== 'string' || typeof reconnectToken !== 'string'
    || reconnectToken.length === 0 || typeof hostToken !== 'string'
    || hostToken.length === 0) {
    throw new LiveApiError('The game server gave an unexpected reply. Try again.');
  }
  return { roomId, roomCode, hostPlayerId, reconnectToken, hostToken };
}

export interface LiveJoinResult {
  roomId: string;
  playerId: string;
  isHost: boolean;
  /** Raw reconnect credential for a NEW seat. Empty string when the
   *  server restored an existing seat — the stored token stays valid
   *  (see session-credentials.ts). */
  reconnectToken: string;
  restored: boolean;
}

/** Join a room on the Worker. Needs the roomId (path) AND the
 *  6-letter roomCode (body — the invite proof, verified by the DO).
 *  Body shape is exactly `joinBody` (workers/src/http.ts).
 *  `reconnectToken` in that body is optional for a NEW join and
 *  REQUIRED to restore an existing seat (room-do.ts `addPlayer`,
 *  SEC-06: a restore without a matching token throws FORBIDDEN) —
 *  so when this tab already holds a live session for this room
 *  under the same display name, its stored reconnect token is
 *  forwarded; a brand-new join sends none. Answers
 *  `{ ok, player, reconnectToken, restored }`. A code-only caller
 *  resolves the code first with `resolveRoomByCode` above, then
 *  joins with the returned roomId — that is what the join pages do. */
export async function joinLiveRoom(input: {
  roomId: string;
  roomCode: string;
  displayName: string;
}): Promise<LiveJoinResult> {
  // Restore proof: the server restores a seat by display name only
  // when the seat's reconnect token is presented (see above). Only
  // our OWN stored seat qualifies — same room, same display name —
  // so a stored token is never offered for somebody else's seat.
  const stored = getSessionForRoom(input.roomId);
  const restoreToken = stored?.mode === 'live'
    && typeof stored.reconnectToken === 'string' && stored.reconnectToken.length > 0
    && typeof stored.displayName === 'string'
    && stored.displayName.trim().toLowerCase() === input.displayName.trim().toLowerCase()
    ? stored.reconnectToken : undefined;
  const data = await postJson<Record<string, unknown>>(
    `/v1/rooms/${encodeURIComponent(input.roomId)}/join`,
    { displayName: input.displayName, kind: 'guest', roomCode: input.roomCode,
      ...(restoreToken ? { reconnectToken: restoreToken } : {}) },
    'Could not join the game on the server. Try again.',
  );
  const player = data['player'] as Player | null | undefined;
  const reconnectToken = data['reconnectToken'];
  if (!player || typeof player.playerId !== 'string') {
    throw new LiveApiError('The game server gave an unexpected reply. Try again.');
  }
  return {
    roomId: input.roomId,
    playerId: player.playerId,
    isHost: player.isHost === true,
    reconnectToken: typeof reconnectToken === 'string' ? reconnectToken : '',
    restored: data['restored'] === true,
  };
}

/** Regenerate the room code (D-M2, host only). POST
 *  /v1/rooms/:id/regenerate-code { playerId, hostToken } — the server
 *  generates the fresh code, registers it, swaps it in and
 *  unregisters the old one, so the old code stops working and the
 *  new code works for joining. Auth is the HOST token (SEC-06), never
 *  the reconnect token or a display name. Answers
 *  `{ ok, roomCode, oldRoomCode }`. The caller must store the new
 *  code in the tab session (see live-room-client.ts
 *  `regenerateLiveRoomCode`) so the lobby, invite link and rejoin
 *  all use it. */
export async function regenerateLiveRoomCode(input: {
  roomId: string;
  playerId: string;
  hostToken: string;
}): Promise<{ roomCode: string; oldRoomCode: string }> {
  const data = await postJson<Record<string, unknown>>(
    `/v1/rooms/${encodeURIComponent(input.roomId)}/regenerate-code`,
    { playerId: input.playerId, hostToken: input.hostToken },
    'Could not change the room code on the server. Try again.',
  );
  const roomCode = data['roomCode'];
  const oldRoomCode = data['oldRoomCode'];
  if (typeof roomCode !== 'string' || roomCode.length === 0
    || typeof oldRoomCode !== 'string' || oldRoomCode.length === 0) {
    throw new LiveApiError('The game server gave an unexpected reply. Try again.');
  }
  return { roomCode, oldRoomCode };
}

/** Open the live socket for a room, using the credential this tab
 *  stored at create/join. Reconnect is the socket's own (websocket.ts):
 *  a dropped connection fetches a FRESH single-use ticket with the
 *  stored reconnect credential and retries with exponential backoff
 *  + jitter, max 5 tries, then the socket reports 'reconnect-failed'
 *  and the caller shows its own plain-words reconnect-failed message
 *  with a Retry button that calls `retryLiveSocket`. Commands sent
 *  while disconnected are discarded, never queued. Returns the socket
 *  on success, or a plain-words error string when there is no stored
 *  credential or the ticket fetch / handshake failed. */
export async function openLiveSocket(
  roomId: string,
  callbacks: PakdamSocketCallbacks,
): Promise<{ socket: PakdamSocket } | { error: string }> {
  const apiUrl = getWorkerUrl();
  if (!apiUrl) {
    return { error: 'Live play is not set up — no game server address is configured.' };
  }
  const session = getSessionForRoom(roomId);
  if (!session || session.mode !== 'live'
    || typeof session.reconnectToken !== 'string' || session.reconnectToken.length === 0) {
    return { error: 'Your sign-in for this game is missing on this tab — rejoin with the room code to get a fresh one.' };
  }
  const socket = createLivePakdamSocket({
    roomId,
    playerId: session.playerId,
    reconnectToken: session.reconnectToken,
    options: {
      maxReconnectAttempts: 5,
      reconnectBaseDelayMs: 1000,
      reconnectMaxDelayMs: 30000,
    },
  });
  if (!socket) {
    return { error: 'Live play is not set up — no game server address is configured.' };
  }
  try {
    await socket.connect(roomId, { ...callbacks, playerId: session.playerId });
  } catch {
    return { error: 'Could not connect to the game server. Check your connection and try again.' };
  }
  return { socket };
}

/** Manual retry after 'reconnect-failed' ("Retry" button). Returns
 *  null on success, or a plain-words error when the retry itself
 *  could not even start (e.g. the stored credential is gone). */
export async function retryLiveSocket(socket: PakdamSocket): Promise<string | null> {
  try {
    await socket.retry();
    return null;
  } catch {
    return 'Could not reconnect to the game server. Check your connection and try again.';
  }
}

/** Convenience for a page that just created / joined live: persist
 *  the seat (host token included when this seat is the host) in
 *  sessionStorage. Kept here so pages cannot forget the host token. */
export function storeLiveSeat(result: LiveCreateResult | LiveJoinResult, displayName: string): void {
  if ('hostPlayerId' in result) {
    saveLiveSession({
      roomId: result.roomId,
      playerId: result.hostPlayerId,
      displayName,
      reconnectToken: result.reconnectToken,
      // The SEPARATE host token from the 201 — never the reconnect
      // token (the DO verifies host actions against the host-token
      // hash, so storing the reconnect token here fails every host
      // action with 403). session-credentials.ts already holds the
      // two tokens in separate fields; no extra storage is needed.
      hostToken: result.hostToken,
      isHost: true,
      roomCode: result.roomCode,
    });
  } else {
    saveLiveSession({
      roomId: result.roomId,
      playerId: result.playerId,
      displayName,
      reconnectToken: result.reconnectToken,
      // Join never returns a host token (the DO's add-player answer
      // carries only `reconnectToken`). Pass none: saveLiveSession
      // keeps a previously stored host token for a restored host
      // seat, and a host seat with no stored token recovers one via
      // POST /v1/rooms/:id/host/token (live-room-client.ts
      // `fetchHostToken`). Never put the reconnect token here.
      hostToken: undefined,
      isHost: result.isHost,
    });
  }
}
