import type { MatchMode, MatchResult, Player } from '@pakdam/shared';

/**
 * Game modes — engine rules, not UI labels. All copy below is Pakdam's
 * own wording; no competitor text, code, or brand is used. Only two
 * modes exist in the pilot (founder decision, 2026-11-17): Classic
 * Manhunt and Infection. Breach and Zombie are later, not now — they
 * are not in MatchMode, not in MODE_INFO, and no mode helper knows
 * them. Do not re-add them without a founder decision.
 *
 * - Classic: a tagged Runner is OUT (watches live). Hunters win when
 *   every Runner is caught; Runners win if any survive the clock.
 * - Infection: a tagged Runner JOINS the Hunters (role flips). Hunters
 *   win when no Runner is left; Runners win if any survive the clock.
 */
export interface ModeInfo {
  label: string; short: string; catchRule: string; winRule: string;
}
export const MODE_INFO: Record<MatchMode, ModeInfo> = {
  classic: {
    label: 'Classic Manhunt',
    short: 'Tagged Runners are out.',
    catchRule: 'A tagged Runner is out of the game and watches live. A catch counts only when the Runner confirms it on their own phone (unless the host turned confirmation off).',
    winRule: 'Hunters win when every Runner is caught. Runners win if even one survives the clock.',
  },
  infection: {
    label: 'Infection',
    short: 'Tagged Runners join the Hunters.',
    catchRule: 'A tagged Runner becomes a Hunter and hunts their old team. A catch counts only when the Runner confirms it on their own phone (unless the host turned confirmation off).',
    winRule: 'Hunters win when no Runner is left. Runners win if even one survives the clock.',
  },
};
export function describeMode(mode: MatchMode): ModeInfo { return MODE_INFO[mode]; }
/** True when a confirmed tag flips the Runner to the Hunters' side. */
export function modeTurnsRunner(mode: MatchMode): boolean { return mode === 'infection'; }

export interface TagOutcome {
  players: Player[];
  /** Runner id when the tag puts the Runner out (Classic). */
  caughtRunnerId: string | null;
  /** Runner id when the tag turns the Runner into a Hunter (Infection). */
  turnedHunterId: string | null;
}
/** Apply one CONFIRMED tag under the room's mode. Classic leaves
 *  roles alone (the caller records the Runner as caught); Infection
 *  flips the Runner to Hunter. The caller still records the catch
 *  event either way. Throws when the Runner is not a Runner. */
export function applyConfirmedTag(players: Player[], runnerId: string, mode: MatchMode): TagOutcome {
  const runner = players.find((p) => p.playerId === runnerId);
  if (!runner) throw new Error('INVALID_STATE: tagged player is not in this room');
  if (runner.matchRole !== 'runner') throw new Error('INVALID_STATE: only a Runner can be tagged');
  if (!modeTurnsRunner(mode)) return { players, caughtRunnerId: runnerId, turnedHunterId: null };
  const next = players.map((p) => (p.playerId === runnerId ? { ...p, matchRole: 'hunter' as const, team: 'hunters' as const } : p));
  return { players: next, caughtRunnerId: null, turnedHunterId: runnerId };
}

/** Mode-aware outcome. `caughtRunnerIds` are the confirmed Classic
 *  catches; for Infection the flipped roles already carry the
 *  truth, so the list is ignored. `timeExpired` ends the round in the
 *  Runners' favour unless no Runner is left at all. An EJECTED player
 *  (ejectedAt set — outside the play zone past the 30-second return
 *  countdown) is out of play and never a survivor, in either mode:
 *  ejection removes a Runner from the game exactly like a catch does
 *  for win purposes, but the record keeps them as "ejected", not
 *  "caught" — the results screen tells the two apart. */
export function resolveModeOutcome(players: Player[], caughtRunnerIds: string[], timeExpired: boolean, mode: MatchMode): MatchResult {
  const active = players.filter((p) => !p.leftAt && !p.ejectedAt);
  if (modeTurnsRunner(mode)) {
    const runnersLeft = active.filter((p) => p.matchRole === 'runner').map((p) => p.playerId);
    const outcome = runnersLeft.length === 0 ? 'hunters-win' : 'runners-win';
    return { outcome, durationSeconds: 0, caughtRunnerIds, survivingRunnerIds: runnersLeft };
  }
  const runners = active.filter((p) => p.matchRole === 'runner');
  const survivors = runners.filter((r) => !caughtRunnerIds.includes(r.playerId)).map((r) => r.playerId);
  const outcome = survivors.length === 0 ? 'hunters-win' : 'runners-win';
  void timeExpired; // same result either way: all caught wins, else surviving Runners win
  return { outcome, durationSeconds: 0, caughtRunnerIds, survivingRunnerIds: survivors };
}
