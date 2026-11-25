/**
 * Pakdam WS event catalogue — frozen contract v2.1, as amended by v18
 * and the v18 follow-up (claim-less runner QR token).
 *
 * 22 client→server message types, 35 server→client types.
 *
 * v18 removals (founder decisions — do not re-add):
 * - `safety.sos` / `sos.raised`: SOS removed entirely, server + shared.
 * - `zone.preview`: NO next-zone preview at all — the next zone appears
 *   suddenly at a random place, so the server never broadcasts a preview.
 *   The shrink itself (timing, random offset, final 42%) is unchanged.
 * - `reveal.send` (client→server) + the `reveal` server event: hold-to-
 *   reveal was removed entirely in v18 (server handler, web UI, and now
 *   this catalogue — Wave 2 removed the last shared types: `RevealArea`,
 *   `RevealSendPayload`, `RevealEventPayload`). A stray `reveal.send`
 *   now gets "Unknown message type" (VALIDATION_FAILED).
 *
 * NOTE — server count: the protocol map's header states 35 server→client
 * types and its §2.4 table enumerates 34 named types plus `zone.preview`
 * (added by the shrink-preview fix, P1-18) = 35. v18 removes `zone.preview`,
 * `sos.raised`, and `reveal`, so this file now implements 32. If another
 * type is ever identified, add it here and bump the protocol version. Do
 * not invent one to make the count match.
 *
 * v18 follow-up (claim-less runner QR token): `catch.runner-token` is
 * added both ways — the Runner mints it (client→server, empty payload)
 * and receives the raw token back (server→client, direct-only) — so the
 * count is now 22 client / 33 server types.
 *
 * v29: `snapshot.unchanged` (R5 — server honours lastServerSeq) and
 * `ticket.renewed` (R8 — server-push ticket renewal) are added, so the
 * count is now 22 client / 35 server types. v29 fix round:
 * `teammate.fix` (R3 — fix broadcast replaces the 8 s periodic
 * re-fetch as the primary liveness mechanism) is added, so the count
 * is now 22 client / 36 server types.
 *
 * v34 correction (Arjun R2): v23 fix round 1 (S12) had already unfrozen
 * `room.deleted` without bumping this count, so the true count has been
 * 22 client / 37 server types since then — the header said 36. The
 * `WS_SERVER_TYPES` array below is the contract; the count here now
 * matches it (37).
 *
 * Broadcast scoping (server-side, must be preserved): direct messages
 * (`welcome`, `snapshot`, `error`, `heartbeat.ack`, `auth.refreshed`,
 * `ticket.renewal-required`, `catch.runner-token`) go only to the sender; `voice.signal` and
 * `radio` are team-only (lobby = whole lobby); `ping` is role-scoped — it
 * goes only to the ping's recipient role (a Runner ping to Hunters, a
 * Hunter ping to Runners), so each side sees only the opposing team;
 * everything else broadcasts to the room.
 */
import type {
  Announcement,
  CatchView,
  LocationFix,
  MapPin,
  MatchPhase,
  MatchResult,
  Ping,
  PlayerView,
  QuickSignal,
  RadioMessage,
  Room,
  SuspensionReason,
  VoiceSignalKind,
  WsErrorPayload,
  WsSnapshotPayload,
  ZoneConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// Client → server (22 types)
// ---------------------------------------------------------------------------

/** `{}` — empty payload (heartbeat, safety.resume, briefing.confirm). */
export type EmptyPayload = Record<string, never>;

/** First message on socket open. Carries NO credential — a hello containing one is rejected. */
export interface HelloPayload {
  protocolVersion: 1;
  clientVersion: string;
  lastServerSeq: number;
}

/** The ONLY message that ever carries a ticket (a fresh `renew` ticket). */
export interface AuthRefreshPayload {
  ticket: string;
}

export interface LocationUpdatePayload {
  fix: LocationFix;
}

export interface CatchRequestPayload {
  /**
   * Name-claim path: the Runner to claim. Optional when `qrToken` is
   * given — a Hunter who scanned a QR sends the token only and the
   * server identifies the Runner from it. When both are given they
   * must agree, or the request is rejected.
   */
  runnerId?: string;
  /**
   * Scan path: the raw token decoded from the Runner's QR. Either a
   * claim-less runner token (creates the claim for that Runner) or —
   * once a claim exists — the claim's own token. Never typed, never
   * shown as text: QR-only carriage, same as every catch token.
   */
  qrToken?: string;
}

/** Runner confirms with the fetched QR token, or manually with no token. */
export interface CatchConfirmPayload {
  catchId: string;
  qrToken: string;
  manualConfirm?: boolean;
  resolution?: 'manual-confirm';
}

/**
 * v18 self-confirm (founder catch flow): the RUNNER names the Hunter who
 * tagged them (`hunterId`) and the server completes the tag — no QR scan,
 * no token, and NO confirmation needed from the Hunter. The server
 * creates the claim if none is open for that Hunter + Runner, then
 * confirms it in the same op, under the same physical-tag rule as every
 * other confirm (both phones need a recent fix within 100 m). The
 * QR-scan way (Hunter scans the Runner's QR, then taps Tag) still uses
 * `catch.request` + `catch.confirm` and is unchanged.
 */
/**
 * v18 follow-up — claim-less runner QR token (founder catch flow): the
 * RUNNER mints their own QR token with NO claim open (`catch.runner-token`,
 * empty payload) and shows the QR the moment they tap "Got Tagged". The
 * token is tied to the Runner (their playerId), not to a claim: 128-bit,
 * 120 s TTL, hash-only storage, single-use, QR-only carriage — the same
 * token rules as a claim token, with the hash domain
 * sha256('runner:' + runnerId + ':' + raw). One live token per Runner:
 * re-minting REPLACES the old one at once (the server never stores the
 * raw, so it cannot re-issue the same token). A Hunter who scans it
 * sends `catch.request` with `{ qrToken }` (no runnerId needed); the
 * server validates it, creates the claim for that Runner, and the Hunter
 * then taps Tag → the existing `catch.confirm` with the same token
 * (the physical 100 m gate still applies at confirm). Minting with an
 * open claim is CONFLICT — the Runner shows that claim's QR instead
 * (HTTP /catch-token, unchanged).
 */
export interface CatchSelfConfirmPayload {
  hunterId: string;
}

export type CatchRunnerTokenPayload = EmptyPayload;

/** Direct reply to a `catch.runner-token` mint: the raw token, once, to the Runner only. */
export interface CatchRunnerTokenIssuedPayload {
  token: string;
  runnerId: string;
  /** ISO-8601 expiry (mint + CATCH_TOKEN_TTL_SECONDS). */
  expiresAt: string;
  serverSeq: number;
}

export interface CatchDisputePayload {
  catchId: string;
  reason: string;
}

export interface SafetyPausePayload {
  reason: string | null;
}

export interface LeavePayload {
  reason: string | null;
}

export interface SignalSendPayload {
  code: string;
}

export interface RadioSendPayload {
  text: string;
  kind?: 'quick' | 'text';
}

export interface VoiceSignalPayload {
  toPlayerId: string;
  kind: VoiceSignalKind;
  sdp?: string;
  candidate?: unknown;
}

export interface PinPlacePayload {
  point: { lat: number; lng: number };
  label: string;
}

export interface AnnouncementSendPayload {
  text: string;
}

export interface ReadySetPayload {
  isReady: boolean;
}

export interface SnapshotRequestPayload {
  lastServerSeq: number;
  /**
   * v29 (R5, fix round) — the client's last snapshot key, first-class.
   * Canonical field names: `{ version, serverSeq, maxLastFixAtMs,
   * epochMs }`. `maxLastFixAtMs` is null when no seat has reported a
   * fix (never 0 — null on both sides). `epochMs` is the DO instance's
   * memory epoch (see `WsSnapshotPayload.epochMs`): a key from before
   * a wake never matches. Absent entirely (old client, or a request
   * carrying only `lastServerSeq`) → the server returns a full
   * snapshot, never guesses.
   */
  lastSnapshotKey?: SnapshotKey;
}

/** v29 (R5) — the snapshot-unchanged key, shared by request + snapshot. */
export interface SnapshotKey {
  version: number;
  serverSeq: number;
  /** Newest `lastFixAt` over the viewer + same-team players only (v30 AppSec F1), epoch ms, or null. */
  maxLastFixAtMs: number | null;
  /** The DO instance's memory epoch (changes on every wake). */
  epochMs: number;
}

export interface ResyncRequestPayload {
  lastServerSeq: number;
  /** Same key as `snapshot.request` (see `SnapshotRequestPayload`). */
  lastSnapshotKey?: SnapshotKey;
}

export interface PlayerSuspendedPayload {
  reason: SuspensionReason;
}

/** Payload for every client→server message type, keyed by type name. */
export interface WsClientPayloads {
  hello: HelloPayload;
  'auth.refresh': AuthRefreshPayload;
  heartbeat: EmptyPayload;
  'snapshot.request': SnapshotRequestPayload;
  'resync.request': ResyncRequestPayload;
  'location.update': LocationUpdatePayload;
  'catch.request': CatchRequestPayload;
  'catch.confirm': CatchConfirmPayload;
  'catch.self-confirm': CatchSelfConfirmPayload;
  'catch.runner-token': CatchRunnerTokenPayload;
  'catch.dispute': CatchDisputePayload;
  'safety.pause': SafetyPausePayload;
  'safety.resume': EmptyPayload;
  'ready.set': ReadySetPayload;
  'briefing.confirm': EmptyPayload;
  'radio.send': RadioSendPayload;
  'signal.send': SignalSendPayload;
  'voice.signal': VoiceSignalPayload;
  'pin.place': PinPlacePayload;
  'announcement.send': AnnouncementSendPayload;
  leave: LeavePayload;
  'player.suspended': PlayerSuspendedPayload;
}

export type WsClientMessageType = keyof WsClientPayloads;

export const WS_CLIENT_TYPES: readonly WsClientMessageType[] = [
  'hello',
  'auth.refresh',
  'heartbeat',
  'snapshot.request',
  'resync.request',
  'location.update',
  'catch.request',
  'catch.confirm',
  'catch.self-confirm',
  'catch.runner-token',
  'catch.dispute',
  'safety.pause',
  'safety.resume',
  'ready.set',
  'briefing.confirm',
  'radio.send',
  'signal.send',
  'voice.signal',
  'pin.place',
  'announcement.send',
  'leave',
  'player.suspended',
] as const;

/** Type guard: is this string a known client→server message type? */
export function isWsClientMessageType(value: string): value is WsClientMessageType {
  return (WS_CLIENT_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Server → client (37 enumerated types; see note at the top of this file)
// ---------------------------------------------------------------------------

export interface WelcomePayload {
  playerId: string;
  serverSeq: number;
  protocolVersion: 1;
}

export interface RoomStatePayload {
  phase: MatchPhase;
  version: number;
  serverSeq: number;
  reason: string;
}

export interface PlayerEventPayload {
  player: PlayerView;
  serverSeq: number;
}

export interface PlayerSuspendedEventPayload {
  playerId: string;
  reason?: string;
  serverSeq: number;
}

export interface PlayerResumedEventPayload {
  playerId: string;
  reason?: string;
  serverSeq: number;
}

export interface PlayerVisibilityPayload {
  playerId: string;
  locationQuality: 'good' | 'fair' | 'poor' | null;
  lastFixAt: string | null;
  serverSeq: number;
}

export interface PingEventPayload {
  ping: Ping;
  serverSeq: number;
}

export interface PingExpiredPayload {
  pingId: string;
  subjectPlayerId: string;
  expiresAt: string;
}

export interface ZoneUpdatePayload {
  zone: ZoneConfig;
  phase: MatchPhase;
  serverSeq: number;
}

export interface CatchEventPayload {
  catch: CatchView;
  serverSeq: number;
}

export interface SafetyPausedPayload {
  byPlayerId: string;
  reason: string | null;
  serverSeq: number;
}

export interface SafetyResumedPayload {
  byPlayerId: string;
  reason: string | null;
  serverSeq: number;
}

export interface MatchStartedPayload {
  result: MatchResult | null;
  serverSeq: number;
}

export interface MatchCompletedPayload {
  result: MatchResult | null;
  serverSeq: number;
}

export interface MatchCancelledPayload {
  result: MatchResult | null;
  serverSeq: number;
}

export interface AnnouncementEventPayload {
  announcement: Announcement;
  serverSeq: number;
}

export interface SignalEventPayload {
  signal: QuickSignal;
  serverSeq: number;
}

export interface RadioEventPayload {
  radio: RadioMessage;
  serverSeq: number;
}

export interface VoiceSignalEventPayload {
  fromPlayerId: string;
  toPlayerId: string;
  kind: VoiceSignalKind;
  sdp?: string;
  candidate?: unknown;
}

export interface PinEventPayload {
  pin: MapPin;
  serverSeq: number;
}

export interface HostTransferredPayload {
  previousHostPlayerId: string;
  newHostPlayerId: string;
  serverSeq: number;
}

export interface TicketRenewalRequiredPayload {
  expiresAt: number;
  serverSeq: number;
}

/**
 * v29 (R8) — server-push ticket renewal: the DO minted + registered a
 * renewal ticket itself and pushes the raw value over the existing
 * authenticated socket, shortly before expiry. The client stores it
 * and presents it via `auth.refresh` — no HTTP ticket call. Sent
 * alongside `ticket.renewal-required` (old clients ignore this event
 * and keep fetching over HTTP).
 */
export interface TicketRenewedPayload {
  ticket: string;
  /**
   * v29 (R8 fix round) — epoch ms when the pushed ticket expires.
   * The client needs it to know when the pushed ticket itself dies
   * (the 60 s TTL is unchanged — never 10 min); without it the
   * client could not schedule its next renewal.
   */
  expiresAtMs: number;
  serverSeq: number;
}

/**
 * v29 (R5 fix round) — `teammate.fix`: the primary teammate-liveness
 * mechanism (replaces the 8 s periodic re-fetch). On each accepted
 * fix the server emits this lightweight event to the sender's
 * teammates ONLY, using exactly the same visibility predicate as
 * `buildSnapshot`'s per-viewer `teammateFixes` (so broadcast and
 * snapshot can never disagree about who sees whom — including the
 * caught-Runner-loses-live-view rule). Outbound sends are not
 * counted as DO requests under the conservative-meter reading
 * (only inbound messages and alarm invocations count); the CPU
 * cost of the fan-out is the open question. The R1 30 s safety
 * valve stays as the safety net. CONTRACT (client implements
 * against this exact event/payload).
 */
export interface TeammateFixPayload {
  playerId: string;
  lat: number;
  lng: number;
  accuracyMeters: number;
  /** Device timestamp of the fix, epoch ms. */
  timestampMs: number;
  serverSeq: number;
}

/**
 * v29 (R5) — the server honours `lastServerSeq`: when the seat's
 * (version, serverSeq, durable watermark) key has not moved, the
 * snapshot request is answered with this tiny event instead of a full
 * snapshot. `serverSeq` / `version` are the current values (the
 * envelope carries the same serverSeq).
 */
export interface SnapshotUnchangedPayload {
  serverSeq: number;
  version: number;
}

export interface AuthRefreshedPayload {
  expiresAt: number;
  /** ISO-8601 timestamp — the DO emits a string here, not epoch ms. */
  serverTs: string;
  serverSeq: number;
}

export interface HeartbeatAckPayload {
  /** ISO-8601 timestamp — the DO emits a string here, not epoch ms. */
  serverTs: string;
  serverSeq: number;
}

/** Payload for every server→client message type, keyed by type name. */
export interface WsServerPayloads {
  welcome: WelcomePayload;
  snapshot: WsSnapshotPayload;
  'snapshot.unchanged': SnapshotUnchangedPayload;
  'room.state': RoomStatePayload;
  'ticket.renewal-required': TicketRenewalRequiredPayload;
  'ticket.renewed': TicketRenewedPayload;
  'teammate.fix': TeammateFixPayload;
  'auth.refreshed': AuthRefreshedPayload;
  'heartbeat.ack': HeartbeatAckPayload;
  error: WsErrorPayload;
  'player.joined': PlayerEventPayload;
  'player.left': PlayerEventPayload;
  'player.removed': PlayerEventPayload;
  'player.suspended': PlayerSuspendedEventPayload;
  'player.resumed': PlayerResumedEventPayload;
  'player.visibility': PlayerVisibilityPayload;
  'host.transferred': HostTransferredPayload;
  ping: PingEventPayload;
  'ping.expired': PingExpiredPayload;
  'zone.update': ZoneUpdatePayload;
  pin: PinEventPayload;
  signal: SignalEventPayload;
  radio: RadioEventPayload;
  'voice.signal': VoiceSignalEventPayload;
  announcement: AnnouncementEventPayload;
  'catch.requested': CatchEventPayload;
  'catch.confirmed': CatchEventPayload;
  'catch.disputed': CatchEventPayload;
  'catch.expired': CatchEventPayload;
  'catch.rejected': CatchEventPayload;
  'catch.runner-token': CatchRunnerTokenIssuedPayload;
  'safety.paused': SafetyPausedPayload;
  'safety.resumed': SafetyResumedPayload;
  'match.started': MatchStartedPayload;
  'match.completed': MatchCompletedPayload;
  'match.cancelled': MatchCancelledPayload;
  /**
   * v23 fix round 1 (S12): `'room.deleted'` was emitted via a cast
   * because the catalogue was frozen for v23 — the guard
   * `isWsServerMessageType('room.deleted')` was false and no runtime
   * check would have caught a typo'd server type. Unfrozen now: the
   * signal carries the same `{ result }` payload as `match.cancelled`
   * (the store emits exactly that), and the three casts are gone.
   * The wire string is unchanged — the web client already matches the
   * raw `'room.deleted'` string.
   */
  'room.deleted': MatchCancelledPayload;
}

export type WsServerMessageType = keyof WsServerPayloads;

export const WS_SERVER_TYPES: readonly WsServerMessageType[] = [
  'welcome',
  'snapshot',
  'snapshot.unchanged',
  'room.state',
  'ticket.renewal-required',
  'ticket.renewed',
  'teammate.fix',
  'auth.refreshed',
  'heartbeat.ack',
  'error',
  'player.joined',
  'player.left',
  'player.removed',
  'player.suspended',
  'player.resumed',
  'player.visibility',
  'host.transferred',
  'ping',
  'ping.expired',
  'zone.update',
  'pin',
  'signal',
  'radio',
  'voice.signal',
  'announcement',
  'catch.requested',
  'catch.confirmed',
  'catch.disputed',
  'catch.expired',
  'catch.rejected',
  'catch.runner-token',
  'safety.paused',
  'safety.resumed',
  'match.started',
  'match.completed',
  'match.cancelled',
  'room.deleted',
] as const;

/** Type guard: is this string a known server→client message type? */
export function isWsServerMessageType(value: string): value is WsServerMessageType {
  return (WS_SERVER_TYPES as readonly string[]).includes(value);
}

/** Server→client types sent ONLY to the sender (never broadcast). */
export const WS_DIRECT_SERVER_TYPES: readonly WsServerMessageType[] = [
  'welcome',
  'snapshot',
  'snapshot.unchanged',
  'error',
  'heartbeat.ack',
  'auth.refreshed',
  'ticket.renewal-required',
  'ticket.renewed',
  'catch.runner-token',
] as const;

/** Server→client types relayed team-only (lobby scope = whole lobby). */
export const WS_TEAM_ONLY_SERVER_TYPES: readonly WsServerMessageType[] = [
  'voice.signal',
  'radio',
  'teammate.fix',
] as const;

/** Server→client types sent only to the ping's recipient role (a Runner ping to Hunters, a Hunter ping to Runners). */
export const WS_ROLE_SCOPED_SERVER_TYPES: readonly WsServerMessageType[] = ['ping'] as const;

// ---------------------------------------------------------------------------
// Game events (audit log) — 11 types
// ---------------------------------------------------------------------------

export type GameEventType =
  | 'PLAYER_JOINED'
  | 'PLAYER_READY'
  | 'MATCH_STARTED'
  | 'LOCATION_UPDATED'
  | 'LOCATION_PING_SENT'
  | 'PLAYER_TAGGED'
  | 'ZONE_UPDATED'
  | 'PLAYER_DISCONNECTED'
  | 'PLAYER_RECONNECTED'
  | 'GPS_VIOLATION'
  | 'MATCH_COMPLETED';

export const GAME_EVENT_TYPES: readonly GameEventType[] = [
  'PLAYER_JOINED',
  'PLAYER_READY',
  'MATCH_STARTED',
  'LOCATION_UPDATED',
  'LOCATION_PING_SENT',
  'PLAYER_TAGGED',
  'ZONE_UPDATED',
  'PLAYER_DISCONNECTED',
  'PLAYER_RECONNECTED',
  'GPS_VIOLATION',
  'MATCH_COMPLETED',
] as const;

/**
 * Payloads for the game events. Privacy: raw coordinates appear ONLY in
 * `LOCATION_UPDATED` / `LOCATION_PING_SENT` payloads (active-room state,
 * purged at match end); persistent logs and recovery snapshots carry the
 * event WITHOUT coordinates.
 */
export interface GameEventPayloads {
  PLAYER_JOINED: { playerId: string; displayName: string };
  PLAYER_READY: { playerId: string; isReady: boolean };
  MATCH_STARTED: { startedAt: string; endsAt: string };
  LOCATION_UPDATED: { playerId: string };
  LOCATION_PING_SENT: { pingId: string; subjectPlayerId: string };
  PLAYER_TAGGED: { catchId: string; hunterPlayerId: string; runnerPlayerId: string };
  ZONE_UPDATED: { zone: ZoneConfig };
  PLAYER_DISCONNECTED: { playerId: string; reason?: string };
  PLAYER_RECONNECTED: { playerId: string };
  /**
   * v29 (Gap 1) — a seat reached 3 GPS violations in 5 min. Coordinates
   * NEVER appear here (player id, kind and count only); the
   * `room_events` trigger rejects coordinate keys at any depth.
   */
  GPS_VIOLATION: { playerId: string; kind: 'speed' | 'burst' | 'teleport'; count: number };
  MATCH_COMPLETED: { result: MatchResult; room: Pick<Room, 'roomId' | 'phase'> };
}

/**
 * Game-event envelope. `seq` is assigned by the DO. Deduplication by `id`
 * (retries reuse the id). The DO keeps a redacted log capped at 500.
 */
export interface GameEvent<T extends GameEventType = GameEventType> {
  id: string;
  timestamp: string;
  roomId: string;
  actorId: string;
  type: T;
  payload: GameEventPayloads[T];
  seq?: number;
}

/** Type guard: is this string a known game-event type? */
export function isGameEventType(value: string): value is GameEventType {
  return (GAME_EVENT_TYPES as readonly string[]).includes(value);
}
