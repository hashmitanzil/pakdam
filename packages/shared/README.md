# @pakdam/shared

The pure foundation every other package imports. **Pure types + pure functions
only** — no I/O, no secrets, no imports from `engine`, `workers`, or `web`.

- Contract: frozen wire protocol **v2.1** (`PROTOCOL_VERSION = 1`).
- Stack: pnpm workspace, source-first — `exports` points at `src/index.ts`.
- `tsconfig.json` extends the root `tsconfig.base.json` (strict).
- `pnpm --filter @pakdam/shared typecheck` runs `tsc --noEmit`.

## Rules this package enforces

- **Ticket values are never stored, only hashes** — `hashToken` / `hashWsTicket` /
  `catchTokenHash`; see `src/hash.ts`.
- **Catch token ≥ 128 bits** — `newCatchToken()` makes 32 uppercase hex chars;
  the old 12-char (48-bit) form is rejected by `isValidCatchToken`.
- **Heartbeat is configured, never null** — `HEARTBEAT_INTERVAL_MS = 30_000`
  (OPEN, chosen so inbound traffic lands inside the 30 s renewal-warning window)
  and `HEARTBEAT_MISSED_LIMIT = 3` (from the old client's defaults).
- **OPEN values are placeholders to measure**, not requirements — every one is
  flagged `OPEN` in `src/calibration.ts` and grouped in `CALIBRATION_OPEN`.
- **Server-count note:** the protocol map states 35 server→client WS types but
  enumerates 34 distinct names; `WS_SERVER_TYPES` implements the 34 enumerated
  types exactly (see `src/events.ts`).

## Public API

### `src/calibration.ts` — every named constant

Protocol (frozen v2.1):

- `PROTOCOL_VERSION` — wire protocol version; `hello` must carry exactly 1.
- `CLIENT_VERSION` — client version string sent in `hello` (`pakdam-web/0.1.0`).
- `IDEMPOTENCY_TTL_MS` — (seat, commandId) idempotency records live 10 min.
- `RENEWAL_WARNING_MS` — DO warns once when the socket ticket expires within 30 s.
- `WS_TICKET_TTL_MS` — WS ticket TTL, 60 s (OPEN).
- `RECONNECT_MAX_ATTEMPTS` — reconnect attempts before `reconnect-failed` (5, OPEN).
- `RECONNECT_BACKOFF_BASE_MS` — reconnect backoff base, 1 s (OPEN).
- `RECONNECT_BACKOFF_CEILING_MS` — reconnect backoff ceiling, 30 s (OPEN).
- `HEARTBEAT_INTERVAL_MS` — heartbeat interval, 30 s (OPEN — see rules above).
- `HEARTBEAT_MISSED_LIMIT` — missed heartbeats before the client closes the socket (3, OPEN).
- `FIX_TTL_MS` — latest fixes older than 120 s are purged every DO tick.
- `GAME_EVENT_LOG_CAP` — redacted game-event log cap in the DO (500).
- `RADIO_KEEP_LAST` — text radio keeps the last 50 messages per client.
- `RADIO_MAX_CHARS` — text radio max 140 characters per message.
- `VOICE_MAX_BURST_MS` — voice radio max 10 s per push-to-talk burst.
- `VOICE_STUN_SERVERS` — free public STUN servers only; no TURN, no recording.
- `VOICE_SDP_MAX_BYTES` — voice SDP payload cap, 8 KB.

Fixed founder rules (NOT calibration):

- `MIN_PLAYERS` — minimum players to start: 3 (server + client gates agree).
- `MAX_PLAYERS` — maximum players in a room: 30.
- `ZONE_RADIUS_MIN_M` — zone radius minimum: 100 m.
- `ZONE_RADIUS_DEFAULT_M` — zone radius default: 500 m.
- `ZONE_RADIUS_STEP_M` — zone radius stepper step: 50 m.
- `ZONE_RADIUS_UI_MAX_M` — slider convenience range only (10 km); never a cap.
- `ZONE_DIAMETER_MIN_M` — minimum zone diameter: 200 m.
- `ZONE_AUTO_CENTRE_MAX_ACCURACY_M` — never auto-centre on a fix worse than ±50 m.
- `OUTSIDE_ZONE_RETURN_SECONDS` — outside-zone return countdown: 30 s, then ejection.
- `SHRINK_RADIUS_FACTOR` — each shrink keeps 75% of the radius.
- `MIN_NEXT_ZONE_OFFSET_M` — next-zone draws within 10 m of centre are re-drawn.
- `SHRINK_MAX_ATTEMPTS` — random next-zone draw attempts before fallbacks: 50.
- `CATCH_CONFIRMATION_REQUIRED` — runner confirmation is always required: true.
- `CATCH_TOKEN_HEX_LENGTH` — fresh catch token length: 32 hex chars.
- `CATCH_TOKEN_BITS` — fresh catch token entropy: 128 bits.
- `SCORING_RUNNER_PER_3_MIN_FREE` — Runner +1 per whole 3 min free.
- `SCORING_RUNNER_NEVER_CAUGHT` — Runner +10 never caught.
- `SCORING_HUNTER_PER_TAG` — Hunter +3 per confirmed tag.
- `SCORING_CLEAN_SWEEP` — +10 clean sweep to every Hunter on the winning side.
- `SESSION_STORAGE_KEY` — the one sessionStorage key: `pakdam.session.v1`.
- `SOS_COPY` — exact SOS copy: SOS alerts the host; Pakdam is NOT an emergency service.
- `CATCH_DISPUTE_REASON` — fixed string sent as the reason on `catch.dispute`.

OPEN — measure in the field before any public pilot:

- `ACCURACY_GOOD_M` — accuracy tier good: ≤ 10 m (OPEN).
- `ACCURACY_FAIR_M` — accuracy tier fair: ≤ 25 m (OPEN).
- `ACCURACY_POOR_M` — accuracy tier poor: ≤ 60 m (OPEN).
- `CATCH_PROXIMITY_PLAUSIBILITY_M` — catch proximity plausibility: 15 m (OPEN).
- `CATCH_TOKEN_TTL_SECONDS` — catch-token TTL: 120 s (OPEN).
- `PING_INTERVAL_SECONDS_DEFAULT` — default ping interval: 180 s (OPEN).
- `PING_ACCELERATION_SECONDS` — ping acceleration: 60 s (OPEN).
- `DISCONNECT_GRACE_SECONDS` — disconnect grace: 60 s (OPEN).
- `SUSPENSION_FRESHNESS_SECONDS` — suspension freshness: 30 s (OPEN).
- `LOCATION_FRESHNESS_SECONDS` — location freshness window: 30 s (OPEN).
- `SUSPENSIONS_BEFORE_HOST_CHECKIN` — suspensions before a host check-in: 3 (OPEN).
- `PENDING_PING_TTL_SECONDS` — pending (undelivered) ping TTL: 300 s (OPEN).
- `QUICK_PRESET_DURATION_SECONDS` — quick-preset duration: 1800 s (OPEN).
- `HEAD_START_SECONDS_DEFAULT` — head-start default: 180 s (OPEN).
- `STANDARD_DURATION_SECONDS` — standard round duration: 1800 s (OPEN).
- `ZONE_SHRINK_INTERVAL_SECONDS_DEFAULT` — zone shrink interval default: 600 s (OPEN).
- `PING_AREA_RADIUS_M` — ping area radius: 150 m, coarse area never an exact pin (OPEN).
- `CLOCK_SKEW_MS` — fix > 5 min in the future is rejected (OPEN).
- `STALE_FIX_MS` — fix > 60 s old on arrival is rejected (OPEN).
- `MAX_PLAUSIBLE_SPEED_MPS` — impossible movement > 30 m/s warns only (OPEN).
- `WRONG_SCAN_MAX` — demo-only wrong-scan cooldown: 3 wrong scans (OPEN).
- `WRONG_SCAN_LOCK_SECONDS` — demo-only wrong-scan lock: 30 s (OPEN).
- `BALANCED_HUNTER_TABLE` — Hunter balance table by roster size (OPEN).
- `SUGGESTED_ZONE_RADIUS_BASE_M` — suggested radius base: 200 m (OPEN).
- `SUGGESTED_ZONE_RADIUS_PER_PLAYER_M` — suggested radius per extra player: 25 m (OPEN).
- `SUGGESTED_ZONE_RADIUS_CAP_M` — suggested radius cap: 1000 m, starting point only (OPEN).
- `WS_MESSAGE_RATE_LIMITS` — WS per-seat per-message rate limits (OPEN; `player.suspended` exempt).
- `WS_MESSAGE_RATE_LIMIT_DEFAULT` — fallback WS per-message limit, 20/min (OPEN).
- `HTTP_RATE_LIMITS` — HTTP per-route rate limits incl. the 9 routes the old build left un-limited (OPEN).
- `CALIBRATION_OPEN` — all OPEN values grouped in one object for the field-measurement pass.

### `src/types.ts` — room / player / zone / ping / catch / safety / config / result

- `GeoPoint` — a point on Earth (lat ±90, lng ±180).
- `GeoPolygon` — a polygon boundary: ordered vertices, 3+ enclose a shape.
- `LocationFix` — a GPS fix: point + `accuracyMeters` + `timestampMs`.
- `LocationQuality` — fix quality tier: `good | fair | poor` (server decides).
- `MatchPhase` — the 12-phase DO state machine.
- `MATCH_PHASES` — all 12 phases in order.
- `TERMINAL_PHASES` — `COMPLETED / CANCELLED / ABANDONED / EXPIRED` (no outgoing edge).
- `MATCH_PHASE_TRANSITIONS` — allowed phase transitions (clock starts at `HEAD_START`).
- `MatchMode` — `classic | infection` only.
- `MATCH_MODES` — both modes.
- `MatchRole` — `hunter | runner`.
- `Team` — `hunters | runners`.
- `TeamAssignment` — `random | selected`.
- `ConnectionState` — `connected | stale | suspended | disconnected`.
- `WsConnectionState` — client socket states incl. `reconnecting` / `reconnect-failed`.
- `WsCloseAction` — what the client does on a WS close code.
- `WS_CLOSE_CODE_ACTION` — close-code table (1000/1001/1006/1011/4400/4401/4403/4409/4413).
- `ZoneShape` — `circle | draw`.
- `ZoneConfig` — play zone: boundary + shrink-phase placeholders (server re-draws per shrink).
- `HouseRules` — the host's house rules for a room.
- `RoomConfig` — full room config: house rules + zone + areas + host picks.
- `DEFAULT_HOST_TOGGLES` — Balance ON, Random ON, ping history OFF.
- `LEGACY_HOST_TOGGLES` — rooms saved before toggles resolve to all OFF.
- `DEFAULT_ROOM_CONFIG` — create-page defaults (Classic, 30 min, 3 min head start, 3 min pings, 500 m zone).
- `Player` — a seat (server-only `reconnectTokenHash` included; never sent).
- `PlayerView` — what a seat sees: hash stripped, other seats' roles `null`.
- `MatchResult` — outcome + duration + caught/surviving Runner ids (no routes, no trails).
- `Room` — a room: ids, code, host, phase, version, config, timestamps, result.
- `Ping` — a coarse ping area (150 m), mutual (Runner pings to Hunters, Hunter pings to Runners); no fix = no ping.
- `CatchState` — `requested | awaiting-confirmation | confirmed | disputed | rejected | expired`.
- `CatchGpsEvidence` — `present | absent | stale` (supporting evidence only).
- `CatchEvent` — a catch as the server stores it (server-only `qrTokenHash`).
- `CatchView` — a catch as clients see it (pending only in snapshots).
- `SafetyEventType` — safety audit kinds (`safety-pause`, `sos`, …).
- `SafetyState` — snapshot safety state: paused / by / at / SOS active.
- `RadioMessage` — a team-radio message (server-known sender name).
- `QUICK_SIGNALS` — closed-set quick-signal chips per scope (lobby / hunters / runners).
- `QuickSignal` — a quick signal: closed-set code only.
- `RevealArea` — a hold-to-reveal 150 m coarse area for the whole room.
- `MapPin` — a map pin placed by a player.
- `Announcement` — an announcement ("I'm safe" travels as one; no check-in command).
- `WsSnapshotPayload` — the whole truth: room, players, phase, version, serverSeq, locationStatus, activeCatches, safetyState, missedAnnouncements.
- `WsClientEnvelope` — client envelope: v, type, commandId, roomId, playerId, clientSeq, clientTs, payload.
- `WsServerEnvelope` — server envelope: v, type, roomId, eventId, serverSeq, serverTs, payload.
- `WsErrorCode` — WS error codes (`AUTH_REQUIRED`, `RATE_LIMITED`, `TICKET_INVALID`, …).
- `WsErrorPayload` — WS error payload incl. `retryAfterSeconds`.
- `VoiceSignalKind` — voice signalling kinds: `join | leave | offer | answer | ice`.
- `VoiceRadioStatus` — voice radio statuses: `off | ready | talking | unavailable | failed`.
- `SuspensionReason` — why a seat reported itself suspended.
- `PakdamSession` — the canonical live session: one key, two separate tokens.

### `src/events.ts` — the WS event catalogue

Client → server (22 types) — payload per type + the type union + the array + a guard:

- `EmptyPayload` — `{}` payload (heartbeat, safety.resume, briefing.confirm).
- `HelloPayload` — hello: protocolVersion 1, clientVersion, lastServerSeq (no credential).
- `AuthRefreshPayload` — auth.refresh: the only message that ever carries a ticket.
- `LocationUpdatePayload` — location.update: a fresh fix that passes the ±50 m rule.
- `RevealSendPayload` — reveal.send: hold-to-reveal fix.
- `CatchRequestPayload` — catch.request: the Runner being claimed.
- `CatchConfirmPayload` — catch.confirm: QR token, or manual confirm with no token.
- `CatchDisputePayload` — catch.dispute: catch id + fixed reason string.
- `SafetyPausePayload` — safety.pause: reason or null.
- `SafetySosPayload` — safety.sos: reason or null.
- `LeavePayload` — leave: reason or null (best-effort).
- `SignalSendPayload` — signal.send: a closed-set quick-signal code.
- `RadioSendPayload` — radio.send: text ≤ 140 chars, kind quick/text.
- `VoiceSignalPayload` — voice.signal: one teammate, SDP/ICE, team-only.
- `PinPlacePayload` — pin.place: point + label.
- `AnnouncementSendPayload` — announcement.send: check-in text.
- `ReadySetPayload` — ready.set: isReady.
- `SnapshotRequestPayload` — snapshot.request: lastServerSeq.
- `ResyncRequestPayload` — resync.request: lastServerSeq (helper only).
- `PlayerSuspendedPayload` — player.suspended: tab-hidden / screen-locked / network-lost / heartbeat-timeout / unknown.
- `WsClientPayloads` — payload for every client→server type, keyed by type name.
- `WsClientMessageType` — union of the 22 client→server type names.
- `WS_CLIENT_TYPES` — the 22 client→server type names in contract order.
- `isWsClientMessageType` — guard: is this string a known client→server type?

Server → client (34 enumerated types; see the note at the top of this README):

- `WelcomePayload` — welcome: playerId, serverSeq, serverTs, protocolVersion.
- `RoomStatePayload` — room.state: phase, version, serverSeq, reason.
- `PlayerEventPayload` — player.joined / left / removed: player + serverSeq.
- `PlayerSuspendedEventPayload` — player.suspended: playerId, reason?, serverSeq.
- `PlayerResumedEventPayload` — player.resumed: playerId, reason?, serverSeq.
- `PlayerVisibilityPayload` — player.visibility: playerId, locationQuality, lastFixAt, serverSeq.
- `PingEventPayload` — ping: the ping + serverSeq (append, dedup by pingId, never timer-removed).
- `PingExpiredPayload` — ping.expired: pingId, subjectPlayerId, expiresAt.
- `ZoneUpdatePayload` — zone.update: the new zone, phase, serverSeq.
- `CatchEventPayload` — catch.requested / confirmed / disputed / expired / rejected: the catch + serverSeq.
- `SafetyPausedPayload` — safety.paused: byPlayerId, reason, serverSeq.
- `SafetyResumedPayload` — safety.resumed: byPlayerId, reason, serverSeq.
- `SosRaisedPayload` — sos.raised: byPlayerId, serverSeq.
- `MatchStartedPayload` — match.started: result (null at start), serverSeq.
- `MatchCompletedPayload` — match.completed: result, serverSeq.
- `MatchCancelledPayload` — match.cancelled: result, serverSeq.
- `AnnouncementEventPayload` — announcement: the announcement + serverSeq.
- `RevealEventPayload` — reveal: the reveal area + serverSeq.
- `SignalEventPayload` — signal: the quick signal + serverSeq.
- `RadioEventPayload` — radio: the radio message + serverSeq.
- `VoiceSignalEventPayload` — voice.signal: from/to player, kind, SDP/ICE.
- `PinEventPayload` — pin: the pin + serverSeq.
- `HostTransferredPayload` — host.transferred: previous + new host ids, serverSeq.
- `TicketRenewalRequiredPayload` — ticket.renewal-required: expiresAt.
- `AuthRefreshedPayload` — auth.refreshed: expiresAt, serverTs.
- `HeartbeatAckPayload` — heartbeat.ack: serverTs, serverSeq (resets the missed counter).
- `WsServerPayloads` — payload for every server→client type, keyed by type name.
- `WsServerMessageType` — union of the server→client type names.
- `WS_SERVER_TYPES` — the server→client type names in contract order.
- `isWsServerMessageType` — guard: is this string a known server→client type?
- `WS_DIRECT_SERVER_TYPES` — server types sent only to the sender.
- `WS_TEAM_ONLY_SERVER_TYPES` — server types relayed team-only (`voice.signal`, `radio`).
- `WS_ROLE_SCOPED_SERVER_TYPES` — server types sent only to the ping's recipient role (`ping`).

Game events (audit log, 10 types):

- `GameEventType` — the 10 game-event type names.
- `GAME_EVENT_TYPES` — the 10 game-event type names in order.
- `GameEventPayloads` — payload per game-event type (coordinates only in LOCATION_UPDATED / LOCATION_PING_SENT).
- `GameEvent` — game-event envelope: id, timestamp, roomId, actorId, type, payload, seq (DO-assigned).
- `isGameEventType` — guard: is this string a known game-event type?

### `src/validation.ts` — pure input validation

- `ROOM_CODE_PATTERN` — room code regex: exactly 6 chars A–Z0–9.
- `isValidRoomCode` — is this a valid 6-letter invite code?
- `isValidDisplayName` — display name / codename: 1–30 chars after trimming.
- `UUID_PATTERN` — UUID regex for ids.
- `isUuid` — is this a UUID-shaped id?
- `isValidGeoPoint` — lat ±90, lng ±180, both finite.
- `isValidGeoPolygon` — a boundary of ≥ 3 valid points (default min 3).
- `validateZoneBoundary` — zone-boundary issues (empty = unplaced zone, allowed).
- `validateRoomConfig` — full config issues: ranges, pick invariant, host-on-site, forced catch confirmation.
- `CATCH_TOKEN_PATTERN` — fresh catch-token regex: 32 uppercase hex chars.
- `isValidCatchToken` — is this a fresh ≥128-bit catch token? (12-char form rejected.)
- `classifyAccuracy` — GPS tier: good ≤ 10 m, fair ≤ 25 m, poor ≤ 60 m (OPEN).
- `balancedHunterCount` — Hunter count from the roster size (balance table, OPEN).
- `suggestZoneRadiusMeters` — suggested radius: 200 m + 25 m/player beyond 3, cap 1000 m (OPEN).
- `helloHasCredential` — does a hello payload contain a credential key anywhere? (reject + audit.)

### `src/hash.ts` — hashing (values never stored, only hashes)

- `sha256Hex` — SHA-256 hex of a UTF-8 string (Web Crypto, async).
- `hashToken` — SHA-256 hex of a raw token value; store the result, never the value.
- `hashReconnectToken` — SHA-256 hex of a reconnect token (named alias).
- `hashHostToken` — SHA-256 hex of a host token (named alias).
- `hashWsTicket` — SHA-256 hex of a WS ticket (only the hash crosses Worker→DO).
- `catchTokenHash` — catch-token hash: `sha256(catchId + ':' + raw)`.
- `isSha256Hex` — is this a lowercase SHA-256 hex digest (64 chars)?
- `randomHex` — cryptographically random hex (never `Math.random` for tokens).
- `newCatchToken` — a fresh 128-bit catch token: 32 uppercase hex chars.
- `newId` — a fresh id (UUID, with a random-hex fallback).

### `src/gps-validation.ts` — GPS rules

- `FixValidationResult` — fix validation result: ok, errors, warnings, quality.
- `validateFix` — fix validation: rejects bad shape/range, clock skew, stale, exact duplicate; warns on poor accuracy / impossible movement.
- `canAutoCentreZone` — may the zone auto-centre on this fix? (never worse than ±50 m.)
- `isFixSendable` — may this fix be sent at all? (same ±50 m rule.)
- `LocationStatus` — per-player location status: `known | unknown`.
- `locationStatusForPlayer` — status from the last fix timestamp (freshness window OPEN).
- `locationFreshnessLabel` — plain-words label: `Location never reported` / `Location unknown` / `Last fix 0:20 ago`.
- `formatAgeLabel` — an age in seconds as `m:ss` (e.g. `0:20`).
- `verifyCatchProximity` — hunter↔runner distance vs 15 m: plausibility only, never proof (OPEN).
- `haversineMeters` — great-circle distance in metres between two points.
