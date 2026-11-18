import type { Player } from '@pakdam/shared';
/**
 * v2.1 Issue 3 — suspension fairness. Do NOT auto-punish suspension, and
 * do NOT let it become a free competitive escape.
 * - Timer keeps running; a suspended player is "location unknown", never live.
 * - A pending catch cannot complete while the Runner is suspended (no auto-confirm).
 * - Repeated suspension (>= threshold) raises a host check-in: the host must
 *   confirm the player is accounted for; the host may safety-pause the match.
 * - Suspension count is recorded per player and visible to the host.
 */
export interface SuspensionOutcome { suspended: boolean; hostCheckinRequired: boolean; reason: string }
export function recordSuspension(p: Player, threshold: number): { player: Player; outcome: SuspensionOutcome } {
  const count = p.suspensionCount + 1;
  const player: Player = { ...p, suspensionCount: count, connectionState: 'suspended' };
  const required = count >= threshold;
  return { player, outcome: { suspended: true, hostCheckinRequired: required, reason: required ? `Player suspended ${count} times — host check-in required` : `Player suspended (${count}) — location unknown, timer continues` } };
}
export function canCompleteCatchWhileRunnerSuspended(): boolean { return false; }
