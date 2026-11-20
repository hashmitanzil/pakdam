# `src/lib` — public API (for screen workers)

The foundation every screen imports from. All modules are fresh from
`BEHAVIOUR.md` + `PROTOCOL-MAP.md` + `SCRAM-SPEC.md`; nothing is copied
from the old tree. Import from `@pakdam/shared` for types/constants
(protocol v2.1, calibration, validation, hashing, GPS rules) and from
these modules for behaviour.

## `websocket.ts` — WS client (PROTOCOL-MAP §2)

- `getWorkerUrl()` — `NEXT_PUBLIC_WORKER_URL`, trailing slash stripped.
- `isLiveTransportEnabled()` — true when a Worker URL is set (live mode); unset = local demo loop, never mixed in one room.
- `fetchWsTicket(roomId, playerId, reconnectToken, purpose?)` — single-use WS ticket over HTTPS (60 s TTL); the value is never logged or stored.
- `class PakdamSocket` — the socket. States: `idle | connecting | connected | suspended | reconnecting | reconnect-failed | closed`.
  - `connect()` — fetch ticket → `wss://…/ws?ticket=…` → `hello` (no credential) → heartbeat starts.
  - `retry()` — manual retry after `reconnect-failed`: resets attempts, fetches a fresh ticket.
  - `close(reason?)` — best-effort `leave`, then close 1000; never auto-reconnects.
  - `sendCommand(type, payload, commandId?)` — one command; `false` when disconnected (discarded, never queued). Retries reuse the same `commandId`.
  - `requestSnapshot()` / `resync()` — `snapshot.request` / `resync.request`.
  - `sendLocationUpdate(fix)` / `sendReveal(fix)` — `location.update` / `reveal.send`.
  - `setReady(isReady)` — "I'm ready": sends `ready.set` AND `briefing.confirm` together when turning ready on.
  - `sendRadio(text, kind?)` / `sendSignal(code)` / `sendVoiceSignal(toPlayerId, kind, sdp?, candidate?)` / `sendPin(point, label)` / `sendAnnouncement(text)` / `sendCheckIn(text?)` — radio, quick signal, voice signalling, pin, announcement ("I'm safe" travels as an announcement).
  - `requestCatch(runnerId)` / `sendCatchConfirm(catchId, qrToken, manualConfirm?)` / `sendCatchDispute(catchId, reason)` — catch claim / confirm (QR token, or manual confirm with no token) / dispute.
  - `safetyPause(reason?)` / `safetyResume()` / `safetySos(reason?)` — safety pause / resume / SOS.
  - `leave(reason?)` / `reportSuspended(reason)` — best-effort leave / `player.suspended` notice.
  - `connectionState` / `lastAppliedServerSeq` — getters.
  - Close codes follow the CONTRACT (`WS_CLOSE_CODE_ACTION`): 4400 → fresh ticket, reconnect once, AND surface the failure; 4401 → fresh ticket, reconnect once, a second 4401 → closed; 1000/4403/4409 never auto-reconnect; 1001/1006/1011/4413 back off (1 s base, doubling, 30 s ceiling, jitter ×0.5–1.0, max 5 attempts, then `reconnect-failed` with detail `reconnect failed — Retry`).
  - Heartbeat is actually configured (`HEARTBEAT_INTERVAL_MS` 30 s / `HEARTBEAT_MISSED_LIMIT` 3, OPEN, from `@pakdam/shared`); on the limit the client closes the socket (1006, 'heartbeat timeout') so the reconnect path re-syncs via snapshot.
  - `ticket.renewal-required` → fresh `renew` ticket → `auth.refresh` (the only message that ever carries a ticket).
  - Tab-hide sends best-effort `player.suspended` ('tab-hidden'); tab-visible re-requests a snapshot. The DO resumes a suspended seat on hello/reconnect (P0-1).

## `live-client.ts` — live HTTP client (PROTOCOL-MAP §1)

- `liveErrorMessage(status)` — plain-words error: 400 setup not accepted · 403 code does not match · 404 game not found / ended · 409 full / no longer open · 429 too many tries.
- `class LiveHttpError` — `Error` with a `status` field.
- `createLiveRoom(displayName, config?)` — `POST /v1/rooms`; stores both tokens, returns the session.
- `resolveRoomByCode(code)` — `GET /v1/rooms/by-code/:code` → `{ roomId, roomCode }`.
- `joinLiveRoom(roomId, displayName, roomCode, reconnectToken?)` — `POST /v1/rooms/:id/join`; forwards the stored token only for a seat restore (a restored seat returns an EMPTY token — the good stored one is kept).
- `fetchHostToken(roomId, playerId, reconnectToken)` — `POST /v1/rooms/:id/host/token` (mint / rotate).
- `fetchLiveCatchToken(roomId, playerId, reconnectToken, catchId)` — `POST /v1/rooms/:id/catch-token`; the raw token is for the Runner's QR only, never stored beyond the screen.

## `live-room-client.ts` — live room state wrappers (PROTOCOL-MAP §1.5–1.12, §3)

- `fetchLiveRoomState(roomId, playerId, reconnectToken)` — `GET /v1/rooms/:id?playerId=…` with `Authorization: Bearer <reconnectToken>` (never in the query string); first paint / results.
- `getHostTokenLive(roomId)` — the stored host token, or recover it via §1.10 when missing.
- `startLiveMatch(roomId)` — `POST /v1/rooms/:id/start` (host token; 409 if the gate is unmet).
- `updateLiveRoomConfig(roomId, config)` — `POST /v1/rooms/:id/config` (full lobby config, lobby only).
- `removeLivePlayer(roomId, targetPlayerId)` — `POST /v1/rooms/:id/remove-player` (never the host).
- `regenerateLiveRoomCode(roomId)` — `POST /v1/rooms/:id/regenerate-code`; stores the new code in the tab session.
- `resolveLiveCatch(roomId, catchId, decision, reason?)` — `POST /v1/rooms/:id/catches/:cid/resolve` ('confirmed' | 'rejected'). Wired into the host UI (the §1.12 decision: wire it, do not leave it half-wired).
- `canStartLiveMatch(players, teamAssignment, selectedHunterIds, hunterCount)` — client start gate (active ≥ 3 AND every active seat ready AND teams set); a blocked start always says why in one line.
- `snapshotToLiveRoomState(snapshot)` — snapshot → `{ room, players, version }` (the snapshot is the whole truth; pings never arrive in it).
- `createLiveSnapshotHandler(onState)` — builds a socket `onSnapshot` handler from a state callback.
- Role secrecy: a seat sees its OWN role/team only — every other seat's role is `null` in `PlayerView`. The catch picker shows names only.

## `demo-store.ts` — local demo mode, no server (PROTOCOL-MAP §9)

Rooms persist to localStorage `pakdam.demo.rooms.v1` WITHOUT coordinates; fixes, raw catch tokens, verified scans and idempotency keys are in-memory only. Demo parity with the DO: pings auto-fire on schedule; shrink uses the random-offset draw, never concentric; demo SOS notifies nobody (`SOS_DEMO_COPY`).

- `createRoom(displayName, config?)` / `joinRoom(roomId, displayName)` — create / join (rejoin by display name restores the seat; an ejected seat stays ejected).
- `getRoom(roomId)` / `getRoomByCode(code)` / `listRooms()` — reads; `getRoom`/`getRoomByCode` tick the room first (`listRooms` does NOT tick).
- `tickDemoRoom(demo, nowMs?)` — the demo alarm: expires overdue catches, HEAD_START→ACTIVE, completes at `endsAt`, auto-fires pings, applies scheduled shrinks. Never fires while SAFETY_PAUSED.
- `setPhase(demo, phase)` — enforces the state machine; resume from SAFETY_PAUSED returns to `pausedFrom`; clock starts at HEAD_START; roles assigned ONCE at HEAD_START.
- `assignRoles(demo)` — Balance/Random/selected rules (§4.3).
- `canStartDemoMatch(demo)` / `startDemoMatch(demo)` — demo start gate (same rule as live) / LOBBY → READY_CHECK → COUNTDOWN → HEAD_START.
- `setTeamAssignment(demo, teamAssignment)` / `setSelectedHunters(demo, playerIds)` / `updateRoomConfig(demo, config)` — lobby-only team/config changes (pick cleared on hunter-count/team-assignment change).
- `toggleReady(demo, playerId)` — flips `isReady` AND sets `briefingConfirmed: true`.
- `requestCatch(demo, hunterPlayerId, runnerPlayerId, idempotencyKey?)` — Hunter claims a Runner; same-Hunter re-request returns the open claim; returns `{ catch, rawToken }` (raw token in-memory only, for the QR).
- `verifyCatchScan(catchId, rawToken)` — hash + expiry + pending-state check; records the scan for `confirmCatch('qr-scan')`; verification alone never confirms.
- `confirmCatch(demo, catchId, actorPlayerId, how)` — `how`: `'qr-scan'` (claiming Hunter + verified scan, consumed) | `'manual-confirm'` (named Runner only) | `'host-review'` (host only, disputed only).
- `disputeCatch(demo, catchId, actorPlayerId)` — Runner-only, pending claim only.
- `getCatchRaw(catchId)` — the raw token for a Runner's QR (in-memory only).
- `resolveEffectiveRunner(demo, myPlayerId, options?)` — P0-2 auto-select: `?runner=` param → open claim involving me → picker choice → my latest confirmed catch → picker.
- `listCatchPickerNames(demo, myPlayerId)` — P0-2 name-only picker (names only, no roles; exclusions: self, ejected/left, already-caught).
- `recordPlayerSuspension(demo, playerId, reason)` / `resumePlayer(demo, playerId)` / `resumePlayerOnCatchPageArrival(demo, playerId)` — P0-1: resume is a no-op unless suspended; returns true only when a suspended player was actually resumed.
- `recordPlayerFix(demo, playerId, fix)` — timestamp only (no coordinates stored); marks the player connected again.
- `recordZoneExit(demo, playerId, nowMs?)` — logs the crossing (starts the 30 s countdown); caller guards to once per crossing.
- `leaveRoom(demo, playerId)` — host-leave transfers host to the earliest-joined remaining player.
- `ejectPlayer(demo, playerId)` — ACTIVE/HEAD_START only; completes as Hunters win when no Runner is left free.
- `safetyPauseDemo(demo, playerId)` / `safetyResumeDemo(demo)` / `sosDemo(demo, playerId)` — demo safety; SOS notifies nobody (see `SOS_DEMO_COPY`).
- `hostCheckin(demo, playerId, text)` — demo event-log check-in.
- `fireDemoPing(demo, runnerPlayerId, nowMs?)` — one demo ping (coarse 150 m area; the UI labels it simulated).
- `randomOffsetShrinkBoundary(boundary)` / `circlePolygon(centre, radiusMeters, points?)` — shrink draw / circle approximation.
- `pollDemoRoom(roomId)` / `watchDemoPhase(roomId, onLeaveLobby, intervalMs?)` — F2: poll every 1 s; `watchDemoPhase` calls `onLeaveLobby` ONCE when the phase leaves LOBBY (guest auto-navigates to /play).
- `currentPlayerId()` / `setCurrentPlayerId(playerId)` — per-tab player identity in sessionStorage (`pakdam.playerId`).

## `voice-radio.ts` — WebRTC push-to-talk, team-only (PROTOCOL-MAP §6)

- `class VoiceRadio` — statuses `off | ready | talking | unavailable | failed` (`VoiceRadioStatus`); PTT states `idle | listening | talking` (`PttState`).
  - `enable()` — asks for the mic (echo cancellation + noise suppression), keeps the track disabled until held, sends `join` to each teammate.
  - `disable()` — sends `leave` to each teammate, closes every peer connection, stops the mic.
  - `startTalking()` / `stopTalking()` — hold to talk, max 10 s per burst (`VOICE_MAX_BURST_MS`); the mic track is disabled except while held.
  - `burstElapsedSeconds()` — seconds into the current burst.
  - `setMuted(muted)` — silences both directions (mic off + remote playback muted).
  - `setTeammates(teammateIds)` — replace the teammate list.
  - `handleSignal(signal)` — incoming `voice.signal`; re-checks same-team membership locally, consumes each signal exactly once, never triggers a snapshot. Exactly-one-offerer: a `join` from a teammate is answered with an `offer`.
  - `getRemoteStream(peerId)` — remote audio stream for a teammate (attach to an `<audio>` element).
  - `connectionSummary` — `Connected: N of M teammates.`; `connectedPeers` / `failedPeers` getters.
- `VOICE_FAILURE_COPY` — `"Voice didn't connect — text radio still works."`
- Free public STUN only (`VOICE_STUN_SERVERS`); no TURN, no recording, no storage. SDP ≤ 8 KB (`VOICE_SDP_MAX_BYTES`).

## `geolocation.ts` — foreground GPS (PROTOCOL-MAP §4.10)

- `watchLocation(onFix, onError?)` — foreground-only `watchPosition` (high accuracy, maximumAge 0, timeout 15 s); dedupes by timestamp; only permission-denied is terminal (transient errors swallowed). Returns a `{ stop() }` handle, or null when unsupported.
- `getCurrentFix()` — one-shot fix, staged chain (12 s high-accuracy watch → 10 s high-accuracy one-shot → 15 s low-accuracy one-shot → 8 s cached one-shot), 45 s global deadline; best fix within ±50 m or a plain-words timeout.
- `isFixSendableToServer(fix)` / `canZoneAutoCentreOn(fix)` — the ±50 m rule (only fixes ≤ ±50 m are ever sent; a zone is never auto-centred on a worse fix).
- `locationFreshnessLabel(lastFixAtMs, nowMs?)` — `Location never reported` / `Location unknown` / `Last fix 0:20 ago` (from `@pakdam/shared`).

## `session-credentials.ts` — seat credentials (PROTOCOL-MAP §10)

- `getSessionForRoom(roomId)` — the session for this room, or null (a token for another room is not a token for this one).
- `saveSession(session)` / `storeLiveSeat(session)` / `storeDemoSeat(session)` — save/replace the session for its room. An empty token on restore never overwrites a good stored token.
- `clearSession(roomId)` — drop the seat (leave / switch player); the room itself is untouched.
- `isLiveHost(roomId)` — true only with a live session + `isHost` + a non-empty `hostToken` (display name alone is never proof of host).
- `hasLiveCredential(roomId)` — gates socket opening (live seat + reconnect token).
- `loadAllLiveSessions()` — all live sessions saved on this device (host dashboard lists these only — the server has no room-list endpoint).
- One sessionStorage key (`pakdam.session.v1`); two separate tokens. Tokens are never in localStorage, never in a URL, never logged.

## `wake-lock.ts` — screen wake lock

- `requestWakeLock()` — best-effort, never throws; returns `{ release(), isHeld() }`. Re-acquired on tab-visible.
- `isWakeLockSupported()` — true when the Wake Lock API exists.

## `pwa.ts` — install prompt + service worker

- `attachInstallPromptListener()` — capture `beforeinstallprompt` once (call early, e.g. layout).
- `isInstallPromptAvailable()` / `showInstallPrompt()` — show the captured prompt (false when none is available).
- `registerServiceWorker()` — registers `/sw.js`; no-op when unsupported.

## `offline-queue.ts` — offline queue (PROTOCOL-MAP §2.1, R12)

Commands sent while disconnected are DISCARDED, never queued. This queue holds ONLY non-competitive actions — bug-report drafts, settings, grievances — never location, catches, pings or votes.

- `enqueueOfflineAction(kind, roomId, payload)` — enqueue one item (`kind`: `'bug-report' | 'settings' | 'grievance'`).
- `readOfflineQueue()` / `removeOfflineAction(id)` — list / drop items.
- `replayOfflineQueue(send)` — replay on reconnect; `send(item)` returns true when accepted; items failing 3 times are dropped. Returns `{ sent, dropped }`.

## `utils.ts` — formatting helpers

- `formatAgeLabel(seconds)` — an age in seconds as `m:ss` (e.g. `0:20`).
- `ageLabelFromTimestamp(timestampMs, nowMs?)` — `0:20 ago`.
- `formatCountdown(totalSeconds)` / `formatClock(msRemaining)` — `mm:ss` countdown / match clock.
- `distanceMeters(a, b)` / `formatDistance(meters)` — great-circle distance; `420 m` / `1.2 km`.
- `formatZoneSize(startRadiusM, finalRadiusM | null)` — `500 m → 211 m` (start → final; `Auto` when null).
- `formatDurationShort(totalSeconds)` — `45 s` / `3 min`.
- `initialsForName(displayName)` — avatar initials (first letters of the first two words).

## `../components/ui/` — primitives (SCRAM-SPEC §11)

- `Button({ variant, children })` — `variant`: `'primary'` (red #EF4444, 56 px, full width) | `'outline'` | `'ghost'` | `'blocked'` (grey bar — stays tappable so the tap can answer in plain language; never a disabled button).
- `Toggle({ checked, onChange, label, disabled? })` — iOS-style, red ON, grey OFF, 48×24 px capsule, 22 px knob.
- `Stepper({ value, onChange, step?, min?, max?, label, format?, disabled? })` — − / + dark squares, bold centred value.
- `BottomTabs({ active, onChange, radioUnread? })` — `Map | Radio | ···`, active = red-tinted pill; Radio badge = unread count.
- `Sheet({ open, onClose, title?, children })` — bottom sheet, radius 20 px top, drag handle, Escape/backdrop closes.
- `Pill({ tone, children })` / `Badge({ count })` — `tone`: `'host'` (red outline) | `'ready'` (green outline) | `'hunter'` (red fill) | `'runner'` (white fill) | `'random'` | `'neutral'` | `'warning'`; Badge = red dot with white number.

## `../components/map/maplibre.ts` — Ola Maps helper (PROTOCOL-MAP §11)

- `OLA_STYLE_URL` — `https://api.olamaps.io/tiles/vector/v1/styles/default-dark-standard/style.json`.
- `OLA_MAP_INITIAL_CENTRE` — Ranchi/Doranda `[85.33, 23.36]`; `OLA_MAP_INITIAL_ZOOM` 14, `OLA_MAP_FIX_ZOOM` 15, min 3, max 19.
- `getOlaApiKey()` — `NEXT_PUBLIC_OLA_MAPS_API_KEY`, env only, never hardcoded.
- `isOlaConfigured()` — false when no key is set: do NOT construct a map (show the missing-key banner).
- `olaTransformRequest(url, resourceType?)` — appends `api_key` to EVERY `api.olamaps.io` request.
- `createOlaMap({ container, center?, hasFix?, zoom? })` — constructs the map (null when unconfigured). Callers must call `map.resize()` after resize / hidden-then-shown.
- `fetchCleanedOlaStyle()` / `cleanOlaStyle(style)` — the Ola style JSON declares a `3d_model_data` layer whose `3d_model` source layer does not exist in the vectordata tiles, so the style is fetched, stripped of those layers, and passed to MapLibre as a cleaned OBJECT (never the URL). A failed fetch falls back to the URL so the caller's error banner shows the real detail.
- `shouldRefly(lastCentre, fix, lastAccuracyMeters)` — re-centre only when the fix moved > 25 m or accuracy at least halved.
- Zone/ping/no-go overlay colours: `ZONE_LINE_COLOR` / `ZONE_FILL_COLOR` / `PING_FILL_COLOR` / `NO_GO_FILL_COLOR`.
- `maplibre-gl` is a dependency of `@pakdam/web` (`maplibre-gl@^5.0.0`); the module imports it dynamically at runtime.
