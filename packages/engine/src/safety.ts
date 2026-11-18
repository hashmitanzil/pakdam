import type { MatchPhase } from '@pakdam/shared';
import { canTransition } from './state-machine.js';
/** Safety rules (HNT-057–061). Any player may pause; SOS is NOT emergency dispatch. */
export const SOS_COPY = 'SOS alerts your host in this game. Pakdam is NOT an emergency service and does not call police or ambulance. If you are in danger, call your local emergency number.';
export function sosRecipients(): string { return 'host-only (Phase 0). Trusted-contact sharing is HNT-060 (P1) and is NOT pulled into Phase 0.'; }
/**
 * A safety pause is allowed exactly where the state machine allows
 * entering SAFETY_PAUSED: HEAD_START and ACTIVE. It is NOT allowed
 * in DRAFT/LOBBY/READY_CHECK/COUNTDOWN (no match clock running yet),
 * in RESOLVING (the match is already ending), or in any terminal
 * phase — an earlier version returned true for every phase, so a
 * caller could "pause" a lobby or a completed match. A match that is
 * already SAFETY_PAUSED reports true: the pause is already in
 * effect, so a repeat request is a harmless no-op, not an error.
 */
export function canSafetyPause(phase: MatchPhase | string): boolean {
  if (phase === 'SAFETY_PAUSED') return true;
  return canTransition(phase as MatchPhase, 'SAFETY_PAUSED');
}
