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
 *   pause/SOS state, lightweight event log, shrinkIndexApplied.
 * - Memory only (never persisted): latest fixes (purged after 120 s and at
 *   match end), pending pings, outside-zone countdowns, WS tickets, WS
 *   rate-limit windows, idempotency set, raw catch tokens, announcements.
 * Never persisted, ever: raw coordinates, raw tokens of any kind, WS
 * ticket values.
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
  CATCH_TOKEN_TTL_SECONDS,
  FIX_TTL_MS,
  GAME_EVENT_LOG_CAP,
  HEARTBEAT_INTERVAL_MS,
  HTTP_RATE_LIMITS,
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
  classifyAccuracy,
  hashHostToken,
  hashReconnectToken,
  helloHasCredential,
  isValidCatchToken,
  isValidDisplayName,
  isValidRoomCode,
  locationStatusForPlayer,
  newId,
  randomHex,
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
  issueCatchToken,
  maybeCompleteOnWin,
  openCatchForRunner,
  pauseMatch,
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
}

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

  safetyState(): SafetyState {
    return {
      paused: this.state.paused,
      pausedBy: this.state.pausedBy,
      pausedAt: this.room.pausedAt,
      sosActive: this.state.sosActive,
    };
  }

  locationStatus(nowMs: number): Record<string, 'known' | 'unknown'> {
    const out: Record<string, 'known' | 'unknown'> = {};
    for (const p of this.state.players) {
      out[p.playerId] = locationStatusForPlayer(
        p.lastFixAt === null ? null : Date.parse(p.lastFixAt),
        nowMs,
      );
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
      locationStatus: this.locationStatus(nowMs),
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
   */
  private emitPlayerEvent(
    type: 'player.joined' | 'player.removed' | 'player.left',
    player: Player,
    nowMs: number,
  ): OutboundEvent[] {
    return this.allPlayerIds().map((viewerId) =>
      this.emit(type, { player: this.playerViewFor(viewerId, player) }, [viewerId], nowMs),
    );
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
    const config = this.room.config;
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
    this.mem.tickets = this.mem.tickets.filter(
      (t) => !(t.playerId === input.playerId && !t.redeemed),
    );
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
      const done = this.completeMatch(win, nowMs);
      events.push(...done.events);
      persist.push(...done.persist);
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
      return okResult({ token: held.token, catchId: c.catchId, expiresAt }, sweep.events, sweep.persist);
    }
    // Raw token lost (e.g. DO hibernated — raw tokens are memory-only):
    // mint a fresh one for the same pending catch; the old token is dead.
    const { token, tokenHash } = await issueCatchToken(c.catchId);
    c.qrTokenHash = tokenHash;
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
    const paused = pauseMatch(this.room.phase, byPlayerId, nowMs);
    if (!paused.ok) {
      return errResult(paused.reason, paused.code, 409);
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

  /** Complete the match with a result (via RESOLVING; clock already stopped). */
  completeMatch(
    result: MatchResult,
    nowMs: number,
  ): { events: OutboundEvent[]; persist: PersistIntent[] } {
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
    try {
      if (this.room.phase !== 'RESOLVING') {
        this.room.phase = transitionOrThrow(this.room.phase, 'RESOLVING');
      }
      this.room.phase = transitionOrThrow(this.room.phase, 'COMPLETED');
    } catch {
      return { events, persist };
    }
    this.room.result = result;
    this.bumpVersion();
    // Fixes are purged at match end; raw catch tokens die with the match.
    this.mem.latestFix = {};
    this.mem.outsideZone = {};
    this.mem.rawCatchTokens.clear();
    this.mem.pendingPings = [];
    events.push(
      this.emit('match.completed', { result }, this.allPlayerIds(), nowMs),
      this.roomStateEvent('match-completed', nowMs),
    );
    persist.push(
      this.logGameEvent('MATCH_COMPLETED', null, { result, room: { roomId: this.room.roomId, phase: this.room.phase } }, nowMs),
      { kind: 'match-result', room: this.room },
      { kind: 'room-upsert', room: this.room },
    );
    return { events, persist };
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
      ejectedRunnerIds: [...ejected].filter((id) => {
        const p = this.player(id);
        return p !== undefined;
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
    // Everyone gone while live: the match is abandoned, not left hanging.
    if (
      (this.room.phase === 'HEAD_START' || this.room.phase === 'ACTIVE') &&
      this.activePlayers().length === 0
    ) {
      const durationSeconds =
        this.room.startedAt === null
          ? 0
          : Math.max(0, Math.floor((nowMs - Date.parse(this.room.startedAt)) / 1000));
      const result: MatchResult = {
        outcome: 'abandoned',
        durationSeconds,
        caughtRunnerIds: this.caughtRunnerIds(),
        survivingRunnerIds: freeRunnerIds(this.state.players, this.caughtRunnerIds()),
        tags: confirmedTags(this.state.catches),
      };
      try {
        this.room.phase = transitionOrThrow(this.room.phase, 'ABANDONED');
        this.room.result = result;
        this.bumpVersion();
        events.push(
          this.emit('match.cancelled', { result }, this.allPlayerIds(), nowMs),
          this.roomStateEvent('match-abandoned', nowMs),
        );
        persist.push({ kind: 'match-result', room: this.room });
      } catch {
        // Phase edge raced with the tick; the tick will complete it.
      }
    }
    return { events, persist };
  }

  // -- pending pings ----------------------------------------------------------

  /** Pings built but not yet delivered to any Hunter (TTL 300 s, memory only). */
  acknowledgePingDelivery(pingId: string, nowMs: number): void {
    const idx = this.mem.pendingPings.findIndex((p) => p.pingId === pingId);
    if (idx === -1) return;
    const [ping] = this.mem.pendingPings.splice(idx, 1);
    if (ping) this.state.lastPingAtMs[ping.subjectPlayerId] = nowMs;
  }

  /**
   * Pending pings for a player who just (re)connected. Pings are mutual
   * and role-scoped: a Hunter re-receives pending Runner pings
   * (recipientRole 'hunters'), a Runner re-receives pending Hunter pings
   * (recipientRole 'runners'). A player never receives a ping that reveals
   * their own team. The caller acknowledges delivery per ping.
   */
  pendingPingsFor(playerId: string, _nowMs: number): Ping[] {
    const me = this.player(playerId);
    if (!me || me.matchRole === null) return [];
    const role: 'hunters' | 'runners' = me.matchRole === 'hunter' ? 'hunters' : 'runners';
    return this.mem.pendingPings.filter((p) => p.recipientRole === role);
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
    for (const [pid, fix] of Object.entries(this.mem.latestFix)) {
      if (nowMs - fix.timestampMs > FIX_TTL_MS) delete this.mem.latestFix[pid];
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

    // (5) Zone shrink — draw the random-offset next zone, never concentric.
    if (
      this.room.config.zoneShrinkEnabled &&
      this.room.config.zone.boundary.length >= 3
    ) {
      const target = shrinkIndexAt(
        elapsedSeconds,
        this.room.config.zoneShrinkIntervalSeconds,
        true,
      );
      while (this.state.shrinkIndexApplied < target) {
        const drawn = randomOffsetShrinkBoundary(this.room.config.zone.boundary);
        this.room.config.zone.boundary = drawn.boundary;
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
    if (
      this.room.phase === 'ACTIVE' &&
      this.room.config.playZoneEnabled !== false &&
      this.room.config.pingIntervalSeconds > 0
    ) {
      const free = freeRunnerIds(this.state.players, this.caughtRunnerIds());
      const pendingSubjects = new Set(this.mem.pendingPings.map((p) => p.subjectPlayerId));
      const due = dueRunnerIds({
        freeRunnerIds: free.filter((id) => !pendingSubjects.has(id)),
        fixes: this.mem.latestFix,
        lastPingAtMs: this.state.lastPingAtMs,
        startedAtMs,
        intervalSeconds: this.room.config.pingIntervalSeconds,
        nowMs,
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
   * Dispatch one client message (hello already validated by the caller).
   * Returns outbound events, persist intents, and optionally a socket close.
   * The caller (DO class) delivers events, owns the socket, and executes
   * the persist intents via ctx.waitUntil().
   */
  async handleWsMessage(
    session: WsSessionRef,
    envelope: { type: string; commandId?: string; payload?: Record<string, unknown> },
    nowMs: number = Date.now(),
  ): Promise<{
    events: OutboundEvent[];
    persist: PersistIntent[];
    close?: { code: number; reason: string };
  }> {
    const playerId = session.playerId;
    const me = this.player(playerId);
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
    const type = envelope.type;
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    if (!me) {
      return {
        events: [this.errorEvent(playerId, 'ROOM_NOT_FOUND', 'Seat not found in this room.', false, undefined, nowMs)],
        persist,
        close: { code: 4403, reason: 'Seat not found.' },
      };
    }
    // A seat that left the room has no socket business left; its socket
    // should already be closed, so a message from it is a protocol error.
    if (me.leftAt !== null) {
      return {
        events: [this.errorEvent(playerId, 'FORBIDDEN', 'That seat has left the room.', false, undefined, nowMs)],
        persist,
        close: { code: 4403, reason: 'Seat has left the room.' },
      };
    }
    // A socket past its ticket expiry is closed 4401. (The class checks
    // this on every message too; this is the store-side guard.)
    // NOTE: the class passes the session ticket expiry separately.

    // Idempotency: a retry reuses the same commandId; replays get the
    // original direct reply without re-applying or burning rate budget.
    if (typeof envelope.commandId === 'string' && envelope.commandId.length > 0) {
      if (isDuplicateCommand(this.mem.idempotency, playerId, envelope.commandId, nowMs)) {
        const cached = this.mem.idempotentReplies.get(`${playerId}:${envelope.commandId}`) ?? [];
        return { events: [...cached], persist };
      }
      this.mem.idempotency = rememberCommand(this.mem.idempotency, playerId, envelope.commandId, nowMs);
    }

    // Per-message rate limit (player.suspended is exempt).
    const rl = this.checkWsRateLimit(playerId, type, nowMs);
    if (!rl.allowed) {
      return {
        events: [
          this.errorEvent(playerId, 'RATE_LIMITED', 'Too many messages — slow down.', true, rl.retryAfterSeconds, nowMs),
        ],
        persist,
      };
    }

    const direct = (t: WsServerMessageType, p: Record<string, unknown>): OutboundEvent =>
      this.emit(t, p, [playerId], nowMs);
    const rememberReply = (evts: OutboundEvent[]): void => {
      if (typeof envelope.commandId === 'string' && envelope.commandId.length > 0) {
        this.mem.idempotentReplies.set(
          `${playerId}:${envelope.commandId}`,
          evts.filter((e) => e.recipients.length === 1 && e.recipients[0] === playerId),
        );
      }
    };

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
        this.mem.latestFix[playerId] = goodFix;
        me.lastFixAt = new Date(nowMs).toISOString();
        const quality: LocationQuality = check.quality ?? classifyAccuracy(goodFix.accuracyMeters);
        const qualityChanged = me.locationQuality !== quality;
        me.locationQuality = quality;
        if (me.connectionState === 'suspended') {
          const r = resumeSuspendedPlayer(me, nowMs);
          Object.assign(me, r.player);
          events.push(this.emit('player.resumed', { playerId }, this.allPlayerIds(), nowMs));
        } else {
          me.connectionState = 'connected';
        }
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
              this.allPlayerIds(),
              nowMs,
            ),
          );
        }
        persist.push({ kind: 'player-upsert', roomId: this.room.roomId, player: me });
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
        if (this.room.phase !== 'HEAD_START' && this.room.phase !== 'ACTIVE') {
          events.push(this.errorEvent(playerId, 'INVALID_STATE', 'Reveals are for live play only.', false, undefined, nowMs));
          break;
        }
        this.mem.latestFix[playerId] = fix;
        me.lastFixAt = new Date(nowMs).toISOString();
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
        const tokenValid =
          manualConfirm && isRunnerConfirmer
            ? true
            : typeof qrToken === 'string' && isValidCatchToken(qrToken)
              ? await verifyCatchToken(c.catchId, qrToken, c.qrTokenHash)
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
        });
        if (!conf.ok) {
          events.push(this.errorEvent(playerId, conf.code, conf.reason, false, undefined, nowMs));
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
        const r = this.doSafetyPause(playerId, typeof payload['reason'] === 'string' ? (payload['reason'] as string) : null, nowMs);
        if (!r.ok) {
          events.push(this.errorEvent(playerId, r.code, r.error, false, undefined, nowMs));
          break;
        }
        events.push(...r.events);
        persist.push(...r.persist);
        break;
      }
      case 'safety.resume': {
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
          reason: typeof payload['reason'] === 'string' ? (payload['reason'] as string) : null,
        });
        break;
      }
      case 'leave': {
        const r = this.leaveSeat(playerId, typeof payload['reason'] === 'string' ? (payload['reason'] as string) : null, nowMs);
        events.push(...r.events);
        persist.push(...r.persist);
        return { events, persist, close: { code: 1000, reason: 'Left the room.' } };
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
    return { events, persist };
  }
}

// Re-exported for the class: heartbeat / renewal calibration in one place.
export const HEARTBEAT = {
  intervalMs: HEARTBEAT_INTERVAL_MS,
  renewalWarningMs: RENEWAL_WARNING_MS,
};
