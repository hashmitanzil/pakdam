/**
 * @pakdam/workers — Durable Object state ops (pure-ish, no I/O).
 *
 * The DO is the sole game authority: room + roster, phase machine, timers,
 * role assignment, ping generation, catch confirmation, zone transitions,
 * suspension, ejection, completion, snapshots, ticket registry, per-seat WS
 * rate limits, idempotency. All game rules come from @pakdam/engine; this
 * file is a thin shell over those pure transitions — it never re-implements
 * a game rule.
 *
 * DURABLE vs MEMORY-ONLY (hibernation split — must be preserved):
 * - Durable (survives hibernation): room, players (incl. token hashes,
 *   never sent), catches (incl. qrTokenHash, server only), host-token
 *   hashes, serverSeq, redacted game-event log (cap 500), lastPingAtMs,
 *   pause state, lightweight event log, shrinkIndexApplied, the WS
 *   ticket registry (hashes only), idempotency records + cached replies,
 *   pending pings (+ per-recipient delivery state), and the claim-less
 *   runner QR token records (hashes only — a Runner's QR survives a
 *   wake, since the raw value is never stored anywhere). A wake must not
 *   invalidate a minted ticket, lose a retry's reply, or drop a ping that
 *   was never delivered (P1-5).
 * - Memory only (never persisted): latest fixes (purged after 30 s —
 *   the LOCATION_FRESHNESS_SECONDS window — and at match end),
 *   outside-zone countdowns, WS rate-limit windows, raw catch tokens,
 *   announcements. Never persisted, ever: raw coordinates, raw tokens
 *   of any kind, WS ticket values.
 *
 * Server caps (P2): safety pause / leave `reason` ≤ 500 chars;
 * voice.signal `candidate` ≤ 8 KB (same as SDP); bug/grievance
 * deviceInfo / appVersion / complainantRef ≤ 500 chars (enforced in
 * http.ts); HTTP + DO /op bodies ≤ 1 MB (413 above).
 *
 * v18 removals (founder decisions — do not re-add):
 * - NO next-zone preview: the server never broadcasts `zone.preview` and
 *   stores no pending shrink boundary; a shrink draws its boundary fresh
 *   at fire time via `randomOffsetShrinkBoundary`. Shrink timing, random
 *   offset and the final 42% are unchanged.
 * - SOS removed entirely (server + shared): no `safety.sos` handler, no
 *   `sosActive`, no SOS copy. The safety PAUSE / resume STAYS.
 * - Hold-to-reveal removed: no `reveal.send` handler. The shared
 *   `reveal` event type is kept for the web builder's parallel removal.
 * - Start gate REMOVED: a match starts even if a player's GPS has not
 *   reported yet. Instead, a player with NO fix at all for 30 s during
 *   ACTIVE is EJECTED (see `alarmTick` step (4a)). A poor-but-present
 *   fix still freezes the outside-zone countdown; only a COMPLETELY
 *   missing fix ejects. (4a) runs in ACTIVE only, never HEAD_START
 *   (A4 — the head start is for acquiring GPS), never ejects a
 *   SUSPENDED seat (A3/F4 — suspension is not departure, and ejection
 *   is terminal), and is skipped once on the first tick after a DO wake
 *   (A3/F4 — durable `lastFixAt` can be stale for a live roster). The
 *   silence baseline is the moment ACTIVE began, so a never-reported
 *   player is ejected 30 s into ACTIVE. A4 + the suspended exemption
 *   are JUDGMENT CALLS against the founder's rule as written (eject any
 *   seat silent for 30 s) — implemented as the safer default, flagged
 *   for the founder to override.
 *
 * Physical tags (founder decision, P1-11): a tag confirms only when the
 * Hunter and the Runner both have a recent fix within
 * CATCH_MAX_DISTANCE_METERS (100 m) — enforced by the engine's
 * checkCatchProximity; the DO passes `mem.latestFix` for both seats as
 * `positions` (plus `maxDistanceMeters`) into requestCatch/confirmCatch.
 *
 * SUPABASE: this file never touches Supabase. Mutating ops return
 * `PersistIntent[]` (JSON-safe); the caller — the DO class for WS-driven
 * mutations, the Worker for HTTP-driven ones — executes them via
 * ctx.waitUntil(). Persistence is best-effort; the DO is the authority.
 *
 * TICKET REGISTRY (DO-owned — the per-isolate bug, never again): the Worker
 * NEVER validates a ticket. Issuance mints a value and registers only its
 * SHA-256 hash here; the upgrade path redeems the hash atomically in this
 * DO. A ticket issued on one isolate validates on any other, because the
 * registry lives in the room's DO, not in Worker memory.
 */
import {
  CATCH_MAX_DISTANCE_METERS,
  CATCH_TOKEN_TTL_SECONDS,
  EVENT_LOG_CAP,
  GAME_EVENT_LOG_CAP,
  GPS_VIOLATION_WINDOW_MS,
  HEARTBEAT_INTERVAL_MS,
  HTTP_RATE_LIMITS,
  IDEMPOTENCY_TTL_MS,
  LOCATION_FRESHNESS_SECONDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  OUTSIDE_ZONE_RETURN_SECONDS,
  QUICK_SIGNALS,
  RADIO_MAX_CHARS,
  RENEWAL_WARNING_MS,
  VOICE_SDP_MAX_BYTES,
  WS_MESSAGE_RATE_LIMITS,
  WS_MESSAGE_RATE_LIMIT_DEFAULT,
  WS_TICKET_TTL_MS,
  checkFixMovement,
  classifyAccuracy,
  catchTokenHash,
  hashHostToken,
  hashReconnectToken,
  hashWsTicket,
  helloHasCredential,
  isValidCatchToken,
  isValidDisplayName,
  isValidRoomCode,
  newId,
  randomHex,
  resolveGpsAntiCheatConfig,
  validateFix,
  validateRoomConfig,
  type Announcement,
  type CatchEvent,
  type CatchView,
  type GameEvent,
  type GeoPoint,
  type LocationFix,
  type LocationQuality,
  type MatchPhase,
  type MatchResult,
  type Ping,
  type Player,
  type PlayerView,
  type RadioMessage,
  type Room,
  type RoomConfig,
  type SafetyState,
  type SuspensionReason,
  type WsServerMessageType,
  type WsSnapshotPayload,
} from '@pakdam/shared';
import {
  applyConfirmedTag,
  applyOutsideZoneEjection,
  assignRoles,
  buildPing,
  buildSnapshot,
  canTransition,
  confirmCatch,
  confirmedTags,
  disputeCatch,
  dueHunterIds,
  dueRunnerIds,
  emptyOutsideZoneState,
  expireCatchIfOverdue,
  freeHunterIds,
  freeRunnerIds,
  isCatchExpired,
  isCatchableRunner,
  isPendingCatch,
  isTerminalPhase,
  issueCatchToken,
  issueRunnerQrToken,
  maybeCompleteOnWin,
  openCatchForRunner,
  pauseMatch,
  purgeExpiredPings,
  purgeIdempotency,
  randomOffsetShrinkBoundary,
  recordSuspension,
  requestCatch,
  resolveCatch,
  resolveModeOutcome,
  resolveOpenClaimQrToken,
  resolveRunnerQrToken,
  resumeMatch,
  resumeSuspendedPlayer,
  scoreMatch,
  shrinkIndexAt,
  toCatchView,
  teammateViewFor,
  transitionForEvent,
  transitionOrThrow,
  updateOutsideZone,
  verifyCatchToken,
  isPointInZone,
  type IdempotencyRecord,
  type OutsideZoneState,
  type RunnerQrToken,
} from '@pakdam/engine';
import type { LogEntry, PersistIntent } from './supabase.js';
import { stripCoordinatesDeep } from './supabase.js';
import {
  OPERATION_NON_MUTATING_TYPES,
  operationCacheEarlyReply,
  operationEpilogue,
  operationPrologue,
} from './operation-wrapper.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WsTicketRecord {
  ticketId: string;
  playerId: string;
  /** SHA-256 hex of the ticket value. The value itself is never stored. */
  ticketHash: string;
  purpose: 'connect' | 'renew';
  expiresAtMs: number;
  redeemed: boolean;
  createdAtMs: number;
}

/** Durable state — everything that survives DO hibernation. */
export interface RoomDoState {
  room: Room;
  players: Player[];
  catches: CatchEvent[];
  /** playerId -> SHA-256(host token). Only the current host seat has one. */
  hostTokens: Record<string, string>;
  serverSeq: number;
  /** Redacted game events, cap 500 (coordinates stripped). */
  gameEventLog: GameEvent[];
  /** Last DELIVERED ping per player (timestamps only, no coordinates). */
  lastPingAtMs: Record<string, number | null>;
  paused: boolean;
  pausedBy: string | null;
  pausedFrom: MatchPhase | null;
  eventLog: Array<{ seq: number; type: string; actorId: string | null; at: string }>;
  /** How many scheduled shrinks have already been drawn. */
  shrinkIndexApplied: number;
  /**
   * WS ticket registry, durable (P1-5): hashes only, never values. A
   * ticket minted before a hibernate must still redeem after the wake.
   */
  tickets: WsTicketRecord[];
  /**
   * (seat, commandId) idempotency records, durable (P1-5): serialised as
   * { key, record } pairs; the live Map is rebuilt from these on load.
   */
  idempotency: Array<{ key: string; record: IdempotencyRecord }>;
  /**
   * Cached direct/broadcast replies per (seat, commandId), durable
   * (P1-5 + P1-9): a retry after a wake gets the original reply.
   */
  idempotentReplies: Array<{ key: string; events: OutboundEvent[] }>;
  /** Pending (undelivered) pings, durable (P1-5): re-delivered on hello. */
  pendingPings: Ping[];
  /**
   * Claim-less runner QR token records, durable (v18 follow-up):
   * hashes only, never raw values — one live record per Runner. A
   * Runner mints theirs with `catch.runner-token` before any claim
   * exists; a Hunter's scan resolves the Runner from the hash and the
   * record is consumed when the claim is created (or bound to it).
   * Expired records are pruned lazily by the mint/scan ops; expiry is
   * always decided by `expiresAtMs`, never by the prune.
   */
  runnerQrTokens: RunnerQrToken[];
  /**
   * Per-ping recipients still awaiting delivery: pingId -> playerIds.
   * A ping leaves `pendingPings` only when every recipient has received
   * it (per-recipient ack); an offline Hunter still gets it on reconnect.
   */
  pendingPingRecipients: Record<string, string[]>;
  // v18: NO pending shrink preview. The founder removed the next-zone
  // preview entirely — a shrink draws its boundary fresh at fire time,
  // so there is no stored preview boundary to persist or restore.
  /**
   * v18 fix round (B2) — the ORIGINAL configured zone boundary, snapshotted
   * at `startMatch`. Shrinks mutate `config.zone.boundary` in place, so
   * without this snapshot a replay would start the "fresh" game on the
   * already-shrunk zone (~42% of the original). `replayMatch` restores
   * the boundary from here. Null until the first match starts (older
   * durable writes lack it — `restoreState` fills null).
   */
  originalZoneBoundary?: GeoPoint[] | null;
  /**
   * v23 Rule 1 — host cancel deleted the room. Set by `cancelMatch`
   * (host `lifecycleOp('end')` only). While set, the room is gone:
   * snapshot / results / replay / lifecycle / host-token checks all
   * refuse with 404 ROOM_NOT_FOUND (`isDeleted()`). A terminal phase
   * alone does NOT imply this — a naturally completed room (COMPLETED)
   * and an emptied room (EXPIRED / ABANDONED / CANCELLED via
   * `leaveSeat`) keep serving snapshots and replay. Optional: older
   * durable writes lack it — `restoreState` fills false; test-built
   * states that omit it read as `undefined` (falsy) until set.
   */
  deleted?: boolean;
  /**
   * v24 — host reconnect grace (founder decision D1, 2026-11-21).
   * Set when the HOST suspends with an actually-gone reason
   * (`'network-lost'` / `'heartbeat-timeout'`): `{ hostPlayerId,
   * endsAtMs }` with `endsAtMs = suspendMs + HOST_RECONNECT_GRACE_MS`.
   * Durable (NOT mem): it must survive a DO eviction/wake, so the
   * deadline is still honoured after hibernation. Null when no grace
   * is running. Optional: older durable writes / test-built states
   * lack it — `restoreState` fills null and the constructor defaults
   * it. Only ever one grace at a time (one host); a second
   * actually-gone reason while suspended never restarts it.
   */
  hostGrace?: { hostPlayerId: string; endsAtMs: number } | null;
  /**
   * v28 — epoch ms of the first alarm tick that observed NO live
   * WebSocket attached to this room, or null when a socket is (or was
   * most recently) attached. Durable, for the same reason as the host
   * grace: the DO is routinely evicted between 30 s ticks, and a
   * memory-only clock would restart on every wake, so the idle window
   * would never complete. Written only on transitions (set on the
   * first no-socket tick, cleared when a socket is seen or the room is
   * abandoned) — never on every tick (v17 split). Older durable
   * writes / test-built states lack it — `restoreState` fills null.
   */
  noSocketsSinceMs?: number | null;
  /**
   * v29 — per-seat 30 s return deadlines (founder decision
   * 2026-11-22): playerId -> epoch ms when the seat's return window
   * ends. Set at `startMatch` for seats not present then, and by
   * `suspendSeat` on an actually-gone suspension mid-game; cleared
   * on resume / leave / ejection / replay. Durable (NOT mem): the
   * deadline must survive a DO eviction/wake, like the host grace.
   * Absent/empty = no window running for that seat. Older durable
   * writes / test-built states lack it — `restoreState` fills {}.
   */
  disconnectDeadlineMs?: Record<string, number>;
}

/** Memory-only state — rebuilt empty after hibernation, never persisted. */
export interface RoomMemory {
  latestFix: Record<string, LocationFix>;
  outsideZone: Record<string, OutsideZoneState>;
  pendingPings: Ping[];
  tickets: WsTicketRecord[];
  /**
   * Per-seat WS-ticket issue timestamps: key `playerId` -> issue times.
   * The DO-owned ticket-issue limit (same table as the Worker's HTTP
   * limiter). The Worker limiter is per-isolate best-effort, so a burst
   * spread across isolates could mint an 11th ticket inside a minute;
   * the DO is the single instance per room, so its window cannot be
   * bypassed that way. Same durability class as the ticket registry
   * itself (DO memory, not `storage.put`).
   */
  ticketIssues: Map<string, number[]>;
  /**
   * v31 FIX ROUND (Zara (c)) — per-seat WS-ticket REVOKE timestamps:
   * key `playerId` -> revoke times. Same shape and durability class
   * as `ticketIssues`: the revoke route's Worker limiter is
   * per-isolate in-memory, so a valid seat holder spreading revoke
   * calls across isolates could force more than 10 `save()`s/min
   * (the class saves unconditionally after a revoke, so each call
   * is a write). The DO check below is the authoritative window;
   * a DO wake resets it, exactly as for the issue limit.
   */
  ticketRevokes: Map<string, number[]>;
  /** Per-seat WS rate-limit windows: key `${playerId}:${type}` -> timestamps. */
  wsRate: Map<string, number[]>;
  /** (seat, commandId) idempotency records, 10 min TTL. */
  idempotency: Map<string, IdempotencyRecord>;
  /** catchId -> raw one-time QR token (memory only; re-minted on re-fetch). */
  rawCatchTokens: Map<string, { token: string; expiresAtMs: number }>;
  /** Ephemeral announcements (cap 50) for missedAnnouncements. */
  announcements: Announcement[];
  /** playerId -> epoch ms of the seat's last disconnect (for missed msgs). */
  lastDisconnectAtMs: Record<string, number>;
  /**
   * v28 fix round (Diya R1) — playerId -> the reason of the seat's
   * LATEST suspension, stamped by `suspendSeat` on every call.
   * Memory only (rebuilt empty after hibernation): the heartbeat loop
   * needs it only while the DO is awake, and the `suspendSeat` grace
   * gate (wasSuspended) covers the post-wake case without it. A
   * seat's reason is read only while the seat is suspended, and a
   * fresh suspend always re-stamps it.
   */
  lastSuspensionReason: Record<string, SuspensionReason>;
  /** commandId -> direct reply events, so a retry gets the original reply. */
  idempotentReplies: Map<string, OutboundEvent[]>;
  /**
   * Per-seat Supabase player-row persist throttle (Phase 3 #2): the last
   * epoch ms a player-upsert intent was emitted for a location.update.
   * The durable player row is refreshed at most every
   * PLAYER_PERSIST_INTERVAL_MS per seat, not on every GPS fix.
   */
  lastPlayerPersistAtMs: Record<string, number>;
  /**
   * Per-seat GPS fix throttle (Phase 3 #2): the last epoch ms a fix was
   * accepted for this seat. Fixes arriving sooner than
   * GPS_FIX_MIN_INTERVAL_MS after the previous accepted fix are dropped
   * (coalesced), so the DO queue is bounded at ~1 fix/s/seat by design.
   */
  lastFixAcceptedAtMs: Record<string, number>;
  /**
   * v29 (Gap 1) — per-seat ring of accepted fixes (cap
   * `GPS_FIX_HISTORY_CAP` = 10), memory only, never persisted. The
   * anti-cheat movement check reads the previous accepted fix from
   * here. Dropped with the seat (leave / replay clears it).
   */
  fixHistory: Record<string, LocationFix[]>;
  /**
   * v29 (Gap 1) — per-seat counted GPS violations in the current
   * 5-min window: `{ count, firstAtMs }`, memory only. Older
   * violations age out (a new window starts). Dies with hibernation
   * — acceptable, it is a flag, not a punishment. Dropped with the
   * seat.
   */
  gpsViolations: Record<string, { count: number; firstAtMs: number }>;
  /**
   * v29 (Gap 5) — buffered structured-log entries, cap 100 (see
   * `queueLog`). Flushed piggybacked on the next persist batch or
   * the alarm tick as one `log-batch` intent. Memory only.
   */
  logBuffer: LogEntry[];
  /**
   * v29 (Gap 4) — cached HTTP idempotent replies, memory only:
   * key -> `{ status, body, expiresAtMs }`. Keys are
   * `join:<roomId>:<key>` for joins (the seat does not exist yet)
   * and `<playerId>:<op>:<key>` for start/replay. 10-min TTL
   * (`IDEMPOTENCY_TTL_MS`). Memory-only DELIBERATELY: a cached join
   * reply carries the raw reconnect token, and raw tokens are never
   * persisted anywhere — a retry after a DO eviction inside the
   * window re-executes instead of replaying (same loss class as the
   * ≤ 60 s WS idempotency sync window). Purged on the alarm tick.
   *
   * v29 fix round (F11) — HONEST LIMIT: the memory-only cache means
   * the stranded-seat fix works only while the DO stays resident.
   * After an eviction inside the 10 min window, a retried join
   * re-executes instead of replaying the cached reply — and a
   * retried join for a seat that already exists (same codename, no
   * reconnect token presented) 403s "name taken" instead of
   * restoring the seat. Recovery: the host removes the stranded
   * seat and the player re-joins with a different codename. No
   * code change to the cache itself: raw tokens are never persisted
   * — that justification stands.
   */
  httpIdempotentReplies: Map<string, { status: number; body: Record<string, unknown>; expiresAtMs: number }>;
  /**
   * v29 (R5 fix round) — the memory epoch, epoch ms, stamped when
   * this awake instance loads/restores durable state (it changes on
   * every wake — a fresh instance always re-stamps it in the
   * constructor and again in `restoreDurableMemory`). Memory only,
   * never persisted: that is the point — a key carrying the old
   * epoch can never match after a wake, so a post-wake
   * `snapshot.unchanged` cannot fire while memory-only
   * `teammateFixes` / `locationStatus` are gone. 0 = never stamped
   * (only before the constructor runs).
   */
  epochMs: number;
  /**
   * v29 (R1) — epoch ms of the last snapshot safety-valve broadcast
   * in this awake instance (0 = never). Memory only: a wake
   * re-arms the valve immediately, which is harmless (one extra
   * `room.state`).
   */
  lastSafetyValveMs: number;
  /**
   * Per-ping recipients still awaiting delivery: pingId -> playerIds not
   * yet delivered to. Mirrors the durable `pendingPingRecipients`.
   */
  pendingPingRecipients: Map<string, Set<string>>;
  /**
   * Radio content-dedupe (Phase 4 (r)): `${playerId}:${kind}:${text}` ->
   * epoch ms of the last SENT radio message with that content. Memory
   * only, pruned to the dedupe window on every radio.send — a retry that
   * minted a new commandId cannot be caught by commandId idempotency,
   * so identical content inside the window is dropped as a duplicate.
   */
  recentRadio: Map<string, number>;
  /**
   * v23 Rule 2 — the last host-succession transfer emitted by
   * `succeedHostAfterDisconnect`, if any, in THIS awake instance.
   *
   * v23 fix round 1 (S6): the amend is keyed by a BATCH TOKEN, not by
   * `nowMs`. Simultaneous disconnects share one batch (the class
   * sweep and one alarm tick each pass a single `batchId` for the
   * whole batch); when the seat that JUST received host drops in the
   * same batch, the succession AMENDS this event (new host rewritten)
   * instead of emitting a second transfer — exactly one
   * `host.transferred` per simultaneous disconnect, naming the final
   * host. Two genuinely separate disconnects that happen to share a
   * `Date.now()` millisecond get DIFFERENT batch ids (each caller
   * mints its own, and a lone call gets a fresh one), so the second
   * one can never amend the first's already-delivered transfer.
   *
   * The amend may ONLY rewrite an event that has not been delivered
   * yet — that is the caller's contract: every caller that passes a
   * `batchId` must deliver the batch's events only after the batch
   * completes (`suspendClosedSeats` and the alarm loop both collect
   * then deliver once; the WS handler never passes a batchId, so one
   * message can never amend another's transfer). Memory only:
   * rebuilt empty on wake, so a stale batch can never leak across
   * hibernation. Null when no succession has happened yet.
   */
  lastSuccession: { batchId: string; event: OutboundEvent } | null;
}

/** No GPS start gate (v18): the founder removed the P1-7 check that
 * required every active player to have a fix ≤ 120 s old before the
 * match could start. A match starts even if a player's GPS has not
 * reported yet; the backstop is the missing-fix ejection in `alarmTick`
 * step (4a) — no fix at all for 30 s during a live phase ejects.
 * (The old `START_GPS_FRESHNESS_MS = 120_000` constant is deleted.) */

/**
 * Player-row persist throttle (Phase 3 #2): a location.update emits a
 * Supabase player-upsert at most once per 30 s per seat (or sooner when
 * something durable actually changed — quality, role, connection). The
 * live in-memory fix is the primary source for freshness; the durable
 * lastFixAt is only the hibernate/wake fallback.
 */
export const PLAYER_PERSIST_INTERVAL_MS = 30_000;

/** GPS fix throttle (Phase 3 #2): at most ~1 accepted fix/s/seat. */
export const GPS_FIX_MIN_INTERVAL_MS = 1_000;

/**
 * v33 (F2b) — WS close for an ejected seat: 4405 (ejected, do-not-reconnect),
 * DISTINCT from 4403 (removed by the host). The client branches on code:
 * 4403 would make it treat an ejected seat as removed, clear the rejoin
 * token and lock the seat out of results/replay. The close is delivered
 * AFTER the `player-ejected` snapshot (snapshot-before-close), never
 * before it.
 */
export const EJECTED_CLOSE_CODE = 4405;
export const EJECTED_CLOSE_REASON = 'You were ejected from the game.';

/**
 * v24 — host reconnect grace (founder decision D1, 2026-11-21): a host
 * who ACTUALLY disconnects (`'network-lost'` / `'heartbeat-timeout'`)
 * keeps host for this long. If they resume inside the window the grace
 * is cancelled and no transfer ever happens; if the deadline passes
 * with the host still suspended, host transfers to the earliest-joined
 * connected player (the v23 rule, unchanged). Voluntary leave has NO
 * grace — `leaveSeat` transfers immediately, as before. The client
 * never reads this constant: it reads the deadline from the snapshot
 * (`hostGraceEndsAtMs`), so this stays a server-only calibration.
 */
export const HOST_RECONNECT_GRACE_MS = 30_000;

/**
 * v29 — seat return window (founder decision 2026-11-22, "what I
 * meant", as in ShadowHunt/SCRAM): ONE timer, 30 seconds, everywhere.
 * - Game start: a seat not present at `startMatch` gets 30 s to come
 *   back onto the page and reconnect (deadline = startMs + 30 s);
 *   still absent at the deadline, the alarm ejects it and the member
 *   count drops.
 * - Mid-game: a seat that suspends with an actually-gone reason
 *   ('network-lost' / 'heartbeat-timeout', i.e. NO live socket) gets
 *   30 s, then ejection. A tab-hidden seat WITH a live socket never
 *   starts this timer (a call on speaker while staying on the page
 *   counts as present — the socket is alive).
 * - Lobby: no timer, no ejection for absence — seats stay in the
 *   roster regardless of page presence/socket.
 * The 10-min `ABANDONED_IDLE_MS` stays as the resource backstop
 * (empty-room end); it never conflicts with this product rule.
 * Stored durably per seat (`state.disconnectDeadlineMs`) so the
 * deadline survives a DO eviction. Deliberately the same 30 s value
 * as the host grace, but a separate rule: the grace moves HOST, this
 * moves the SEAT.
 */
export const SEAT_RECONNECT_WINDOW_MS = 30_000;

/**
 * v29 (R1) — periodic snapshot safety valve: in live phases the alarm
 * emits a `room.state` at most once per 30 s even when nothing
 * changed, so a client that dropped a broadcast event (the WS layer
 * drops reused seqs with no gap detection) re-fetches a correct
 * snapshot within 30 s instead of holding a stale dot indefinitely.
 * The valve is NOT cheap under R5: the re-fetch request itself still
 * counts as a DO request even when the reply is the tiny
 * `snapshot.unchanged` — cost up to 1,800 requests/game (one
 * re-fetch per seat per 30 s: 30 seats × 60 re-fetches), counted in
 * the meter budget. It stays because it is the safety net under the
 * `teammate.fix` broadcast (R3 fix round): a client that missed a
 * broadcast re-syncs within 30 s.
 */
export const SNAPSHOT_SAFETY_VALVE_MS = 30_000;

/**
 * v29 (Gap 1) — per-seat accepted-fix ring for the anti-cheat
 * movement check: 10 fixes, memory only. With the 1/s server
 * throttle, consecutive accepted fixes are ~1 s apart, so the ring
 * covers ~10 s of movement — enough for the 3 s burst window.
 */
export const GPS_FIX_HISTORY_CAP = 10;

/**
 * Radio content-dedupe window (Phase 4 (r)): same sender + same kind +
 * same text inside this window is dropped as a double-delivery. 5 s is
 * short enough that a genuinely repeated message still goes through,
 * long enough to catch a double-tap / retry that minted a new commandId
 * (which the commandId idempotency above cannot catch).
 */
export const RADIO_DEDUPE_WINDOW_MS = 5_000;

/** Idle-lobby expiry: a LOBBY older than 24 h transitions to EXPIRED. */
export const LOBBY_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * v28 — abandoned-live-room idle window: how long a live room
 * (HEAD_START / ACTIVE / SAFETY_PAUSED, plus READY_CHECK / COUNTDOWN —
 * see `abandonForIdle`) may go with NO live WebSocket attached before
 * the DO ends it as terminal. 10 minutes.
 *
 * MUST exceed the v29 seat-hold window (founder decision 2026-11-22:
 * 2 minutes — a player who tabs away / takes a call and comes back
 * inside 2 min resumes straight in). 10 min = 2-min hold + 8-min
 * margin for a slow reconnect after the hold (ticket fetch + backoff +
 * hello) and for the host grace (30 s) to run first. A room abandoned
 * at or below 2 min would kill a room underneath a player on a 90 s
 * phone call (Diya F9). The margin costs almost nothing: while idle
 * the room ticks at the 30 s cadence (20 ticks over the window), so
 * 5 vs 10 min differs by ~10 requests.
 *
 * The clock is the durable `noSocketsSinceMs` on the state (NOT
 * memory): a DO evicted between 30 s ticks wakes with the clock
 * intact, so the window completes across hibernation. It is written
 * only on transitions (first no-socket tick sets it, a live socket
 * clears it, abandonment clears it) — never on every tick (v17
 * durable/non-durable split).
 */
export const ABANDONED_IDLE_MS = 10 * 60 * 1000;

/** Free-text caps (P2): safety pause / leave `reason`. */
export const REASON_MAX_CHARS = 500;

/** Voice ICE candidate cap (P2): 8 KB, same as the SDP cap. */
export const VOICE_CANDIDATE_MAX_BYTES = 8_192;

export interface OutboundEvent {
  type: WsServerMessageType;
  payload: Record<string, unknown>;
  /** Player ids to deliver to (connected sockets only; empty = nobody). */
  recipients: string[];
  eventId: string;
  serverSeq: number;
  serverTs: string;
}

export type OpResult<T> =
  | {
      ok: true;
      value: T;
      events: OutboundEvent[];
      persist: PersistIntent[];
      /** Sockets to close after delivery: { playerId, code, reason }. */
      disconnect?: Array<{ playerId: string; code: number; reason: string }>;
    }
  | {
      ok: false;
      error: string;
      code: string;
      status: number;
      /** Seconds to wait before retrying (rate limits only). */
      retryAfterSeconds?: number;
      /**
       * Side effects that already happened before the failure (e.g. the
       * overdue-catch sweep in getCatchToken): the caller must still
       * deliver/persist them, even though the op itself failed.
       */
      events?: OutboundEvent[];
      persist?: PersistIntent[];
    };

export function okResult<T>(
  value: T,
  events: OutboundEvent[] = [],
  persist: PersistIntent[] = [],
  disconnect?: Array<{ playerId: string; code: number; reason: string }>,
): OpResult<T> {
  return { ok: true, value, events, persist, disconnect };
}

export function errResult(
  error: string,
  code: string,
  status: number,
  events: OutboundEvent[] = [],
  persist: PersistIntent[] = [],
  retryAfterSeconds?: number,
): OpResult<never> {
  return { ok: false, error, code, status, events, persist, retryAfterSeconds };
}

// ---------------------------------------------------------------------------
// Durable-state (de)serialisation
// ---------------------------------------------------------------------------

export const STATE_KEY = 'room-state-v1';

export function emptyMemory(): RoomMemory {
  return {
    latestFix: {},
    outsideZone: {},
    pendingPings: [],
    tickets: [],
    ticketIssues: new Map(),
    ticketRevokes: new Map(),
    wsRate: new Map(),
    idempotency: new Map(),
    rawCatchTokens: new Map(),
    announcements: [],
    lastDisconnectAtMs: {},
    lastSuspensionReason: {},
    idempotentReplies: new Map(),
    pendingPingRecipients: new Map(),
    lastPlayerPersistAtMs: {},
    lastFixAcceptedAtMs: {},
    recentRadio: new Map(),
    lastSuccession: null,
    fixHistory: {},
    gpsViolations: {},
    logBuffer: [],
    httpIdempotentReplies: new Map(),
    epochMs: 0,
    lastSafetyValveMs: 0,
  };
}

/** The durable slice of a RoomStore — what `storage.put` persists. */
export function durableSnapshot(state: RoomDoState): RoomDoState {
  return {
    room: state.room,
    players: state.players,
    catches: state.catches,
    hostTokens: state.hostTokens,
    serverSeq: state.serverSeq,
    gameEventLog: state.gameEventLog,
    lastPingAtMs: state.lastPingAtMs,
    paused: state.paused,
    pausedBy: state.pausedBy,
    pausedFrom: state.pausedFrom,
    eventLog: state.eventLog,
    shrinkIndexApplied: state.shrinkIndexApplied,
    tickets: state.tickets,
    idempotency: state.idempotency,
    idempotentReplies: state.idempotentReplies,
    pendingPings: state.pendingPings,
    pendingPingRecipients: state.pendingPingRecipients,
    runnerQrTokens: state.runnerQrTokens,
    originalZoneBoundary: state.originalZoneBoundary ?? null,
    deleted: state.deleted ?? false,
    hostGrace: state.hostGrace ?? null,
    // v28: older durable writes lack the idle clock — null means a
    // socket was attached (or the room never went idle), same as a
    // fresh room.
    noSocketsSinceMs: state.noSocketsSinceMs ?? null,
    // v29: 30 s return deadlines — {} means no window is running.
    disconnectDeadlineMs: state.disconnectDeadlineMs ?? {},
  };
}

/** Restore durable state, filling defaults for fields older writes lack. */
export function restoreState(raw: unknown): RoomDoState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<RoomDoState>;
  if (!s.room || !Array.isArray(s.players)) return null;
  return {
    room: s.room,
    players: s.players,
    catches: s.catches ?? [],
    hostTokens: s.hostTokens ?? {},
    serverSeq: s.serverSeq ?? 0,
    gameEventLog: s.gameEventLog ?? [],
    lastPingAtMs: s.lastPingAtMs ?? {},
    paused: s.paused ?? false,
    pausedBy: s.pausedBy ?? null,
    pausedFrom: s.pausedFrom ?? null,
    eventLog: s.eventLog ?? [],
    shrinkIndexApplied: s.shrinkIndexApplied ?? 0,
    // P1-5 fields: older durable writes lack them — empty is the honest
    // default (a pre-fix ticket simply does not survive the wake).
    tickets: s.tickets ?? [],
    idempotency: s.idempotency ?? [],
    idempotentReplies: s.idempotentReplies ?? [],
    pendingPings: s.pendingPings ?? [],
    pendingPingRecipients: s.pendingPingRecipients ?? {},
    // v18 follow-up: older durable writes lack runner-token records —
    // empty is the honest default (no Runner had minted one yet).
    runnerQrTokens: s.runnerQrTokens ?? [],
    // v18 fix round (B2): older durable writes lack the snapshot —
    // null means "no match has started yet", same as a fresh room.
    originalZoneBoundary: s.originalZoneBoundary ?? null,
    // v23 Rule 1: older durable writes lack the flag — false means
    // the room was never host-cancel-deleted, same as a fresh room.
    deleted: s.deleted ?? false,
    // v24: older durable writes lack the grace — null means no grace
    // was running, same as a fresh room.
    hostGrace: s.hostGrace ?? null,
    // v28: older durable writes lack the idle clock — null means a
    // socket was attached, same as a fresh room.
    noSocketsSinceMs: s.noSocketsSinceMs ?? null,
    // v29: older durable writes lack return deadlines — {} means no
    // window is running, same as a fresh room.
    disconnectDeadlineMs: s.disconnectDeadlineMs ?? {},
  };
}

// ---------------------------------------------------------------------------
// RoomStore — the DO's state ops
// ---------------------------------------------------------------------------

export interface WsSessionRef {
  playerId: string;
  sessionId: string;
}

export class RoomStore {
  readonly state: RoomDoState;
  readonly mem: RoomMemory;

  constructor(state: RoomDoState, mem: RoomMemory = emptyMemory()) {
    this.state = state;
    this.mem = mem;
    // v29 (R5 fix round) — stamp the memory epoch for this awake
    // instance. Every wake creates a fresh instance (a fresh
    // constructor call), so the epoch changes on every wake by
    // construction; `restoreDurableMemory` re-stamps it as well, so
    // a store restored into an existing instance still moves.
    this.mem.epochMs = Date.now();
    // Older durable writes / test-built states lack the runner-token
    // records — default to empty rather than crashing on undefined.
    this.state.runnerQrTokens ??= [];
    // v24: same for the host grace — null means no grace is running.
    this.state.hostGrace ??= null;
    // v28: same for the idle clock — null means a socket is attached.
    this.state.noSocketsSinceMs ??= null;
    // v29: same for the return deadlines — {} means no window running.
    this.state.disconnectDeadlineMs ??= {};
  }

  /**
   * Rebuild the durable-backed memory maps after a hibernate/wake (P1-5).
   * The class calls this right after `restoreState`: tickets,
   * idempotency records + cached replies, and pending pings (+ their
   * per-recipient delivery state) come back; latest fixes deliberately
   * do NOT — raw coordinates are never persisted, so a woken DO reports
   * locations as unknown until each client sends a fresh fix (see
   * `locationStatus`). Raw catch tokens are likewise memory-only and
   * re-minted on re-fetch (see `getCatchToken`).
   */
  restoreDurableMemory(): void {
    // v29 (R5 fix round) — re-stamp the memory epoch on every
    // restore: the epoch must change on every wake, and a restore
    // into a long-lived instance is still a wake.
    this.mem.epochMs = Date.now();
    this.mem.tickets = [...(this.state.tickets ?? [])];
    this.mem.idempotency = new Map(
      (this.state.idempotency ?? []).map((e) => [e.key, e.record]),
    );
    this.mem.idempotentReplies = new Map(
      (this.state.idempotentReplies ?? []).map((e) => [e.key, e.events]),
    );
    this.mem.pendingPings = [...(this.state.pendingPings ?? [])];
    this.mem.pendingPingRecipients = new Map(
      Object.entries(this.state.pendingPingRecipients ?? {}).map(([k, v]) => [
        k,
        new Set(v),
      ]),
    );
  }

  /**
   * Copy the durable-backed memory maps into `state` before a
   * `storage.put` (P1-5). The class calls this inside `save()`; every
   * mutation therefore persists the ticket registry and pending pings
   * together with the game state. The idempotency table is deliberately
   * NOT synced here: rebuilding those arrays on every save is O(n) on
   * the hot path (Phase 3 #4). It syncs on a slow cadence instead via
   * `syncIdempotencyMemory()` — a wake inside that window loses at most
   * 60 s of idempotency records. Same-commandId retries stay safe
   * (the cached reply is what a retry gets), and the state-changing
   * commands are additionally guarded against double-apply by the
   * engine (re-confirm → CONFLICT, re-request → open claim, ready.set
   * → idempotent assignment, pause/resume/leave/dispute/
   * briefing.confirm likewise). That guard does NOT cover the relay
   * commands (radio.send, signal.send, pin.place, announcement.send):
   * they carry no server state to conflict on, so a retry that mints a
   * NEW commandId re-applies them.
   * radio.send has a content-dedupe window instead (Phase 4 (r)); the
   * others are deliberately unguarded — see the note at the radio.send
   * dedupe for why.
   */
  syncDurableMemory(): void {
    this.state.tickets = [...this.mem.tickets];
    this.state.pendingPings = [...this.mem.pendingPings];
    this.state.pendingPingRecipients = Object.fromEntries(
      [...this.mem.pendingPingRecipients.entries()].map(([k, v]) => [k, [...v]]),
    );
  }

  /** Slow-cadence sync of the idempotency table + cached replies (Phase 3 #4). */
  syncIdempotencyMemory(): void {
    this.state.idempotency = [...this.mem.idempotency.entries()].map(
      ([key, record]) => ({ key, record }),
    );
    this.state.idempotentReplies = [...this.mem.idempotentReplies.entries()].map(
      ([key, events]) => ({ key, events }),
    );
  }

  // -- basics ---------------------------------------------------------------

  get room(): Room {
    return this.state.room;
  }

  get players(): Player[] {
    return this.state.players;
  }

  player(playerId: string): Player | undefined {
    return this.state.players.find((p) => p.playerId === playerId);
  }

  /** Active seats: in the room (not left). Ejected seats stay on the record. */
  activePlayers(): Player[] {
    return this.state.players.filter((p) => p.leftAt === null);
  }

  caughtRunnerIds(): string[] {
    return this.state.catches
      .filter((c) => c.state === 'confirmed')
      .map((c) => c.runnerPlayerId);
  }

  nextSeq(): number {
    this.state.serverSeq += 1;
    return this.state.serverSeq;
  }

  /** Build one outbound server event (assigns the monotonic serverSeq). */
  emit(
    type: WsServerMessageType,
    payload: Record<string, unknown>,
    recipients: string[],
    nowMs: number = Date.now(),
  ): OutboundEvent {
    const serverSeq = this.nextSeq();
    return {
      type,
      payload: { ...payload, serverSeq },
      recipients,
      eventId: newId(),
      serverSeq,
      serverTs: new Date(nowMs).toISOString(),
    };
  }

  errorEvent(
    toPlayerId: string,
    code: string,
    message: string,
    retryable: boolean,
    retryAfterSeconds?: number,
    nowMs: number = Date.now(),
  ): OutboundEvent {
    // v29 (Gap 5) — every WS error is logged by code (no payload, no
    // coordinates). The entry rides out with the next persist batch
    // or alarm tick; logging never changes the reply or durability.
    this.queueLog({
      level: 'warn',
      message: 'ws.error',
      roomId: this.room.roomId,
      playerId: toPlayerId,
      metadata: { code },
    });
    return this.emit(
      'error',
      {
        code,
        message,
        retryable,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        serverTs: new Date(nowMs).toISOString(),
      },
      [toPlayerId],
      nowMs,
    );
  }

  /** All player ids (broadcast scope = every seat; class sends to sockets). */
  allPlayerIds(): string[] {
    return this.state.players.map((p) => p.playerId);
  }

  hunterPlayerIds(): string[] {
    return this.state.players
      .filter((p) => p.matchRole === 'hunter' && p.leftAt === null)
      .map((p) => p.playerId);
  }

  runnerPlayerIds(): string[] {
    return this.state.players
      .filter((p) => p.matchRole === 'runner' && p.leftAt === null)
      .map((p) => p.playerId);
  }

  /** Recipients for a catch event: the parties + the host only (role secrecy). */
  catchRecipients(c: CatchEvent): string[] {
    const ids = new Set([c.hunterPlayerId, c.runnerPlayerId, this.room.hostPlayerId]);
    return [...ids];
  }

  /** Team members of a player; in the lobby the scope is the whole lobby. */
  teamRecipients(playerId: string): string[] {
    const me = this.player(playerId);
    if (!me || this.room.phase === 'LOBBY' || me.team === null) {
      return this.allPlayerIds();
    }
    return this.state.players
      .filter((p) => p.team === me.team)
      .map((p) => p.playerId);
  }

  /**
   * Is this player a caught Runner spectating (Classic)? A confirmed
   * catch against a seat that is still a Runner. Infection flips a
   * tagged Runner to Hunter, so a flipped player is not a spectator.
   * Caught spectators cannot send radio / voice / pins / announcements
   * to their live team (P2) — the founder can override this rule.
   */
  isCaughtSpectator(playerId: string): boolean {
    const me = this.player(playerId);
    if (!me || me.matchRole !== 'runner') return false;
    return this.state.catches.some(
      (c) => c.state === 'confirmed' && c.runnerPlayerId === playerId,
    );
  }

  /** Can the match complete from here (RESOLVING then COMPLETED)? */
  canCompleteMatch(): boolean {
    return (
      canTransition(this.room.phase, 'RESOLVING') &&
      canTransition('RESOLVING', 'COMPLETED')
    );
  }

  /**
   * Would confirming this catch (with the engine's decided value applied)
   * complete the match? Pure simulation — nothing is mutated. Used by
   * the confirm/resolve paths to validate the completion transition
   * BEFORE marking the catch confirmed (P1-2).
   */
  wouldCompleteOnConfirm(
    c: CatchEvent,
    decided: CatchEvent,
    nowMs: number,
  ): boolean {
    const nextCatches = this.state.catches.map((x) =>
      x.catchId === c.catchId ? decided : x,
    );
    const caughtIds = nextCatches
      .filter((x) => x.state === 'confirmed')
      .map((x) => x.runnerPlayerId);
    const durationSeconds =
      this.room.startedAt === null
        ? 0
        : Math.max(0, Math.floor((nowMs - Date.parse(this.room.startedAt)) / 1000));
    return (
      maybeCompleteOnWin({
        mode: this.room.config.mode,
        players: this.state.players,
        caughtRunnerIds: caughtIds,
        durationSeconds,
        tags: confirmedTags(nextCatches),
      }) !== null
    );
  }

  /** Record which seats a newly built ping still has to reach. */
  notePingRecipients(pingId: string, recipientIds: string[]): void {
    this.mem.pendingPingRecipients.set(pingId, new Set(recipientIds));
  }

  /**
   * Per-recipient ping ack (P2): remove only the recipients that actually
   * received this delivery from the ping's pending set. The ping leaves
   * `pendingPings` (and `lastPingAtMs` advances) only when NO recipient
   * is left waiting — an offline Hunter still gets it on reconnect.
   */
  acknowledgePingDeliveryFor(
    pingId: string,
    deliveredIds: string[],
    nowMs: number,
  ): void {
    const waiting = this.mem.pendingPingRecipients.get(pingId);
    if (waiting) {
      for (const id of deliveredIds) waiting.delete(id);
      if (waiting.size > 0) return;
      this.mem.pendingPingRecipients.delete(pingId);
    }
    const idx = this.mem.pendingPings.findIndex((p) => p.pingId === pingId);
    if (idx === -1) return;
    const [ping] = this.mem.pendingPings.splice(idx, 1);
    if (ping) this.state.lastPingAtMs[ping.subjectPlayerId] = nowMs;
  }

  safetyState(): SafetyState {
    return {
      paused: this.state.paused,
      pausedBy: this.state.pausedBy,
      pausedAt: this.room.pausedAt,
    };
  }

  /**
   * Per-viewer location status, teammates-only during play (P2 liveness
   * leak): an opponent's freshness must not leak to the other team. The
   * viewer always sees their own status; in the LOBBY there are no teams
   * yet, so the whole lobby sees each other.
   * Freshness needs a LIVE fix in memory, not just a durable `lastFixAt`:
   * after a hibernate/wake the fixes are gone while `lastFixAt` still
   * says "known" (P1-5) — reporting unknown until a fresh fix arrives
   * is the honest answer, and lobby clients stream fixes continuously.
   */
  locationStatus(nowMs: number): Record<string, 'known' | 'unknown'> {
    const out: Record<string, 'known' | 'unknown'> = {};
    for (const p of this.state.players) {
      const fix = this.mem.latestFix[p.playerId];
      out[p.playerId] =
        fix !== undefined && nowMs - fix.timestampMs <= LOCATION_FRESHNESS_SECONDS * 1000
          ? 'known'
          : 'unknown';
    }
    return out;
  }

  /**
   * Location status for one viewer: teammates-only during play. The
   * base `locationStatus` is the raw freshness map; this scopes it so a
   * viewer sees real freshness for themself + their team, and 'unknown'
   * for everyone else. In the LOBBY the whole lobby is one scope.
   */
  locationStatusFor(viewerId: string, nowMs: number): Record<string, 'known' | 'unknown'> {
    const raw = this.locationStatus(nowMs);
    if (this.room.phase === 'LOBBY') return raw;
    const viewer = this.player(viewerId);
    const team = viewer?.team ?? null;
    if (team === null) {
      const out: Record<string, 'known' | 'unknown'> = {};
      for (const p of this.state.players) {
        out[p.playerId] = p.playerId === viewerId ? raw[p.playerId] ?? 'unknown' : 'unknown';
      }
      return out;
    }
    const out: Record<string, 'known' | 'unknown'> = {};
    for (const p of this.state.players) {
      out[p.playerId] =
        p.playerId === viewerId || p.team === team
          ? raw[p.playerId] ?? 'unknown'
          : 'unknown';
    }
    return out;
  }

  missedAnnouncements(viewerId: string): Announcement[] {
    const since = this.mem.lastDisconnectAtMs[viewerId];
    if (since === undefined) return [];
    return this.mem.announcements.filter(
      (a) => Date.parse(a.sentAt) > since && a.playerId !== viewerId,
    );
  }

  snapshotFor(viewerId: string, nowMs: number = Date.now()): WsSnapshotPayload {
    const viewer = this.player(viewerId);
    return buildSnapshot({
      room: this.room,
      players: this.state.players,
      viewerPlayerId: viewerId,
      viewerIsHost: viewer?.isHost ?? false,
      serverSeq: this.state.serverSeq,
      // Teammates-only liveness (P2): opponents read as 'unknown'.
      locationStatus: this.locationStatusFor(viewerId, nowMs),
      catches: this.state.catches,
      safetyState: this.safetyState(),
      missedAnnouncements: this.missedAnnouncements(viewerId),
      // Teammates' latest live fixes (memory only) — buildSnapshot keeps
      // only the viewer's teammates, never an opponent, and none at all
      // for a caught Runner.
      fixes: this.mem.latestFix,
      // v24: the host-grace deadline, so the client can show the
      // countdown without knowing the server constant (null = no grace).
      hostGraceEndsAtMs: this.hostGraceEndsAtMs(),
      // v29: per-seat 30 s-rule presence + return deadlines.
      seatPresence: this.seatPresenceMap(),
      // v29 (R5 fix round): the memory epoch — top-level on the
      // payload so the client can include it in its snapshot key.
      epochMs: this.mem.epochMs,
    });
  }

  /**
   * v29 fix round (F6, R3) — the recipients of a `teammate.fix`
   * broadcast for a fix from `senderId`: exactly the seats whose
   * snapshot `teammateFixes` would contain this fix. Computed by
   * running the SAME predicate `buildSnapshot` uses
   * (`teammateViewFor`, per viewer) over the current state — never
   * a re-implementation — so broadcast and snapshot can never
   * disagree about who sees whom, including the caught-Runner-
   * loses-live-view rule (a caught Runner's own view is empty, so
   * they receive nothing; a live teammate's view still contains a
   * caught Runner's fix, so they still receive it). Empty in the
   * lobby (no teams yet) and when the sender has no team.
   */
  teammateFixRecipients(senderId: string): string[] {
    const out: string[] = [];
    for (const p of this.state.players) {
      if (p.playerId === senderId) continue;
      const view = teammateViewFor(p.playerId, this.state.players, this.mem.latestFix, this.state.catches);
      if (view.teammateFixes[senderId] !== undefined) out.push(p.playerId);
    }
    return out;
  }

  // -- audit log ------------------------------------------------------------

  /** Redacted game-event log entry (coordinates stripped at any depth, cap 500). */
  logGameEvent(
    type: GameEvent['type'],
    actorId: string | null,
    payload: Record<string, unknown>,
    nowMs: number = Date.now(),
  ): PersistIntent {
    // v29 fix round (F9) — deep strip, same key list as
    // `redactPayload` / `stripCoordinatesDeep` in supabase.ts: a
    // nested `fix` / `centre` / `coordinates` object must never
    // reach the log through a nested payload. All current payloads
    // are scalar by construction — this is hardening, not a live leak.
    const clean = stripCoordinatesDeep(payload) as Record<string, unknown>;
    const seq = this.nextSeq();
    const event: GameEvent = {
      id: newId(),
      timestamp: new Date(nowMs).toISOString(),
      roomId: this.room.roomId,
      // GameEvent.actorId is a plain string; system events use ''.
      actorId: actorId ?? '',
      type,
      payload: clean as GameEvent['payload'],
      seq,
    };
    this.state.gameEventLog.push(event);
    if (this.state.gameEventLog.length > GAME_EVENT_LOG_CAP) {
      this.state.gameEventLog.splice(0, this.state.gameEventLog.length - GAME_EVENT_LOG_CAP);
    }
    this.state.eventLog.push({ seq, type, actorId, at: event.timestamp });
    // Phase 3 #4: the lightweight log was uncapped, so the persisted
    // blob grew monotonically for the whole match and every save()
    // rewrote more. Same 500 cap as the game-event log.
    if (this.state.eventLog.length > EVENT_LOG_CAP) {
      this.state.eventLog.splice(0, this.state.eventLog.length - EVENT_LOG_CAP);
    }
    return {
      kind: 'room-event',
      roomId: this.room.roomId,
      seq,
      type,
      actorId,
      payload: clean,
    };
  }

  private bumpVersion(): void {
    this.state.room.version += 1;
  }

  /** v23 Rule 1 — has the host cancelled and deleted this room? */
  private isDeleted(): boolean {
    return this.state.deleted === true;
  }

  /** Refusal for any op on a deleted room (v23 Rule 1). */
  private deletedRefusal(): OpResult<never> {
    return errResult('This room has been deleted.', 'ROOM_NOT_FOUND', 404);
  }

  private roomStateEvent(reason: string, nowMs: number): OutboundEvent {
    return this.emit(
      'room.state',
      { phase: this.room.phase, version: this.room.version, reason },
      this.allPlayerIds(),
      nowMs,
    );
  }

  // -- credential checks (hash comparison only; raw values never arrive) ---

  verifyReconnect(playerId: string, reconnectTokenHash: string | null): Player | null {
    // v23 fix round 1 (S4): a deleted room has no seats anymore — every
    // reconnect-token check refuses, so no reconnect-gated op (snapshot,
    // results, pause, ticket issue, ...) can run on a deleted room.
    if (this.isDeleted()) return null;
    if (!reconnectTokenHash) return null;
    const p = this.player(playerId);
    if (!p) return null;
    return p.reconnectTokenHash === reconnectTokenHash ? p : null;
  }

  verifyHost(playerId: string, hostTokenHash: string | null): Player | null {
    // v23 Rule 1: a deleted room has no host anymore — every host-token
    // check refuses, so no host-only op can run on a deleted room.
    if (this.isDeleted()) return null;
    if (!hostTokenHash) return null;
    const p = this.player(playerId);
    if (!p || !p.isHost) return null;
    // v23 fix round 1 (S1): a seat that LEFT is not the host anymore,
    // even if its `isHost` flag and host token both survived (sole-host
    // leave with no successor). Without this, a left host could replay
    // the room into a lobby with 0 active players and a hostPlayerId
    // pointing at an absent host. Rejoin-by-name restore clears
    // `leftAt`, so a genuinely restored host still verifies.
    if (p.leftAt !== null) return null;
    // v33 (Diya): an ejected host's token must not verify WHILE the
    // match is live — an ejected host can otherwise still call
    // mid-match host ops (`lifecycleOp('end')`, resume, config).
    // Live-phase only, deliberately: in a terminal phase the same
    // token must still verify so the host can `replayMatch` the
    // finished room — ejection never transfers host, so a blanket
    // gate would strand a room whose host was ejected with nobody
    // able to replay it.
    if (this.ejectedWhileLive(p)) return null;
    return this.state.hostTokens[playerId] === hostTokenHash ? p : null;
  }

  /**
   * v33 (F2a/F3b) — an ejected seat is out while the match is live
   * (HEAD_START / ACTIVE / SAFETY_PAUSED / RESOLVING — i.e. not
   * terminal, not LOBBY). In a terminal phase the snapshot is history
   * and `get-results` is the read path; in the LOBBY `ejectedAt` is
   * always null (`replayMatch` clears it), so the LOBBY exclusion is
   * vacuous but explicit.
   *
   * Public (not private) since the v33 fix round: `RoomDO`'s hello
   * path needs the same check, and hello never reaches the store.
   */
  ejectedWhileLive(player: Player): boolean {
    return (
      player.ejectedAt !== null &&
      !isTerminalPhase(this.room.phase) &&
      this.room.phase !== 'LOBBY'
    );
  }

  // -- create / join --------------------------------------------------------

  static createRoom(input: {
    roomId: string;
    roomCode: string;
    hostPlayerId: string;
    displayName: string;
    config: RoomConfig;
    reconnectTokenHash: string;
    hostTokenHash: string;
    nowMs: number;
  }): { store: RoomStore; persist: PersistIntent[] } {
    const now = new Date(input.nowMs).toISOString();
    const room: Room = {
      roomId: input.roomId,
      roomCode: input.roomCode,
      hostPlayerId: input.hostPlayerId,
      phase: 'LOBBY',
      version: 1,
      config: input.config,
      createdAt: now,
      startedAt: null,
      endsAt: null,
      pausedAt: null,
      result: null,
    };
    const host: Player = {
      playerId: input.hostPlayerId,
      roomId: input.roomId,
      kind: 'guest',
      displayName: input.displayName,
      isHost: true,
      matchRole: null,
      team: null,
      reconnectTokenHash: input.reconnectTokenHash,
      joinedAt: now,
      leftAt: null,
      ejectedAt: null,
      connectionState: 'connected',
      lastFixAt: null,
      locationQuality: null,
      isReady: true,
      briefingConfirmed: true,
      ageGatePassed: true,
      suspensionCount: 0,
    };
    const state: RoomDoState = {
      room,
      players: [host],
      catches: [],
      hostTokens: { [input.hostPlayerId]: input.hostTokenHash },
      serverSeq: 0,
      gameEventLog: [],
      lastPingAtMs: {},
      paused: false,
      pausedBy: null,
      pausedFrom: null,
      eventLog: [],
      shrinkIndexApplied: 0,
      tickets: [],
      idempotency: [],
      idempotentReplies: [],
      pendingPings: [],
      pendingPingRecipients: {},
      runnerQrTokens: [],
      hostGrace: null,
    };
    const store = new RoomStore(state);
    const persist: PersistIntent[] = [
      { kind: 'room-upsert', room },
      { kind: 'player-upsert', roomId: input.roomId, player: host },
    ];
    persist.push(
      store.logGameEvent('PLAYER_JOINED', host.playerId, { playerId: host.playerId, displayName: host.displayName }, input.nowMs),
    );
    return { store, persist };
  }

  /**
   * Join by code (async: mints the seat's reconnect token and stores only
   * its hash). A duplicate display name (case-insensitive) RESTORES the
   * seat — but only with the seat's reconnect token; a restore without a
   * matching token is 403. An ejected seat stays ejected on rejoin. New
   * joins are LOBBY-only; room-full counts active (not-left) seats.
   */
  async addPlayerAsync(input: {
    displayName: string;
    roomCode: string;
    reconnectTokenHash: string | null;
    nowMs: number;
  }): Promise<OpResult<{ player: PlayerView; reconnectToken: string; restored: boolean }>> {
    const nowMs = input.nowMs;
    if (this.isDeleted()) return this.deletedRefusal();
    if (!isValidDisplayName(input.displayName)) {
      return errResult('Display name must be 1–30 characters.', 'VALIDATION_FAILED', 400);
    }
    if (!isValidRoomCode(input.roomCode) || input.roomCode !== this.room.roomCode) {
      return errResult('The room code does not match.', 'FORBIDDEN', 403);
    }
    const name = input.displayName.trim();
    const existing = this.state.players.find(
      (p) => p.displayName.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      if (input.reconnectTokenHash === null || input.reconnectTokenHash !== existing.reconnectTokenHash) {
        return errResult('That name is taken — reconnect with its saved seat to restore it.', 'FORBIDDEN', 403);
      }
      // v33 (F3b): an ejected seat cannot restore while the match is
      // live — a restore would hand it a connected seat, ticket
      // minting and snapshot reads mid-match. (After `replayMatch`
      // clears the ejection the seat restores normally.)
      if (this.ejectedWhileLive(existing)) {
        return errResult('An ejected seat cannot rejoin while the match is live.', 'FORBIDDEN', 403);
      }
      // v33 (F3c): a seat that left (host-removed in the lobby, or a
      // voluntary leave) restores in the LOBBY only — a mid-match
      // restore would seat a null-role ghost with no role, no team
      // and no way back into play.
      if (existing.leftAt !== null && this.room.phase !== 'LOBBY') {
        return errResult('This room is no longer open for new players.', 'CONFLICT', 409);
      }
      if (existing.leftAt !== null && existing.ejectedAt === null) {
        existing.leftAt = null;
      }
      if (existing.connectionState === 'suspended') {
        const r = resumeSuspendedPlayer(existing, nowMs);
        Object.assign(existing, r.player);
      } else if (existing.leftAt === null) {
        existing.connectionState = 'connected';
      }
      // v29 (30 s rule) — a restored seat came back: clear any return
      // window (role/score intact, same as a hello resume).
      this.clearDisconnectDeadline(existing.playerId);
      // v24 — a graced host restored by name + reconnect token keeps
      // host: cancel the grace. The host token was never deleted
      // during the grace, so the restored host still verifies.
      // (A host who returns AFTER a transfer is a regular player by
      // then — the grace is already gone — so this never flips host
      // back.)
      if (
        existing.isHost &&
        existing.connectionState === 'connected' &&
        this.state.hostGrace?.hostPlayerId === existing.playerId
      ) {
        this.cancelHostGrace(existing.playerId);
      }
      // An ejected seat stays ejected: ejectedAt is never cleared here.
      this.bumpVersion();
      const events = [
        ...this.emitPlayerEvent('player.joined', existing, nowMs),
        this.roomStateEvent('player-joined', nowMs),
      ];
      const persist: PersistIntent[] = [
        { kind: 'player-upsert', roomId: this.room.roomId, player: existing },
      ];
      persist.push(this.logGameEvent('PLAYER_JOINED', existing.playerId, { playerId: existing.playerId, displayName: existing.displayName }, nowMs));
      // The returned seat is the SUBJECT's own view: hash stripped, own
      // role kept (BEHAVIOUR §4). A raw Player must never leave the store —
      // the reconnect-token hash is server-only.
      return okResult({ player: this.playerViewFor(existing.playerId, existing), reconnectToken: '', restored: true }, events, persist);
    }
    if (this.room.phase !== 'LOBBY') {
      return errResult('This room is no longer open for new players.', 'CONFLICT', 409);
    }
    if (this.activePlayers().length >= Math.min(this.room.config.maxPlayers, MAX_PLAYERS)) {
      return errResult('This room is full.', 'CONFLICT', 409);
    }
    const rawToken = randomHex(16);
    const tokenHash = await hashReconnectToken(rawToken);
    const now = new Date(nowMs).toISOString();
    const player: Player = {
      playerId: newId(),
      roomId: this.room.roomId,
      kind: 'guest',
      displayName: name,
      isHost: false,
      matchRole: null,
      team: null,
      reconnectTokenHash: tokenHash,
      joinedAt: now,
      leftAt: null,
      ejectedAt: null,
      connectionState: 'connected',
      lastFixAt: null,
      locationQuality: null,
      isReady: false,
      briefingConfirmed: false,
      ageGatePassed: true,
      suspensionCount: 0,
    };
    this.state.players.push(player);
    this.bumpVersion();
    const events = [
      ...this.emitPlayerEvent('player.joined', player, nowMs),
      this.roomStateEvent('player-joined', nowMs),
    ];
    const persist: PersistIntent[] = [
      { kind: 'player-upsert', roomId: this.room.roomId, player },
    ];
    persist.push(this.logGameEvent('PLAYER_JOINED', player.playerId, { playerId: player.playerId, displayName: player.displayName }, nowMs));
    // Subject's own view: hash stripped (BEHAVIOUR §4) — never the raw Player.
    return okResult({ player: this.playerViewFor(player.playerId, player), reconnectToken: rawToken, restored: false }, events, persist);
  }

  /** One seat as a viewer sees it (own role only — see @pakdam/engine). */
  playerViewFor(viewerPlayerId: string, player: Player): PlayerView {
    const { reconnectTokenHash: _hash, ...rest } = player;
    void _hash;
    // v29 — every view leaving the DO carries the seat's 30 s-rule
    // presence + return deadline (contract for the client countdown).
    const presence = {
      presence: this.presenceFor(player),
      reconnectEndsAtMs: this.reconnectEndsAtMs(player.playerId),
    };
    if (player.playerId === viewerPlayerId) return { ...rest, ...presence };
    return { ...rest, matchRole: null, team: null, ...presence };
  }

  /**
   * v29 — a seat's presence for the 30 s rule: 'away' = no live socket
   * (suspended, disconnected, or left); 'present' otherwise. A
   * tab-hidden seat reads 'away' even though its socket may still be
   * attached — it is not on the page. The disconnect TIMER (the
   * enforcement) is the narrower rule: it runs only for actually-gone
   * suspensions, never for tab-hidden (see `setDisconnectDeadline`).
   */
  presenceFor(player: Player): 'present' | 'away' {
    if (player.leftAt !== null) return 'away';
    return player.connectionState === 'suspended' ||
      player.connectionState === 'disconnected'
      ? 'away'
      : 'present';
  }

  /** v29 — this seat's 30 s return deadline (epoch ms), or null. */
  reconnectEndsAtMs(playerId: string): number | null {
    return this.state.disconnectDeadlineMs?.[playerId] ?? null;
  }

  /** v29 — per-seat presence/deadline map for the snapshot builder. */
  seatPresenceMap(): Record<
    string,
    { reconnectEndsAtMs: number | null; presence: 'present' | 'away' }
  > {
    const out: Record<
      string,
      { reconnectEndsAtMs: number | null; presence: 'present' | 'away' }
    > = {};
    for (const p of this.state.players) {
      out[p.playerId] = {
        reconnectEndsAtMs: this.reconnectEndsAtMs(p.playerId),
        presence: this.presenceFor(p),
      };
    }
    return out;
  }

  /**
   * v29 — start a seat's 30 s return window (`nowMs + 30 s`), if none
   * is already running. Never restarts or extends a running window.
   * No-op in the LOBBY (seats stay regardless of presence) and in
   * terminal phases. Called from `startMatch` (seats not present at
   * start) and `suspendSeat` (actually-gone mid-game only — the
   * caller gates the reason).
   */
  setDisconnectDeadline(playerId: string, nowMs: number): boolean {
    if (this.room.phase === 'LOBBY' || isTerminalPhase(this.room.phase)) {
      return false;
    }
    const deadlines = (this.state.disconnectDeadlineMs ??= {});
    if (deadlines[playerId] !== undefined) return false;
    deadlines[playerId] = nowMs + SEAT_RECONNECT_WINDOW_MS;
    return true;
  }

  /** v29 — clear a seat's return window (resume / leave / eject). */
  clearDisconnectDeadline(playerId: string): void {
    if (this.state.disconnectDeadlineMs) {
      delete this.state.disconnectDeadlineMs[playerId];
    }
  }

  /**
   * v29 (Gap 5) — buffer one structured-log entry (memory only, cap
   * 100). Best-effort: never throws, never blocks a game op. When
   * full, the oldest info/debug entry is dropped first to make room;
   * when the buffer holds only warn/error, an incoming info/debug is
   * dropped instead; an incoming warn/error evicts the oldest entry.
   * No entry ever carries coordinates — callers pass metadata only,
   * and `persistLogBatch` strips coordinate keys as a backstop.
   */
  queueLog(entry: LogEntry): void {
    try {
      const buf = this.mem.logBuffer;
      if (buf.length >= 100) {
        const dropIdx = buf.findIndex((e) => e.level === 'info' || e.level === 'debug');
        if (dropIdx >= 0) {
          buf.splice(dropIdx, 1);
        } else if (entry.level === 'info' || entry.level === 'debug') {
          return;
        } else {
          buf.shift();
        }
      }
      buf.push(entry);
    } catch {
      // Logging must never break a game op.
    }
  }

  /**
   * v29 (Gap 5) — drain the log buffer as one `log-batch` persist
   * intent, or null when empty. The caller appends it to a persist
   * batch already going out (piggyback) or to the alarm tick.
   */
  takeLogBatchIntent(): PersistIntent | null {
    if (this.mem.logBuffer.length === 0) return null;
    const entries = this.mem.logBuffer.splice(0, this.mem.logBuffer.length);
    return { kind: 'log-batch', entries };
  }

  /**
   * v29 (Gap 4) — read a cached HTTP idempotent reply. Returns null
   * on a miss or an expired entry (expired entries are dropped).
   */
  getHttpIdempotentReply(
    key: string,
    nowMs: number,
  ): { status: number; body: Record<string, unknown> } | null {
    const hit = this.mem.httpIdempotentReplies.get(key);
    if (!hit) return null;
    if (nowMs >= hit.expiresAtMs) {
      this.mem.httpIdempotentReplies.delete(key);
      return null;
    }
    return { status: hit.status, body: hit.body };
  }

  /** v29 (Gap 4) — cache an HTTP reply for its idempotency key (10-min TTL). */
  putHttpIdempotentReply(
    key: string,
    status: number,
    body: Record<string, unknown>,
    nowMs: number,
  ): void {
    this.mem.httpIdempotentReplies.set(key, {
      status,
      body,
      expiresAtMs: nowMs + IDEMPOTENCY_TTL_MS,
    });
  }

  /** v29 (Gap 1) — this room's effective anti-cheat settings. */
  gpsAntiCheatConfig(): ReturnType<typeof resolveGpsAntiCheatConfig> {
    return resolveGpsAntiCheatConfig(this.room.config.gpsAntiCheat);
  }

  /**
   * v29 (R8) — mint + register a renewal WS ticket for a seat, DO-side
   * (server-push renewal). The caller is the DO itself acting on an
   * authenticated socket, so no reconnect-token check applies here —
   * the socket already proved the seat at upgrade. The per-seat issue
   * rate limit still applies (same table as the HTTP mint path).
   * The raw value is returned to the caller (the class) for ONE
   * delivery over the socket as `ticket.renewed`; only the hash is
   * stored, exactly like the HTTP path.
   */
  async mintRenewalTicket(
    playerId: string,
    nowMs: number,
  ): Promise<OpResult<{ ticket: string; ticketId: string; expiresAtMs: number }>> {
    if (this.isDeleted()) return this.deletedRefusal();
    const seat = this.player(playerId);
    if (!seat || seat.leftAt !== null || seat.ejectedAt !== null) {
      return errResult('Seat not found in this room.', 'FORBIDDEN', 403);
    }
    const issueCheck = this.checkTicketIssueRateLimit(playerId, nowMs);
    if (!issueCheck.allowed) {
      return errResult(
        'Too many tries — slow down.',
        'RATE_LIMITED',
        429,
        [],
        [],
        issueCheck.retryAfterSeconds,
      );
    }
    const ticket = randomHex(32);
    const ticketId = newId();
    const expiresAtMs = nowMs + WS_TICKET_TTL_MS;
    this.mem.tickets.push({
      ticketId,
      playerId,
      ticketHash: await hashWsTicket(ticket),
      purpose: 'renew',
      expiresAtMs,
      redeemed: false,
      createdAtMs: nowMs,
    });
    return okResult({ ticket, ticketId, expiresAtMs });
  }

  /**
   * One roster event per recipient, each carrying that recipient's view of
   * the subject (BEHAVIOUR §4 role secrecy: only the subject sees their
   * own matchRole/team). A single broadcast view would leak the subject's
   * role to every other seat — live during play on restore (no phase gate)
   * and on leave. The reconnect-token hash is stripped for every viewer.
   *
   * Phase 3 #9: there are only TWO distinct views — the subject's own
   * and everyone else's redacted one — so this builds TWO events, not
   * N: one broadcast carrying the redacted view to the whole room, plus
   * one direct event carrying the subject's own view to the subject
   * (delivered second, so the subject's last-applied view is their own).
   * The client only re-fetches a snapshot on these events, so the
   * subject receiving both is harmless. Role secrecy is unchanged.
   */
  private emitPlayerEvent(
    type: 'player.joined' | 'player.removed' | 'player.left',
    player: Player,
    nowMs: number,
  ): OutboundEvent[] {
    // A viewer id that can never be a real seat (UUIDs only): the
    // redacted view for "everyone else".
    const redacted = this.playerViewFor('00000000-0000-0000-0000-000000000000', player);
    return [
      this.emit(type, { player: redacted }, this.allPlayerIds(), nowMs),
      this.emit(type, { player: this.playerViewFor(player.playerId, player) }, [player.playerId], nowMs),
    ];
  }

  // -- host token -----------------------------------------------------------

  /**
   * Mint / rotate the host token for the host seat (previous token dies).
   *
   * v31 FIX ROUND (F6) — investigated, NOT changed. Two tabs restoring
   * the same host seat ping-pong: host tokens live in sessionStorage
   * (`pakdam.session.v1`, one copy per tab — see
   * apps/web/src/lib/session-credentials.ts), so each tab holds its
   * own cached token and this unconditional overwrite kills the other
   * tab's token on every mint; `postHost` (live-room-client.ts) then
   * re-mints once per 403, which kills the first tab's token in turn.
   * The obvious server fix — "return the existing valid token instead
   * of minting" — is IMPOSSIBLE here: only the HASH is stored
   * (`hashHostToken`, below), never the raw token, and the raw value
   * exists only in the minting tab's sessionStorage. Returning it
   * would require persisting a raw bearer credential in durable
   * state. The remaining server-side shape (keep the previous hash
   * valid as a grace) changes the durable `hostTokens` record, needs
   * a migration for stored states, and weakens the "previous token
   * dies" rotation guarantee — not a change to make unilaterally in
   * this round. The churn is bounded meanwhile by the Worker limiter
   * (5/min/seat on POST /v1/rooms/:id/host/token) and each tab's
   * action still succeeds via the one re-mint retry. See the fix-round
   * report for the candidate design and its pinning test.
   */
  async issueHostToken(input: {
    playerId: string;
    reconnectTokenHash: string | null;
    nowMs: number;
  }): Promise<OpResult<{ hostToken: string }>> {
    const seat = this.verifyReconnect(input.playerId, input.reconnectTokenHash);
    if (!seat) {
      return errResult('Seat not found or reconnect token does not match.', 'FORBIDDEN', 403);
    }
    if (!seat.isHost) {
      return errResult('Only the host can mint a host token.', 'FORBIDDEN', 403);
    }
    // v31 FIX ROUND (F3, hello-path audit) — a seat that left must not
    // mint. A sole host who leaves with no successor keeps `isHost`
    // (leaveSeat deletes the token but not the flag), so without this
    // the check above passes and a fresh token is minted for a left
    // seat. The token would be dead on arrival (`verifyHost` refuses
    // `leftAt` seats), so this is hardening, not a live hole — but a
    // left seat minting fresh credentials is the same resurrection
    // class F3 closes, and no legitimate flow mints while `leftAt`
    // is set (a restore clears `leftAt` first, in `addPlayerAsync`).
    if (seat.leftAt !== null) {
      return errResult('That seat has left the room.', 'FORBIDDEN', 403);
    }
    // v33 fix round (Zara final review, REQUIRED) — an ejected host
    // must not mint a fresh host token while the match is live
    // (credential issuance to an out seat). Live-phase only,
    // deliberately, like `verifyHost` above: in a terminal phase the
    // same host must still be able to mint so it can `replayMatch`
    // the finished room — ejection never transfers host, so a
    // blanket gate would strand the room unreplayable.
    if (this.ejectedWhileLive(seat)) {
      return errResult('That seat has been ejected from the game.', 'FORBIDDEN', 403);
    }
    const raw = randomHex(16);
    this.state.hostTokens[input.playerId] = await hashHostToken(raw);
    return okResult({ hostToken: raw });
  }

  transferHost(input: {
    playerId: string;
    hostTokenHash: string | null;
    newHostPlayerId: string;
    nowMs: number;
  }): OpResult<{ previousHostPlayerId: string; newHostPlayerId: string }> {
    const host = this.verifyHost(input.playerId, input.hostTokenHash);
    if (!host) {
      return errResult('Only the host can transfer hosting.', 'FORBIDDEN', 403);
    }
    const next = this.player(input.newHostPlayerId);
    if (!next || next.leftAt !== null) {
      return errResult('The new host must be a player still in the room.', 'CONFLICT', 409);
    }
    if (next.playerId === host.playerId) {
      return errResult('That player is already the host.', 'CONFLICT', 409);
    }
    delete this.state.hostTokens[host.playerId];
    // v24 fix round (Finding 5) — a manual transfer ends any running
    // grace for the old host, like `leaveSeat` / `completeMatch` /
    // replay already do. Inert as written: a grace only ever runs
    // while its host is suspended, and a suspended host's client is
    // gone — but a stale deadline must never survive a host change.
    this.cancelHostGrace();
    host.isHost = false;
    next.isHost = true;
    this.state.room.hostPlayerId = next.playerId;
    this.bumpVersion();
    // v29 (R5) — ONE event, not two (see `transferHostToSeat`): the
    // client re-fetches on `host.transferred`; the `room.state` only
    // bought a second identical snapshot request per client.
    const events = [
      this.emit(
        'host.transferred',
        { previousHostPlayerId: host.playerId, newHostPlayerId: next.playerId },
        this.allPlayerIds(),
        input.nowMs,
      ),
    ];
    const persist: PersistIntent[] = [
      { kind: 'room-upsert', room: this.room },
      { kind: 'player-upsert', roomId: this.room.roomId, player: host },
      { kind: 'player-upsert', roomId: this.room.roomId, player: next },
    ];
    return okResult(
      { previousHostPlayerId: host.playerId, newHostPlayerId: next.playerId },
      events,
      persist,
    );
  }

  // -- start / config / remove / regenerate ---------------------------------

  /** Start gate: host only, LOBBY only, >= MIN_PLAYERS, every active seat ready. */
  startMatch(input: { playerId: string; hostTokenHash: string | null; nowMs: number }): OpResult<{
    phase: MatchPhase;
    startedAt: string;
    endsAt: string;
  }> {
    const nowMs = input.nowMs;
    const host = this.verifyHost(input.playerId, input.hostTokenHash);
    if (!host) {
      return errResult('Only the host can start the match.', 'FORBIDDEN', 403);
    }
    if (this.room.phase !== 'LOBBY') {
      return errResult(`Cannot start from phase ${this.room.phase}.`, 'INVALID_STATE', 409);
    }
    const active = this.activePlayers();
    if (active.length < MIN_PLAYERS) {
      return errResult(
        `Need at least ${MIN_PLAYERS} players to start — ${active.length} in the room.`,
        'CONFLICT',
        409,
      );
    }
    const notReady = active.filter((p) => !p.isReady);
    if (notReady.length > 0) {
      return errResult(
        `Waiting for ${notReady.map((p) => p.displayName).join(', ')} to tap "I'm ready".`,
        'CONFLICT',
        409,
      );
    }
    // Zone gate (unchanged): the zone must be placed (a boundary of
    // ≥ 3 points) before the match can start.
    // v18: NO GPS start gate. The old P1-7 check (every active player
    // needs a fix ≤ 120 s old) is REMOVED — the match starts even if a
    // player's GPS has not reported yet. The backstop is the missing-fix
    // ejection in `alarmTick` step (4a): no fix at all for 30 s during a
    // live phase ejects that player.
    const config = this.room.config;
    if (!config.zone || config.zone.boundary.length < 3) {
      return errResult(
        'Set the play zone first — the zone needs at least 3 points on the map.',
        'CONFLICT',
        409,
      );
    }
    // v18 fix round (B2): snapshot the ORIGINAL configured boundary
    // before play can shrink it. Shrinks mutate `config.zone.boundary`
    // in place, so without this the replayed game would start on the
    // already-shrunk zone. Deep-copied point by point (a spread of the
    // array alone would still share the point objects with the live
    // boundary). Re-snapshotted on every start, so a host-edited zone
    // in the lobby is what the next match plays on.
    this.state.originalZoneBoundary = config.zone.boundary.map((p) => ({ ...p }));
    const draw = assignRoles(active, {
      balanceHunters: config.balanceHunters ?? true,
      randomDraw: config.randomDraw ?? true,
      teamAssignment: config.teamAssignment,
      hostHunterCount: config.hunterCount,
      selectedHunterIds: config.selectedHunterIds,
      pickHunterCount: config.hunterCount,
    });
    if (!draw.ok) {
      return errResult(draw.reason, 'CONFLICT', 409);
    }
    for (const p of active) {
      const a = draw.assignments[p.playerId];
      if (a) {
        p.matchRole = a.matchRole;
        p.team = a.team;
      }
    }
    this.room.config.hunterCount = draw.hunterCount;
    const startedAt = new Date(nowMs).toISOString();
    const endsAt = new Date(nowMs + config.durationSeconds * 1000).toISOString();
    this.room.startedAt = startedAt;
    this.room.endsAt = endsAt;
    try {
      this.room.phase = transitionOrThrow(this.room.phase, 'READY_CHECK');
      this.room.phase = transitionOrThrow(this.room.phase, 'COUNTDOWN');
      this.room.phase = transitionOrThrow(this.room.phase, 'HEAD_START');
    } catch {
      return errResult('Cannot start from this phase.', 'INVALID_STATE', 409);
    }
    this.bumpVersion();
    // v29 (30 s rule) — seats not present at start get 30 s to come
    // back onto the page and reconnect (deadline = startMs + 30 s).
    // "Not present" is the store-visible proxy: connectionState
    // 'suspended' (tab-hidden, screen-locked, or actually gone). A
    // seat whose socket is alive but tab-hidden gets the window too —
    // it is not on the page — and resuming inside it clears it.
    // The alarm ejects seats still absent at the deadline.
    for (const p of active) {
      if (p.connectionState === 'suspended') {
        this.setDisconnectDeadline(p.playerId, nowMs);
      }
    }
    const persist: PersistIntent[] = [{ kind: 'room-upsert', room: this.room }];
    for (const p of active) {
      persist.push({ kind: 'player-upsert', roomId: this.room.roomId, player: p });
    }
    persist.push(
      this.logGameEvent('MATCH_STARTED', host.playerId, { startedAt, endsAt }, nowMs),
    );
    const events = [
      this.emit('match.started', { result: null }, this.allPlayerIds(), nowMs),
      this.roomStateEvent('match-started', nowMs),
    ];
    return okResult({ phase: this.room.phase, startedAt, endsAt }, events, persist);
  }

  updateConfig(input: {
    playerId: string;
    hostTokenHash: string | null;
    config: unknown;
    nowMs: number;
  }): OpResult<{ room: Room }> {
    const host = this.verifyHost(input.playerId, input.hostTokenHash);
    if (!host) {
      return errResult('Only the host can change settings.', 'FORBIDDEN', 403);
    }
    if (this.room.phase !== 'LOBBY') {
      return errResult('Settings can only change in the lobby.', 'INVALID_STATE', 409);
    }
    const issues = validateRoomConfig(input.config);
    if (issues.length > 0) {
      return { ok: false, error: issues.join(' '), code: 'VALIDATION_FAILED', status: 400 };
    }
    const next = input.config as RoomConfig;
    // NOTE: no clearing of `selectedHunterIds` here. An earlier version
    // wiped the pick whenever hunterCount or teamAssignment changed — but
    // the incoming config already carries the pick the host just made
    // against the NEW values (the lobby's normaliseConfig trims it
    // on every edit), so wiping it made 'selected' unstartable: the host
    // picked 1 Hunter (the effective count), the DO stored 0, and start
    // failed with "Pick exactly 1 Hunter." A stale pick cannot survive
    // a UI-driven change (normaliseConfig trims it first); an API-driven
    // stale pick is caught at start by assignRoles, in plain words.
    this.room.config = next;
    this.bumpVersion();
    const events = [this.roomStateEvent('config-updated', input.nowMs)];
    return okResult(
      { room: this.room },
      events,
      [{ kind: 'room-upsert', room: this.room }],
    );
  }

  removePlayer(input: {
    playerId: string;
    hostTokenHash: string | null;
    targetPlayerId: string;
    nowMs: number;
  }): OpResult<{ removedPlayerId: string }> {
    const host = this.verifyHost(input.playerId, input.hostTokenHash);
    if (!host) {
      return errResult('Only the host can remove a player.', 'FORBIDDEN', 403);
    }
    if (this.room.phase !== 'LOBBY') {
      return errResult('Players can only be removed in the lobby.', 'INVALID_STATE', 409);
    }
    const target = this.player(input.targetPlayerId);
    if (!target || target.leftAt !== null) {
      return errResult('That player is not in the room.', 'CONFLICT', 409);
    }
    if (target.playerId === host.playerId) {
      return errResult('The host cannot remove themself.', 'CONFLICT', 409);
    }
    target.leftAt = new Date(input.nowMs).toISOString();
    target.connectionState = 'disconnected';
    this.bumpVersion();
    const events = [
      ...this.emitPlayerEvent('player.removed', target, input.nowMs),
      this.roomStateEvent('player-removed', input.nowMs),
    ];
    return okResult(
      { removedPlayerId: target.playerId },
      events,
      [{ kind: 'player-upsert', roomId: this.room.roomId, player: target }],
      [{ playerId: target.playerId, code: 4403, reason: 'Removed from the room by the host.' }],
    );
  }

  regenerateCode(input: {
    playerId: string;
    hostTokenHash: string | null;
    newCode: string;
    nowMs: number;
  }): OpResult<{ roomCode: string; oldRoomCode: string }> {
    const host = this.verifyHost(input.playerId, input.hostTokenHash);
    if (!host) {
      return errResult('Only the host can regenerate the room code.', 'FORBIDDEN', 403);
    }
    if (!isValidRoomCode(input.newCode)) {
      return errResult('The new room code is not valid.', 'VALIDATION_FAILED', 400);
    }
    const oldRoomCode = this.room.roomCode;
    this.room.roomCode = input.newCode;
    this.bumpVersion();
    const events = [this.roomStateEvent('code-regenerated', input.nowMs)];
    return okResult(
      { roomCode: input.newCode, oldRoomCode },
      events,
      [{ kind: 'room-upsert', room: this.room }],
    );
  }

  // -- WS tickets (DO-owned registry) ----------------------------------------

  /**
   * Register a ticket hash minted by the Worker. Issuing a new ticket
   * revokes any other unredeemed ticket for the same seat. The ticket VALUE
   * never arrives here — only its hash.
   *
   * DO-ENFORCED ISSUE LIMIT: the per-seat ticket-issue window from the
   * shared HTTP rate-limit table (10/min/seat) is enforced HERE, in the
   * room's DO — not only in the Worker, whose limiter is in-memory per
   * isolate and can be bypassed by a burst landing on different isolates.
   * Every ticket issue goes through this one op on the single DO instance
   * per room, so the window is shared across isolates by construction.
   */
  registerTicket(input: {
    playerId: string;
    reconnectTokenHash: string | null;
    ticketId: string;
    ticketHash: string;
    purpose: 'connect' | 'renew';
    expiresAtMs: number;
    nowMs: number;
  }): OpResult<{ ticketId: string; expiresAtMs: number; registered: number }> {
    // v23 fix round 1 (S4): no ticket minting on a deleted room.
    if (this.isDeleted()) {
      return errResult('This room has been deleted.', 'ROOM_NOT_FOUND', 404);
    }
    const seat = this.verifyReconnect(input.playerId, input.reconnectTokenHash);
    if (!seat) {
      return errResult('Seat not found or reconnect token does not match.', 'FORBIDDEN', 403);
    }
    if (seat.leftAt !== null) {
      return errResult('That seat has left the room.', 'CONFLICT', 409);
    }
    // v33 (F2c): an ejected seat mints no fresh sockets — its
    // reconnect token stays valid for `get-results` only. No phase
    // gate here: a ticket is a live-socket credential, and an ejected
    // seat has no live-socket business in any phase until
    // `replayMatch` clears the ejection.
    if (seat.ejectedAt !== null) {
      return errResult('That seat has been ejected from the game.', 'FORBIDDEN', 403);
    }
    const issueCheck = this.checkTicketIssueRateLimit(input.playerId, input.nowMs);
    if (!issueCheck.allowed) {
      return errResult(
        'Too many tries — slow down.',
        'RATE_LIMITED',
        429,
        [],
        [],
        issueCheck.retryAfterSeconds,
      );
    }
    // P1-4 (two tabs): a seat may hold several unredeemed tickets at once
    // — one per tab. Registering a ticket for tab A must NOT revoke tab
    // B's unredeemed ticket. Tickets stay single-use (redeem marks them),
    // and the per-seat issue rate limit above is the abuse control.
    this.mem.tickets.push({
      ticketId: input.ticketId,
      playerId: input.playerId,
      ticketHash: input.ticketHash,
      purpose: input.purpose,
      expiresAtMs: input.expiresAtMs,
      redeemed: false,
      createdAtMs: input.nowMs,
    });
    const live = this.mem.tickets.filter((t) => t.playerId === input.playerId).length;
    return okResult({ ticketId: input.ticketId, expiresAtMs: input.expiresAtMs, registered: live });
  }

  revokeTickets(input: {
    playerId: string;
    reconnectTokenHash: string | null;
    nowMs?: number;
  }): OpResult<{ revoked: number }> {
    const seat = this.verifyReconnect(input.playerId, input.reconnectTokenHash);
    if (!seat) {
      return errResult('Seat not found or reconnect token does not match.', 'FORBIDDEN', 403);
    }
    // v31 FIX ROUND (Zara (c)) — DO-side revoke rate limit. The class
    // saves unconditionally after a successful revoke, so an unlimited
    // revoke stream is write amplification (one `save()` per call);
    // the Worker's HTTP limiter for this route is per-isolate
    // in-memory and can be spread across isolates. Same table entry
    // (10/min/seat) and same sliding-window shape as
    // `checkTicketIssueRateLimit`; a 429 returns BEFORE mutating, so
    // it also costs no save (the class error path never saves).
    const nowMs = input.nowMs ?? Date.now();
    const revokeCheck = this.checkTicketRevokeRateLimit(input.playerId, nowMs);
    if (!revokeCheck.allowed) {
      return errResult(
        'Too many tries — slow down.',
        'RATE_LIMITED',
        429,
        [],
        [],
        revokeCheck.retryAfterSeconds,
      );
    }
    const before = this.mem.tickets.length;
    this.mem.tickets = this.mem.tickets.filter((t) => t.playerId !== input.playerId);
    return okResult({ revoked: before - this.mem.tickets.length });
  }

  /**
   * Upgrade validation — atomic redeem. A 'renew' ticket can never open a
   * socket. Returns the seat on success; distinct errors for invalid /
   * reused / expired (all surface as WS close 4401 with distinct wording).
   */
  redeemTicketForConnect(
    ticketHash: string,
    nowMs: number,
  ): OpResult<{ playerId: string; ticketId: string; expiresAtMs: number }> {
    // v23 fix round 1 (S4): no socket upgrade on a deleted room — a
    // ticket minted before the delete must not open a socket after it.
    if (this.isDeleted()) {
      return errResult('This room has been deleted.', 'ROOM_NOT_FOUND', 404);
    }
    const rec = this.mem.tickets.find((t) => t.ticketHash === ticketHash);
    if (!rec) {
      return errResult('Ticket invalid — fetch a fresh ticket and reconnect once.', 'TICKET_INVALID', 4401);
    }
    if (rec.redeemed) {
      return errResult('Ticket already used — fetch a fresh ticket and reconnect once.', 'TICKET_REUSED', 4401);
    }
    if (nowMs > rec.expiresAtMs) {
      return errResult('Ticket expired — fetch a fresh ticket and reconnect once.', 'TICKET_EXPIRED', 4401);
    }
    if (rec.purpose !== 'connect') {
      return errResult('A renewal ticket cannot open a socket — fetch a connect ticket.', 'TICKET_INVALID', 4401);
    }
    const seat = this.player(rec.playerId);
    if (!seat || seat.leftAt !== null || seat.ejectedAt !== null) {
      return errResult('That seat is no longer in the room.', 'FORBIDDEN', 4403);
    }
    rec.redeemed = true;
    return okResult({ playerId: rec.playerId, ticketId: rec.ticketId, expiresAtMs: rec.expiresAtMs });
  }

  /** Renewal validation for `auth.refresh` (existing socket, renew ticket). */
  redeemTicketForRenew(
    ticketHash: string,
    playerId: string,
    nowMs: number,
  ): OpResult<{ ticketId: string; expiresAtMs: number }> {
    const rec = this.mem.tickets.find((t) => t.ticketHash === ticketHash);
    if (!rec || rec.playerId !== playerId) {
      return errResult('Ticket invalid.', 'TICKET_INVALID', 4401);
    }
    if (rec.redeemed) {
      return errResult('Ticket already used.', 'TICKET_REUSED', 4401);
    }
    if (nowMs > rec.expiresAtMs) {
      return errResult('Ticket expired.', 'TICKET_EXPIRED', 4401);
    }
    if (rec.purpose !== 'renew') {
      return errResult('Only a renewal ticket can refresh a socket.', 'TICKET_INVALID', 4401);
    }
    // v33 (F2c): an ejected seat renews no socket (its socket was
    // closed at ejection; a second tab's renewal dies the same way).
    // This also closes the adjacent hole the old code had for LEFT
    // seats, which were never looked up here at all.
    const seat = this.player(playerId);
    if (!seat || seat.leftAt !== null || seat.ejectedAt !== null) {
      return errResult('That seat is no longer in the room.', 'FORBIDDEN', 4403);
    }
    rec.redeemed = true;
    return okResult({ ticketId: rec.ticketId, expiresAtMs: rec.expiresAtMs });
  }

  // -- catches ---------------------------------------------------------------

  /** Lazily expire overdue pending catches; returns their events + intents. */
  private expireOverdueCatches(nowMs: number): { events: OutboundEvent[]; persist: PersistIntent[] } {
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
    for (const c of this.state.catches) {
      if (isPendingCatch(c) && isCatchExpired(c, nowMs, CATCH_TOKEN_TTL_SECONDS)) {
        const expired = expireCatchIfOverdue(c, nowMs, CATCH_TOKEN_TTL_SECONDS);
        Object.assign(c, expired);
        this.mem.rawCatchTokens.delete(c.catchId);
        events.push(
          this.emit('catch.expired', { catch: toCatchView(c) }, this.catchRecipients(c), nowMs),
        );
        persist.push({ kind: 'catch-update', catch: c });
      }
    }
    return { events, persist };
  }

  /** Apply a confirmed tag (mode rule) + win check. Shared by confirm/resolve. */
  private applyConfirmedTagAndWinCheck(
    c: CatchEvent,
    nowMs: number,
  ): { events: OutboundEvent[]; persist: PersistIntent[] } {
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
    const runner = this.player(c.runnerPlayerId);
    if (runner) {
      const tag = applyConfirmedTag(this.room.config.mode);
      runner.matchRole = tag.newRole;
      runner.team = tag.newRole === 'hunter' ? 'hunters' : 'runners';
      persist.push({ kind: 'player-upsert', roomId: this.room.roomId, player: runner });
    }
    persist.push(
      this.logGameEvent('PLAYER_TAGGED', c.hunterPlayerId, { catchId: c.catchId, hunterPlayerId: c.hunterPlayerId, runnerPlayerId: c.runnerPlayerId }, nowMs),
    );
    const durationSeconds =
      this.room.startedAt === null
        ? 0
        : Math.max(0, Math.floor((nowMs - Date.parse(this.room.startedAt)) / 1000));
    const win = maybeCompleteOnWin({
      mode: this.room.config.mode,
      players: this.state.players,
      caughtRunnerIds: this.caughtRunnerIds(),
      durationSeconds,
      tags: confirmedTags(this.state.catches),
    });
    if (win) {
      // The confirm/resolve caller pre-validated the transition (P1-2),
      // so `ok: false` here is unreachable in practice; an illegal edge
      // is never swallowed as an empty success.
      const done = this.completeMatch(win, nowMs);
      if (done.ok) {
        events.push(...done.events);
        persist.push(...done.persist);
      }
    }
    return { events, persist };
  }

  /**
   * Eject one seat + run the win check. Shared by the tick-side
   * ejections (missing-fix step (4a), outside-zone step (4)). Returns
   * true when the ejection completed the match — the caller must return
   * its tick immediately. `applyOutsideZoneEjection` is idempotent and
   * stamps `ejectedAt` once; the seat's outside-zone countdown is
   * dropped with it.
   */
  private ejectWithWinCheck(
    p: Player,
    nowMs: number,
    startedAtMs: number,
    events: OutboundEvent[],
    persist: PersistIntent[],
    disconnect: Array<{ playerId: string; code: number; reason: string }>,
  ): boolean {
    const ejected = applyOutsideZoneEjection(p, nowMs);
    Object.assign(p, ejected);
    delete this.mem.outsideZone[p.playerId];
    this.bumpVersion();
    events.push(this.roomStateEvent('player-ejected', nowMs));
    persist.push({ kind: 'player-upsert', roomId: this.room.roomId, player: p });
    // v33 (F2b): the ejection closes the seat's socket(s) — 4405
    // (ejected), never 4403. The caller delivers `events` first and
    // closes after, so the seat still receives its `player-ejected`
    // notice before the close lands.
    disconnect.push({
      playerId: p.playerId,
      code: EJECTED_CLOSE_CODE,
      reason: EJECTED_CLOSE_REASON,
    });
    const durationSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
    const win = maybeCompleteOnWin({
      mode: this.room.config.mode,
      players: this.state.players,
      caughtRunnerIds: this.caughtRunnerIds(),
      durationSeconds,
      tags: confirmedTags(this.state.catches),
    });
    if (!win) {
      // v33 (F2b, snapshot-before-close): the seat learns `ejectedAt`
      // only from a snapshot — push one now, while its socket is still
      // open. Pushed after the win check so it carries the final phase.
      events.push(
        this.emit(
          'snapshot',
          this.snapshotFor(p.playerId, nowMs) as unknown as Record<string, unknown>,
          [p.playerId],
          nowMs,
        ),
      );
      return false;
    }
    const done = this.completeMatch(win, nowMs);
    events.push(...done.events);
    persist.push(...done.persist);
    // v33 (F2b, snapshot-before-close): as above, after the match
    // completed, so the snapshot carries the terminal phase + result.
    events.push(
      this.emit(
        'snapshot',
        this.snapshotFor(p.playerId, nowMs) as unknown as Record<string, unknown>,
        [p.playerId],
        nowMs,
      ),
    );
    return true;
  }

  /** Runner fetches the raw one-time catch token for their QR (HTTP route). */
  async getCatchToken(input: {
    playerId: string;
    reconnectTokenHash: string | null;
    catchId: string;
    nowMs: number;
  }): Promise<OpResult<{ token: string; catchId: string; expiresAt: string }>> {
    const seat = this.verifyReconnect(input.playerId, input.reconnectTokenHash);
    if (!seat) {
      return errResult('Seat not found or reconnect token does not match.', 'FORBIDDEN', 403);
    }
    const c = this.state.catches.find((x) => x.catchId === input.catchId);
    if (!c) {
      return errResult('No catch with that id in this room.', 'NOT_FOUND', 404);
    }
    if (c.runnerPlayerId !== input.playerId) {
      return errResult('Only the Runner in this catch can fetch its token.', 'FORBIDDEN', 403);
    }
    // The sweep is a real side effect: an overdue catch expiring here must
    // still broadcast catch.expired + persist the catch-update, even when
    // this fetch itself fails because the catch is no longer pending.
    const sweep = this.expireOverdueCatches(input.nowMs);
    if (!isPendingCatch(c)) {
      return errResult(
        'That catch is no longer pending.',
        'CONFLICT',
        409,
        sweep.events,
        sweep.persist,
      );
    }
    const expiresAt = new Date(
      Date.parse(c.requestedAt) + CATCH_TOKEN_TTL_SECONDS * 1000,
    ).toISOString();
    const held = this.mem.rawCatchTokens.get(c.catchId);
    if (held && input.nowMs < held.expiresAtMs) {
      // Phase 3 #10 (cheap re-fetch): a valid token already exists, so
      // return it WITHOUT rotating — no new hash, no catch-update, no
      // full afterMutation save. Rotation on every re-fetch made each QR
      // refresh a full-cost mutation. Trade-off, stated plainly: a QR
      // photographed before this re-fetch stays valid until the 120 s
      // TTL expires (the old P2 rotation killed it at once); the token
      // is still single-use + TTL-bound and QR-only.
      return okResult(
        { token: held.token, catchId: c.catchId, expiresAt },
        sweep.events,
        sweep.persist,
      );
    }
    // Raw token lost (e.g. DO hibernated — raw tokens are memory-only):
    // mint a fresh one for the same pending catch, BUT keep the previous
    // hash valid until it expires or is confirmed (P1-5) — the QR already
    // displayed on the runner's screen must keep working. The previous
    // hash is stored on the catch (durable) and accepted at confirm time.
    // (Only when the token was LOST, not when it expired: an expired
    // token is dead by TTL and is not preserved.)
    const { token, tokenHash } = await issueCatchToken(c.catchId);
    const prev = c.qrTokenHash;
    c.qrTokenHash = tokenHash;
    if (prev !== null && !held) {
      c.previousQrTokenHash = prev;
    }
    this.mem.rawCatchTokens.set(c.catchId, {
      token,
      expiresAtMs: Date.parse(expiresAt),
    });
    return okResult(
      { token, catchId: c.catchId, expiresAt },
      sweep.events,
      [...sweep.persist, { kind: 'catch-update', catch: c }],
    );
  }

  /**
   * v18 follow-up — Runner mints a claim-less QR token (`catch.runner-token`,
   * WS, Runner only).
   *
   * The Runner taps "Got Tagged" with NO claim open and shows the QR at
   * once. The token is tied to the RUNNER (their playerId), not to a
   * claim: 128-bit, 120 s TTL, hash-only storage, single-use, QR-only
   * carriage — the same token rules as a claim token, with the hash
   * domain sha256('runner:' + runnerId + ':' + raw).
   *
   * Rules:
   * - ACTIVE only; the sender must be a free, present, non-suspended
   *   Runner (an already-caught Runner, a disputed catch with the host,
   *   or a Hunter sender all reject). A suspended/disconnected Runner
   *   cannot mint — reconnect first.
   * - One live token per Runner: a re-mint REPLACES the previous record
   *   at once, so the old QR dies immediately. The server never stores
   *   the raw value, so it cannot re-issue the same token — a re-mint is
   *   always a fresh token with a fresh 120 s TTL. An expired token is
   *   likewise replaced, never revived.
   * - Minting with an open claim is CONFLICT — the Runner shows that
   *   claim's QR instead (HTTP /catch-token, unchanged). The record is
   *   durable (hash only): it survives DO hibernation, unlike the raw
   *   claim tokens in memory.
   * - The mint mutates durable state but has no Supabase row: the WS
   *   case marks the message durable via `stateDirty` (see
   *   `handleWsMessage`), so the DO class still `save()`s the state.
   *   NO catch code, NO dispute button. The physical-tag gate does NOT
   *   apply at mint time (no Hunter is involved yet) — it applies when
   *   the scan creates the claim (`requestCatch`) and again at
   *   `catch.confirm`.
   */
  async mintRunnerQrToken(input: {
    playerId: string;
    nowMs: number;
  }): Promise<OpResult<{ token: string; runnerId: string; expiresAt: string }>> {
    const nowMs = input.nowMs;
    const me = this.player(input.playerId);
    if (!me || me.leftAt !== null) {
      return errResult('Seat not found in this room.', 'FORBIDDEN', 403);
    }
    if (me.matchRole !== 'runner') {
      return errResult('Only a Runner can show a catch QR.', 'FORBIDDEN', 403);
    }
    if (this.room.phase !== 'ACTIVE') {
      return errResult('Catches can only be made while the match is live.', 'INVALID_STATE', 409);
    }
    // Expire overdue claims first (same lazy sweep as catch.request):
    // a claim that just expired must not block a fresh mint.
    const sweep = this.expireOverdueCatches(nowMs);
    const events: OutboundEvent[] = [...sweep.events];
    const persist: PersistIntent[] = [...sweep.persist];
    // A disputed catch for this Runner is with the host — it can neither
    // be re-minted around nor re-claimed until the host resolves it.
    if (
      this.state.catches.some(
        (c) => c.runnerPlayerId === me.playerId && c.state === 'disputed',
      )
    ) {
      return errResult(
        'That catch is with the host — wait for the host to resolve it.',
        'CONFLICT',
        409,
        events,
        persist,
      );
    }
    if (openCatchForRunner(this.state.catches, me.playerId) !== null) {
      return errResult(
        'A Hunter has already claimed you — show the QR for that claim.',
        'CONFLICT',
        409,
        events,
        persist,
      );
    }
    if (this.caughtRunnerIds().includes(me.playerId)) {
      return errResult('You have already been caught.', 'CONFLICT', 409, events, persist);
    }
    if (!isCatchableRunner(me, this.caughtRunnerIds())) {
      return errResult(
        'You cannot be caught right now — reconnect first, then try again.',
        'CONFLICT',
        409,
        events,
        persist,
      );
    }
    // Re-mint replaces: drop this Runner's previous record (live or
    // expired — an expired record is dead by TTL and is never revived),
    // then store the fresh hash-only record. The raw token goes to the
    // Runner once, in the direct reply — it is never stored.
    this.state.runnerQrTokens = this.state.runnerQrTokens.filter(
      (r) => r.runnerPlayerId !== me.playerId,
    );
    const { token, record } = await issueRunnerQrToken(me.playerId, nowMs);
    this.state.runnerQrTokens.push(record);
    return okResult(
      {
        token,
        runnerId: me.playerId,
        expiresAt: new Date(record.expiresAtMs).toISOString(),
      },
      events,
      persist,
    );
  }

  /** Host resolves a disputed catch (confirmed / rejected). Decision is final. */
  resolveCatchOp(input: {
    playerId: string;
    hostTokenHash: string | null;
    catchId: string;
    decision: 'confirmed' | 'rejected';
    reason?: string;
    nowMs: number;
  }): OpResult<{ catch: CatchView }> {
    const host = this.verifyHost(input.playerId, input.hostTokenHash);
    if (!host) {
      return errResult('Only the host can resolve a disputed catch.', 'FORBIDDEN', 403);
    }
    const c = this.state.catches.find((x) => x.catchId === input.catchId);
    if (!c) {
      return errResult('No catch with that id in this room.', 'NOT_FOUND', 404);
    }
    const decided = resolveCatch({
      catchEvent: c,
      resolverIsHost: true,
      decision: input.decision,
      nowMs: input.nowMs,
    });
    if (!decided.ok) {
      const status = decided.code === 'FORBIDDEN' ? 403 : 409;
      return errResult(decided.reason, decided.code, status);
    }
    // P1-2: validate the completion transition BEFORE mutating the catch
    // — a 'confirmed' resolution that would complete the match from a
    // phase that cannot complete is rejected with the catch untouched.
    if (
      input.decision === 'confirmed' &&
      this.wouldCompleteOnConfirm(c, decided.value, input.nowMs) &&
      !this.canCompleteMatch()
    ) {
      return errResult(
        'The match cannot complete from its current phase — the catch stays disputed.',
        'INVALID_STATE',
        409,
      );
    }
    Object.assign(c, decided.value);
    this.mem.rawCatchTokens.delete(c.catchId);
    const events: OutboundEvent[] = [
      this.emit(
        input.decision === 'confirmed' ? 'catch.confirmed' : 'catch.rejected',
        { catch: toCatchView(c) },
        this.catchRecipients(c),
        input.nowMs,
      ),
    ];
    const persist: PersistIntent[] = [{ kind: 'catch-update', catch: c }];
    if (input.decision === 'confirmed') {
      const applied = this.applyConfirmedTagAndWinCheck(c, input.nowMs);
      events.push(...applied.events);
      persist.push(...applied.persist);
    }
    events.push(this.roomStateEvent('catch-resolved', input.nowMs));
    return okResult({ catch: toCatchView(c) }, events, persist);
  }

  /**
   * v18 runner Self Confirm — `catch.self-confirm` (WS, Runner only).
   *
   * The Runner picks the Hunter who tagged them (`hunterId`) and taps OK;
   * the tag completes with NO confirmation needed from the Hunter. The
   * server creates the claim if none is open for that Hunter + Runner,
   * then confirms it in the same op — one atomic tag, no token, no QR.
   *
   * Rules (same as every other confirm — nothing is relaxed):
   * - ACTIVE only; the sender must be a free, present Runner, the named
   *   seat a Hunter still in play. An already-caught Runner, a disputed
   *   catch (with the host), or an open claim by a DIFFERENT Hunter all
   *   reject — the Runner must name the Hunter who actually claimed them.
   * - PHYSICAL tag (P1-11): both phones need a recent fix within
   *   CATCH_MAX_DISTANCE_METERS (100 m), enforced by `requestCatch` (on
   *   claim creation) and `confirmCatch`. A self-confirm from another
   *   city does not complete the tag.
   * - NO catch code, NO dispute button. The 128-bit / 120 s / hash-only /
   *   single-use / QR-only token rules are untouched — this path simply
   *   does not use a token at all (manual Runner confirm, like the
   *   existing `catch.confirm` manual fallback, but claim-creating).
   * - The QR-scan way is unchanged: Hunter scans the Runner's QR, then
   *   taps Tag via `catch.request` + `catch.confirm` with the token.
   *
   * A failed self-confirm rolls back a claim it just created, so no
   * dangling pending claim is left behind. Persist: one `catch-insert`
   * (it writes the full catch state, incl. confirmed) when the claim was
   * created here, else `catch-update`.
   */
  selfConfirmCatch(input: {
    playerId: string;
    hunterId: string;
    nowMs: number;
  }): OpResult<{ catch: CatchView }> {
    const nowMs = input.nowMs;
    const me = this.player(input.playerId);
    if (!me || me.leftAt !== null) {
      return errResult('Seat not found in this room.', 'FORBIDDEN', 403);
    }
    if (me.matchRole !== 'runner') {
      return errResult('Only a Runner can self-confirm a tag.', 'FORBIDDEN', 403);
    }
    const hunter = this.player(input.hunterId);
    if (!hunter) {
      return errResult('That Hunter is not in the room.', 'VALIDATION_FAILED', 400);
    }
    if (hunter.matchRole !== 'hunter') {
      return errResult('That player is not a Hunter.', 'FORBIDDEN', 403);
    }
    if (hunter.ejectedAt !== null || hunter.leftAt !== null) {
      return errResult('That Hunter is no longer in play.', 'CONFLICT', 409);
    }
    // Expire overdue claims first (same lazy sweep as catch.request).
    const sweep = this.expireOverdueCatches(nowMs);
    const events: OutboundEvent[] = [...sweep.events];
    const persist: PersistIntent[] = [...sweep.persist];
    // A disputed catch for this Runner is with the host — it can neither
    // be self-confirmed nor re-claimed until the host resolves it.
    if (
      this.state.catches.some(
        (c) => c.runnerPlayerId === me.playerId && c.state === 'disputed',
      )
    ) {
      return errResult(
        'That catch is with the host — wait for the host to resolve it.',
        'CONFLICT',
        409,
        events,
        persist,
      );
    }
    const open = openCatchForRunner(this.state.catches, me.playerId);
    if (open && open.hunterPlayerId !== hunter.playerId) {
      return errResult(
        'Another Hunter has already claimed this Runner.',
        'CONFLICT',
        409,
        events,
        persist,
      );
    }
    let c = open;
    let createdHere = false;
    if (!c) {
      const req = requestCatch({
        catches: this.state.catches,
        hunter,
        runner: me,
        caughtRunnerIds: this.caughtRunnerIds(),
        phase: this.room.phase,
        catchId: newId(),
        roomId: this.room.roomId,
        nowMs,
        hunterFix: this.mem.latestFix[hunter.playerId] ?? null,
        runnerFix: this.mem.latestFix[me.playerId] ?? null,
        // P1-11: physical tag — the engine enforces proximity on these.
        positions: {
          hunter: this.mem.latestFix[hunter.playerId] ?? null,
          runner: this.mem.latestFix[me.playerId] ?? null,
        },
        maxDistanceMeters: CATCH_MAX_DISTANCE_METERS,
      });
      if (!req.ok) {
        const status = req.code === 'FORBIDDEN' ? 403 : 409;
        return errResult(req.reason, req.code, status, events, persist);
      }
      c = req.value;
      this.state.catches.push(c);
      createdHere = true;
    }
    // v18 fix round (A2/F3): re-check the NAMED Hunter's liveness here,
    // on BOTH paths, before `confirmCatch`. The create path above goes
    // through `requestCatch`, which rejects a suspended/disconnected
    // Hunter — but when a claim is ALREADY open this op used to skip
    // `requestCatch` entirely and go straight to `confirmCatch`, which
    // never checks the Hunter's state. A Hunter suspended (tab hidden /
    // screen locked / network lost) or disconnected after claiming
    // could then be credited with a tag the Runner confirmed alone.
    // Same gate `requestCatch` applies: connectionState not suspended /
    // disconnected, ejectedAt / leftAt null. The open claim is left
    // untouched (not rolled back — it was not created here).
    if (
      hunter.connectionState === 'suspended' ||
      hunter.connectionState === 'disconnected' ||
      hunter.ejectedAt !== null ||
      hunter.leftAt !== null
    ) {
      return errResult(
        'That Hunter is suspended or no longer in play — they cannot be credited with a tag right now.',
        'CONFLICT',
        409,
        events,
        persist,
      );
    }
    // Manual Runner confirm: no token is presented or needed — the
    // Runner themself confirms the tag. The physical-tag gate below
    // (in confirmCatch) is what stops a remote self-confirm.
    const conf = confirmCatch({
      catchEvent: c,
      confirmerId: me.playerId,
      confirmerRole: me.matchRole,
      manualConfirm: true,
      tokenValid: false,
      runner: me,
      caughtRunnerIds: this.caughtRunnerIds(),
      phase: this.room.phase,
      nowMs,
      ttlSeconds: CATCH_TOKEN_TTL_SECONDS,
      positions: {
        hunter: this.mem.latestFix[c.hunterPlayerId] ?? null,
        runner: this.mem.latestFix[c.runnerPlayerId] ?? null,
      },
      maxDistanceMeters: CATCH_MAX_DISTANCE_METERS,
    });
    if (!conf.ok) {
      // Roll back a claim created by this op — a failed self-confirm
      // must not leave a dangling pending claim behind.
      if (createdHere) {
        this.state.catches = this.state.catches.filter(
          (x) => x.catchId !== (c as CatchEvent).catchId,
        );
      }
      const status = conf.code === 'FORBIDDEN' ? 403 : 409;
      return errResult(conf.reason, conf.code, status, events, persist);
    }
    // P1-2: validate the completion transition BEFORE mutating the
    // catch — if confirming would complete the match from a phase that
    // cannot complete, reject without marking it confirmed (and roll
    // back a claim created by this op).
    if (this.wouldCompleteOnConfirm(c, conf.value, nowMs) && !this.canCompleteMatch()) {
      if (createdHere) {
        this.state.catches = this.state.catches.filter((x) => x.catchId !== c.catchId);
      }
      return errResult(
        'The match cannot complete from its current phase — the catch stays pending.',
        'INVALID_STATE',
        409,
        events,
        persist,
      );
    }
    Object.assign(c, conf.value);
    this.mem.rawCatchTokens.delete(c.catchId);
    events.push(
      this.emit('catch.confirmed', { catch: toCatchView(c) }, this.catchRecipients(c), nowMs),
    );
    persist.push(
      createdHere
        ? { kind: 'catch-insert', roomId: this.room.roomId, catch: c }
        : { kind: 'catch-update', catch: c },
    );
    const applied = this.applyConfirmedTagAndWinCheck(c, nowMs);
    events.push(...applied.events);
    persist.push(...applied.persist);
    events.push(this.roomStateEvent('catch-confirmed', nowMs));
    return okResult({ catch: toCatchView(c) }, events, persist);
  }

  // -- safety / lifecycle / results ------------------------------------------

  private doSafetyPause(
    byPlayerId: string,
    reason: string | null,
    nowMs: number,
  ): OpResult<{ paused: boolean }> {
    // P0-2: pausing an already-paused match is an idempotent no-op — the
    // ORIGINAL pausedFrom/pausedAt must survive, never be re-stamped.
    // pauseMatch takes the stored pause state and returns it unchanged;
    // without it the engine rejects, so the guard below passes it in.
    const alreadyPaused = this.room.phase === 'SAFETY_PAUSED';
    const paused = pauseMatch(
      this.room.phase,
      byPlayerId,
      nowMs,
      alreadyPaused
        ? {
            pausedFrom: this.state.pausedFrom ?? 'ACTIVE',
            pausedAt: this.room.pausedAt ?? new Date(nowMs).toISOString(),
          }
        : undefined,
    );
    if (!paused.ok) {
      return errResult(paused.reason, paused.code, 409);
    }
    if (alreadyPaused) {
      // No-op success: keep the original pausedFrom/pausedAt exactly.
      return okResult({ paused: true });
    }
    this.state.paused = true;
    this.state.pausedBy = byPlayerId;
    this.state.pausedFrom = paused.pausedFrom;
    this.room.pausedAt = paused.pausedAt;
    try {
      this.room.phase = transitionOrThrow(this.room.phase, 'SAFETY_PAUSED');
    } catch {
      // pauseMatch already validated; an already-paused room is a no-op.
      if (this.room.phase !== 'SAFETY_PAUSED') {
        return errResult('Cannot pause from this phase.', 'INVALID_STATE', 409);
      }
    }
    this.bumpVersion();
    const events = [
      this.emit('safety.paused', { byPlayerId, reason }, this.allPlayerIds(), nowMs),
      this.roomStateEvent('safety-paused', nowMs),
    ];
    const persist: PersistIntent[] = [
      { kind: 'safety-event', roomId: this.room.roomId, playerId: byPlayerId, type: 'safety-pause', reason },
      { kind: 'room-upsert', room: this.room },
    ];
    return okResult({ paused: true }, events, persist);
  }

  private doSafetyResume(
    byPlayerId: string,
    nowMs: number,
  ): OpResult<{ phase: MatchPhase }> {
    const resumed = resumeMatch({
      phase: this.room.phase,
      pausedFrom: this.state.pausedFrom,
      pausedAt: this.room.pausedAt,
      startedAt: this.room.startedAt,
      endsAt: this.room.endsAt,
      nowMs,
      // v29 fix round (F4) — the 30 s return windows shift forward
      // by the paused duration alongside startedAt/endsAt: a
      // deadline that passes during a pause must not eject on the
      // first ACTIVE tick after resume — the player had zero chance
      // to return while paused.
      disconnectDeadlineMs: this.state.disconnectDeadlineMs ?? {},
    });
    if (!resumed.ok) {
      return errResult(resumed.reason, resumed.code, 409);
    }
    this.room.startedAt = resumed.startedAt;
    this.room.endsAt = resumed.endsAt;
    if (resumed.disconnectDeadlineMs !== undefined) {
      this.state.disconnectDeadlineMs = resumed.disconnectDeadlineMs;
    }
    this.room.pausedAt = null;
    this.room.phase = resumed.phase;
    this.state.paused = false;
    this.state.pausedBy = null;
    this.state.pausedFrom = null;
    this.bumpVersion();
    const events = [
      this.emit('safety.resumed', { byPlayerId, reason: null }, this.allPlayerIds(), nowMs),
      this.roomStateEvent('safety-resumed', nowMs),
    ];
    const persist: PersistIntent[] = [
      { kind: 'safety-event', roomId: this.room.roomId, playerId: byPlayerId, type: 'safety-resume', reason: null },
      { kind: 'room-upsert', room: this.room },
    ];
    return okResult({ phase: this.room.phase }, events, persist);
  }

  /**
   * Complete the match with a result (via RESOLVING; clock already stopped).
   * P1-2: the transition is validated BEFORE anything mutates — an illegal
   * edge returns `{ ok: false }` and the caller must not have mutated the
   * catch yet (the confirm/resolve paths pre-check with
   * `wouldCompleteOnConfirm` + `canCompleteMatch` first). A caller that
   * gets `ok: false` treats it as a failed op, never as an empty success.
   */
  completeMatch(
    result: MatchResult,
    nowMs: number,
  ): { ok: boolean; events: OutboundEvent[]; persist: PersistIntent[] } {
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
    if (!this.canCompleteMatch()) {
      return { ok: false, events, persist };
    }
    this.room.phase = transitionOrThrow(this.room.phase, 'RESOLVING');
    this.room.phase = transitionOrThrow(this.room.phase, 'COMPLETED');
    this.room.result = result;
    // v24: the match is over — no grace survives into a terminal room.
    this.cancelHostGrace();
    this.bumpVersion();
    // Fixes are purged at match end; raw catch tokens die with the match.
    this.mem.latestFix = {};
    this.mem.outsideZone = {};
    this.mem.rawCatchTokens.clear();
    this.state.runnerQrTokens = [];
    this.mem.pendingPings = [];
    this.mem.pendingPingRecipients.clear();
    events.push(
      this.emit('match.completed', { result }, this.allPlayerIds(), nowMs),
      this.roomStateEvent('match-completed', nowMs),
    );
    persist.push(
      this.logGameEvent('MATCH_COMPLETED', null, { result, room: { roomId: this.room.roomId, phase: this.room.phase } }, nowMs),
      { kind: 'match-result', room: this.room },
      { kind: 'room-upsert', room: this.room },
    );
    return { ok: true, events, persist };
  }

  /**
   * Host cancel (v23 Rule 1, founder decision 2026-11-21) — the ONLY
   * caller is `lifecycleOp('end')` (host-only). The store IS the
   * deleter here: phase CANCELLED, result built, `state.deleted =
   * true`, and exactly ONE event — a literal `'room.deleted'` with
   * `{ result }` to every remaining seat (including suspended ones).
   * NO `match.cancelled` from the store: the DO class, on seeing the
   * signal, translates it into the delivered stream
   * (`match.cancelled` synthesised FIRST, then `room.deleted`, then
   * the `room.state` notice with reason `'room-deleted'` LAST),
   * persists the cancel record, unregisters the invite code, closes
   * every socket and wipes the durable state. The Supabase cancel
   * record (`match-result` PATCH + `room-upsert`) is preserved — the
   * class awaits it before wiping. Every later op refuses with 404
   * ROOM_NOT_FOUND via `isDeleted()`; a second cancel refuses as
   * deleted, not "already cancelled".
   *
   * The literal `'room.deleted'` string is pinned by the v23 contract
   * (Arjun's store + DO tests, and the web client matches the raw
   * string). It is a first-class catalogue type now (v23 fix round 1,
   * S12: `'room.deleted'` in `WsServerPayloads` / `WS_SERVER_TYPES`,
   * payload `{ result }` — the `MatchCancelledPayload` shape), so no
   * cast is needed anymore.
   *
   * Natural completion (`completeMatch`) and the last-player-leaves
   * path in `leaveSeat` do NOT call this and do NOT delete: a
   * COMPLETED room still serves snapshots and replay.
   */
  cancelMatch(
    byPlayerId: string,
    nowMs: number,
  ): OpResult<{ phase: MatchPhase; result: MatchResult }> {
    if (this.isDeleted()) return this.deletedRefusal();
    const durationSeconds =
      this.room.startedAt === null
        ? 0
        : Math.max(0, Math.floor((nowMs - Date.parse(this.room.startedAt)) / 1000));
    const result: MatchResult = {
      outcome: 'cancelled',
      durationSeconds,
      caughtRunnerIds: this.caughtRunnerIds(),
      survivingRunnerIds: freeRunnerIds(this.state.players, this.caughtRunnerIds()),
      tags: confirmedTags(this.state.catches),
    };
    try {
      this.room.phase = transitionOrThrow(this.room.phase, 'CANCELLED');
    } catch {
      return errResult(`Cannot cancel from phase ${this.room.phase}.`, 'INVALID_STATE', 409);
    }
    this.room.result = result;
    this.state.deleted = true;
    // v24: the room is deleted — no grace survives it.
    this.cancelHostGrace();
    this.bumpVersion();
    const events = [
      this.emit(
        'room.deleted',
        { result },
        this.allPlayerIds(),
        nowMs,
      ),
    ];
    const persist: PersistIntent[] = [
      { kind: 'match-result', room: this.room },
      { kind: 'room-upsert', room: this.room },
    ];
    void byPlayerId;
    return okResult({ phase: this.room.phase, result }, events, persist);
  }

  /**
   * v18 replay — reset a FINISHED room to LOBBY so the same room/code can
   * play again. HOST-ONLY (host token, like start/config): a non-host
   * gets 403, and the reset never touches the config — a non-host cannot
   * change the config or start the game through it; starting still needs
   * the host token via `startMatch`.
   *
   * Allowed only from a terminal phase (COMPLETED / CANCELLED / ABANDONED
   * / EXPIRED) — a live or paused match cannot be replayed away (409).
   * The phase is assigned directly, not via the state machine: terminal
   * phases deliberately have no LOBBY edge (a replay is a reset, not a
   * match transition), and no other caller may use this edge.
   *
   * Kept: room id + code, host + host tokens, roster, config (incl. the
   * zone boundary — the next game replays on the same zone unless the
   * host changes it in the lobby).
   * Cleared (match state): result, startedAt/endsAt/pausedAt, pause
   * state, shrink count, all catches, pending pings, outside-zone
   * countdowns, raw catch tokens; every seat still in the room gets
   * matchRole/team null, isReady false, briefing un-confirmed,
   * suspension count 0, ejection cleared. Seats that LEFT stay left
   * (they restore via the normal join-by-name + reconnect-token path);
   * the game-event log is kept as the audit trail. Live GPS fixes are
   * kept — they are current positions, not match state.
   */
  replayMatch(input: {
    playerId: string;
    hostTokenHash: string | null;
    nowMs: number;
  }): OpResult<{ phase: MatchPhase; roomCode: string; playerCount: number }> {
    if (this.isDeleted()) return this.deletedRefusal();
    const host = this.verifyHost(input.playerId, input.hostTokenHash);
    if (!host) {
      return errResult('Only the host can replay the room.', 'FORBIDDEN', 403);
    }
    if (!isTerminalPhase(this.room.phase)) {
      return errResult(
        `Only a finished room can be replayed — this room is ${this.room.phase}.`,
        'INVALID_STATE',
        409,
      );
    }
    this.room.phase = 'LOBBY';
    this.room.result = null;
    this.room.startedAt = null;
    this.room.endsAt = null;
    this.room.pausedAt = null;
    this.state.paused = false;
    this.state.pausedBy = null;
    this.state.pausedFrom = null;
    this.state.shrinkIndexApplied = 0;
    this.state.catches = [];
    this.state.lastPingAtMs = {};
    this.state.runnerQrTokens = [];
    // v24: a replayed lobby starts clean — no grace from the old match.
    this.cancelHostGrace();
    // v18 fix round (B2): restore the ORIGINAL configured zone boundary
    // snapshotted at `startMatch` — shrinks mutated the live boundary
    // in place, and resetting only the shrink counter would leave the
    // replayed game on the ~42%-of-original zone. Deep-copied so the
    // snapshot itself is never aliased to the live boundary. (When no
    // match ever started the snapshot is null and the boundary is
    // already the configured one — nothing to restore.)
    if (this.state.originalZoneBoundary !== null && this.state.originalZoneBoundary !== undefined) {
      this.room.config.zone.boundary = this.state.originalZoneBoundary.map((p) => ({ ...p }));
    }
    this.mem.outsideZone = {};
    this.mem.rawCatchTokens.clear();
    this.mem.pendingPings = [];
    this.mem.pendingPingRecipients.clear();
    // v18 fix round (F6/A10): replay must not leak cross-round state.
    // Announcements are for the finished match ("X was tagged", "match
    // ends in…") — a fresh lobby must not re-deliver them to a
    // reconnecting seat. `lastDisconnectAtMs` is the same story (it
    // drives missed-message delivery for the old match). The live fixes
    // are from the old match too, so they go with it — a seat that
    // never reports in the new game must read "Location never
    // reported", not carry a stale dot. The fix/persist throttles reset
    // with them (they are per-match hot-path state, not identity).
    this.mem.announcements = [];
    this.mem.lastDisconnectAtMs = {};
    this.mem.latestFix = {};
    this.mem.lastFixAcceptedAtMs = {};
    this.mem.lastPlayerPersistAtMs = {};
    // v29 — a fresh game starts with no return windows, no fix
    // history, and no violation counts from the old match. (The log
    // buffer is NOT cleared: buffered audit entries still flush.)
    this.state.disconnectDeadlineMs = {};
    this.mem.fixHistory = {};
    this.mem.gpsViolations = {};
    const persist: PersistIntent[] = [{ kind: 'room-upsert', room: this.room }];
    for (const p of this.state.players) {
      if (p.leftAt !== null) continue;
      p.matchRole = null;
      p.team = null;
      p.isReady = false;
      p.briefingConfirmed = false;
      p.suspensionCount = 0;
      p.ejectedAt = null;
      // v18 fix round (F6/A10): a seat suspended when the match ended
      // must not enter the new lobby still marked suspended — it would
      // sit "location unknown" and blocked from confirming until a
      // resume that nothing triggers in the lobby. Back to connected,
      // with no stale quality or fix timestamp from the old match.
      p.connectionState = 'connected';
      p.locationQuality = null;
      p.lastFixAt = null;
      persist.push({ kind: 'player-upsert', roomId: this.room.roomId, player: p });
    }
    this.bumpVersion();
    const events = [this.roomStateEvent('replay-reset', input.nowMs)];
    return okResult(
      {
        phase: this.room.phase,
        roomCode: this.room.roomCode,
        playerCount: this.activePlayers().length,
      },
      events,
      persist,
    );
  }

  /** REST lifecycle: start / pause / resume / end. Pause is any player; the rest host-only. */
  lifecycleOp(input: {
    action: 'start' | 'pause' | 'resume' | 'end';
    playerId: string;
    hostTokenHash?: string | null;
    reconnectTokenHash?: string | null;
    nowMs: number;
  }): OpResult<Record<string, unknown>> {
    if (this.isDeleted()) return this.deletedRefusal();
    switch (input.action) {
      case 'start': {
        const r = this.startMatch({
          playerId: input.playerId,
          hostTokenHash: input.hostTokenHash ?? null,
          nowMs: input.nowMs,
        });
        if (!r.ok) return r;
        return okResult(
          { phase: r.value.phase, startedAt: r.value.startedAt, endsAt: r.value.endsAt },
          r.events,
          r.persist,
        );
      }
      case 'pause': {
        const seat = this.verifyReconnect(input.playerId, input.reconnectTokenHash ?? null);
        if (!seat) {
          return errResult('Seat not found or reconnect token does not match.', 'FORBIDDEN', 403);
        }
        // v33 fix round (Zara final review, BLOCKING) — an ejected
        // seat must not pause the live match with its still-valid
        // reconnect token (ejection clears only the localStorage
        // rejoin mirror, never the sessionStorage credential, and
        // pause is ANY player). Same refusal shape as `getStateOp`
        // below (`SEAT_REMOVED` / 403), live-phase only.
        if (this.ejectedWhileLive(seat)) {
          return errResult('That seat has been ejected from the game.', 'SEAT_REMOVED', 403);
        }
        const r = this.doSafetyPause(input.playerId, null, input.nowMs);
        if (!r.ok) return r;
        return okResult({ paused: true }, r.events, r.persist);
      }
      case 'resume': {
        const host = this.verifyHost(input.playerId, input.hostTokenHash ?? null);
        if (!host) {
          return errResult('Only the host can resume over REST.', 'FORBIDDEN', 403);
        }
        const r = this.doSafetyResume(input.playerId, input.nowMs);
        if (!r.ok) return r;
        return okResult({ phase: r.value.phase }, r.events, r.persist);
      }
      case 'end': {
        const host = this.verifyHost(input.playerId, input.hostTokenHash ?? null);
        if (!host) {
          return errResult('Only the host can end the match.', 'FORBIDDEN', 403);
        }
        const r = this.cancelMatch(input.playerId, input.nowMs);
        if (!r.ok) return r;
        return okResult({ phase: r.value.phase, result: r.value.result }, r.events, r.persist);
      }
      default:
        return errResult('Unknown lifecycle action.', 'VALIDATION_FAILED', 400);
    }
  }

  getStateOp(input: {
    playerId: string;
    reconnectTokenHash: string | null;
    nowMs: number;
  }): OpResult<WsSnapshotPayload> {
    if (this.isDeleted()) return this.deletedRefusal();
    const seat = this.verifyReconnect(input.playerId, input.reconnectTokenHash);
    if (!seat) {
      return errResult('Seat not found or reconnect token does not match.', 'FORBIDDEN', 403);
    }
    // v31 FIX ROUND (F3) — a seat that left the room (host-removed in
    // the lobby via `removePlayer`, or voluntary `leaveSeat`) must not
    // read state anymore. Its reconnect token still verifies — by
    // design, so the seat can be RESTORED by name + token
    // (`addPlayerAsync` clears `leftAt`) — but a snapshot landing is
    // what resurrects the seat on the client: the lobby / play first
    // paint treats any landed snapshot as "I am in". A discarded tab
    // has no live socket to close with 4403, so this HTTP read was
    // the only hole left (ticket register / redeem, hello resume and
    // WS messages already refuse `leftAt` seats — see below).
    //
    // Why refuse here instead of carrying `leftAt` in the response
    // (the other option): the snapshot ALREADY carries it — every
    // player view spreads the seat's `leftAt` (`playerViewFor` in
    // @pakdam/engine snapshot.ts, via `RoomStore.snapshotFor`), and
    // the client already filters on it. The data was never missing;
    // the server was still SERVING it to a seat that is out. Refusing
    // is the only half that closes the hole server-side; the client
    // half (banner + mirror-clear on learning the seat is out) keys
    // off this refusal.
    //
    // Why NOT in `verifyReconnect` (the shared verifier): that would
    // also close `resultsFor` (a mid-game leaver can still read their
    // scores — pinned by test) and the `verify-reconnect` probe, and
    // `addPlayerAsync` restores by comparing the token hash directly.
    // The refusal belongs on this op only. Callers checked:
    // `get-state` is first-paint / re-sync for one's OWN seat only
    // (GET /v1/rooms/:id); results use the separate `get-results` op;
    // the lobby's socket-close probe only acts on 404, so a 403 here
    // is ignored there; a deleted room still 404s first (above).
    // Status 403 (not 409): the sibling read-guard `verifyReconnect`
    // fails 403, and the WS analog closes a left seat 4403. The
    // distinct code `SEAT_REMOVED` (passed through by `doError` in
    // http.ts) is what the client branches on — a bare 403 also
    // covers a bad token.
    if (seat.leftAt !== null) {
      return errResult('That seat has left the room.', 'SEAT_REMOVED', 403);
    }
    // v33 (F2a): an ejected seat reads no live state while the match
    // is live — same refusal shape as the `leftAt` check above. The
    // code stays `SEAT_REMOVED`: the client branches on that code for
    // its removal screen (a new code would fall through to "Game not
    // found"), and the message names the ejection. `get-results`
    // stays open (separate op, playerIds only). The seat already got
    // its ejection snapshot pushed before its socket closed, so the
    // refusal never strands it without `ejectedAt`.
    if (this.ejectedWhileLive(seat)) {
      return errResult('That seat has been ejected from the game.', 'SEAT_REMOVED', 403);
    }
    return okResult(this.snapshotFor(input.playerId, input.nowMs));
  }

  /** Match result, participant-only; 404 until the match has a result. */
  resultsFor(input: {
    playerId: string;
    reconnectTokenHash: string | null;
    nowMs: number;
  }): OpResult<{
    roomId: string;
    phase: MatchPhase;
    result: MatchResult;
    scores: Record<string, number>;
  }> {
    if (this.isDeleted()) return this.deletedRefusal();
    const seat = this.verifyReconnect(input.playerId, input.reconnectTokenHash);
    if (!seat) {
      return errResult('Seat not found or reconnect token does not match.', 'FORBIDDEN', 403);
    }
    if (!this.room.result) {
      return errResult('No result yet — the match has not finished.', 'NOT_FOUND', 404);
    }
    const startedAtMs = this.room.startedAt === null ? null : Date.parse(this.room.startedAt);
    const endedAtMs =
      this.room.result.durationSeconds !== undefined && startedAtMs !== null
        ? startedAtMs + this.room.result.durationSeconds * 1000
        : input.nowMs;
    const caught = new Set(this.caughtRunnerIds());
    const ejected = new Set(
      this.state.players.filter((p) => p.ejectedAt !== null).map((p) => p.playerId),
    );
    // P1-6 (FIXED v29 — ported from the v2 track's `scoringInputs`,
    // adapted to the live tree): `wasRunner` is set from the catch
    // record, not from the FINAL role. A confirmed tag AS a Runner
    // proves the seat was a Runner at some point, even when the final
    // role is Hunter (Infection flip). The old code keyed free time
    // on the final role only, so a flipped Runner's free time ran to
    // the end of the match (and earned no Runner points at all, since
    // `wasRunner` was never set). Free time now stops at the earliest
    // confirmed tag for a flipped Runner, exactly as it stops at the
    // tag for a Classic Runner. (The v2 copy also stops free time at
    // the first explicit leave; the live tree has no `firstLeftAt`
    // marker, so that half is deliberately NOT ported here.)
    const caughtAtMs = new Map<string, number>();
    for (const c of this.state.catches) {
      if (c.state !== 'confirmed' || c.confirmedAt === null) continue;
      const ms = Date.parse(c.confirmedAt);
      const prev = caughtAtMs.get(c.runnerPlayerId);
      if (prev === undefined || ms < prev) caughtAtMs.set(c.runnerPlayerId, ms);
    }
    const scored = scoreMatch({
      players: this.state.players.map((p) => {
        const wasRunner = p.matchRole === 'runner' || caughtAtMs.has(p.playerId);
        let freeUntil = endedAtMs;
        if (wasRunner) {
          if (p.ejectedAt !== null) {
            freeUntil = Math.min(freeUntil, Date.parse(p.ejectedAt));
          }
          const caughtMs = caughtAtMs.get(p.playerId);
          if (caughtMs !== undefined) freeUntil = Math.min(freeUntil, caughtMs);
        }
        return {
          playerId: p.playerId,
          matchRole: p.matchRole,
          wasRunner,
          freeSeconds:
            startedAtMs === null
              ? 0
              : Math.max(0, Math.floor((freeUntil - startedAtMs) / 1000)),
          caught: caught.has(p.playerId),
          ejected: ejected.has(p.playerId),
          tagsMade: this.state.catches.filter(
            (c) => c.hunterPlayerId === p.playerId && c.state === 'confirmed',
          ).length,
        };
      }),
      result: this.room.result,
      // P1-6: ONLY players who were Runners when ejected. An ejected
      // Hunter in this list would falsely break the clean sweep
      // (scoring.ts caller contract). Ejection never changes a seat's
      // matchRole, so the role at results time IS the role at ejection —
      // except an Infection flip, which moves the seat to Hunters first,
      // so a flipped-then-ejected seat correctly counts as a Hunter.
      ejectedRunnerIds: [...ejected].filter((id) => {
        const p = this.player(id);
        return p !== undefined && p.matchRole === 'runner';
      }),
    });
    return okResult({
      roomId: this.room.roomId,
      phase: this.room.phase,
      result: this.room.result,
      scores: scored.scores,
    });
  }

  // -- suspension / leave -----------------------------------------------------

  /** Resume a suspended seat on hello / reconnect (P0-1). No-op unless suspended. */
  resumeOnHello(
    playerId: string,
    nowMs: number,
  ): { resumed: boolean; events: OutboundEvent[]; persist: PersistIntent[] } {
    const seat = this.player(playerId);
    if (!seat) return { resumed: false, events: [], persist: [] };
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
    let resumed = false;
    const r = resumeSuspendedPlayer(seat, nowMs);
    if (r.resumed) {
      Object.assign(seat, r.player);
      resumed = true;
      // v29 (30 s rule) — resuming inside the window clears it, so a
      // seat that came back is never ejected for the earlier absence.
      // Role/score are intact: resume only flips connectionState.
      this.clearDisconnectDeadline(playerId);
      events.push(
        this.emit('player.resumed', { playerId }, this.allPlayerIds(), nowMs),
      );
      persist.push(
        { kind: 'player-upsert', roomId: this.room.roomId, player: seat },
        this.logGameEvent('PLAYER_RECONNECTED', playerId, { playerId }, nowMs),
      );
    }
    // v24 — a graced host who resumes inside the grace keeps host:
    // cancel the grace BEFORE the re-trigger below, so it cannot
    // transfer a host who is connected again. The host token was
    // never deleted during the grace, so `verifyHost` still accepts
    // the restored host. (A host who returns AFTER a transfer is a
    // regular player by then — the grace is already gone — so this
    // never flips host back.)
    if (
      seat.isHost &&
      seat.connectionState === 'connected' &&
      this.state.hostGrace?.hostPlayerId === playerId
    ) {
      this.cancelHostGrace(playerId);
    }
    // v23 fix round 1 (S8): a seat coming back (or re-helloing) is the
    // trigger to re-run succession when the room is hostless — the
    // host disconnected while every remaining seat was suspended, so
    // the original succession found nobody. If the resuming seat IS
    // the host it is connected again by now, so this is a no-op for it.
    const s = this.succeedHostIfSuspended(nowMs);
    events.push(...s.events);
    persist.push(...s.persist);
    return { resumed, events, persist };
  }

  // -- v24 host reconnect grace (founder decision D1, 2026-11-21) ------

  /**
   * The running grace's deadline (epoch ms), or null when no grace is
   * running. A grace naming a seat that is no longer the suspended
   * host is stale — report null so the snapshot never advertises a
   * deadline for a host who already kept / lost host another way.
   */
  hostGraceEndsAtMs(): number | null {
    const g = this.state.hostGrace;
    if (!g) return null;
    const host = this.player(g.hostPlayerId);
    if (!host || !host.isHost || host.connectionState !== 'suspended' || host.leftAt !== null) {
      return null;
    }
    return g.endsAtMs;
  }

  /**
   * Start the host's reconnect grace. Called ONLY from `suspendSeat`
   * on an actually-gone reason (`'network-lost'` /
   * `'heartbeat-timeout'`), and ONLY on the transition into
   * actually-gone suspension — which is exactly when `suspendSeat`
   * calls it: a fresh suspend just recorded the suspension, and an
   * already-suspended seat (tab hidden first, socket closed after)
   * is suspended by now. No-ops when the phase is terminal, the seat
   * is not the host, or the seat is not suspended. A grace already
   * running for this host is NEVER restarted or extended — timers
   * never stack, so a second actually-gone reason while suspended
   * keeps the deadline from the first one. Returns true when a grace
   * actually started (the caller persists it + makes it visible).
   *
   * v24 follow-up — the start MUST move the snapshot key: it bumps
   * the room version, so a snapshot re-fetched after the grace starts
   * is never identical-skipped by the client's `(version, serverSeq)`
   * gate. (The caller also emits a `room.state` when no other event
   * fires, and a room-upsert persist — see `suspendSeat`.)
   */
  startHostGrace(hostPlayerId: string, nowMs: number): boolean {
    if (isTerminalPhase(this.room.phase)) return false;
    const seat = this.player(hostPlayerId);
    if (!seat || !seat.isHost) return false;
    if (seat.connectionState !== 'suspended') return false;
    if (seat.leftAt !== null) return false;
    const existing = this.state.hostGrace;
    if (existing && existing.hostPlayerId === hostPlayerId) return false;
    this.state.hostGrace = {
      hostPlayerId,
      endsAtMs: nowMs + HOST_RECONNECT_GRACE_MS,
    };
    this.bumpVersion();
    return true;
  }

  /**
   * Cancel the grace. Called when the graced host resumes
   * (`resumeOnHello`, join-path restore), when the host leaves
   * voluntarily (`leaveSeat` — no grace survives a leave), and when
   * the room reaches a terminal phase. With no argument it clears
   * whatever grace is recorded; with a host id it clears only that
   * host's grace.
   */
  cancelHostGrace(hostPlayerId?: string): void {
    const g = this.state.hostGrace;
    if (!g) return;
    if (hostPlayerId !== undefined && g.hostPlayerId !== hostPlayerId) return;
    this.state.hostGrace = null;
  }

  /**
   * v24 follow-up — notice for a grace that ended WITHOUT a transfer
   * (expired with no successor, the graced host is no longer the
   * suspended host, or the room went terminal). The clearing must be
   * persisted (a room-upsert), must move the snapshot key
   * (bumpVersion), AND must reach clients (a `room.state` broadcast,
   * which makes them re-fetch the snapshot) — otherwise the client's
   * grace line lingers on a deadline that no longer exists, and the
   * alarm path (which saves only when something changed) would never
   * persist the clearing. No-op when no grace is recorded. Callers
   * that transfer do NOT use this: the transfer's own events /
   * persist / version bump already carry the clearing.
   */
  private graceClearedNotice(
    nowMs: number,
  ): { events: OutboundEvent[]; persist: PersistIntent[] } {
    if (!this.state.hostGrace) return { events: [], persist: [] };
    this.state.hostGrace = null;
    this.bumpVersion();
    return {
      events: [this.roomStateEvent('host-grace-expired', nowMs)],
      persist: [{ kind: 'room-upsert', room: this.room }],
    };
  }

  /**
   * v24 — grace expiry, called from `alarmTick`. Returns the transfer
   * (or nothing) for the caller to deliver/persist. Guards, in order:
   * no grace → nothing; terminal phase → the grace dies with the room
   * (no transfer); RESOLVING → the grace waits out the resolve
   * (`completeMatch` clears it when the match completes — a transfer
   * mid-resolve would crown a host for a finished game); deadline not
   * yet reached → nothing; host no longer the suspended host (resumed
   * without cancelling, left, transferred already) → the grace is
   * cleared and nothing transfers. At expiry WITH a successor the
   * transfer clears the grace (`transferHostToSeat`) and its own
   * events / persist / version bump carry the clearing. At expiry
   * with NO successor the lapsed record STANDS (F3, v24 fix round):
   * clearing it would strand the room hostless forever, because the
   * re-trigger (`succeedHostIfSuspended`) may only transfer on an
   * expired grace recorded for this host — with the record gone it
   * no-ops (F1 rule). The standing record is the marker that lets a
   * later resume / fresh join re-trigger the transfer when a
   * successor appears; it is cleared only by a completed transfer,
   * a resume (`cancelHostGrace`), a leave, or a terminal phase. The
   * snapshot keeps reporting the past deadline while the host is
   * still the suspended host, so the client's "Waiting for the
   * host…" line stays up in the lapsed state — acceptable, the room
   * IS still hostless. The transfer itself calls
   * `succeedHostAfterDisconnect` with NO batchId: a fresh id, so it
   * can never amend an already-delivered transfer (v23 S6 lesson —
   * expiry must never rewrite a delivered event, and a no-batchId
   * call cannot amend anything).
   */
  expireHostGrace(
    nowMs: number,
  ): { events: OutboundEvent[]; persist: PersistIntent[] } {
    const none = { events: [] as OutboundEvent[], persist: [] as PersistIntent[] };
    const g = this.state.hostGrace;
    if (!g) return none;
    if (isTerminalPhase(this.room.phase)) {
      // Terminal: no transfer — but the clearing itself still needs
      // the notice (persisted + visible), not a silent drop.
      return this.graceClearedNotice(nowMs);
    }
    const phase = this.room.phase;
    if (
      phase !== 'LOBBY' &&
      phase !== 'READY_CHECK' &&
      phase !== 'HEAD_START' &&
      phase !== 'ACTIVE' &&
      phase !== 'SAFETY_PAUSED'
    ) {
      return none;
    }
    if (nowMs < g.endsAtMs) return none;
    const host = this.player(g.hostPlayerId);
    if (!host || !host.isHost || host.connectionState !== 'suspended' || host.leftAt !== null) {
      // Stale grace: the host is gone another way — clear with the
      // notice, no transfer.
      return this.graceClearedNotice(nowMs);
    }
    const s = this.succeedHostAfterDisconnect(host.playerId, nowMs);
    if (s.transferred) {
      // The transfer cleared the grace (`transferHostToSeat`) and its
      // own events / persist / version bump carry the clearing.
      return { events: s.events, persist: s.persist };
    }
    // F3 — expired with no successor: return NOTHING and keep the
    // lapsed record standing (no clearing, no notice). Clearing here
    // used to strand the room hostless forever: the re-trigger below
    // (`succeedHostIfSuspended`) may only transfer on an expired
    // grace recorded for this host, so a cleared record made every
    // later resume / join a no-op. The record is the marker; the
    // next tick / resume re-trigger transfers as soon as a successor
    // appears, and the record is cleared then (by the transfer), by
    // a resume, a leave, or a terminal phase.
    return none;
  }

  /**
   * v23 fix round 1 (S8) — hostless-room re-trigger. If the current
   * host seat is suspended AND a grace recorded for this host has
   * EXPIRED, run succession to the earliest-joined connected seat
   * (the alarm's expiry step may not have run yet). A suspended host
   * with NO grace recorded for them — 'tab-hidden' / 'screen-locked'
   * / 'unknown' never start one — keeps host: no transfer, ever, from
   * this path (F1, v24 fix round). If the host seat LEFT while every
   * remaining seat was suspended, `leaveSeat` crowned nobody (S14: no
   * suspended successor), so the room is hostless with `isHost` still
   * on the absent host — the first seat to come back transfers host
   * here instead. No-op when the host is connected, the room is
   * terminal, or nobody connected remains. Called from
   * `resumeOnHello` and from `alarmTick`, the two moments a suspended
   * host can gain a live successor without a fresh disconnect.
   */
  private succeedHostIfSuspended(
    nowMs: number,
  ): { events: OutboundEvent[]; persist: PersistIntent[] } {
    // F4 (v24 fix round) — RESOLVING waits out the resolve, like
    // `expireHostGrace`: `completeMatch` transitions synchronously,
    // so this is unreachable in practice, but the two expiry paths
    // must agree — never crown a host for a finished game. One-line
    // guard covering both transfer paths below.
    if (this.room.phase === 'RESOLVING') return { events: [], persist: [] };
    const host = this.state.players.find((p) => p.isHost);
    if (!host) return { events: [], persist: [] };
    if (host.connectionState === 'suspended') {
      // v24 — while a grace is running for this host and has not
      // expired, the host keeps host: skip the transfer. The
      // `leftAt !== null` branch below (voluntary leave, no grace)
      // still runs. When the grace HAS expired but the alarm's expiry
      // step has not run yet, the transfer happens here instead.
      const g = this.state.hostGrace;
      if (g && g.hostPlayerId === host.playerId && nowMs < g.endsAtMs) {
        return { events: [], persist: [] };
      }
      // F1 (v24 fix round) — NO grace recorded for this host means
      // the suspension was NOT actually-gone: 'tab-hidden' /
      // 'screen-locked' / 'unknown' never start a grace
      // (`suspendSeat` only starts one for 'network-lost' /
      // 'heartbeat-timeout'), and a host who merely hid a tab keeps
      // host (v23 rule, founder D1: "host stays host until they've
      // really left"). Only an EXPIRED grace recorded for THIS host
      // may transfer here; without one, return no-op — otherwise
      // the next alarm tick / resume re-trigger would transfer a
      // tab-hidden host that `suspendSeat` correctly did not.
      if (!g || g.hostPlayerId !== host.playerId) {
        return { events: [], persist: [] };
      }
      const s = this.succeedHostAfterDisconnect(host.playerId, nowMs);
      if (s.transferred) return { events: s.events, persist: s.persist };
      // F3 — the grace expired but nobody could take host: return
      // NOTHING and keep the lapsed record standing (no clearing, no
      // notice). Clearing here used to strand the room hostless
      // forever: with the record gone the F1 rule above makes every
      // later tick / resume a no-op, so a seat resuming later could
      // never take host. The standing record is the marker — the
      // next tick / resume re-trigger transfers as soon as a
      // successor appears.
      return { events: [], persist: [] };
    }
    // The host LEFT while every remaining seat was suspended:
    // `leaveSeat` crowns no suspended seat (S14), so the room is
    // hostless with `isHost` still on the absent host. The first seat
    // to come back re-triggers the transfer here, to the
    // earliest-joined connected seat.
    if (host.leftAt === null) return { events: [], persist: [] };
    if (isTerminalPhase(this.room.phase)) return { events: [], persist: [] };
    const next = this.state.players
      .filter((p) => p.leftAt === null && p.connectionState !== 'suspended')
      .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt))[0];
    if (!next) return { events: [], persist: [] };
    const s = this.transferHostToSeat(host, next, nowMs);
    return { events: s.events, persist: s.persist };
  }

  /**
   * Socket close marks the seat suspended — NEVER removal.
   *
   * v23 Rule 2 — host succession lives HERE, gated on the REASON
   * (founder decision 2026-11-21; pinned by Arjun's v23 store tests):
   *  - `'network-lost'` (socket close) and `'heartbeat-timeout'`
   *    (alarm) are "actually gone" — a suspended HOST transfers host
   *    to the earliest-joined remaining player, via
   *    `succeedHostAfterDisconnect`.
   *  - `'tab-hidden'`, `'screen-locked'` and `'unknown'` NEVER
   *    transfer — a host switching tabs or locking the screen keeps
   *    host. The gate is the reason, not the call site: the class's
   *    socket-close sweep and the alarm arrive as `'network-lost'` /
   *    `'heartbeat-timeout'` and transfer. (v23 fix round 1, S13: the
   *    WS `player.suspended` handler no longer passes a client-supplied
   *    `'network-lost'` / `'heartbeat-timeout'` through — those map to
   *    `'unknown'` there, so only the server-side sweep/alarm assert
   *    "actually gone".)
   * A seat already suspended still succeeds when the reason is
   * actually-gone (tab hidden first, socket closed after): the
   * suspension itself emits nothing twice, but the succession runs.
   *
   * v24 (founder decision D1, 2026-11-21) — the succession above is
   * now DEFERRED by a 30 s grace: an actually-gone host suspend
   * starts the grace (`startHostGrace`) instead of transferring
   * immediately. The transfer happens at expiry (`expireHostGrace`,
   * from `alarmTick`) if the host has not returned. Everything else
   * in this doc comment still holds, with "transfers" read as
   * "starts the grace, then transfers at expiry".
   *
   * `batchId` (v23 fix round 1, S6) groups simultaneous disconnects:
   * the class sweep and one alarm tick each pass a single id for the
   * whole batch, so the same-batch amend in
   * `succeedHostAfterDisconnect` only ever rewrites a transfer from
   * THIS batch. A lone call (WS handler, resume re-trigger) passes
   * none and gets a fresh id per call, so it can never amend another
   * call's already-delivered transfer. (v24: `suspendSeat` no longer
   * calls `succeedHostAfterDisconnect` at all, so the batchId is
   * accepted but unused here — the grace expiry call passes NO
   * batchId, which is what guarantees it can never amend a delivered
   * transfer.)
   */
  suspendSeat(
    playerId: string,
    reason: 'tab-hidden' | 'screen-locked' | 'network-lost' | 'heartbeat-timeout' | 'unknown',
    nowMs: number,
    batchId?: string,
  ): { events: OutboundEvent[]; persist: PersistIntent[]; needsHostCheckin: boolean } {
    const seat = this.player(playerId);
    if (!seat) {
      return { events: [], persist: [], needsHostCheckin: false };
    }
    // v33 fix round (Zara final review, RECOMMENDED) — an out seat
    // (left or ejected) is never suspended: suspension would stamp a
    // return window — and, for a host, a reconnect grace — for a seat
    // that can never come back. Defence in depth: every current
    // caller already filters out seats (the class close-sweep skips
    // ejected seats, `handleWsMessage` refuses them before the
    // `player.suspended` case), but the shared primitive must not
    // depend on its callers never regressing.
    if (seat.leftAt !== null || seat.ejectedAt !== null) {
      return { events: [], persist: [], needsHostCheckin: false };
    }
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
    let needsHostCheckin = false;
    // v28 fix round (Diya R1): remember the latest suspension reason
    // (memory only) — the alarm's heartbeat loop skips a tab-hidden
    // seat whose socket is still attached (its heartbeat pause is
    // expected, not a death). Stamped on every call, fresh or repeat,
    // so it is always the latest reason for this seat.
    this.mem.lastSuspensionReason[playerId] = reason;
    // v24 follow-up: whether the seat was ALREADY suspended before
    // this call — when it was, this call emits no `player.suspended`,
    // so a grace started below needs its own event to reach clients.
    const wasSuspended = seat.connectionState === 'suspended';
    if (seat.connectionState !== 'suspended') {
      const r = recordSuspension(seat, reason);
      Object.assign(seat, r.player);
      this.mem.lastDisconnectAtMs[playerId] = nowMs;
      events.push(
        this.emit('player.suspended', { playerId, reason }, this.allPlayerIds(), nowMs),
      );
      persist.push(
        { kind: 'player-upsert', roomId: this.room.roomId, player: seat },
        this.logGameEvent('PLAYER_DISCONNECTED', playerId, { playerId, reason }, nowMs),
      );
      needsHostCheckin = r.needsHostCheckin;
    }
    if (reason === 'network-lost' || reason === 'heartbeat-timeout') {
      // v29 (30 s rule) — an actually-gone suspension starts the
      // seat's 30 s return window (never restarts one already
      // running). The alarm ejects the seat at the deadline if it
      // has not resumed. Tab-hidden / screen-locked / unknown never
      // start it: the socket may still be alive (a call on speaker
      // while staying on the page counts as present).
      this.setDisconnectDeadline(playerId, nowMs);
      // v24 — NO immediate succession: an actually-gone HOST starts
      // the 30 s reconnect grace instead (`startHostGrace` — a no-op
      // for non-host seats, and never restarts an already-running
      // grace). The transfer happens at expiry (`expireHostGrace`,
      // from `alarmTick`) if the host has not returned by then.
      // `batchId` is intentionally unused here now: the expiry call
      // passes NO batchId (fresh id), so it can never amend a
      // delivered transfer (v23 S6 lesson).
      void batchId;
      // v28 fix round (Diya R1, defence in depth) — a
      // 'heartbeat-timeout' for a seat ALREADY suspended never starts
      // a grace: the seat's suspension is already recorded, and the
      // timeout is the heartbeat loop re-firing on a paused heartbeat
      // (tab hidden, socket still open), not a fresh "actually gone".
      // Without this, a merely-hidden host gets a grace at ~61-90 s
      // and can lose the crown at ~91-120 s, inside the v29 2-min
      // seat hold. 'network-lost' still starts one: a tab-hidden host
      // whose socket THEN closes really is gone (v24 F1), and that
      // path arrives here with reason 'network-lost', untouched.
      const timeoutOnSuspendedSeat = reason === 'heartbeat-timeout' && wasSuspended;
      if (!timeoutOnSuspendedSeat && this.startHostGrace(playerId, nowMs)) {
        // v24 follow-up — the grace start must be persisted AND
        // visible. The room-upsert persists it: without this, the
        // already-suspended case returns no persist intent at all and
        // the class would never save the grace (it would not survive
        // a DO eviction). The version bump in `startHostGrace` moves
        // the snapshot key, so a re-fetched snapshot is never
        // identical-skipped. And when the seat was ALREADY suspended,
        // this call emits nothing else — so a `room.state` is emitted
        // here, the only trigger that makes clients re-fetch the
        // snapshot and see the grace at all. (In the fresh case
        // `player.suspended` already triggers the re-fetch, so no
        // second event is needed.)
        if (wasSuspended) {
          events.push(this.roomStateEvent('host-grace-started', nowMs));
        }
        persist.push({ kind: 'room-upsert', room: this.room });
      }
    }
    return { events, persist, needsHostCheckin };
  }

  /** Leave: marks leftAt + disconnected; host-leave auto-transfers host. */
  leaveSeat(
    playerId: string,
    reason: string | null,
    nowMs: number,
  ): { events: OutboundEvent[]; persist: PersistIntent[] } {
    const seat = this.player(playerId);
    if (!seat || seat.leftAt !== null) return { events: [], persist: [] };
    seat.leftAt = new Date(nowMs).toISOString();
    seat.connectionState = 'disconnected';
    delete this.mem.latestFix[playerId];
    // v29 — a seat that left for good carries no return window, fix
    // history, or violation count into a later restore (a restore
    // re-starts clean; the suspension count stays on the record).
    this.clearDisconnectDeadline(playerId);
    delete this.mem.fixHistory[playerId];
    delete this.mem.gpsViolations[playerId];
    const events: OutboundEvent[] = [
      ...this.emitPlayerEvent('player.left', seat, nowMs),
    ];
    const persist: PersistIntent[] = [
      { kind: 'player-upsert', roomId: this.room.roomId, player: seat },
    ];
    if (seat.isHost) {
      // v24 — voluntary leave counts as really left: no grace
      // survives a leave, even one recorded before the leave.
      this.cancelHostGrace(seat.playerId);
      const next = this.state.players
        .filter(
          (p) =>
            p.leftAt === null &&
            // v23 fix round 1 (S14): mirror
            // `succeedHostAfterDisconnect` — a suspended seat must not
            // be crowned. It cannot mint a host token until it
            // reconnects, so crowning it strands the room hostless.
            p.connectionState !== 'suspended',
        )
        .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt))[0];
      if (next) {
        delete this.state.hostTokens[seat.playerId];
        seat.isHost = false;
        next.isHost = true;
        this.state.room.hostPlayerId = next.playerId;
        events.push(
          this.emit(
            'host.transferred',
            { previousHostPlayerId: seat.playerId, newHostPlayerId: next.playerId },
            this.allPlayerIds(),
            nowMs,
          ),
        );
        persist.push({ kind: 'player-upsert', roomId: this.room.roomId, player: next });
      } else {
        // v23 fix round 1 (S1): no successor — the leaver's host token
        // dies with the seat instead of surviving on a left host.
        // (`verifyHost` also refuses left seats now, so the token is
        // unusable either way; deleting it keeps the record honest.)
        delete this.state.hostTokens[seat.playerId];
      }
    }
    this.bumpVersion();
    events.push(this.roomStateEvent('player-left', nowMs));
    persist.push({ kind: 'room-upsert', room: this.room });
    void reason;
    // P1-8: when the LAST player leaves — in ANY phase — the room ends
    // instead of hanging forever. (Previously only HEAD_START/ACTIVE
    // abandoned, so a room emptied while SAFETY_PAUSED stayed paused
    // forever: alarmTick returns early for non-live phases while the
    // alarm kept re-arming.) LOBBY empties to EXPIRED; a live/paused
    // match abandons (HEAD_START has no ABANDONED edge, so it cancels);
    // RESOLVING cancels. A terminal phase stops the alarm (the class
    // deletes it) and frees the invite code (class unregisters it).
    if (this.activePlayers().length === 0 && !isTerminalPhase(this.room.phase)) {
      // v24: the room ends terminal here, so no grace survives it —
      // a grace must never resurrect or transfer in a terminal room.
      this.cancelHostGrace();
      const from = this.room.phase;
      const outcome = from === 'LOBBY' ? 'expire' : 'abandon';
      const moved = transitionForEvent(from, outcome);
      const target = moved.ok
        ? moved.phase
        : transitionForEvent(from, 'cancel').ok
          ? 'CANCELLED'
          : null;
      if (target !== null) {
        const durationSeconds =
          this.room.startedAt === null
            ? 0
            : Math.max(0, Math.floor((nowMs - Date.parse(this.room.startedAt)) / 1000));
        const result: MatchResult = {
          outcome: target === 'EXPIRED' ? 'cancelled' : target === 'CANCELLED' ? 'cancelled' : 'abandoned',
          durationSeconds,
          caughtRunnerIds: this.caughtRunnerIds(),
          survivingRunnerIds: freeRunnerIds(this.state.players, this.caughtRunnerIds()),
          tags: confirmedTags(this.state.catches),
        };
        this.room.phase = target;
        this.room.result = result;
        this.bumpVersion();
        events.push(
          this.emit('match.cancelled', { result }, this.allPlayerIds(), nowMs),
          this.roomStateEvent('room-ended-empty', nowMs),
        );
        persist.push({ kind: 'match-result', room: this.room });
      }
    }
    return { events, persist };
  }

  /**
   * v28 — end an abandoned live room (Diya F8/F11, Zara A2). Called
   * ONLY from the DO class `alarm()` when no live WebSocket has been
   * attached for `ABANDONED_IDLE_MS` (10 min — see the constant: it
   * must exceed the v29 2-min seat hold plus margin). The class owns
   * the socket observation; this method owns the transition, mirroring
   * `leaveSeat`'s empty-room end so the two paths can never disagree:
   * ACTIVE / SAFETY_PAUSED → ABANDONED; HEAD_START / READY_CHECK /
   * COUNTDOWN have no ABANDONED edge, so they fall back to CANCELLED
   * (exactly `leaveSeat`'s fallback). A paused room is the stuck
   * shape this closes: SAFETY_PAUSED has no timeout and no
   * auto-resume, so a host who pauses and whose phone then dies used
   * to tick 1 s forever — now the idle window ends it. LOBBY never
   * reaches here (its 24 h expiry owns it — the idle window must not
   * fight it) and terminal phases refuse. Like the empty-room end,
   * the grace is cancelled first (no transfer in a terminal room)
   * and the result is built the same way, so snapshots + replay keep
   * working from the terminal room.
   */
  abandonForIdle(
    nowMs: number,
  ): { events: OutboundEvent[]; persist: PersistIntent[]; abandoned: boolean } {
    const from = this.room.phase;
    const none = { events: [] as OutboundEvent[], persist: [] as PersistIntent[], abandoned: false };
    if (isTerminalPhase(from) || from === 'LOBBY') return none;
    if (
      from !== 'HEAD_START' &&
      from !== 'ACTIVE' &&
      from !== 'SAFETY_PAUSED' &&
      from !== 'READY_CHECK' &&
      from !== 'COUNTDOWN'
    ) {
      return none;
    }
    // The room ends terminal here, so no grace survives it — same as
    // the empty-room end in `leaveSeat`.
    this.cancelHostGrace();
    const moved = transitionForEvent(from, 'abandon');
    const target = moved.ok
      ? moved.phase
      : transitionForEvent(from, 'cancel').ok
        ? 'CANCELLED'
        : null;
    if (target === null) return none;
    const durationSeconds =
      this.room.startedAt === null
        ? 0
        : Math.max(0, Math.floor((nowMs - Date.parse(this.room.startedAt)) / 1000));
    const result: MatchResult = {
      outcome: target === 'CANCELLED' ? 'cancelled' : 'abandoned',
      durationSeconds,
      caughtRunnerIds: this.caughtRunnerIds(),
      survivingRunnerIds: freeRunnerIds(this.state.players, this.caughtRunnerIds()),
      tags: confirmedTags(this.state.catches),
    };
    this.room.phase = target;
    this.room.result = result;
    this.bumpVersion();
    const events = [
      this.emit('match.cancelled', { result }, this.allPlayerIds(), nowMs),
      this.roomStateEvent('room-ended-idle', nowMs),
    ];
    const persist: PersistIntent[] = [
      { kind: 'match-result', room: this.room },
      { kind: 'room-upsert', room: this.room },
    ];
    return { events, persist, abandoned: true };
  }

  /**
   * Host succession on ACTUAL disconnect (Rule 2, founder decision
   * 2026-11-21). v24: NO LONGER called from `suspendSeat` — a
   * disconnect starts the 30 s grace instead, and this runs only at
   * grace expiry (`expireHostGrace`, from `alarmTick`, NO batchId)
   * or from the hostless re-trigger `succeedHostIfSuspended` (grace
   * already expired — a suspended host with no grace recorded keeps
   * host, F1). NEVER from the WS
   * `player.suspended` handler with a tab-hidden / screen-locked
   * reason: a host who switches tabs or locks the screen suspends
   * but keeps host.
   *
   * Ordering is `leaveSeat`'s: remaining seats, sorted by `joinedAt`
   * ascending, first wins — with one eligibility difference forced by
   * the disconnect case. `leaveSeat` filters only on `leftAt === null`,
   * because the leaver is the only gone seat. Here the gone seats are
   * the suspended ones, so a suspended seat is NOT a candidate: the
   * founder's rule is "if that player has also left, the next earliest
   * joiner", and a disconnected player has left in exactly that sense.
   * Without this, two simultaneous disconnects flip host BACK to the
   * dead original host — the sweep succeeds h1→p2, then p2→h1 (h1 is
   * still `leftAt === null`, merely suspended, and is earliest) — a
   * double-transfer ending with a disconnected host, and a reconnected
   * h1 resuming AS host. Skipping suspended candidates makes the
   * double-disconnect deterministic: the earliest still-present player
   * wins in a single transfer. A suspended seat that later reconnects
   * is still in the room, just not host — no harm. Role / caught /
   * ejected state are still NOT consulted: a caught/spectating
   * CONNECTED earliest joiner still becomes host (join order only).
   * The old host's host token is deleted, exactly as `leaveSeat` /
   * `transferHost` do; the new host mints a fresh token via the
   * existing `issue-host-token` op. The snapshot carries the new host
   * at once (`room.hostPlayerId` + per-seat `isHost`), so the new
   * host gets full host controls immediately. One-way and sticky:
   * nothing here ever flips host back, and `resumeOnHello` never
   * touches `isHost`, so a reconnected old host resumes as a regular
   * player.
   *
   * SAME-BATCH AMEND (Arjun's v23 double-disconnect contract): two
   * seats dropping in the same instant share one batch (the class
   * sweep and one alarm tick each pass a single `batchId` for the
   * whole batch — v23 fix round 1, S6: keyed by batch, NOT by
   * `nowMs`, so two separate disconnects that happen to share a
   * millisecond can never amend each other's transfer). The first
   * drop transfers host to the earliest-joined remaining seat; when
   * THAT seat drops in the same batch, the succession does NOT emit a
   * second `host.transferred` — it AMENDS the one already emitted
   * (its `newHostPlayerId` rewritten to the final host) and emits
   * only a `room.state`. Exactly one transfer per simultaneous
   * disconnect, naming the final host; a `room.state` still goes out
   * so clients re-fetch the snapshot and see the new host at once.
   * The amended event object is the one already returned to the
   * caller (the class sweep delivers after the loop), so every
   * observer sees the final target — the amend is only ever applied
   * to an event that has not been delivered yet (the batching
   * contract on `lastSuccession`). A later drop in a DIFFERENT batch
   * is a separate batch and emits a fresh transfer.
   *
   * No-op (`transferred: false`) when the seat is not the host, is
   * not suspended, the phase is terminal, or nobody remains.
   */
  succeedHostAfterDisconnect(
    playerId: string,
    nowMs: number,
    batchId?: string,
  ): { transferred: boolean; events: OutboundEvent[]; persist: PersistIntent[] } {
    const seat = this.player(playerId);
    const none = { transferred: false, events: [], persist: [] as PersistIntent[] };
    if (!seat || !seat.isHost) return none;
    if (seat.connectionState !== 'suspended') return none;
    if (isTerminalPhase(this.room.phase)) return none;
    const next = this.state.players
      .filter(
        (p) =>
          p.leftAt === null &&
          p.playerId !== seat.playerId &&
          p.connectionState !== 'suspended',
      )
      .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt))[0];
    if (!next) return none;
    return this.transferHostToSeat(seat, next, nowMs, batchId);
  }

  /**
   * The shared transfer core: move `isHost` + `hostPlayerId` from
   * `prev` to `next`, delete the old host's token, persist, and emit
   * exactly one `host.transferred` naming the final host — amending
   * the batch's earlier transfer instead of emitting a second one
   * when `next`'s predecessor in THIS batch was the seat that just
   * received host (see the same-batch amend above). Used by
   * `succeedHostAfterDisconnect` and by the hostless re-trigger
   * `succeedHostIfSuspended` (which also covers a host that LEFT
   * while every remaining seat was suspended — `leaveSeat` crowns no
   * suspended seat, so the transfer waits for the first seat to come
   * back). Callers must respect the batching contract on
   * `lastSuccession`: the amend only rewrites an event that has not
   * been delivered yet.
   */
  private transferHostToSeat(
    prev: Player,
    next: Player,
    nowMs: number,
    batchId?: string,
  ): { transferred: boolean; events: OutboundEvent[]; persist: PersistIntent[] } {
    // v24: any completed transfer ends the grace for the previous
    // host — a transferred host never gets a grace back.
    if (this.state.hostGrace?.hostPlayerId === prev.playerId) {
      this.state.hostGrace = null;
    }
    delete this.state.hostTokens[prev.playerId];
    prev.isHost = false;
    next.isHost = true;
    this.state.room.hostPlayerId = next.playerId;
    this.bumpVersion();
    const persist: PersistIntent[] = [
      { kind: 'room-upsert', room: this.room },
      { kind: 'player-upsert', roomId: this.room.roomId, player: prev },
      { kind: 'player-upsert', roomId: this.room.roomId, player: next },
    ];
    // Same-batch amend: the seat dropping now is the seat that JUST
    // received host via succession in this same batch — rewrite the
    // one transfer event to name the final host, emit no second one.
    // Keyed by `batchId` (S6): a call with no batchId, or a different
    // batch's id, never amends — two separate disconnects sharing a
    // millisecond emit two truthful transfers.
    const prior = this.mem.lastSuccession;
    if (
      batchId !== undefined &&
      prior !== null &&
      prior.batchId === batchId &&
      prior.event.payload['newHostPlayerId'] === prev.playerId
    ) {
      prior.event.payload['newHostPlayerId'] = next.playerId;
      return {
        transferred: true,
        events: [this.roomStateEvent('host-transferred', nowMs)],
        persist,
      };
    }
    const transfer = this.emit(
      'host.transferred',
      { previousHostPlayerId: prev.playerId, newHostPlayerId: next.playerId },
      this.allPlayerIds(),
      nowMs,
    );
    // A lone call (no batchId) gets a fresh id, so a later call can
    // never mistake it for its own batch.
    this.mem.lastSuccession = { batchId: batchId ?? newId(), event: transfer };
    // v29 (R5) — ONE event, not two: the client re-fetches the
    // snapshot on `host.transferred` already, so the accompanying
    // `room.state` only bought a second identical snapshot request
    // per client. The version bump still rides the re-fetched
    // snapshot. (The same-batch amend path above still returns only
    // a `room.state` — the amended transfer is the earlier, already
    // queued event object, not a second request.)
    return {
      transferred: true,
      events: [transfer],
      persist,
    };
  }

  /**
   * Deletion notice (Rule 1) — the LAST event of the delivered
   * deletion stream, minted by the DO class (not by `cancelMatch`):
   * a `room.state` broadcast with reason `'room-deleted'`. The full
   * stream the class delivers is `match.cancelled` (with the result,
   * synthesised by the class) → `room.deleted` (the literal signal
   * from `cancelMatch`, re-emitted here) → this notice. The notice is
   * NOT a new WS event type: the free-form `reason` string on the
   * existing `room.state` event carries the signal (no
   * packages/shared change). The notice tells every connected client
   * the room is gone: on it (or on `room.deleted`, or on a snapshot
   * 404, or on the socket closing) the client goes home with the one
   * plain message and never offers replay — snapshot / results /
   * replay all answer 404 from here on.
   */
  roomDeletedNotice(nowMs: number): OutboundEvent {
    return this.roomStateEvent('room-deleted', nowMs);
  }

  // -- pending pings ----------------------------------------------------------

  /**
   * Pending pings for a player who just (re)connected. Pings are mutual
   * and role-scoped: a Hunter re-receives pending Runner pings
   * (recipientRole 'hunters'), a Runner re-receives pending Hunter pings
   * (recipientRole 'runners'). A player never receives a ping that reveals
   * their own team. Only pings this player has NOT yet received are
   * returned (per-recipient ack): a ping delivered to one Hunter stays
   * pending for an offline Hunter until they reconnect.
   */
  pendingPingsFor(playerId: string, _nowMs: number): Ping[] {
    // Pings are ACTIVE-only: nothing is delivered during HEAD_START (or
    // any pre-start phase). A ping generated in ACTIVE may still be
    // re-delivered while SAFETY_PAUSED — the pause froze a live game,
    // it did not rewind it to the head start.
    if (this.room.phase !== 'ACTIVE' && this.room.phase !== 'SAFETY_PAUSED') return [];
    const me = this.player(playerId);
    if (!me || me.matchRole === null) return [];
    const role: 'hunters' | 'runners' = me.matchRole === 'hunter' ? 'hunters' : 'runners';
    return this.mem.pendingPings.filter((p) => {
      if (p.recipientRole !== role) return false;
      const waiting = this.mem.pendingPingRecipients.get(p.pingId);
      return waiting === undefined || waiting.has(playerId);
    });
  }

  // -- alarm tick ---------------------------------------------------------------

  /**
   * The timer authority. Order, per spec: (1) purge stale fixes; (2)
   * HEAD_START -> ACTIVE; (3) match end (never while paused); (4)
   * outside-zone ejection + win check; (5) zone shrink (random offset,
   * never concentric); (6) scheduled pings. Nothing completes while
   * SAFETY_PAUSED. Called every 1 s while live, every 30 s in the lobby,
   * never once terminal.
   */
  alarmTick(
    nowMs: number,
    opts: { firstTickAfterWake?: boolean; liveSocketCount?: number } = {},
  ): {
    events: OutboundEvent[];
    persist: PersistIntent[];
    /** v33 (F2b): seats ejected on this tick — the class closes their sockets AFTER delivering `events`. */
    disconnect: Array<{ playerId: string; code: number; reason: string }>;
  } {
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
    const disconnect: Array<{ playerId: string; code: number; reason: string }> = [];
    const phase = this.room.phase;

    // (1) Purge stale fixes + expired pending pings + stale idempotency.
    // Fixes purge after 30 s (LOCATION_FRESHNESS_SECONDS), not 120 s —
    // the freshness window is 30 s, so a fix older than that is already
    // 'unknown' everywhere it is read.
    for (const [pid, fix] of Object.entries(this.mem.latestFix)) {
      if (nowMs - fix.timestampMs > LOCATION_FRESHNESS_SECONDS * 1000) {
        delete this.mem.latestFix[pid];
      }
    }
    const pingsBefore = this.mem.pendingPings;
    this.mem.pendingPings = purgeExpiredPings(this.mem.pendingPings, nowMs);
    // The declared `ping.expired` type exists so recipients learn a pending
    // ping died undelivered; emit one per expired ping to that ping's
    // recipient role only (Runner pings to Hunters, Hunter pings to Runners).
    const expiredPings = pingsBefore.filter((p) => !this.mem.pendingPings.includes(p));
    if (expiredPings.length > 0) {
      const hunterIds = this.hunterPlayerIds();
      const runnerIds = this.runnerPlayerIds();
      for (const p of expiredPings) {
        const recipients = p.recipientRole === 'hunters' ? hunterIds : runnerIds;
        if (recipients.length === 0) continue;
        events.push(
          this.emit(
            'ping.expired',
            { pingId: p.pingId, subjectPlayerId: p.subjectPlayerId, expiresAt: p.expiresAt },
            recipients,
            nowMs,
          ),
        );
      }
    }
    this.mem.idempotency = purgeIdempotency(this.mem.idempotency, nowMs);
    for (const [cid, held] of [...this.mem.rawCatchTokens]) {
      if (nowMs >= held.expiresAtMs) this.mem.rawCatchTokens.delete(cid);
    }
    // Purge redeemed/expired WS tickets (P2): a redeemed ticket is spent
    // and an expired one is dead — keeping them only grows the registry.
    // (Durable: the purge syncs to storage on the next save.)
    if (this.mem.tickets.length > 0) {
      this.mem.tickets = this.mem.tickets.filter(
        (t) => !t.redeemed && nowMs <= t.expiresAtMs,
      );
    }
    // Purge cached idempotency replies whose record already expired (P2):
    // a reply without its (seat, commandId) record is unreachable.
    if (this.mem.idempotentReplies.size > 0) {
      for (const key of [...this.mem.idempotentReplies.keys()]) {
        if (!this.mem.idempotency.has(key)) this.mem.idempotentReplies.delete(key);
      }
    }
    // v29 (Gap 4) — purge expired cached HTTP idempotent replies.
    if (this.mem.httpIdempotentReplies.size > 0) {
      for (const [key, hit] of [...this.mem.httpIdempotentReplies.entries()]) {
        if (nowMs >= hit.expiresAtMs) this.mem.httpIdempotentReplies.delete(key);
      }
    }
    // v29 (Gap 5) — flush buffered structured logs piggybacked on
    // this tick's persist batch (or alone when the tick is otherwise
    // quiet — the class saves when persist is non-empty).
    const logIntent = this.takeLogBatchIntent();
    if (logIntent !== null) persist.push(logIntent);

    // Lazily expire overdue pending catches on every tick.
    const sweep = this.expireOverdueCatches(nowMs);
    events.push(...sweep.events);
    persist.push(...sweep.persist);

    if (
      phase === 'COMPLETED' ||
      phase === 'CANCELLED' ||
      phase === 'ABANDONED' ||
      phase === 'EXPIRED'
    ) {
      // v24 follow-up: a grace that somehow survived to a terminal
      // tick must still be cleared visibly + persistently (the
      // notice), not silently — the alarm saves only when something
      // changed, and clients must see the grace line go away.
      const cleared = this.graceClearedNotice(nowMs);
      events.push(...cleared.events);
      persist.push(...cleared.persist);
      return { events, persist, disconnect };
    }
    // v28 — RESOLVING backstop. `completeMatch` moves RESOLVING →
    // COMPLETED synchronously in one call, so no durable state should
    // ever rest in RESOLVING — but IF one does (a future writer, a
    // restored legacy row), every completion path refuses it
    // (`canCompleteMatch` is false from RESOLVING: it requires a
    // RESOLVING edge out of RESOLVING itself) and the tick below
    // returns early for a non-live phase, so the room would tick at
    // 30 s forever and never complete. Finish it on the next tick
    // instead: the result is recomputed from the current catches
    // (the same outcome the clock-end path would have produced), or
    // the already-recorded result is kept. This is the only place
    // RESOLVING is ever exited except inside `completeMatch` itself.
    if (phase === 'RESOLVING') {
      const durationSeconds =
        this.room.startedAt === null
          ? 0
          : Math.max(0, Math.floor((nowMs - Date.parse(this.room.startedAt)) / 1000));
      const result =
        this.room.result ??
        resolveModeOutcome({
          mode: this.room.config.mode,
          players: this.state.players,
          caughtRunnerIds: this.caughtRunnerIds(),
          durationSeconds,
          tags: confirmedTags(this.state.catches),
        });
      this.room.phase = transitionOrThrow(this.room.phase, 'COMPLETED');
      this.room.result = result;
      // The match is over — no grace survives into a terminal room
      // (same as `completeMatch`).
      this.cancelHostGrace();
      this.bumpVersion();
      events.push(
        this.emit('match.completed', { result }, this.allPlayerIds(), nowMs),
        this.roomStateEvent('match-completed', nowMs),
      );
      persist.push(
        this.logGameEvent('MATCH_COMPLETED', null, { result, room: { roomId: this.room.roomId, phase: this.room.phase } }, nowMs),
        { kind: 'match-result', room: this.room },
        { kind: 'room-upsert', room: this.room },
      );
      return { events, persist, disconnect };
    }
    // v23 fix round 1 (S8): hostless-room re-trigger on the tick — a
    // host that disconnected while every remaining seat was suspended
    // gains a successor as soon as any seat is connected again (a
    // seat that resumed without a hello, a fresh joiner in the lobby,
    // ...). Cheap no-op while the host is connected; the transfer
    // itself runs at most once (after it, the host is connected).
    {
      const s = this.succeedHostIfSuspended(nowMs);
      events.push(...s.events);
      persist.push(...s.persist);
    }
    // Idle-lobby expiry: a LOBBY older than 24 h transitions to EXPIRED
    // via transitionForEvent (the class unregisters the invite code and
    // the terminal phase stops the alarm). The tick runs every 30 s in
    // the lobby, so expiry lands within half a minute of the deadline.
    if (phase === 'LOBBY') {
      const ageMs = nowMs - Date.parse(this.room.createdAt);
      if (ageMs > LOBBY_EXPIRY_MS) {
        const moved = transitionForEvent(phase, 'expire');
        if (moved.ok) {
          this.room.phase = moved.phase;
          // v24: the lobby expired terminal — no grace survives it.
          this.cancelHostGrace();
          this.bumpVersion();
          events.push(this.roomStateEvent('lobby-expired', nowMs));
          persist.push({ kind: 'room-upsert', room: this.room });
        }
        return { events, persist, disconnect };
      }
    }
    // v24 — host reconnect grace expiry. Runs in LOBBY, READY_CHECK
    // and live phases (HEAD_START / ACTIVE / SAFETY_PAUSED); the step
    // itself guards the phase and the deadline. Placed BEFORE the
    // `startedAt === null` return so the lobby (startedAt null) is
    // covered, and AFTER the lobby-expiry block so a 24 h-expired
    // lobby expires instead of transferring first. In the lobby and
    // ready-check the tick is 30 s, so a tick-only check could land
    // up to ~60 s after disconnect — the class arms a one-shot alarm
    // at the grace deadline (see `armAlarm` in room-do-class.ts), so
    // the tick that expires the grace fires at ~30 s. Live phases
    // tick every 1 s, so tick expiry alone lands within a second
    // there.
    {
      const g = this.expireHostGrace(nowMs);
      events.push(...g.events);
      persist.push(...g.persist);
    }
    // v28 — store-level abandoned-room end (Arjun repro, Diya F8 /
    // F11). The class's idle clock (no live sockets, durable) is the
    // primary trigger in production, but the store must also end a
    // room whose seats are all suspended: a single tick long after
    // the last disconnect must reach terminal once the class reports
    // no live socket attached (Zara R1: the store rule takes the
    // socket observation from the class — it never fires on socket
    // knowledge of its own, because it has none). The two shapes it
    // closes: a SAFETY_PAUSED room whose clock is frozen (step (3)
    // never completes while paused, so it can never end even after
    // `endsAt` passes) and an ACTIVE room whose suspended seats are exempt from the (4a) ejection
    // (so nothing ever ends it before `endsAt`). The bound is the
    // same ABANDONED_IDLE_MS (10 min): abandon only when EVERY
    // non-left seat has been suspended for at least the window,
    // measured from the MOST RECENT disconnect
    // (`mem.lastDisconnectAtMs`, stamped by `suspendSeat` on the
    // first suspend). A seat with no recorded disconnect time cannot
    // prove the bound — the rule skips and the class's durable clock
    // decides instead (after a DO eviction the memory map is empty,
    // so this rule deliberately never fires on a bare wake). A
    // running host grace defers it (F10); a lapsed grace does not
    // block it. Placed here — after grace expiry, so a live
    // successor can still save the room, and before the `startedAt`
    // return, so it covers READY_CHECK (never started) and
    // SAFETY_PAUSED (which returns early below as non-live).
    // v28 fix round (Zara R1) — the rule may ONLY fire with NO live
    // socket at all (`opts.liveSocketCount === 0`, observed by the
    // class at tick start and passed in: the store cannot see
    // sockets itself). That is the class rule's invariant ("Only a
    // room with NO live socket at all accrues idle time"), and the
    // store rule must agree with it: a GPS-denied suspension keeps
    // the socket open and heartbeating, so all seats suspended for
    // 10 min WITH sockets attached must NOT end the room under
    // attached players. A missing count (a direct store caller that
    // cannot see sockets) fails closed — the rule never fires on
    // unknown attendance; the class's durable clock still ends a
    // genuinely empty room.
    {
      const idlePhase =
        this.room.phase === 'HEAD_START' ||
        this.room.phase === 'ACTIVE' ||
        this.room.phase === 'SAFETY_PAUSED' ||
        this.room.phase === 'READY_CHECK' ||
        this.room.phase === 'COUNTDOWN';
      const active = this.activePlayers();
      if (
        idlePhase &&
        opts.liveSocketCount === 0 &&
        active.length > 0 &&
        active.every((p) => p.connectionState === 'suspended')
      ) {
        const graceEndsAtMs = this.hostGraceEndsAtMs();
        const graceRunning = graceEndsAtMs !== null && nowMs < graceEndsAtMs;
        if (!graceRunning) {
          let mostRecentDisconnectMs = Number.NEGATIVE_INFINITY;
          let allKnown = true;
          for (const p of active) {
            const at = this.mem.lastDisconnectAtMs[p.playerId];
            if (at === undefined) {
              allKnown = false;
              break;
            }
            if (at > mostRecentDisconnectMs) mostRecentDisconnectMs = at;
          }
          if (allKnown && nowMs - mostRecentDisconnectMs >= ABANDONED_IDLE_MS) {
            const gone = this.abandonForIdle(nowMs);
            events.push(...gone.events);
            persist.push(...gone.persist);
            return { events, persist, disconnect };
          }
        }
      }
    }
    if (this.room.startedAt === null) return { events, persist, disconnect };

    const startedAtMs = Date.parse(this.room.startedAt);
    const endsAtMs = this.room.endsAt === null ? null : Date.parse(this.room.endsAt);
    const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));

    // (2) HEAD_START -> ACTIVE when the head start elapses.
    if (phase === 'HEAD_START') {
      const headStartEndsMs = startedAtMs + this.room.config.headStartSeconds * 1000;
      if (nowMs >= headStartEndsMs) {
        try {
          this.room.phase = transitionOrThrow(this.room.phase, 'ACTIVE');
          this.bumpVersion();
          events.push(this.roomStateEvent('head-start-elapsed', nowMs));
          persist.push({ kind: 'room-upsert', room: this.room });
        } catch {
          // Already moved by a racing op; ignore.
        }
      }
    }

    const livePhase = this.room.phase === 'HEAD_START' || this.room.phase === 'ACTIVE';
    if (!livePhase) return { events, persist, disconnect };

    // (3) Match end — only from a live phase, never while paused.
    if (endsAtMs !== null && nowMs >= endsAtMs) {
      const result = resolveModeOutcome({
        mode: this.room.config.mode,
        players: this.state.players,
        caughtRunnerIds: this.caughtRunnerIds(),
        durationSeconds: this.room.config.durationSeconds,
        tags: confirmedTags(this.state.catches),
      });
      const done = this.completeMatch(result, nowMs);
      events.push(...done.events);
      persist.push(...done.persist);
      return { events, persist, disconnect };
    }

    // (4a) Missing-fix ejection (v18 — the replacement for the removed
    // GPS start gate). A player whose location has not been reported AT
    // ALL for 30 s during ACTIVE is EJECTED. "Reported" is the server
    // receipt time (`lastFixAt`, set on every accepted fix — including
    // a poor fix up to ±1000 m, which proves liveness even though its
    // position is never used for gameplay) — NOT the fix's device
    // timestamp, which can be skewed up to 5 min and would let a fast
    // device clock delay its own ejection. The baseline is the moment
    // ACTIVE began (`activeAtMs`), so a player who never reported at
    // all is ejected 30 s into ACTIVE, not the instant the head start
    // ends. INVARIANT: in production a live fix never exists without a
    // fresh `lastFixAt` — `location.update` is the only writer of
    // `mem.latestFix` and it always stamps `lastFixAt` in the same
    // call — so reading the receipt time cannot miss a real report.
    // (Test harnesses that write `mem.latestFix` directly MUST stamp
    // `lastFixAt` too, or the tick will — correctly, by this rule —
    // eject the seat for silence.)
    // This runs BEFORE the outside-zone accrual: the old code FROZE the
    // countdown on a missing/stale fix, so a player who went outside and
    // then stopped sending fixes could never be ejected. That freeze is
    // now gone for a COMPLETELY missing fix.
    // EXACT RULE — missing vs poor:
    // - NO fix for ≥ 30 s (lastFixAt older than 30 s / never, measured
    //   from max(last fix, ACTIVE start)) → EJECTED here. No zone is
    //   needed: a player with no GPS cannot be placed inside or outside
    //   anything. Runs in ACTIVE ONLY — never during HEAD_START (a
    //   player with a cold GPS lock, or indoors at start, gets the head
    //   start to acquire GPS; a safety pause freezes the clock, so a
    //   paused match never ejects for silence). JUDGMENT CALL (A4):
    //   the founder's rule as written ejects any seat silent for 30 s
    //   from match start — this is the softer version, flag it for the
    //   founder to override if he wants the strict one.
    // - A fix IS present (lastFixAt fresh, ≤ 30 s old) but POOR accuracy
    //   → NO ejection here; the outside-zone countdown freezes as before
    //   (step (4) + location.update). Poor GPS is warned, never treated
    //   as absent.
    // - SUSPENDED seats are EXEMPT here (A3/F4): a seat suspended for
    //   tab-hidden / screen-locked / network-lost is already visible as
    //   "location unknown" and blocked from confirming, and ejection is
    //   terminal — suspending for 30 s must not end a player's game
    //   while the 30 s host reconnect grace is still running. JUDGMENT
    //   CALL: the founder's rule as written ejects any seat silent for
    //   30 s — this is the safer default, flag it for override.
    // - FIRST TICK AFTER WAKE: `firstTickAfterWake` skips this step
    //   once (A3/F4). After a DO eviction the durable `lastFixAt` can
    //   be > 30 s old for a whole live roster; without the skip the
    //   first tick would mass-eject players whose phones are alive and
    //   about to report. They are ejected on the next tick if they
    //   really stay silent.
    if (this.room.phase === 'ACTIVE' && !opts.firstTickAfterWake) {
      const activeAtMs = startedAtMs + this.room.config.headStartSeconds * 1000;
      for (const p of this.state.players) {
        if (p.ejectedAt !== null || p.leftAt !== null) continue;
        if (p.connectionState === 'suspended') continue;
        const lastSeenMs = Math.max(
          p.lastFixAt === null ? Number.NEGATIVE_INFINITY : Date.parse(p.lastFixAt),
          activeAtMs,
        );
        if (nowMs - lastSeenMs >= LOCATION_FRESHNESS_SECONDS * 1000) {
          if (this.ejectWithWinCheck(p, nowMs, startedAtMs, events, persist, disconnect)) {
            return { events, persist, disconnect };
          }
        }
      }
    }

    // (4) Outside-zone ejection (tick-side accrual for players already outside).
    if (this.room.config.playZoneEnabled !== false && this.room.config.zone.boundary.length >= 3) {
      for (const p of this.state.players) {
        const oz = this.mem.outsideZone[p.playerId];
        if (!oz || oz.outsideSinceMs === null) continue;
        if (p.ejectedAt !== null || p.leftAt !== null) continue;
        // Freeze ejection when the player's fix is stale (P2): no fresh
        // evidence, no ejection — mirroring the location.update freeze
        // for poor accuracy. A stale fix means we cannot prove the
        // player is still outside the zone. NOTE (v18): this freeze now
        // only covers a fix that is present-but-stale (e.g. a device
        // clock so skewed the fix looks old while lastFixAt is fresh) —
        // a COMPLETELY missing fix (no fix for ≥ 30 s) was already
        // ejected by step (4a) above and never reaches this freeze.
        const fix = this.mem.latestFix[p.playerId];
        if (!fix || nowMs - fix.timestampMs > LOCATION_FRESHNESS_SECONDS * 1000) {
          continue;
        }
        const totalMs = oz.outsideAccumMs + (nowMs - oz.outsideSinceMs);
        if (totalMs >= OUTSIDE_ZONE_RETURN_SECONDS * 1000) {
          const ejected = applyOutsideZoneEjection(p, nowMs);
          Object.assign(p, ejected);
          delete this.mem.outsideZone[p.playerId];
          this.bumpVersion();
          events.push(this.roomStateEvent('player-ejected', nowMs));
          persist.push({ kind: 'player-upsert', roomId: this.room.roomId, player: p });
          // v33 (F2b): same 4405 disconnect as `ejectWithWinCheck`.
          disconnect.push({
            playerId: p.playerId,
            code: EJECTED_CLOSE_CODE,
            reason: EJECTED_CLOSE_REASON,
          });
          const durationSeconds = Math.max(
            0,
            Math.floor((nowMs - startedAtMs) / 1000),
          );
          const win = maybeCompleteOnWin({
            mode: this.room.config.mode,
            players: this.state.players,
            caughtRunnerIds: this.caughtRunnerIds(),
            durationSeconds,
            tags: confirmedTags(this.state.catches),
          });
          if (win) {
            const done = this.completeMatch(win, nowMs);
            events.push(...done.events);
            persist.push(...done.persist);
            // v33 (F2b, snapshot-before-close): after the match
            // completed, so the snapshot carries the terminal phase.
            events.push(
              this.emit(
                'snapshot',
                this.snapshotFor(p.playerId, nowMs) as unknown as Record<string, unknown>,
                [p.playerId],
                nowMs,
              ),
            );
            return { events, persist, disconnect };
          }
          // v33 (F2b, snapshot-before-close): the seat learns
          // `ejectedAt` only from a snapshot — push one now, while
          // its socket is still open.
          events.push(
            this.emit(
              'snapshot',
              this.snapshotFor(p.playerId, nowMs) as unknown as Record<string, unknown>,
              [p.playerId],
              nowMs,
            ),
          );
        }
      }
    }

    // (4b) v29 — 30 s return-window ejection (founder decision
    // 2026-11-22). A seat whose return deadline passed while still
    // suspended is ejected and the member count drops. Runs in
    // HEAD_START and ACTIVE only — never in the LOBBY (no windows
    // are ever set there), never while SAFETY_PAUSED (the pause
    // freezes the game clock; v29 fix round F4 shifts every return
    // deadline forward by the paused duration on resume, so a
    // deadline that passed during a pause does NOT eject on the
    // first ACTIVE tick after resume — it was extended instead).
    // This is a DIFFERENT mechanism from (4a): (4a) ejects for a
    // missing fix and still exempts suspended seats (v18 A3/F4,
    // verified intact); this step ejects for an expired return
    // window after an actually-gone suspension or an absence at
    // start. Two guards, both learned from the v28 idle tests:
    // - Skipped on the first tick after a wake (same staleness
    //   reason as (4a)): a deadline is durable, and a seat whose
    //   client is about to resume must not be ejected on the wake
    //   tick itself. The deadline survives; the next tick ejects
    //   if the seat is still absent.
    // - Skipped when NOBODY is still playing (no active seat with
    //   connectionState 'connected'): the 30 s rule drops ABSENT
    //   members from a live game, it does not end an empty room.
    //   Ejecting every seat of a room nobody is connected to would
    //   complete it via the win check (COMPLETED) instead of the
    //   idle-abandon path (ABANDONED at 10 min) — the v28 idle
    //   tests pin the abandon, and a winner nobody is there to see
    //   is nonsense. A room with everyone gone is abandoned, not won.
    const anyoneConnected = this.state.players.some(
      (p) => p.leftAt === null && p.ejectedAt === null && p.connectionState === 'connected',
    );
    if (
      !opts.firstTickAfterWake &&
      anyoneConnected &&
      (this.room.phase === 'HEAD_START' || this.room.phase === 'ACTIVE')
    ) {
      const deadlines = this.state.disconnectDeadlineMs ?? {};
      for (const [pid, endsAtMs] of Object.entries(deadlines)) {
        if (nowMs < endsAtMs) continue;
        const p = this.player(pid);
        this.clearDisconnectDeadline(pid);
        if (!p || p.ejectedAt !== null || p.leftAt !== null) continue;
        if (p.connectionState !== 'suspended') continue;
        if (this.ejectWithWinCheck(p, nowMs, startedAtMs, events, persist, disconnect)) {
          return { events, persist, disconnect };
        }
      }
    }

    // (5) Zone shrink — ACTIVE ONLY (P2): shrinks never fire during
    // HEAD_START. v18: NO preview — the founder removed `zone.preview`
    // entirely, so nothing is drawn or broadcast ahead of a shrink. The
    // boundary is drawn fresh at fire time via
    // `randomOffsetShrinkBoundary` (random offset, never concentric);
    // timing (interval), the 75% factor and the final 42% are unchanged.
    if (
      this.room.phase === 'ACTIVE' &&
      this.room.config.zoneShrinkEnabled &&
      this.room.config.zone.boundary.length >= 3
    ) {
      const intervalSeconds = this.room.config.zoneShrinkIntervalSeconds;
      const target = shrinkIndexAt(
        elapsedSeconds,
        intervalSeconds,
        true,
      );
      while (this.state.shrinkIndexApplied < target) {
        const boundary = randomOffsetShrinkBoundary(this.room.config.zone.boundary).boundary;
        this.room.config.zone.boundary = boundary;
        this.state.shrinkIndexApplied += 1;
        this.bumpVersion();
        events.push(
          this.emit(
            'zone.update',
            { zone: this.room.config.zone, phase: this.room.phase },
            this.allPlayerIds(),
            nowMs,
          ),
        );
        persist.push({ kind: 'room-upsert', room: this.room });
      }
    }

    // (6) Scheduled pings — ACTIVE only, one per free Runner per interval.
    // The ping clock starts at ACTIVE, not at match start: the first ping
    // is due one interval after the head start ENDS, so no ping can be
    // due — or fire the instant ACTIVE begins — because its interval
    // elapsed during HEAD_START.
    if (
      this.room.phase === 'ACTIVE' &&
      this.room.config.playZoneEnabled !== false &&
      this.room.config.pingIntervalSeconds > 0
    ) {
      const activeAtMs = startedAtMs + this.room.config.headStartSeconds * 1000;
      const free = freeRunnerIds(this.state.players, this.caughtRunnerIds());
      const pendingSubjects = new Set(this.mem.pendingPings.map((p) => p.subjectPlayerId));
      const due = dueRunnerIds({
        freeRunnerIds: free.filter((id) => !pendingSubjects.has(id)),
        fixes: this.mem.latestFix,
        lastPingAtMs: this.state.lastPingAtMs,
        startedAtMs,
        intervalSeconds: this.room.config.pingIntervalSeconds,
        nowMs,
        activeAtMs,
      });
      for (const runnerId of due) {
        const runner = this.player(runnerId);
        const fix = this.mem.latestFix[runnerId] ?? null;
        const ping = buildPing({
          pingId: newId(),
          roomId: this.room.roomId,
          subjectPlayerId: runnerId,
          recipientRole: 'hunters',
          fix,
          qualityAtPing: runner?.locationQuality ?? null,
          nowMs,
        });
        if (!ping) continue; // No fix = no ping, never an invented position.
        this.mem.pendingPings.push(ping);
        // Per-recipient delivery tracking: the ping stays pending for any
        // Hunter who did not receive this broadcast.
        this.notePingRecipients(ping.pingId, this.hunterPlayerIds());
        events.push(
          this.emit('ping', { ping }, this.hunterPlayerIds(), nowMs),
        );
        persist.push(
          this.logGameEvent(
            'LOCATION_PING_SENT',
            runnerId,
            { pingId: ping.pingId, subjectPlayerId: runnerId },
            nowMs,
          ),
        );
      }
      // Mutual pings: one per free Hunter per interval, same rules — the
      // Hunter ping goes to Runners, so both sides learn the other's
      // location when it fires. Same interval, same 150 m area, same
      // ACTIVE-only / play-zone-ON rules; no fix = no ping.
      const freeHunters = freeHunterIds(this.state.players);
      const dueHunters = dueHunterIds({
        freeHunterIds: freeHunters.filter((id) => !pendingSubjects.has(id)),
        fixes: this.mem.latestFix,
        lastPingAtMs: this.state.lastPingAtMs,
        startedAtMs,
        intervalSeconds: this.room.config.pingIntervalSeconds,
        nowMs,
        activeAtMs,
      });
      for (const hunterId of dueHunters) {
        const hunter = this.player(hunterId);
        const fix = this.mem.latestFix[hunterId] ?? null;
        const ping = buildPing({
          pingId: newId(),
          roomId: this.room.roomId,
          subjectPlayerId: hunterId,
          recipientRole: 'runners',
          fix,
          qualityAtPing: hunter?.locationQuality ?? null,
          nowMs,
        });
        if (!ping) continue; // No fix = no ping, never an invented position.
        this.mem.pendingPings.push(ping);
        this.notePingRecipients(ping.pingId, this.runnerPlayerIds());
        events.push(
          this.emit('ping', { ping }, this.runnerPlayerIds(), nowMs),
        );
        persist.push(
          this.logGameEvent(
            'LOCATION_PING_SENT',
            hunterId,
            { pingId: ping.pingId, subjectPlayerId: hunterId },
            nowMs,
          ),
        );
      }
    }
    // v29 (R1) — periodic snapshot safety valve (see
    // `SNAPSHOT_SAFETY_VALVE_MS`): a `room.state` at most once per
    // 30 s in live phases, so a client that dropped a broadcast event
    // (the WS layer drops reused seqs with no gap detection)
    // re-fetches a correct snapshot within 30 s instead of holding a
    // stale dot indefinitely. The valve is NOT cheap under R5: the
    // re-fetch request still counts as a DO request even when the
    // reply is the tiny `snapshot.unchanged` — up to 1,800
    // requests/game, counted in the budget (see the constant's
    // comment). It stays as the safety net under the `teammate.fix`
    // broadcast. Two guards keep it quiet: the first tick in an
    // awake instance only stamps the clock (no emit), and it fires
    // only when this tick emitted no `room.state` already — a tick
    // that changed state already makes clients re-fetch, so the valve
    // adds nothing there. (4b) early-returns above skip this line
    // entirely.
    if (this.mem.lastSafetyValveMs === 0) {
      this.mem.lastSafetyValveMs = nowMs;
    } else if (
      !opts.firstTickAfterWake &&
      nowMs - this.mem.lastSafetyValveMs >= SNAPSHOT_SAFETY_VALVE_MS &&
      !events.some((e) => e.type === 'room.state')
    ) {
      this.mem.lastSafetyValveMs = nowMs;
      events.push(this.roomStateEvent('snapshot-safety-valve', nowMs));
    }
    return { events, persist, disconnect };
  }

  // -- WS message handling ------------------------------------------------------

  /** Validate a hello payload: version 1, no credential anywhere. */
  static validateHello(payload: unknown): { ok: true } | { ok: false; error: string; closeCode: number } {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'hello must be an object.', closeCode: 4400 };
    }
    const p = payload as Record<string, unknown>;
    if (p['protocolVersion'] !== 1) {
      return { ok: false, error: 'Protocol unsupported — upgrade the client.', closeCode: 4409 };
    }
    if (helloHasCredential(payload)) {
      return { ok: false, error: 'hello must not carry a credential.', closeCode: 4400 };
    }
    return { ok: true };
  }

  /**
   * Per-seat WS-ticket issue limit, enforced in the DO (durable across
   * isolates). Same table entry as the Worker's HTTP limiter
   * (`POST /v1/rooms/:id/ws-ticket`, 10/min/seat) — one source of truth,
   * two enforcement points: the Worker limiter is the cheap first line,
   * this one is authoritative. Applies to both `connect` and `renew`
   * tickets: a renew storm mints tickets too.
   */
  private checkTicketIssueRateLimit(
    playerId: string,
    nowMs: number,
  ): { allowed: boolean; retryAfterSeconds: number } {
    const entry = HTTP_RATE_LIMITS['POST /v1/rooms/:id/ws-ticket'];
    const limit = entry?.limit ?? 10;
    const windowSeconds = entry?.windowSeconds ?? 60;
    const cutoff = nowMs - windowSeconds * 1000;
    const seen = (this.mem.ticketIssues.get(playerId) ?? []).filter((t) => t > cutoff);
    if (seen.length >= limit) {
      const oldest = seen[0] ?? nowMs;
      this.mem.ticketIssues.set(playerId, seen);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - nowMs) / 1000)),
      };
    }
    seen.push(nowMs);
    this.mem.ticketIssues.set(playerId, seen);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * v31 FIX ROUND (Zara (c)) — per-seat WS-ticket REVOKE limit,
   * enforced in the DO. Deliberate mirror of
   * `checkTicketIssueRateLimit` (same sliding-window shape, own
   * memory map, own table entry) — the issue path is untouched.
   * Same table entry as the Worker's HTTP limiter
   * (`POST /v1/rooms/:id/ws-ticket/revoke`, 10/min/seat): one
   * source of truth, two enforcement points. Counts CALLS, not
   * revocations — a revoke of zero tickets still costs the class a
   * `save()`, so the bucket must count the call.
   */
  private checkTicketRevokeRateLimit(
    playerId: string,
    nowMs: number,
  ): { allowed: boolean; retryAfterSeconds: number } {
    const entry = HTTP_RATE_LIMITS['POST /v1/rooms/:id/ws-ticket/revoke'];
    const limit = entry?.limit ?? 10;
    const windowSeconds = entry?.windowSeconds ?? 60;
    const cutoff = nowMs - windowSeconds * 1000;
    const seen = (this.mem.ticketRevokes.get(playerId) ?? []).filter((t) => t > cutoff);
    if (seen.length >= limit) {
      const oldest = seen[0] ?? nowMs;
      this.mem.ticketRevokes.set(playerId, seen);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - nowMs) / 1000)),
      };
    }
    seen.push(nowMs);
    this.mem.ticketRevokes.set(playerId, seen);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Per-seat per-message WS rate limit (OPEN values from shared). */
  private checkWsRateLimit(
    playerId: string,
    type: string,
    nowMs: number,
  ): { allowed: boolean; retryAfterSeconds: number } {
    const entry = (WS_MESSAGE_RATE_LIMITS as Readonly<Record<string, { limit: number; windowSeconds: number } | 'exempt'>>)[type];
    if (entry === 'exempt') return { allowed: true, retryAfterSeconds: 0 };
    const limit = entry?.limit ?? WS_MESSAGE_RATE_LIMIT_DEFAULT.limit;
    const windowSeconds = entry?.windowSeconds ?? WS_MESSAGE_RATE_LIMIT_DEFAULT.windowSeconds;
    const key = `${playerId}:${type}`;
    const cutoff = nowMs - windowSeconds * 1000;
    const seen = (this.mem.wsRate.get(key) ?? []).filter((t) => t > cutoff);
    if (seen.length >= limit) {
      const oldest = seen[0] ?? nowMs;
      this.mem.wsRate.set(key, seen);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - nowMs) / 1000)),
      };
    }
    seen.push(nowMs);
    this.mem.wsRate.set(key, seen);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Message types that change nothing durable and are relay/read-only, so
   * they skip idempotency entirely (Phase 3 #1/#3): a retry of one of
   * these re-runs the same cheap read/relay instead of replaying a cached
   * reply, and no (seat, commandId) record is ever written for them.
   * Everything else keeps exactly-once via `rememberCommand`.
   */
  // v29 (Gap 2) — the canonical set lives in `operation-wrapper.ts`
  // (the single source of truth for mutating vs non-mutating); this
  // alias keeps `RoomStore.NON_MUTATING_TYPES` working for callers
  // and tests.
  private static readonly NON_MUTATING_TYPES: ReadonlySet<string> =
    OPERATION_NON_MUTATING_TYPES;

  /**
   * Dispatch one client message (hello already validated by the caller).
   * Returns outbound events, persist intents, and optionally a socket close.
   * The caller (DO class) delivers events, owns the socket, and executes
   * the persist intents via ctx.waitUntil().
   *
   * `durable` (Phase 3 #1) tells the caller whether this message changed
   * durable state: only then must it `save()` (and `putSession`). Relay /
   * read-only traffic (heartbeat, GPS fix, snapshot, voice signal) returns
   * `durable: false`, so a tap never queues behind a full state rewrite.
   * Game mutations (ready, catch, config, pause, start, leave, join)
   * always return `durable: true`, via a non-empty `persist`.
   */
  async handleWsMessage(
    session: WsSessionRef,
    envelope: { type: string; commandId?: string; payload?: Record<string, unknown> },
    nowMs: number = Date.now(),
  ): Promise<{
    events: OutboundEvent[];
    persist: PersistIntent[];
    durable: boolean;
    close?: { code: number; reason: string };
    /** v33 (F2b): seats ejected by this message — the class closes their sockets AFTER delivering `events`. */
    disconnect?: Array<{ playerId: string; code: number; reason: string }>;
  }> {
    const playerId = session.playerId;
    const me = this.player(playerId);
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
    const disconnect: Array<{ playerId: string; code: number; reason: string }> = [];
    // v29 (Gap 5) — wall-clock entry stamp for the catch-confirm
    // duration log (the handler's `nowMs` is the receive time and does
    // not advance inside the handler, so it cannot measure duration).
    const receivedWallMs = Date.now();
    // v23 fix round 1 (S4): no WS traffic on a deleted room. Every op
    // below is served from the store, so one guard here covers
    // snapshot.request, radio.send, signal.send, pin.place,
    // location.update, ready.set and the rest at once. The socket is
    // closed — a deleted room has nothing left to say.
    if (this.isDeleted()) {
      return {
        events: [
          this.errorEvent(playerId, 'ROOM_NOT_FOUND', 'This room has been deleted.', false, undefined, nowMs),
        ],
        persist,
        durable: false,
        close: { code: 4403, reason: 'Room deleted.' },
      };
    }
    // v18 follow-up: the runner-token mint mutates durable DO state
    // (the hash-only record) but emits no Supabase persist intent, so
    // `persist.length > 0` alone would report it non-durable and the DO
    // class would skip `save()`. A case that changes durable state
    // without a Supabase row sets this instead.
    let stateDirty = false;
    const type = envelope.type;
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    // v29 (Gap 2) — the idempotency + rate-limit + cached-reply
    // prologue/epilogue live in `operation-wrapper.ts` (extracted
    // verbatim from here, behaviour unchanged). The helpers are bound
    // to this message's seat/type/commandId below; the case bodies
    // stay inline. See the module header for the contract:
    // a duplicate key returns the CACHED result, never an error.
    // (P1-9 preserved: the cached reply is the ACTUAL reply —
    // broadcast events included, narrowed to the replier — never an
    // empty `[]` that looks like success-with-nothing. Per-viewer
    // events for OTHER seats are never cached. Hoisted above the
    // early returns (Phase 4 (q)) so the !me / leftAt / rate-limit /
    // leave returns cache their error reply too.)
    const rememberReply = (evts: OutboundEvent[]): void => {
      operationEpilogue(this.mem, playerId, type, envelope.commandId, evts);
    };
    const cacheEarlyReply = (evts: OutboundEvent[]): void => {
      operationCacheEarlyReply(
        this.mem, playerId, type, envelope.commandId, evts, nowMs,
      );
    };

    if (!me) {
      const errorEvents = [this.errorEvent(playerId, 'ROOM_NOT_FOUND', 'Seat not found in this room.', false, undefined, nowMs)];
      cacheEarlyReply(errorEvents);
      return {
        events: errorEvents,
        persist,
        durable: false,
        close: { code: 4403, reason: 'Seat not found.' },
      };
    }
    // A seat that left the room has no socket business left; its socket
    // should already be closed, so a message from it is a protocol error.
    if (me.leftAt !== null) {
      const errorEvents = [this.errorEvent(playerId, 'FORBIDDEN', 'That seat has left the room.', false, undefined, nowMs)];
      cacheEarlyReply(errorEvents);
      return {
        events: errorEvents,
        persist,
        durable: false,
        close: { code: 4403, reason: 'Seat has left the room.' },
      };
    }
    // v33 fix round (Zara final review, REQUIRED) — an ejected seat
    // serves nothing on a surviving socket (ticket redeemed before
    // the ejection, or a second tab): no `snapshot.request` /
    // `resync.request` snapshot, no fix, no radio, nothing. Same
    // shape as the `leftAt` guard above, but close 4405 (ejected),
    // never 4403. Code `FORBIDDEN`, like the `leftAt` guard and the
    // v30-pinned ejected `voice.signal` refusal — the client branches
    // on the 4405 close, not on this code (unlike the HTTP
    // `getStateOp` refusal, whose `SEAT_REMOVED` code the client
    // does branch on). Live-phase only, like `getStateOp`: in a
    // terminal phase the snapshot is history, and the socket is
    // closed at match end anyway. The ejection snapshot itself is
    // NOT served here — it was already pushed before the 4405 close
    // at ejection time.
    if (this.ejectedWhileLive(me)) {
      const errorEvents = [this.errorEvent(playerId, 'FORBIDDEN', 'That seat has been ejected from the game.', false, undefined, nowMs)];
      cacheEarlyReply(errorEvents);
      return {
        events: errorEvents,
        persist,
        durable: false,
        close: { code: EJECTED_CLOSE_CODE, reason: EJECTED_CLOSE_REASON },
      };
    }
    // A socket past its ticket expiry is closed 4401. (The class checks
    // this on every message too; this is the store-side guard.)
    // NOTE: the class passes the session ticket expiry separately.

    // v29 (Gap 2) — idempotency prologue via the wrapper (verbatim
    // extraction; see the module header for the contract). A duplicate
    // key returns the CACHED reply narrowed to this seat — never an
    // error, never a re-apply, never a re-broadcast. Skipped for
    // non-mutating messages (Phase 3 #3): location.update / heartbeat
    // / snapshot / resync / voice.signal carry no mutation to dedupe.
    const prologue = operationPrologue(this.mem, playerId, type, envelope.commandId, nowMs);
    if (prologue.duplicate) {
      return { events: prologue.cached, persist, durable: false };
    }

    // Per-message rate limit (player.suspended is exempt).
    const rl = this.checkWsRateLimit(playerId, type, nowMs);
    if (!rl.allowed) {
      // v29 (Gap 5) — rate-limit hits are logged (by operation + code,
      // no payload). The entry rides out with the next persist batch
      // or alarm tick.
      this.queueLog({
        level: 'warn',
        message: 'ws.rate_limited',
        roomId: this.room.roomId,
        playerId,
        metadata: { operation: type, code: 'RATE_LIMITED' },
      });
      const errorEvents = [
        this.errorEvent(playerId, 'RATE_LIMITED', 'Too many messages — slow down.', true, rl.retryAfterSeconds, nowMs),
      ];
      // Phase 4 (q): cache the rate-limit error — a retry gets the
      // error, not an empty [] that looks like success.
      cacheEarlyReply(errorEvents);
      return {
        events: errorEvents,
        persist,
        durable: false,
      };
    }

    const direct = (t: WsServerMessageType, p: Record<string, unknown>): OutboundEvent =>
      this.emit(t, p, [playerId], nowMs);

    // Caught-Runner (spectator) comms block (P2): a caught Runner cannot
    // send radio / quick signals / voice signals / pins / announcements
    // to their live team. The founder can override this rule. (Their
    // location fixes are still accepted — they are a real person in the
    // field — and they can still receive everything.)
    if (
      this.isCaughtSpectator(playerId) &&
      (type === 'radio.send' ||
        type === 'signal.send' ||
        type === 'voice.signal' ||
        type === 'pin.place' ||
        type === 'announcement.send')
    ) {
      events.push(
        this.errorEvent(
          playerId,
          'FORBIDDEN',
          'You are out — spectating players cannot message the live team.',
          false,
          undefined,
          nowMs,
        ),
      );
      rememberReply(events);
      return { events, persist, durable: false };
    }

    switch (type) {
      case 'heartbeat': {
        events.push(direct('heartbeat.ack', { serverTs: new Date(nowMs).toISOString() }));
        break;
      }
      case 'snapshot.request':
      case 'resync.request': {
        // v29 (R5 — only after R1, fix round) — honour the client's
        // snapshot key. When the seat's (version, serverSeq, durable
        // watermark, memory epoch) key has not moved since the
        // client's last snapshot, reply with the tiny
        // `snapshot.unchanged` event instead of a full snapshot.
        // Canonical key fields: `version`, `serverSeq`,
        // `maxLastFixAtMs` (null when nobody has reported a fix —
        // never 0), `epochMs`. The epoch is what makes the key
        // wake-safe: durable seq + watermark can be unchanged across
        // a wake while memory-only `teammateFixes` / `locationStatus`
        // are gone, so a pre-wake key must never match. A fix-only
        // serverSeq bump counts as a change (location.update advances
        // serverSeq), so dots never go stale by answering unchanged.
        // A client that sends no key at all — only `lastServerSeq`,
        // or an old client — gets the full snapshot: safe default,
        // never guess. A key missing any canonical field (e.g. an
        // old `maxLastFixAt` spelling, or no `epochMs`) likewise
        // gets the full snapshot.
        const key = payload['lastSnapshotKey'] as
          | { version?: unknown; serverSeq?: unknown; maxLastFixAtMs?: unknown; epochMs?: unknown }
          | undefined;
        const snapshot = this.snapshotFor(playerId, nowMs);
        if (
          key !== undefined &&
          typeof key.version === 'number' &&
          typeof key.serverSeq === 'number' &&
          (typeof key.maxLastFixAtMs === 'number' || key.maxLastFixAtMs === null) &&
          typeof key.epochMs === 'number' &&
          key.version === snapshot.version &&
          key.serverSeq === this.state.serverSeq &&
          key.maxLastFixAtMs === (snapshot.maxLastFixAtMs ?? null) &&
          key.epochMs === snapshot.epochMs
        ) {
          events.push(
            direct('snapshot.unchanged', {
              serverSeq: this.state.serverSeq,
              version: snapshot.version,
            }),
          );
        } else {
          events.push(this.emit('snapshot', snapshot as unknown as Record<string, unknown>, [playerId], nowMs));
        }
        break;
      }
      case 'ready.set': {
        if (typeof payload['isReady'] !== 'boolean') {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'ready.set needs isReady: boolean.', false, undefined, nowMs));
          break;
        }
        me.isReady = payload['isReady'] as boolean;
        // Phase 3 #6: "I'm ready" folds briefing.confirm in — one tap,
        // one message, one save, one broadcast. A ready tap also
        // confirms the briefing (un-readying does not un-confirm it).
        // The standalone briefing.confirm case below stays for old
        // clients that still send it.
        if (me.isReady) me.briefingConfirmed = true;
        this.bumpVersion();
        if (me.isReady) {
          persist.push(this.logGameEvent('PLAYER_READY', playerId, { playerId, isReady: true }, nowMs));
        }
        events.push(this.roomStateEvent('ready-set', nowMs));
        persist.push({ kind: 'player-upsert', roomId: this.room.roomId, player: me });
        break;
      }
      case 'briefing.confirm': {
        me.briefingConfirmed = true;
        this.bumpVersion();
        events.push(this.roomStateEvent('briefing-confirmed', nowMs));
        persist.push({ kind: 'player-upsert', roomId: this.room.roomId, player: me });
        break;
      }
      case 'location.update': {
        const fix = payload['fix'] as LocationFix | undefined;
        const prev = this.mem.latestFix[playerId] ?? null;
        // NOTE (deliberate, not an oversight): a caught Runner's fixes are
        // still accepted. They are out of play, but they are still a real
        // person in the field — their location stays visible for safety,
        // and the spectator's own map dot needs it. It cannot affect the
        // outcome: caught status comes only from confirmed catches, a
        // caught Runner cannot be re-tagged (CONFLICT), and `ready.set`
        // mid-game is display-only (the start gate already passed).
        const check = validateFix(fix, prev, nowMs);
        if (!check.ok) {
          // The code comes from the validator: malformed fixes are
          // VALIDATION_FAILED, only a fix that arrived too old is
          // STALE_LOCATION. Clients branch on the code.
          events.push(
            this.errorEvent(playerId, check.code ?? 'VALIDATION_FAILED', check.errors.join(' ') || 'Fix rejected.', false, undefined, nowMs),
          );
          break;
        }
        const goodFix = fix as LocationFix;
        // Phase 3 #2 — server-side fix throttle: at most ~1 accepted
        // fix/s/seat. A fix arriving sooner is dropped (coalesced), not
        // errored: the client streams ~1/s, so this only bites on
        // bursts, and the live fix stays at most 1 s stale.
        // v29 (R7) — this 1/s throttle is DELIBERATELY not tightened:
        // Gap 1's movement check samples at most 1 fix/s, so a tighter
        // throttle would starve it (a 3 s burst window needs >= 3
        // samples). The client-side send gate is the throttle that
        // matters for the DO meter; the server floor stays 1/s.
        const lastAccepted = this.mem.lastFixAcceptedAtMs[playerId] ?? 0;
        if (nowMs - lastAccepted < GPS_FIX_MIN_INTERVAL_MS) {
          // Coalesced fix: no reply is cached here on purpose —
          // location.update is NON_MUTATING, so no commandId was ever
          // recorded for it and there is no retry to serve (Phase 4 (q)
          // does not apply to this return).
          return { events, persist, durable: false };
        }
        // v29 fix round (F3) — the previous fix's SERVER receipt
        // time, captured BEFORE this fix's receipt is stamped below.
        // The movement check uses receipt dt, never device timestamps.
        const prevFixReceiptMs = this.mem.lastFixAcceptedAtMs[playerId] ?? null;
        this.mem.lastFixAcceptedAtMs[playerId] = nowMs;
        // v29 (Gap 1) — GPS anti-cheat movement check, AFTER
        // validateFix passed and AFTER the 1/s throttle, BEFORE the
        // fix is stored. The previous ACCEPTED fix is the reference
        // (ring cap 10, memory only). dt comes from SERVER receipt
        // time (`nowMs` / `lastFixAcceptedAtMs`, F3) — a spoofer
        // forging device timestamps cannot stretch dt and defeat
        // teleport / burst / speed. One violation is counted per
        // accepted fix at most, kind priority teleport > burst >
        // speed; the fix is STILL accepted either way (warn-only by
        // default — the snapshot never exposes the flag). At 3
        // violations inside 5 min a `GPS_VIOLATION` room event is
        // logged (player id, kind, count — NO coordinates) and, only
        // when the room config opts in (`action: 'eject'`), the seat
        // is ejected through the existing machinery in a live phase.
        {
          const cfg = this.gpsAntiCheatConfig();
          if (cfg.enabled) {
            const history = (this.mem.fixHistory[playerId] ??= []);
            const movement = checkFixMovement(history[history.length - 1] ?? null, goodFix, {
              prevReceiptMs: prevFixReceiptMs,
              currReceiptMs: nowMs,
            });
            if (movement) {
              let kind: 'speed' | 'burst' | 'teleport' | null = null;
              if (movement.teleport) kind = 'teleport';
              else if (movement.dtMs <= cfg.burstWindowMs && movement.speedMps > cfg.burstMaxMs) kind = 'burst';
              else if (movement.speedMps > cfg.maxSpeedMs) kind = 'speed';
              if (kind !== null) {
                const slot = (this.mem.gpsViolations[playerId] ??= {
                  count: 0,
                  firstAtMs: nowMs,
                });
                if (nowMs - slot.firstAtMs >= GPS_VIOLATION_WINDOW_MS) {
                  slot.count = 0;
                  slot.firstAtMs = nowMs;
                }
                slot.count += 1;
                if (slot.count >= cfg.violationThreshold) {
                  persist.push(
                    this.logGameEvent(
                      'GPS_VIOLATION',
                      playerId,
                      { playerId, kind, count: slot.count },
                      nowMs,
                    ),
                  );
                  this.queueLog({
                    level: 'warn',
                    message: 'gps.violation',
                    roomId: this.room.roomId,
                    playerId,
                    metadata: { kind, count: slot.count },
                  });
                  slot.count = 0;
                  slot.firstAtMs = nowMs;
                  if (
                    cfg.action === 'eject' &&
                    (this.room.phase === 'HEAD_START' || this.room.phase === 'ACTIVE') &&
                    me.ejectedAt === null
                  ) {
                    const done = this.ejectWithWinCheck(me, nowMs, Date.parse(this.room.startedAt ?? new Date(nowMs).toISOString()), events, persist, disconnect);
                    if (done) {
                      // Ejection completes the match — stop here; the
                      // fix is not stored (the seat is out).
                      this.clearDisconnectDeadline(playerId);
                      rememberReply(events);
                      return { events, persist, durable: true, disconnect };
                    }
                  }
                }
              }
            }
            history.push(goodFix);
            if (history.length > GPS_FIX_HISTORY_CAP) {
              history.splice(0, history.length - GPS_FIX_HISTORY_CAP);
            }
          }
        }
        this.mem.latestFix[playerId] = goodFix;
        // Phase 4 (i) — snapshot-key fix: an accepted fix mutates
        // snapshot content (players[].lastFixAt, teammateFixes, and the
        // time-derived locationStatus) without any emit, so the
        // (version, serverSeq) key the client gates HTTP snapshots on
        // would not move and a re-fetch could be skipped as identical
        // while fixes aged in between. Advance serverSeq (in-memory
        // only — this case still returns durable:false unless a persist
        // is due, so no save is written per fix; the bump persists with
        // the next durable save).
        this.nextSeq();
        me.lastFixAt = new Date(nowMs).toISOString();
        // v29 fix round (F6, R3) — `teammate.fix` broadcast: the
        // primary teammate-liveness mechanism (replaces the 8 s
        // periodic re-fetch). One lightweight event per accepted fix,
        // to the sender's teammates ONLY (same predicate as the
        // snapshot's `teammateFixes` — see `teammateFixRecipients`).
        // Outbound sends are not counted as DO requests under the
        // conservative-meter reading (only inbound messages and alarm
        // invocations count); the CPU cost of the fan-out is the open
        // question. The R1 30 s safety valve stays as the safety net.
        {
          const recipients = this.teammateFixRecipients(playerId);
          if (recipients.length > 0) {
            events.push(
              this.emit(
                'teammate.fix',
                {
                  playerId,
                  lat: goodFix.lat,
                  lng: goodFix.lng,
                  accuracyMeters: goodFix.accuracyMeters,
                  timestampMs: goodFix.timestampMs,
                },
                recipients,
                nowMs,
              ),
            );
          }
        }
        const quality: LocationQuality = check.quality ?? classifyAccuracy(goodFix.accuracyMeters);
        const qualityChanged = me.locationQuality !== quality;
        me.locationQuality = quality;
        const prevConnection = me.connectionState;
        let resumed = false;
        if (me.connectionState === 'suspended') {
          const r = resumeSuspendedPlayer(me, nowMs);
          Object.assign(me, r.player);
          resumed = true;
          // v29 (30 s rule) — a fix from a resumed seat clears the
          // return window, like `resumeOnHello` (role/score intact).
          this.clearDisconnectDeadline(playerId);
          events.push(this.emit('player.resumed', { playerId }, this.allPlayerIds(), nowMs));
        } else {
          me.connectionState = 'connected';
        }
        // v24 fix round (F4) — a suspended seat that resumes on a fix
        // cancels its grace, mirroring `resumeOnHello` and the
        // join-path restore. Defence-in-depth only: in production
        // hello must be the first message, so a fix from a suspended
        // seat is currently unreachable — but a resumed host must
        // never leave a stale grace behind to transfer it away later.
        if (
          resumed &&
          me.isHost &&
          me.connectionState === 'connected' &&
          this.state.hostGrace?.hostPlayerId === playerId
        ) {
          this.cancelHostGrace(playerId);
        }
        const connectionChanged = resumed || prevConnection !== me.connectionState;
        // Outside-zone countdown (live phases, play zone on, boundary set,
        // seat still in play — an ejected seat never re-accrues).
        if (
          me.ejectedAt === null &&
          (this.room.phase === 'HEAD_START' || this.room.phase === 'ACTIVE') &&
          this.room.config.playZoneEnabled !== false &&
          this.room.config.zone.boundary.length >= 3
        ) {
          const inside = isPointInZone(
            { lat: goodFix.lat, lng: goodFix.lng },
            this.room.config.zone.boundary,
          );
          const poor = quality === 'poor';
          const prevOz = this.mem.outsideZone[playerId] ?? emptyOutsideZoneState();
          const upd = updateOutsideZone(prevOz, { inside, poorAccuracy: poor, nowMs });
          this.mem.outsideZone[playerId] = upd.state;
          if (upd.shouldEject) {
            const ejected = applyOutsideZoneEjection(me, nowMs);
            Object.assign(me, ejected);
            delete this.mem.outsideZone[playerId];
            this.bumpVersion();
            events.push(this.roomStateEvent('player-ejected', nowMs));
            persist.push({ kind: 'player-upsert', roomId: this.room.roomId, player: me });
            // v33 (F2b): same 4405 disconnect as `ejectWithWinCheck`,
            // plus the snapshot-before-close push below (after the
            // win check, so it carries the final phase).
            disconnect.push({
              playerId,
              code: EJECTED_CLOSE_CODE,
              reason: EJECTED_CLOSE_REASON,
            });
            const durationSeconds = Math.max(
              0,
              Math.floor((nowMs - Date.parse(this.room.startedAt ?? new Date(nowMs).toISOString())) / 1000),
            );
            const win = maybeCompleteOnWin({
              mode: this.room.config.mode,
              players: this.state.players,
              caughtRunnerIds: this.caughtRunnerIds(),
              durationSeconds,
              tags: confirmedTags(this.state.catches),
            });
            if (win) {
              const done = this.completeMatch(win, nowMs);
              events.push(...done.events);
              persist.push(...done.persist);
            }
            // v33 (F2b, snapshot-before-close): the seat learns
            // `ejectedAt` only from a snapshot — push one now, while
            // its socket is still open.
            events.push(
              this.emit(
                'snapshot',
                this.snapshotFor(playerId, nowMs) as unknown as Record<string, unknown>,
                [playerId],
                nowMs,
              ),
            );
          }
        }
        if (qualityChanged) {
          events.push(
            this.emit(
              'player.visibility',
              { playerId, locationQuality: quality, lastFixAt: me.lastFixAt },
              // P2 liveness leak: an opponent's lastFixAt/quality goes to
              // teammates only, never the whole room (lobby = whole lobby).
              this.teamRecipients(playerId),
              nowMs,
            ),
          );
        }
        // Phase 3 #2 — stop the per-fix Supabase write: the player row
        // persists only when something durable changed (quality, role
        // via resume, connection) or at most once every 30 s
        // (PLAYER_PERSIST_INTERVAL_MS). The live in-memory fix is the
        // start gate's primary source; the durable lastFixAt is only
        // the hibernate/wake fallback, and 30 s is far inside its
        // 120 s freshness window. A fix with no durable change returns
        // durable:false, so the caller skips the save entirely.
        const lastPlayerPersist = this.mem.lastPlayerPersistAtMs[playerId] ?? 0;
        const persistDue = nowMs - lastPlayerPersist >= PLAYER_PERSIST_INTERVAL_MS;
        if (qualityChanged || connectionChanged || persistDue) {
          persist.push({ kind: 'player-upsert', roomId: this.room.roomId, player: me });
          this.mem.lastPlayerPersistAtMs[playerId] = nowMs;
        }
        break;
      }
      // v18: `reveal.send` REMOVED — the founder removed hold-to-reveal
      // entirely. There is no case for it: a stray `reveal.send` from an
      // old client falls through to the default case ("Unknown message
      // type"). The shared `reveal` event type is kept for the web
      // builder's parallel removal of the play-page button.
      case 'catch.runner-token': {
        // v18 follow-up — claim-less runner QR token: the Runner mints
        // their own QR with no claim open and shows it the moment they
        // tap "Got Tagged". Empty payload; the raw token comes back in
        // the direct `catch.runner-token` reply, once, to the Runner
        // only. See `mintRunnerQrToken` for the rules (Runner-only,
        // ACTIVE-only, one live token per Runner, re-mint replaces).
        const r = await this.mintRunnerQrToken({ playerId, nowMs });
        if (!r.ok) {
          events.push(this.errorEvent(playerId, r.code, r.error, false, undefined, nowMs));
          if (r.events) events.push(...r.events);
          if (r.persist) persist.push(...r.persist);
          break;
        }
        stateDirty = true;
        events.push(...r.events);
        persist.push(...r.persist);
        events.push(
          direct('catch.runner-token', {
            token: r.value.token,
            runnerId: r.value.runnerId,
            expiresAt: r.value.expiresAt,
          }),
        );
        break;
      }
      case 'catch.request': {
        // v18 follow-up — scan path: `qrToken` carries the raw token the
        // Hunter decoded from the Runner's QR, with NO runnerId needed.
        // A claim-less runner token resolves the Runner from the hash
        // and creates the claim for them; a claim token (the QR of an
        // already-open claim) resolves the same way. When both `qrToken`
        // and `runnerId` are given they must agree. A failed request
        // (too far apart, Runner not catchable, another Hunter's claim)
        // does NOT consume the token — the Hunter can re-scan / retry
        // with the same QR until its 120 s TTL runs out.
        const qrToken = payload['qrToken'];
        const runnerIdRaw = payload['runnerId'];
        let runnerId = typeof runnerIdRaw === 'string' ? runnerIdRaw : undefined;
        let scanned: { record: RunnerQrToken; raw: string } | null = null;
        if (typeof qrToken === 'string') {
          if (!isValidCatchToken(qrToken)) {
            events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', "That QR didn't scan as a catch token — try again.", false, undefined, nowMs));
            break;
          }
          const resolved = await resolveRunnerQrToken(this.state.runnerQrTokens, qrToken, nowMs);
          if (resolved.status === 'unknown') {
            // v18 fix round (A1): the token matched NO claim-less runner
            // record — but it may be a CLAIM QR. After a name-claim the
            // Runner displays the claim's QR (HTTP /catch-token), and
            // that token lives only in the claim's hash, not in any
            // runner record. Try the open claims' hashes before giving
            // up: a match resolves the Runner from the claim (no runner
            // record is consumed or bound — `scanned` stays null, the
            // claim keeps its own token). The hash domains are NOT
            // merged — this is an explicit second lookup, and a runner
            // token still never verifies as a claim token on its own.
            // A match on an EXPIRED claim does not resolve (the sweep
            // below expires it and the scan opens a fresh claim).
            const claim = await resolveOpenClaimQrToken(this.state.catches, qrToken, nowMs);
            if (claim !== null) {
              if (runnerId !== undefined && runnerId !== claim.runnerPlayerId) {
                events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'That QR is for a different Runner.', false, undefined, nowMs));
                break;
              }
              runnerId = claim.runnerPlayerId;
            } else {
              // v18 fix round (A8): an unknown token may be a genuine QR
              // that ROTATED under the Hunter's camera (a re-mint
              // replaces the record, so the old QR dies instantly) —
              // say so, instead of the bare "didn't match". The
              // distinct CATCH_EXPIRED code below is kept for tokens
              // that are genuinely expired.
              events.push(this.errorEvent(playerId, 'FORBIDDEN', "That QR didn't match — it may have expired or been refreshed. Ask the Runner to show a fresh QR.", false, undefined, nowMs));
              break;
            }
          }
          if (resolved.status === 'expired') {
            events.push(this.errorEvent(playerId, 'CATCH_EXPIRED', 'That QR expired — ask the Runner to show a fresh QR.', false, undefined, nowMs));
            break;
          }
          if (resolved.status === 'used') {
            events.push(this.errorEvent(playerId, 'FORBIDDEN', 'That QR was already used — ask the Runner to show a fresh QR.', false, undefined, nowMs));
            break;
          }
          // 'valid' only — 'unknown' was handled above (claim lookup
          // sets runnerId and skips this block; no match breaks out),
          // so `resolved.record` is non-null here.
          if (resolved.status === 'valid') {
            const record = resolved.record as RunnerQrToken;
            if (runnerId !== undefined && runnerId !== record.runnerPlayerId) {
              events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'That QR is for a different Runner.', false, undefined, nowMs));
              break;
            }
            runnerId = record.runnerPlayerId;
            scanned = { record, raw: qrToken };
          }
        }
        if (runnerId === undefined) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'catch.request needs runnerId or a scanned qrToken.', false, undefined, nowMs));
          break;
        }
        const runner = this.player(runnerId);
        if (!runner) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'That Runner is not in the room.', false, undefined, nowMs));
          break;
        }
        const sweep = this.expireOverdueCatches(nowMs);
        events.push(...sweep.events);
        persist.push(...sweep.persist);
        const open = openCatchForRunner(this.state.catches, runnerId);
        if (open && open.hunterPlayerId === playerId) {
          // Same-Hunter re-request returns the open claim (idempotent).
          // With a scanned runner token, BIND it to the claim as its
          // previous hash: the claim keeps its own token (the Runner's
          // displayed claim QR stays valid) and the scanned QR confirms
          // too — `catch.confirm` accepts the current hash or the
          // previous hash. The runner token is consumed either way.
          if (scanned !== null) {
            open.previousQrTokenHash = await catchTokenHash(open.catchId, scanned.raw);
            scanned.record.used = true;
            persist.push({ kind: 'catch-update', catch: open });
          }
          events.push(direct('catch.requested', { catch: toCatchView(open) }));
          break;
        }
        const req = requestCatch({
          catches: this.state.catches,
          hunter: me,
          runner,
          caughtRunnerIds: this.caughtRunnerIds(),
          phase: this.room.phase,
          catchId: newId(),
          roomId: this.room.roomId,
          nowMs,
          hunterFix: this.mem.latestFix[playerId] ?? null,
          runnerFix: this.mem.latestFix[runnerId] ?? null,
          // P1-11: physical tag — the engine enforces proximity on these.
          positions: {
            hunter: this.mem.latestFix[playerId] ?? null,
            runner: this.mem.latestFix[runnerId] ?? null,
          },
          maxDistanceMeters: CATCH_MAX_DISTANCE_METERS,
        });
        if (!req.ok) {
          const status = req.code === 'FORBIDDEN' ? 403 : 409;
          void status;
          events.push(this.errorEvent(playerId, req.code, req.reason, false, undefined, nowMs));
          break;
        }
        const claim = req.value;
        if (scanned !== null) {
          // Transfer the scanned token into the claim: the claim's token
          // hash is the catchId-scoped hash of the SAME raw value, so
          // the Hunter's later `catch.confirm` with the scanned token
          // verifies unchanged. The Runner keeps showing the same QR —
          // the raw is also held in memory, so a re-fetch returns it,
          // exactly like the name-claim path. The runner token is
          // consumed: it can never create a second claim.
          claim.qrTokenHash = await catchTokenHash(claim.catchId, scanned.raw);
          scanned.record.used = true;
          this.mem.rawCatchTokens.set(claim.catchId, {
            token: scanned.raw,
            expiresAtMs: Date.parse(claim.requestedAt) + CATCH_TOKEN_TTL_SECONDS * 1000,
          });
        } else {
          const { token, tokenHash } = await issueCatchToken(claim.catchId);
          claim.qrTokenHash = tokenHash;
          this.mem.rawCatchTokens.set(claim.catchId, {
            token,
            expiresAtMs: Date.parse(claim.requestedAt) + CATCH_TOKEN_TTL_SECONDS * 1000,
          });
        }
        this.state.catches.push(claim);
        events.push(this.emit('catch.requested', { catch: toCatchView(claim) }, this.catchRecipients(claim), nowMs));
        persist.push({ kind: 'catch-insert', roomId: this.room.roomId, catch: claim });
        break;
      }
      case 'catch.confirm': {
        const catchId = payload['catchId'];
        const qrToken = payload['qrToken'];
        const manualConfirm = payload['manualConfirm'] === true;
        if (typeof catchId !== 'string') {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'catch.confirm needs catchId.', false, undefined, nowMs));
          break;
        }
        const c = this.state.catches.find((x) => x.catchId === catchId);
        if (!c) {
          events.push(this.errorEvent(playerId, 'CATCH_EXPIRED', 'That catch no longer exists.', false, undefined, nowMs));
          break;
        }
        const runner = this.player(c.runnerPlayerId);
        if (!runner) {
          events.push(this.errorEvent(playerId, 'CONFLICT', 'The Runner is no longer in the room.', false, undefined, nowMs));
          break;
        }
        const isRunnerConfirmer = playerId === c.runnerPlayerId;
        // A token matches the current hash — or the preserved previous
        // hash (P1-5: a QR displayed before a hibernate-driven re-mint
        // stays valid until it expires or is confirmed). A rotated token
        // (P2 re-fetch) has no preserved hash, so its old QR is dead.
        const previousHash = c.previousQrTokenHash ?? null;
        const tokenValid =
          manualConfirm && isRunnerConfirmer
            ? true
            : typeof qrToken === 'string' && isValidCatchToken(qrToken)
              ? (await verifyCatchToken(c.catchId, qrToken, c.qrTokenHash)) ||
                (previousHash !== null &&
                  (await verifyCatchToken(c.catchId, qrToken, previousHash)))
              : false;
        const conf = confirmCatch({
          catchEvent: c,
          confirmerId: playerId,
          confirmerRole: me.matchRole,
          manualConfirm,
          tokenValid,
          runner,
          caughtRunnerIds: this.caughtRunnerIds(),
          phase: this.room.phase,
          nowMs,
          ttlSeconds: CATCH_TOKEN_TTL_SECONDS,
          // P1-11: physical tag — the engine rejects the confirm when
          // either fix is missing/stale or the seats are too far apart.
          positions: {
            hunter: this.mem.latestFix[c.hunterPlayerId] ?? null,
            runner: this.mem.latestFix[c.runnerPlayerId] ?? null,
          },
          maxDistanceMeters: CATCH_MAX_DISTANCE_METERS,
        });
        if (!conf.ok) {
          events.push(this.errorEvent(playerId, conf.code, conf.reason, false, undefined, nowMs));
          break;
        }
        // P1-2: validate the completion transition BEFORE mutating the
        // catch — if confirming would complete the match from a phase
        // that cannot complete, reject without marking it confirmed.
        if (this.wouldCompleteOnConfirm(c, conf.value, nowMs) && !this.canCompleteMatch()) {
          events.push(
            this.errorEvent(
              playerId,
              'INVALID_STATE',
              'The match cannot complete from its current phase — the catch stays pending.',
              false,
              undefined,
              nowMs,
            ),
          );
          break;
        }
        Object.assign(c, conf.value);
        this.mem.rawCatchTokens.delete(c.catchId);
        events.push(this.emit('catch.confirmed', { catch: toCatchView(c) }, this.catchRecipients(c), nowMs));
        persist.push({ kind: 'catch-update', catch: c });
        const applied = this.applyConfirmedTagAndWinCheck(c, nowMs);
        events.push(...applied.events);
        persist.push(...applied.persist);
        events.push(this.roomStateEvent('catch-confirmed', nowMs));
        break;
      }
      case 'catch.self-confirm': {
        // v18 Self Confirm: the Runner names the Hunter who tagged them
        // and taps OK — the tag completes with NO confirmation needed
        // from the Hunter. See `selfConfirmCatch` for the rules (claim
        // created if none open, physical-tag gate, no token, no code).
        const hunterId = payload['hunterId'];
        if (typeof hunterId !== 'string') {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'catch.self-confirm needs hunterId.', false, undefined, nowMs));
          break;
        }
        const r = this.selfConfirmCatch({ playerId, hunterId, nowMs });
        if (!r.ok) {
          events.push(this.errorEvent(playerId, r.code, r.error, false, undefined, nowMs));
          if (r.events) events.push(...r.events);
          if (r.persist) persist.push(...r.persist);
          break;
        }
        events.push(...r.events);
        persist.push(...r.persist);
        break;
      }
      case 'catch.dispute': {
        const catchId = payload['catchId'];
        if (typeof catchId !== 'string') {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'catch.dispute needs catchId.', false, undefined, nowMs));
          break;
        }
        const c = this.state.catches.find((x) => x.catchId === catchId);
        if (!c) {
          events.push(this.errorEvent(playerId, 'CATCH_EXPIRED', 'That catch no longer exists.', false, undefined, nowMs));
          break;
        }
        const disp = disputeCatch({
          catchEvent: c,
          disputerId: playerId,
          phase: this.room.phase,
          nowMs,
          ttlSeconds: CATCH_TOKEN_TTL_SECONDS,
        });
        if (!disp.ok) {
          events.push(this.errorEvent(playerId, disp.code, disp.reason, false, undefined, nowMs));
          break;
        }
        Object.assign(c, disp.value);
        events.push(this.emit('catch.disputed', { catch: toCatchView(c) }, this.catchRecipients(c), nowMs));
        persist.push({ kind: 'catch-update', catch: c });
        break;
      }
      case 'safety.pause': {
        const reason = typeof payload['reason'] === 'string' ? (payload['reason'] as string) : null;
        if (reason !== null && reason.length > REASON_MAX_CHARS) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', `Pause reason must be at most ${REASON_MAX_CHARS} characters.`, false, undefined, nowMs));
          break;
        }
        const r = this.doSafetyPause(playerId, reason, nowMs);
        if (!r.ok) {
          events.push(this.errorEvent(playerId, r.code, r.error, false, undefined, nowMs));
          break;
        }
        events.push(...r.events);
        persist.push(...r.persist);
        break;
      }
      case 'safety.resume': {
        // P1-10: only the host can resume — matching the REST lifecycle
        // resume rule. (Pause is any player; resume is host-only.)
        if (!me.isHost) {
          events.push(this.errorEvent(playerId, 'FORBIDDEN', 'Only the host can resume the match.', false, undefined, nowMs));
          break;
        }
        const r = this.doSafetyResume(playerId, nowMs);
        if (!r.ok) {
          events.push(this.errorEvent(playerId, r.code, r.error, false, undefined, nowMs));
          break;
        }
        events.push(...r.events);
        persist.push(...r.persist);
        break;
      }
      // v18: `safety.sos` REMOVED — the founder removed SOS entirely
      // (server + shared). There is no case for it: a stray `safety.sos`
      // from an old client falls through to the default case ("Unknown
      // message type"). The safety PAUSE / resume above STAYS.
      case 'leave': {
        const reason = typeof payload['reason'] === 'string' ? (payload['reason'] as string) : null;
        if (reason !== null && reason.length > REASON_MAX_CHARS) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', `Leave reason must be at most ${REASON_MAX_CHARS} characters.`, false, undefined, nowMs));
          break;
        }
        const r = this.leaveSeat(playerId, reason, nowMs);
        events.push(...r.events);
        persist.push(...r.persist);
        // Phase 4 (q): this early return used to bypass rememberReply —
        // a same-commandId retry got an empty [] that looked like
        // success. Cache the leave reply first.
        rememberReply(events);
        return { events, persist, durable: persist.length > 0, close: { code: 1000, reason: 'Left the room.' } };
      }
      case 'player.suspended': {
        // v23 fix round 1 (S13): a client may only report the reasons
        // it can honestly know — tab-hidden / screen-locked / unknown.
        // `'network-lost'` and `'heartbeat-timeout'` are "actually
        // gone" and trigger host succession, so a client-supplied one
        // would let a host abdicate (or force a transfer) without a
        // host token. They map to `'unknown'` here: the seat is still
        // marked suspended, just without succession. Only the
        // server-side sweep (socket close) and alarm assert those
        // reasons, via `suspendSeat` directly.
        const reason = payload['reason'];
        const valid =
          reason === 'tab-hidden' || reason === 'screen-locked' || reason === 'unknown'
            ? (reason as 'tab-hidden' | 'screen-locked' | 'unknown')
            : 'unknown';
        const r = this.suspendSeat(playerId, valid, nowMs);
        events.push(...r.events);
        persist.push(...r.persist);
        break;
      }
      case 'radio.send': {
        const text = payload['text'];
        const kind = payload['kind'] === 'quick' ? 'quick' : 'text';
        if (typeof text !== 'string' || text.trim().length === 0 || text.length > RADIO_MAX_CHARS) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', `Radio text must be 1–${RADIO_MAX_CHARS} characters.`, false, undefined, nowMs));
          break;
        }
        if (
          me.matchRole === 'hunter' &&
          this.room.config.huntersCanTalk === false &&
          this.room.phase !== 'LOBBY'
        ) {
          events.push(this.errorEvent(playerId, 'FORBIDDEN', 'Hunters cannot send radio in this room — text radio still works for Runners.', false, undefined, nowMs));
          break;
        }
        if (kind === 'quick') {
          const scope = this.room.phase === 'LOBBY' ? 'lobby' : me.team === 'hunters' ? 'hunters' : 'runners';
          const allowed = QUICK_SIGNALS[scope] as readonly string[];
          if (!allowed.includes(text)) {
            events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'That quick message is not in the closed set.', false, undefined, nowMs));
            break;
          }
        }
        // Phase 4 (r) — content dedupe for radio.send: same sender +
        // same kind + same text inside RADIO_DEDUPE_WINDOW_MS is a
        // double-delivery (a double-tap / retry that minted a NEW
        // commandId, so the commandId idempotency above cannot catch
        // it) — drop it silently. The original send's reply stays
        // cached under ITS commandId, so a same-commandId retry still
        // gets the original radio event. The drop itself caches NO
        // reply: caching [] here would be the exact false-success the
        // Phase 4 (q) fix removes elsewhere. A retry of the dropped
        // attempt hits the duplicate check at the top and gets the
        // (empty) cached reply — which is honest here, not a false
        // success: nothing was sent, so there is nothing to replay.
        // Why radio only: the other relay commands are deliberately
        // unguarded. pin.place is a deliberate re-assertion (a re-placed
        // pin is a new marker with a fresh id). signal.send is a
        // transient toast with no server state — a duplicate only
        // re-flashes it, and suppressing a quick signal the sender
        // deliberately re-tapped would hide a live "I need help" repeat.
        // (v18: safety.sos and reveal.send no longer exist — the founder
        // removed SOS and hold-to-reveal entirely.) Radio is the one
        // where a duplicate is both likely (chat send double-tap) and
        // pure noise.
        const radioKey = `${playerId}:${kind}:${text}`;
        const lastRadioAtMs = this.mem.recentRadio.get(radioKey) ?? 0;
        for (const [k, atMs] of this.mem.recentRadio) {
          if (nowMs - atMs >= RADIO_DEDUPE_WINDOW_MS) this.mem.recentRadio.delete(k);
        }
        if (nowMs - lastRadioAtMs < RADIO_DEDUPE_WINDOW_MS) {
          return { events, persist, durable: false };
        }
        this.mem.recentRadio.set(radioKey, nowMs);
        const msg: RadioMessage = {
          messageId: newId(),
          roomId: this.room.roomId,
          playerId,
          senderName: me.displayName,
          text,
          kind,
          sentAt: new Date(nowMs).toISOString(),
        };
        events.push(this.emit('radio', { radio: msg }, this.teamRecipients(playerId), nowMs));
        break;
      }
      case 'signal.send': {
        const code = payload['code'];
        if (typeof code !== 'string') {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'signal.send needs a code.', false, undefined, nowMs));
          break;
        }
        const all = [
          ...QUICK_SIGNALS.lobby,
          ...QUICK_SIGNALS.hunters,
          ...QUICK_SIGNALS.runners,
        ] as readonly string[];
        if (!all.includes(code)) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'Unknown quick-signal code.', false, undefined, nowMs));
          break;
        }
        events.push(
          this.emit(
            'signal',
            { signal: { code, fromPlayerId: playerId, sentAt: new Date(nowMs).toISOString() } },
            this.teamRecipients(playerId),
            nowMs,
          ),
        );
        break;
      }
      case 'voice.signal': {
        const toPlayerId = payload['toPlayerId'];
        const kind = payload['kind'];
        if (typeof toPlayerId !== 'string' || typeof kind !== 'string') {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'voice.signal needs toPlayerId and kind.', false, undefined, nowMs));
          break;
        }
        if (!['join', 'leave', 'offer', 'answer', 'ice'].includes(kind)) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'Unknown voice signal kind.', false, undefined, nowMs));
          break;
        }
        const target = this.player(toPlayerId);
        if (!target) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'Voice peer is not in the room.', false, undefined, nowMs));
          break;
        }
        // F2 (v30 AppSec): an ejected seat keeps no live team voice.
        // Reject before the team check so an ejected seat's signals
        // are never forwarded and its peers never answer.
        if (me.ejectedAt !== null) {
          events.push(this.errorEvent(playerId, 'FORBIDDEN', 'Voice radio is team-only.', false, undefined, nowMs));
          break;
        }
        // F2 (v30 AppSec, target half): the sender block above cannot
        // fire for an in-flight handshake — the ejected seat offered
        // to a teammate BEFORE ejection, so after ejection it sends
        // nothing and only the teammate's `answer` (or further ICE)
        // arrives. Without a target check that handshake completes
        // against a stale/tampered client that never runs `disable()`.
        // Block delivery TO an ejected seat: the error goes to the
        // sending teammate, the ejected target receives nothing.
        // This does not tear down pre-existing peer connections —
        // only the client `disable()` does that — which is why both
        // halves remain necessary.
        if (target.ejectedAt !== null) {
          events.push(this.errorEvent(playerId, 'FORBIDDEN', 'Voice radio is team-only.', false, undefined, nowMs));
          break;
        }
        // Team-only: the DO rejects cross-team signals (lobby = whole lobby).
        if (
          this.room.phase !== 'LOBBY' &&
          me.team !== null &&
          target.team !== null &&
          me.team !== target.team
        ) {
          events.push(this.errorEvent(playerId, 'FORBIDDEN', 'Voice radio is team-only.', false, undefined, nowMs));
          break;
        }
        if (kind === 'offer' || kind === 'answer') {
          const sdp = typeof payload['sdp'] === 'string' ? payload['sdp'] : '';
          if (sdp.length > VOICE_SDP_MAX_BYTES) {
            events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'Voice SDP payload is too large.', false, undefined, nowMs));
            break;
          }
        }
        // ICE candidate cap (P2): 8 KB, same as the SDP cap — an
        // unbounded `candidate` is a free-text smuggling channel.
        if (payload['candidate'] !== undefined) {
          let candidateSize = 0;
          try {
            candidateSize = JSON.stringify(payload['candidate'])?.length ?? 0;
          } catch {
            candidateSize = VOICE_CANDIDATE_MAX_BYTES + 1;
          }
          if (candidateSize > VOICE_CANDIDATE_MAX_BYTES) {
            events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'Voice ICE candidate is too large.', false, undefined, nowMs));
            break;
          }
        }
        events.push(
          this.emit(
            'voice.signal',
            {
              fromPlayerId: playerId,
              toPlayerId,
              kind,
              ...(typeof payload['sdp'] === 'string' ? { sdp: payload['sdp'] } : {}),
              ...(payload['candidate'] !== undefined ? { candidate: payload['candidate'] } : {}),
            },
            [toPlayerId],
            nowMs,
          ),
        );
        break;
      }
      case 'pin.place': {
        const point = payload['point'] as GeoPoint | undefined;
        const label = payload['label'];
        if (
          !point ||
          typeof point.lat !== 'number' ||
          typeof point.lng !== 'number' ||
          point.lat < -90 ||
          point.lat > 90 ||
          point.lng < -180 ||
          point.lng > 180 ||
          typeof label !== 'string' ||
          label.length > 140
        ) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'pin.place needs a valid point and a label up to 140 characters.', false, undefined, nowMs));
          break;
        }
        events.push(
          this.emit(
            'pin',
            {
              pin: {
                pinId: newId(),
                roomId: this.room.roomId,
                playerId,
                point,
                label,
                createdAt: new Date(nowMs).toISOString(),
              },
            },
            this.allPlayerIds(),
            nowMs,
          ),
        );
        break;
      }
      case 'announcement.send': {
        const text = payload['text'];
        if (typeof text !== 'string' || text.trim().length === 0 || text.length > 500) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'Announcements must be 1–500 characters.', false, undefined, nowMs));
          break;
        }
        const ann: Announcement = {
          announcementId: newId(),
          roomId: this.room.roomId,
          playerId,
          senderName: me.displayName,
          text,
          sentAt: new Date(nowMs).toISOString(),
        };
        this.mem.announcements.push(ann);
        if (this.mem.announcements.length > 50) {
          this.mem.announcements.splice(0, this.mem.announcements.length - 50);
        }
        events.push(this.emit('announcement', { announcement: ann }, this.allPlayerIds(), nowMs));
        break;
      }
      case 'auth.refresh': {
        // The class handles auth.refresh itself (it owns the socket's ticket
        // binding); reaching here means the class already swapped it.
        events.push(direct('auth.refreshed', { expiresAt: nowMs + WS_TICKET_TTL_MS, serverTs: new Date(nowMs).toISOString() }));
        break;
      }
      default: {
        events.push(
          this.errorEvent(playerId, 'VALIDATION_FAILED', `Unknown message type: ${type}.`, false, undefined, nowMs),
        );
        break;
      }
    }

    // v29 (Gap 5) — catch-confirm duration: how long the confirm
    // path took, wall-clock. Only the catch ops are logged (never
    // every fix / heartbeat / snapshot / ping).
    if (type === 'catch.confirm' || type === 'catch.request' || type === 'catch.self-confirm') {
      this.queueLog({
        level: 'info',
        message: 'catch.confirm.duration',
        roomId: this.room.roomId,
        playerId,
        operation: type,
        durationMs: Date.now() - receivedWallMs,
      });
    }
    // v29 (Gap 5) — flush buffered structured logs piggybacked on
    // this message's persist batch when one is already going out.
    // (When there is no batch, the buffer rides the next batch or
    // the alarm tick — never a save of its own.)
    if (persist.length > 0) {
      const logIntent = this.takeLogBatchIntent();
      if (logIntent !== null) persist.push(logIntent);
    }
    rememberReply(events);
    // Durable iff a persist intent was produced OR durable DO state
    // changed with no Supabase row (`stateDirty` — the runner-token
    // mint). Everything else — heartbeat ack, snapshot, GPS fix,
    // radio/signal/voice/pin relay — is transient: the caller skips
    // putSession + save + re-arm for it.
    return { events, persist, durable: persist.length > 0 || stateDirty, disconnect };
  }
}

// Re-exported for the class: heartbeat / renewal calibration in one place.
export const HEARTBEAT = {
  intervalMs: HEARTBEAT_INTERVAL_MS,
  renewalWarningMs: RENEWAL_WARNING_MS,
};
