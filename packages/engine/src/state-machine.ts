/**
 * Pakdam engine — the 12-phase DO state machine.
 *
 * Pure transitions only: `(from, to) => next phase or a rejection with a
 * reason`. Only the server changes phase; an illegal edge is rejected with
 * `INVALID_STATE` (never silently applied). The match clock starts at
 * HEAD_START, not ACTIVE.
 *
 * The transition table itself lives in @pakdam/shared
 * (`MATCH_PHASE_TRANSITIONS` / `TERMINAL_PHASES`); this module is the
 * pure function that applies it.
 */
import {
  MATCH_PHASES,
  MATCH_PHASE_TRANSITIONS,
  TERMINAL_PHASES,
  type MatchPhase,
} from '@pakdam/shared';

export { MATCH_PHASES, MATCH_PHASE_TRANSITIONS, TERMINAL_PHASES };
export type { MatchPhase };

/** Result of attempting a phase transition. */
export type TransitionResult =
  | { ok: true; phase: MatchPhase }
  | { ok: false; reason: string; code: 'INVALID_STATE' };

/** Is `phase` terminal — no outgoing edge? */
export function isTerminalPhase(phase: MatchPhase): boolean {
  return (TERMINAL_PHASES as readonly MatchPhase[]).includes(phase);
}

/** Is `to` a legal edge out of `from`? */
export function canTransition(from: MatchPhase, to: MatchPhase): boolean {
  return (MATCH_PHASE_TRANSITIONS[from] as readonly MatchPhase[]).includes(to);
}

/**
 * Attempt a phase transition. Returns the next phase, or a rejection with
 * the plain-words reason (and the `INVALID_STATE` error code the DO throws).
 * A transition to the same phase is an ERROR, never a silent no-op
 * success: an illegal edge is rejected, never silently applied — callers
 * that already sit in the target phase must check first (or use the
 * idempotent operation for that phase, e.g. `pauseMatch` with the
 * existing pause state) instead of assuming the transition succeeded.
 */
export function transition(from: MatchPhase, to: MatchPhase): TransitionResult {
  if (from === to) {
    return {
      ok: false,
      code: 'INVALID_STATE',
      reason: `Already in ${from} — a transition to the same phase is not a no-op success.`,
    };
  }
  if (canTransition(from, to)) return { ok: true, phase: to };
  return {
    ok: false,
    code: 'INVALID_STATE',
    reason: `Cannot move from ${from} to ${to}.`,
  };
}

/** Like `transition`, but throws an `INVALID_STATE` error on an illegal edge. */
export function transitionOrThrow(from: MatchPhase, to: MatchPhase): MatchPhase {
  const result = transition(from, to);
  if (!result.ok) {
    const error = new Error(result.reason) as Error & { code: 'INVALID_STATE' };
    error.code = 'INVALID_STATE';
    throw error;
  }
  return result.phase;
}

/**
 * Named match events the DO alarm / handlers drive. `resume` needs the phase
 * the safety pause was taken from (`pausedFrom`) — resume never hard-codes
 * ACTIVE; it returns to the phase paused from.
 */
export type MatchEvent =
  | 'room-created'
  | 'start-requested'
  | 'countdown-complete'
  | 'head-start-elapsed'
  | 'match-end'
  | 'resolve-complete'
  | 'cancel'
  | 'abandon'
  | 'expire'
  | 'pause'
  | 'resume';

/**
 * Map a named event to its target phase, then apply `transition`.
 * `resume` resolves through `pausedFrom`; without it the event is rejected.
 */
export function transitionForEvent(
  from: MatchPhase,
  event: MatchEvent,
  pausedFrom?: MatchPhase | null,
): TransitionResult {
  switch (event) {
    case 'room-created':
      return transition(from, 'LOBBY');
    case 'start-requested':
      return transition(from, 'READY_CHECK');
    case 'countdown-complete':
      return transition(from, 'HEAD_START');
    case 'head-start-elapsed':
      return transition(from, 'ACTIVE');
    case 'match-end':
      return transition(from, 'RESOLVING');
    case 'resolve-complete':
      return transition(from, 'COMPLETED');
    case 'cancel':
      return transition(from, 'CANCELLED');
    case 'abandon':
      return transition(from, 'ABANDONED');
    case 'expire':
      return transition(from, 'EXPIRED');
    case 'pause':
      return transition(from, 'SAFETY_PAUSED');
    case 'resume': {
      if (pausedFrom === undefined || pausedFrom === null) {
        return {
          ok: false,
          code: 'INVALID_STATE',
          reason: 'Cannot resume: no paused-from phase was recorded.',
        };
      }
      return transition(from, pausedFrom);
    }
  }
}

/** Phases in which the match clock runs (the DO ticks every 1 s while live). */
export function isLivePhase(phase: MatchPhase): boolean {
  return phase === 'HEAD_START' || phase === 'ACTIVE' || phase === 'SAFETY_PAUSED';
}

/** Phases in which a match is running but not yet finished. */
export function isPlayPhase(phase: MatchPhase): boolean {
  return phase === 'HEAD_START' || phase === 'ACTIVE';
}
