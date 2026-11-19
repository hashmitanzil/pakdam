/**
 * Pakdam engine — safety rules.
 *
 * Any player may pause the match; SOS is NOT emergency dispatch — the copy
 * must say so. Safety pause and SOS are one tap away on the play screen at
 * all times. A pause only blocks play, never deletes state: the clock
 * freezes, and resume returns to the phase paused from (never hard-codes
 * ACTIVE) with the deadlines shifted forward by the pause.
 *
 * "I'm safe" check-in travels as an announcement; there is no command for it.
 */
import { SOS_COPY, type MatchPhase, type SafetyState } from '@pakdam/shared';

export { SOS_COPY };

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
 * freezes. A pause from an already-paused phase is a no-op success.
 */
export function pauseMatch(
  phase: MatchPhase,
  byPlayerId: string,
  nowMs: number,
): PauseResult & { pausedBy: string } {
  if (phase === 'SAFETY_PAUSED') {
    return {
      ok: true,
      phase: 'SAFETY_PAUSED',
      pausedFrom: 'ACTIVE',
      pausedAt: new Date(nowMs).toISOString(),
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

/** Build the snapshot safety state after a resume (SOS stays as it was). */
export function safetyStateAfterResume(previous: SafetyState): SafetyState {
  return { ...previous, paused: false, pausedBy: null, pausedAt: null };
}

/**
 * Raise an SOS. ANY player may raise one (no host check on the sender —
 * the DO accepts `safety.sos` from any seat); SOS alerts the host only
 * (trusted-contact sharing is a later phase) and is NOT emergency dispatch
 * — `SOS_COPY` says so, and the UI must show it. The host sees who raised
 * it (`sos.raised` goes to the host + the raiser). Returns the updated
 * safety state; the caller broadcasts `sos.raised` to the room.
 */
export function raiseSos(previous: SafetyState): SafetyState {
  return { ...previous, sosActive: true };
}

/** Clear an SOS (host-acknowledged). */
export function clearSos(previous: SafetyState): SafetyState {
  return { ...previous, sosActive: false };
}

/** SOS recipients: host only. */
export function sosRecipients(hostPlayerId: string): string[] {
  return [hostPlayerId];
}
