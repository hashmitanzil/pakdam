/**
 * Pakdam engine — host-controlled teams.
 *
 * Teams are host-controlled, never self-picked. Balance ON (default) sets
 * the Hunter count from the roster at start (3–4 → 1, 5–8 → 2, 9–16 → 3,
 * 17–24 → 4, 25–30 → 5); Balance OFF lets the host pick a count with a
 * stepper. Random ON (default) draws Hunters at random (Fisher–Yates);
 * Random OFF lets the host tap roster names to pick them. Roles are drawn
 * once, at head start, and never re-drawn.
 *
 * The balance table itself lives in @pakdam/shared (`BALANCED_HUNTER_TABLE`
 * / `balancedHunterCount`); this module applies the host toggles around it.
 */
import {
  BALANCED_HUNTER_TABLE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  balancedHunterCount,
  type MatchRole,
  type Team,
  type TeamAssignment,
} from '@pakdam/shared';

export { BALANCED_HUNTER_TABLE, balancedHunterCount };

/** Minimal seat shape role assignment needs. */
export interface RolePlayer {
  playerId: string;
}

/** Host toggles that decide how roles are drawn. */
export interface RoleDrawOptions {
  /** Balance ON: Hunter count comes from the roster size. OFF: host stepper. */
  balanceHunters: boolean;
  /** Random ON: Hunters are drawn at random. OFF: host taps roster names. */
  randomDraw: boolean;
  /** 'random' | 'selected' team assignment from the room config. */
  teamAssignment: TeamAssignment;
  /** Host-picked Hunter count (stepper value); used when Balance is OFF. */
  hostHunterCount: number;
  /** Host-picked Hunter ids; used when Random is OFF / assignment 'selected'. */
  selectedHunterIds: readonly string[];
  /**
   * The Hunter count the host pick was made against. When Balance later
   * changes the effective count, a pick that matched this count is stale —
   * the start draws at random instead of blocking. A pick that never
   * matched this count is genuinely short and is rejected. Defaults to the
   * effective Hunter count (i.e. the pick was made against the current count).
   */
  pickHunterCount?: number;
  /**
   * Random source (defaults to `Math.random`). Pass a seeded function in
   * tests / the demo so a draw is reproducible.
   */
  random?: () => number;
}

export type AssignRolesResult =
  | {
      ok: true;
      /** Hunter count actually drawn (balance-derived or host-picked). */
      hunterCount: number;
      hunterIds: string[];
      runnerIds: string[];
      /** Role + team per seat. */
      assignments: Record<string, { matchRole: MatchRole; team: Team }>;
    }
  | { ok: false; reason: string };

/**
 * Effective Hunter count for a roster: Balance ON reads the table from the
 * roster size; Balance OFF uses the host's stepper value (clamped to
 * 1..rosterSize−1).
 */
export function resolveHunterCount(input: {
  balanceHunters: boolean;
  rosterSize: number;
  hostHunterCount: number;
}): number {
  if (input.balanceHunters) return balancedHunterCount(input.rosterSize);
  // Clamped to at least 1 Hunter: the host's chosen count is honoured
  // as-is above that floor (a count of 0 or negative is clamped to 1,
  // not silently reduced from a larger choice). A count that leaves no
  // Runner is rejected by the caller (assignRoles) with a plain-words
  // reason, and by the client start gate before that.
  return Math.max(1, Math.floor(input.hostHunterCount));
}

/**
 * Validate a host-picked Hunter list: exactly `hunterCount` ids, all joined,
 * no repeats. Returns the problem in plain words, or null when the pick is
 * valid. A pick that matched the stored `hunterCount` when made never blocks
 * the start even if Balance later changed the effective count — the caller
 * then draws at random instead (see `assignRoles`).
 */
export function validateSelectedHunters(input: {
  selectedHunterIds: readonly string[];
  hunterCount: number;
  joinedPlayerIds: readonly string[];
}): string | null {
  const joined = new Set(input.joinedPlayerIds);
  const unique = new Set(input.selectedHunterIds);
  if (unique.size !== input.selectedHunterIds.length) {
    return 'The same player was picked twice.';
  }
  if (input.selectedHunterIds.length !== input.hunterCount) {
    return `Pick exactly ${input.hunterCount} Hunter${input.hunterCount === 1 ? '' : 's'}.`;
  }
  for (const id of input.selectedHunterIds) {
    if (!joined.has(id)) return 'A picked Hunter is no longer in the room.';
  }
  return null;
}

/** Fisher–Yates shuffle of a copy, using the injected random source. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j] as T;
    copy[j] = tmp as T;
  }
  return copy;
}

/**
 * Draw roles once, at head start. Needs ≥ MIN_PLAYERS players; `hunterCount` 1..n−1.
 * - `teamAssignment 'selected'` (Random OFF): exactly `hunterCount` picked
 *   ids, all joined, no repeats. A genuinely short/stale pick is rejected;
 *   a pick whose count no longer matches the balance-derived count falls
 *   back to a random draw instead of blocking the start.
 * - `teamAssignment 'random'` (Random ON): Fisher–Yates shuffle, first
 *   `hunterCount` seats are Hunters.
 * Never re-drawn: call this once per match.
 */
export function assignRoles(
  players: readonly RolePlayer[],
  options: RoleDrawOptions,
): AssignRolesResult {
  const ids = players.map((p) => p.playerId);
  if (ids.length < MIN_PLAYERS) {
    return { ok: false, reason: `Need at least ${MIN_PLAYERS} players to start.` };
  }
  if (ids.length > MAX_PLAYERS) {
    return { ok: false, reason: `A room holds at most ${MAX_PLAYERS} players.` };
  }
  const hunterCount = resolveHunterCount({
    balanceHunters: options.balanceHunters,
    rosterSize: ids.length,
    hostHunterCount: options.hostHunterCount,
  });
  if (hunterCount < 1 || hunterCount > ids.length - 1) {
    return { ok: false, reason: 'Hunter count must leave at least one Runner.' };
  }

  let hunterIds: string[];
  if (options.teamAssignment === 'selected') {
    const problem = validateSelectedHunters({
      selectedHunterIds: options.selectedHunterIds,
      hunterCount,
      joinedPlayerIds: ids,
    });
    if (problem === null) {
      hunterIds = [...options.selectedHunterIds];
    } else if (
      options.selectedHunterIds.length > 0 &&
      options.selectedHunterIds.length === (options.pickHunterCount ?? hunterCount) &&
      (options.pickHunterCount ?? hunterCount) !== hunterCount &&
      options.selectedHunterIds.every((id) => ids.includes(id)) &&
      new Set(options.selectedHunterIds).size === options.selectedHunterIds.length
    ) {
      // Stale pick: it matched the stored hunterCount when made, but Balance
      // changed the effective count since. Draw at random instead of blocking.
      hunterIds = shuffled(ids, options.random).slice(0, hunterCount);
    } else {
      return { ok: false, reason: problem };
    }
  } else {
    hunterIds = shuffled(ids, options.random).slice(0, hunterCount);
  }

  const hunterSet = new Set(hunterIds);
  const runnerIds = ids.filter((id) => !hunterSet.has(id));
  const assignments: Record<string, { matchRole: MatchRole; team: Team }> = {};
  for (const id of ids) {
    assignments[id] = hunterSet.has(id)
      ? { matchRole: 'hunter', team: 'hunters' }
      : { matchRole: 'runner', team: 'runners' };
  }
  return { ok: true, hunterCount, hunterIds, runnerIds, assignments };
}

/**
 * Switching to Random clears the host pick; changing hunter count or team
 * assignment clears it too. Returns the cleared pick (always `[]`).
 */
export function clearSelectedHunters(): string[] {
  return [];
}
