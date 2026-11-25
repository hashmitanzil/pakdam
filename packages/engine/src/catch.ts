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
 *   non-suspended Runner; the requesting Hunter must not be suspended or
 *   disconnected either; one pending catch per Runner (a re-request by the
 *   SAME Hunter returns the open claim — idempotent; a different Hunter gets
 *   CONFLICT); an already-caught Runner cannot be claimed again. The claim
 *   opens only when the Hunter and Runner are physically close (see below).
 * - `catch.confirm`: the named Runner (QR token, or `manualConfirm` with no
 *   token) OR the claiming Hunter (valid QR token) may confirm. Requires
 *   ACTIVE, Runner still free and non-suspended (a suspended Runner blocks
 *   the confirm — the catch-22, fixed by resume-on-hello), claim still
 *   pending and unexpired. A second confirm is CONFLICT, never a double-apply.
 * - PHYSICAL TAGS (founder decision): a tag confirms ONLY when (a valid
 *   token is presented OR the Runner manually confirms) AND the Hunter and
 *   the Runner both have a recent fix AND the distance between them is
 *   ≤ CATCH_MAX_DISTANCE_METERS (100 m). Missing/stale fixes reject with
 *   "Waiting for GPS — move closer and try again". This applies to BOTH
 *   the hunter-scan-confirms-directly path and the manual-confirm path —
 *   a tag must not complete with both phones in different cities.
 * - `catch.dispute`: Runner-only, on a pending claim; an overdue claim
 *   expires instead of disputing. A disputed catch goes to host resolution;
 *   re-confirming a disputed catch is rejected server-side.
 * - QR token: 128-bit (32 hex chars) fresh token, hash =
 *   `sha256(catchId + ':' + raw)`, single-use + TTL, QR-only carriage.
 * - Claim-less runner QR token (v18 follow-up): a Runner mints their own
 *   token with NO claim open (`catch.runner-token`); hash =
 *   `sha256('runner:' + runnerId + ':' + raw)`, same 128-bit / 120 s /
 *   single-use / QR-only rules, one live token per Runner (re-mint
 *   replaces the old one). A Hunter's scan (`catch.request` with
 *   `qrToken`) resolves the Runner from the token and creates the claim;
 *   the claim then carries the catchId-scoped hash of the same raw value,
 *   so `catch.confirm` with the scanned token verifies unchanged.
 * - GPS evidence (`gpsEvidence`) is a plausibility record only
 *   ('present'/'absent'/'stale') — the physical-tag gate above is the
 *   separate, enforcing check in `confirmCatch` / `requestCatch`.
 *
 * Idempotency: retries reuse the same `commandId`; the DO drops repeats for
 * 10 min (see `isDuplicateCommand` / `rememberCommand`).
 */
import {
  CATCH_CONFIRMATION_REQUIRED,
  CATCH_MAX_DISTANCE_METERS,
  CATCH_TOKEN_TTL_SECONDS,
  IDEMPOTENCY_TTL_MS,
  STALE_FIX_MS,
  ZONE_AUTO_CENTRE_MAX_ACCURACY_M,
  newCatchToken,
  catchTokenHash,
  isValidCatchToken,
  haversineMeters,
  runnerTokenHash,
  CATCH_PROXIMITY_PLAUSIBILITY_M,
  type CatchEvent,
  type CatchGpsEvidence,
  type CatchState,
  type CatchView,
  type LocationFix,
  type MatchPhase,
  type MatchTag,
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

/** Strip the server-only token hashes for clients (F1: both hashes — `qrTokenHash` AND `previousQrTokenHash` — never leave the server). */
export function toCatchView(catchEvent: CatchEvent): CatchView {
  const { qrTokenHash: _qrTokenHash, previousQrTokenHash: _previousQrTokenHash, ...view } = catchEvent;
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

/**
 * Record a (seat, commandId) as seen. Mutates the map IN PLACE (the old
 * version copied the whole map — `new Map(seen)` — on every message
 * carrying a commandId). Callers must not reassign from the return value;
 * there is none. Exactly-once semantics are unchanged: a repeat inside
 * the TTL is still a duplicate (see `isDuplicateCommand`).
 */
export function rememberCommand(
  seen: Map<string, IdempotencyRecord>,
  seatPlayerId: string,
  commandId: string,
  nowMs: number,
): void {
  seen.set(`${seatPlayerId}:${commandId}`, { commandId, seenAtMs: nowMs });
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
// Claim-less runner QR token (v18 follow-up — founder catch flow)
// ---------------------------------------------------------------------------

/**
 * A Runner's claim-less QR token, as the server stores it. Hash ONLY —
 * the raw value is returned once to the Runner (inside the direct
 * `catch.runner-token` reply) and is never stored, logged, or persisted.
 * One live record per Runner: a re-mint replaces the previous record,
 * so the old QR dies at once. `used` flips when a Hunter's scan creates
 * (or binds to) a claim with it — a consumed token can never create a
 * second claim. Expired records are pruned lazily by the DO; expiry is
 * always decided by `expiresAtMs`, never by the prune.
 */
export interface RunnerQrToken {
  runnerPlayerId: string;
  /** sha256('runner:' + runnerId + ':' + raw) — see `runnerTokenHash`. */
  tokenHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
  used: boolean;
}

/**
 * Issue a fresh claim-less runner token: raw token (QR only) + its
 * durable record (hash only). Same token rules as a claim token:
 * 128-bit (32 uppercase hex), TTL `CATCH_TOKEN_TTL_SECONDS` (120 s),
 * single-use, QR-only carriage. The record carries NO raw value — the
 * caller returns `token` to the Runner once and stores only `record`.
 */
export async function issueRunnerQrToken(
  runnerPlayerId: string,
  nowMs: number,
  ttlSeconds: number = CATCH_TOKEN_TTL_SECONDS,
): Promise<{ token: string; record: RunnerQrToken }> {
  const token = newCatchToken();
  const tokenHash = await runnerTokenHash(runnerPlayerId, token);
  return {
    token,
    record: {
      runnerPlayerId,
      tokenHash,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + ttlSeconds * 1000,
      used: false,
    },
  };
}

/** Has this runner-token record expired? Expiry is enforced lazily on every operation. */
export function isRunnerQrTokenExpired(record: RunnerQrToken, nowMs: number): boolean {
  return nowMs >= record.expiresAtMs;
}

export type RunnerQrTokenStatus = 'valid' | 'expired' | 'used' | 'unknown';

/**
 * Resolve a raw token a Hunter scanned against every live runner-token
 * record. The QR carries only the raw token, so the Runner is identified
 * by re-hashing: for each record, sha256('runner:' + record.runnerId +
 * ':' + raw) is compared with the stored hash. A hash match on an
 * expired record answers 'expired' (not 'unknown' — the Runner's QR was
 * real, just stale); a match on a consumed record answers 'used'; no
 * match at all answers 'unknown'. Malformed tokens (not 32 uppercase
 * hex) are 'unknown' without hashing.
 */
export async function resolveRunnerQrToken(
  records: readonly RunnerQrToken[],
  rawToken: string,
  nowMs: number,
): Promise<{ status: RunnerQrTokenStatus; record: RunnerQrToken | null }> {
  if (!isValidCatchToken(rawToken)) return { status: 'unknown', record: null };
  for (const record of records) {
    const hash = await runnerTokenHash(record.runnerPlayerId, rawToken);
    if (hash !== record.tokenHash) continue;
    if (record.used) return { status: 'used', record };
    if (isRunnerQrTokenExpired(record, nowMs)) return { status: 'expired', record };
    return { status: 'valid', record };
  }
  return { status: 'unknown', record: null };
}

/**
 * v18 fix round (A1) — resolve a scanned token against OPEN CLAIMS.
 *
 * After a name-claim the Runner displays the CLAIM QR (fetched via HTTP
 * `/catch-token`), not a claim-less runner token — so `resolveRunnerQrToken`
 * answers 'unknown' for it and the Hunter could never tag after a reload
 * (the in-memory `scannedToken` was gone too). When the runner-token
 * lookup misses, the DO tries this second lookup: a raw token that
 * verifies against an open (pending, unexpired) claim's `qrTokenHash` —
 * or its preserved `previousQrTokenHash` — resolves to that claim.
 *
 * The hash domains are NOT merged: a runner token still never verifies
 * as a claim token except through this explicit dual lookup in
 * `catch.request` (this helper only ever reads claim hashes). Expired
 * claims do not resolve (the lazy sweep expires them and the Hunter's
 * scan then opens a fresh claim instead). Returns the open claim, or
 * null when no open claim's token matches.
 */
export async function resolveOpenClaimQrToken(
  catches: readonly CatchEvent[],
  rawToken: string,
  nowMs: number,
  ttlSeconds: number = CATCH_TOKEN_TTL_SECONDS,
): Promise<CatchEvent | null> {
  if (!isValidCatchToken(rawToken)) return null;
  for (const c of catches) {
    if (!isPendingCatch(c)) continue;
    if (isCatchExpired(c, nowMs, ttlSeconds)) continue;
    if (await verifyCatchToken(c.catchId, rawToken, c.qrTokenHash)) return c;
    if (
      c.previousQrTokenHash !== undefined &&
      c.previousQrTokenHash !== null &&
      (await verifyCatchToken(c.catchId, rawToken, c.previousQrTokenHash))
    ) {
      return c;
    }
  }
  return null;
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

/**
 * The physical-tag gate: both phones must have a recent fix and be within
 * `maxDistanceMeters` of each other. Missing or stale fixes reject with
 * STALE_LOCATION ("Waiting for GPS — move closer and try again"); too far
 * apart rejects with FORBIDDEN. This is the ENFORCING check — unlike
 * `gpsEvidenceForCatch` (plausibility only), a failure here blocks the
 * tag. Callers pass the DO's latest fixes (`mem.latestFix`) for both
 * seats; `maxDistanceMeters` defaults to CATCH_MAX_DISTANCE_METERS (100 m).
 */
export function checkCatchProximity(input: {
  hunterFix: LocationFix | null;
  runnerFix: LocationFix | null;
  nowMs: number;
  maxDistanceMeters?: number;
}): CatchResult<void> {
  const maxDistanceMeters = input.maxDistanceMeters ?? CATCH_MAX_DISTANCE_METERS;
  // v34 (Diya R2-9) — the reason names WHOSE fix is the problem. The
  // old single message ("Waiting for GPS — move closer and try again")
  // was shown to the Runner for every cause, including a coarse
  // HUNTER fix, while both phones stood together — the Runner could
  // not tell whose GPS was at fault. The code stays STALE_LOCATION
  // for all of these (the client branches on it); only the reason
  // distinguishes. This changes no acceptance rule: the ±50 m
  // accuracy leg and the 60 s freshness leg are untouched (F1 stays
  // a founder call).
  if (input.hunterFix === null || input.runnerFix === null) {
    if (input.hunterFix === null) {
      return {
        ok: false,
        code: 'STALE_LOCATION',
        reason: "Waiting for the Hunter's GPS — they have no fix yet.",
      };
    }
    return {
      ok: false,
      code: 'STALE_LOCATION',
      reason: 'Waiting for GPS — move closer and try again.',
    };
  }
  if (
    input.nowMs - input.hunterFix.timestampMs > STALE_FIX_MS ||
    input.nowMs - input.runnerFix.timestampMs > STALE_FIX_MS
  ) {
    if (input.nowMs - input.hunterFix.timestampMs > STALE_FIX_MS) {
      return {
        ok: false,
        code: 'STALE_LOCATION',
        reason: "The Hunter's GPS fix is stale — wait for it to refresh, then try again.",
      };
    }
    return {
      ok: false,
      code: 'STALE_LOCATION',
      reason: 'Waiting for GPS — move closer and try again.',
    };
  }
  // v18 fix round (B1) — liveness vs usability: a poor fix (accuracy
  // worse than ±50 m, `ZONE_AUTO_CENTRE_MAX_ACCURACY_M`) still proves
  // the phone is alive (it stamps `lastFixAt`, so the seat is not
  // ejected for silence), but its position is far too coarse to judge
  // a 100 m tag — the distance between two ±1000 m fixes says nothing
  // about whether the phones are actually next to each other. A tag
  // needs BOTH fixes accurate to ±50 m or better; otherwise the phones
  // wait for a better lock, exactly like a missing fix.
  if (
    input.hunterFix.accuracyMeters > ZONE_AUTO_CENTRE_MAX_ACCURACY_M ||
    input.runnerFix.accuracyMeters > ZONE_AUTO_CENTRE_MAX_ACCURACY_M
  ) {
    if (input.hunterFix.accuracyMeters > ZONE_AUTO_CENTRE_MAX_ACCURACY_M) {
      return {
        ok: false,
        code: 'STALE_LOCATION',
        reason: `The Hunter's GPS is too rough (±${Math.round(input.hunterFix.accuracyMeters)} m) — wait for a better lock, then try again.`,
      };
    }
    return {
      ok: false,
      code: 'STALE_LOCATION',
      reason: `Your GPS is too rough (±${Math.round(input.runnerFix.accuracyMeters)} m) — wait for a better lock, then try again.`,
    };
  }
  const distance = haversineMeters(input.hunterFix, input.runnerFix);
  if (distance > maxDistanceMeters) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: 'You are too far apart to tag — stand next to the Runner and try again.',
    };
  }
  return { ok: true, value: undefined };
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
 * Confirmed tags for the match result, oldest first. Only catches in
 * `confirmed` state with a confirmation time are listed — a pending,
 * disputed, expired or rejected catch is never a tag.
 */
export function confirmedTags(catches: readonly CatchEvent[]): MatchTag[] {
  return catches
    .filter((c) => c.state === 'confirmed' && c.confirmedAt !== null)
    .map((c) => ({
      hunterPlayerId: c.hunterPlayerId,
      runnerPlayerId: c.runnerPlayerId,
      confirmedAt: c.confirmedAt as string,
    }))
    .sort((a, b) => Date.parse(a.confirmedAt) - Date.parse(b.confirmedAt));
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
  /**
   * Latest fixes for both seats (the DO passes `mem.latestFixForCatch`
   * for the Hunter and the Runner — the gate-only map, purged at the
   * gate's 60 s window). When given, the physical-tag gate runs on
   * these; otherwise it runs on `hunterFix` / `runnerFix`.
   */
  positions?: { hunter: LocationFix | null; runner: LocationFix | null };
  /** Max Hunter↔Runner distance for a tag; defaults to CATCH_MAX_DISTANCE_METERS (100 m). */
  maxDistanceMeters?: number;
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
  // A suspended or disconnected Hunter cannot open a claim — only the
  // Runner's state was gated before; the Hunter's matters just as much
  // (a Hunter whose phone is in a pocket cannot physically tag anyone).
  if (
    input.hunter.connectionState === 'suspended' ||
    input.hunter.connectionState === 'disconnected'
  ) {
    return { ok: false, code: 'FORBIDDEN', reason: 'A suspended or disconnected Hunter cannot tag.' };
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
  // Physical-tag gate: the Hunter and the Runner must both have a recent
  // fix within maxDistanceMeters — a claim opened from another city is
  // rejected here, not just at confirm time.
  const proximity = checkCatchProximity({
    hunterFix: input.positions?.hunter ?? input.hunterFix,
    runnerFix: input.positions?.runner ?? input.runnerFix,
    nowMs: input.nowMs,
    maxDistanceMeters: input.maxDistanceMeters,
  });
  if (!proximity.ok) return proximity;
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
 * PHYSICAL TAG: `positions` (required — the DO passes `mem.latestFix`
 * for the Hunter and the Runner) must show both seats with a recent fix
 * within `maxDistanceMeters` (default CATCH_MAX_DISTANCE_METERS, 100 m);
 * otherwise the tag is rejected. The gate applies to BOTH the
 * hunter-scan-confirms-directly path and the manual-confirm path.
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
  /** Latest fixes for the Hunter and the Runner (DO `mem.latestFix`). Required — a tag without both fixes cannot be confirmed. */
  positions: { hunter: LocationFix | null; runner: LocationFix | null };
  /** Max Hunter↔Runner distance for a tag; defaults to CATCH_MAX_DISTANCE_METERS (100 m). */
  maxDistanceMeters?: number;
}): CatchResult<CatchEvent> {
  const c = input.catchEvent;
  if (input.phase !== 'ACTIVE') {
    return { ok: false, code: 'INVALID_STATE', reason: 'The match is not live.' };
  }
  // Expiry BEFORE the decided check: a claim already flipped to 'expired'
  // by the lazy sweep must answer CATCH_EXPIRED ("QR expired — ask the
  // Hunter to re-claim"), not CONFLICT. A genuinely decided catch
  // (confirmed / disputed / rejected) is not expired, so a second confirm
  // still answers CONFLICT below.
  if (
    c.state === 'expired' ||
    (isPendingCatch(c) && isCatchExpired(c, input.nowMs, input.ttlSeconds))
  ) {
    return { ok: false, code: 'CATCH_EXPIRED', reason: 'This catch expired — tag the Runner again.' };
  }
  if (!isPendingCatch(c)) {
    return { ok: false, code: 'CONFLICT', reason: 'This catch has already been decided.' };
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
  // Physical-tag gate (both paths): the Hunter and the Runner must be
  // next to each other with fresh GPS. A token/manual confirm from
  // another city does not complete the tag.
  const proximity = checkCatchProximity({
    hunterFix: input.positions.hunter,
    runnerFix: input.positions.runner,
    nowMs: input.nowMs,
    maxDistanceMeters: input.maxDistanceMeters,
  });
  if (!proximity.ok) return proximity;
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
 * Dispute requires the match to be ACTIVE — pass the room phase; when
 * `phase` is provided and is not ACTIVE the dispute is rejected (the DO
 * always passes its phase; `resolveCatchOp` enforces the same rule).
 */
export function disputeCatch(input: {
  catchEvent: CatchEvent;
  disputerId: string;
  phase: MatchPhase;
  nowMs: number;
  ttlSeconds?: number;
}): CatchResult<CatchEvent> {
  const c = input.catchEvent;
  if (input.phase !== 'ACTIVE') {
    return { ok: false, code: 'INVALID_STATE', reason: 'Catches can only be disputed while the match is live.' };
  }
  if (input.disputerId !== c.runnerPlayerId) {
    return { ok: false, code: 'FORBIDDEN', reason: 'Only the Runner can dispute this catch.' };
  }
  // Expiry BEFORE the decided check (same reason as confirmCatch): an
  // already-expired claim answers CATCH_EXPIRED, not CONFLICT.
  if (
    c.state === 'expired' ||
    (isPendingCatch(c) && isCatchExpired(c, input.nowMs, input.ttlSeconds))
  ) {
    return { ok: false, code: 'CATCH_EXPIRED', reason: 'This catch expired — tag the Runner again.' };
  }
  if (!isPendingCatch(c)) {
    return { ok: false, code: 'CONFLICT', reason: 'This catch has already been decided.' };
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
 * decides it. Resolution requires the match to be ACTIVE — pass the room
 * phase; when `phase` is provided and is not ACTIVE the resolution is
 * rejected (the DO's `resolveCatchOp` enforces the same rule).
 */
export function resolveCatch(input: {
  catchEvent: CatchEvent;
  resolverIsHost: boolean;
  decision: 'confirmed' | 'rejected';
  nowMs: number;
  phase?: MatchPhase;
}): CatchResult<CatchEvent> {
  const c = input.catchEvent;
  if (input.phase !== undefined && input.phase !== 'ACTIVE') {
    return { ok: false, code: 'INVALID_STATE', reason: 'Catches can only be resolved while the match is live.' };
  }
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
