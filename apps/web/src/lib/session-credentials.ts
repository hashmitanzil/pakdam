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
