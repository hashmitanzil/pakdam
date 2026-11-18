/**
 * Pakdam shared types — ONE canonical model (v2.1 Issue 6/7 fix).
 * Canonical Postgres tables (docs/CANONICAL-SCHEMA.md): profiles, players,
 * rooms, room_events, catches, safety_events, bug_reports, grievances,
 * audit_log, telemetry_daily. No `room_participants` / `match_events` /
 * `match_results` / `catch_attempts` / `support_tickets` / `saved_arenas`
 * tables exist in this codebase — those were the competing schema in Pack v2.
 *
 * Host vs match role (v2.1 Issue 7): a Player has `isHost` (room
 * permission) SEPARATE from `matchRole` ('hunter' | 'runner' | null).
 * A host CAN also be a Hunter or a Runner. There is no 'host' match role.
 */
// HNT-001..126 register; Phase 0 = P0 75 (see docs/DECISIONS.md)
export type MatchPhase =
  | 'DRAFT' | 'LOBBY' | 'READY_CHECK' | 'COUNTDOWN' | 'HEAD_START'
  | 'ACTIVE' | 'SAFETY_PAUSED' | 'RESOLVING' | 'COMPLETED'
  | 'CANCELLED' | 'ABANDONED' | 'EXPIRED';
/** Game modes in the pilot — Classic Manhunt and Infection only.
 *  Breach and Zombie are later, not now (founder decision, 2026-11-17):
 *  they are not offered, not stored, and not valid in a room config. */
export type MatchMode = 'classic' | 'infection';
// How Hunters are picked: 'random' (assigned when the game starts) or
// 'selected' (the host picks exactly hunterCount players in the lobby).
export type TeamAssignment = 'random' | 'selected';
export type MatchRole = 'hunter' | 'runner'; // match role only — never 'host'
export type Team = 'hunters' | 'runners';
export type PlayerKind = 'host-account' | 'guest';
export type ConnectionState = 'connected' | 'stale' | 'suspended' | 'disconnected';
export type LocationQuality = 'good' | 'fair' | 'poor' | 'stale' | 'suspicious' | 'unknown';

export interface Player {
  playerId: string; roomId: string; kind: PlayerKind;
  displayName: string;
  isHost: boolean;                 // room permission — separate from matchRole
  matchRole: MatchRole | null;     // server-assigned only (HNT-021)
  team: Team | null;
  reconnectTokenHash: string;      // hash only; raw token lives in browser storage (HNT-006)
  joinedAt: string; leftAt: string | null;
  /** Set when the player is ejected for staying outside the play zone
   *  past the 30-second return countdown (founder rule, 2026-11-17).
   *  Null while the player is in the game. An ejected player is out of
   *  play — shown as ejected in the roster and results — but stays in
   *  the room record (they are NOT deleted, and leftAt stays null). */
  ejectedAt: string | null;
  connectionState: ConnectionState;
  lastFixAt: string | null;        // timestamp only — NEVER the fix itself
  locationQuality: LocationQuality;
  isReady: boolean;
  briefingConfirmed: boolean;      // HNT-032/057
  ageGatePassed: boolean;          // HNT-001/065 — assurance method OPEN
  suspensionCount: number;         // v2.1 Issue 3 — repeated suspension is a fairness signal
}

export interface GeoPoint { lat: number; lng: number }
export type GeoPolygon = GeoPoint[];
export interface ZoneConfig {
  boundary: GeoPolygon;
  shrinkPhases: { atSeconds: number; boundary: GeoPolygon }[];
}
/**
 * HouseRules — every host-customisable rule of a game, with no hidden
 * defaults: the host sets each one on the create screen (sliders /
 * steppers), and a saved house-rule preset is just these fields with a
 * name. All durations are seconds; pingIntervalSeconds 0 = no pings.
 * Ranges are enforced by validateRoomConfig / validateHousePreset.
 * Every numeric default is a calibration placeholder (OPEN) — see
 * CALIBRATION_OPEN; none is a measured requirement.
 */
export interface HouseRules {
  mode: MatchMode;
  teamAssignment: TeamAssignment;
  maxPlayers: number; // 3–30 (personal game; founder raised the limit 16 -> 30, 2026-11-17)
  hunterCount: number; // 1..maxPlayers-1
  durationSeconds: number; // 5 min–3 h (300–10800)
  headStartSeconds: number; // 0–30 min (0–1800)
  pingIntervalSeconds: number; // 0 = no pings, else 30 s–30 min (30–1800)
  zoneShrinkEnabled: boolean;
  zoneShrinkIntervalSeconds: number; // shrink every N seconds, when enabled
  catchConfirmationRequired: boolean; // false = a Hunter tag counts at once (Runner may still dispute)
  // No outside-zone timing fields: the rule is a single fixed founder
  // rule (see OUTSIDE_ZONE_RETURN_SECONDS below), not a host setting.
  // --- Host-setup toggles (location-first redesign, Nov 2026) ---
  // All four are OPTIONAL so rooms/presets saved before they existed
  // still validate: absent means the legacy behaviour (see defaults in
  // resolveHostToggles). The create screen always writes them explicitly.
  /** ON = the Hunter count is set from the roster at match start
   *  (balancedHunterCount, provisional table, calibration OPEN).
   *  OFF = the host's hunterCount stepper value is used. Absent = OFF. */
  balanceHunters?: boolean;
  /** ON = Hunters are drawn at random at match start (a real shuffle,
   *  not join order). Only meaningful with teamAssignment 'random';
   *  OFF + 'random' keeps the legacy deterministic join-order draw
   *  the demo board relies on. Absent = OFF. */
  randomDraw?: boolean;
  /** ON = the play zone is on (zone enforced, pings on schedule).
   *  OFF = no zone, no pings — classic hide and seek: Hunters find
   *  Runners by looking, not by pings or a boundary. Absent = ON. */
  playZoneEnabled?: boolean;
  /** ON = Hunters can use Team Radio. OFF = the Hunters' radio channel
   *  is off for this game (Runners can still use theirs). Absent = ON. */
  huntersCanTalk?: boolean;
  /** Final zone size as a percentage of the starting size, applied at
   *  the last shrink. null/absent = Auto: the zone keeps 75% of its
   *  size per shrink (the existing shrink rule). 5–100 when set. */
  finalSizePercent?: number | null;
  /** ON = Hunters see each Runner's earlier pings, not just the latest.
   *  Pings stay coarse areas — never exact pins. Absent = OFF. */
  showPingHistory?: boolean;
  // No discovery/listing field: Pakdam is private invite-only by room
  // code only — there is no public listing, no nearby-rooms list, and
  // no "list to players nearby" setting (founder decision, 2026-11-17).
}
/** Defaults for the host-setup toggles on a room saved before they
 *  existed: everything OFF, i.e. the legacy behaviour is preserved. */
export const LEGACY_HOST_TOGGLES: Required<Pick<HouseRules, 'balanceHunters' | 'randomDraw' | 'showPingHistory'>> = {
  balanceHunters: false, randomDraw: false, showPingHistory: false,
};
/** The create screen's defaults: Balance ON, Random draw ON, ping
 *  history OFF. */
export const DEFAULT_HOST_TOGGLES: Required<Pick<HouseRules, 'balanceHunters' | 'randomDraw' | 'showPingHistory'>> = {
  balanceHunters: true, randomDraw: true, showPingHistory: false,
};
/** Fill in any missing host-setup toggle with its legacy default, so
 *  old rooms and presets behave exactly as they did before. */
export function resolveHostToggles(r: HouseRules): Required<Pick<HouseRules, 'balanceHunters' | 'randomDraw' | 'showPingHistory'>> {
  return {
    balanceHunters: r.balanceHunters ?? LEGACY_HOST_TOGGLES.balanceHunters,
    randomDraw: r.randomDraw ?? LEGACY_HOST_TOGGLES.randomDraw,
    showPingHistory: r.showPingHistory ?? LEGACY_HOST_TOGGLES.showPingHistory,
  };
}
/** Zone radius bounds for host setup (location-first redesign).
 *  Minimum diameter 200 m (radius 100 m). Default 500 m.
 *  Stepper/slider step 50 m.
 *  NO MAXIMUM (founder decision, 2026-11-17 — "unlimited past
 *  1 km"): the old 1.5 km cap (ZONE_RADIUS_MAX_M) is deleted, and
 *  no validation anywhere enforces an upper size. The host can set
 *  any radius. ZONE_RADIUS_UI_MAX_M below is only the slider /
 *  stepper list's convenience range — it is never a rule and never
 *  blocks a larger radius set with the + buttons or keyboard. */
export const ZONE_RADIUS_MIN_M = 100;
export const ZONE_RADIUS_DEFAULT_M = 500;
export const ZONE_RADIUS_STEP_M = 50;
/** Slider / stepper convenience range only (10 km radius = 20 km
 *  across — far wider than the downloaded offline map, ~7 km
 *  across). NOT a cap: validation accepts any radius >= the
 *  minimum, and the + controls keep growing past this range. */
export const ZONE_RADIUS_UI_MAX_M = 10000;
/** Outside-zone rule (founder, 2026-11-17 — FINAL, replaces the old
 *  SCRAM live/tag sliders): a player outside the play zone
 *  gets a 30-second return countdown on their own screen. Get back
 *  inside before it ends, or they are EJECTED from the game. While
 *  outside (during those 30 seconds) Hunters may see the player's
 *  coarse area — never an exact pin. This is a fixed rule, NOT a
 *  calibration placeholder and NOT a host setting. */
export const OUTSIDE_ZONE_RETURN_SECONDS = 30;
/** Zone-centre rule (founder, 2026-11-17 — a zone built 2–3 km from the
 *  host's real spot is unusable): a zone is NEVER auto-centred on a GPS
 *  fix worse than ±50 m. A coarser fix is rejected — the host places the
 *  zone by hand instead (tap the map / drag the centre pin). The centre
 *  must equal the user's real position or the pin they placed, never a
 *  coarse fix, never a default. This is a fixed founder rule, NOT a
 *  calibration placeholder. */
export const ZONE_AUTO_CENTRE_MAX_ACCURACY_M = 50;
/** A saved house-rule preset: HouseRules + a host-chosen name. Saved on
 *  the host's device only (localStorage); never a payment or membership.
 *  `radiusMeters` (optional) remembers the zone size the preset was
 *  saved with; presets saved before it existed simply leave the
 *  current radius alone. */
export interface HouseRulePreset {
  presetId: string; name: string; createdAt: string; rules: HouseRules;
  radiusMeters?: number;
}
export interface RoomConfig extends HouseRules {
  zone: ZoneConfig;
  /** 'circle' = the zone is a circle around the host's location
   *  (radius stepper). 'draw' = the host drew a custom polygon on the
   *  map (draggable corners). Absent = 'circle' (rooms saved before
   *  Draw mode existed). The boundary polygon itself is zone.boundary
   *  in both shapes — the engine enforces polygons, not circles. */
  zoneShape?: 'circle' | 'draw';
  safeAreas: GeoPolygon[]; noGoAreas: GeoPolygon[];
  // Host-picked Hunters when teamAssignment is 'selected'; chosen in the
  // lobby from joined players, so empty at creation time. Must hold
  // exactly hunterCount ids when the game starts.
  selectedHunterIds: string[];
  hostOnSiteConfirmed: boolean;
  // No venue/area name field: the game starts from the host's GPS
  // location + a zone on the map (redesign 2026-11-17). Nothing in this
  // codebase may re-add a place-name field to the schema.
}
export interface MatchResult {
  outcome: 'hunters-win' | 'runners-win' | 'cancelled' | 'abandoned';
  durationSeconds: number;
  caughtRunnerIds: string[]; survivingRunnerIds: string[];
  // NO exact routes, NO coordinate trails (HNT-069)
}
export interface Room {
  roomId: string; roomCode: string; // short, high-entropy (HNT-013)
  hostPlayerId: string; phase: MatchPhase; version: number;
  config: RoomConfig; createdAt: string;
  startedAt: string | null; endsAt: string | null; pausedAt: string | null;
  result: MatchResult | null;
}
// LocationFix lives ONLY in Durable Object active-room state. NEVER in
// Postgres, the event log, analytics or audit logs. Purged at match end/TTL (HNT-068).
export interface LocationFix {
  playerId: string; roomId: string; lat: number; lng: number;
  accuracyMeters: number; capturedAt: string; receivedAt: string;
  quality: Exclude<LocationQuality, 'unknown'>;
}
export type CatchState = 'requested' | 'awaiting-confirmation' | 'confirmed' | 'disputed' | 'rejected' | 'expired';
export interface CatchEvent {
  catchId: string; roomId: string; hunterPlayerId: string; runnerPlayerId: string;
  state: CatchState; qrTokenHash: string | null;
  requestedAt: string; confirmedAt: string | null; disputedAt: string | null;
  resolution: string | null;
  gpsEvidence: 'present' | 'absent' | 'stale'; // supporting only, NEVER sole proof (HNT-053)
}
// Ping is a COARSE signal, never a false-precision dot (HNT-024/025).
export interface Ping {
  pingId: string; roomId: string; subjectPlayerId: string; recipientRole: 'hunters';
  uncertainty: { centre: GeoPoint; radiusMeters: number } | { sector: string };
  ageSeconds: number; qualityAtPing: LocationQuality; createdAt: string;
  expiresAt: string; // v2.1 Issue 9 — pending pings expire; stale pings are never delivered
}
export type SafetyEventType = 'briefing-confirmed' | 'safety-pause' | 'safety-resume' | 'sos' | 'leave' | 'stop-sharing' | 'report' | 'block';
export interface SafetyEvent {
  eventId: string; roomId: string; playerId: string;
  type: SafetyEventType; reason: string | null; createdAt: string;
}
export interface BugReport {
  reportId: string; roomId: string | null; playerId: string | null;
  deviceInfo: string; appVersion: string; description: string;
  status: 'open' | 'triaged' | 'resolved'; createdAt: string;
}
export interface Grievance {
  grievanceId: string; complainantRef: string; channel: 'in-app' | 'email';
  summary: string; status: 'acknowledged' | 'in-review' | 'resolved' | 'escalated';
  acknowledgedAt: string | null; resolvedAt: string | null;
}
export interface AuditLogEntry {
  entryId: string; actorId: string; actorRole: string; action: string;
  roomId: string | null; targetId: string | null; createdAt: string; result: 'allowed' | 'denied';
}
// --- WebSocket protocol (17 §3, v2.1 FROZEN contract) ---
// Ticket travels ONLY in the handshake query string
//   wss://<api-host>/v1/rooms/{roomId}/ws?ticket=<ticket>
// The `hello` message carries NO credential. The ONLY message that carries
// a ticket is `auth.refresh` (renewal, 17 §3.2). The v2 `hello`-with-ticket
// shape is deleted — a hello containing token/ticket/password is rejected
// with VALIDATION_FAILED and audited.
export type WsTicketPurpose = 'connect' | 'renew';
export const WS_PROTOCOL_VERSION = 1;
/** OPEN calibration (17 §7). `null` = not fixed by measurement yet; no
 *  number anywhere in this codebase is a measured requirement. */
export const WS_OPEN_CALIBRATION = {
  wsTicketTtlSeconds: null as number | null,
  heartbeatIntervalSeconds: null as number | null,
  missedHeartbeatLimit: null as number | null,
  wsRenewalGraceSeconds: null as number | null,
  maxReconnectAttempts: null as number | null,
  reconnectBaseDelayMs: null as number | null,
} as const;

/** PlayerView — the recipient-specific player shape sent over WS/REST.
 *  It NEVER carries a reconnect-token hash (17 §3.3 snapshot rule). */
export type PlayerView = Omit<Player, 'reconnectTokenHash'>;
/** CatchView — a catch as sent to clients. The QR token hash is NEVER in
 *  any payload (17 §3.3). */
export type CatchView = Omit<CatchEvent, 'qrTokenHash'>;
export interface Announcement {
  announcementId: string; roomId: string; text: string;
  sentByPlayerId: string; sentAt: string;
}
export interface QuickSignal {
  signalId: string; roomId: string; playerId: string;
  code: string; // preset code only, closed set (HNT-102) — no free text in Phase 0
  sentAt: string;
}
export interface MapPin {
  pinId: string; roomId: string; playerId: string;
  point: GeoPoint; label: string; createdAt: string;
}
/** One Team Radio text message (D-M7, 2026-11-17): free text (≤140
 *  chars) or a closed-set quick message, sent by one seat and relayed
 *  by the DO to that seat's TEAM only (lobby scope: the whole lobby —
 *  roles do not exist yet). `senderName` is the seat's display name
 *  as the server knows it, never a client claim. This type carries
 *  TEXT only — voice rides a separate channel (D-M1, `voice.signal`),
 *  untouched here. */
export interface RadioMessage {
  messageId: string; roomId: string; playerId: string;
  senderName: string; text: string; kind: 'quick' | 'text'; sentAt: string;
}
/** A "Tell everyone" reveal: the coarse area a player deliberately
 *  shared with the whole room (hold-to-reveal, D-M6). The centre is
 *  the revealer's fix at reveal time and the radius is the same
 *  150 m coarse area as a ping — never an exact pin. Clients draw
 *  the area on the map and never render lat/lng numbers. */
export interface RevealArea {
  revealId: string; roomId: string; byPlayerId: string;
  centre: GeoPoint; radiusMeters: number; sentAt: string;
}
export interface WsSafetyState {
  paused: boolean; pausedBy: string | null; pausedAt: string | null; sosActive: boolean;
}
export interface WsSnapshotPayload {
  room: Room; players: PlayerView[]; phase: MatchPhase; version: number;
  serverSeq: number;
  /** 'known' only while a fresh foreground fix is held; 'unknown' for every
   *  player after a recovery until a fresh fix arrives (17 §3.5, 04 §8). */
  locationStatus: Record<string, 'known' | 'unknown'>;
  activeCatches: CatchView[]; // recipient-filtered; NO token hashes
  safetyState: WsSafetyState;
  missedAnnouncements: Announcement[];
  // NO raw coordinates, NO pending pings, NO token hashes — ever (17 §3.3).
}
/** Versioned WS error payload (17 §5). Never contains a token, a ticket
 *  value, a secret, or a raw coordinate. */
export interface WsErrorPayload {
  code: string; message: string; retryable: boolean;
  retryAfterSeconds: number | null; requestId: string;
  details: { field: string; issue: string }[] | null;
  serverTs: number;
}

// --- Voice radio (D-M1, 2026-11-17) — FREE WebRTC peer-to-peer, team-only.
// Signalling rides the existing game WebSocket (`voice.signal`,
// client → server → one teammate); the voice itself NEVER goes
// through the Worker — it flows directly peer to peer over WebRTC
// (free public STUN only, no TURN relay, no server, no recording,
// no storage). The Durable Object enforces team-only delivery (see
// workers/src/room-do.ts): a signal whose sender and recipient are
// not on the same team is rejected, so the other team — and the host
// on the other team — never receives it. `join`/`leave` are presence
// (no SDP): a teammate that enables voice sends `join` to each
// teammate; the recipient answers with an `offer` (so exactly one
// side offers — no glare). `offer`/`answer` carry SDP (≤ 8 KB);
// `ice` carries one ICE candidate. Payloads carry player ids only —
// never audio, never coordinates, never a token. */
export type VoiceSignalKind = 'join' | 'leave' | 'offer' | 'answer' | 'ice';
export interface VoiceIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}
/** Client → server: `toPlayerId` is the ONE teammate the signal is
 *  for (the DO forwards it to that seat only). */
export interface VoiceSignalPayload {
  toPlayerId: string;
  kind: VoiceSignalKind;
  sdp?: string;
  candidate?: VoiceIceCandidate;
}
/** Server → client: the DO stamps `fromPlayerId` and re-sends the
 *  kind/sdp/candidate, plus `toPlayerId` so the fan-out can address
 *  the single recipient (the host gets no copy — voice is team-only,
 *  unlike `signal`/`pin`, which the host also sees). */
export interface VoiceSignalBroadcast {
  fromPlayerId: string;
  toPlayerId: string;
  kind: VoiceSignalKind;
  sdp?: string;
  candidate?: VoiceIceCandidate;
}
// (REQUIRED for mutating commands, §3.6), roomId, playerId, clientSeq
// (per-connection, increments by 1), clientTs (epoch ms, display only).
export interface WsClientEnvelope<Type extends string, Payload> {
  v: 1; type: Type; commandId?: string; roomId: string; playerId: string;
  clientSeq: number; clientTs: number; payload: Payload;
}
export type WsClientMessage =
  | WsClientEnvelope<'hello', { protocolVersion: 1; clientVersion: string; lastServerSeq: number }>
  | WsClientEnvelope<'auth.refresh', { ticket: string }>
  | WsClientEnvelope<'heartbeat', Record<string, never>>
  | WsClientEnvelope<'location.update', { fix: LocationFix }>
  | WsClientEnvelope<'catch.request', { runnerId: string }>
  | WsClientEnvelope<'catch.confirm', { catchId: string; qrToken: string; manualConfirm?: boolean; resolution?: 'manual-confirm' }>
  | WsClientEnvelope<'catch.dispute', { catchId: string; reason: string }>
  | WsClientEnvelope<'safety.pause', { reason: string | null }>
  | WsClientEnvelope<'safety.resume', Record<string, never>>
  | WsClientEnvelope<'safety.sos', { reason: string | null }>
  | WsClientEnvelope<'leave', { reason: string | null }>
  | WsClientEnvelope<'signal.send', { code: string }>
  | WsClientEnvelope<'radio.send', { text: string; kind?: 'quick' | 'text' }>
  | WsClientEnvelope<'voice.signal', VoiceSignalPayload>
  | WsClientEnvelope<'pin.place', { point: GeoPoint; label: string }>
  | WsClientEnvelope<'announcement.send', { text: string }>
  | WsClientEnvelope<'reveal.send', { fix: LocationFix }>
  | WsClientEnvelope<'ready.set', { isReady: boolean }>
  | WsClientEnvelope<'briefing.confirm', Record<string, never>>
  | WsClientEnvelope<'snapshot.request', { lastServerSeq: number }>
  | WsClientEnvelope<'resync.request', { lastServerSeq: number }>
  // Suspension signal (client → server): the tab-hidden / screen-locked
  // notice of 17 §3.7 stage 2. Same type name as the server broadcast.
  | WsClientEnvelope<'player.suspended', { reason: 'tab-hidden' | 'screen-locked' | 'network-lost' | 'heartbeat-timeout' | 'unknown' }>;
export const WS_CLIENT_TYPES = [
  'hello', 'auth.refresh', 'heartbeat', 'location.update', 'catch.request',
  'catch.confirm', 'catch.dispute', 'safety.pause', 'safety.resume',
  'safety.sos', 'leave', 'signal.send', 'radio.send', 'voice.signal', 'pin.place', 'announcement.send', 'reveal.send',
  'ready.set', 'briefing.confirm', 'snapshot.request', 'resync.request',
  'player.suspended',
] as const;
export type WsClientType = (typeof WS_CLIENT_TYPES)[number];

// --- Server → client (17 §3.3). Common envelope: v, type, roomId,
// eventId, serverSeq (monotonic per room), serverTs (epoch ms).
export interface WsServerEnvelope<Type extends string, Payload> {
  v: 1; type: Type; roomId: string; eventId: string;
  serverSeq: number; serverTs: number; payload: Payload;
}
export type WsServerMessage =
  | WsServerEnvelope<'welcome', { playerId: string; serverSeq: number; serverTs: number; protocolVersion: 1 }>
  | WsServerEnvelope<'snapshot', WsSnapshotPayload>
  | WsServerEnvelope<'room.state', { phase: MatchPhase; version: number; serverSeq: number; reason: string | null }>
  | WsServerEnvelope<'player.joined', { player: PlayerView; serverSeq: number }>
  | WsServerEnvelope<'player.left', { player: PlayerView; serverSeq: number }>
  | WsServerEnvelope<'player.removed', { player: PlayerView; serverSeq: number }>
  | WsServerEnvelope<'player.suspended', { playerId: string; reason: 'tab-hidden' | 'screen-locked' | 'network-lost' | 'heartbeat-timeout' | 'unknown'; serverSeq: number }>
  | WsServerEnvelope<'player.resumed', { playerId: string; serverSeq: number }>
  | WsServerEnvelope<'player.visibility', { playerId: string; locationQuality: LocationQuality; lastFixAt: string | null; serverSeq: number }>
  | WsServerEnvelope<'ping', { ping: Ping; serverSeq: number }>
  | WsServerEnvelope<'ping.expired', { pingId: string; subjectPlayerId: string; expiresAt: string }>
  | WsServerEnvelope<'zone.update', { zone: ZoneConfig; phase: number; serverSeq: number }>
  | WsServerEnvelope<'catch.requested', { catch: CatchView; serverSeq: number }>
  | WsServerEnvelope<'catch.confirmed', { catch: CatchView; serverSeq: number }>
  | WsServerEnvelope<'catch.disputed', { catch: CatchView; serverSeq: number }>
  | WsServerEnvelope<'catch.expired', { catch: CatchView; serverSeq: number }>
  | WsServerEnvelope<'catch.rejected', { catch: CatchView; serverSeq: number }>
  | WsServerEnvelope<'safety.paused', { byPlayerId: string; reason: string | null; serverSeq: number }>
  | WsServerEnvelope<'safety.resumed', { byPlayerId: string; reason: string | null; serverSeq: number }>
  | WsServerEnvelope<'sos.raised', { byPlayerId: string; serverSeq: number }>
  | WsServerEnvelope<'match.started', { result: MatchResult | null; serverSeq: number }>
  | WsServerEnvelope<'match.completed', { result: MatchResult | null; serverSeq: number }>
  | WsServerEnvelope<'match.cancelled', { result: MatchResult | null; serverSeq: number }>
  | WsServerEnvelope<'announcement', { announcement: Announcement; serverSeq: number }>
  | WsServerEnvelope<'reveal', { reveal: RevealArea; serverSeq: number }>
  | WsServerEnvelope<'signal', { signal: QuickSignal; serverSeq: number }>
  | WsServerEnvelope<'radio', { radio: RadioMessage; serverSeq: number }>
  | WsServerEnvelope<'voice.signal', VoiceSignalBroadcast>
  | WsServerEnvelope<'pin', { pin: MapPin; serverSeq: number }>
  | WsServerEnvelope<'host.transferred', { previousHostPlayerId: string; newHostPlayerId: string; serverSeq: number }>
  | WsServerEnvelope<'ticket.renewal-required', { expiresAt: string }>
  | WsServerEnvelope<'auth.refreshed', { expiresAt: string; serverTs: number }>
  | WsServerEnvelope<'heartbeat.ack', { serverTs: number; serverSeq: number }>
  | WsServerEnvelope<'error', WsErrorPayload>;
export const WS_SERVER_TYPES = [
  'welcome', 'snapshot', 'room.state', 'player.joined', 'player.left',
  'player.removed', 'player.suspended', 'player.resumed', 'player.visibility',
  'ping', 'ping.expired', 'zone.update', 'catch.requested', 'catch.confirmed',
  'catch.disputed', 'catch.expired', 'catch.rejected', 'safety.paused',
  'safety.resumed', 'sos.raised', 'match.started', 'match.completed',
  'match.cancelled', 'announcement', 'reveal', 'signal', 'voice.signal', 'pin', 'host.transferred',
  'ticket.renewal-required', 'auth.refreshed', 'heartbeat.ack', 'error', 'radio',
] as const;
export type WsServerType = (typeof WS_SERVER_TYPES)[number];

/** Close codes (17 §3.4) and what the client must do. */
export type WsCloseCode = 1000 | 1001 | 1006 | 4400 | 4401 | 4403 | 4409 | 4413 | 1011;
export type WsCloseAction =
  | 'do-not-reconnect'
  | 'reconnect-with-backoff'
  | 'fresh-ticket-then-reconnect-once'
  | 'upgrade-no-retry'
  | 'backoff-until-retry-after';
export const WS_CLOSE_CODE_ACTION: Record<WsCloseCode, WsCloseAction> = {
  1000: 'do-not-reconnect',           // normal closure (match end, clean leave)
  1001: 'reconnect-with-backoff',     // going away
  1006: 'reconnect-with-backoff',     // abnormal closure (network, suspend)
  4400: 'fresh-ticket-then-reconnect-once', // bad request (malformed handshake/hello)
  4401: 'fresh-ticket-then-reconnect-once', // ticket invalid / reused / expired
  4403: 'do-not-reconnect',           // forbidden (seat removed / blocked / revoked)
  4409: 'upgrade-no-retry',           // protocol unsupported (version mismatch)
  4413: 'backoff-until-retry-after',  // rate-limited disconnect (retryAfterSeconds)
  1011: 'reconnect-with-backoff',     // server error
};

/** True when a `hello` message carries a credential field anywhere in its
 *  top level or its payload. Any such hello is rejected with
 *  VALIDATION_FAILED and audited (17 §3.1 rule 4). */
const CREDENTIAL_FIELDS = ['token', 'ticket', 'password', 'authToken', 'reconnectToken'] as const;
export function helloHasCredential(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  for (const f of CREDENTIAL_FIELDS) if (f in obj) return true;
  const payload = obj['payload'];
  if (typeof payload === 'object' && payload !== null) {
    for (const f of CREDENTIAL_FIELDS) if (f in (payload as Record<string, unknown>)) return true;
  }
  return false;
}
export const ERROR_CODES = ['AUTH_REQUIRED','FORBIDDEN','ROOM_NOT_FOUND','INVALID_STATE','VALIDATION_FAILED','VERSION_CONFLICT','RATE_LIMITED','TOKEN_EXPIRED','TOKEN_REUSED','TICKET_INVALID','TICKET_REUSED','TICKET_EXPIRED','PROTOCOL_UNSUPPORTED','SNAPSHOT_REQUIRED','CATCH_EXPIRED','CATCH_DISPUTED','STALE_LOCATION','CONFLICT','SERVER_ERROR','SERVICE_UNAVAILABLE'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
