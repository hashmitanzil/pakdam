/**
 * Session credentials — PROTOCOL-MAP §10 (R3, R14).
 *
 * Canonical live session: ONE sessionStorage key (`pakdam.session.v1`,
 * `SESSION_STORAGE_KEY` from @pakdam/shared) holding one JSON object with
 * TWO separate tokens — `reconnectToken` (the seat credential) and
 * `hostToken` (a SEPARATE host credential). Sending one as the other 403s.
 *
 * Tokens live ONLY here: never localStorage (shared across tabs, survives
 * tab close), never in a URL, never logged. One tab = one seat;
 * sessionStorage survives a reload in the same tab but a brand-new tab
 * starts with no identity and must rejoin.
 *
 * Empty-token rule: a restored seat returns an EMPTY reconnect token;
 * saving must never overwrite a good stored token (or host token) with
 * nothing.
 */
import { SESSION_STORAGE_KEY, type PakdamSession } from '@pakdam/shared';
import { getRejoinToken } from './rejoin-token';

export type { PakdamSession };

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

function readAll(): PakdamSession[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PakdamSession[]) : [];
  } catch {
    return [];
  }
}

function writeAll(sessions: PakdamSession[]): void {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Storage full / unavailable — the seat is lost on reload, but the
    // game keeps running for this tab.
  }
}

/** The session for this room, or null. A token for another room is not a token for this one. */
export function getSessionForRoom(roomId: string): PakdamSession | null {
  const found = readAll().find((s) => s.roomId === roomId);
  return found ?? null;
}

/**
 * v31 (Fix 1 — rejoin does not survive a dropped tab): the session for
 * this room, restored from the localStorage rejoin mirror when
 * sessionStorage has nothing for it.
 *
 * ROOT CAUSE (founder-confirmed live, v30): the v29 mirror
 * (`pakdam.rejoin.v1.<roomId>`, written at join/create by
 * `mirrorRejoinToken` in live-client.ts) WAS written, but NOTHING on
 * a room page ever read it back — only the two join pages offered
 * "Rejoin your game" (`getRejoinTokenForCode`). A discarded tab
 * (Android, 20 tabs open) comes back with no sessionStorage, so
 * `useRoomState` read a null session, fell back to `mode: 'demo'`,
 * polled the demo store, found no demo room, and set the dead-end
 * error "Game not found on this device." — while a live seat token
 * sat in localStorage, never tried. Retry in that state just
 * re-polled the demo store and could never restore the seat.
 *
 * This is the read side the v29 design was missing, and it runs
 * FIRST — synchronously, in the `useState` initializer that decides
 * the mode, so the demo fallback can never win the race: a stored
 * rejoin entry becomes a live session in sessionStorage BEFORE any
 * fetch, socket, or error is decided. "Game not found" now appears
 * ONLY when there is neither a session nor a restorable entry.
 *
 * The restored session carries the seat credential ONLY (the rejoin
 * entry never holds a host token, by design) — a restored host
 * lazy-mints its host token via `getHostTokenForRoom`, exactly as a
 * host joining in a fresh tab already does. An empty token never
 * restores (a restored seat with an empty token is a dead seat).
 * A stale entry (older than the 12 h max age) reads as null via
 * `getRejoinToken` and is deleted there, so it never restores.
 * A demo session, when one exists, is returned untouched — demo
 * rooms have no rejoin entry, so this never converts demo to live.
 */
export function getOrRestoreSessionForRoom(roomId: string): PakdamSession | null {
  const existing = getSessionForRoom(roomId);
  if (existing) return existing;
  const entry = getRejoinToken(roomId);
  if (!entry || !entry.reconnectToken) return null;
  const session: PakdamSession = {
    mode: 'live',
    roomId: entry.roomId,
    playerId: entry.playerId,
    displayName: entry.displayName,
    reconnectToken: entry.reconnectToken,
    isHost: entry.isHost,
    roomCode: entry.roomCode,
  };
  storeLiveSeat(session);
  return session;
}

/** The live session for a room code, or null (join-by-code restore lookup, Phase 3 #9). */
export function getSessionForRoomCode(roomCode: string): PakdamSession | null {
  const normalized = roomCode.trim().toUpperCase();
  const found = readAll().find(
    (s) => s.mode === 'live' && (s.roomCode ?? '').toUpperCase() === normalized,
  );
  return found ?? null;
}

/**
 * Save (or replace) the session for its room. Saving a session for a room
 * replaces whatever that tab held before; live and demo sessions are never
 * mixed in one room. An empty token on restore never overwrites a good
 * stored token.
 */
export function saveSession(session: PakdamSession): void {
  const sessions = readAll().filter((s) => s.roomId !== session.roomId);
  const previous = readAll().find((s) => s.roomId === session.roomId);
  const merged: PakdamSession = { ...session };
  if (previous) {
    // Empty-token restore rule: keep the previously stored tokens.
    if (!merged.reconnectToken && previous.reconnectToken) {
      merged.reconnectToken = previous.reconnectToken;
    }
    if (!merged.hostToken && previous.hostToken) {
      merged.hostToken = previous.hostToken;
    }
  }
  sessions.push(merged);
  writeAll(sessions);
}

/** Save a live seat (create/join response). Never overwrites good tokens with empty ones. */
export function storeLiveSeat(session: PakdamSession): void {
  saveSession({ ...session, mode: 'live' });
}

/** Save a demo seat. */
export function storeDemoSeat(session: PakdamSession): void {
  saveSession({ ...session, mode: 'demo' });
}

/** Drop the seat for a room (leave / switch player). The room itself is untouched. */
export function clearSession(roomId: string): void {
  writeAll(readAll().filter((s) => s.roomId !== roomId));
}

/**
 * Drop ONLY the cached host token for a room (the seat + reconnect
 * token stay). The background mint rotates the host token, so a cached
 * token can go stale (two tabs, a rejoin) — a 403 from a host-token
 * POST drops it here and re-mints once. This writes directly instead
 * of going through `saveSession`: saving a session with an empty
 * hostToken would merge the old token straight back in.
 */
export function clearHostToken(roomId: string): void {
  writeAll(
    readAll().map((s) =>
      s.roomId === roomId ? { ...s, hostToken: undefined } : s,
    ),
  );
}

/** True only with a live session + isHost + a non-empty hostToken. Display name alone is never proof of host. */
export function isLiveHost(roomId: string): boolean {
  const session = getSessionForRoom(roomId);
  return (
    session !== null &&
    session.mode === 'live' &&
    session.isHost === true &&
    Boolean(session.hostToken)
  );
}

/** Gates socket opening: a live seat with a reconnect token. */
export function hasLiveCredential(roomId: string): boolean {
  const session = getSessionForRoom(roomId);
  return (
    session !== null &&
    session.mode === 'live' &&
    Boolean(session.reconnectToken)
  );
}

/** All live sessions saved on this device (host dashboard lists these only — the server has no room-list endpoint). */
export function loadAllLiveSessions(): PakdamSession[] {
  return readAll().filter((s) => s.mode === 'live');
}
