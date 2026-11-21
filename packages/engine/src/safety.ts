/**
 * Pakdam engine — safety rules.
 *
 * Any player may pause the match; the host resumes. A pause only blocks
 * play, never deletes state: the clock freezes, and resume returns to the
 * phase paused from (never hard-codes ACTIVE) with the deadlines shifted
 * forward by the pause.
 *
 * v18: SOS was REMOVED entirely (founder decision). There is no SOS
 * state, no SOS copy, no SOS handler — do not re-add one. The safety
 * pause / resume below is unchanged and STAYS.
 *
 * "I'm safe" check-in travels as an announcement; there is no command for it.
 */
import { type MatchPhase, type SafetyState } from '@pakdam/shared';

/**
 * Can a safety pause start from this phase? Allowed exactly where the state
 * machine allows entering SAFETY_PAUSED — HEAD_START and ACTIVE (plus
 * already-paused, a harmless no-op). NOT in DRAFT/LOBBY/READY_CHECK/
 * COUNTDOWN (no match clock running yet), RESOLVING, or any terminal phase.
 */
export function canSafetyPause(phase: MatchPhase): boolean {
  return phase === 'HEAD_START' || phase === 'ACTIVE' || phase === 'SAFETY_PAUSED';
}

/** Is a safety pause allowed to start (not already paused) from this phase? */
export function canStartSafetyPause(phase: MatchPhase): boolean {
  return phase === 'HEAD_START' || phase === 'ACTIVE';
}

export type PauseResult =
  | {
      ok: true;
      phase: 'SAFETY_PAUSED';
      /** The phase to return to on resume. */
      pausedFrom: MatchPhase;
      pausedAt: string;
    }
  | { ok: false; reason: string; code: 'INVALID_STATE' };

/**
 * Start a safety pause. Records `pausedAt` + `pausedFrom`; the clock
 * freezes. A pause from an already-paused phase is an idempotent no-op:
 * when the caller passes the existing pause state it is returned
 * unchanged (same `pausedFrom`, same `pausedAt` — never re-stamped, never
 * hard-coded to 'ACTIVE'); without it the call is rejected, because the
 * existing state is the only honest answer. Callers (the DO's
 * `doSafetyPause`) must pass the stored `pausedFrom`/`pausedAt` and must
 * not overwrite them when already paused.
 */
export function pauseMatch(
  phase: MatchPhase,
  byPlayerId: string,
  nowMs: number,
  existing?: { pausedFrom: MatchPhase; pausedAt: string } | null,
): PauseResult & { pausedBy: string } {
  if (phase === 'SAFETY_PAUSED') {
    if (existing !== undefined && existing !== null) {
      return {
        ok: true,
        phase: 'SAFETY_PAUSED',
        pausedFrom: existing.pausedFrom,
        pausedAt: existing.pausedAt,
        pausedBy: byPlayerId,
      };
    }
    return {
      ok: false,
      code: 'INVALID_STATE',
      reason:
        'The match is already paused — pass the existing pausedFrom/pausedAt to confirm the pause instead of starting a new one.',
      pausedBy: byPlayerId,
    };
  }
  if (!canStartSafetyPause(phase)) {
    return {
      ok: false,
      code: 'INVALID_STATE',
      reason: `Cannot pause the match from ${phase} — no match clock is running yet.`,
      pausedBy: byPlayerId,
    };
  }
  return {
    ok: true,
    phase: 'SAFETY_PAUSED',
    pausedFrom: phase,
    pausedAt: new Date(nowMs).toISOString(),
    pausedBy: byPlayerId,
  };
}

export type ResumeResult =
  | {
      ok: true;
      /** The phase paused from — resume returns here, never hard-codes ACTIVE. */
      phase: MatchPhase;
      /** Deadlines shifted forward by the pause duration. */
      startedAt: string | null;
      endsAt: string | null;
    }
  | { ok: false; reason: string; code: 'INVALID_STATE' };

/**
 * Shift an ISO deadline forward by `pauseDurationMs`. Null deadlines stay
 * null. While paused, reads project the deadlines forward by the same rule.
 */
export function shiftDeadlineForward(
  deadline: string | null,
  pauseDurationMs: number,
): string | null {
  if (deadline === null) return null;
  return new Date(Date.parse(deadline) + pauseDurationMs).toISOString();
}

/**
 * Resume from a safety pause. Returns to the phase paused from and shifts
 * `startedAt`/`endsAt` forward by the pause, so a paused room cannot reach
 * its deadlines. Nothing completes while safety-paused.
 */
export function resumeMatch(input: {
  phase: MatchPhase;
  pausedFrom: MatchPhase | null;
  pausedAt: string | null;
  startedAt: string | null;
  endsAt: string | null;
  nowMs: number;
}): ResumeResult {
  if (input.phase !== 'SAFETY_PAUSED') {
    return {
      ok: false,
      code: 'INVALID_STATE',
      reason: `Cannot resume — the match is not paused (phase is ${input.phase}).`,
    };
  }
  if (input.pausedFrom === null) {
    return {
      ok: false,
      code: 'INVALID_STATE',
      reason: 'Cannot resume: no paused-from phase was recorded.',
    };
  }
  const pauseDurationMs =
    input.pausedAt === null ? 0 : Math.max(0, input.nowMs - Date.parse(input.pausedAt));
  return {
    ok: true,
    phase: input.pausedFrom,
    startedAt: shiftDeadlineForward(input.startedAt, pauseDurationMs),
    endsAt: shiftDeadlineForward(input.endsAt, pauseDurationMs),
  };
}

/** Build the snapshot safety state after a pause. */
export function safetyStateAfterPause(
  byPlayerId: string,
  nowMs: number,
  previous: SafetyState,
): SafetyState {
  return {
    ...previous,
    paused: true,
    pausedBy: byPlayerId,
    pausedAt: new Date(nowMs).toISOString(),
  };
}

/** Build the snapshot safety state after a resume. */
export function safetyStateAfterResume(previous: SafetyState): SafetyState {
  return { ...previous, paused: false, pausedBy: null, pausedAt: null };
}
