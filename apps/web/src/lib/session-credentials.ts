/**
 * Per-tab session credentials — sessionStorage ONLY, never localStorage.
 *
 * One tab = one seat. sessionStorage survives a reload in the same tab
 * (so a refresh keeps the room, the role and the reconnect credential)
 * but a brand-new tab starts with no identity and must rejoin — which
 * is also why the demo store's `currentPlayerId` already lives in
 * sessionStorage (see demo-store.ts). Tokens are stored ONLY here:
 * never in localStorage (shared across tabs, survives tab close),
 * never in a URL, never logged.
 *
 * Live vs demo: a session records its `mode`. A live session and a
 * demo session are never mixed in one room — saving a session for a
 * room replaces whatever that tab held before, and `getSessionForRoom`
 * returns null for any other room, so a live room can never be read
 * as a demo room or vice versa.
 *
 * Host identity: the host token IS the proof of host — never the
 * display name alone. The Worker issues no separate "host token":
 * the host seat's reconnect token (returned once by POST /v1/rooms)
 * is the credential the server checks for host-only actions (start,
 * WS ticket). It is stored here as `hostToken` only for a host seat;
 * for a non-host seat it is absent. Callers must check
 * `isLiveHost(roomId)` / `session.isHost`, never compare names.
 *
 * Restored seats: when a player rejoins with a display name the
 * server already knows, the Worker returns an EMPTY reconnect token
 * (room-do.ts `addPlayer` restore path) — the seat keeps the
 * credential it already had. `saveLiveSession` therefore keeps the
 * previously stored token when the new one is empty for the same
 * room + player, instead of overwriting it with nothing.
 */
export type SessionMode = 'live' | 'demo';

export interface PakdamSession {
  mode: SessionMode;
  roomId: string;
  playerId: string;
  displayName?: string;
  /** Live only: raw reconnect credential for this seat. Absent for demo. */
  reconnectToken?: string;
  /** Live only, host seats only: the host seat's reconnect token —
   *  the proof of host. Absent for non-hosts and for demo sessions. */
  hostToken?: string;
  isHost: boolean;
  roomCode?: string;
}

const KEY = 'pakdam.session.v1';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function readSession(): PakdamSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed['mode'] !== 'live' && parsed['mode'] !== 'demo') return null;
    if (typeof parsed['roomId'] !== 'string' || typeof parsed['playerId'] !== 'string') return null;
    return {
      mode: parsed['mode'],
      roomId: parsed['roomId'],
      playerId: parsed['playerId'],
      displayName: typeof parsed['displayName'] === 'string' ? parsed['displayName'] : undefined,
      reconnectToken: typeof parsed['reconnectToken'] === 'string' && parsed['reconnectToken'].length > 0
        ? parsed['reconnectToken'] : undefined,
      hostToken: typeof parsed['hostToken'] === 'string' && parsed['hostToken'].length > 0
        ? parsed['hostToken'] : undefined,
      isHost: parsed['isHost'] === true,
      roomCode: typeof parsed['roomCode'] === 'string' ? parsed['roomCode'] : undefined,
    };
  } catch {
    return null;
  }
}

function writeSession(session: PakdamSession): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(KEY, JSON.stringify(session));
}

/** Save a live seat: room + player + reconnect credential, plus the
 *  host token when this seat is the host. An empty reconnect token
 *  for a seat this tab already holds keeps the stored token (server
 *  restore path — see the header note). */
export function saveLiveSession(input: {
  roomId: string;
  playerId: string;
  displayName?: string;
  reconnectToken?: string;
  hostToken?: string;
  isHost: boolean;
  roomCode?: string;
}): PakdamSession {
  const previous = readSession();
  const keepToken = !input.reconnectToken
    && previous?.mode === 'live'
    && previous.roomId === input.roomId
    && previous.playerId === input.playerId
    ? previous.reconnectToken : undefined;
  const keepHostToken = !input.hostToken && input.isHost
    && previous?.mode === 'live'
    && previous.roomId === input.roomId
    && previous.playerId === input.playerId
    ? previous.hostToken : undefined;
  const session: PakdamSession = {
    mode: 'live',
    roomId: input.roomId,
    playerId: input.playerId,
    displayName: input.displayName,
    reconnectToken: input.reconnectToken ? input.reconnectToken : keepToken,
    hostToken: input.hostToken ? input.hostToken : keepHostToken,
    isHost: input.isHost,
    roomCode: input.roomCode,
  };
  writeSession(session);
  return session;
}

/** Save a demo seat: room + player only, no tokens of any kind. */
export function saveDemoSession(input: {
  roomId: string;
  playerId: string;
  displayName?: string;
  isHost?: boolean;
  roomCode?: string;
}): PakdamSession {
  const session: PakdamSession = {
    mode: 'demo',
    roomId: input.roomId,
    playerId: input.playerId,
    displayName: input.displayName,
    isHost: input.isHost ?? false,
    roomCode: input.roomCode,
  };
  writeSession(session);
  return session;
}

/** This tab's session, whatever the room — null when this tab has none. */
export function getSession(): PakdamSession | null {
  return readSession();
}

/** This tab's session for one room — null when the tab holds a
 *  session for a different room (or none). Use this before trusting
 *  any stored credential: a token for another room is not a token
 *  for this one. */
export function getSessionForRoom(roomId: string): PakdamSession | null {
  const session = readSession();
  return session && session.roomId === roomId ? session : null;
}

/** True only when this tab holds a LIVE session for this room AND
 *  that session carries a host token. Display name alone is never
 *  proof of host. */
export function isLiveHost(roomId: string): boolean {
  const session = getSessionForRoom(roomId);
  return session?.mode === 'live' && session.isHost === true
    && typeof session.hostToken === 'string' && session.hostToken.length > 0;
}

/** True only when this tab holds a LIVE session for this room with a
 *  reconnect credential to open a socket with. */
export function hasLiveCredential(roomId: string): boolean {
  const session = getSessionForRoom(roomId);
  return session?.mode === 'live'
    && typeof session.reconnectToken === 'string' && session.reconnectToken.length > 0;
}

/** Drop this tab's session (leave / switch player). The room itself
 *  is untouched — the seat can rejoin with the room code. */
export function clearSession(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(KEY);
}
