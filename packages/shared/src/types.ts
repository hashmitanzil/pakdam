/**
 * Pakdam shared types — the room / player / zone / ping / catch / safety /
 * config / result shapes every package agrees on. Pure types + a few
 * data-only constants (defaults, transition table, close-code actions).
 * No I/O, no secrets, no imports from engine/workers/web.
 */
import {
  CATCH_CONFIRMATION_REQUIRED,
  HEAD_START_SECONDS_DEFAULT,
  MAX_PLAYERS,
  PING_INTERVAL_SECONDS_DEFAULT,
  STANDARD_DURATION_SECONDS,
  ZONE_SHRINK_INTERVAL_SECONDS_DEFAULT,
} from './calibration.js';

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

/** A point on Earth. Latitude −90..90, longitude −180..180. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** A polygon boundary: ordered vertices. 3+ points enclose a shape. */
export type GeoPolygon = GeoPoint[];

/** A single GPS fix. Accuracy is the ± metres radius; only fixes ≤ ±50 m are ever sent. */
export interface LocationFix extends GeoPoint {
  /** ± accuracy in metres (must be > 0 and finite). */
  accuracyMeters: number;
  /** Epoch milliseconds, device clock. */
  timestampMs: number;
}

/** GPS fix quality tier. The SERVER — never the client — decides the tier. */
export type LocationQuality = 'good' | 'fair' | 'poor';

// ---------------------------------------------------------------------------
// Match phases, modes, roles, connection
// ---------------------------------------------------------------------------

/**
 * The 12-phase DO state machine. Only the server changes phase;
 * illegal edges throw INVALID_STATE. Terminal phases have no outgoing edge.
 */
export type MatchPhase =
  | 'DRAFT'
  | 'LOBBY'
  | 'READY_CHECK'
  | 'COUNTDOWN'
  | 'HEAD_START'
  | 'ACTIVE'
  | 'SAFETY_PAUSED'
  | 'RESOLVING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'ABANDONED'
  | 'EXPIRED';

export const MATCH_PHASES: readonly MatchPhase[] = [
  'DRAFT',
  'LOBBY',
  'READY_CHECK',
  'COUNTDOWN',
  'HEAD_START',
  'ACTIVE',
  'SAFETY_PAUSED',
  'RESOLVING',
  'COMPLETED',
  'CANCELLED',
  'ABANDONED',
  'EXPIRED',
] as const;

/** Terminal phases — no outgoing edge. */
export const TERMINAL_PHASES: readonly MatchPhase[] = [
  'COMPLETED',
  'CANCELLED',
  'ABANDONED',
  'EXPIRED',
] as const;

/** Allowed phase transitions. The clock starts at HEAD_START, not ACTIVE. */
export const MATCH_PHASE_TRANSITIONS: Readonly<Record<MatchPhase, readonly MatchPhase[]>> = {
  DRAFT: ['LOBBY', 'CANCELLED'],
  LOBBY: ['READY_CHECK', 'CANCELLED', 'EXPIRED'],
  READY_CHECK: ['COUNTDOWN', 'LOBBY', 'CANCELLED'],
  COUNTDOWN: ['HEAD_START', 'CANCELLED'],
  HEAD_START: ['ACTIVE', 'SAFETY_PAUSED', 'RESOLVING', 'CANCELLED'],
  ACTIVE: ['SAFETY_PAUSED', 'RESOLVING', 'CANCELLED', 'ABANDONED'],
  SAFETY_PAUSED: ['ACTIVE', 'HEAD_START', 'RESOLVING', 'CANCELLED', 'ABANDONED'],
  RESOLVING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  ABANDONED: [],
  EXPIRED: [],
} as const;

/** Only two modes. Breach/Zombie are not in MatchMode — do not re-add them. */
export type MatchMode = 'classic' | 'infection';

export const MATCH_MODES: readonly MatchMode[] = ['classic', 'infection'] as const;

/** A seat's role in the match. `null` until roles are drawn at head start. */
export type MatchRole = 'hunter' | 'runner';

/** A seat's team. `null` until roles are drawn at head start. */
export type Team = 'hunters' | 'runners';

/** How a team is assigned: drawn at random, or picked by the host. */
export type TeamAssignment = 'random' | 'selected';

/**
 * A seat's connection state. Suspended = "location unknown"; the timer keeps
 * running and a pending catch cannot complete while the Runner is suspended.
 */
export type ConnectionState = 'connected' | 'stale' | 'suspended' | 'disconnected';

/** Client socket states (websocket client state machine). */
export type WsConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'suspended'
  | 'reconnecting'
  | 'reconnect-failed'
  | 'closed';

/** What the client does on each WS close code. */
export type WsCloseAction =
  | 'do-not-reconnect'
  | 'backoff-reconnect'
  | 'fresh-ticket-reconnect-once'
  | 'backoff-after-retry-after';

/**
 * Close-code table (frozen contract). 4400: fresh ticket, reconnect once, AND
 * surface the failure — a malformed hello will not be fixed by a fresh ticket.
 * 4401: fresh ticket, reconnect once; a second 4401 → closed.
 * 4413: back off, never before the server's `retryAfterSeconds`.
 */
export const WS_CLOSE_CODE_ACTION: Readonly<Record<number, WsCloseAction>> = {
  1000: 'do-not-reconnect',
  1001: 'backoff-reconnect',
  1006: 'backoff-reconnect',
  1011: 'backoff-reconnect',
  4400: 'fresh-ticket-reconnect-once',
  4401: 'fresh-ticket-reconnect-once',
  4403: 'do-not-reconnect',
  4409: 'do-not-reconnect',
  4413: 'backoff-after-retry-after',
} as const;

// ---------------------------------------------------------------------------
// Room, player, config
// ---------------------------------------------------------------------------

/** Shape of the play zone: a circle (centre + radius) or a host-drawn polygon. */
export type ZoneShape = 'circle' | 'draw';

/** The play zone: boundary + scheduled shrink boundaries (size placeholders only — the server re-draws the real boundary per shrink). */
export interface ZoneConfig {
  boundary: GeoPolygon;
  /**
   * RESERVED / UNUSED: pre-computed shrink-phase boundaries from the old
   * build. Nothing reads them — the server re-draws the real boundary per
   * shrink (`randomOffsetShrinkBoundary`) at the moment the shrink fires.
   * There is NO next-zone preview (founder decision, v18): the next zone
   * appears suddenly at a random place, so nothing previews a boundary
   * ahead of time. Kept in the type only because stored configs and the
   * create page still carry an (empty) array; validators check its shape
   * but no code may treat it as the shrink schedule. Do not revive it.
   */
  shrinkPhases: { atSeconds: number; boundary: GeoPolygon }[];
}

/** The host's house rules for a room. */
export interface HouseRules {
  mode: MatchMode;
  teamAssignment: TeamAssignment;
  /** 2–30 (MIN_PLAYERS = 2). */
  maxPlayers: number;
  /** Host-picked or balance-derived Hunter count; 1..n−1. */
  hunterCount: number;
  /** Round length in seconds; 300–10800. */
  durationSeconds: number;
  /** Head start in seconds; 0–1800. */
  headStartSeconds: number;
  /** Ping interval in seconds; 0 = no pings, else 30–1800. */
  pingIntervalSeconds: number;
  zoneShrinkEnabled: boolean;
  /** Seconds between shrinks. */
  zoneShrinkIntervalSeconds: number;
  /** Always true in practice — a tag never counts at once. */
  catchConfirmationRequired: boolean;
  /** Balance ON (default): Hunter count is set from the roster at start. */
  balanceHunters?: boolean;
  /** Random ON (default): Hunters are drawn at random. */
  randomDraw?: boolean;
  /** Play zone ON (default). */
  playZoneEnabled?: boolean;
  /** Hunters can talk (default ON). When OFF, Hunters read but cannot send voice or text. */
  huntersCanTalk?: boolean;
  /**
   * RESERVED / UNUSED: final zone size as a percent of the start size.
   * Founder decision: Final size is Auto-only — the UI offers no control
   * and the value must stay `null`. The final radius is derived, not
   * configured: 0.75^3 = 42% after the 3 shrinks (`finalRadiusPercent`
   * in @pakdam/engine). Kept in the type only because stored configs
   * carry `null`; validators accept `null` or a finite 1–100 number but
   * no code may treat a non-null value as a live setting.
   */
  finalSizePercent?: number | null;
  // NOTE: `showPingHistory` was REMOVED (dead toggle — nothing read it;
  // the setup UI carried a toggle for it that did nothing). Do not re-add.
}

/** GPS anti-cheat knobs (Gap 1). Optional on the config; absent = defaults
 * (`GPS_ANTI_CHEAT_DEFAULTS`). No host setup UI in v1 — these are set
 * server-side / by the founder only. Eject is opt-in via
 * `action: 'eject'`; the default `action: 'warn'` never ejects. */
export interface GpsAntiCheatConfig {
  enabled?: boolean;
  warnOnly?: boolean;
  action?: 'warn' | 'eject';
  maxSpeedMs?: number;
  burstMaxMs?: number;
  burstWindowMs?: number;
  teleportMaxGapM?: number;
  teleportMaxGapMs?: number;
  violationThreshold?: number;
}

/** Full room config = house rules + zone + areas + host picks. */
export interface RoomConfig extends HouseRules {
  zone: ZoneConfig;
  zoneShape?: ZoneShape;
  /** Always [] in practice. */
  safeAreas: GeoPolygon[];
  /** Host-drawn no-go polygons. */
  noGoAreas: GeoPolygon[];
  /** Host-picked Hunter ids (teamAssignment 'selected' only; cleared on Random). */
  selectedHunterIds: string[];
  /** Required: the host confirms they are on site. */
  hostOnSiteConfirmed: boolean;
  /** GPS anti-cheat overrides (Gap 1); absent = `GPS_ANTI_CHEAT_DEFAULTS`. */
  gpsAntiCheat?: GpsAntiCheatConfig;
}

/** Host-toggle defaults: Balance ON, Random draw ON. */
export const DEFAULT_HOST_TOGGLES = {
  balanceHunters: true,
  randomDraw: true,
} as const;

// NOTE: `LEGACY_HOST_TOGGLES` was REMOVED — dead constant, used nowhere
// except the shared README. Rooms saved before toggles existed resolve to
// the defaults above; do not re-add a legacy all-OFF set.

/** Create-page defaults: Classic · 30 min · 3 min head start · pings every 3 min · 500 m zone · shrinking ON every 10 min · Balance ON · Random ON · play zone ON · final size Auto. */
export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  mode: 'classic',
  teamAssignment: 'random',
  maxPlayers: MAX_PLAYERS,
  hunterCount: 2,
  durationSeconds: STANDARD_DURATION_SECONDS,
  headStartSeconds: HEAD_START_SECONDS_DEFAULT,
  pingIntervalSeconds: PING_INTERVAL_SECONDS_DEFAULT,
  zoneShrinkEnabled: true,
  zoneShrinkIntervalSeconds: ZONE_SHRINK_INTERVAL_SECONDS_DEFAULT,
  catchConfirmationRequired: CATCH_CONFIRMATION_REQUIRED,
  balanceHunters: true,
  randomDraw: true,
  playZoneEnabled: true,
  huntersCanTalk: true,
  finalSizePercent: null,
  zone: { boundary: [], shrinkPhases: [] },
  zoneShape: 'circle',
  safeAreas: [],
  noGoAreas: [],
  selectedHunterIds: [],
  hostOnSiteConfirmed: false,
};

/** A seat in a room. `isHost` (room permission) is SEPARATE from `matchRole` — a host can also be a Hunter or a Runner. */
export interface Player {
  playerId: string;
  roomId: string;
  kind: 'host-account' | 'guest';
  displayName: string;
  isHost: boolean;
  matchRole: MatchRole | null;
  team: Team | null;
  /** Server only — SHA-256 of the reconnect token. Never sent to any client. */
  reconnectTokenHash: string;
  joinedAt: string;
  leftAt: string | null;
  /** Set = out of play but stays in the room record; `leftAt` stays null. */
  ejectedAt: string | null;
  connectionState: ConnectionState;
  /** Timestamp only, never a fix. */
  lastFixAt: string | null;
  locationQuality: LocationQuality | null;
  isReady: boolean;
  briefingConfirmed: boolean;
  ageGatePassed: boolean;
  suspensionCount: number;
}

/**
 * What a seat sees of another seat: the reconnect-token hash is stripped, and a
 * seat sees its OWN matchRole/team only — every other seat's role is `null`
 * (enforced at runtime by the authorised snapshot, not by this type).
 */
export type PlayerView = Omit<Player, 'reconnectTokenHash'> & {
  /**
   * v29 — seat presence for the 30 s return rule (founder decision
   * 2026-11-22): 'away' = no live socket (suspended / not on the page),
   * 'present' otherwise. Optional: engine-built views without a store
   * omit it; every view leaving the DO carries it.
   */
  presence?: 'present' | 'away';
  /**
   * v29 — epoch ms when this seat's 30 s return window ends, or null
   * when no window is running. The client shows the countdown from
   * here, never the server constant.
   */
  reconnectEndsAtMs?: number | null;
};

/**
 * One confirmed tag: who tagged whom, and when. Carried on the match
 * result so the results page can list tags in live games (previously the
 * timeline only had per-tag entries in demo mode).
 */
export interface MatchTag {
  hunterPlayerId: string;
  runnerPlayerId: string;
  /** ISO timestamp of the confirmation. */
  confirmedAt: string;
}

/** The match result — no routes, no coordinate trails. */
export interface MatchResult {
  outcome: 'hunters-win' | 'runners-win' | 'cancelled' | 'abandoned';
  durationSeconds: number;
  caughtRunnerIds: string[];
  survivingRunnerIds: string[];
  /** Confirmed tags, oldest first. Empty when nobody was tagged. */
  tags: MatchTag[];
}

/** A room. `result` is null until the match completes. */
export interface Room {
  roomId: string;
  roomCode: string;
  hostPlayerId: string;
  phase: MatchPhase;
  version: number;
  config: RoomConfig;
  createdAt: string;
  startedAt: string | null;
  endsAt: string | null;
  pausedAt: string | null;
  result: MatchResult | null;
}

// ---------------------------------------------------------------------------
// Pings, catches, safety, radio, pins
// ---------------------------------------------------------------------------

/**
 * A ping is a coarse area, never an exact pin. Centre = the subject's latest
 * server-held fix, radius 150 m (OPEN), mutual: a ping for a Runner goes to
 * Hunters, and a ping for a Hunter goes to Runners — both sides learn the
 * other's location when it fires. No fix = no ping, never an invented
 * position. A sector ping has no centre: text only.
 */
export interface Ping {
  pingId: string;
  roomId: string;
  subjectPlayerId: string;
  recipientRole: 'hunters' | 'runners';
  uncertainty: { centre: GeoPoint; radiusMeters: number } | { sector: string };
  ageSeconds: number;
  qualityAtPing: LocationQuality | null;
  createdAt: string;
  expiresAt: string;
}

/** Catch states. `requested` is the legacy alias for `awaiting-confirmation`. */
export type CatchState =
  | 'requested'
  | 'awaiting-confirmation'
  | 'confirmed'
  | 'disputed'
  | 'rejected'
  | 'expired';

/** GPS is supporting evidence for a catch only — never proof, never a rejection on its own. */
export type CatchGpsEvidence = 'present' | 'absent' | 'stale';

/** A catch as the server stores it (qrTokenHash is server-only, stripped in CatchView). */
export interface CatchEvent {
  catchId: string;
  roomId: string;
  hunterPlayerId: string;
  runnerPlayerId: string;
  state: CatchState;
  /** Server only — SHA-256 of the one-time QR token. Never sent to clients. */
  qrTokenHash: string | null;
  /**
   * Server only — the previous token's hash, kept when the raw token was
   * lost (e.g. DO hibernation) and a fresh one was minted, or when a
   * scanned runner token was bound to an already-open claim. The old QR
   * stays valid until it expires or is confirmed. Never sent to clients
   * (stripped in CatchView alongside `qrTokenHash`).
   */
  previousQrTokenHash?: string | null;
  requestedAt: string;
  confirmedAt: string | null;
  disputedAt: string | null;
  resolution: 'confirmed' | 'rejected' | null;
  gpsEvidence: CatchGpsEvidence;
}

/** A catch as clients see it. `activeCatches` in a snapshot holds pending catches only. */
export type CatchView = Omit<CatchEvent, 'qrTokenHash' | 'previousQrTokenHash'>;

/** Safety-event kinds (audit log). v18: 'sos' REMOVED — the founder removed SOS entirely. */
export type SafetyEventType =
  | 'briefing-confirmed'
  | 'safety-pause'
  | 'safety-resume'
  | 'leave'
  | 'stop-sharing'
  | 'report'
  | 'block';

/** Safety state riding the snapshot. `pausedFrom` lives server-side (resume returns there). v18: no `sosActive` — SOS was removed entirely. */
export interface SafetyState {
  paused: boolean;
  pausedBy: string | null;
  pausedAt: string | null;
}

/** A team-radio message. `senderName` is the server-known display name, never a client claim. */
export interface RadioMessage {
  messageId: string;
  roomId: string;
  playerId: string;
  senderName: string;
  text: string;
  kind: 'quick' | 'text';
  sentAt: string;
}

/** Closed-set quick-signal sets (team radio quick chips). */
export const QUICK_SIGNALS: Readonly<Record<'lobby' | 'hunters' | 'runners', readonly string[]>> = {
  lobby: [
    'Ready when you are',
    'Give me a minute',
    'Check the boundary first',
    'I’m here — where is everyone?',
    'Let’s go!',
  ],
  hunters: [
    'Cover the far edge',
    'Hold the boundary',
    'Moving to the next ping area',
    'I need backup',
    'All clear on my side',
  ],
  runners: [
    'I’m safe for now',
    'Moving to a new spot',
    'Stay spread out',
    'Don’t bunch up',
    'Heads up — hunter nearby',
  ],
} as const;

/** A quick signal: a closed-set code only (no free text). */
export interface QuickSignal {
  code: string;
  fromPlayerId: string;
  sentAt: string;
}

/** A map pin placed by a player. */
export interface MapPin {
  pinId: string;
  roomId: string;
  playerId: string;
  point: GeoPoint;
  label: string;
  createdAt: string;
}

/** An announcement ("I'm safe" check-ins travel as announcements — there is no dedicated check-in command). */
export interface Announcement {
  announcementId: string;
  roomId: string;
  playerId: string;
  senderName: string;
  text: string;
  sentAt: string;
}

// ---------------------------------------------------------------------------
// Snapshot, envelopes, errors
// ---------------------------------------------------------------------------

/**
 * Snapshot payload — the whole truth the UI renders. It NEVER carries raw
 * coordinates, pending pings, or token hashes. Pings arrive only as `ping`
 * events after connect; a reconnect loses earlier pings. Decided catches
 * (confirmed / disputed) ARE carried, so the after-tagged screen and
 * auto-spectator state survive a reload — a snapshot must rebuild them,
 * not just the live `catch.*` events.
 */
export interface WsSnapshotPayload {
  room: Room;
  players: PlayerView[];
  phase: MatchPhase;
  version: number;
  serverSeq: number;
  locationStatus: Record<string, 'known' | 'unknown'>;
  /** Pending catches only (recipient-filtered: parties + host). */
  activeCatches: CatchView[];
  /**
   * Decided catches this viewer may see (confirmed or disputed,
   * recipient-filtered: parties + host). The client merges these into its
   * session catches on every snapshot, so a tagged Runner who reloads
   * still sees "You were tagged by X" and stays a spectator.
   */
  decidedCatches: CatchView[];
  /**
   * The viewer's teammates (same team, not left): their playerIds.
   * Teammates only — never an opponent. Empty when the viewer has no
   * team, or when the viewer is a caught Runner (a tagged Runner loses
   * the live teammate view entirely).
   */
  teammateIds: string[];
  /**
   * The viewer's teammates' latest live fixes, keyed by playerId.
   * Teammates only — never an opponent's position, never the viewer's
   * own fix (the client has its own GPS). Only teammates WITH a fix
   * appear here; a teammate without a fix is still in `teammateIds`.
   * Empty when the viewer is a caught Runner.
   */
  teammateFixes: Record<string, LocationFix>;
  safetyState: SafetyState;
  missedAnnouncements: Announcement[];
  /**
   * v24 — host reconnect grace deadline (epoch ms): the moment the
   * suspended host's 30 s grace expires and host transfers if they
   * have not returned. Null when no grace is running. The client
   * reads the deadline from here, never the server constant
   * (`HOST_RECONNECT_GRACE_MS` stays server-only).
   */
  hostGraceEndsAtMs: number | null;
  /**
   * v29 (R1) — durable watermark for the client snapshot key
   * `version:serverSeq:maxLastFixAtMs:epochMs`: the newest `lastFixAt`
   * over the viewer + their same-team players only (v30 AppSec F1 —
   * never an opponent's fix), as epoch ms, or null when nobody in
   * scope has reported a fix. `lastFixAt` is durable and persisted
   * ≤ 30 s (player-upsert
   * throttle), so after a DO eviction the restored watermark is ≤ the
   * cached one and the key differs — the client re-fetches instead of
   * trusting a collided `serverSeq`. Optional: snapshots built by
   * older callers omit it; every snapshot leaving the DO carries it.
   */
  maxLastFixAtMs?: number | null;
  /**
   * v29 (R5 fix round) — the DO instance's memory epoch, epoch ms
   * stamped when the DO loads/restores durable state (it changes on
   * every wake). Part of the snapshot key: durable `serverSeq` +
   * watermark can be unchanged across a wake while memory-only state
   * (`teammateFixes`, `locationStatus`) is gone, so a key without
   * the epoch could falsely answer `snapshot.unchanged` after a
   * wake. Every snapshot leaving the DO carries it.
   */
  epochMs: number;
}

/** Client → server envelope. Retries reuse the same `commandId`; the DO drops repeats for 10 min. */
export interface WsClientEnvelope<TPayload = unknown> {
  v: 1;
  type: string;
  commandId?: string;
  idempotencyKey?: string;
  roomId: string;
  playerId: string;
  clientSeq: number;
  clientTs: number;
  payload: TPayload;
}

/** Server → client envelope. `serverSeq` is monotonic per room. */
export interface WsServerEnvelope<TPayload = unknown> {
  v: 1;
  type: string;
  roomId: string;
  eventId: string;
  serverSeq: number;
  /** ISO-8601 timestamp — the DO emits a string here, not epoch ms. */
  serverTs: string;
  payload: TPayload;
}

/** WS error codes. */
export type WsErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'ROOM_NOT_FOUND'
  | 'INVALID_STATE'
  | 'VALIDATION_FAILED'
  | 'VERSION_CONFLICT'
  | 'RATE_LIMITED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REUSED'
  | 'TICKET_INVALID'
  | 'TICKET_REUSED'
  | 'TICKET_EXPIRED'
  | 'PROTOCOL_UNSUPPORTED'
  | 'SNAPSHOT_REQUIRED'
  | 'CATCH_EXPIRED'
  | 'CATCH_DISPUTED'
  | 'STALE_LOCATION'
  | 'CONFLICT'
  | 'SERVER_ERROR'
  | 'SERVICE_UNAVAILABLE';

/** WS error payload. `retryAfterSeconds` is honoured for 4413 backoff. */
export interface WsErrorPayload {
  code: WsErrorCode;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  requestId?: string;
  details?: unknown;
  /**
   * Client-set only (epoch ms, e.g. locally constructed errors): the DO
   * never emits serverTs inside an error payload — it rides on the
   * envelope instead, as an ISO string.
   */
  serverTs?: number;
}

/** Voice signalling kinds (WebRTC P2P, team-only; the DO rejects cross-team signals). */
export type VoiceSignalKind = 'join' | 'leave' | 'offer' | 'answer' | 'ice';

/** Voice radio client statuses. */
export type VoiceRadioStatus = 'off' | 'ready' | 'talking' | 'unavailable' | 'failed';

/** Reasons a seat may report itself suspended (best-effort notice on tab-hide). */
export type SuspensionReason =
  | 'tab-hidden'
  | 'screen-locked'
  | 'network-lost'
  | 'heartbeat-timeout'
  | 'unknown';

/** The canonical live session: ONE sessionStorage key, two separate tokens. */
export interface PakdamSession {
  mode: 'live' | 'demo';
  roomId: string;
  playerId: string;
  displayName?: string;
  reconnectToken?: string;
  hostToken?: string;
  isHost: boolean;
  roomCode?: string;
}
