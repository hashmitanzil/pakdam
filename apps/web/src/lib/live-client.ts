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
import { getSessionForRoom, storeLiveSeat, type PakdamSession } from './session-credentials';

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
  constructor(status: number, message?: string) {
    super(message ?? liveErrorMessage(status));
    this.status = status;
  }
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  init?: RequestInit,
): Promise<T> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error('Live transport is not configured.');
  const response = await fetch(`${workerUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
  if (!response.ok) {
    let message: string | undefined;
    try {
      const data = (await response.json()) as { error?: string };
      message = data.error;
    } catch {
      message = undefined;
    }
    throw new LiveHttpError(response.status, message);
  }
  return (await response.json()) as T;
}

async function getJson<T>(path: string, headers?: Record<string, string>): Promise<T> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error('Live transport is not configured.');
  const response = await fetch(`${workerUrl}${path}`, { headers });
  if (!response.ok) {
    throw new LiveHttpError(response.status);
  }
  return (await response.json()) as T;
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
  const data = await postJson<JoinRoomResponse>(`/v1/rooms/${roomId}/join`, {
    displayName: displayName.trim(),
    kind: 'guest',
    roomCode: roomCode.trim().toUpperCase(),
    ...(reconnectToken ? { reconnectToken } : {}),
  });
  const session: PakdamSession = {
    mode: 'live',
    roomId,
    playerId: data.player.playerId,
    displayName: displayName.trim(),
    reconnectToken: data.reconnectToken,
    isHost: data.player.isHost,
    roomCode: roomCode.trim().toUpperCase(),
  };
  storeLiveSeat(session);
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
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error('Live transport is not configured.');
  const response = await fetch(
    `${workerUrl}/v1/rooms/${roomId}/results?playerId=${encodeURIComponent(playerId)}`,
    { headers: { Authorization: `Bearer ${reconnectToken}` } },
  );
  if (!response.ok) throw new LiveHttpError(response.status);
  return (await response.json()) as LiveResultsResponse;
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

/**
 * POST /v1/rooms/:id/lifecycle { action: 'end' } — host ends the round
 * early (server-only REST lifecycle; pause/resume go over WS instead).
 * The match completes with the mode-aware outcome and the play screen
 * redirects to results.
 */
export async function endLiveMatch(roomId: string): Promise<{ ok: boolean }> {
  const { playerId, hostToken } = await getHostTokenForRoom(roomId);
  return postJson<{ ok: boolean }>(`/v1/rooms/${roomId}/lifecycle`, {
    action: 'end',
    playerId,
    hostToken,
  });
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
