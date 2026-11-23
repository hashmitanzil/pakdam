/**
 * Presence — the founder's 30-second rule (2026-11-22), client readers.
 *
 * Server contract (Kabir implements the server against the same
 * contract): each player in the snapshot carries
 * `reconnectEndsAtMs: number | null` (epoch ms when this seat's 30 s
 * return window ends; null when no window runs) and
 * `presence: 'present' | 'away'` ('away' = no live socket).
 *
 * The client NEVER computes a deadline itself and NEVER starts a
 * disconnect timer: every deadline below is read off the snapshot.
 * Reads are tolerant — a server that predates these fields reads as
 * "present / no window", exactly like `readHostGraceEndsAtMs`.
 *
 * The 30 s window is the ONE timer, everywhere: lobby (no kick — an
 * away seat stays on the roster), start (an absent player gets 30 s
 * to come back), mid-game disconnect and out-of-zone (same 30 s).
 * While away in the window the seat is frozen, not shielded (pings
 * continue, still taggable, no GPS ejection). A call on speaker while
 * staying on the page counts as present — the page is visible and the
 * socket is alive, so no window ever starts for that seat.
 */
import type { PlayerView } from '@pakdam/shared';
import { formatAgeLabel } from '@pakdam/shared';

export type PlayerPresence = 'present' | 'away';

/** The founder's return window, in ms. The server enforces it; the client only displays it. */
export const RECONNECT_WINDOW_MS = 30_000;

/** Tolerant read of `presence` off a player-shaped value. Absent / anything else reads as 'present'. */
export function readPlayerPresence(value: unknown): PlayerPresence {
  if (typeof value !== 'object' || value === null) return 'present';
  const raw = (value as { presence?: unknown }).presence;
  return raw === 'away' ? 'away' : 'present';
}

/** Tolerant read of `reconnectEndsAtMs` off a player-shaped value. Anything that is not a finite number reads as null (no window running). */
export function readReconnectEndsAtMs(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as { reconnectEndsAtMs?: unknown }).reconnectEndsAtMs;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** Whole seconds left in the return window, never negative. Null when no window is running. */
export function reconnectSecondsLeft(endsAtMs: number | null, nowMs: number): number | null {
  if (endsAtMs === null) return null;
  return Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));
}

/** `0:23` — the countdown shown for an away seat, or null when no window runs. */
export function formatReconnectCountdown(
  endsAtMs: number | null,
  nowMs: number,
): string | null {
  const left = reconnectSecondsLeft(endsAtMs, nowMs);
  return left === null ? null : formatAgeLabel(left);
}

/** True when this seat's return window has run out (server ejects at the same moment). */
export function isReconnectWindowExpired(endsAtMs: number | null, nowMs: number): boolean {
  if (endsAtMs === null) return false;
  return nowMs >= endsAtMs;
}

/** The away seats in a roster — shown, never removed. */
export function awayPlayers(players: PlayerView[]): PlayerView[] {
  return players.filter((p) => readPlayerPresence(p) === 'away');
}
