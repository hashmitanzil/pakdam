import type { MatchResult, Player } from '@pakdam/shared';
export function resolveOutcome(players: Player[], caughtRunnerIds: string[], timeExpired: boolean): MatchResult {
  // QA 2026-11-17 (GL-10): ejected players were counted as survivors
  // here (only leftAt was excluded). Kept for backwards compatibility
  // with scripts/simulate-match.ts; new code must use
  // resolveModeOutcome (modes.ts), which is mode-aware and excludes
  // ejected players. This helper is mode-blind by design of its
  // signature — do not use it for Infection outcomes.
  const runners = players.filter((p) => p.matchRole === 'runner' && !p.leftAt && !p.ejectedAt);
  const survivors = runners.filter((r) => !caughtRunnerIds.includes(r.playerId)).map((r) => r.playerId);
  // timeExpired does not change the outcome: all Runners caught means
  // Hunters win, otherwise a surviving Runner means Runners win.
  void timeExpired;
  const outcome = survivors.length === 0 ? 'hunters-win' : 'runners-win';
  return { outcome, durationSeconds: 0, caughtRunnerIds, survivingRunnerIds: survivors };
}

// --- Leaderboard points (founder checklist, 2026-11-17) -----------------
// Monthly leaderboards, opt-in only. Points per completed match:
//   +1 per 3 minutes free (Runner time uncaught — for a caught Runner,
//     free time stops at the tag; for a never-caught Runner it is the
//     full match)
//   +10 never caught (a Runner still free at match end — not caught
//     AND not ejected; an ejected Runner did not stay free)
//   +3 per tag (each confirmed tag, to the Hunter who made it)
//   +10 clean sweep (every Hunter on the winning side, when every
//     Runner was caught)
// These are fixed founder rules, NOT calibration placeholders. The
// engine only computes points from match records the caller supplies
// (free seconds, confirmed tags); it never invents them.
export const POINTS_PER_FREE_3_MIN = 1;
export const POINTS_NEVER_CAUGHT = 10;
export const POINTS_PER_TAG = 3;
export const POINTS_CLEAN_SWEEP = 10;
/** Whole 3-minute blocks of free time. Partial blocks earn nothing. */
export const FREE_POINTS_INTERVAL_SECONDS = 180;

/** A clean sweep needs every Runner CAUGHT: ejected Runners are out,
 *  not caught, so they break the sweep. Same definition as the results
 *  screen. In Infection a turned Runner counts as caught (the tag
 *  confirmed), so the caller passes the turned ids as caught ids. */
export function isCleanSweep(players: Player[], caughtRunnerIds: string[]): boolean {
  const runners = players.filter((p) => p.matchRole === 'runner' || caughtRunnerIds.includes(p.playerId));
  if (runners.length === 0) return false;
  if (players.some((p) => p.matchRole === 'runner' && p.ejectedAt)) return false;
  return runners.every((r) => caughtRunnerIds.includes(r.playerId));
}

export interface PlayerPointsInput {
  playerId: string;
  /** Role at match end (a turned Infection Runner ends as 'hunter'). */
  matchRole: 'hunter' | 'runner';
  /** Seconds the player spent free as a Runner (0 for a Hunter who
   *  started as one; stops at the tag for a caught Runner). */
  freeSeconds: number;
  /** Confirmed tags this player made (0 for Runners). */
  tags: number;
  /** True when the player was caught/turned by a confirmed tag. */
  caught: boolean;
  /** True when the player was ejected (outside-zone countdown). */
  ejected: boolean;
}
export interface PlayerPoints {
  playerId: string;
  points: number;
  freeMinutesPoints: number;
  neverCaughtBonus: number;
  tagPoints: number;
  cleanSweepBonus: number;
}
/** Points for one completed match. `cleanSweep` is the isCleanSweep
 *  result for the match — pass it in so the caller, not this helper,
 *  decides what counts as a sweep. Call only for completed matches
 *  (cancelled/abandoned matches earn no points). */
export function computeMatchPoints(inputs: PlayerPointsInput[], cleanSweep: boolean): PlayerPoints[] {
  return inputs.map((p) => {
    const freeSeconds = Math.max(0, p.freeSeconds);
    const tags = Math.max(0, p.tags);
    const freeMinutesPoints = Math.floor(freeSeconds / FREE_POINTS_INTERVAL_SECONDS) * POINTS_PER_FREE_3_MIN;
    // Never caught: a Runner still free at the end — not caught and
    // not ejected. A turned Infection Runner was caught, so no bonus.
    const neverCaughtBonus = p.matchRole === 'runner' && !p.caught && !p.ejected ? POINTS_NEVER_CAUGHT : 0;
    const tagPoints = p.matchRole === 'hunter' ? tags * POINTS_PER_TAG : 0;
    const cleanSweepBonus = cleanSweep && p.matchRole === 'hunter' ? POINTS_CLEAN_SWEEP : 0;
    return {
      playerId: p.playerId,
      points: freeMinutesPoints + neverCaughtBonus + tagPoints + cleanSweepBonus,
      freeMinutesPoints, neverCaughtBonus, tagPoints, cleanSweepBonus,
    };
  });
}
