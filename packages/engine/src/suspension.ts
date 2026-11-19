/**
 * Pakdam engine — suspension rules.
 *
 * What suspension is: a suspended player is "location unknown", never live;
 * the TIMER keeps running; a pending catch CANNOT complete while the Runner
 * is suspended (no auto-confirm); the suspension count is recorded per
 * player and visible to the host.
 *
 * How a seat becomes suspended: tab hidden / phone locks (client sends a
 * best-effort `player.suspended`), socket close (server marks it), or a
 * missed-heartbeat limit. How it resumes — P0-1, DO NOT LOSE: the DO
 * resumes a suspended player on `hello`/reconnect; the demo path resumes on
 * catch-page arrival and on tab-visible again.
 *
 * Do NOT auto-punish suspension, and do NOT let it become a free
 * competitive escape.
 */
import {
  SUSPENSIONS_BEFORE_HOST_CHECKIN,
  type ConnectionState,
  type SuspensionReason,
} from '@pakdam/shared';

export { SUSPENSIONS_BEFORE_HOST_CHECKIN };
export type { SuspensionReason };

/** Minimal seat shape the suspension rules need. */
export interface SuspendablePlayer {
  playerId: string;
  connectionState: ConnectionState;
  suspensionCount: number;
  lastFixAt: string | null;
}

/** Does this suspension count raise a host check-in? (≥ 3, OPEN.) */
export function suspensionNeedsHostCheckin(suspensionCount: number): boolean {
  return suspensionCount >= SUSPENSIONS_BEFORE_HOST_CHECKIN;
}

/**
 * Record a suspension: connection becomes 'suspended', the count increments,
 * and the caller learns whether the host must now check in on this player.
 * The timer keeps running; nothing else about the seat changes.
 */
export function recordSuspension<T extends SuspendablePlayer>(
  player: T,
  _reason: SuspensionReason,
): { player: T; needsHostCheckin: boolean } {
  const next = {
    ...player,
    connectionState: 'suspended' as ConnectionState,
    suspensionCount: player.suspensionCount + 1,
  };
  return {
    player: next,
    needsHostCheckin: suspensionNeedsHostCheckin(next.suspensionCount),
  };
}

/**
 * Mark a seat suspended on socket close. Same as `recordSuspension` — the
 * server marks the seat and broadcasts `player.suspended` to the room.
 */
export function suspendOnSocketClose<T extends SuspendablePlayer>(
  player: T,
): { player: T; needsHostCheckin: boolean } {
  return recordSuspension(player, 'network-lost');
}

export interface SuspensionResumeResult<T> {
  /** True only when a suspended player was actually resumed. */
  resumed: boolean;
  player: T;
}

/**
 * Resume a suspended player on hello / reconnect (P0-1). The DO resumes
 * the seat when its socket (re)connects after a valid hello; the demo path
 * resumes on catch-page arrival and on tab-visible. A no-op when the seat
 * is unknown or not suspended. The suspension count STAYS on the record;
 * the player is location-known again (a fresh fix refreshes `lastFixAt`)
 * and the timer kept running while they were away.
 */
export function resumeSuspendedPlayer<T extends SuspendablePlayer>(
  player: T,
  nowMs: number,
): SuspensionResumeResult<T> {
  if (player.connectionState !== 'suspended') {
    return { resumed: false, player };
  }
  return {
    resumed: true,
    player: {
      ...player,
      connectionState: 'connected' as ConnectionState,
      lastFixAt: new Date(nowMs).toISOString(),
    },
  };
}

/** Can a pending catch complete while this Runner is suspended? Never. */
export function canCompleteCatchWhileSuspended(player: SuspendablePlayer): boolean {
  return player.connectionState !== 'suspended';
}

/** Is this seat suspended ("location unknown")? */
export function isSuspended(player: SuspendablePlayer): boolean {
  return player.connectionState === 'suspended';
}
