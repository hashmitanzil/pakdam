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
 *   pause/SOS state, lightweight event log, shrinkIndexApplied, the WS
 *   ticket registry (hashes only), idempotency records + cached replies,
 *   pending pings (+ per-recipient delivery state), and the pending
 *   shrink preview boundary. A wake must not invalidate a minted ticket,
 *   lose a retry's reply, or drop a ping that was never delivered (P1-5).
 * - Memory only (never persisted): latest fixes (purged after 30 s —
 *   the LOCATION_FRESHNESS_SECONDS window — and at match end),
 *   outside-zone countdowns, WS rate-limit windows, raw catch tokens,
 *   announcements. Never persisted, ever: raw coordinates, raw tokens
 *   of any kind, WS ticket values.
 *
 * Server caps (P2): safety pause / SOS / leave `reason` ≤ 500 chars;
 * voice.signal `candidate` ≤ 8 KB (same as SDP); bug/grievance
 * deviceInfo / appVersion / complainantRef ≤ 500 chars (enforced in
 * http.ts); HTTP + DO /op bodies ≤ 1 MB (413 above).
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
  HEARTBEAT_INTERVAL_MS,
  HTTP_RATE_LIMITS,
  LOCATION_FRESHNESS_SECONDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  OUTSIDE_ZONE_RETURN_SECONDS,
  PREVIEW_LEAD_SECONDS,
  QUICK_SIGNALS,
  RADIO_MAX_CHARS,
  RENEWAL_WARNING_MS,
  VOICE_SDP_MAX_BYTES,
  WS_MESSAGE_RATE_LIMITS,
  WS_MESSAGE_RATE_LIMIT_DEFAULT,
  WS_TICKET_TTL_MS,
  classifyAccuracy,
  hashHostToken,
  hashReconnectToken,
  helloHasCredential,
  isValidCatchToken,
  isValidDisplayName,
  isValidRoomCode,
  newId,
  randomHex,
  validateFix,
  validateRoomConfig,
  type Announcement,
  type CatchEvent,
  type CatchView,
  type GameEvent,
  type GeoPoint,
  type GeoPolygon,
  type LocationFix,
  type LocationQuality,
  type MatchPhase,
  type MatchResult,
  type Ping,
  type Player,
  type PlayerView,
  type RadioMessage,
  type RevealArea,
  type Room,
  type RoomConfig,
  type SafetyState,
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
  isDuplicateCommand,
  isPendingCatch,
  isTerminalPhase,
  issueCatchToken,
  maybeCompleteOnWin,
  openCatchForRunner,
  pauseMatch,
  previewShrinkBoundary,
  purgeIdempotency,
  purgeExpiredPings,
  raiseSos,
  randomOffsetShrinkBoundary,
  recordSuspension,
  rememberCommand,
  requestCatch,
  resolveCatch,
  resolveModeOutcome,
  resumeMatch,
  resumeSuspendedPlayer,
  safetyStateAfterResume,
  scoreMatch,
  shrinkIndexAt,
  toCatchView,
  transitionForEvent,
  transitionOrThrow,
  updateOutsideZone,
  verifyCatchToken,
  isPointInZone,
  type IdempotencyRecord,
  type OutsideZoneState,
} from '@pakdam/engine';
import type { PersistIntent } from './supabase.js';

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
  sosActive: boolean;
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
   * Per-ping recipients still awaiting delivery: pingId -> playerIds.
   * A ping leaves `pendingPings` only when every recipient has received
   * it (per-recipient ack); an offline Hunter still gets it on reconnect.
   */
  pendingPingRecipients: Record<string, string[]>;
  /**
   * The previewed next-zone boundary (P1-18): drawn PREVIEW_LEAD_SECONDS
   * before the shrink and applied verbatim when the shrink fires, so the
   * preview is the real next zone — never a second, different draw.
   */
  pendingShrink: {
    boundary: GeoPolygon;
    firesAtMs: number;
    shrinkIndex: number;
  } | null;
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
}

/** Start gate: a fix counts as fresh for 120 s at start time (P1-7). */
export const START_GPS_FRESHNESS_MS = 120_000;

/**
 * Player-row persist throttle (Phase 3 #2): a location.update emits a
 * Supabase player-upsert at most once per 30 s per seat (or sooner when
 * something durable actually changed — quality, role, connection). 30 s
 * is far inside the 120 s start-gate window, and the live in-memory fix
 * is the gate's primary source anyway; the durable lastFixAt is only
 * the hibernate/wake fallback.
 */
export const PLAYER_PERSIST_INTERVAL_MS = 30_000;

/** GPS fix throttle (Phase 3 #2): at most ~1 accepted fix/s/seat. */
export const GPS_FIX_MIN_INTERVAL_MS = 1_000;

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

/** Free-text caps (P2): safety pause / SOS / leave `reason`. */
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
    wsRate: new Map(),
    idempotency: new Map(),
    rawCatchTokens: new Map(),
    announcements: [],
    lastDisconnectAtMs: {},
    idempotentReplies: new Map(),
    pendingPingRecipients: new Map(),
    lastPlayerPersistAtMs: {},
    lastFixAcceptedAtMs: {},
    recentRadio: new Map(),
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
    sosActive: state.sosActive,
    eventLog: state.eventLog,
    shrinkIndexApplied: state.shrinkIndexApplied,
    tickets: state.tickets,
    idempotency: state.idempotency,
    idempotentReplies: state.idempotentReplies,
    pendingPings: state.pendingPings,
    pendingPingRecipients: state.pendingPingRecipients,
    pendingShrink: state.pendingShrink,
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
    sosActive: s.sosActive ?? false,
    eventLog: s.eventLog ?? [],
    shrinkIndexApplied: s.shrinkIndexApplied ?? 0,
    // P1-5 fields: older durable writes lack them — empty is the honest
    // default (a pre-fix ticket simply does not survive the wake).
    tickets: s.tickets ?? [],
    idempotency: s.idempotency ?? [],
    idempotentReplies: s.idempotentReplies ?? [],
    pendingPings: s.pendingPings ?? [],
    pendingPingRecipients: s.pendingPingRecipients ?? {},
    pendingShrink: s.pendingShrink ?? null,
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
   * commands (radio.send, signal.send, pin.place, announcement.send,
   * safety.sos, reveal.send): they carry no server state to conflict
   * on, so a retry that mints a NEW commandId re-applies them.
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
      sosActive: this.state.sosActive,
    };
  }

  /**
   * Per-viewer location status, teammates-only during play (P2 liveness
   * leak): an opponent's freshness must not leak to the other team. The
   * viewer always sees their own status; in the LOBBY there are no teams
   * yet, so the whole lobby sees each other (the start gate needs it).
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
    });
  }

  // -- audit log ------------------------------------------------------------

  /** Redacted game-event log entry (coordinates stripped, cap 500). */
  logGameEvent(
    type: GameEvent['type'],
    actorId: string | null,
    payload: Record<string, unknown>,
    nowMs: number = Date.now(),
  ): PersistIntent {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (['lat', 'lng', 'latitude', 'longitude', 'fix', 'centre'].includes(k)) continue;
      clean[k] = v;
    }
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
    if (!reconnectTokenHash) return null;
    const p = this.player(playerId);
    if (!p) return null;
    return p.reconnectTokenHash === reconnectTokenHash ? p : null;
  }

  verifyHost(playerId: string, hostTokenHash: string | null): Player | null {
    if (!hostTokenHash) return null;
    const p = this.player(playerId);
    if (!p || !p.isHost) return null;
    return this.state.hostTokens[playerId] === hostTokenHash ? p : null;
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
      sosActive: false,
      eventLog: [],
      shrinkIndexApplied: 0,
      tickets: [],
      idempotency: [],
      idempotentReplies: [],
      pendingPings: [],
      pendingPingRecipients: {},
      pendingShrink: null,
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
      if (existing.leftAt !== null && existing.ejectedAt === null) {
        existing.leftAt = null;
      }
      if (existing.connectionState === 'suspended') {
        const r = resumeSuspendedPlayer(existing, nowMs);
        Object.assign(existing, r.player);
      } else if (existing.leftAt === null) {
        existing.connectionState = 'connected';
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
    if (player.playerId === viewerPlayerId) return rest;
    return { ...rest, matchRole: null, team: null };
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

  /** Mint / rotate the host token for the host seat (previous token dies). */
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
    host.isHost = false;
    next.isHost = true;
    this.state.room.hostPlayerId = next.playerId;
    this.bumpVersion();
    const events = [
      this.emit(
        'host.transferred',
        { previousHostPlayerId: host.playerId, newHostPlayerId: next.playerId },
        this.allPlayerIds(),
        input.nowMs,
      ),
      this.roomStateEvent('host-transferred', input.nowMs),
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
    // P1-7 start gate: the zone must be placed (a boundary of ≥ 3 points)
    // and every active player must have a fix ≤ 120 s old. The error names
    // the players without GPS in plain words. Freshness uses the live fix
    // first, falling back to the durable `lastFixAt` (which survives a
    // hibernate/wake while the live fix does not). Lobby clients stream
    // fixes continuously, so a fresh fix is the normal case — a missing
    // one means that player's GPS is off or the app is backgrounded.
    const config = this.room.config;
    if (!config.zone || config.zone.boundary.length < 3) {
      return errResult(
        'Set the play zone first — the zone needs at least 3 points on the map.',
        'CONFLICT',
        409,
      );
    }
    const withoutGps = active.filter((p) => {
      const live = this.mem.latestFix[p.playerId];
      const liveMs = live ? nowMs - live.timestampMs : Number.POSITIVE_INFINITY;
      const lastMs =
        p.lastFixAt === null
          ? Number.POSITIVE_INFINITY
          : nowMs - Date.parse(p.lastFixAt);
      return Math.min(liveMs, lastMs) > START_GPS_FRESHNESS_MS;
    });
    if (withoutGps.length > 0) {
      return errResult(
        `Waiting for GPS from ${withoutGps.map((p) => p.displayName).join(', ')} — their location has not been reported in the last 2 minutes.`,
        'CONFLICT',
        409,
      );
    }
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
    // against the NEW values (the lobby's normaliseConfig fills/trims it
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
    const seat = this.verifyReconnect(input.playerId, input.reconnectTokenHash);
    if (!seat) {
      return errResult('Seat not found or reconnect token does not match.', 'FORBIDDEN', 403);
    }
    if (seat.leftAt !== null) {
      return errResult('That seat has left the room.', 'CONFLICT', 409);
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
  }): OpResult<{ revoked: number }> {
    const seat = this.verifyReconnect(input.playerId, input.reconnectTokenHash);
    if (!seat) {
      return errResult('Seat not found or reconnect token does not match.', 'FORBIDDEN', 403);
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
    if (!seat || seat.leftAt !== null) {
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
      (c as CatchEvent & { previousQrTokenHash?: string | null }).previousQrTokenHash = prev;
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
    });
    if (!resumed.ok) {
      return errResult(resumed.reason, resumed.code, 409);
    }
    this.room.startedAt = resumed.startedAt;
    this.room.endsAt = resumed.endsAt;
    this.room.pausedAt = null;
    this.room.phase = resumed.phase;
    this.state.paused = false;
    this.state.pausedBy = null;
    this.state.pausedFrom = null;
    void safetyStateAfterResume(this.safetyState());
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
    this.bumpVersion();
    // Fixes are purged at match end; raw catch tokens die with the match.
    this.mem.latestFix = {};
    this.mem.outsideZone = {};
    this.mem.rawCatchTokens.clear();
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

  cancelMatch(
    byPlayerId: string,
    nowMs: number,
  ): OpResult<{ phase: MatchPhase; result: MatchResult }> {
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
    this.bumpVersion();
    const events = [
      this.emit('match.cancelled', { result }, this.allPlayerIds(), nowMs),
      this.roomStateEvent('match-cancelled', nowMs),
    ];
    const persist: PersistIntent[] = [
      { kind: 'match-result', room: this.room },
      { kind: 'room-upsert', room: this.room },
    ];
    void byPlayerId;
    return okResult({ phase: this.room.phase, result }, events, persist);
  }

  /** REST lifecycle: start / pause / resume / end. Pause is any player; the rest host-only. */
  lifecycleOp(input: {
    action: 'start' | 'pause' | 'resume' | 'end';
    playerId: string;
    hostTokenHash?: string | null;
    reconnectTokenHash?: string | null;
    nowMs: number;
  }): OpResult<Record<string, unknown>> {
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
    const seat = this.verifyReconnect(input.playerId, input.reconnectTokenHash);
    if (!seat) {
      return errResult('Seat not found or reconnect token does not match.', 'FORBIDDEN', 403);
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
    const scored = scoreMatch({
      players: this.state.players.map((p) => {
        const freeUntil =
          p.matchRole === 'runner'
            ? p.ejectedAt !== null
              ? Date.parse(p.ejectedAt)
              : caught.has(p.playerId)
                ? Date.parse(
                    this.state.catches.find(
                      (c) => c.runnerPlayerId === p.playerId && c.state === 'confirmed',
                    )?.confirmedAt ?? new Date(endedAtMs).toISOString(),
                  )
                : endedAtMs
            : endedAtMs;
        return {
          playerId: p.playerId,
          matchRole: p.matchRole,
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
    const r = resumeSuspendedPlayer(seat, nowMs);
    if (!r.resumed) return { resumed: false, events: [], persist: [] };
    Object.assign(seat, r.player);
    const events = [
      this.emit('player.resumed', { playerId }, this.allPlayerIds(), nowMs),
    ];
    const persist: PersistIntent[] = [
      { kind: 'player-upsert', roomId: this.room.roomId, player: seat },
    ];
    persist.push(
      this.logGameEvent('PLAYER_RECONNECTED', playerId, { playerId }, nowMs),
    );
    return { resumed: true, events, persist };
  }

  /** Socket close marks the seat suspended — NEVER removal. */
  suspendSeat(
    playerId: string,
    reason: 'tab-hidden' | 'screen-locked' | 'network-lost' | 'heartbeat-timeout' | 'unknown',
    nowMs: number,
  ): { events: OutboundEvent[]; persist: PersistIntent[]; needsHostCheckin: boolean } {
    const seat = this.player(playerId);
    if (!seat || seat.connectionState === 'suspended') {
      return { events: [], persist: [], needsHostCheckin: false };
    }
    const r = recordSuspension(seat, reason);
    Object.assign(seat, r.player);
    this.mem.lastDisconnectAtMs[playerId] = nowMs;
    const events = [
      this.emit('player.suspended', { playerId, reason }, this.allPlayerIds(), nowMs),
    ];
    const persist: PersistIntent[] = [
      { kind: 'player-upsert', roomId: this.room.roomId, player: seat },
    ];
    persist.push(
      this.logGameEvent('PLAYER_DISCONNECTED', playerId, { playerId, reason }, nowMs),
    );
    return { events, persist, needsHostCheckin: r.needsHostCheckin };
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
    const events: OutboundEvent[] = [
      ...this.emitPlayerEvent('player.left', seat, nowMs),
    ];
    const persist: PersistIntent[] = [
      { kind: 'player-upsert', roomId: this.room.roomId, player: seat },
    ];
    if (seat.isHost) {
      const next = this.state.players
        .filter((p) => p.leftAt === null)
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
  alarmTick(nowMs: number): { events: OutboundEvent[]; persist: PersistIntent[] } {
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
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
      return { events, persist };
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
          this.bumpVersion();
          events.push(this.roomStateEvent('lobby-expired', nowMs));
          persist.push({ kind: 'room-upsert', room: this.room });
        }
        return { events, persist };
      }
    }
    if (this.room.startedAt === null) return { events, persist };

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
    if (!livePhase) return { events, persist };

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
      return { events, persist };
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
        // player is still outside the zone.
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
            return { events, persist };
          }
        }
      }
    }

    // (5) Zone shrink — ACTIVE ONLY (P2): shrinks never fire during
    // HEAD_START. The next zone is previewed PREVIEW_LEAD_SECONDS (30 s)
    // ahead (P1-18) via `previewShrinkBoundary` and STORED, so the
    // previewed boundary is the one applied when the shrink fires —
    // never a second, different draw.
    if (
      this.room.phase === 'ACTIVE' &&
      this.room.config.zoneShrinkEnabled &&
      this.room.config.zone.boundary.length >= 3
    ) {
      const intervalSeconds = this.room.config.zoneShrinkIntervalSeconds;
      const nextIndex = this.state.shrinkIndexApplied;
      const nextFireInSeconds = (nextIndex + 1) * intervalSeconds;
      if (nextFireInSeconds < this.room.config.durationSeconds) {
        const firesAtMs = startedAtMs + nextFireInSeconds * 1000;
        if (firesAtMs > nowMs && firesAtMs - nowMs <= PREVIEW_LEAD_SECONDS * 1000) {
          const pending = this.state.pendingShrink;
          if (!pending || pending.shrinkIndex !== nextIndex) {
            const drawn = previewShrinkBoundary(this.room.config.zone.boundary);
            this.state.pendingShrink = {
              boundary: drawn.boundary,
              firesAtMs,
              shrinkIndex: nextIndex,
            };
            this.bumpVersion();
            events.push(
              this.emit(
                // 'zone.preview' is defined by the engine/shared contract
                // (Meera); the cast goes away once it lands in
                // WsServerPayloads.
                'zone.preview' as WsServerMessageType,
                { boundary: drawn.boundary, firesAtMs, shrinkIndex: nextIndex },
                this.allPlayerIds(),
                nowMs,
              ),
            );
            persist.push({ kind: 'room-upsert', room: this.room });
          } else if (pending.firesAtMs !== firesAtMs) {
            // The pause shifted the deadlines: refresh the stored fire
            // time and re-broadcast so the countdown stays honest.
            pending.firesAtMs = firesAtMs;
            this.bumpVersion();
            events.push(
              this.emit(
                'zone.preview' as WsServerMessageType,
                { boundary: pending.boundary, firesAtMs, shrinkIndex: nextIndex },
                this.allPlayerIds(),
                nowMs,
              ),
            );
            persist.push({ kind: 'room-upsert', room: this.room });
          }
        }
      }
      const target = shrinkIndexAt(
        elapsedSeconds,
        intervalSeconds,
        true,
      );
      while (this.state.shrinkIndexApplied < target) {
        const idx = this.state.shrinkIndexApplied;
        const pending = this.state.pendingShrink;
        // Use the previewed boundary for this shrink when one was stored;
        // otherwise draw fresh (e.g. the shrink fired without a preview
        // because the DO woke after its fire time).
        const boundary =
          pending && pending.shrinkIndex === idx
            ? pending.boundary
            : randomOffsetShrinkBoundary(this.room.config.zone.boundary).boundary;
        if (pending && pending.shrinkIndex === idx) this.state.pendingShrink = null;
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
    return { events, persist };
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
  private static readonly NON_MUTATING_TYPES: ReadonlySet<string> = new Set([
    'heartbeat',
    'location.update',
    'snapshot.request',
    'resync.request',
    'voice.signal',
  ]);

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
   * always return `durable: true` — via a non-empty `persist`, or via
   * `durableChanged` for the rare mutation with no Supabase intent
   * (reveal.send's `lastFixAt`).
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
  }> {
    const playerId = session.playerId;
    const me = this.player(playerId);
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
    const type = envelope.type;
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    // Set by cases that mutate durable state without emitting a persist
    // intent (reveal.send's lastFixAt). Anything with a persist intent is
    // durable by construction.
    let durableChanged = false;

    // P1-9: cache the ACTUAL reply — broadcast events included, not an
    // empty list. A genuine same-commandId replay gets the original
    // reply (narrowed to the replier at the top of this function), never
    // an empty `[]` that looks like success-with-nothing. Only events
    // addressed to this player are cached: a direct event to the replier,
    // or a broadcast the replier was among (its payload is identical for
    // every recipient). Per-viewer events (emitPlayerEvent's role-filtered
    // copies for OTHER seats) are never cached — replaying one to the
    // wrong viewer would hand them another seat's view.
    // Hoisted above the early returns (Phase 4 (q)): the !me / leftAt /
    // rate-limit / leave returns below must cache their error reply too
    // — previously they returned without caching, so a same-commandId
    // retry got an empty [] that looked like success.
    const rememberReply = (evts: OutboundEvent[]): void => {
      // Non-mutating messages never recorded a commandId (see above), so
      // there is nothing to cache for them.
      if (RoomStore.NON_MUTATING_TYPES.has(type)) return;
      if (typeof envelope.commandId === 'string' && envelope.commandId.length > 0) {
        this.mem.idempotentReplies.set(
          `${playerId}:${envelope.commandId}`,
          evts.filter(
            (e) =>
              (e.recipients.length === 1 && e.recipients[0] === playerId) ||
              (e.recipients.length > 1 && e.recipients.includes(playerId)),
          ),
        );
      }
    };

    // Phase 4 (q) — cache an early return's error as its reply. The
    // idempotency block below has not run yet for the !me / leftAt
    // returns, so the commandId is recorded here as well (calling
    // rememberCommand twice — rate-limit / leave — only refreshes
    // seenAtMs, which is harmless). A retry then reaches the cached
    // error instead of an empty [].
    const cacheEarlyReply = (evts: OutboundEvent[]): void => {
      if (RoomStore.NON_MUTATING_TYPES.has(type)) return;
      if (typeof envelope.commandId === 'string' && envelope.commandId.length > 0) {
        rememberCommand(this.mem.idempotency, playerId, envelope.commandId, nowMs);
        rememberReply(evts);
      }
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
    // A socket past its ticket expiry is closed 4401. (The class checks
    // this on every message too; this is the store-side guard.)
    // NOTE: the class passes the session ticket expiry separately.

    // Idempotency: a retry reuses the same commandId; replays get the
    // original reply without re-applying or burning rate budget. The
    // cached reply is delivered ONLY to the replaying player (recipients
    // narrowed below) so a broadcast op is never re-broadcast to the
    // whole room on a retry. SKIPPED for non-mutating messages (Phase 3
    // #3): location.update / heartbeat / snapshot / resync / voice.signal
    // carry no mutation to dedupe, and recording them only grew the map.
    if (
      !RoomStore.NON_MUTATING_TYPES.has(type) &&
      typeof envelope.commandId === 'string' &&
      envelope.commandId.length > 0
    ) {
      if (isDuplicateCommand(this.mem.idempotency, playerId, envelope.commandId, nowMs)) {
        const cached = this.mem.idempotentReplies.get(`${playerId}:${envelope.commandId}`) ?? [];
        const narrowed = cached.map((e) => ({ ...e, recipients: [playerId] }));
        return { events: narrowed, persist, durable: false };
      }
      // In-place (Phase 3 #3): no `new Map(seen)` copy per message.
      rememberCommand(this.mem.idempotency, playerId, envelope.commandId, nowMs);
    }

    // Per-message rate limit (player.suspended is exempt).
    const rl = this.checkWsRateLimit(playerId, type, nowMs);
    if (!rl.allowed) {
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
        events.push(this.emit('snapshot', this.snapshotFor(playerId, nowMs) as unknown as Record<string, unknown>, [playerId], nowMs));
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
        const lastAccepted = this.mem.lastFixAcceptedAtMs[playerId] ?? 0;
        if (nowMs - lastAccepted < GPS_FIX_MIN_INTERVAL_MS) {
          // Coalesced fix: no reply is cached here on purpose —
          // location.update is NON_MUTATING, so no commandId was ever
          // recorded for it and there is no retry to serve (Phase 4 (q)
          // does not apply to this return).
          return { events, persist, durable: false };
        }
        this.mem.lastFixAcceptedAtMs[playerId] = nowMs;
        this.mem.latestFix[playerId] = goodFix;
        // Phase 4 (i) — snapshot-key fix: an accepted fix mutates
        // snapshot content (players[].lastFixAt, teammateFixes, and the
        // time-derived locationStatus) without any emit, so the
        // (version, serverSeq) key the client gates HTTP snapshots on
        // would not move and a re-fetch could be skipped as identical
        // while fixes aged in between. Advance serverSeq (in-memory
        // only — this case still returns durable:false unless a persist
        // is due, so no save is written per fix; the bump persists with
        // the next durable save). reveal.send needs no bump here: it
        // always emits, which advances the sequence itself.
        this.nextSeq();
        me.lastFixAt = new Date(nowMs).toISOString();
        const quality: LocationQuality = check.quality ?? classifyAccuracy(goodFix.accuracyMeters);
        const qualityChanged = me.locationQuality !== quality;
        me.locationQuality = quality;
        const prevConnection = me.connectionState;
        let resumed = false;
        if (me.connectionState === 'suspended') {
          const r = resumeSuspendedPlayer(me, nowMs);
          Object.assign(me, r.player);
          resumed = true;
          events.push(this.emit('player.resumed', { playerId }, this.allPlayerIds(), nowMs));
        } else {
          me.connectionState = 'connected';
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
      case 'reveal.send': {
        const fix = payload['fix'] as LocationFix | undefined;
        const check = validateFix(fix, this.mem.latestFix[playerId] ?? null, nowMs);
        if (!fix) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'Reveal needs a fresh fix.', false, undefined, nowMs));
          break;
        }
        if (!check.ok) {
          // Same code mapping as location.update: malformed is
          // VALIDATION_FAILED, only too-old is STALE_LOCATION.
          events.push(this.errorEvent(playerId, check.code ?? 'VALIDATION_FAILED', check.errors.join(' ') || 'Reveal needs a fresh fix.', false, undefined, nowMs));
          break;
        }
        // Reveals are a manual ping (a 150 m circle around the sender's
        // exact fix, shown to the whole room) — ACTIVE only, never during
        // HEAD_START, or a Runner could hand the Hunters their position
        // before the hunt starts (and vice versa).
        if (this.room.phase !== 'ACTIVE') {
          events.push(this.errorEvent(playerId, 'INVALID_STATE', 'Reveals start once the head start ends.', false, undefined, nowMs));
          break;
        }
        this.mem.latestFix[playerId] = fix;
        me.lastFixAt = new Date(nowMs).toISOString();
        // No Supabase intent here (as before), but the lastFixAt change
        // IS durable state — flag it so the caller saves.
        durableChanged = true;
        const centre: GeoPoint = { lat: fix.lat, lng: fix.lng };
        const reveal: RevealArea = {
          revealId: newId(),
          roomId: this.room.roomId,
          byPlayerId: playerId,
          centre,
          radiusMeters: 150,
          sentAt: new Date(nowMs).toISOString(),
        };
        events.push(this.emit('reveal', { reveal }, this.allPlayerIds(), nowMs));
        break;
      }
      case 'catch.request': {
        const runnerId = payload['runnerId'];
        if (typeof runnerId !== 'string') {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', 'catch.request needs runnerId.', false, undefined, nowMs));
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
        const { token, tokenHash } = await issueCatchToken(claim.catchId);
        claim.qrTokenHash = tokenHash;
        this.mem.rawCatchTokens.set(claim.catchId, {
          token,
          expiresAtMs: Date.parse(claim.requestedAt) + CATCH_TOKEN_TTL_SECONDS * 1000,
        });
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
        const previousHash =
          (c as CatchEvent & { previousQrTokenHash?: string | null }).previousQrTokenHash ?? null;
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
      case 'safety.sos': {
        const reason = typeof payload['reason'] === 'string' ? (payload['reason'] as string) : null;
        if (reason !== null && reason.length > REASON_MAX_CHARS) {
          events.push(this.errorEvent(playerId, 'VALIDATION_FAILED', `SOS reason must be at most ${REASON_MAX_CHARS} characters.`, false, undefined, nowMs));
          break;
        }
        const next = raiseSos(this.safetyState());
        this.state.sosActive = next.sosActive;
        events.push(
          this.emit(
            'sos.raised',
            { byPlayerId: playerId },
            // Dedupe: when the host raises SOS the host is both the
            // recipient and the raiser — one copy, not two.
            [...new Set([this.room.hostPlayerId, playerId])],
            nowMs,
          ),
        );
        persist.push({
          kind: 'safety-event',
          roomId: this.room.roomId,
          playerId,
          type: 'sos',
          reason,
        });
        break;
      }
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
        const reason = payload['reason'];
        const valid =
          reason === 'tab-hidden' ||
          reason === 'screen-locked' ||
          reason === 'network-lost' ||
          reason === 'heartbeat-timeout' ||
          reason === 'unknown'
            ? (reason as 'tab-hidden' | 'screen-locked' | 'network-lost' | 'heartbeat-timeout' | 'unknown')
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
        // unguarded. safety.sos must NEVER be dropped — a second SOS
        // is a second distress call, and raiseSos is already
        // state-idempotent (sosActive stays true); only its audit row
        // would double-log, which is intended. pin.place / reveal.send
        // are deliberate re-assertions (a re-placed pin or a fresh
        // reveal is a new marker / a new position broadcast, each with
        // a fresh id). signal.send is a transient toast with no server
        // state — a duplicate only re-flashes it, and suppressing a
        // quick signal the sender deliberately re-tapped would hide a
        // live "I need help" repeat. Radio is the one where a duplicate
        // is both likely (chat send double-tap) and pure noise.
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

    rememberReply(events);
    // Durable iff a persist intent was produced or a case flagged a
    // durable change with no intent (reveal.send). Everything else —
    // heartbeat ack, snapshot, GPS fix, radio/signal/voice/pin relay —
    // is transient: the caller skips putSession + save + re-arm for it.
    return { events, persist, durable: persist.length > 0 || durableChanged };
  }
}

// Re-exported for the class: heartbeat / renewal calibration in one place.
export const HEARTBEAT = {
  intervalMs: HEARTBEAT_INTERVAL_MS,
  renewalWarningMs: RENEWAL_WARNING_MS,
};
