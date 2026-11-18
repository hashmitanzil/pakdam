import type { MatchPhase } from '@pakdam/shared';
/** Authoritative transitions. Only the server changes phase. */
const ALLOWED: Record<MatchPhase, MatchPhase[]> = {
  DRAFT: ['LOBBY', 'CANCELLED'],
  LOBBY: ['READY_CHECK', 'CANCELLED', 'EXPIRED'],
  READY_CHECK: ['COUNTDOWN', 'LOBBY', 'CANCELLED'],
  COUNTDOWN: ['HEAD_START', 'CANCELLED'],
  HEAD_START: ['ACTIVE', 'SAFETY_PAUSED', 'RESOLVING', 'CANCELLED'],
  ACTIVE: ['SAFETY_PAUSED', 'RESOLVING', 'CANCELLED', 'ABANDONED'],
  SAFETY_PAUSED: ['ACTIVE', 'HEAD_START', 'RESOLVING', 'CANCELLED', 'ABANDONED'],
  RESOLVING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [], CANCELLED: [], ABANDONED: [], EXPIRED: [],
};
export function canTransition(from: MatchPhase, to: MatchPhase): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}
export function transition(from: MatchPhase, to: MatchPhase): MatchPhase {
  if (!canTransition(from, to)) throw new Error(`INVALID_STATE: ${from} -> ${to} is not allowed`);
  return to;
}
export const TERMINAL_PHASES: MatchPhase[] = ['COMPLETED', 'CANCELLED', 'ABANDONED', 'EXPIRED'];
