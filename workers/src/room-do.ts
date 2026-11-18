import {
  transition, recordSuspension, purgeExpiredPings, authorisedSnapshot,
  issueCatchToken, verifyCatchToken, resolveCatch, gpsEvidenceForCatch,
  pointInPolygon, effectiveZoneBoundary, assignRoles, balancedHunterCount,
  applyConfirmedTag, resolveModeOutcome, buildPing, PING_AREA_RADIUS_M,
  randomOffsetShrinkBoundary, zoneDiameterMeters, SHRINK_RADIUS_FACTOR,
} from '@pakdam/engine';
import { CALIBRATION_OPEN, OUTSIDE_ZONE_RETURN_SECONDS, isValidDisplayName, isValidRoomCode, randomHex, sha256Hex, validateFix, validateRoomConfig, createGameEvent, redactForLog, parseGameEvent, resolveHostToggles } from '@pakdam/shared';
import type { WsTicketRecord } from './auth.js';
import { validateWsClientMessage } from './lib/validation.js';
import type { CatchEvent, CatchView, GameEvent, LocationFix, MatchPhase, MatchResult, Ping, Player, Room, RoomConfig } from '@pakdam/shared';
/**
 * Durable Object per active room — authoritative engine + WS fan-out.
 * Hibernation-safe: state is serialisable; on wake, recover from the
 * versioned event log + snapshot WITHOUT raw coordinates and WITHOUT
 * pending pings (HNT-120, v2.1 Issue 9). A recovered room marks every
 * player "location unknown" until a fresh foreground fix arrives.
 * Raw fixes live ONLY in this DO's memory, one latest fix per player,
 * purged at match end / TTL (HNT-068). They are NEVER persisted.
 *
 * Idempotency (17 §3.6): mutating WS commands carry a `commandId` (UUID).
 * Outcomes are stored per (seat, commandId) in DO memory and a duplicate
 * delivery returns the original replies with `replayed: true` on the
 * handler result — never a duplicate effect. The wire envelope has no
 * `replayed` field in the frozen §3.3 catalogue, so the live DO class
 * must surface the replay marker to the client out of band; do NOT invent
 * a wire field here. Retention window is OPEN (§3.6 §7); the in-memory
 * TTL below is a placeholder, not a measured requirement.
 */
export interface IdempotencyRecord {
  key: string; playerId: string; type: string;
  replies: WsServerMessage[]; serverSeq: number;
  issuedCatchToken?: { catchId: string; runnerPlayerId: string; token: string };
  storedAtMs: number;
}
/** Placeholder only — retention OPEN (17 §3.6, §7). */
export const IDEMPOTENCY_TTL_MS = 600_000;

export interface RoomDoState {
  room: Room; players: Player[]; latestFix: Record<string, LocationFix>;
  /** First-seen-outside timestamps (ms) per player — the 30-second
   *  return countdown runs from here (founder rule, 2026-11-17). Set
   *  when a location.update first shows the player outside the zone
   *  with a trustworthy fix, cleared when a fix shows them back
   *  inside. NOT recovered after hibernation (the countdown restarts;
   *  players must send a fresh foreground fix). Ejection at 0 IS
   *  enforced by the alarm loop (`alarmTick` below) — the gap the
   *  old code noted here is closed. */
  outsideSinceMs: Record<string, number>;
  /** Accumulated outside-zone time (ms) while the countdown is PAUSED
   *  (founder decision, docs/DECISIONS.md): when a player's live fix
   *  is poor (accuracy worse than the good tier), the countdown
   *  freezes — seconds already counted stay, no new seconds accrue —
   *  and resumes when accuracy recovers. The alarm ejects when
   *  accumulated + current segment >= 30 s. NOT recovered after
   *  hibernation (like outsideSinceMs). */
  outsideAccumMs: Record<string, number>;
  /** Last zone boundary the alarm emitted a ZONE_UPDATED event for
   *  (shrink detection). Compared by value each tick. Seeded with
   *  the boundary in force at match start (startMatch), so the first
   *  tick of a fresh room is quiet; null only before the match starts
   *  or after a recovery. NOT recovered (recomputed from the zone
   *  schedule after hibernation: the first tick after wake seeds it
   *  silently when no shrink has fired, while a shrink that fired
   *  while hibernating is still emitted once on wake). */
  lastZoneBoundary: { lat: number; lng: number }[] | null;
  /** Redacted game-event log (HNT-068): validated GameEvents with
   *  raw coordinates stripped (see `redactForLog` in shared/events).
   *  Capped at 500, like eventLog. This IS recovered — it is the
   *  durable audit trail the snapshot carries. */
  gameEventLog: Record<string, unknown>[];
  pendingPings: Ping[]; catches: CatchEvent[]; activeCatchIds: string[];
  /** Last DELIVERED ping per Runner (ms epoch) — drives the ping
   *  schedule in alarmTick (WIRING 2026-11-17). Timestamps only, no
   *  coordinates; durable (survives hibernation) so the schedule does
   *  not restart from zero on wake. Optional so older stored states
   *  (and the unit-test fixtures) still typecheck — readers treat a
   *  missing map as empty. Defaults to the match start for a Runner
   *  never pinged, so the first ping lands one interval in. */
  lastPingAtMs?: Record<string, number>;
  /** Host-token hashes (SEC-06 fix, Worker 5, 2026-11-17): playerId →
   *  sha256 of the per-seat HOST token issued at room creation (create
   *  response) or on rotation (POST /v1/rooms/:id/host/token). The host
   *  token is a SEPARATE credential from the reconnect token: the
   *  reconnect token proves a SEAT (WS tickets, rejoin, snapshots);
   *  the host token proves HOST authority (start, config, remove,
   *  transfer, dispute resolution, lifecycle end/resume). Only the
   *  current host seat ever has an entry here. It lives in DO state
   *  (never on the Player — the engine's authorisedSnapshot strips
   *  only reconnectTokenHash, so a Player-carried host hash would
   *  leak to every participant via GET /v1/rooms/:id), survives
   *  hibernation via snapshotForRecovery's ...rest, and is NEVER
   *  sent to any client — only its hash is stored, the raw token is
   *  returned once at issuance. A host transfer deletes the old
   *  host's entry; the successor must call issue-host-token (with
   *  their reconnect token) to get a fresh one. */
  hostTokens?: Record<string, string>;
  serverSeq: number; paused: boolean; pausedBy: string | null;
  /** Phase the match was in when safety-paused (QA 2026-11-17, GL-08):
   *  resume returns to THIS phase (HEAD_START stays HEAD_START),
   *  instead of always jumping to ACTIVE and losing the head start. */
  pausedFrom?: MatchPhase | null;
  sosActive: boolean; eventLog: { seq: number; type: string; actorId: string; at: string }[];
  idempotency: IdempotencyRecord[];
  /** WS ticket records registered by the Worker when it issues a
   *  ticket (SEC-11, 2026-11-17): hash-only records the DO uses to
   *  validate `auth.refresh` renewals itself and to check the
   *  handshake ticket on upgrade. In-memory ONLY — never persisted
   *  (excluded from snapshotForRecovery, reset by recoverState):
   *  after hibernation a socket renews via a fresh ticket fetched
   *  over HTTPS. Ticket VALUES are never stored here, only hashes. */
  wsTickets: WsTicketRecord[];
  /** WS per-seat rate-limit windows (SEC-12): `${playerId}:${type}`
   *  → accepted timestamps (ms). In-memory ONLY — excluded from the
   *  recovery snapshot, reset on recovery (a hibernated room starts
   *  with empty windows; a burst right after wake is bounded by the
   *  same per-message limits, so this is safe). */
  wsRate: Record<string, number[]>;
}
export function recoverState(saved: Omit<RoomDoState, 'latestFix' | 'pendingPings' | 'idempotency' | 'outsideSinceMs' | 'outsideAccumMs' | 'lastZoneBoundary' | 'wsTickets' | 'wsRate'> & { catches?: CatchEvent[]; sosActive?: boolean; gameEventLog?: Record<string, unknown>[] }): RoomDoState {
  const catches = (saved.catches ?? []).map((c) => {
    // A pending catch cannot survive recovery: its QR token hash is
    // stripped from the durable snapshot, so the token can no longer be
    // verified. It expires deterministically — never auto-confirmed.
    if (c.state === 'requested' || c.state === 'awaiting-confirmation') {
      return { ...c, state: 'expired' as const, qrTokenHash: null, resolution: 'recovery-expired' };
    }
    return { ...c, qrTokenHash: null };
  });
  return {
    ...saved,
    catches,
    activeCatchIds: catches.filter((c) => c.state === 'requested' || c.state === 'awaiting-confirmation').map((c) => c.catchId),
    lastPingAtMs: saved.lastPingAtMs ?? {},
    sosActive: saved.sosActive ?? false,
    gameEventLog: saved.gameEventLog ?? [],
    idempotency: [], // replay protection restarts after a recovery (17 §3.6 is silent on recovery; documented limitation)
    wsTickets: [], // ticket records are never persisted — a socket renews via a fresh HTTPS ticket after wake
    wsRate: {}, // rate windows restart after a recovery (same per-message limits bound any post-wake burst)
    latestFix: {}, // coordinates are NOT recovered — players must send a fresh foreground fix
    outsideSinceMs: {}, // outside-zone countdowns are NOT recovered — they restart from the next fix
    outsideAccumMs: {}, // paused countdown accumulation is NOT recovered either
    lastZoneBoundary: null, // recomputed from the zone schedule after wake
    pendingPings: [], // pending pings are NOT recovered — they are re-computed
    players: saved.players.map((p) => ({ ...p, connectionState: 'suspended' as const, locationQuality: 'unknown' as const })),
  };
}
export function snapshotForRecovery(s: RoomDoState): Omit<RoomDoState, 'latestFix' | 'pendingPings' | 'idempotency' | 'outsideSinceMs' | 'outsideAccumMs' | 'lastZoneBoundary' | 'wsTickets' | 'wsRate'> {
  const { latestFix: _lf, pendingPings: _pp, idempotency: _id, outsideSinceMs: _os, outsideAccumMs: _oa, lastZoneBoundary: _lz, wsTickets: _wt, wsRate: _wr, ...rest } = s;
  // QR token hashes are stripped from the durable snapshot (defence in
  // depth); recoverState() expires any pending catch whose hash is gone.
  return { ...rest, catches: rest.catches.map((c) => ({ ...c, qrTokenHash: null })) };
}
export function applyPhase(s: RoomDoState, to: MatchPhase, actorId?: string, nowMs?: number): RoomDoState {
  const from = s.room.phase;
  const next: RoomDoState = { ...s, room: { ...s.room, phase: transition(from, to), version: s.room.version + 1 }, serverSeq: s.serverSeq + 1 };
  const actor = actorId ?? s.room.hostPlayerId;
  // Match lifecycle events (validated GameEvents, redacted into the
  // durable log). MATCH_STARTED fires on entering HEAD_START — the
  // head start IS the match starting. MATCH_COMPLETED fires on
  // entering COMPLETED; the result comes from room.result when the
  // caller set it, else all-runners-caught → hunters-win, else
  // aborted (a match that ends without a recorded outcome).
  if (to === 'HEAD_START' && from !== 'HEAD_START') {
    return logGameEvent(next, createGameEvent('MATCH_STARTED', s.room.roomId, actor, {
      mode: s.room.config.mode,
      hunterIds: s.players.filter((p) => p.matchRole === 'hunter').map((p) => p.playerId),
      headStartSeconds: s.room.config.headStartSeconds,
      durationSeconds: s.room.config.durationSeconds,
    }));
  }
  if (to === 'COMPLETED' && from !== 'COMPLETED') {
    const caught = next.catches.filter((c) => c.state === 'confirmed').length;
    const result = next.room.result?.outcome;
    return logGameEvent(next, createGameEvent('MATCH_COMPLETED', s.room.roomId, actor, {
      result: result === 'hunters-win' || result === 'runners-win' ? result : 'aborted',
      caughtCount: caught,
      durationSeconds: next.room.startedAt ? Math.max(0, Math.round(((nowMs ?? Date.now()) - Date.parse(next.room.startedAt)) / 1000)) : 0,
    }));
  }
  return next;
}

/**
 * QA 2026-11-17 (GL-01/GL-02): completing a match the legal way.
 * The state machine forbids ACTIVE -> COMPLETED (and HEAD_START ->
 * COMPLETED): a match must pass through RESOLVING. alarmTick used to
 * call applyPhase(state, 'COMPLETED') directly, which threw
 * INVALID_STATE on every timer expiry — the match could never end on
 * the clock. completeMatch goes ACTIVE/HEAD_START -> RESOLVING ->
 * COMPLETED (HEAD_START -> RESOLVING is allowed by the machine) with
 * the result already set, so MATCH_COMPLETED logs the real outcome.
 */
/**
 * Location-fix retention (HNT-068, SEC-13, 2026-11-17).
 * Raw fixes live ONLY in DO memory, one latest fix per player.
 * - `FIX_TTL_MS`: a fix older than this is dropped from memory by
 *   `purgeStaleFixes` (called every alarm tick). PLACEHOLDER —
 *   OPEN calibration; 120 s is twice the 60 s arrival-staleness
 *   limit in shared/gps-validation, so no fix that could still be
 *   accepted on arrival is purged early.
 * - `purgeFixesOnMatchEnd`: the match is over, so every fix, every
 *   pending ping and every outside-zone counter is wiped at once —
 *   called by `completeMatch`. Nothing location-shaped survives a
 *   completed match in DO memory, and nothing was ever persisted.
 */
export const FIX_TTL_MS = 120_000;

export function purgeStaleFixes(s: RoomDoState, nowMs: number): RoomDoState {
  let changed = false;
  const latestFix = { ...s.latestFix };
  for (const [playerId, fix] of Object.entries(latestFix)) {
    const receivedMs = Date.parse(fix.receivedAt);
    if (Number.isNaN(receivedMs) || nowMs - receivedMs > FIX_TTL_MS) {
      delete latestFix[playerId];
      changed = true;
    }
  }
  if (!changed) return s;
  const staleIds = new Set(Object.keys(s.latestFix).filter((id) => !(id in latestFix)));
  return {
    ...s,
    latestFix,
    players: s.players.map((p) => (staleIds.has(p.playerId) ? { ...p, locationQuality: 'unknown' as const } : p)),
  };
}

export function purgeFixesOnMatchEnd(s: RoomDoState): RoomDoState {
  return {
    ...s,
    latestFix: {},
    pendingPings: [],
    outsideSinceMs: {},
    outsideAccumMs: {},
  };
}

export function completeMatch(s: RoomDoState, result: MatchResult, actorId: string, nowMs: number): RoomDoState {
  const withResult: RoomDoState = { ...s, room: { ...s.room, result } };
  const resolving = applyPhase(withResult, 'RESOLVING', actorId, nowMs);
  const completed = applyPhase(resolving, 'COMPLETED', actorId, nowMs);
  // SEC-13 / HNT-068: the match is over — wipe every raw fix, pending
  // ping and outside-zone counter from DO memory at once.
  return purgeFixesOnMatchEnd(completed);
}

/** Mode-aware outcome for the current state (ejected/left players are
 *  never survivors — resolveModeOutcome already excludes them). */
export function computeOutcome(s: RoomDoState, timeExpired: boolean, nowMs: number): MatchResult {
  const caught = s.catches.filter((c) => c.state === 'confirmed').map((c) => c.runnerPlayerId);
  const base = resolveModeOutcome(s.players, caught, timeExpired, s.room.config.mode);
  return {
    ...base,
    durationSeconds: s.room.startedAt ? Math.max(0, Math.round((nowMs - Date.parse(s.room.startedAt)) / 1000)) : 0,
  };
}

/** After a catch/ejection/leave, complete the match at once when the
 *  mode's win rule is already met (all Runners caught/turned/ejected/
 *  left) instead of waiting for the clock. No-op otherwise. */
export function maybeCompleteOnWin(s: RoomDoState, actorId: string, nowMs: number): { state: RoomDoState; completed: boolean } {
  if (s.room.phase !== 'ACTIVE' && s.room.phase !== 'HEAD_START') return { state: s, completed: false };
  const result = computeOutcome(s, false, nowMs);
  if (result.outcome !== 'hunters-win') return { state: s, completed: false };
  return { state: completeMatch(s, result, actorId, nowMs), completed: true };
}

/** Apply one CONFIRMED catch to the roster: Classic records the Runner
 *  as caught (role unchanged); Infection flips them to Hunter. Then
 *  complete the match at once when no Runner is left in play. */
export function applyConfirmedCatchToState(s: RoomDoState, c: CatchEvent, actorId: string, nowMs: number): RoomDoState {
  const tag = applyConfirmedTag(s.players, c.runnerPlayerId, s.room.config.mode);
  const next: RoomDoState = { ...s, players: tag.players };
  return maybeCompleteOnWin(next, actorId, nowMs).state;
}

/**
 * QA 2026-11-17 (GL-03): start a match server-side, enforcing the
 * rules the DO class used to skip entirely (its old code jumped
 * LOBBY -> HEAD_START, an illegal transition that threw, with no
 * role assignment, no minimum-player check and no ready check).
 * Host only; >= 3 active players; every active player ready; roles
 * assigned here (Balance / Random shuffle / host-picked) and the
 * effective hunterCount written back to the config; then the legal
 * walk LOBBY -> READY_CHECK -> COUNTDOWN -> HEAD_START.
 */
export type StartMatchResult = { ok: true; state: RoomDoState } | { ok: false; error: string };
export function startMatch(s: RoomDoState, actorId: string, nowMs: number): StartMatchResult {
  if (s.room.phase !== 'LOBBY') return { ok: false, error: `cannot start while ${s.room.phase}` };
  if (actorId !== s.room.hostPlayerId) return { ok: false, error: 'only the host may start the match' };
  const active = s.players.filter((p) => !p.leftAt);
  if (active.length < 3) return { ok: false, error: 'need at least 3 players to start' };
  const notReady = active.filter((p) => !p.isReady);
  if (notReady.length > 0) return { ok: false, error: `waiting for ready: ${notReady.map((p) => p.displayName).join(', ')}` };
  const toggles = resolveHostToggles(s.room.config);
  let effective = toggles.balanceHunters ? balancedHunterCount(active.length) : s.room.config.hunterCount;
  effective = Math.max(1, Math.min(effective, active.length - 1));
  let assigned: Player[];
  try {
    if (s.room.config.teamAssignment === 'selected') {
      const picked = s.room.config.selectedHunterIds;
      if (picked.length === effective) {
        assigned = assignRoles(active, effective, { teamAssignment: 'selected', selectedHunterIds: picked });
      } else if (picked.length === s.room.config.hunterCount) {
        // QA BE-10 (2026-11-17): Balance changed the effective count
        // AFTER the host picked exactly the stored hunterCount (the
        // lobby UI only lets the host pick exactly that many) — the
        // old strict check 409'd forever and the match could never
        // start. A pick that was complete when made never blocks the
        // start: draw the Hunters at random instead (shuffled when
        // Random draw is on). A pick that does NOT match the stored
        // hunterCount is a genuinely short/stale pick the host can
        // still fix in the lobby, so it still 409s (GL-03b).
        assigned = assignRoles(active, effective, { teamAssignment: 'random', shuffle: toggles.randomDraw });
      } else {
        return { ok: false, error: `host must pick exactly ${s.room.config.hunterCount} Hunter(s) in the lobby` };
      }
    } else {
      assigned = assignRoles(active, effective, { teamAssignment: 'random', shuffle: toggles.randomDraw });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'role assignment failed' };
  }
  const byId = new Map(assigned.map((p) => [p.playerId, p]));
  const players = s.players.map((p) => byId.get(p.playerId) ?? p);
  const startedAt = new Date(nowMs).toISOString();
  const endsAt = new Date(nowMs + s.room.config.durationSeconds * 1000).toISOString();
  let state: RoomDoState = {
    ...s, players,
    // Worker 4 fix (2026-11-18): seed the shrink-detection baseline
    // with the boundary in force at match start. Before this,
    // lastZoneBoundary stayed null on a fresh room, so the first
    // alarm tick compared the unchanged base boundary against null
    // and emitted a spurious zone.update (phase 0, unchanged
    // boundary). Seeding here makes the first tick quiet; alarmTick
    // also seeds silently when it meets a null baseline with no
    // shrink fired (e.g. after a recovery), so the fix holds on
    // both paths.
    lastZoneBoundary: s.room.config.zone
      ? effectiveZoneBoundary(s.room.config.zone, startedAt, nowMs)
      : null,
    room: { ...s.room, config: { ...s.room.config, hunterCount: effective }, startedAt, endsAt },
  };
  state = applyPhase(state, 'READY_CHECK', actorId, nowMs);
  state = applyPhase(state, 'COUNTDOWN', actorId, nowMs);
  state = applyPhase(state, 'HEAD_START', actorId, nowMs);
  return { ok: true, state };
}
export function applySuspension(s: RoomDoState, playerId: string): { state: RoomDoState; hostCheckinRequired: boolean } {
  const p = s.players.find((x) => x.playerId === playerId);
  if (!p) return { state: s, hostCheckinRequired: false };
  const { player, outcome } = recordSuspension(p, CALIBRATION_OPEN.suspensionCountBeforeHostCheckin);
  return { state: { ...s, players: s.players.map((x) => (x.playerId === playerId ? player : x)), pendingPings: purgeExpiredPings(s.pendingPings, Date.now()) }, hostCheckinRequired: outcome.hostCheckinRequired };
}

// ---------------------------------------------------------------------------
// Host authority — SEC-06 (Worker 5, 2026-11-17).
// Two credentials, two jobs: the RECONNECT token proves a seat (WS
// tickets, rejoin, snapshots); the HOST token proves host authority
// (start, config, remove-player, host transfer, dispute resolution,
// lifecycle start/resume/end). The host token is issued at room
// creation (raw value returned ONCE in the 201 response) and on
// rotation via the issue-host-token op (the caller proves the host
// seat with their reconnect token first). Only the sha256 hash is
// ever stored (RoomDoState.hostTokens — never on the Player, so the
// engine's authorisedSnapshot cannot leak it). Issuing a new token
// ROTATES: the previous hash for that seat is replaced, so a leaked
// old host token dies on rotation. A host transfer deletes the old
// host's entry — the successor holds no host token until they call
// issue-host-token with their own reconnect token.
// ---------------------------------------------------------------------------

/** One server → client message, built the same way everywhere in this
 *  file (the `msg` helper inside applyGameCommand is closure-bound to
 *  one call; these functions need a module-level builder). */
function serverMessage(roomId: string, type: WsServerMessage['type'], payload: never, serverSeq: number, serverTs: number): WsServerMessage {
  return {
    v: 1, type, roomId, eventId: randomEventId(),
    serverSeq, serverTs, payload,
  } as WsServerMessage;
}

export type IssueHostTokenResult = { ok: true; state: RoomDoState; token: string } | { ok: false; error: string };

/** Issue (or rotate) the host token for the CURRENT host seat. The
 *  caller (DO class) must already have verified the seat's reconnect
 *  token — this function checks seat existence + isHost only. The raw
 *  token is returned here for the single HTTPS response that delivers
 *  it; it is never stored, never logged, and never appears in any
 *  broadcast, snapshot, or idempotency record. */
export function issueHostToken(s: RoomDoState, playerId: string): IssueHostTokenResult {
  const player = s.players.find((p) => p.playerId === playerId);
  if (!player) return { ok: false, error: 'unknown seat in this room' };
  if (!player.isHost) return { ok: false, error: 'only the host seat holds a host token' };
  const token = randomHex(16);
  return {
    ok: true,
    state: { ...s, hostTokens: { ...(s.hostTokens ?? {}), [playerId]: sha256Hex(token) } },
    token,
  };
}

/** Does the presented raw host token belong to the current host seat?
 *  False for every non-host seat, for a missing/empty token, and for a
 *  token issued to a PREVIOUS host (transfer deletes the old entry). */
export function verifyHostToken(s: RoomDoState, playerId: string, token: string): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const player = s.players.find((p) => p.playerId === playerId);
  if (!player || !player.isHost) return false;
  if (playerId !== s.room.hostPlayerId) return false;
  const hash = s.hostTokens?.[playerId];
  return hash !== undefined && sha256Hex(token) === hash;
}

export type TransferHostResult =
  | { ok: true; state: RoomDoState; message: WsServerMessage }
  | { ok: false; error: string };

/** Explicit host transfer (POST /v1/rooms/:id/host/transfer). The old
 *  host's token entry is deleted — host authority does not survive a
 *  transfer — and the successor holds NO host token until they call
 *  issue-host-token with their own reconnect token. (The automatic
 *  transfer on host-leave, in the WS `leave` handler, follows the
 *  same rule: it reassigns isHost/hostPlayerId only, and mints no
 *  token — the successor fetches one over HTTPS.) */
export function transferHost(s: RoomDoState, actorId: string, newHostPlayerId: string, nowMs: number): TransferHostResult {
  if (actorId !== s.room.hostPlayerId) return { ok: false, error: 'only the host may transfer host powers' };
  if (newHostPlayerId === actorId) return { ok: false, error: 'that seat is already the host' };
  const successor = s.players.find((p) => p.playerId === newHostPlayerId);
  if (!successor) return { ok: false, error: 'unknown seat in this room' };
  if (successor.leftAt || successor.ejectedAt) return { ok: false, error: 'the new host must still be in the room' };
  const hostTokens = { ...(s.hostTokens ?? {}) };
  delete hostTokens[actorId];
  const next: RoomDoState = {
    ...s,
    hostTokens,
    room: { ...s.room, hostPlayerId: newHostPlayerId },
    players: s.players.map((p) =>
      p.playerId === newHostPlayerId ? { ...p, isHost: true }
      : p.playerId === actorId ? { ...p, isHost: false } : p),
    serverSeq: s.serverSeq + 1,
  };
  const logged = logEvent(next, 'host.transferred', actorId, nowMs);
  return {
    ok: true,
    state: logged,
    message: serverMessage(
      s.room.roomId, 'host.transferred',
      { previousHostPlayerId: actorId, newHostPlayerId, serverSeq: logged.serverSeq } as never,
      logged.serverSeq, nowMs,
    ),
  };
}

export type UpdateConfigResult = { ok: true; state: RoomDoState } | { ok: false; error: string };

/** Host-only lobby settings change (POST /v1/rooms/:id/config). The
 *  full new config is validated with validateRoomConfig — the same
 *  authority the create path uses — and the change is LOBBY-only, so
 *  a match in progress can never have its rules rewritten under it.
 *  Mirrors the demo store: changing the Hunter count or the team
 *  assignment clears any host-picked Hunters (the old pick may no
 *  longer hold the right number). */
export function updateRoomConfig(s: RoomDoState, actorId: string, config: RoomConfig): UpdateConfigResult {
  if (actorId !== s.room.hostPlayerId) return { ok: false, error: 'only the host may change the room config' };
  if (s.room.phase !== 'LOBBY') return { ok: false, error: `room config can only change while LOBBY (now ${s.room.phase})` };
  const errors = validateRoomConfig(config);
  if (errors.length > 0) return { ok: false, error: `invalid room config: ${errors.join('; ')}` };
  const hunterCountChanged = config.hunterCount !== s.room.config.hunterCount;
  const assignmentChanged = config.teamAssignment !== s.room.config.teamAssignment;
  const nextConfig = hunterCountChanged || assignmentChanged
    ? { ...config, selectedHunterIds: [] } : config;
  return {
    ok: true,
    state: { ...s, room: { ...s.room, config: nextConfig, version: s.room.version + 1 }, serverSeq: s.serverSeq + 1 },
  };
}

export type ResolveCatchResult =
  | { ok: true; state: RoomDoState; catch: CatchEvent; messages: WsServerMessage[] }
  | { ok: false; error: string };

/** Host resolution of a DISPUTED catch (POST
 *  /v1/rooms/:id/catches/:cid/resolve — "host resolves disputes",
 *  founder checklist). Only a catch in state 'disputed' can be
 *  resolved, and only by the host seat. 'confirmed' applies the mode
 *  rule (Classic records the tag; Infection flips the Runner) and
 *  the win rule, exactly like a Runner confirm; 'rejected' voids the
 *  claim (state 'rejected', Runner stays free). The resolution is
 *  recorded as 'host-review' on the catch itself. No PLAYER_TAGGED
 *  GameEvent is logged here: its method enum (shared/events.ts) has
 *  no host-review value, and logging a fake 'qr'/'manual' method
 *  would lie about how the tag completed — the plain audit log
 *  ('catch.confirm' / 'catch.rejected') plus the catch record carry
 *  the resolution instead. */
export function resolveDisputedCatch(
  s: RoomDoState, catchId: string, actorId: string,
  decision: 'confirmed' | 'rejected', nowMs: number,
): ResolveCatchResult {
  if (actorId !== s.room.hostPlayerId) return { ok: false, error: 'only the host may resolve a disputed catch' };
  const c = s.catches.find((x) => x.catchId === catchId);
  if (!c) return { ok: false, error: 'unknown catchId' };
  if (c.state !== 'disputed') return { ok: false, error: `catch is ${c.state}, not disputed` };
  const nowIso = new Date(nowMs).toISOString();
  if (decision === 'rejected') {
    const rejected: CatchEvent = { ...c, state: 'rejected', resolution: 'host-review' };
    const next: RoomDoState = {
      ...s,
      catches: s.catches.map((x) => (x.catchId === catchId ? rejected : x)),
      activeCatchIds: s.activeCatchIds.filter((id) => id !== catchId),
      serverSeq: s.serverSeq + 1,
    };
    const logged = logEvent(next, 'catch.rejected', actorId, nowMs);
    return {
      ok: true, state: logged, catch: rejected,
      messages: [serverMessage(s.room.roomId, 'catch.rejected', { catch: toCatchView(rejected), serverSeq: next.serverSeq } as never, next.serverSeq, nowMs)],
    };
  }
  const confirmed: CatchEvent = { ...c, state: 'confirmed', confirmedAt: nowIso, resolution: 'host-review' };
  const next: RoomDoState = {
    ...s,
    catches: s.catches.map((x) => (x.catchId === catchId ? confirmed : x)),
    activeCatchIds: s.activeCatchIds.filter((id) => id !== catchId),
    serverSeq: s.serverSeq + 1,
  };
  const logged = logEvent(next, 'catch.confirm', actorId, nowMs);
  const finalState = applyConfirmedCatchToState(logged, confirmed, s.room.hostPlayerId, nowMs);
  const messages: WsServerMessage[] = [
    serverMessage(s.room.roomId, 'catch.confirmed', { catch: toCatchView(confirmed), serverSeq: next.serverSeq } as never, next.serverSeq, nowMs),
  ];
  if (finalState.room.phase === 'COMPLETED' && finalState.room.result) {
    messages.push(serverMessage(s.room.roomId, 'match.completed', { result: finalState.room.result, serverSeq: finalState.serverSeq } as never, finalState.serverSeq, nowMs));
  }
  return { ok: true, state: finalState, catch: confirmed, messages };
}

export type EndMatchResult =
  | { ok: true; state: RoomDoState; messages: WsServerMessage[] }
  | { ok: false; error: string };

/** Host ends the match early (lifecycle action 'end'). Any live phase
 *  may be cancelled (the state machine allows CANCELLED from LOBBY,
 *  READY_CHECK, COUNTDOWN, HEAD_START, ACTIVE and SAFETY_PAUSED); a
 *  terminal phase cannot be ended again. The result is outcome
 *  'cancelled' with the runners caught so far. Raw coordinates are
 *  purged at match end (HNT-068): latestFix, pendingPings and the
 *  outside-zone counters are dropped with the match, not left in
 *  memory for a cancelled room. */
export function endMatch(s: RoomDoState, actorId: string, nowMs: number): EndMatchResult {
  if (actorId !== s.room.hostPlayerId) return { ok: false, error: 'only the host may end the match' };
  const cancellable: MatchPhase[] = ['LOBBY', 'READY_CHECK', 'COUNTDOWN', 'HEAD_START', 'ACTIVE', 'SAFETY_PAUSED'];
  if (!cancellable.includes(s.room.phase)) return { ok: false, error: `cannot end a match while ${s.room.phase}` };
  const caught = s.catches.filter((c) => c.state === 'confirmed').map((c) => c.runnerPlayerId);
  const surviving = s.players
    .filter((p) => p.matchRole === 'runner' && !caught.includes(p.playerId) && !p.leftAt && !p.ejectedAt)
    .map((p) => p.playerId);
  const result: MatchResult = {
    outcome: 'cancelled',
    durationSeconds: s.room.startedAt ? Math.max(0, Math.round((nowMs - Date.parse(s.room.startedAt)) / 1000)) : 0,
    caughtRunnerIds: caught,
    survivingRunnerIds: surviving,
  };
  let state: RoomDoState = {
    ...s,
    room: { ...s.room, result },
    latestFix: {}, pendingPings: [], outsideSinceMs: {}, outsideAccumMs: {},
  };
  state = applyPhase(state, 'CANCELLED', actorId, nowMs);
  const logged = logEvent(state, 'match.cancelled', actorId, nowMs);
  return {
    ok: true,
    state: logged,
    messages: [
      serverMessage(s.room.roomId, 'match.cancelled', { result, serverSeq: logged.serverSeq } as never, logged.serverSeq, nowMs),
      serverMessage(s.room.roomId, 'room.state', { phase: 'CANCELLED', version: logged.room.version, serverSeq: logged.serverSeq, reason: 'match-ended' } as never, logged.serverSeq, nowMs),
    ],
  };
}

/** Recipient-filtered snapshot for the DO `get-state` op.
 *  SECURITY (QA 2026-11-17, SEC-02): returns null when `playerId` is not
 *  a seat in this room. The previous version returned the full roster to
 *  ANY caller that named a playerId — including a non-member — which is
 *  an IDOR on room membership. The DO class maps null to 404. The
 *  snapshot itself is hash-stripped by authorisedSnapshot (SEC-01). */
export function snapshotForPlayer(s: RoomDoState, playerId: string) {
  if (!s.players.some((p) => p.playerId === playerId)) return null;
  return authorisedSnapshot(s.room, s.players, playerId); // HNT-038: no hidden coordinates
}

/** Does the presented raw reconnect token belong to this seat?
 *  Pure helper (SEC-10, 2026-11-17): the DO `get-state` op checks
 *  this itself (defence in depth — the Worker already verified the
 *  same token before forwarding), and the unit tests drive it
 *  directly. The raw token is never stored or logged; only the
 *  SHA-256 hash on the Player record is compared. */
export function verifyReconnectToken(s: RoomDoState, playerId: string, token: string): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const player = s.players.find((p) => p.playerId === playerId);
  if (!player) return false;
  return sha256Hex(token) === player.reconnectTokenHash;
}

// ---------------------------------------------------------------------------
// Room-code index (Worker F, 2026-11-17): code → roomId.
//
// WHY A DO INDEX, NOT SUPABASE OR WORKER MEMORY:
//  - Worker memory is per-isolate (see the WsTicketStore note in
//    http.ts): a code registered in one isolate is invisible to
//    every other isolate and dies on eviction — a lookup would
//    404 rooms that exist. Not an index.
//  - Supabase `rooms` rows are best-effort (persistRoomCreated via
//    ctx.waitUntil — a failure never fails the 201) and Supabase
//    may be unconfigured, so a Supabase-only lookup could miss a
//    live room. Not the authority.
//  - The index is therefore a SINGLETON Durable Object instance —
//    `env.ROOM_DO.idFromName(CODE_INDEX_DO_NAME)` — one global
//    instance of the existing RoomDurableObject class, holding NO
//    room state, only this map under its own storage key
//    (room-do-class.ts `register-code` / `lookup-code` ops). It
//    reuses the existing ROOM_DO binding and migration, so no
//    wrangler.toml change is needed. A dedicated index DO class
//    would be cleaner at scale (one less overloaded class) but
//    needs a new binding + migration — a follow-up, not a blocker.
//  - The Worker registers the code SYNCHRONOUSLY in handleCreateRoom
//    before the 201 returns, so a code is always resolvable the
//    moment the host sees it. The map is append-only in practice:
//    rooms are never deleted, so codes are never unregistered.
//  - The map holds ONLY code → roomId UUID. No player list, no
//    config, no tokens, no location — the lookup answer cannot leak
//    anything beyond "this code names this room".
// ---------------------------------------------------------------------------

/** The code index: room code (6 chars A-Z0-9) → roomId UUID. */
export type CodeIndex = Record<string, string>;

/** Resolve a code to its roomId, or null when the code is unknown.
 *  Pure — the DO class loads/stores the map around it. */
export function lookupRoomCode(index: CodeIndex, roomCode: string): string | null {
  return index[roomCode] ?? null;
}

/** Register code → roomId. First writer wins: re-registering the
 *  SAME code for the SAME room is a no-op (idempotent retry — the
 *  Worker may re-send after a transport blip); the SAME code for a
 *  DIFFERENT room is a conflict, and the original mapping is kept
 *  untouched. The caller retries a conflict with a fresh code (the
 *  code space is 32^6, so a collision is ~1 in a billion per
 *  create — the retry exists for correctness, not for frequency). */
export function registerRoomCode(index: CodeIndex, roomCode: string, roomId: string): { index: CodeIndex; conflict: boolean } {
  const existing = index[roomCode];
  if (existing !== undefined) {
    return { index, conflict: existing !== roomId };
  }
  return { index: { ...index, [roomCode]: roomId }, conflict: false };
}

/** Remove a code → roomId mapping, but ONLY when it names this room
 *  (D-M2 regenerate: the old code is unregistered after the new one
 *  is live, so a stale mapping can never steal another room's code).
 *  Removing a code that names a different room — or no room — is a
 *  no-op returning the index unchanged. */
export function unregisterRoomCode(index: CodeIndex, roomCode: string, roomId: string): CodeIndex {
  if (index[roomCode] !== roomId) return index;
  const next = { ...index };
  delete next[roomCode];
  return next;
}

export type RegenerateCodeResult =
  | { ok: true; state: RoomDoState; oldRoomCode: string; newRoomCode: string }
  | { ok: false; error: string };

/** Host-only room-code regeneration (D-M2, POST
 *  /v1/rooms/:id/regenerate-code). The host proves host authority
 *  with the host token at the Worker; this pure function re-checks
 *  actorId === host and LOBBY-only (a code change mid-match would
 *  strand players joining from the old invite). The new code is
 *  supplied by the Worker, which generated it and already registered
 *  it in the code index for this room before calling — this function
 *  only validates its shape and that it differs from the current
 *  code, then swaps it in and bumps the version. The OLD code stops
 *  working the moment this lands: joins verify the presented code
 *  against `room.roomCode` (verify-code op), and the Worker
 *  unregisters the old mapping from the index right after, so even
 *  the lookup stops resolving it. */
export function regenerateRoomCode(s: RoomDoState, actorId: string, newCode: string): RegenerateCodeResult {
  if (actorId !== s.room.hostPlayerId) return { ok: false, error: 'only the host may change the room code' };
  if (s.room.phase !== 'LOBBY') return { ok: false, error: `room code can only change while LOBBY (now ${s.room.phase})` };
  if (!isValidRoomCode(newCode)) return { ok: false, error: 'new room code must be 6 characters A-Z0-9' };
  if (newCode === s.room.roomCode) return { ok: false, error: 'new room code must differ from the current code' };
  return {
    ok: true,
    state: { ...s, room: { ...s.room, roomCode: newCode, version: s.room.version + 1 }, serverSeq: s.serverSeq + 1 },
    oldRoomCode: s.room.roomCode,
    newRoomCode: newCode,
  };
}

// ---------------------------------------------------------------------------
// Alarm loop — the DO's timer authority (founder-approved final stack).
// The Durable Object is the SOLE authority for active gameplay: timers
// live here, not on any client. `alarmTick` is pure (state in, state +
// broadcast messages out) so the unit tests can drive it without a
// Workers runtime; the live DO class (room-do-class.ts) calls it from
// `alarm()`, persists the state, and broadcasts the messages.
//
// Each tick handles, in order:
//   1. HEAD_START → ACTIVE when the configured head start elapses.
//   2. Match end (endsAt reached) → COMPLETED + result + MATCH_COMPLETED.
//   3. Outside-zone ejection: accumulated + current segment >= 30 s.
//   4. Zone shrink: the effective boundary changed → the DO draws
//      the next zone HERE, per shrink (random offset, server-side),
//      then ZONE_UPDATED + a `zone.update` broadcast. Only the shrink
//      TIMES are pre-computed in the zone config; the stored phase
//      boundary is a size placeholder, never the live boundary.
// Timers FREEZE while SAFETY_PAUSED (resume shifts startedAt/endsAt,
// so the tick needs no pause logic — a paused room simply never
// reaches its deadlines while paused, because the deadlines moved).
// The return value's `alarmDelayMs` tells the DO class when to fire
// next: 1 s while a timer is live, 30 s in the lobby, null when the
// match is over (no more alarms).
// ---------------------------------------------------------------------------
export const OUTSIDE_ZONE_LIMIT_MS = OUTSIDE_ZONE_RETURN_SECONDS * 1000;

function ejectPlayer(s: RoomDoState, playerId: string, nowMs: number): { state: RoomDoState; message: WsServerMessage } {
  const nowIso = new Date(nowMs).toISOString();
  const outsideSinceMs = { ...s.outsideSinceMs };
  const outsideAccumMs = { ...s.outsideAccumMs };
  delete outsideSinceMs[playerId];
  delete outsideAccumMs[playerId];
  const next: RoomDoState = {
    ...s,
    players: s.players.map((p) => (p.playerId === playerId ? { ...p, ejectedAt: nowIso, connectionState: 'disconnected' as const } : p)),
    outsideSinceMs,
    outsideAccumMs,
    serverSeq: s.serverSeq + 1,
  };
  const withEvent = logGameEvent(
    logEvent(next, 'player.ejected', playerId, nowMs),
    createGameEvent('PLAYER_DISCONNECTED', s.room.roomId, playerId, { playerId, reason: 'ejected' }),
  );
  const ejected = withEvent.players.find((p) => p.playerId === playerId)!;
  const { reconnectTokenHash: _hash, ...playerView } = ejected;
  return {
    state: withEvent,
    message: {
      v: 1, type: 'player.removed', roomId: s.room.roomId,
      eventId: randomEventId(), serverSeq: withEvent.serverSeq, serverTs: nowMs,
      payload: { player: playerView, serverSeq: withEvent.serverSeq },
    },
  };
}

/** Add a player to a room (join path, called by the DO class after
 *  the Worker validated the room code + display name). Returns the
 *  new state, the raw reconnect token (returned ONCE to the join
 *  caller over HTTPS — never stored, never logged, only its hash is
 *  kept), and the broadcast message. Joining with an existing display
 *  name restores that seat instead of duplicating it (same rule as
 *  the demo store).
 *
 * SECURITY (QA 2026-11-17):
 * - SEC-03: there is NO `isHost` parameter any more. A previous version
 *   took `isHost` from the caller, so any joining client could claim
 *   host powers by passing `isHost: true`. New seats are ALWAYS
 *   non-host; the host seat is created by the `create` op only. A
 *   restore keeps the seat's existing `isHost` flag.
 * - SEC-04: the display name is validated server-side (1–30 chars,
 *   no URL) via `isValidDisplayName`. Previously a blank name reached
 *   `logGameEvent` and threw an uncaught ZodError (no clean validation
 *   error), and a URL-shaped name was accepted. The DO class also
 *   validates first and returns 400; this throw is the second layer.
 * - SEC-05: a NEW join is allowed only while the room is in LOBBY.
 *   Previously a brand-new player could join an ACTIVE/COMPLETED room
 *   (no phase check anywhere on the join path). Restoring an existing
 *   seat is a resume, not a new join, and is allowed in any phase.
 * - SEC-06 (FIXED, Worker 5, 2026-11-17): restore-by-display-name
 *   now REQUIRES the seat's reconnect token (`opts.reconnectToken`).
 *   The old code restored any seat — including the host seat — to
 *   anyone who knew its display name. A restore with a missing or
 *   wrong token throws FORBIDDEN and restores nothing. The Worker
 *   join route forwards the token when the client presents it
 *   (joinBody.reconnectToken, optional for a NEW join, required for
 *   a restore). Host authority itself is a SEPARATE credential — the
 *   host token (see hostTokens on RoomDoState) — so even a restored
 *   host seat cannot start/config/transfer/resolve without it. */
export function addPlayer(
  s: RoomDoState, displayName: string, kind: 'host-account' | 'guest', nowMs: number,
  opts?: { reconnectToken?: string },
): { state: RoomDoState; player: Player; reconnectToken: string; message: WsServerMessage; restored: boolean } {
  if (typeof displayName !== 'string' || !isValidDisplayName(displayName)) {
    throw new Error('VALIDATION_FAILED: display name must be 1–30 characters and must not contain a URL');
  }
  const trimmed = displayName.trim();
  const existing = s.players.find((p) => p.displayName.trim().toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    // SEC-06: a restore is a rejoin, not a new join — the seat's
    // reconnect token must be presented and must match the stored
    // hash. No token (or a wrong one) never restores the seat.
    if (!opts?.reconnectToken || sha256Hex(opts.reconnectToken) !== existing.reconnectTokenHash) {
      throw new Error('FORBIDDEN: reconnect token is required to restore this seat and does not match');
    }
    // Restore: same seat, same role, host powers if host. A left
    // player rejoins as connected; an ejection is NEVER undone by
    // rejoining — and an ejected seat must NOT flip back to
    // 'connected' while ejectedAt is set (QA BE-09, 2026-11-17: the
    // old code marked an ejected player connected on restore, so an
    // ejected Runner looked live again while still being ejected).
    const restored: Player = {
      ...existing,
      leftAt: null,
      connectionState: existing.ejectedAt ? existing.connectionState : 'connected',
      isHost: existing.isHost,
    };
    const next: RoomDoState = {
      ...s,
      players: s.players.map((p) => (p.playerId === existing.playerId ? restored : p)),
      serverSeq: s.serverSeq + 1,
    };
    const { reconnectTokenHash: _hash, ...view } = restored;
    return {
      state: next, player: restored, reconnectToken: '', restored: true,
      message: {
        v: 1, type: 'player.joined', roomId: s.room.roomId,
        eventId: randomEventId(), serverSeq: next.serverSeq, serverTs: nowMs,
        payload: { player: view, serverSeq: next.serverSeq },
      },
    };
  }
  if (s.room.phase !== 'LOBBY') {
    throw new Error(`INVALID_STATE: room is not open for joining while the match is ${s.room.phase}`);
  }
  const playerId = globalThis.crypto.randomUUID();
  const reconnectToken = globalThis.crypto.randomUUID();
  const player: Player = {
    playerId, roomId: s.room.roomId, kind, displayName: trimmed, isHost: false,
    matchRole: null, team: null,
    reconnectTokenHash: sha256Hex(reconnectToken),
    joinedAt: new Date(nowMs).toISOString(), leftAt: null,
    connectionState: 'connected', lastFixAt: null, locationQuality: 'unknown',
    isReady: false, briefingConfirmed: false, ageGatePassed: true,
    suspensionCount: 0, ejectedAt: null,
  };
  const next: RoomDoState = {
    ...s, players: [...s.players, player], serverSeq: s.serverSeq + 1,
  };
  const withEvent = logGameEvent(next, createGameEvent('PLAYER_JOINED', s.room.roomId, playerId, {
    displayName: trimmed, kind,
  }));
  const { reconnectTokenHash: _hash, ...view } = player;
  return {
    state: withEvent, player, reconnectToken, restored: false,
    message: {
      v: 1, type: 'player.joined', roomId: s.room.roomId,
      eventId: randomEventId(), serverSeq: withEvent.serverSeq, serverTs: nowMs,
      payload: { player: view, serverSeq: withEvent.serverSeq },
    },
  };
}

export interface AlarmTickResult {
  state: RoomDoState;
  messages: WsServerMessage[];
  /** ms until the next alarm, or null when no further alarms are needed. */
  alarmDelayMs: number | null;
}

export function alarmTick(s: RoomDoState, nowMs: number): AlarmTickResult {
  const messages: WsServerMessage[] = [];
  // SEC-13 / HNT-068: every tick drops fixes older than FIX_TTL_MS
  // from DO memory, so stale coordinates never linger past the match.
  let state = purgeStaleFixes(s, nowMs);
  const phase = state.room.phase;

  // 1. Head start → ACTIVE.
  if (phase === 'HEAD_START' && state.room.startedAt) {
    const headStartEndMs = Date.parse(state.room.startedAt) + state.room.config.headStartSeconds * 1000;
    if (nowMs >= headStartEndMs) {
      state = applyPhase(state, 'ACTIVE', state.room.hostPlayerId, nowMs);
      messages.push({
        v: 1, type: 'room.state', roomId: state.room.roomId, eventId: randomEventId(),
        serverSeq: state.serverSeq, serverTs: nowMs,
        payload: { phase: 'ACTIVE', version: state.room.version, serverSeq: state.serverSeq, reason: 'head-start-elapsed' },
      });
    }
  }

  // 2. Match end (endsAt reached) — only from a live phase, and never
  // while paused (resume shifts endsAt, so a paused room cannot reach
  // its deadline here). Outcome is mode-aware and excludes ejected /
  // left players (computeOutcome); the match completes via RESOLVING
  // (completeMatch) — the old code called applyPhase(COMPLETED)
  // directly, which the state machine forbids and threw (GL-01).
  if ((state.room.phase === 'ACTIVE' || state.room.phase === 'HEAD_START') && state.room.endsAt) {
    if (nowMs >= Date.parse(state.room.endsAt)) {
      const result = computeOutcome(state, true, nowMs);
      state = completeMatch(state, result, state.room.hostPlayerId, nowMs);
      messages.push({
        v: 1, type: 'match.completed', roomId: state.room.roomId, eventId: randomEventId(),
        serverSeq: state.serverSeq, serverTs: nowMs,
        payload: { result: state.room.result, serverSeq: state.serverSeq },
      });
    }
  }

  // 3. Outside-zone ejection (accumulated + current segment >= 30 s).
  // Only while the match is live. A player whose countdown is paused
  // (poor GPS) accrues nothing — outsideAccumMs holds only counted
  // seconds, and a paused segment contributes nothing until it resumes.
  // An ejection can end the match (no Runner left in play) — check
  // the win rule after the loop (GL-02).
  if (state.room.phase === 'ACTIVE' || state.room.phase === 'HEAD_START') {
    let ejectedAny = false;
    for (const p of [...state.players]) {
      if (p.ejectedAt || p.leftAt) continue;
      const accum = state.outsideAccumMs[p.playerId] ?? 0;
      const segment = state.outsideSinceMs[p.playerId] !== undefined ? nowMs - state.outsideSinceMs[p.playerId]! : 0;
      if (accum + segment >= OUTSIDE_ZONE_LIMIT_MS) {
        const ejected = ejectPlayer(state, p.playerId, nowMs);
        state = ejected.state;
        messages.push(ejected.message);
        ejectedAny = true;
      }
    }
    if (ejectedAny) {
      const won = maybeCompleteOnWin(state, state.room.hostPlayerId, nowMs);
      if (won.completed) {
        state = won.state;
        messages.push({
          v: 1, type: 'match.completed', roomId: state.room.roomId, eventId: randomEventId(),
          serverSeq: state.serverSeq, serverTs: nowMs,
          payload: { result: state.room.result, serverSeq: state.serverSeq },
        });
      }
    }
  }

  // 4. Zone shrink — the effective boundary changed since the last
  // emitted ZONE_UPDATED. The shrink TIMES are pre-computed in the
  // zone config, but the random POSITION is drawn HERE, by the DO,
  // at the moment the shrink fires (2026-11-17): the stored
  // phase boundary (drawn by the host client at creation) is only a
  // size placeholder — the live boundary is re-drawn per shrink
  // from the boundary in force, so no client can fix the next zone
  // in advance. The drawn boundary replaces the stored one in the
  // room config, so snapshots, previews and later ticks all agree.
  if ((state.room.phase === 'ACTIVE' || state.room.phase === 'HEAD_START') && state.room.config?.zone && state.room.startedAt) {
    const boundary = effectiveZoneBoundary(state.room.config.zone, state.room.startedAt, nowMs);
    const prev = state.lastZoneBoundary;
    // PERF (QA 2026-11-17): effectiveZoneBoundary returns the SAME
    // boundary object until a shrink fires (zone.boundary or one
    // shrink-phase boundary, both stable refs from the room config),
    // and lastZoneBoundary stores that same ref — so a reference check
    // settles the common no-shrink case with no work. Only when the
    // ref changes do we pay the two JSON.stringify calls to confirm
    // the content actually changed (a shrink replaces the ref, and a
    // recovered room has lastZoneBoundary null, so the first tick
    // after recovery still compares by value — and seeds the baseline
    // silently when no shrink has fired, instead of emitting a
    // phase-0 update for an unchanged boundary; see below).
    const changed = boundary.length >= 3 && boundary !== prev
      && JSON.stringify(boundary) !== JSON.stringify(prev);
    if (changed) {
      const elapsed = Math.max(0, Math.floor((nowMs - Date.parse(state.room.startedAt)) / 1000));
      const phaseIndex = state.room.config.zone.shrinkPhases.filter((sp) => sp.atSeconds <= elapsed).length;
      if (phaseIndex === 0) {
        // Worker 4 fix (2026-11-18): no shrink has fired yet, so the
        // boundary in force IS the base boundary — unchanged. The old
        // code emitted a spurious zone.update here (phase 0, unchanged
        // boundary) whenever lastZoneBoundary was null, i.e. on the
        // first tick of a fresh room and the first tick after a
        // recovery (startMatch now seeds the baseline, but a recovered
        // room still arrives with null). Seed the baseline silently
        // instead: no ZONE_UPDATED event, no broadcast, no serverSeq
        // bump — there is nothing for clients to learn. A shrink that
        // fired while hibernating still emits below (phaseIndex > 0).
        state = { ...state, lastZoneBoundary: boundary };
      } else {
        // A shrink has fired: draw the next zone NOW, from the
        // boundary in force before this shrink (the last emitted
        // boundary, else the previous stored phase, else the base).
        // The SIZE follows the host's shrink setting exactly: the
        // factor is the stored phase's diameter relative to the
        // previous boundary (0.75 per shrink under the Auto rule);
        // only the POSITION is re-drawn, by the server, with
        // Math.random — never the host client's draw.
        const phases = state.room.config.zone.shrinkPhases;
        const prevBoundary = prev !== null && prev.length >= 3 ? prev
          : phaseIndex > 1 ? phases[phaseIndex - 2]!.boundary
          : state.room.config.zone.boundary;
        const prevDiameter = zoneDiameterMeters(prevBoundary);
        const storedDiameter = zoneDiameterMeters(boundary);
        const ratio = prevDiameter > 0 ? storedDiameter / prevDiameter : 0;
        const factor = ratio > 0.05 && ratio < 0.95 ? ratio : SHRINK_RADIUS_FACTOR;
        const liveBoundary = randomOffsetShrinkBoundary(prevBoundary, factor);
        const liveZone = {
          ...state.room.config.zone,
          shrinkPhases: phases.map((sp, i) => (i === phaseIndex - 1 ? { ...sp, boundary: liveBoundary } : sp)),
        };
        const withEvent = logGameEvent(state, createGameEvent('ZONE_UPDATED', state.room.roomId, state.room.hostPlayerId, {
          boundary: liveBoundary, reason: 'shrink', shrinkStep: phaseIndex,
        }));
        state = {
          ...withEvent,
          room: { ...withEvent.room, config: { ...withEvent.room.config, zone: liveZone } },
          lastZoneBoundary: liveBoundary, serverSeq: withEvent.serverSeq + 1,
        };
        messages.push({
          v: 1, type: 'zone.update', roomId: state.room.roomId, eventId: randomEventId(),
          serverSeq: state.serverSeq, serverTs: nowMs,
          payload: { zone: liveZone, phase: phaseIndex, serverSeq: state.serverSeq },
        });
      }
    }
  }

  // 5. Scheduled pings (WIRING 2026-11-17 — the DO never generated
  // pings before: buildPing existed in the engine but nothing called
  // it, so Hunters on the live backend got no pings at all). ACTIVE
  // only — never during HEAD_START (Hunters get no locations while
  // Runners are hiding) — and never when the play zone is off (no
  // zone = no pings, classic hide and seek). One coarse ping per free
  // Runner per pingIntervalSeconds, from the Runner's latest
  // server-held fix; no fix = no ping, never an invented position.
  // A ping is a COARSE area (150 m radius, calibration OPEN), never
  // an exact pin. Delivery is immediate (broadcast below); the
  // pending-ping TTL governs undelivered pings only (Issue 9).
  // lastPingAtMs is the schedule memory: a Runner never pinged gets
  // their first ping one interval after the match started.
  if (state.room.phase === 'ACTIVE' && state.room.config?.pingIntervalSeconds > 0
    && state.room.config?.playZoneEnabled !== false && state.room.startedAt) {
    const intervalMs = state.room.config.pingIntervalSeconds * 1000;
    const startedAtMs = Date.parse(state.room.startedAt);
    const lastPingAtMs = { ...(state.lastPingAtMs ?? {}) };
    let pinged = false;
    for (const p of state.players) {
      if (p.matchRole !== 'runner' || p.ejectedAt || p.leftAt) continue;
      const fix = state.latestFix[p.playerId];
      if (!fix) continue;
      const last = lastPingAtMs[p.playerId] ?? startedAtMs;
      if (nowMs - last < intervalMs) continue;
      const ping = buildPing(randomEventId(), state.room.roomId, fix, nowMs, CALIBRATION_OPEN.pendingPingTtlSeconds);
      lastPingAtMs[p.playerId] = nowMs;
      pinged = true;
      state = { ...state, serverSeq: state.serverSeq + 1 };
      messages.push({
        v: 1, type: 'ping', roomId: state.room.roomId, eventId: randomEventId(),
        serverSeq: state.serverSeq, serverTs: nowMs,
        payload: { ping, serverSeq: state.serverSeq },
      });
    }
    if (pinged) state = { ...state, lastPingAtMs };
  }

  const live = state.room.phase === 'ACTIVE' || state.room.phase === 'HEAD_START' || state.room.phase === 'SAFETY_PAUSED';
  const alarmDelayMs = state.room.phase === 'COMPLETED' || state.room.phase === 'CANCELLED' ? null : live ? 1000 : 30_000;
  return { state, messages, alarmDelayMs };
}

// ---------------------------------------------------------------------------
// WS protocol — server side (17 §3, v2.1 FROZEN). Runtime-free so it stays
// unit-testable without a Workers runtime. The live Durable Object class
// calls these helpers around its WebSocketPair; no deployment exists yet.
// ---------------------------------------------------------------------------
import {
  helloHasCredential, WS_CLOSE_CODE_ACTION, WS_PROTOCOL_VERSION,
} from '@pakdam/shared';
import type {
  PlayerView, WsCloseAction, WsCloseCode, WsErrorPayload, WsServerMessage,
} from '@pakdam/shared';

export type HelloValidation =
  | { ok: true; lastServerSeq: number; clientVersion: string }
  | { ok: false; code: 'VALIDATION_FAILED' | 'PROTOCOL_UNSUPPORTED'; message: string };

/** Validate a `hello` (17 §3.1 rule 4, §3.8). A hello carrying any
 *  credential field is rejected with VALIDATION_FAILED and must be audited
 *  by the caller (the ticket value itself is never written to the audit —
 *  only the fact of the rejection, the room, and the seat). A protocol
 *  version other than 1 is PROTOCOL_UNSUPPORTED (close 4409). */
export function validateHello(msg: unknown): HelloValidation {
  if (typeof msg !== 'object' || msg === null) {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'hello must be an object' };
  }
  const m = msg as Record<string, unknown>;
  if (m['v'] !== 1 || m['type'] !== 'hello') {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'first message must be hello with v: 1' };
  }
  if (helloHasCredential(msg)) {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'hello must not carry a credential' };
  }
  const payload = m['payload'];
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'hello payload is required' };
  }
  const p = payload as Record<string, unknown>;
  if (p['protocolVersion'] !== WS_PROTOCOL_VERSION) {
    return { ok: false, code: 'PROTOCOL_UNSUPPORTED', message: 'protocol version unsupported — upgrade the client' };
  }
  if (typeof p['clientVersion'] !== 'string' || typeof p['lastServerSeq'] !== 'number') {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'hello requires clientVersion and lastServerSeq' };
  }
  return { ok: true, lastServerSeq: p['lastServerSeq'], clientVersion: p['clientVersion'] };
}

/** Close-code mapping (17 §3.4). Returns the code and the client action
 *  from the shared contract table. */
export function closeCodeFor(reason: 'normal' | 'going-away' | 'abnormal' | 'bad-request' | 'ticket' | 'forbidden' | 'protocol' | 'rate-limited' | 'server-error'): { code: WsCloseCode; action: WsCloseAction } {
  const code: WsCloseCode =
    reason === 'normal' ? 1000
    : reason === 'going-away' ? 1001
    : reason === 'abnormal' ? 1006
    : reason === 'bad-request' ? 4400
    : reason === 'ticket' ? 4401
    : reason === 'forbidden' ? 4403
    : reason === 'protocol' ? 4409
    : reason === 'rate-limited' ? 4413
    : 1011;
  return { code, action: WS_CLOSE_CODE_ACTION[code] };
}

export function wsError(code: string, message: string, retryable: boolean, requestId: string, serverTs: number, retryAfterSeconds: number | null = null): WsErrorPayload {
  return { code, message, retryable, retryAfterSeconds, requestId, details: null, serverTs };
}

/** Strip every field that must never leave the server in a snapshot:
 *  reconnect-token hashes (Player), QR token hashes (catches), raw
 *  coordinates (latestFix), pending pings. Returns the snapshot message
 *  (17 §3.3) for one seat. */
export function buildWsSnapshot(s: RoomDoState, playerId: string, nowMs: number): WsServerMessage {
  // ROLE VISIBILITY (DECIDED 2026-11-17, recovery — replaces the
  // phase-gated "all roles visible once live" design): a seat sees its
  // OWN role and its OWN TEAM's roles only; the other team's roles
  // are always null, in every phase. Checklist rule: lobby reveal is
  // "tap to find out, no peeking", live is "own team live, other team
  // only via pings" — so in-match a Runner must NOT see Hunters'
  // roles and vice versa. Pre-start roles are null until startMatch
  // assigns them, so the same rule covers the lobby too. The REST
  // get-state path (authorisedSnapshot, engine) still hides all other
  // roles; the WS snapshot supersedes it once the socket connects.
  // CONSEQUENCE (accepted by the decision): a Hunter can no longer
  // enumerate Runners from the snapshot, so the live play page's
  // hunter "Catch" target list (built from matchRole === 'runner')
  // is empty — a catch starts from the Runner presenting (QR /
  // manual confirm) or from a catch.requested naming the parties,
  // not from a snapshot role list.
  const requester = s.players.find((p) => p.playerId === playerId);
  const players: PlayerView[] = s.players.map((p) => {
    const { reconnectTokenHash: _hash, ...view } = p;
    const visible = p.playerId === playerId
      || (requester !== undefined && p.team !== null && requester.team !== null && p.team === requester.team);
    return visible ? view : { ...view, matchRole: null, team: null };
  });
  const locationStatus: Record<string, 'known' | 'unknown'> = {};
  for (const p of s.players) {
    // 'known' only while a fresh foreground fix is held in DO memory.
    // After a recovery latestFix is empty, so every player is 'unknown'.
    locationStatus[p.playerId] = s.latestFix[p.playerId] ? 'known' : 'unknown';
  }
  // Recipient-filtered active catches: a seat sees only catches it is a
  // party to (Hunter or Runner) — or, if host, status-only. CatchView
  // strips the QR token hash for every recipient (17 §3.3).
  const activeCatches: CatchView[] = s.catches
    .filter((c) => (c.state === 'requested' || c.state === 'awaiting-confirmation')
      && (requester?.isHost === true || c.hunterPlayerId === playerId || c.runnerPlayerId === playerId))
    .map((c) => {
      const { qrTokenHash: _hash, ...view } = c;
      return view;
    });
  return {
    v: 1, type: 'snapshot', roomId: s.room.roomId,
    eventId: randomEventId(), serverSeq: s.serverSeq, serverTs: nowMs,
    payload: {
      room: s.room, players, phase: s.room.phase, version: s.room.version,
      serverSeq: s.serverSeq, locationStatus,
      activeCatches,
      safetyState: { paused: s.paused, pausedBy: s.pausedBy, pausedAt: s.room.pausedAt, sosActive: s.sosActive },
      missedAnnouncements: [],
    },
  };
}

/** Offending key names found anywhere in a serialised snapshot. Empty
 *  means clean. Used by the snapshot-leak tests (HNT-038). */
export function snapshotLeakKeys(msg: WsServerMessage): string[] {
  const json = JSON.stringify(msg);
  const found: string[] = [];
  for (const key of ['"lat"', '"lng"', '"reconnectTokenHash"', '"qrTokenHash"', '"ticket"', '"pendingPings"', '"latestFix"', '"centre"', '"radiusMeters"']) {
    if (json.includes(`${key}:`)) found.push(key.replaceAll('"', ''));
  }
  return found;
}

export function buildRenewalRequired(roomId: string, expiresAtIso: string, serverTs: number): WsServerMessage {
  return { v: 1, type: 'ticket.renewal-required', roomId, eventId: randomEventId(), serverSeq: 0, serverTs, payload: { expiresAt: expiresAtIso } };
}
export function buildAuthRefreshed(roomId: string, expiresAtIso: string, serverTs: number): WsServerMessage {
  return { v: 1, type: 'auth.refreshed', roomId, eventId: randomEventId(), serverSeq: 0, serverTs, payload: { expiresAt: expiresAtIso, serverTs } };
}

// ---------------------------------------------------------------------------
// WS ticket registry — DO-side validation (SEC-11, 2026-11-17).
// The Worker issues every ticket and registers its HASH with the DO
// (op `register-ticket`, called before the ticket is returned to the
// client). The DO then enforces ticket auth end-to-end:
//  - on WS upgrade the DO checks the forwarded ticketId resolves to
//    a registered, unexpired record for this room + seat (the Worker
//    already redeemed its own copy — the DO marks its copy redeemed
//    too, so a second upgrade with the same ticketId fails here even
//    if the Worker check is ever bypassed);
//  - on `auth.refresh` the DO redeems a fresh ticket itself (below).
// Ticket VALUES are never stored — only hashes, ticketIds and
// expiries. Records live in `state.wsTickets` (memory only, never
// persisted, reset on recovery).
// ---------------------------------------------------------------------------

export type RenewalRedeemResult =
  | { ok: true; ticketId: string; expiresAtMs: number }
  | { ok: false; code: 'TICKET_INVALID' | 'TICKET_REUSED' | 'TICKET_EXPIRED' };

/** Store a ticket record the Worker just issued (hash only). A
 *  re-registration of the same ticketId replaces the old record. */
export function registerWsTicket(s: RoomDoState, rec: WsTicketRecord): RoomDoState {
  const wsTickets = [...(s.wsTickets ?? []).filter((r) => r.ticketId !== rec.ticketId), rec];
  return { ...s, wsTickets };
}

/** Find a registered ticket record by the PRESENTED value (hash
 *  lookup — the value itself is never stored or logged). */
export function findWsTicket(s: RoomDoState, presented: string): WsTicketRecord | null {
  const hash = sha256Hex(presented);
  return (s.wsTickets ?? []).find((r) => r.hash === hash) ?? null;
}

/** Redeem a ticket for `auth.refresh` renewal. Only a ticket issued
 *  with purpose 'renew' may renew a socket: a 'connect' ticket is
 *  for opening a socket, and a ticket already redeemed (handshake
 *  or an earlier renewal) is TICKET_REUSED. Consumes the ticket. */
export function redeemWsTicketForRenewal(s: RoomDoState, presented: string, roomId: string, playerId: string, nowMs: number): { state: RoomDoState; result: RenewalRedeemResult } {
  const rec = findWsTicket(s, presented);
  if (!rec || rec.roomId !== roomId || rec.playerId !== playerId || rec.purpose !== 'renew') {
    return { state: s, result: { ok: false, code: 'TICKET_INVALID' } };
  }
  if (rec.status === 'redeemed') return { state: s, result: { ok: false, code: 'TICKET_REUSED' } };
  if (rec.status === 'revoked') return { state: s, result: { ok: false, code: 'TICKET_INVALID' } };
  if (nowMs > rec.expiresAtMs || rec.status === 'expired') {
    const wsTickets = (s.wsTickets ?? []).map((r) => (r.ticketId === rec.ticketId ? { ...r, status: 'expired' as const } : r));
    return { state: { ...s, wsTickets }, result: { ok: false, code: 'TICKET_EXPIRED' } };
  }
  const wsTickets = (s.wsTickets ?? []).map((r) => (r.ticketId === rec.ticketId ? { ...r, status: 'redeemed' as const } : r));
  return { state: { ...s, wsTickets }, result: { ok: true, ticketId: rec.ticketId, expiresAtMs: rec.expiresAtMs } };
}

/** Mark a registered ticket redeemed (handshake path — the Worker
 *  redeemed its own copy first and forwards the ticketId; the DO
 *  marks its copy too). Returns the state unchanged when the record
 *  is unknown (the caller then rejects the upgrade). */
export function markWsTicketRedeemed(s: RoomDoState, ticketId: string): { state: RoomDoState; found: boolean } {
  const rec = (s.wsTickets ?? []).find((r) => r.ticketId === ticketId);
  if (!rec) return { state: s, found: false };
  const wsTickets = (s.wsTickets ?? []).map((r) => (r.ticketId === ticketId ? { ...r, status: 'redeemed' as const } : r));
  return { state: { ...s, wsTickets }, found: true };
}

/** Is a renewal warning due for this socket? The DO sends
 *  `ticket.renewal-required` once, when the socket's ticket expires
 *  within RENEWAL_WARNING_MS and has not expired yet — the client
 *  then fetches a fresh ticket and sends `auth.refresh`. Pure, so
 *  the DO class can call it on every message/heartbeat. */
export const RENEWAL_WARNING_MS = 30_000;
export function ticketRenewalDue(ticketExpiresAtMs: number | null, nowMs: number): boolean {
  if (ticketExpiresAtMs === null) return false;
  const remaining = ticketExpiresAtMs - nowMs;
  return remaining > 0 && remaining <= RENEWAL_WARNING_MS;
}

/** Build + apply a player.suspended broadcast (17 §3.3, §3.7 stage 2). */
export function buildPlayerSuspended(
  s: RoomDoState, playerId: string,
  reason: 'tab-hidden' | 'screen-locked' | 'network-lost' | 'heartbeat-timeout' | 'unknown',
  nowMs: number,
): { state: RoomDoState; message: WsServerMessage } {
  const state: RoomDoState = {
    ...s,
    players: s.players.map((p) => (p.playerId === playerId ? { ...p, connectionState: 'suspended' as const } : p)),
    serverSeq: s.serverSeq + 1,
  };
  return {
    state,
    message: {
      v: 1, type: 'player.suspended', roomId: s.room.roomId,
      eventId: randomEventId(), serverSeq: state.serverSeq, serverTs: nowMs,
      payload: { playerId, reason, serverSeq: state.serverSeq },
    },
  };
}

export interface WsHandleResult {
  state: RoomDoState;
  replies: WsServerMessage[];
  /** Present when the client sent `auth.refresh` and the DO redeemed
   *  the renewal ticket itself (SEC-11): the caller swaps the
   *  socket's ticket binding to this ticketId/expiry and sends the
   *  `auth.refreshed` reply (already in `replies`) to the sender. */
  authRefreshed?: { ticketId: string; expiresAtMs: number };
  /** Present when `auth.refresh` failed validation (SEC-11): the
   *  caller must close the socket with 4401 and this message — the
   *  client fetches a fresh ticket and reconnects once. */
  authRefreshFailed?: { code: 'TICKET_INVALID' | 'TICKET_REUSED' | 'TICKET_EXPIRED'; message: string };
  heartbeatReceived?: boolean;
  /** True when this delivery was a duplicate `commandId` and the stored
   *  outcome was returned instead of re-applying the command (17 §3.6). */
  replayed?: boolean;
  /** The raw one-time catch token, for delivery to the RUNNER's seat ONLY
   *  (the Runner shows it; the Hunter types it in — demo catch page).
   *  It is a server-side return value, NOT a wire message: the §3.3
   *  catalogue has no runner-only token message, so the live DO class
   *  must deliver it on a channel the API mission adds to the catalogue.
   *  It is never in any broadcast, snapshot, log, or stored outcome. */
  issuedCatchToken?: { catchId: string; runnerPlayerId: string; token: string };
}

/** Mutating client→server commands (17 §3.3). Every one requires a
 *  `commandId` (§3.6) except `player.suspended`, which is a best-effort
 *  signal: it is deduped when a commandId is present and applied once
 *  when it is not. Non-mutating messages (hello, heartbeat, auth.refresh,
 *  snapshot/resync) are never deduped. */
export const MUTATING_WS_TYPES = new Set([
  'location.update', 'catch.request', 'catch.confirm', 'catch.dispute',
  'safety.pause', 'safety.resume', 'safety.sos', 'leave', 'signal.send', 'radio.send',
  'voice.signal',
  'pin.place', 'announcement.send', 'reveal.send', 'ready.set', 'briefing.confirm',
  'player.suspended',
]);

// ---------------------------------------------------------------------------
// WS per-seat rate limits (SEC-12, 2026-11-17). All numbers are
// PLACEHOLDERS — OPEN calibration (HNT-071), to be measured in the
// field before the external pilot. They exist to stop one seat
// flooding the DO (location spam, catch spam, signal spam), not to
// throttle legitimate play: location.update allows 6/s sustained
// (the client sends ~1 fix per 10 s), catches 5/min, signals/pins
// 10/min. `player.suspended` is exempt (best-effort signal). A
// limit hit returns a RATE_LIMITED error reply — the socket stays
// open; the DO class closes with 4413 only on repeated abuse
// (not implemented: single-hit close would punish a lagging client
// whose retries bunch up).
// ---------------------------------------------------------------------------
export const WS_RATE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  'location.update': { limit: 60, windowMs: 10_000 },
  'catch.request': { limit: 5, windowMs: 60_000 },
  'catch.confirm': { limit: 5, windowMs: 60_000 },
  'catch.dispute': { limit: 5, windowMs: 60_000 },
  'signal.send': { limit: 10, windowMs: 60_000 },
  // Team Radio text (D-M7): same budget as signals — one seat
  // cannot flood its team. PLACEHOLDER calibration (HNT-071).
  'radio.send': { limit: 10, windowMs: 60_000 },
  // Voice signalling (D-M1): generous on purpose — one ICE burst is
  // ~10–20 candidates per peer, and a mesh to a whole team multiplies
  // it. Still a per-seat cap, so one seat cannot flood the DO.
  // PLACEHOLDER calibration (HNT-071), like every other limit here.
  'voice.signal': { limit: 600, windowMs: 60_000 },
  'pin.place': { limit: 10, windowMs: 60_000 },
  'announcement.send': { limit: 5, windowMs: 60_000 },
  'reveal.send': { limit: 5, windowMs: 60_000 },
  'ready.set': { limit: 10, windowMs: 60_000 },
  'briefing.confirm': { limit: 5, windowMs: 60_000 },
  'safety.pause': { limit: 10, windowMs: 60_000 },
  'safety.resume': { limit: 10, windowMs: 60_000 },
  'safety.sos': { limit: 10, windowMs: 60_000 },
  'leave': { limit: 3, windowMs: 60_000 },
};
export const WS_RATE_LIMIT_DEFAULT = { limit: 20, windowMs: 60_000 };

/** Check (and consume) one unit of the per-seat budget for a WS
 *  message type. Returns the new state plus whether the message may
 *  proceed; when denied, `retryAfterSeconds` tells the client how
 *  long to wait. Replayed duplicates never reach this check (the
 *  idempotency replay returns before it), so a retry storm from a
 *  lagging client does not burn the budget twice. */
export function checkWsRate(s: RoomDoState, playerId: string, type: string, nowMs: number): { state: RoomDoState; allowed: boolean; retryAfterSeconds: number } {
  if (type === 'player.suspended') return { state: s, allowed: true, retryAfterSeconds: 0 };
  const { limit, windowMs } = WS_RATE_LIMITS[type] ?? WS_RATE_LIMIT_DEFAULT;
  const key = `${playerId}:${type}`;
  const window = ((s.wsRate ?? {})[key] ?? []).filter((t) => nowMs - t < windowMs);
  if (window.length >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((Math.min(...window) + windowMs - nowMs) / 1000));
    return { state: s, allowed: false, retryAfterSeconds };
  }
  return { state: { ...s, wsRate: { ...(s.wsRate ?? {}), [key]: [...window, nowMs] } }, allowed: true, retryAfterSeconds: 0 };
}

function toCatchView(c: CatchEvent): CatchView {
  const { qrTokenHash: _hash, ...view } = c;
  return view;
}
function toPlayerView(p: Player): PlayerView {
  const { reconnectTokenHash: _hash, ...view } = p;
  return view;
}
function logEvent(s: RoomDoState, type: string, actorId: string, nowMs: number): RoomDoState {
  const eventLog = [...s.eventLog, { seq: s.serverSeq, type, actorId, at: new Date(nowMs).toISOString() }];
  return { ...s, eventLog: eventLog.slice(-500) };
}

/** Append a validated game event to the durable log. The event is
 *  validated by its Zod schema first (a malformed event is a bug —
 *  parseGameEvent throws instead of logging garbage), then stored
 *  REDACTED (no raw coordinates — HNT-068) and mirrored into the
 *  plain audit trail above, so both logs stay in sync. */
export function logGameEvent(s: RoomDoState, event: GameEvent): RoomDoState {
  const validated = parseGameEvent(event);
  const gameEventLog = [...(s.gameEventLog ?? []), redactForLog(validated)].slice(-500);
  const withEvent = { ...s, gameEventLog };
  return logEvent(withEvent, validated.type, validated.actorId, Date.parse(validated.timestamp));
}
function isFiniteNumber(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function isValidFix(fix: unknown): fix is LocationFix {
  if (typeof fix !== 'object' || fix === null) return false;
  const f = fix as Record<string, unknown>;
  return typeof f['playerId'] === 'string' && typeof f['roomId'] === 'string'
    && isFiniteNumber(f['lat']) && (f['lat'] as number) >= -90 && (f['lat'] as number) <= 90
    && isFiniteNumber(f['lng']) && (f['lng'] as number) >= -180 && (f['lng'] as number) <= 180
    && isFiniteNumber(f['accuracyMeters']) && (f['accuracyMeters'] as number) > 0
    && typeof f['capturedAt'] === 'string' && !Number.isNaN(Date.parse(f['capturedAt'] as string))
    && typeof f['quality'] === 'string'
    && ['good', 'fair', 'poor', 'stale', 'suspicious'].includes(f['quality'] as string);
}

/**
 * Apply one mutating game command to DO state. Returns the new state and
 * the replies the DO class must send (broadcast replies are returned in
 * order; fan-out filtering — teammates-only signals/pins, host-only
 * status — is the live DO class's job, using the same recipient rules as
 * buildWsSnapshot). Error outcomes return the state UNCHANGED plus a
 * single `error` reply; the caller still stores error outcomes under the
 * commandId so a retry returns the same outcome (§3.6).
 */
function applyGameCommand(
  s: RoomDoState, playerId: string, type: string,
  payload: Record<string, unknown>, nowMs: number,
): { state: RoomDoState; replies: WsServerMessage[]; issuedCatchToken?: { catchId: string; runnerPlayerId: string; token: string } } {
  const nowIso = new Date(nowMs).toISOString();
  const err = (code: string, message: string): WsServerMessage => ({
    v: 1, type: 'error', roomId: s.room.roomId, eventId: randomEventId(),
    serverSeq: s.serverSeq, serverTs: nowMs,
    payload: wsError(code, message, false, randomEventId(), nowMs),
  });
  const sender = s.players.find((p) => p.playerId === playerId);
  if (!sender) return { state: s, replies: [err('FORBIDDEN', 'unknown seat in this room')] };
  if (sender.leftAt) return { state: s, replies: [err('INVALID_STATE', 'this seat has left the room')] };
  const msg = (msgType: WsServerMessage['type'], msgPayload: never, seq: number): WsServerMessage => ({
    v: 1, type: msgType, roomId: s.room.roomId, eventId: randomEventId(),
    serverSeq: seq, serverTs: nowMs, payload: msgPayload,
  } as WsServerMessage);
  const roomStateMsg = (seq: number, reason: string | null, phase: MatchPhase = s.room.phase, version: number = s.room.version): WsServerMessage => msg('room.state', { phase, version, serverSeq: seq, reason } as never, seq);

  switch (type) {
    case 'location.update': {
      const fix = payload['fix'];
      if (!isValidFix(fix) || fix.playerId !== playerId || fix.roomId !== s.room.roomId) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'location.update requires a valid fix for your own seat in this room')] };
      }
      // Server-side GPS validation (shared/gps-validation): the
      // server — never the client — decides the quality tier, and a
      // malformed / future / stale / duplicate fix is REJECTED here
      // (state unchanged). A poor-accuracy fix is ACCEPTED with a
      // warning: poor accuracy is never cheating evidence (HNT-034)
      // and never a reason to drop a fix. An impossible-movement
      // jump warns only — indoor drift must never punish a player.
      const prev = s.latestFix[playerId] ?? null;
      const validation = validateFix(
        { ...fix, at: fix.capturedAt },
        {
          now: new Date(nowMs),
          previous: prev ? { lat: prev.lat, lng: prev.lng, accuracyMeters: prev.accuracyMeters, at: prev.capturedAt } : null,
        },
      );
      if (validation.verdict === 'reject') {
        return { state: s, replies: [err('VALIDATION_FAILED', `fix rejected: ${validation.issues.join('; ')}`)] };
      }
      const serverQuality = validation.quality === 'unknown' ? 'poor' : validation.quality;
      // SECURITY (QA 2026-11-17, SEC-07): allowlist the stored fix.
      // The previous code spread the client-supplied fix (`{ ...fix }`),
      // so any extra field the client sent — including a multi-megabyte
      // junk field — was stored verbatim in DO memory (verified: a 1 MB
      // `junk` field was accepted and persisted in latestFix). Only the
      // seven LocationFix fields are ever stored now.
      const held: LocationFix = {
        playerId, roomId: s.room.roomId,
        lat: fix.lat, lng: fix.lng, accuracyMeters: fix.accuracyMeters,
        capturedAt: fix.capturedAt, receivedAt: nowIso, quality: serverQuality,
      };
      // Zone-exit with the PAUSED countdown (founder decision,
      // docs/DECISIONS.md): the 30-second return countdown runs only
      // while the player's live fix is trustworthy (good/fair). When
      // the fix is poor, the countdown FREEZES — seconds already
      // counted stay in outsideAccumMs, no new seconds accrue — and
      // resumes when accuracy recovers. A fix back inside clears
      // both counters. The alarm (`alarmTick`) ejects when
      // accumulated + current segment >= 30 s; nothing here ejects.
      const zone = s.room.config?.zone;
      const boundary = zone ? effectiveZoneBoundary(zone, s.room.startedAt, nowMs) : [];
      const zoneOn = s.room.config?.playZoneEnabled !== false;
      const outsideSinceMs = { ...(s.outsideSinceMs ?? {}) };
      const outsideAccumMs = { ...(s.outsideAccumMs ?? {}) };
      let crossed = false;
      const trustworthy = serverQuality === 'good' || serverQuality === 'fair';
      // QA BE-08 (2026-11-17): the 30-second outside-zone countdown runs
      // ONLY while the match is live (HEAD_START/ACTIVE). The old code
      // tracked it on every fix, so a player standing outside the zone
      // during a long LOBBY had outsideSinceMs set before the match
      // started and could be ejected seconds after start. While
      // SAFETY_PAUSED the counters freeze (resume shifts them, below).
      const livePhase = s.room.phase === 'HEAD_START' || s.room.phase === 'ACTIVE';
      if (livePhase && zoneOn && Array.isArray(boundary) && boundary.length >= 3) {
        if (!pointInPolygon({ lat: fix.lat, lng: fix.lng }, boundary)) {
          if (trustworthy) {
            if (outsideSinceMs[playerId] === undefined) { outsideSinceMs[playerId] = nowMs; crossed = true; }
          } else if (outsideSinceMs[playerId] !== undefined) {
            // Poor fix while outside: freeze the segment into the
            // accumulator and stop the clock until accuracy recovers.
            outsideAccumMs[playerId] = (outsideAccumMs[playerId] ?? 0) + (nowMs - outsideSinceMs[playerId]!);
            delete outsideSinceMs[playerId];
          }
        } else { delete outsideSinceMs[playerId]; delete outsideAccumMs[playerId]; }
      }
      const next: RoomDoState = {
        ...s,
        latestFix: { ...s.latestFix, [playerId]: held },
        outsideSinceMs,
        outsideAccumMs,
        players: s.players.map((p) => (p.playerId === playerId ? { ...p, lastFixAt: nowIso, locationQuality: serverQuality, connectionState: 'connected' as const } : p)),
        serverSeq: s.serverSeq + 1,
      };
      const logged = crossed ? logEvent(next, 'zone.exit', playerId, nowMs) : next;
      const withEvent = logGameEvent(logged, createGameEvent('LOCATION_UPDATED', s.room.roomId, playerId, {
        fix: { lat: fix.lat, lng: fix.lng, accuracyMeters: fix.accuracyMeters, at: fix.capturedAt },
        quality: serverQuality,
      }));
      return {
        state: withEvent,
        // The reply carries the SERVER-computed quality tier (not the
        // client's claim): a 'poor' tier here is how the client learns
        // its fix is poor — the detailed reasons live in the DO's
        // redacted game-event log, not on the wire (the §3.3
        // catalogue is frozen; no new wire field is invented here).
        replies: [msg('player.visibility', { playerId, locationQuality: serverQuality, lastFixAt: nowIso, serverSeq: next.serverSeq } as never, next.serverSeq)],
      };
    }
    case 'catch.request': {
      if (sender.matchRole !== 'hunter') return { state: s, replies: [err('FORBIDDEN', 'only a Hunter may request a catch')] };
      if (sender.ejectedAt) return { state: s, replies: [err('INVALID_STATE', 'an ejected Hunter may not request a catch')] };
      // QA 2026-11-17 (GL-06): catches only while ACTIVE. The old code
      // also allowed HEAD_START — Hunters tagging while Runners are
      // still hiding. The demo store already requires ACTIVE.
      if (s.room.phase !== 'ACTIVE') {
        return { state: s, replies: [err('INVALID_STATE', `catches are not possible while the match is ${s.room.phase}`)] };
      }
      const runnerId = payload['runnerId'];
      if (typeof runnerId !== 'string') return { state: s, replies: [err('VALIDATION_FAILED', 'catch.request requires runnerId')] };
      const runner = s.players.find((p) => p.playerId === runnerId);
      if (!runner || runner.matchRole !== 'runner' || runner.leftAt || runner.ejectedAt) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'runnerId is not a Runner in this room')] };
      }
      if (runner.connectionState === 'suspended') {
        return { state: s, replies: [err('INVALID_STATE', 'Runner is suspended — a catch cannot complete while the Runner is suspended')] };
      }
      if (s.catches.some((c) => c.runnerPlayerId === runnerId && c.state === 'confirmed')) {
        return { state: s, replies: [err('INVALID_STATE', 'Runner is already caught')] };
      }
      // QA 2026-11-17 (GL-05): one pending catch per Runner, whoever
      // the Hunter is. The old check only blocked the SAME Hunter
      // re-requesting, so two Hunters could open two claims on one
      // Runner and BOTH could confirm — one Runner counted twice.
      if (s.catches.some((c) => c.runnerPlayerId === runnerId && (c.state === 'requested' || c.state === 'awaiting-confirmation'))) {
        return { state: s, replies: [err('CONFLICT', 'a catch is already pending for this Runner')] };
      }
      const catchId = randomEventId();
      const token = issueCatchToken(catchId, CALIBRATION_OPEN.catchTokenTtlSeconds, nowMs);
      const gpsEvidence = gpsEvidenceForCatch(
        s.latestFix[runnerId] ?? null, nowMs, CALIBRATION_OPEN.suspensionFreshnessSeconds * 1000,
      );
      const catchEvent: CatchEvent = {
        catchId, roomId: s.room.roomId, hunterPlayerId: playerId, runnerPlayerId: runnerId,
        state: 'requested', qrTokenHash: token.hash, requestedAt: nowIso,
        confirmedAt: null, disputedAt: null, resolution: null, gpsEvidence,
      };
      const next: RoomDoState = {
        ...s,
        catches: [...s.catches, catchEvent],
        activeCatchIds: [...s.activeCatchIds, catchId],
        serverSeq: s.serverSeq + 1,
      };
      const logged = logEvent(next, 'catch.request', playerId, nowMs);
      // QA 2026-11-17 (GL-07): the host's catchConfirmationRequired
      // flag was ignored server-side — the catch always stayed
      // pending. When confirmation is OFF the tag counts at once
      // (the Runner may still dispute it afterwards is NOT yet
      // supported — see GL-07b in the QA report).
      if (s.room.config.catchConfirmationRequired === false) {
        const auto = resolveCatch(catchEvent, 'confirm', nowIso);
        const confirmedState: RoomDoState = {
          ...logged,
          catches: logged.catches.map((x) => (x.catchId === catchId ? auto : x)),
          activeCatchIds: logged.activeCatchIds.filter((id) => id !== catchId),
        };
        const withTag = logGameEvent(confirmedState, createGameEvent('PLAYER_TAGGED', s.room.roomId, playerId, {
          runnerId, hunterId: playerId, catchId, method: 'no-confirmation',
        }));
        const finalState = applyConfirmedCatchToState(withTag, auto, s.room.hostPlayerId, nowMs);
        const replies: WsServerMessage[] = [
          msg('catch.requested', { catch: toCatchView(catchEvent), serverSeq: next.serverSeq } as never, next.serverSeq),
          msg('catch.confirmed', { catch: toCatchView(auto), serverSeq: finalState.serverSeq } as never, finalState.serverSeq),
        ];
        if (finalState.room.phase === 'COMPLETED' && finalState.room.result) {
          replies.push(msg('match.completed', { result: finalState.room.result, serverSeq: finalState.serverSeq } as never, finalState.serverSeq));
        }
        return { state: finalState, replies, issuedCatchToken: { catchId, runnerPlayerId: runnerId, token: token.raw } };
      }
      return {
        state: logged,
        replies: [msg('catch.requested', { catch: toCatchView(catchEvent), serverSeq: next.serverSeq } as never, next.serverSeq)],
        issuedCatchToken: { catchId, runnerPlayerId: runnerId, token: token.raw },
      };
    }
    case 'catch.confirm':
    case 'catch.dispute': {
      const catchId = payload['catchId'];
      if (typeof catchId !== 'string') return { state: s, replies: [err('VALIDATION_FAILED', 'catchId is required')] };
      const c = s.catches.find((x) => x.catchId === catchId);
      if (!c) return { state: s, replies: [err('VALIDATION_FAILED', 'unknown catchId')] };
      // WIRING 2026-11-17 — who may confirm: the RUNNER (manual
      // confirm, or presenting the QR token) OR the HUNTER who made
      // the claim, presenting the QR token they just scanned. The old
      // code allowed ONLY the Runner, so a Hunter who scanned the
      // Runner's QR had no way to complete the tag — the scan could
      // never be sent, because the Hunter's device holds the scanned
      // token and the Runner's device never sees the scan. The QR
      // token IS the proof of physical proximity: whoever presents a
      // matching token proves they were with the Runner. Manual
      // confirm stays Runner-only (it is the Runner's own consent,
      // no token involved). Dispute stays Runner-only.
      const isRunner = c.runnerPlayerId === playerId;
      const isHunter = c.hunterPlayerId === playerId;
      if (type === 'catch.dispute' && !isRunner) return { state: s, replies: [err('FORBIDDEN', 'only the named Runner may confirm or dispute this catch')] };
      if (type === 'catch.confirm' && !isRunner && !isHunter) return { state: s, replies: [err('FORBIDDEN', 'only the named Runner or the claiming Hunter may confirm this catch')] };
      if (c.state === 'confirmed' || c.state === 'disputed') {
        return { state: s, replies: [err('CONFLICT', `catch is already ${c.state}`)] };
      }
      if (c.state === 'expired' || nowMs > new Date(c.requestedAt).getTime() + CALIBRATION_OPEN.catchTokenTtlSeconds * 1000) {
        const expired: CatchEvent = { ...c, state: 'expired' };
        const next: RoomDoState = {
          ...s,
          catches: s.catches.map((x) => (x.catchId === catchId ? expired : x)),
          activeCatchIds: s.activeCatchIds.filter((id) => id !== catchId),
          serverSeq: s.serverSeq + 1,
        };
        return {
          state: logEvent(next, 'catch.expired', playerId, nowMs),
          replies: [msg('catch.expired', { catch: toCatchView(expired), serverSeq: next.serverSeq } as never, next.serverSeq)],
        };
      }
      if (type === 'catch.confirm') {
        // QA 2026-11-17 (GL-09): a catch could be confirmed after the
        // match had already COMPLETED (no phase check here at all).
        if (s.room.phase !== 'ACTIVE') {
          return { state: s, replies: [err('INVALID_STATE', `catches cannot complete while the match is ${s.room.phase}`)] };
        }
        const runner = s.players.find((p) => p.playerId === c.runnerPlayerId);
        // v2.1 Issue 3: a pending catch can NEVER complete while the
        // Runner is suspended — canCompleteCatchWhileRunnerSuspended()
        // is false by engine rule, so suspension alone blocks it.
        if (runner?.connectionState === 'suspended') {
          return { state: s, replies: [err('INVALID_STATE', 'Runner is suspended — a catch cannot complete while the Runner is suspended')] };
        }
        // In Infection a Runner flipped by an earlier confirmed catch
        // is a Hunter now — a second pending claim on them must not
        // confirm (and applyConfirmedTag would throw on a non-Runner).
        if (runner?.matchRole !== 'runner') {
          return { state: s, replies: [err('INVALID_STATE', 'only a Runner can be tagged')] };
        }
        const qrToken = payload['qrToken'];
        // QA 2026-11-17 (GL-04): the founder's manual-confirm fallback
        // (Runner confirms themself in a dialogue when the Hunter's
        // camera cannot scan — no QR, no code) had NO server path:
        // catch.confirm always demanded the QR token. A Runner now
        // confirms manually by sending manualConfirm: true (or
        // resolution: 'manual-confirm') with no token; the confirm is
        // still Runner-only, so no new trust is granted — the Runner
        // is the party whose consent the QR was proving.
        // WIRING 2026-11-17: manual confirm is Runner-only — a Hunter
        // presenting manualConfirm:true is rejected below (the manual
        // branch requires isRunner).
        const manual = isRunner && (payload['manualConfirm'] === true || payload['resolution'] === 'manual-confirm');
        let confirmed: CatchEvent;
        let method: 'qr' | 'manual';
        if (typeof qrToken === 'string' && qrToken.length > 0) {
          if (!c.qrTokenHash) {
            return { state: s, replies: [err('VALIDATION_FAILED', 'catch.confirm requires the QR token from the Runner QR scan — this catch has no QR token to check against')] };
          }
          if (!verifyCatchToken(catchId, qrToken, c.qrTokenHash)) {
            return { state: s, replies: [err('VALIDATION_FAILED', 'QR token does not match this catch')] };
          }
          confirmed = resolveCatch(c, 'confirm', nowIso, 'qr-scan');
          method = 'qr';
        } else if (manual) {
          confirmed = resolveCatch(c, 'confirm', nowIso, 'manual-confirm');
          method = 'manual';
        } else {
          return { state: s, replies: [err('VALIDATION_FAILED', 'catch.confirm requires the QR token from the Runner QR scan, or manualConfirm when the camera is unavailable')] };
        }
        const next: RoomDoState = {
          ...s,
          catches: s.catches.map((x) => (x.catchId === catchId ? confirmed : x)),
          activeCatchIds: s.activeCatchIds.filter((id) => id !== catchId),
          serverSeq: s.serverSeq + 1,
        };
        const tagged = logGameEvent(logEvent(next, 'catch.confirm', playerId, nowMs), createGameEvent('PLAYER_TAGGED', s.room.roomId, playerId, {
          runnerId: c.runnerPlayerId, hunterId: c.hunterPlayerId, catchId, method,
        }));
        // QA 2026-11-17 (GL-02): confirming a catch never applied the
        // mode rule (Infection never flipped the Runner) and never
        // checked the win rule — the match ran to the clock even with
        // every Runner caught.
        const finalState = applyConfirmedCatchToState(tagged, confirmed, s.room.hostPlayerId, nowMs);
        const replies: WsServerMessage[] = [
          msg('catch.confirmed', { catch: toCatchView(confirmed), serverSeq: next.serverSeq } as never, next.serverSeq),
        ];
        if (finalState.room.phase === 'COMPLETED' && finalState.room.result) {
          replies.push(msg('match.completed', { result: finalState.room.result, serverSeq: finalState.serverSeq } as never, finalState.serverSeq));
        }
        return { state: finalState, replies };
      }
      const reason = payload['reason'];
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'catch.dispute requires a reason')] };
      }
      const disputed = resolveCatch(c, 'dispute', nowIso);
      const next: RoomDoState = {
        ...s,
        catches: s.catches.map((x) => (x.catchId === catchId ? disputed : x)),
        activeCatchIds: s.activeCatchIds.filter((id) => id !== catchId),
        serverSeq: s.serverSeq + 1,
      };
      return {
        state: logEvent(next, 'catch.dispute', playerId, nowMs),
        replies: [msg('catch.disputed', { catch: toCatchView(disputed), serverSeq: next.serverSeq } as never, next.serverSeq)],
      };
    }
    case 'safety.pause': {
      if (s.paused) return { state: s, replies: [err('INVALID_STATE', 'match is already paused')] };
      if (s.room.phase !== 'ACTIVE' && s.room.phase !== 'HEAD_START') {
        return { state: s, replies: [err('INVALID_STATE', `cannot pause while the match is ${s.room.phase}`)] };
      }
      const reason = payload['reason'];
      if (reason !== null && (typeof reason !== 'string' || reason.length > 500)) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'safety.pause reason must be a string up to 500 characters, or null')] };
      }
      let phase: MatchPhase;
      try { phase = transition(s.room.phase, 'SAFETY_PAUSED'); } catch {
        return { state: s, replies: [err('INVALID_STATE', `cannot pause while the match is ${s.room.phase}`)] };
      }
      const next: RoomDoState = {
        ...s,
        room: { ...s.room, phase, version: s.room.version + 1, pausedAt: nowIso },
        paused: true, pausedBy: playerId, pausedFrom: s.room.phase, serverSeq: s.serverSeq + 1,
      };
      return {
        state: logEvent(next, 'safety.pause', playerId, nowMs),
        replies: [
          msg('safety.paused', { byPlayerId: playerId, reason: (reason ?? null) as string | null, serverSeq: next.serverSeq } as never, next.serverSeq),
          roomStateMsg(next.serverSeq, 'safety-pause', next.room.phase, next.room.version),
        ],
      };
    }
    case 'safety.resume': {
      if (!sender.isHost) return { state: s, replies: [err('FORBIDDEN', 'only the host may resume a paused match')] };
      if (!s.paused || s.room.phase !== 'SAFETY_PAUSED') {
        return { state: s, replies: [err('INVALID_STATE', 'match is not paused')] };
      }
      // Timers freeze while paused: shift the match clock forward by
      // the pause duration, so a 5-minute pause does not eat 5
      // minutes of match time (and the head start does not expire
      // while everyone is standing still).
      const pausedAtMs = s.room.pausedAt ? Date.parse(s.room.pausedAt) : nowMs;
      const pauseMs = Math.max(0, nowMs - pausedAtMs);
      const shift = (iso: string | null) => (iso ? new Date(Date.parse(iso) + pauseMs).toISOString() : null);
      // QA BE-08 (2026-11-17): the outside-zone countdown freezes while
      // paused, like the match clock — shift first-seen-outside forward
      // by the pause, or a player outside at pause time is ejected the
      // instant the match resumes (the segment would span the pause).
      const shiftedOutsideMs = Object.fromEntries(
        Object.entries(s.outsideSinceMs ?? {}).map(([k, v]) => [k, v + pauseMs]),
      );
      // QA 2026-11-17 (GL-08): resume used to hard-code ACTIVE, so a
      // pause during HEAD_START silently skipped the rest of the head
      // start. Resume to the phase the match was paused from.
      const resumePhase: MatchPhase = s.pausedFrom ?? 'ACTIVE';
      let resumeTarget: MatchPhase;
      try { resumeTarget = transition('SAFETY_PAUSED', resumePhase); } catch {
        resumeTarget = 'ACTIVE';
      }
      const next: RoomDoState = {
        ...s,
        room: { ...s.room, phase: resumeTarget, version: s.room.version + 1, pausedAt: null, startedAt: shift(s.room.startedAt), endsAt: shift(s.room.endsAt) },
        outsideSinceMs: shiftedOutsideMs,
        paused: false, pausedBy: null, pausedFrom: null, serverSeq: s.serverSeq + 1,
      };
      return {
        state: logEvent(next, 'safety.resume', playerId, nowMs),
        replies: [
          msg('safety.resumed', { byPlayerId: playerId, reason: null, serverSeq: next.serverSeq } as never, next.serverSeq),
          roomStateMsg(next.serverSeq, 'safety-resume', next.room.phase, next.room.version),
        ],
      };
    }
    case 'safety.sos': {
      const reason = payload['reason'];
      if (reason !== null && (typeof reason !== 'string' || reason.length > 500)) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'safety.sos reason must be a string up to 500 characters, or null')] };
      }
      const next: RoomDoState = { ...s, sosActive: true, serverSeq: s.serverSeq + 1 };
      return {
        state: logEvent(next, 'safety.sos', playerId, nowMs),
        replies: [msg('sos.raised', { byPlayerId: playerId, serverSeq: next.serverSeq } as never, next.serverSeq)],
      };
    }
    case 'leave': {
      const next: RoomDoState = {
        ...s,
        players: s.players.map((p) => (p.playerId === playerId ? { ...p, leftAt: nowIso, connectionState: 'disconnected' as const } : p)),
        serverSeq: s.serverSeq + 1,
      };
      const logged = logGameEvent(logEvent(next, 'leave', playerId, nowMs), createGameEvent('PLAYER_DISCONNECTED', s.room.roomId, playerId, {
        playerId, reason: 'left',
      }));
      // QA 2026-11-17 (MP-HOST-LEAVE): the host leaving orphaned the
      // room — hostPlayerId kept pointing at the departed seat, so no
      // one could resume a paused match or start, and no
      // host.transferred was ever emitted (the wire type existed but
      // nothing produced it). Transfer to the earliest-joined player
      // still in the room; a lone host leaving transfers to nobody.
      let transferred: RoomDoState = logged;
      let transferMsg: WsServerMessage | null = null;
      if (sender.isHost) {
        const successor = logged.players
          .filter((p) => p.playerId !== playerId && !p.leftAt && !p.ejectedAt)
          .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt))[0];
        if (successor) {
          transferred = {
            ...logged,
            room: { ...logged.room, hostPlayerId: successor.playerId },
            players: logged.players.map((p) =>
              p.playerId === successor.playerId ? { ...p, isHost: true }
              : p.playerId === playerId ? { ...p, isHost: false } : p),
            serverSeq: logged.serverSeq + 1,
          };
          transferMsg = msg('host.transferred', { previousHostPlayerId: playerId, newHostPlayerId: successor.playerId, serverSeq: transferred.serverSeq } as never, transferred.serverSeq);
        }
      }
      // QA 2026-11-17 (GL-02): a Runner leaving could leave no Runner
      // in play — complete the match at once instead of waiting for
      // the clock (and then mis-reporting the leaver as a survivor).
      const won = maybeCompleteOnWin(transferred, s.room.hostPlayerId, nowMs);
      const replies: WsServerMessage[] = [
        msg('player.left', { player: toPlayerView(won.state.players.find((p) => p.playerId === playerId)!), serverSeq: next.serverSeq } as never, next.serverSeq),
      ];
      if (transferMsg) replies.push(transferMsg);
      if (won.completed && won.state.room.result) {
        replies.push(msg('match.completed', { result: won.state.room.result, serverSeq: won.state.serverSeq } as never, won.state.serverSeq));
      }
      return { state: won.state, replies };
    }
    case 'signal.send': {
      const code = payload['code'];
      // Closed preset set is still OPEN (17 §3.3 names it but publishes no
      // set) — accept a short code string and do NOT invent the set here.
      if (typeof code !== 'string' || code.trim().length === 0 || code.length > 32) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'signal.send requires a short preset code')] };
      }
      const next: RoomDoState = { ...s, serverSeq: s.serverSeq + 1 };
      return {
        state: logEvent(next, 'signal.send', playerId, nowMs),
        replies: [msg('signal', { signal: { signalId: randomEventId(), playerId, code, sentAt: nowIso }, serverSeq: next.serverSeq } as never, next.serverSeq)],
      };
    }
    case 'radio.send': {
      // Team Radio TEXT (D-M7) — the live relay the demo store could
      // never provide: one seat's text/quick message, broadcast by
      // the DO to that seat's TEAM only (fan-out in
      // room-do-class.ts broadcastRecipients). In the lobby both
      // teams are null, so the message goes to the whole lobby —
      // that IS the lobby radio. The sender's display name comes
      // from the seat record, never from the client. An ejected
      // seat is out of play and cannot send; a Hunter in a game
      // where the host turned Hunters' radio off (huntersCanTalk
      // === false) cannot send either. No game event is logged
      // (radio is not gameplay); the plain audit trail records the
      // send. Radio is ephemeral like signals: a seat that is
      // offline when a message is sent never gets it from a
      // snapshot — it reconnects to the live channel, not history.
      const text = payload['text'];
      const kind = payload['kind'];
      if (typeof text !== 'string' || text.trim().length === 0 || text.trim().length > 140) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'radio.send requires text of 1–140 characters')] };
      }
      if (kind !== undefined && kind !== 'quick' && kind !== 'text') {
        return { state: s, replies: [err('VALIDATION_FAILED', 'radio.send kind must be quick or text')] };
      }
      if (sender.ejectedAt) {
        return { state: s, replies: [err('INVALID_STATE', 'ejected players cannot send radio messages')] };
      }
      if (sender.team === 'hunters' && s.room.config?.huntersCanTalk === false) {
        return { state: s, replies: [err('FORBIDDEN', 'Hunters’ radio is off in this game')] };
      }
      const clean = text.trim();
      const next: RoomDoState = { ...s, serverSeq: s.serverSeq + 1 };
      const radio = {
        messageId: randomEventId(), roomId: s.room.roomId, playerId,
        senderName: sender.displayName, text: clean,
        kind: (kind === 'quick' ? 'quick' : 'text') as 'quick' | 'text',
        sentAt: nowIso,
      };
      return {
        state: logEvent(next, 'radio.send', playerId, nowMs),
        replies: [msg('radio', { radio, serverSeq: next.serverSeq } as never, next.serverSeq)],
      };
    }
    case 'voice.signal': {
      // FREE voice radio (D-M1) — SIGNALLING ONLY. The DO never sees,
      // stores or relays audio: it forwards one small SDP/ICE payload
      // from a seat to exactly ONE teammate, and only when BOTH seats
      // are on the same team. Team-only is enforced HERE, not just in
      // the client: a cross-team signal, a lobby signal (no team yet),
      // a signal to a seat that left / was ejected, or a Hunter signal
      // in a game where the host turned Hunters' radio off
      // (huntersCanTalk === false) is rejected. The fan-out
      // (room-do-class.ts broadcastRecipients) sends a `voice.signal`
      // reply to the named recipient ONLY — never the host, never the
      // team, never the room — so the other team cannot even learn
      // that a voice signal was sent. No game event is logged (voice
      // is not gameplay); the plain audit trail records the send.
      const toPlayerId = payload['toPlayerId'];
      const kind = payload['kind'];
      const sdp = payload['sdp'];
      const candidate = payload['candidate'];
      if (typeof toPlayerId !== 'string' || toPlayerId.length === 0 || toPlayerId.length > 128
        || (kind !== 'join' && kind !== 'leave' && kind !== 'offer' && kind !== 'answer' && kind !== 'ice')) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'voice.signal requires toPlayerId and kind join|leave|offer|answer|ice')] };
      }
      if (sdp !== undefined && (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > 8192)) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'voice.signal sdp must be a string up to 8192 characters')] };
      }
      if ((kind === 'offer' || kind === 'answer') && typeof sdp !== 'string') {
        return { state: s, replies: [err('VALIDATION_FAILED', `voice.signal ${kind} requires sdp`)] };
      }
      if (candidate !== undefined) {
        const c = candidate as Record<string, unknown>;
        if (typeof c !== 'object' || c === null || typeof c['candidate'] !== 'string'
          || (c['candidate'] as string).length === 0 || (c['candidate'] as string).length > 1024) {
          return { state: s, replies: [err('VALIDATION_FAILED', 'voice.signal candidate must carry a candidate string up to 1024 characters')] };
        }
      }
      if (kind === 'ice' && candidate === undefined) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'voice.signal ice requires candidate')] };
      }
      if (toPlayerId === playerId) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'voice.signal cannot target your own seat')] };
      }
      const recipient = s.players.find((p) => p.playerId === toPlayerId);
      if (!recipient) {
        return { state: s, replies: [err('FORBIDDEN', 'voice recipient is not in this room')] };
      }
      if (sender.leftAt || sender.ejectedAt || recipient.leftAt || recipient.ejectedAt) {
        return { state: s, replies: [err('INVALID_STATE', 'voice is only for players still in the game')] };
      }
      // Teams are assigned at match start: in the lobby both teams are
      // null, so there is no team to be "only" for — voice waits.
      if (sender.team === null || recipient.team === null || sender.team !== recipient.team) {
        return { state: s, replies: [err('FORBIDDEN', 'voice radio is team-only')] };
      }
      if (sender.team === 'hunters' && s.room.config?.huntersCanTalk === false) {
        return { state: s, replies: [err('FORBIDDEN', 'Hunters’ radio is off in this game')] };
      }
      const next: RoomDoState = { ...s, serverSeq: s.serverSeq + 1 };
      const forwarded: Record<string, unknown> = {
        fromPlayerId: playerId, toPlayerId, kind,
      };
      if (typeof sdp === 'string') forwarded['sdp'] = sdp;
      if (candidate !== undefined) forwarded['candidate'] = candidate;
      return {
        state: logEvent(next, 'voice.signal', playerId, nowMs),
        replies: [msg('voice.signal', forwarded as never, next.serverSeq)],
      };
    }
    case 'pin.place': {
      const point = payload['point'] as Record<string, unknown> | undefined;
      const label = payload['label'];
      if (!point || !isFiniteNumber(point['lat']) || !isFiniteNumber(point['lng'])
        || (point['lat'] as number) < -90 || (point['lat'] as number) > 90
        || (point['lng'] as number) < -180 || (point['lng'] as number) > 180
        || typeof label !== 'string' || label.trim().length === 0 || label.length > 80) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'pin.place requires a valid point and a label up to 80 characters')] };
      }
      const next: RoomDoState = { ...s, serverSeq: s.serverSeq + 1 };
      return {
        state: logEvent(next, 'pin.place', playerId, nowMs),
        replies: [msg('pin', { pin: { pinId: randomEventId(), playerId, point: { lat: point['lat'] as number, lng: point['lng'] as number }, label, createdAt: nowIso }, serverSeq: next.serverSeq } as never, next.serverSeq)],
      };
    }
    case 'announcement.send': {
      if (!sender.isHost) return { state: s, replies: [err('FORBIDDEN', 'only the host may send announcements')] };
      const text = payload['text'];
      if (typeof text !== 'string' || text.trim().length === 0 || text.length > 280) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'announcement.send requires text up to 280 characters')] };
      }
      const next: RoomDoState = { ...s, serverSeq: s.serverSeq + 1 };
      return {
        state: logEvent(next, 'announcement.send', playerId, nowMs),
        replies: [msg('announcement', { announcement: { announcementId: randomEventId(), roomId: s.room.roomId, text, sentByPlayerId: playerId, sentAt: nowIso }, serverSeq: next.serverSeq } as never, next.serverSeq)],
      };
    }
    case 'reveal.send': {
      // D-M6 — "Tell everyone" (hold-to-reveal): any seat may share
      // its position with the WHOLE room, deliberately, after a 2 s
      // hold on the client. The fix is validated exactly like a
      // location.update (shape + server-side GPS validation — a
      // stale/future/impossible fix is rejected, never broadcast),
      // then held as the seat's latest fix (same allowlisted 7
      // fields, SEC-07) and broadcast as a 'reveal' to EVERY socket
      // in the room — the DO class broadcasts non-DIRECT replies to
      // all, and 'reveal' has no team filter (unlike signal/pin),
      // because the whole point is that everyone sees it. The
      // broadcast carries a COARSE area (150 m, the same radius as
      // a ping) centred on the fix — never an exact pin — and the
      // client draws the area, never lat/lng numbers. No zone-exit
      // countdown runs here: a reveal is a deliberate share, not a
      // tracking fix (location.update owns the countdown, live
      // phases only).
      const fix = payload['fix'];
      if (!isValidFix(fix) || fix.playerId !== playerId || fix.roomId !== s.room.roomId) {
        return { state: s, replies: [err('VALIDATION_FAILED', 'reveal.send requires a valid fix for your own seat in this room')] };
      }
      const prev = s.latestFix[playerId] ?? null;
      const validation = validateFix(
        { ...fix, at: fix.capturedAt },
        {
          now: new Date(nowMs),
          previous: prev ? { lat: prev.lat, lng: prev.lng, accuracyMeters: prev.accuracyMeters, at: prev.capturedAt } : null,
        },
      );
      if (validation.verdict === 'reject') {
        return { state: s, replies: [err('VALIDATION_FAILED', `fix rejected: ${validation.issues.join('; ')}`)] };
      }
      const serverQuality = validation.quality === 'unknown' ? 'poor' : validation.quality;
      const held: LocationFix = {
        playerId, roomId: s.room.roomId,
        lat: fix.lat, lng: fix.lng, accuracyMeters: fix.accuracyMeters,
        capturedAt: fix.capturedAt, receivedAt: nowIso, quality: serverQuality,
      };
      const next: RoomDoState = {
        ...s,
        latestFix: { ...s.latestFix, [playerId]: held },
        players: s.players.map((p) => (p.playerId === playerId ? { ...p, lastFixAt: nowIso, locationQuality: serverQuality, connectionState: 'connected' as const } : p)),
        serverSeq: s.serverSeq + 1,
      };
      return {
        state: logEvent(next, 'reveal.send', playerId, nowMs),
        replies: [msg('reveal', {
          reveal: {
            revealId: randomEventId(), roomId: s.room.roomId, byPlayerId: playerId,
            centre: { lat: fix.lat, lng: fix.lng }, radiusMeters: PING_AREA_RADIUS_M, sentAt: nowIso,
          },
          serverSeq: next.serverSeq,
        } as never, next.serverSeq)],
      };
    }
    case 'ready.set': {
      const isReady = payload['isReady'];
      if (typeof isReady !== 'boolean') return { state: s, replies: [err('VALIDATION_FAILED', 'ready.set requires isReady boolean')] };
      const next: RoomDoState = {
        ...s,
        players: s.players.map((p) => (p.playerId === playerId ? { ...p, isReady } : p)),
        serverSeq: s.serverSeq + 1,
      };
      const logged = logEvent(next, 'ready.set', playerId, nowMs);
      // PLAYER_READY fires only when a player BECOMES ready (there is
      // no PLAYER_UNREADY event type — un-readying is just state).
      const withEvent = isReady
        ? logGameEvent(logged, createGameEvent('PLAYER_READY', s.room.roomId, playerId, { playerId }))
        : logged;
      return {
        state: withEvent,
        replies: [roomStateMsg(next.serverSeq, 'ready.set')],
      };
    }
    case 'briefing.confirm': {
      const next: RoomDoState = {
        ...s,
        players: s.players.map((p) => (p.playerId === playerId ? { ...p, briefingConfirmed: true } : p)),
        serverSeq: s.serverSeq + 1,
      };
      return {
        state: logEvent(next, 'briefing.confirm', playerId, nowMs),
        replies: [roomStateMsg(next.serverSeq, 'briefing.confirm')],
      };
    }
    case 'player.suspended': {
      const reason = payload['reason'];
      const validReason = reason === 'tab-hidden' || reason === 'screen-locked' || reason === 'network-lost' || reason === 'heartbeat-timeout' ? reason : 'unknown' as const;
      const { state: suspendedState } = applySuspension(s, playerId);
      const suspended = buildPlayerSuspended(suspendedState, playerId, validReason, nowMs);
      const disconnectReason: 'tab-closed' | 'network' | 'timeout' =
        validReason === 'tab-hidden' || validReason === 'screen-locked' ? 'tab-closed'
        : validReason === 'heartbeat-timeout' ? 'timeout' : 'network';
      const withEvent = logGameEvent(
        logEvent(suspended.state, 'player.suspended', playerId, nowMs),
        createGameEvent('PLAYER_DISCONNECTED', s.room.roomId, playerId, { playerId, reason: disconnectReason }),
      );
      return { state: withEvent, replies: [suspended.message] };
    }
    default:
      return { state: s, replies: [err('VALIDATION_FAILED', `unknown WS message type: ${type}`)] };
  }
}

/** Handle one client→server WS message (17 §3.3). Unknown types and
 *  malformed envelopes get a VALIDATION_FAILED error reply, never a crash.
 *  Mutating game commands are applied by applyGameCommand() against the
 *  authoritative engine and broadcast as server events; a duplicate
 *  `commandId` from the same seat returns the stored outcome with
 *  `replayed: true` and no second effect (§3.6). Stale events are never
 *  replayed: a snapshot.request/resync.request always returns a fresh
 *  snapshot. */
export function handleWsClientMessage(s: RoomDoState, playerId: string, raw: unknown, nowMs: number): WsHandleResult {
  const errorReply = (code: string, message: string): WsServerMessage => ({
    v: 1, type: 'error', roomId: s.room.roomId, eventId: randomEventId(),
    serverSeq: s.serverSeq, serverTs: nowMs,
    payload: wsError(code, message, false, randomEventId(), nowMs),
  });
  if (typeof raw !== 'object' || raw === null) {
    return { state: s, replies: [errorReply('VALIDATION_FAILED', 'message must be an object')] };
  }
  const m = raw as Record<string, unknown>;
  if (m['v'] !== 1 || typeof m['type'] !== 'string') {
    return { state: s, replies: [errorReply('VALIDATION_FAILED', 'message requires v: 1 and a type')] };
  }
  const type = m['type'] as string;
  // Shape validation (Zod, workers/src/lib/validation.ts — wired
  // 2026-11-17, final verification): every inbound client message is
  // shape-checked BEFORE the switch, so a malformed payload is
  // rejected with the same VALIDATION_FAILED error shape the DO
  // already uses — never a crash, never a partial apply. Unknown
  // types and missing commandId stay the DO's decision (the
  // validator returns ok for them), and the domain checks below
  // (seat, phase, role, idempotency, rate limits) are unchanged.
  // Note: `hello` never reaches here in production — the DO class
  // intercepts it at handshake time (validateHello) — so validating
  // its shape here only affects a second hello, which is a protocol
  // error either way.
  const validated = validateWsClientMessage(raw);
  if (!validated.ok) {
    return { state: s, replies: [errorReply('VALIDATION_FAILED', validated.message)] };
  }
  const payload = (typeof m['payload'] === 'object' && m['payload'] !== null ? m['payload'] : {}) as Record<string, unknown>;
  switch (type) {
    case 'snapshot.request':
    case 'resync.request': {
      // Gap recovery (17 §3.5): the snapshot is the whole truth. The client
      // applies it and discards local state; stale commands are never replayed.
      return { state: s, replies: [buildWsSnapshot(s, playerId, nowMs)] };
    }
    case 'heartbeat': {
      return {
        state: s,
        heartbeatReceived: true,
        replies: [{
          v: 1, type: 'heartbeat.ack', roomId: s.room.roomId, eventId: randomEventId(),
          serverSeq: s.serverSeq, serverTs: nowMs,
          payload: { serverTs: nowMs, serverSeq: s.serverSeq },
        }],
      };
    }
    case 'auth.refresh': {
      // SEC-11: the DO validates the renewal ticket ITSELF against
      // the records the Worker registered (purpose 'renew', single
      // use, unexpired, this room + seat). The old code returned the
      // ticket to the caller unvalidated and nothing ever checked it
      // — any string "refreshed" the socket. On success the caller
      // swaps the socket's ticket binding (authRefreshed) and the
      // `auth.refreshed` reply goes to the sender only; on failure
      // the caller closes the socket 4401 (authRefreshFailed).
      if (typeof payload['ticket'] !== 'string' || payload['ticket'].length === 0) {
        return { state: s, replies: [errorReply('VALIDATION_FAILED', 'auth.refresh requires a ticket')] };
      }
      const redeemed = redeemWsTicketForRenewal(s, payload['ticket'] as string, s.room.roomId, playerId, nowMs);
      if (!redeemed.result.ok) {
        const message = redeemed.result.code === 'TICKET_REUSED'
          ? 'WS ticket already redeemed — request a fresh ticket'
          : redeemed.result.code === 'TICKET_EXPIRED'
            ? 'WS ticket expired — request a fresh ticket'
            : 'WS ticket is not valid for this room and seat';
        return {
          state: redeemed.state,
          replies: [errorReply(redeemed.result.code, message)],
          authRefreshFailed: { code: redeemed.result.code, message },
        };
      }
      return {
        state: redeemed.state,
        replies: [buildAuthRefreshed(s.room.roomId, new Date(redeemed.result.expiresAtMs).toISOString(), nowMs)],
        authRefreshed: { ticketId: redeemed.result.ticketId, expiresAtMs: redeemed.result.expiresAtMs },
      };
    }
    case 'hello':
      // hello is only valid as the first message, handled by validateHello
      // at handshake time. A second hello is a protocol error.
      return { state: s, replies: [errorReply('VALIDATION_FAILED', 'hello already received')] };
    default: {
      if (!MUTATING_WS_TYPES.has(type)) {
        return { state: s, replies: [errorReply('VALIDATION_FAILED', `unknown WS message type: ${type}`)] };
      }
      // --- Idempotency (§3.6): commandId REQUIRED for mutating commands,
      // except the best-effort player.suspended signal. ---
      const rawKey = m['commandId'] ?? m['idempotencyKey'];
      const commandId = typeof rawKey === 'string' && rawKey.length > 0 ? rawKey : null;
      if (!commandId && type !== 'player.suspended') {
        return { state: s, replies: [errorReply('VALIDATION_FAILED', 'mutating command requires commandId')] };
      }
      let state = s;
      if (commandId) {
        state = { ...s, idempotency: s.idempotency.filter((r) => r.storedAtMs + IDEMPOTENCY_TTL_MS > nowMs) };
        const existing = state.idempotency.find((r) => r.key === commandId && r.playerId === playerId);
        if (existing) {
          if (existing.type !== type) {
            return { state: s, replies: [errorReply('VALIDATION_FAILED', 'commandId reused for a different command')] };
          }
          return { state: s, replies: existing.replies, replayed: true, issuedCatchToken: existing.issuedCatchToken };
        }
      }
      // SEC-12: per-seat WS rate limit. Checked AFTER the replay
      // check above (a duplicate commandId returns the stored outcome
      // without consuming budget) and BEFORE applying the command.
      const rated = checkWsRate(state, playerId, type, nowMs);
      if (!rated.allowed) {
        return {
          state: s,
          replies: [{
            v: 1, type: 'error', roomId: s.room.roomId, eventId: randomEventId(),
            serverSeq: s.serverSeq, serverTs: nowMs,
            payload: wsError('RATE_LIMITED', `too many ${type} messages — try again in ${rated.retryAfterSeconds}s`, true, randomEventId(), nowMs, rated.retryAfterSeconds),
          }],
        };
      }
      const result = applyGameCommand(rated.state, playerId, type, payload, nowMs);
      if (!commandId) return { state: result.state, replies: result.replies, issuedCatchToken: result.issuedCatchToken };
      const record: IdempotencyRecord = {
        key: commandId, playerId, type, replies: result.replies,
        serverSeq: result.state.serverSeq, issuedCatchToken: result.issuedCatchToken, storedAtMs: nowMs,
      };
      return {
        state: { ...result.state, idempotency: [...result.state.idempotency, record] },
        replies: result.replies, replayed: false, issuedCatchToken: result.issuedCatchToken,
      };
    }
  }
}

/** Per-connection WS session (DO-side). `missedHeartbeats` counts
 *  application-level heartbeats missed; the limit that turns stale into
 *  suspended is OPEN (`missedHeartbeatLimit`, 17 §7). */
export interface WsSession {
  roomId: string; playerId: string; ticketId: string;
  lastServerSeq: number; missedHeartbeats: number; heartbeatRequested: boolean;
}
export function newWsSession(roomId: string, playerId: string, ticketId: string, lastServerSeq: number): WsSession {
  return { roomId, playerId, ticketId, lastServerSeq, missedHeartbeats: 0, heartbeatRequested: false };
}
export function noteMissedHeartbeat(session: WsSession, missedHeartbeatLimit: number | null): { session: WsSession; exceeded: boolean } {
  const next = { ...session, missedHeartbeats: session.missedHeartbeats + 1 };
  return { session: next, exceeded: missedHeartbeatLimit !== null && next.missedHeartbeats >= missedHeartbeatLimit };
}

function randomEventId(): string {
  // crypto.randomUUID is available in Workers, browsers and Node 20+.
  return globalThis.crypto.randomUUID();
}
// NOTE: the Cloudflare DurableObject class binding lives in src/index.ts
// (kept separate so this state logic stays runtime-free and unit-testable).
export const ROOM_DO_CLASS = 'RoomDurableObject';
