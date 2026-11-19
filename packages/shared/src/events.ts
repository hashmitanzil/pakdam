/**
 * Pakdam WS event catalogue — frozen contract v2.1.
 *
 * 22 client→server message types, 34 server→client types.
 *
 * NOTE — server count: the protocol map's header states 35 server→client
 * types but its own §2.4 table enumerates 34 distinct type names (7
 * connection + 7 roster + 9 play + 5 catch + 3 safety + 3 match = 34).
 * This file implements the 34 enumerated types exactly; no 35th type
 * exists in the table, so 34 is the complete count. The protocol map's
 * header count (and BEHAVIOUR.md, which copied it) were wrong, not the
 * enumeration. If a 35th type is ever identified, add it here and bump
 * the protocol version. Do not invent one to make the count match.
 *
 * Broadcast scoping (server-side, must be preserved): direct messages
 * (`welcome`, `snapshot`, `error`, `heartbeat.ack`, `auth.refreshed`,
 * `ticket.renewal-required`) go only to the sender; `voice.signal` and
 * `radio` are team-only (lobby = whole lobby); `ping` is Hunters-only;
 * `reveal` goes to the whole room; everything else broadcasts to the room.
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
  RevealArea,
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

export interface RevealSendPayload {
  fix: LocationFix;
}

export interface CatchRequestPayload {
  runnerId: string;
}

/** Runner confirms with the fetched QR token, or manually with no token. */
export interface CatchConfirmPayload {
  catchId: string;
  qrToken: string;
  manualConfirm?: boolean;
  resolution?: 'manual-confirm';
}

export interface CatchDisputePayload {
  catchId: string;
  reason: string;
}

export interface SafetyPausePayload {
  reason: string | null;
}

export interface SafetySosPayload {
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
}

export interface ResyncRequestPayload {
  lastServerSeq: number;
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
  'reveal.send': RevealSendPayload;
  'catch.request': CatchRequestPayload;
  'catch.confirm': CatchConfirmPayload;
  'catch.dispute': CatchDisputePayload;
  'safety.pause': SafetyPausePayload;
  'safety.resume': EmptyPayload;
  'safety.sos': SafetySosPayload;
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
  'reveal.send',
  'catch.request',
  'catch.confirm',
  'catch.dispute',
  'safety.pause',
  'safety.resume',
  'safety.sos',
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
// Server → client (34 enumerated types; see note at the top of this file)
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

export interface SosRaisedPayload {
  byPlayerId: string;
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

export interface RevealEventPayload {
  reveal: RevealArea;
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
  'room.state': RoomStatePayload;
  'ticket.renewal-required': TicketRenewalRequiredPayload;
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
  reveal: RevealEventPayload;
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
  'safety.paused': SafetyPausedPayload;
  'safety.resumed': SafetyResumedPayload;
  'sos.raised': SosRaisedPayload;
  'match.started': MatchStartedPayload;
  'match.completed': MatchCompletedPayload;
  'match.cancelled': MatchCancelledPayload;
}

export type WsServerMessageType = keyof WsServerPayloads;

export const WS_SERVER_TYPES: readonly WsServerMessageType[] = [
  'welcome',
  'snapshot',
  'room.state',
  'ticket.renewal-required',
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
  'reveal',
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
  'safety.paused',
  'safety.resumed',
  'sos.raised',
  'match.started',
  'match.completed',
  'match.cancelled',
] as const;

/** Type guard: is this string a known server→client message type? */
export function isWsServerMessageType(value: string): value is WsServerMessageType {
  return (WS_SERVER_TYPES as readonly string[]).includes(value);
}

/** Server→client types sent ONLY to the sender (never broadcast). */
export const WS_DIRECT_SERVER_TYPES: readonly WsServerMessageType[] = [
  'welcome',
  'snapshot',
  'error',
  'heartbeat.ack',
  'auth.refreshed',
  'ticket.renewal-required',
] as const;

/** Server→client types relayed team-only (lobby scope = whole lobby). */
export const WS_TEAM_ONLY_SERVER_TYPES: readonly WsServerMessageType[] = [
  'voice.signal',
  'radio',
] as const;

/** Server→client types sent Hunters-only. */
export const WS_HUNTERS_ONLY_SERVER_TYPES: readonly WsServerMessageType[] = ['ping'] as const;

// ---------------------------------------------------------------------------
// Game events (audit log) — 10 types
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
