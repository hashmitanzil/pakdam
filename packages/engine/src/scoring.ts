/**
 * Pakdam engine — scoring (completed matches only).
 *
 * Fixed founder rules, NOT calibration:
 * - Runner +1 per whole 3 min free (free time stops at the tag).
 * - Runner +10 never caught (still free at end — not caught AND not
 *   ejected; a turned Infection Runner was caught).
 * - Hunter +3 per confirmed tag (to the Hunter who made it).
 * - Hunter +10 clean sweep to every Hunter on the winning side, when every
 *   Runner was caught (ejected Runners break the sweep).
 * - A flipped Infection Runner KEEPS the Runner free-time points earned
 *   before the flip (free time stops at the flip/tag, it does not vanish)
 *   and earns Hunter tag points for tags made after flipping — the two
 *   parts add. `ScoringPlayer.wasRunner` carries "was a Runner at any
 *   point"; the caller (DO `resultsFor`) must set it from the catch /
 *   ejection record, because the final `matchRole` alone cannot tell a
 *   flipped Runner from a born Hunter.
 * Only completed matches earn points. The leaderboard itself is
 * device-local; this module computes the points, nothing more.
 */
import {
  SCORING_CLEAN_SWEEP,
  SCORING_HUNTER_PER_TAG,
  SCORING_RUNNER_NEVER_CAUGHT,
  SCORING_RUNNER_PER_3_MIN_FREE,
  type MatchResult,
} from '@pakdam/shared';

export {
  SCORING_CLEAN_SWEEP,
  SCORING_HUNTER_PER_TAG,
  SCORING_RUNNER_NEVER_CAUGHT,
  SCORING_RUNNER_PER_3_MIN_FREE,
};

/** Seconds of free time that earn one Runner point. */
export const RUNNER_FREE_SECONDS_PER_POINT = 180;

/** Minimal per-player scoring input (no coordinates, no tokens). */
export interface ScoringPlayer {
  playerId: string;
  /** Role at match end (an Infection flip changes this to 'hunter'). */
  matchRole: 'hunter' | 'runner' | null;
  /**
   * True when this player was a Runner at any point in the match (still
   * a Runner at the end, caught as a Runner, or ejected as a Runner).
   * The caller MUST set this: `freeSeconds` is the Runner free time and
   * must be scored even when the final role is 'hunter' (flipped). When
   * omitted, the old rule applies (`matchRole === 'runner'` only) — kept
   * for back-compat, not for new callers.
   */
  wasRunner?: boolean;
  /** Seconds this Runner was free (stops at the tag/flip; whole match if never caught). */
  freeSeconds: number;
  /** Was this Runner caught (confirmed tag)? */
  caught: boolean;
  /** Was this Runner ejected (out, but recorded as "ejected", not "caught")? */
  ejected: boolean;
  /** Confirmed tags this Hunter made. */
  tagsMade: number;
}

/** Did this player earn Runner points (was a Runner at any point)? */
function earnsRunnerPoints(player: ScoringPlayer): boolean {
  return player.wasRunner ?? player.matchRole === 'runner';
}

/**
 * Is this a clean sweep? Every Runner was caught (none ejected, none
 * surviving) and the Hunters won. Ejected Runners break the sweep.
 * CALLER CONTRACT: `ejectedRunnerIds` must contain ONLY ejected
 * Runners — an ejected Hunter in the list would falsely break the sweep.
 * The DO's `resultsFor` filters to Runners at ejection before calling;
 * this function cannot tell roles from ids alone.
 */
export function isCleanSweep(input: {
  result: MatchResult;
  ejectedRunnerIds: readonly string[];
}): boolean {
  if (input.result.outcome !== 'hunters-win') return false;
  if (input.ejectedRunnerIds.length > 0) return false;
  if (input.result.survivingRunnerIds.length > 0) return false;
  if (input.result.caughtRunnerIds.length === 0) return false;
  return true;
}

/** Points for one Runner: +1 per whole 3 min free, +10 if never caught. A flipped Runner still earns these (free time stops at the flip). */
export function runnerScore(player: ScoringPlayer): number {
  if (!earnsRunnerPoints(player)) return 0;
  let points = Math.floor(Math.max(0, player.freeSeconds) / RUNNER_FREE_SECONDS_PER_POINT) * SCORING_RUNNER_PER_3_MIN_FREE;
  if (!player.caught && !player.ejected) {
    points += SCORING_RUNNER_NEVER_CAUGHT;
  }
  return points;
}

/** Points for one Hunter: +3 per confirmed tag, +10 clean sweep when it applies. */
export function hunterScore(
  player: ScoringPlayer,
  cleanSweep: boolean,
  huntersWon: boolean,
): number {
  if (player.matchRole !== 'hunter') return 0;
  let points = Math.max(0, player.tagsMade) * SCORING_HUNTER_PER_TAG;
  if (cleanSweep && huntersWon) points += SCORING_CLEAN_SWEEP;
  return points;
}

/** Points for one player in a completed match (0 when the match never completed). A flipped Runner earns BOTH parts: Runner free-time points (before the flip) + Hunter tag points (after it). */
export function scorePlayer(
  player: ScoringPlayer,
  context: { result: MatchResult | null; cleanSweep: boolean },
): number {
  if (context.result === null) return 0;
  const huntersWon = context.result.outcome === 'hunters-win';
  let points = 0;
  if (earnsRunnerPoints(player)) points += runnerScore(player);
  if (player.matchRole === 'hunter') points += hunterScore(player, context.cleanSweep, huntersWon);
  return points;
}

export interface ScoreBreakdown {
  playerId: string;
  points: number;
  /** Whole 3-min blocks free (Runner). */
  freeBlocks: number;
  /** Never-caught bonus applied (Runner). */
  neverCaughtBonus: boolean;
  /** Confirmed tags made (Hunter). */
  tagsMade: number;
  /** Clean-sweep bonus applied (Hunter). */
  cleanSweepBonus: boolean;
}

/**
 * Score a completed match. Returns 0 for every player (with empty
 * breakdowns) when the match has no result — only completed matches earn
 * points.
 */
export function scoreMatch(input: {
  players: readonly ScoringPlayer[];
  result: MatchResult | null;
  ejectedRunnerIds: readonly string[];
}): { scores: Record<string, number>; breakdown: ScoreBreakdown[] } {
  const scores: Record<string, number> = {};
  const breakdown: ScoreBreakdown[] = [];
  if (input.result === null) {
    for (const p of input.players) {
      scores[p.playerId] = 0;
      breakdown.push({
        playerId: p.playerId,
        points: 0,
        freeBlocks: 0,
        neverCaughtBonus: false,
        tagsMade: 0,
        cleanSweepBonus: false,
      });
    }
    return { scores, breakdown };
  }
  const cleanSweep = isCleanSweep({
    result: input.result,
    ejectedRunnerIds: input.ejectedRunnerIds,
  });
  const huntersWon = input.result.outcome === 'hunters-win';
  for (const p of input.players) {
    const points = scorePlayer(p, { result: input.result, cleanSweep });
    const isRunner = earnsRunnerPoints(p);
    const freeBlocks = isRunner
      ? Math.floor(Math.max(0, p.freeSeconds) / RUNNER_FREE_SECONDS_PER_POINT)
      : 0;
    scores[p.playerId] = points;
    breakdown.push({
      playerId: p.playerId,
      points,
      freeBlocks,
      neverCaughtBonus: isRunner && !p.caught && !p.ejected,
      tagsMade: p.matchRole === 'hunter' ? Math.max(0, p.tagsMade) : 0,
      cleanSweepBonus: p.matchRole === 'hunter' && cleanSweep && huntersWon,
    });
  }
  return { scores, breakdown };
}
