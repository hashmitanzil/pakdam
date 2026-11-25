/**
 * Live HTTP client — PROTOCOL-MAP §1 + BEHAVIOUR.md §3.1.
 *
 * Base URL is `NEXT_PUBLIC_WORKER_URL` (trailing slash stripped). All POSTs
 * send `Content-Type: application/json`. Success is flat `{ ok: true, … }`;
 * errors are `{ error: '…' }`. Plain-words error mapping: 400 → setup not
 * accepted · 403 → code does not match · 404 → game not found / ended ·
 * 409 → full / no longer open · 429 → too many tries.
 *
 * The web app never reads Supabase directly — all durable reads go through
 * the Worker. Two separate credentials: `reconnectToken` (the seat) and
 * `hostToken` (host actions only — sending one as the other 403s).
 */
import {
  DEFAULT_ROOM_CONFIG,
  isValidDisplayName,
  isValidRoomCode,
  type RoomConfig,
} from '@pakdam/shared';
import { getWorkerUrl, isLiveTransportEnabled } from './websocket';
import { clearHostToken, getSessionForRoom, storeLiveSeat, type PakdamSession } from './session-credentials';
import { fetchWithRetry } from './api-client';
import { clearJoinKey, getOrCreateJoinKey } from './join-key';
import { storeRejoinToken } from './rejoin-token';

export { isLiveTransportEnabled, getWorkerUrl };
export { DEFAULT_ROOM_CONFIG };
export type { RoomConfig };

/** Plain-words error for an HTTP status. */
export function liveErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return 'Setup not accepted — check the settings and try again.';
    case 403:
      return 'That code didn’t match a room — check it and try again.';
    case 404:
      return 'Game not found or ended.';
    case 409:
      return 'Full, or no longer open.';
    case 429:
      return 'Too many tries — wait a moment and try again.';
    default:
      return 'Something went wrong — try again.';
  }
}

export class LiveHttpError extends Error {
  readonly status: number;
  /**
   * v31 fix round (F3, Kabir's server half): the DO's machine-readable
   * error code, passed through by `doError` in workers/src/http.ts
   * (`{ error, code }`). `undefined` when the body carried none — a
   * bare 403 (bad token) and a 403 `SEAT_REMOVED` (seat left the room)
   * share the status but not the code, and only the code tells them
   * apart. Callers branch on `err.code === 'SEAT_REMOVED'`, never on
   * the status alone.
   */
  readonly code?: string;
  constructor(status: number, message?: string, code?: string) {
    super(message ?? liveErrorMessage(status));
    this.status = status;
    this.code = code;
  }
}

/**
 * Read the server's error envelope out of an error response body
 * (`{ error: '…', code: '…' }`). Returns `{}` when the body is
 * missing, not JSON, or carries neither — the caller then falls back
 * to the generic status mapping in `LiveHttpError`. The body is read
 * ONCE here, so message and code always come from the same envelope
 * (reading the body twice would throw — a `Response` body is a
 * single-use stream).
 */
export async function readLiveErrorEnvelope(
  response: Response,
): Promise<{ message?: string; code?: string }> {
  try {
    const data = (await response.json()) as { error?: string; code?: string };
    return {
      ...(typeof data.error === 'string' && data.error.length > 0
        ? { message: data.error }
        : {}),
      ...(typeof data.code === 'string' && data.code.length > 0
        ? { code: data.code }
        : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Read the server's plain-words reason out of an error response body
 * (`{ error: '…' }`). Returns `undefined` when the body is missing, not
 * JSON, or carries no `error` string — the caller then falls back to the
 * generic status mapping in `LiveHttpError`. Every POST helper must use
 * this: a 409 from /start carries the gate reason (e.g. "Waiting for X
 * to tap \"I'm ready\"."), and throwing without it shows the wrong
 * generic "Full, or no longer open." instead.
 */
export async function readLiveErrorMessage(response: Response): Promise<string | undefined> {
  return (await readLiveErrorEnvelope(response)).message;
}

/**
 * POST via `fetchWithRetry` (Gap 4): an unkeyed POST is attempted once
 * (same as the old plain fetch); a keyed POST is retried under the
 * retry rules. The key is generated ONCE per user action by the caller
 * and reused across retries — never minted per attempt. A 403 is never
 * retried here, so the host-token re-mint retry in `postHost` /
 * `replayLiveRoom` / `endLiveMatch` is never double-wrapped.
 */
async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  init?: RequestInit,
  opts?: { idempotencyKey?: string },
): Promise<T> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error('Live transport is not configured.');
  const response = await fetchWithRetry(
    `${workerUrl}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      body: JSON.stringify(body),
      ...init,
    },
    { idempotencyKey: opts?.idempotencyKey },
  );
  if (!response.ok) {
    const envelope = await readLiveErrorEnvelope(response);
    throw new LiveHttpError(response.status, envelope.message, envelope.code);
  }
  return (await response.json()) as T;
}

/** GET via `fetchWithRetry` (Gap 4): retried, max 3 attempts, backoff 500 ms → 5 s on 408/429/5xx. */
async function getJson<T>(path: string, headers?: Record<string, string>): Promise<T> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error('Live transport is not configured.');
  const response = await fetchWithRetry(`${workerUrl}${path}`, { headers });
  if (!response.ok) {
    // v31 fix round (F3): the GET path used to throw the bare status
    // and discard the envelope — a 403 `SEAT_REMOVED` read exactly
    // like a 403 bad token. The code is carried now, same as POST.
    const envelope = await readLiveErrorEnvelope(response);
    throw new LiveHttpError(response.status, envelope.message, envelope.code);
  }
  return (await response.json()) as T;
}

/**
 * Mirror a stored live seat's reconnect token into the rejoin store
 * (founder decision: rejoin must survive the app being killed). The
 * seat in sessionStorage is the source of truth — a restored seat
 * returns an EMPTY token, so the stored (good) token is mirrored, never
 * the empty one.
 */
function mirrorRejoinToken(roomId: string): void {
  const stored = getSessionForRoom(roomId);
  if (!stored?.reconnectToken) return;
  storeRejoinToken({
    roomId: stored.roomId,
    roomCode: stored.roomCode ?? '',
    playerId: stored.playerId,
    displayName: stored.displayName ?? '',
    reconnectToken: stored.reconnectToken,
    isHost: stored.isHost,
  });
}

export interface CreateRoomResponse {
  ok: boolean;
  roomId: string;
  roomCode: string;
  hostPlayerId: string;
  reconnectToken: string;
  hostToken: string;
}

export interface JoinRoomResponse {
  ok: boolean;
  player: {
    playerId: string;
    displayName: string;
    isHost: boolean;
    [key: string]: unknown;
  };
  reconnectToken: string;
  restored: boolean;
}

/** POST /v1/rooms — create room (host). Stores both tokens, returns the session. */
export async function createLiveRoom(
  displayName: string,
  config: RoomConfig = DEFAULT_ROOM_CONFIG,
): Promise<PakdamSession> {
  if (!isValidDisplayName(displayName)) {
    throw new Error('Enter a name between 1 and 30 characters.');
  }
  const data = await postJson<CreateRoomResponse>('/v1/rooms', {
    displayName: displayName.trim(),
    kind: 'guest',
    config,
    ageGatePassed: true,
  });
  const session: PakdamSession = {
    mode: 'live',
    roomId: data.roomId,
    playerId: data.hostPlayerId,
    displayName: displayName.trim(),
    reconnectToken: data.reconnectToken,
    hostToken: data.hostToken,
    isHost: true,
    roomCode: data.roomCode,
  };
  storeLiveSeat(session);
  mirrorRejoinToken(data.roomId);
  return session;
}

/** GET /v1/rooms/by-code/:code — resolve a 6-letter invite code to a roomId. */
export async function resolveRoomByCode(
  code: string,
): Promise<{ roomId: string; roomCode: string }> {
  const normalized = code.trim().toUpperCase();
  if (!isValidRoomCode(normalized)) {
    throw new Error('That code didn’t match a room — check it and try again.');
  }
  const data = await getJson<{ ok: boolean; roomId: string; roomCode: string }>(
    `/v1/rooms/by-code/${normalized}`,
  );
  return { roomId: data.roomId, roomCode: data.roomCode };
}

/**
 * POST /v1/rooms/:id/join — join by code (guest). `reconnectToken` is
 * forwarded only when this tab already holds a live session for this room
 * under the same display name (seat restore). A restored seat returns an
 * EMPTY reconnect token — `storeLiveSeat` keeps the good stored one.
 */
export async function joinLiveRoom(
  roomId: string,
  displayName: string,
  roomCode: string,
  reconnectToken?: string,
): Promise<PakdamSession> {
  if (!isValidDisplayName(displayName)) {
    throw new Error('Enter a name between 1 and 30 characters.');
  }
  // Gap 4 (join dedupe): one key per join attempt, stored BEFORE
  // sending, reused by a retry after a lost response — the server
  // returns the cached join (same seat + token) instead of 403 "name
  // taken". The key is per room+codename; the seat is obtained below,
  // so the key is cleared on success.
  const name = displayName.trim();
  const joinKey = getOrCreateJoinKey(roomId, name);
  const data = await postJson<JoinRoomResponse>(
    `/v1/rooms/${roomId}/join`,
    {
      displayName: name,
      kind: 'guest',
      roomCode: roomCode.trim().toUpperCase(),
      ...(reconnectToken ? { reconnectToken } : {}),
    },
    undefined,
    { idempotencyKey: joinKey },
  );
  clearJoinKey(roomId, name);
  const session: PakdamSession = {
    mode: 'live',
    roomId,
    playerId: data.player.playerId,
    displayName: name,
    reconnectToken: data.reconnectToken,
    isHost: data.player.isHost,
    roomCode: roomCode.trim().toUpperCase(),
  };
  storeLiveSeat(session);
  mirrorRejoinToken(roomId);
  // A2: join never returns a host token, so a host who rejoined in a
  // fresh tab used to pay a second round-trip (POST /host/token) on
  // every host action — including START. Mint it here, in the
  // background, so by the time the host taps START the token is already
  // cached and START is a single POST. Non-blocking: a mint failure
  // just leaves the lazy path (`getHostTokenLive`) to run at START.
  // `storeLiveSeat` keeps a good stored reconnect token when the join
  // returned an empty one, so the stored seat is read back for the mint.
  if (data.player.isHost) {
    const stored = getSessionForRoom(roomId);
    if (stored && !stored.hostToken && stored.reconnectToken) {
      void fetchHostToken(roomId, stored.playerId, stored.reconnectToken)
        .then((hostToken) => storeLiveSeat({ ...stored, hostToken }))
        .catch(() => undefined);
    }
  }
  return session;
}

/**
 * POST /v1/rooms/join-by-code — join by code in ONE call (Phase 3 #9):
 * the server resolves the code to a roomId itself, so the client no
 * longer does GET by-code THEN POST join. `reconnectToken` is forwarded
 * only when this tab already holds a live session for this code under
 * the same display name (seat restore — look it up with
 * getSessionForRoomCode first). A restored seat returns an EMPTY
 * reconnect token — `storeLiveSeat` keeps the good stored one.
 */
export async function joinLiveRoomByCode(
  displayName: string,
  roomCode: string,
  reconnectToken?: string,
): Promise<PakdamSession> {
  if (!isValidDisplayName(displayName)) {
    throw new Error('Enter a name between 1 and 30 characters.');
  }
  const code = roomCode.trim().toUpperCase();
  // Gap 4 (join dedupe, same as joinLiveRoom — keyed on the CODE here,
  // the room id is unknown until the server resolves it).
  const name = displayName.trim();
  const joinKey = getOrCreateJoinKey(code, name);
  const data = await postJson<JoinRoomResponse & { roomId: string }>(
    '/v1/rooms/join-by-code',
    {
      displayName: name,
      kind: 'guest',
      roomCode: code,
      ...(reconnectToken ? { reconnectToken } : {}),
    },
    undefined,
    { idempotencyKey: joinKey },
  );
  clearJoinKey(code, name);
  const session: PakdamSession = {
    mode: 'live',
    roomId: data.roomId,
    playerId: data.player.playerId,
    displayName: name,
    reconnectToken: data.reconnectToken,
    isHost: data.player.isHost,
    roomCode: code,
  };
  storeLiveSeat(session);
  mirrorRejoinToken(data.roomId);
  // A2 (same background mint as joinLiveRoom — this is the join path
  // both join pages actually use): a host who joined in a fresh tab
  // mints the host token now, so START is a single POST by the time
  // the host taps it. Non-blocking; a mint failure just leaves the
  // lazy path (`getHostTokenLive`) to run at START.
  if (data.player.isHost) {
    const stored = getSessionForRoom(data.roomId);
    if (stored && !stored.hostToken && stored.reconnectToken) {
      void fetchHostToken(data.roomId, stored.playerId, stored.reconnectToken)
        .then((hostToken) => storeLiveSeat({ ...stored, hostToken }))
        .catch(() => undefined);
    }
  }
  return session;
}

/** POST /v1/rooms/:id/host/token — mint / rotate the host token for the host seat. */
export async function fetchHostToken(
  roomId: string,
  playerId: string,
  reconnectToken: string,
): Promise<string> {
  const data = await postJson<{ ok: boolean; hostToken: string }>(
    `/v1/rooms/${roomId}/host/token`,
    { playerId, reconnectToken },
  );
  return data.hostToken;
}

/** POST /v1/rooms/:id/catch-token — Runner fetches the raw one-time catch token for their QR. Never stored beyond the QR on screen. */
export async function fetchLiveCatchToken(
  roomId: string,
  playerId: string,
  reconnectToken: string,
  catchId: string,
): Promise<{ token: string; catchId: string; expiresAt?: string }> {
  return postJson<{ token: string; catchId: string; expiresAt?: string }>(
    `/v1/rooms/${roomId}/catch-token`,
    { playerId, reconnectToken, catchId },
  );
}

export interface LiveResultsResponse {
  ok: boolean;
  roomId: string;
  phase: string;
  result: {
    outcome: 'hunters-win' | 'runners-win' | 'cancelled' | 'abandoned';
    durationSeconds: number;
    caughtRunnerIds: string[];
    survivingRunnerIds: string[];
    tags: { hunterPlayerId: string; runnerPlayerId: string; confirmedAt: string }[];
  };
  /** Points per playerId (server-computed, completed matches only). */
  scores: Record<string, number>;
}

/**
 * GET /v1/rooms/:id/results — match result + server-computed scores,
 * participant-only; 404 until a result exists. Bearer reconnect token in
 * the header — the client never puts the token in the query string.
 */
export async function fetchLiveResults(
  roomId: string,
  playerId: string,
  reconnectToken: string,
): Promise<LiveResultsResponse> {
  // GET via getJson (Gap 4 retries) — the Bearer token stays in the
  // header, never in the query string.
  return getJson<LiveResultsResponse>(
    `/v1/rooms/${roomId}/results?playerId=${encodeURIComponent(playerId)}`,
    { Authorization: `Bearer ${reconnectToken}` },
  );
}

/** Recover the host token when the stored one is missing (join never returns one). */
async function getHostTokenForRoom(roomId: string): Promise<{ playerId: string; hostToken: string }> {
  const session = getSessionForRoom(roomId);
  if (!session) throw new Error('No live seat saved on this device for this room.');
  if (session.hostToken) return { playerId: session.playerId, hostToken: session.hostToken };
  if (!session.reconnectToken) throw new Error('No live seat saved on this device for this room.');
  const hostToken = await fetchHostToken(roomId, session.playerId, session.reconnectToken);
  storeLiveSeat({ ...session, hostToken });
  return { playerId: session.playerId, hostToken };
}

export interface ReplayLiveRoomResponse {
  ok: boolean;
  phase: string;
  roomCode: string;
  playerCount: number;
}

/**
 * POST /v1/rooms/:id/replay — v18: host resets a FINISHED room to LOBBY
 * (same room/code, fresh game). Host-only server-side (403 for a
 * non-host); 409 when the room is not finished. The server broadcasts
 * `room.state` (`reason: "replay-reset"`) so every other client returns
 * to the lobby; the caller navigates on the response itself.
 */
export async function replayLiveRoom(roomId: string): Promise<ReplayLiveRoomResponse> {
  // Gap 4 (fix round M3): one Idempotency-Key per replay action,
  // minted here and reused by BOTH sends below — the fetchWithRetry
  // retries inside `postJson` AND the 403 host-token re-mint retry.
  // A retried replay after a lost response gets the server's cached
  // success, not a 409 for a room that already replayed.
  const idempotencyKey = crypto.randomUUID();
  const send = async (): Promise<ReplayLiveRoomResponse> => {
    const { playerId, hostToken } = await getHostTokenForRoom(roomId);
    return postJson<ReplayLiveRoomResponse>(
      `/v1/rooms/${roomId}/replay`,
      {
        playerId,
        hostToken,
      },
      undefined,
      { idempotencyKey },
    );
  };
  try {
    return await send();
  } catch (err) {
    // Stale host token (rotated by the background mint): drop the dead
    // token, mint once, retry once. A failed re-mint surfaces the
    // original error, not the mint error.
    if (err instanceof LiveHttpError && err.status === 403) {
      try {
        clearHostToken(roomId);
        return await send();
      } catch {
        throw err;
      }
    }
    throw err;
  }
}

/**
 * POST /v1/rooms/:id/lifecycle { action: 'end' } — host ends the round
 * early (server-only REST lifecycle; pause/resume go over WS instead).
 * Host cancel DELETES the room (founder decision, 2026-11-21): the
 * cancelling host goes home on success, and every other player follows
 * via the `room.deleted` event or a 404 — nobody goes to results.
 */
export async function endLiveMatch(roomId: string): Promise<{ ok: boolean }> {
  const send = async (): Promise<{ ok: boolean }> => {
    const { playerId, hostToken } = await getHostTokenForRoom(roomId);
    return postJson<{ ok: boolean }>(`/v1/rooms/${roomId}/lifecycle`, {
      action: 'end',
      playerId,
      hostToken,
    });
  };
  try {
    return await send();
  } catch (err) {
    // Stale host token (rotated by the background mint): drop the dead
    // token, mint once, retry once. A failed re-mint surfaces the
    // original error, not the mint error.
    if (err instanceof LiveHttpError && err.status === 403) {
      try {
        clearHostToken(roomId);
        return await send();
      } catch {
        throw err;
      }
    }
    throw err;
  }
}

/**
 * POST /v1/reports — report / block intake (audit record ONLY, 202). A
 * 'block' does NOT remove or silence anyone — it is only recorded for
 * the host's later review. No location is ever attached.
 */
export async function submitReport(
  roomId: string,
  targetPlayerId: string,
  kind: 'report' | 'block',
): Promise<void> {
  const session = getSessionForRoom(roomId);
  if (!session) throw new Error('No live seat saved on this device for this room.');
  await postJson<{ ok: boolean }>('/v1/reports', {
    roomId,
    playerId: session.playerId,
    targetPlayerId,
    kind,
  });
}
