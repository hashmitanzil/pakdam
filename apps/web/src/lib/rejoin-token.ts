/**
 * Rejoin tokens — "Rejoin your game" (founder decision, 2026-11-22).
 *
 * The reconnect token must survive the app being killed: the seat
 * credential is mirrored here, in localStorage, keyed per room
 * (`pakdam.rejoin.v1.<roomId>`), so a killed app can offer "Rejoin
 * your game" on the home / join screen and resume with role/score via
 * the existing resume path (the token is restored into the tab's
 * sessionStorage seat first, then the app navigates to the room — the
 * lobby / play pages resume from the session exactly as they do after
 * a reload).
 *
 * DELIBERATE DEVIATION from the reliability spec (§1.7): the spec
 * keeps tokens in sessionStorage ONLY ("never localStorage"). The
 * founder's explicit rule — rejoin must survive the app being killed —
 * overrides it. TRADEOFF, stated plainly: the token persists on the
 * device until the game ends (or the player leaves / is ejected), so
 * anyone with the device can rejoin that seat while the game is live.
 * It is the seat credential only — never the host token — and it is
 * cleared on leave, eject and match-end, never logged, never put in a
 * URL. A room whose game has ended keeps no token here.
 *
 * READ-TIME MAX AGE (fix round M5, Zara): a stored token is valid for
 * at most 12 hours from `storedAtMs` (`REJOIN_TOKEN_MAX_AGE_MS`) — a
 * game lasts hours at most, and the token is for rejoining a LIVE game
 * after an app kill, not for coming back days later. Every read
 * (`getRejoinToken`, `listRejoinTokens`) enforces the age and deletes
 * stale entries on sight; `clearRejoinToken` — the leave / eject /
 * match-end / room-deleted path — sweeps every stale entry on the
 * device as well, so a terminal room never leaves old tokens behind.
 */
export interface RejoinEntry {
  roomId: string;
  roomCode: string;
  playerId: string;
  displayName: string;
  reconnectToken: string;
  isHost: boolean;
  /** Epoch ms when the entry was stored — the 12 h max-age clock (M5). */
  storedAtMs: number;
}

const REJOIN_KEY_PREFIX = 'pakdam.rejoin.v1.';

/**
 * Max age of a stored rejoin token (fix round M5): 12 hours. A game
 * lasts hours at most; the token is for rejoining a live game after
 * an app kill. Older entries are stale — reads return null for them
 * and delete them, and the terminal-room sweep removes them.
 */
export const REJOIN_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** True when the entry is older than the max age, or undatable (fail closed: no `storedAtMs` = no bound). */
export function isRejoinTokenStale(entry: RejoinEntry, nowMs: number = Date.now()): boolean {
  return (
    typeof entry.storedAtMs !== 'number' ||
    !Number.isFinite(entry.storedAtMs) ||
    nowMs - entry.storedAtMs > REJOIN_TOKEN_MAX_AGE_MS
  );
}

/** Delete every stored rejoin entry older than the max age. Returns how many were removed. */
export function sweepStaleRejoinTokens(nowMs: number = Date.now()): number {
  if (!isBrowser()) return 0;
  let removed = 0;
  for (const entry of listRejoinTokensRaw()) {
    if (isRejoinTokenStale(entry, nowMs)) {
      clearRejoinTokenOnly(entry.roomId);
      removed += 1;
    }
  }
  return removed;
}

/** Every stored entry, including stale ones (the sweep's own read — callers use `listRejoinTokens`). */
function listRejoinTokensRaw(): RejoinEntry[] {
  if (!isBrowser()) return [];
  const out: RejoinEntry[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(REJOIN_KEY_PREFIX)) continue;
      const entry = readRejoinToken(key.slice(REJOIN_KEY_PREFIX.length));
      if (entry) out.push(entry);
    }
  } catch {
    return [];
  }
  out.sort((a, b) => b.storedAtMs - a.storedAtMs);
  return out;
}

/** The raw stored entry for a room, or null — no age enforcement (readers enforce it). */
function readRejoinToken(roomId: string): RejoinEntry | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(keyFor(roomId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as RejoinEntry).reconnectToken !== 'string' ||
      typeof (parsed as RejoinEntry).roomId !== 'string'
    ) {
      return null;
    }
    return parsed as RejoinEntry;
  } catch {
    return null;
  }
}

/** Remove just this room's stored entry (the sweep and the clear below build on it). */
function clearRejoinTokenOnly(roomId: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(keyFor(roomId));
  } catch {
    // Already gone or storage unavailable.
  }
}

function keyFor(roomId: string): string {
  return `${REJOIN_KEY_PREFIX}${roomId}`;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Mirror a live seat's reconnect token for rejoin-after-kill. Overwrites any entry for the room. */
export function storeRejoinToken(entry: Omit<RejoinEntry, 'storedAtMs'>): void {
  if (!isBrowser() || !entry.reconnectToken) return;
  try {
    window.localStorage.setItem(
      keyFor(entry.roomId),
      JSON.stringify({ ...entry, storedAtMs: Date.now() } satisfies RejoinEntry),
    );
  } catch {
    // Storage full / unavailable — rejoin-after-kill is lost, but the
    // live seat in sessionStorage keeps working for this tab.
  }
}

/** The stored rejoin entry for a room, or null. A stale entry (older than the 12 h max age) reads as null and is deleted. */
export function getRejoinToken(roomId: string): RejoinEntry | null {
  const entry = readRejoinToken(roomId);
  if (!entry) return null;
  if (isRejoinTokenStale(entry)) {
    clearRejoinTokenOnly(roomId);
    return null;
  }
  return entry;
}

/** The stored rejoin entry for a room code, or null (join-screen lookup). */
export function getRejoinTokenForCode(roomCode: string): RejoinEntry | null {
  const normalized = roomCode.trim().toUpperCase();
  return listRejoinTokens().find((e) => e.roomCode.toUpperCase() === normalized) ?? null;
}

/** Every stored rejoin entry on this device, newest first. Stale entries are deleted, never listed. */
export function listRejoinTokens(): RejoinEntry[] {
  const nowMs = Date.now();
  const out: RejoinEntry[] = [];
  for (const entry of listRejoinTokensRaw()) {
    if (isRejoinTokenStale(entry, nowMs)) {
      clearRejoinTokenOnly(entry.roomId);
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Clear the stored rejoin token for a room (leave / eject / match-end / room deleted). Also sweeps every other stale entry on the device, so a terminal room never leaves old tokens behind. */
export function clearRejoinToken(roomId: string): void {
  clearRejoinTokenOnly(roomId);
  sweepStaleRejoinTokens();
}

/** Clear every stored rejoin token (defensive; not used on the normal paths). */
export function clearAllRejoinTokens(): void {
  for (const entry of listRejoinTokens()) clearRejoinToken(entry.roomId);
}
