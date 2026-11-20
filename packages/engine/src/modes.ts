/**
 * Pakdam engine — modes (Classic + Infection) and win conditions.
 *
 * Only two modes exist. Breach/Zombie are not in `MatchMode` — do not re-add
 * them. A tagged Runner is OUT in Classic; in Infection a tagged Runner
 * FLIPS to the Hunters. Ejected players are out of play and never survivors,
 * in either mode — ejection removes a Runner exactly like a catch for win
 * purposes, but the record keeps them "ejected", not "caught".
 */
import type { MatchMode, MatchResult, MatchRole, MatchTag } from '@pakdam/shared';

/** Minimal seat shape the mode rules need (no coordinates, no tokens). */
export interface ModePlayer {
  playerId: string;
  /** Current role; null until roles are drawn at head start. */
  matchRole: MatchRole | null;
  /** Set = ejected (out of play, recorded as "ejected", not "caught"). */
  ejectedAt: string | null;
  /** Set = left the room (out of play). */
  leftAt: string | null;
}

/** A Runner is free (still in play) when they are a Runner, not caught, not ejected, not left. */
export function isRunnerFree(
  player: ModePlayer,
  caughtRunnerIds: ReadonlySet<string> | readonly string[],
): boolean {
  const caughtSet =
    caughtRunnerIds instanceof Set ? caughtRunnerIds : new Set(caughtRunnerIds);
  const caught = caughtSet.has(player.playerId);
  return (
    player.matchRole === 'runner' &&
    !caught &&
    player.ejectedAt === null &&
    player.leftAt === null
  );
}

/** Every Runner id on the roster (regardless of caught/ejected/left). */
export function runnerIds(players: readonly ModePlayer[]): string[] {
  return players.filter((p) => p.matchRole === 'runner').map((p) => p.playerId);
}

/** Free (still in play) Runner ids. */
export function freeRunnerIds(
  players: readonly ModePlayer[],
  caughtRunnerIds: ReadonlySet<string> | readonly string[],
): string[] {
  return players
    .filter((p) => isRunnerFree(p, caughtRunnerIds))
    .map((p) => p.playerId);
}

/**
 * Resolve the mode outcome. `timeExpired` does not change the outcome:
 * all Runners caught/ejected → Hunters win, else a surviving Runner →
 * Runners win. Duration is filled in by the caller (0 in this pure helper).
 * Ejected Runners count as out for win purposes but appear in neither the
 * caught list nor the surviving list of the result — they are recorded as
 * "ejected", not "caught".
 */
export function resolveModeOutcome(input: {
  mode: MatchMode;
  players: readonly ModePlayer[];
  caughtRunnerIds: readonly string[];
  /** Duration in seconds; 0 when the caller has not measured it yet. */
  durationSeconds?: number;
  /** Confirmed tags, oldest first; [] when the caller has none. */
  tags?: MatchTag[];
}): MatchResult {
  const caught = new Set(input.caughtRunnerIds);
  const free = freeRunnerIds(input.players, caught);
  const surviving = free;
  // The caught list IS the confirmed-catch set — do NOT filter it through
  // current-role runnerIds(). In Infection a tagged Runner flips to
  // Hunter (applyConfirmedTag), so filtering by "still a Runner" drops
  // every flipped Runner and a full sweep reports zero caught (D-1).
  // The input set is authoritative by construction at every call site
  // (confirmed catches only — ejected Runners are never in it, so they
  // still appear in neither list, as documented above).
  const caughtList = [...caught];
  return {
    outcome: free.length === 0 ? 'hunters-win' : 'runners-win',
    durationSeconds: input.durationSeconds ?? 0,
    caughtRunnerIds: caughtList,
    survivingRunnerIds: surviving,
    tags: input.tags ?? [],
  };
}

/** What applying a confirmed tag does to the tagged Runner, per mode. */
export type TagApplication =
  | {
      kind: 'out';
      /** Classic: the Runner is out; their role stays 'runner', now caught. */
      newRole: 'runner';
    }
  | {
      kind: 'flip';
      /** Infection: the Runner flips to the Hunters. */
      newRole: 'hunter';
    };

/**
 * Apply a confirmed tag to a Runner. Classic → out; Infection → flips to
 * Hunter. Returns the tag application (the caller applies it to the seat);
 * the win check is separate — see `maybeCompleteOnWin`.
 */
export function applyConfirmedTag(mode: MatchMode): TagApplication {
  return mode === 'infection' ? { kind: 'flip', newRole: 'hunter' } : { kind: 'out', newRole: 'runner' };
}

/**
 * Win check after a tag (or an ejection): if no Runner is left free, the
 * Hunters win and the match completes; otherwise play continues.
 * Returns the outcome when the match is over, else null.
 */
export function maybeCompleteOnWin(input: {
  mode: MatchMode;
  players: readonly ModePlayer[];
  caughtRunnerIds: readonly string[];
  durationSeconds?: number;
  /** Confirmed tags, oldest first; [] when the caller has none. */
  tags?: MatchTag[];
}): MatchResult | null {
  const outcome = resolveModeOutcome(input);
  return outcome.outcome === 'hunters-win' ? outcome : null;
}

/** Human-readable outcome label for the results screen. */
export function outcomeLabel(outcome: MatchResult['outcome']): string {
  switch (outcome) {
    case 'hunters-win':
      return 'Hunters win';
    case 'runners-win':
      return 'Runners win';
    case 'cancelled':
      return 'Match cancelled';
    case 'abandoned':
      return 'Match abandoned';
  }
}
