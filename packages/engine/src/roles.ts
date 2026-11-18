import type { MatchRole, Player, Team, TeamAssignment } from '@pakdam/shared';
/** Balanced-Hunter table (location-first redesign, Nov 2026).
 *  3–4 players -> 1 Hunter; 5–8 -> 2; 9–16 -> 3; 17–24 -> 4;
 *  25–30 -> 5. That is the table the host screen shows ("2 for 6
 *  players, 3 for 16"). The ladder keeps the Hunter share roughly
 *  flat as the roster grows to the 30-player cap (founder, 2026-11-17),
 *  instead of leaving 30 players with the same 3 Hunters as 9.
 *  It is a starting point, NOT a measured value — calibration OPEN:
 *  field evidence (fairness, catch rates, match length) must replace
 *  it before any public pilot. */
export function balancedHunterCount(totalPlayers: number): number {
  if (totalPlayers <= 4) return 1;
  if (totalPlayers <= 8) return 2;
  if (totalPlayers <= 16) return 3;
  if (totalPlayers <= 24) return 4;
  return 5;
}
export interface RoleAssignmentOptions {
  /** 'random' (default): first `hunterCount` players by join order are
   *  Hunters. Deterministic in the demo so tests can assert it; the
   *  production server must shuffle instead of using join order.
   *  'selected': `selectedHunterIds` (exactly hunterCount, all joined
   *  players) are Hunters; everyone else is a Runner. */
  teamAssignment?: TeamAssignment;
  selectedHunterIds?: string[];
  /** True = draw the Hunters at random (Fisher–Yates shuffle with
   *  Math.random) instead of taking the first `hunterCount` in join
   *  order. The host screen sets this when "Random hunters" is ON.
   *  Default false: legacy join-order draw, which existing rooms
   *  rely on (the host is first, so the host is the Hunter). */
  shuffle?: boolean;
}
/** Assign match roles server-side. Host designation is separate (Player.isHost). */
export function assignRoles(players: Player[], hunterCount: number, opts: RoleAssignmentOptions = {}): Player[] {
  if (players.length < 3) throw new Error('INVALID_STATE: need at least 3 players');
  if (hunterCount < 1 || hunterCount >= players.length) throw new Error('VALIDATION_FAILED: hunterCount');
  const assignment = opts.teamAssignment ?? 'random';
  let hunterIds: Set<string>;
  if (assignment === 'selected') {
    const ids = opts.selectedHunterIds ?? [];
    if (ids.length !== hunterCount) throw new Error('VALIDATION_FAILED: selectedHunterIds must hold exactly hunterCount players');
    if (new Set(ids).size !== ids.length) throw new Error('VALIDATION_FAILED: selectedHunterIds must not repeat a player');
    const joined = new Set(players.map((p) => p.playerId));
    if (ids.some((id) => !joined.has(id))) throw new Error('VALIDATION_FAILED: selectedHunterIds must be joined players');
    hunterIds = new Set(ids);
  } else {
    // Random draw: shuffle the roster first so the Hunters are a real
    // random draw, not the first joiners. With shuffle off (default),
    // the legacy join-order draw is kept for the demo board.
    const order = [...players];
    if (opts.shuffle) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = order[i]!;
        order[i] = order[j]!;
        order[j] = tmp;
      }
    }
    hunterIds = new Set(order.slice(0, hunterCount).map((p) => p.playerId));
  }
  return players.map((p): Player => {
    const role: MatchRole = hunterIds.has(p.playerId) ? 'hunter' : 'runner';
    const team: Team = role === 'hunter' ? 'hunters' : 'runners';
    return { ...p, matchRole: role, team };
  });
}
