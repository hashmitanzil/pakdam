/**
 * Live room client — typed wrappers over the WS client for room state
 * (PROTOCOL-MAP §1.5–1.12, §3).
 *
 * The DO is the sole authority in live mode: the client never sets phase,
 * roles, timers or ejection locally — it applies the server snapshot as the
 * whole truth and patches only from server messages. A live room is never
 * silently downgraded to demo mid-room.
 *
 * Role secrecy: a seat sees its OWN role/team only — every other seat's
 * role is `null` in `PlayerView`. The Hunter's catch picker shows names
 * only; a wrong pick is rejected by the server in plain words.
 */
import {
  MIN_PLAYERS,
  type CatchView,
  type PlayerView,
  type Room,
  type RoomConfig,
  type WsSnapshotPayload,
} from '@pakdam/shared';
import { getWorkerUrl } from './websocket';
import { getSessionForRoom, storeLiveSeat } from './session-credentials';
import { fetchHostToken, LiveHttpError, liveErrorMessage } from './live-client';
import type { PakdamSocket } from './websocket';

export { MIN_PLAYERS, liveErrorMessage, LiveHttpError };
export type { CatchView, PlayerView, Room, RoomConfig, WsSnapshotPayload };

export interface LiveRoomState {
  room: Room;
  players: PlayerView[];
  version: number;
}

/**
 * GET /v1/rooms/:id?playerId=… — recipient-filtered room state (first paint
 * / results). Bearer reconnect token in the header — the client never puts
 * the token in the query string (tokens must not land in edge access logs).
 *
 * The server answers with the FULL snapshot (`WsSnapshotPayload`), not just
 * room/players — including `decidedCatches`, which is what restores the
 * after-tagged screen and auto-spectator state on a reload before the
 * socket's first snapshot lands. Callers that only need room/players use
 * `snapshotToLiveRoomState`.
 */
export async function fetchLiveRoomState(
  roomId: string,
  playerId: string,
  reconnectToken: string,
): Promise<WsSnapshotPayload> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error('Live transport is not configured.');
  const response = await fetch(
    `${workerUrl}/v1/rooms/${roomId}?playerId=${encodeURIComponent(playerId)}`,
    { headers: { Authorization: `Bearer ${reconnectToken}` } },
  );
  if (!response.ok) throw new LiveHttpError(response.status);
  return (await response.json()) as WsSnapshotPayload;
}

async function postHost<T>(
  roomId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error('Live transport is not configured.');
  const response = await fetch(`${workerUrl}/v1/rooms/${roomId}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new LiveHttpError(response.status);
  return (await response.json()) as T;
}

/** Recover the host token when the stored one is missing (join never returns one). */
export async function getHostTokenLive(roomId: string): Promise<string> {
  const session = getSessionForRoom(roomId);
  if (!session?.reconnectToken) {
    throw new Error('No live seat saved on this device for this room.');
  }
  if (session.hostToken) return session.hostToken;
  const hostToken = await fetchHostToken(roomId, session.playerId, session.reconnectToken);
  storeLiveSeat({ ...session, hostToken });
  return hostToken;
}

/** POST /v1/rooms/:id/start — host starts the match (host token; 409 if the gate is unmet). */
export async function startLiveMatch(
  roomId: string,
): Promise<{ phase: string; startedAt: string | null; endsAt: string | null }> {
  const session = getSessionForRoom(roomId);
  if (!session) throw new Error('No live seat saved on this device for this room.');
  const hostToken = await getHostTokenLive(roomId);
  return postHost(roomId, '/start', {
    playerId: session.playerId,
    hostToken,
  });
}

/** POST /v1/rooms/:id/config — host replaces the full lobby config (lobby only). */
export async function updateLiveRoomConfig(
  roomId: string,
  config: RoomConfig,
): Promise<{ room: Room }> {
  const session = getSessionForRoom(roomId);
  if (!session) throw new Error('No live seat saved on this device for this room.');
  const hostToken = await getHostTokenLive(roomId);
  return postHost(roomId, '/config', {
    playerId: session.playerId,
    hostToken,
    config,
  });
}

/** POST /v1/rooms/:id/remove-player — host removes a lobby player (never the host). */
export async function removeLivePlayer(
  roomId: string,
  targetPlayerId: string,
): Promise<{ ok: boolean }> {
  const session = getSessionForRoom(roomId);
  if (!session) throw new Error('No live seat saved on this device for this room.');
  const hostToken = await getHostTokenLive(roomId);
  return postHost(roomId, '/remove-player', {
    playerId: session.playerId,
    hostToken,
    targetPlayerId,
  });
}

/** POST /v1/rooms/:id/regenerate-code — host swaps the room code; the old code dies at once. */
export async function regenerateLiveRoomCode(
  roomId: string,
): Promise<{ ok: boolean; roomCode: string; oldRoomCode: string }> {
  const session = getSessionForRoom(roomId);
  if (!session) throw new Error('No live seat saved on this device for this room.');
  const hostToken = await getHostTokenLive(roomId);
  const data = await postHost<{ ok: boolean; roomCode: string; oldRoomCode: string }>(
    roomId,
    '/regenerate-code',
    { playerId: session.playerId, hostToken },
  );
  // Store the new code in the tab session so lobby, invite link and rejoin all use it.
  storeLiveSeat({ ...session, roomCode: data.roomCode });
  return data;
}

/**
 * POST /v1/rooms/:id/catches/:cid/resolve — host resolves a disputed catch.
 * Wired into the host UI (PROTOCOL-MAP §1.12 decision: wire it, do not
 * leave it half-wired). Decision 'confirmed' applies the mode rule;
 * 'rejected' voids the claim.
 */
export async function resolveLiveCatch(
  roomId: string,
  catchId: string,
  decision: 'confirmed' | 'rejected',
  reason?: string,
): Promise<{ ok: boolean }> {
  const session = getSessionForRoom(roomId);
  if (!session) throw new Error('No live seat saved on this device for this room.');
  const hostToken = await getHostTokenLive(roomId);
  return postHost(roomId, `/catches/${catchId}/resolve`, {
    playerId: session.playerId,
    hostToken,
    decision,
    ...(reason ? { reason } : {}),
  });
}

/**
 * Client start gate — must agree with the server gate (§4.2): active seats
 * ≥ MIN_PLAYERS (2) AND every active seat ready AND teams set AND the
 * Hunter count leaves at least one Runner. A blocked Start always says
 * why in one line; never a silent disabled button.
 */
export function canStartLiveMatch(
  players: PlayerView[],
  teamAssignment: 'random' | 'selected',
  selectedHunterIds: string[],
  hunterCount: number,
): { canStart: boolean; reason: string | null } {
  const active = players.filter((p) => p.leftAt === null && p.ejectedAt === null);
  if (active.length < MIN_PLAYERS) {
    return {
      canStart: false,
      reason: `Need at least ${MIN_PLAYERS} players — share the room code above.`,
    };
  }
  if (hunterCount > active.length - 1) {
    return {
      canStart: false,
      reason: 'Hunter count must leave at least one Runner — lower it or wait for more players.',
    };
  }
  const notReady = active.filter((p) => !p.isReady);
  if (notReady.length > 0) {
    return {
      canStart: false,
      reason: `Waiting for: ${notReady.map((p) => p.displayName).join(', ')}.`,
    };
  }
  const teamsReady =
    teamAssignment === 'random' || selectedHunterIds.length === hunterCount;
  if (!teamsReady) {
    return {
      canStart: false,
      reason: `Pick ${hunterCount} ${hunterCount === 1 ? 'Hunter' : 'Hunters'} first.`,
    };
  }
  return { canStart: true, reason: null };
}

/**
 * Snapshot → room-state adapter. The snapshot is the whole truth; this
 * helper only reshapes it for pages that render from `LiveRoomState`.
 * Pings never arrive in a snapshot (they come as `ping` events only).
 */
export function snapshotToLiveRoomState(snapshot: WsSnapshotPayload): LiveRoomState {
  return {
    room: snapshot.room,
    players: snapshot.players,
    version: snapshot.version,
  };
}

/** The socket's snapshot handler for a live room: returns the adapted state for the page. */
export function createLiveSnapshotHandler(
  onState: (state: LiveRoomState, snapshot: WsSnapshotPayload) => void,
): (snapshot: WsSnapshotPayload) => void {
  return (snapshot) => onState(snapshotToLiveRoomState(snapshot), snapshot);
}

export type { PakdamSocket };
