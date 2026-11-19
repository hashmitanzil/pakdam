/**
 * Pakdam engine — catch flow.
 *
 * Tag → QR → runner confirms → manual fallback. NO catch code anywhere:
 * the token lives only inside the Runner's QR, and the user never sees or
 * types it. Runner confirmation is ALWAYS required — a tag never counts at
 * once. A disputed catch goes to the host, whose decision is final.
 *
 * Server rules:
 * - `catch.request`: Hunter only, ACTIVE only, target a free, present,
 *   non-suspended Runner; one pending catch per Runner (a re-request by the
 *   SAME Hunter returns the open claim — idempotent; a different Hunter gets
 *   CONFLICT); an already-caught Runner cannot be claimed again.
 * - `catch.confirm`: the named Runner (QR token, or `manualConfirm` with no
 *   token) OR the claiming Hunter (valid QR token) may confirm. Requires
 *   ACTIVE, Runner still free and non-suspended (a suspended Runner blocks
 *   the confirm — the catch-22, fixed by resume-on-hello), claim still
 *   pending and unexpired. A second confirm is CONFLICT, never a double-apply.
 * - `catch.dispute`: Runner-only, on a pending claim; an overdue claim
 *   expires instead of disputing. A disputed catch goes to host resolution;
 *   re-confirming a disputed catch is rejected server-side.
 * - QR token: 128-bit (32 hex chars) fresh token, hash =
 *   `sha256(catchId + ':' + raw)`, single-use + TTL, QR-only carriage.
 * - GPS is supporting evidence only: 'present'/'absent'/'stale' — absent or
 *   stale GPS is "no GPS evidence", never negative evidence.
 *
 * Idempotency: retries reuse the same `commandId`; the DO drops repeats for
 * 10 min (see `isDuplicateCommand` / `rememberCommand`).
 */
import {
  CATCH_CONFIRMATION_REQUIRED,
  CATCH_TOKEN_TTL_SECONDS,
  IDEMPOTENCY_TTL_MS,
  STALE_FIX_MS,
  newCatchToken,
  catchTokenHash,
  isValidCatchToken,
  haversineMeters,
  CATCH_PROXIMITY_PLAUSIBILITY_M,
  type CatchEvent,
  type CatchGpsEvidence,
  type CatchState,
  type CatchView,
  type LocationFix,
  type MatchPhase,
} from '@pakdam/shared';

export { CATCH_CONFIRMATION_REQUIRED, CATCH_TOKEN_TTL_SECONDS, isValidCatchToken };

/** Pending states — the only states a catch in `activeCatches` can be in. */
export const PENDING_CATCH_STATES: readonly CatchState[] = [
  'requested',
  'awaiting-confirmation',
] as const;

export function isPendingCatch(catchEvent: CatchEvent | CatchView): boolean {
  return (PENDING_CATCH_STATES as readonly CatchState[]).includes(catchEvent.state);
}

/** Has this claim expired? Expiry is enforced lazily on every operation. */
export function isCatchExpired(
  catchEvent: CatchEvent | CatchView,
  nowMs: number,
  ttlSeconds: number = CATCH_TOKEN_TTL_SECONDS,
): boolean {
  return nowMs - Date.parse(catchEvent.requestedAt) >= ttlSeconds * 1000;
}

/** Strip the server-only token hash for clients. */
export function toCatchView(catchEvent: CatchEvent): CatchView {
  const { qrTokenHash: _qrTokenHash, ...view } = catchEvent;
  return view;
}

// ---------------------------------------------------------------------------
// Idempotency (commandId)
// ---------------------------------------------------------------------------

/** One idempotency record: (seat, commandId) seen within the TTL. */
export interface IdempotencyRecord {
  commandId: string;
  seenAtMs: number;
}

/** Is this (seat, commandId) a repeat inside the 10-min window? */
export function isDuplicateCommand(
  seen: ReadonlyMap<string, IdempotencyRecord>,
  seatPlayerId: string,
  commandId: string,
  nowMs: number,
): boolean {
  const record = seen.get(`${seatPlayerId}:${commandId}`);
  if (record === undefined) return false;
  return nowMs - record.seenAtMs < IDEMPOTENCY_TTL_MS;
}

/** Record a (seat, commandId) as seen. Returns a new map (input untouched). */
export function rememberCommand(
  seen: ReadonlyMap<string, IdempotencyRecord>,
  seatPlayerId: string,
  commandId: string,
  nowMs: number,
): Map<string, IdempotencyRecord> {
  const next = new Map(seen);
  next.set(`${seatPlayerId}:${commandId}`, { commandId, seenAtMs: nowMs });
  return next;
}

/** Drop idempotency records older than the 10-min TTL. */
export function purgeIdempotency(
  seen: ReadonlyMap<string, IdempotencyRecord>,
  nowMs: number,
): Map<string, IdempotencyRecord> {
  const next = new Map<string, IdempotencyRecord>();
  for (const [key, record] of seen) {
    if (nowMs - record.seenAtMs < IDEMPOTENCY_TTL_MS) next.set(key, record);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Catch token (128-bit, QR-only)
// ---------------------------------------------------------------------------

/** Issue a fresh one-time catch token: raw token (QR only) + its stored hash. */
export async function issueCatchToken(
  catchId: string,
): Promise<{ token: string; tokenHash: string }> {
  const token = newCatchToken();
  const tokenHash = await catchTokenHash(catchId, token);
  return { token, tokenHash };
}

/** Does this raw token match the stored hash for the catch? */
export async function verifyCatchToken(
  catchId: string,
  rawToken: string,
  storedHash: string | null,
): Promise<boolean> {
  if (storedHash === null) return false;
  if (!isValidCatchToken(rawToken)) return false;
  const hash = await catchTokenHash(catchId, rawToken);
  return hash === storedHash;
}

// ---------------------------------------------------------------------------
// GPS evidence (supporting only — never proof, never a rejection on its own)
// ---------------------------------------------------------------------------

/**
 * GPS evidence for a catch: 'present' when both fixes are fresh and the
 * Hunter↔Runner distance is plausible (≤ 15 m, OPEN); 'stale' when either
 * fix is older than the stale window; 'absent' when either fix is missing.
 * Absent/stale is "no GPS evidence", never negative evidence.
 */
export function gpsEvidenceForCatch(
  hunterFix: LocationFix | null,
  runnerFix: LocationFix | null,
  nowMs: number,
): CatchGpsEvidence {
  if (hunterFix === null || runnerFix === null) return 'absent';
  if (
    nowMs - hunterFix.timestampMs > STALE_FIX_MS ||
    nowMs - runnerFix.timestampMs > STALE_FIX_MS
  ) {
    return 'stale';
  }
  const distance = haversineMeters(hunterFix, runnerFix);
  return distance <= CATCH_PROXIMITY_PLAUSIBILITY_M ? 'present' : 'absent';
}

// ---------------------------------------------------------------------------
// Request / confirm / dispute / resolve
// ---------------------------------------------------------------------------

export type CatchResult<T> = { ok: true; value: T } | { ok: false; reason: string; code: string };

/** Minimal seat shape the catch rules need. */
export interface CatchPlayer {
  playerId: string;
  matchRole: 'hunter' | 'runner' | null;
  connectionState: 'connected' | 'stale' | 'suspended' | 'disconnected';
  ejectedAt: string | null;
  leftAt: string | null;
}

/** A free, present, non-suspended Runner — the only valid catch target. */
export function isCatchableRunner(
  player: CatchPlayer,
  caughtRunnerIds: ReadonlySet<string> | readonly string[],
): boolean {
  const caughtSet =
    caughtRunnerIds instanceof Set ? caughtRunnerIds : new Set(caughtRunnerIds);
  const caught = caughtSet.has(player.playerId);
  return (
    player.matchRole === 'runner' &&
    !caught &&
    player.ejectedAt === null &&
    player.leftAt === null &&
    player.connectionState !== 'suspended' &&
    player.connectionState !== 'disconnected'
  );
}

/** The open (pending) claim against a Runner, if any. */
export function openCatchForRunner(
  catches: readonly CatchEvent[],
  runnerId: string,
): CatchEvent | null {
  for (const c of catches) {
    if (c.runnerPlayerId === runnerId && isPendingCatch(c)) return c;
  }
  return null;
}

/**
 * Request a catch. Hunter only, ACTIVE only, target a free, present,
 * non-suspended Runner. One pending catch per Runner: a re-request by the
 * SAME Hunter returns the open claim (idempotent); a different Hunter gets
 * CONFLICT. Returns the new claim in state 'awaiting-confirmation' — the
 * token is issued separately by `issueCatchToken`.
 */
export function requestCatch(input: {
  catches: readonly CatchEvent[];
  hunter: CatchPlayer;
  runner: CatchPlayer;
  caughtRunnerIds: ReadonlySet<string> | readonly string[];
  phase: MatchPhase;
  catchId: string;
  roomId: string;
  nowMs: number;
  hunterFix: LocationFix | null;
  runnerFix: LocationFix | null;
}): CatchResult<CatchEvent> {
  if (input.phase !== 'ACTIVE') {
    return { ok: false, code: 'INVALID_STATE', reason: 'Catches can only be made while the match is live.' };
  }
  if (input.hunter.matchRole !== 'hunter') {
    return { ok: false, code: 'FORBIDDEN', reason: 'Only a Hunter can tag a Runner.' };
  }
  if (input.hunter.ejectedAt !== null || input.hunter.leftAt !== null) {
    return { ok: false, code: 'FORBIDDEN', reason: 'An ejected or departed Hunter cannot tag.' };
  }
  const open = openCatchForRunner(input.catches, input.runner.playerId);
  if (open !== null) {
    if (open.hunterPlayerId === input.hunter.playerId) {
      return { ok: true, value: open };
    }
    return { ok: false, code: 'CONFLICT', reason: 'Another Hunter has already claimed this Runner.' };
  }
  if (!isCatchableRunner(input.runner, input.caughtRunnerIds)) {
    return { ok: false, code: 'CONFLICT', reason: 'That Runner cannot be caught right now.' };
  }
  const now = new Date(input.nowMs).toISOString();
  return {
    ok: true,
    value: {
      catchId: input.catchId,
      roomId: input.roomId,
      hunterPlayerId: input.hunter.playerId,
      runnerPlayerId: input.runner.playerId,
      state: 'awaiting-confirmation',
      qrTokenHash: null,
      requestedAt: now,
      confirmedAt: null,
      disputedAt: null,
      resolution: null,
      gpsEvidence: gpsEvidenceForCatch(input.hunterFix, input.runnerFix, input.nowMs),
    },
  };
}

/**
 * Confirm a catch. The named Runner (QR token, or `manualConfirm` with no
 * token) OR the claiming Hunter (valid QR token) may confirm. Requires
 * ACTIVE, Runner still free and non-suspended, claim still pending and
 * unexpired. A second confirm is CONFLICT, never a double-apply.
 * `tokenValid` is the result of `verifyCatchToken` (or true for a manual
 * Runner confirm, which carries no token by design).
 */
export function confirmCatch(input: {
  catchEvent: CatchEvent;
  confirmerId: string;
  confirmerRole: 'hunter' | 'runner' | null;
  manualConfirm: boolean;
  tokenValid: boolean;
  runner: CatchPlayer;
  caughtRunnerIds: ReadonlySet<string> | readonly string[];
  phase: MatchPhase;
  nowMs: number;
  ttlSeconds?: number;
}): CatchResult<CatchEvent> {
  const c = input.catchEvent;
  if (input.phase !== 'ACTIVE') {
    return { ok: false, code: 'INVALID_STATE', reason: 'The match is not live.' };
  }
  if (!isPendingCatch(c)) {
    return { ok: false, code: 'CONFLICT', reason: 'This catch has already been decided.' };
  }
  if (isCatchExpired(c, input.nowMs, input.ttlSeconds)) {
    return { ok: false, code: 'CATCH_EXPIRED', reason: 'This catch expired — tag the Runner again.' };
  }
  if (input.runner.connectionState === 'suspended') {
    return {
      ok: false,
      code: 'CONFLICT',
      reason: 'The Runner is suspended — reconnect first, then confirm.',
    };
  }
  if (!isCatchableRunner(input.runner, input.caughtRunnerIds)) {
    return { ok: false, code: 'CONFLICT', reason: 'That Runner cannot be caught right now.' };
  }
  const isRunner = input.confirmerId === c.runnerPlayerId;
  const isHunter = input.confirmerId === c.hunterPlayerId;
  if (!isRunner && !isHunter) {
    return { ok: false, code: 'FORBIDDEN', reason: 'Only the Runner or the claiming Hunter can confirm this catch.' };
  }
  if (isRunner && input.manualConfirm) {
    // Manual fallback: Runner confirms themself, no token, no QR needed.
  } else if (!input.tokenValid) {
    return { ok: false, code: 'FORBIDDEN', reason: 'That QR token does not match this catch.' };
  }
  if (input.confirmerRole === null && !isRunner && !isHunter) {
    return { ok: false, code: 'FORBIDDEN', reason: 'Only the Runner or the claiming Hunter can confirm this catch.' };
  }
  return {
    ok: true,
    value: {
      ...c,
      state: 'confirmed',
      confirmedAt: new Date(input.nowMs).toISOString(),
      resolution: 'confirmed',
    },
  };
}

/**
 * Dispute a catch. Runner-only, on a pending claim; an overdue claim
 * expires instead of disputing. A disputed catch goes to host resolution.
 */
export function disputeCatch(input: {
  catchEvent: CatchEvent;
  disputerId: string;
  phase: MatchPhase;
  nowMs: number;
  ttlSeconds?: number;
}): CatchResult<CatchEvent> {
  const c = input.catchEvent;
  if (input.disputerId !== c.runnerPlayerId) {
    return { ok: false, code: 'FORBIDDEN', reason: 'Only the Runner can dispute this catch.' };
  }
  if (!isPendingCatch(c)) {
    return { ok: false, code: 'CONFLICT', reason: 'This catch has already been decided.' };
  }
  if (isCatchExpired(c, input.nowMs, input.ttlSeconds)) {
    return { ok: false, code: 'CATCH_EXPIRED', reason: 'This catch expired — tag the Runner again.' };
  }
  return {
    ok: true,
    value: {
      ...c,
      state: 'disputed',
      disputedAt: new Date(input.nowMs).toISOString(),
    },
  };
}

/**
 * Host-resolve a disputed catch. Decision 'confirmed' applies the mode
 * rule; 'rejected' voids the claim. The host's decision is final.
 * Re-confirming a disputed catch is rejected server-side — only this path
 * decides it.
 */
export function resolveCatch(input: {
  catchEvent: CatchEvent;
  resolverIsHost: boolean;
  decision: 'confirmed' | 'rejected';
  nowMs: number;
}): CatchResult<CatchEvent> {
  const c = input.catchEvent;
  if (!input.resolverIsHost) {
    return { ok: false, code: 'FORBIDDEN', reason: 'Only the host can resolve a disputed catch.' };
  }
  if (c.state !== 'disputed') {
    return { ok: false, code: 'CONFLICT', reason: 'Only a disputed catch can be resolved by the host.' };
  }
  return {
    ok: true,
    value: {
      ...c,
      state: input.decision === 'confirmed' ? 'confirmed' : 'rejected',
      confirmedAt: input.decision === 'confirmed' ? new Date(input.nowMs).toISOString() : c.confirmedAt,
      resolution: input.decision,
    },
  };
}

/** Lazily expire an overdue pending claim (checked on every operation). */
export function expireCatchIfOverdue(
  catchEvent: CatchEvent,
  nowMs: number,
  ttlSeconds: number = CATCH_TOKEN_TTL_SECONDS,
): CatchEvent {
  if (isPendingCatch(catchEvent) && isCatchExpired(catchEvent, nowMs, ttlSeconds)) {
    return { ...catchEvent, state: 'expired' };
  }
  return catchEvent;
}

// ---------------------------------------------------------------------------
// Catch page auto-select + name-only picker (P0-2)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective Runner for the catch page, in order:
 * (1) `?runner=` param; (2) an open claim involving ME — as Runner (bare
 * link lands on their own Step 2) or as Hunter (my open claim's Step 3);
 * (3) the Step 1 picker choice; (4) my most recent CONFIRMED catch
 * involving me (so the "✓ Catch confirmed" card survives the claim leaving
 * the pending set). With none of those, the Step 1 picker renders instead
 * of a "No Runner selected" dead end. Returns null only when the picker
 * must render.
 */
export function selectEffectiveRunner(input: {
  urlRunnerId: string | null;
  myOpenClaim: CatchEvent | CatchView | null;
  myPlayerId: string;
  pickerChoiceId: string | null;
  myLatestConfirmedCatch: CatchEvent | CatchView | null;
}): string | null {
  if (input.urlRunnerId !== null) return input.urlRunnerId;
  const open = input.myOpenClaim;
  if (open !== null) {
    if (open.runnerPlayerId === input.myPlayerId) return open.runnerPlayerId;
    if (open.hunterPlayerId === input.myPlayerId) return open.runnerPlayerId;
  }
  if (input.pickerChoiceId !== null) return input.pickerChoiceId;
  const confirmed = input.myLatestConfirmedCatch;
  if (confirmed !== null) {
    if (confirmed.runnerPlayerId === input.myPlayerId) return confirmed.runnerPlayerId;
    if (confirmed.hunterPlayerId === input.myPlayerId) return confirmed.runnerPlayerId;
  }
  return null;
}

/**
 * Step 1 picker candidates: display names ONLY (no roles). Exclusions are
 * only self, ejected/left players, and already-caught Runners. A pick that
 * turns out not to be a Runner is rejected by the server with a
 * plain-language error — no role is revealed by the rejection.
 */
export function pickerCandidates(
  players: readonly { playerId: string; displayName: string; ejectedAt: string | null; leftAt: string | null }[],
  selfId: string,
  caughtRunnerIds: ReadonlySet<string> | readonly string[],
): { playerId: string; displayName: string }[] {
  const caught = new Set(caughtRunnerIds);
  return players
    .filter(
      (p) =>
        p.playerId !== selfId &&
        p.ejectedAt === null &&
        p.leftAt === null &&
        !caught.has(p.playerId),
    )
    .map((p) => ({ playerId: p.playerId, displayName: p.displayName }));
}
