# Pakdam — Behaviour Spec (fresh build)

> Short spec for the new project. Any builder reads this first, then the two references in §7. Full payload shapes,
> validation and calibration notes live in the protocol map — this file states the behaviour, not the wire bytes.
> Stack (unchanged): Next.js PWA on Vercel · Cloudflare Worker + one Durable Object per room · Supabase (Mumbai)
> for durable records. Free, guest-only, no accounts, no payment, no paywall. Private invite-only, join by code.

## 1. What Pakdam is

Pakdam is a real-world GPS hide-and-seek game played on phones in a city neighbourhood. One host creates a room,
players join with a code, teams are assigned at start, and the match runs on a live map against a clock inside a
shrinking play zone. Two modes only — **Classic** and **Infection** — for 2–30 players (minimum 2 to start).
In Classic a tagged Runner is out; Hunters win when every Runner is caught, Runners win if any survive the clock.
In Infection a tagged Runner flips to the Hunters; Hunters win when no Runner is left. There is no public lobby,
no leaderboard, no points store — the match, its catches and its result are the whole product.

## 2. Game rules in brief

- **Teams are host-controlled, never self-picked.** Balance ON (default) sets the Hunter count from the roster at
  start (3–4 players → 1 Hunter; 5–8 → 2; 9–16 → 3; 17–24 → 4; 25–30 → 5); Balance OFF lets the host pick a count
  with a stepper. Random ON (default) draws Hunters at random; Random OFF lets the host tap roster names to pick
  them. Roles are drawn once, at head start, and never re-drawn.
- **Defaults:** Classic · 30 min round · 3 min head start · pings every 3 min · zone 500 m radius · shrinking ON
  every 10 min (−25% radius per shrink) · ping history OFF · play zone ON · final size Auto.
- **Readiness gate (server + client must agree).** Start needs active seats ≥ 3 (`MIN_PLAYERS = 3`) **and** every
  active seat ready. One tap — "I'm ready" — sends ready and confirms the briefing together. A blocked Start
  always says why in one line; never a silent disabled button.
- **Zone.** Circle or host-drawn polygon (tap-to-place, 3 taps = triangle), radius min 100 m, no maximum. Never
  auto-centred on a fix worse than ±50 m — the host places it by hand instead. Each shrink scales the zone to 75%
  of its radius, then moves it to a **random position fully inside the old boundary — never concentric**
  (near-concentric draws are discarded and re-drawn). The next zone is hidden until the shrink preview.
- **Outside the zone: 30 s, then ejection.** A player outside gets a 30-second return countdown on their own
  screen; at 0 they are ejected. Poor GPS freezes the countdown (counted seconds stay); back inside clears it.
  Ejection is never undone by rejoining, and an ejected Runner counts as out for win purposes but is recorded as
  "ejected", not "caught".
- **Pings stay until the next ping, with age.** In ACTIVE phase only, one coarse 150 m area per free Runner per
  ping interval, to Hunters only. A delivered ping is never removed on a timer — it stays until the next ping
  replaces it, showing its age (e.g. `0:20 ago`). No fix = no ping, never an invented position. Runners never see
  Hunters; Hunters never see a Runner's live position, only pings.
- **Catch flow — tag → QR → runner confirms → manual fallback, NO catch code.** Hunter tags in person; Runner
  shows their QR (`SHOW MY QR`); Hunter scans it; Runner confirms on their own phone (`YES, I WAS TAGGED` /
  `NO — DISPUTE`). If the camera fails, manual fallback: Hunter picks the Runner from a name list, Runner confirms
  the same way. No code is ever shown, spoken or typed — the token lives only inside the QR. A disputed catch goes
  to the host, whose decision is final. Runner confirmation is always required; a tag never counts at once. The
  catch page auto-selects the effective Runner (URL param → my open claim → picker choice → my latest confirmed
  catch) and otherwise shows a name-only picker — never a "No Runner selected" dead end, and never a role reveal
  (a wrong pick is rejected by the server in plain words).
- **Safety, during play only.** Any player may pause the match (clock freezes; resume returns to the phase paused
  from); SOS alerts the host and is not emergency dispatch — the copy must say so. Safety pause and SOS are one tap
  away on the play screen at all times. "I'm safe" check-in travels as an announcement; there is no command for it.
- **Suspension.** Tab hidden / phone locked / socket closed = suspended ("location unknown"); the timer keeps
  running and a pending catch cannot complete while the Runner is suspended. See §6 for the resume rule.
- **Scoring (completed matches only).** Runner +1 per whole 3 min free; +10 never caught (still free at end);
  Hunter +3 per confirmed tag; +10 clean sweep to every Hunter on the winning side when every Runner was caught
  (ejected Runners break the sweep).
- **Location honesty.** Only fixes accurate to ±50 m or better are ever sent. Poor accuracy is warned, never
  treated as cheating. GPS is supporting evidence for a catch only — never proof, never a rejection on its own.
  Foreground-only: location stops when the tab hides.

## 3. Protocol in brief

Full shapes, envelopes, error codes and validation: see PROTOCOL-MAP.md §1–2. The contract is frozen v2.1 and
does not change in the rebuild.

### 3.1 HTTP endpoints (base = `NEXT_PUBLIC_WORKER_URL`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/rooms` | Create room; returns roomId, code, host seat, reconnect + host tokens |
| GET | `/v1/rooms/by-code/:code` | Resolve a 6-letter invite code to a roomId |
| POST | `/v1/rooms/:id/join` | Join by code; restores a seat on matching name + token |
| POST | `/v1/rooms/:id/ws-ticket` | Issue a single-use WS ticket (60 s TTL) for connect / renew |
| GET | `/v1/rooms/:id?playerId=…` | Recipient-filtered room state (first paint / results) |
| POST | `/v1/rooms/:id/start` | Host starts the match (host token; 409 if gate unmet) |
| POST | `/v1/rooms/:id/config` | Host replaces the full lobby config (lobby only) |
| POST | `/v1/rooms/:id/remove-player` | Host removes a lobby player (never the host) |
| POST | `/v1/rooms/:id/regenerate-code` | Host swaps the room code; old code dies at once |
| POST | `/v1/rooms/:id/host/token` | Mint / rotate the host token for the host seat |
| POST | `/v1/rooms/:id/catch-token` | Runner fetches the raw one-time catch token for their QR |
| POST | `/v1/rooms/:id/catches/:cid/resolve` | Host resolves a disputed catch (confirmed / rejected) |

Server-only routes (keep or delete deliberately, never half-wire): `POST …/lifecycle`, `POST …/host/transfer`,
`GET …/results`, `POST …/ws-ticket/revoke`, `POST /v1/reports`, `POST /v1/support/bugs`,
`POST /v1/support/grievances`. There is deliberately **no** REST route for catch request/confirm/dispute, SOS or
leave — those are WS only. No leaderboard route exists; the old leaderboards page was device-local only. Success
is flat `{ ok: true, … }`; errors are `{ error: '…' }`. The web app never reads Supabase directly — all durable
reads go through the Worker.

### 3.2 WebSocket messages

Envelope: client `{ v: 1, type, commandId, roomId, playerId, clientSeq, clientTs, payload }` (retries reuse the
same `commandId`; the DO drops repeats for 10 min). Server `{ v: 1, type, roomId, eventId, serverSeq, serverTs,
payload }`; never apply an event with `serverSeq` at or below the last applied, except welcome / snapshot / auth
messages. Commands sent while disconnected are discarded, never queued. `hello` is first, carries no credential,
and protocol version must be 1.

**Client → server (22 types):** connection — `hello`, `auth.refresh`, `heartbeat`, `snapshot.request`,
`resync.request`; location — `location.update`, `reveal.send`; catch — `catch.request`, `catch.confirm`,
`catch.dispute`; safety — `safety.pause`, `safety.resume`, `safety.sos`; readiness — `ready.set`,
`briefing.confirm`; radio / voice — `radio.send`, `signal.send`, `voice.signal`; other — `pin.place`,
`announcement.send`, `leave`, `player.suspended`.

**Server → client (34 types):** connection — `welcome`, `snapshot`, `room.state`, `ticket.renewal-required`,
`auth.refreshed`, `heartbeat.ack`, `error`; roster — `player.joined`, `player.left`, `player.removed`,
`player.suspended`, `player.resumed`, `player.visibility`, `host.transferred`; play — `ping`, `ping.expired`,
`zone.update`, `reveal`, `pin`, `signal`, `radio`, `voice.signal`, `announcement`; catch — `catch.requested`,
`catch.confirmed`, `catch.disputed`, `catch.expired`, `catch.rejected`; safety — `safety.paused`,
`safety.resumed`, `sos.raised`; match — `match.started`, `match.completed`, `match.cancelled`.

**Broadcast scoping:** direct messages (`welcome`, `snapshot`, `error`, `heartbeat.ack`, `auth.*`) go only to the
sender; `voice.signal` and `radio` are team-only (lobby = whole lobby); `ping` is Hunters-only; `reveal` goes to
the whole room; everything else broadcasts to the room. A snapshot is the whole truth — most events just trigger
a fresh one.

### 3.3 Connect, close codes, reconnect

Ticket first over HTTPS, then `wss://…/v1/rooms/{id}/ws?ticket=…` (the ticket in the query string is the one
sanctioned exception to "never put a token in a URL"). The DO warns once when the socket's ticket expires within
30 s (`ticket.renewal-required`); the client fetches a fresh `renew` ticket and sends `auth.refresh` — the only
message that ever carries a ticket. A `renew` ticket can never open a socket. Invalid/missing ticket gets a real
WS **4401** close frame, not an HTTP 401.

| Code | Meaning | Client action |
|---|---|---|
| 1000 | Normal closure | Do not reconnect |
| 1001 / 1006 / 1011 | Going away / abnormal / server error | Backoff reconnect |
| 4400 | Bad request | Fresh ticket, reconnect once; surface the failure |
| 4401 | Ticket invalid / reused / expired | Fresh ticket, reconnect **once**; a second 4401 → closed |
| 4403 | Forbidden (seat removed / revoked) | Do not reconnect |
| 4409 | Protocol unsupported | Do not reconnect — upgrade the client |
| 4413 | Rate-limited | Backoff, never before the server's `retryAfterSeconds` |

Backoff: base 1 s, doubled per attempt, ceiling 30 s, jitter ×0.5–1.0, max 5 attempts, then `reconnect-failed`
with a Retry button (retry resets attempts and fetches a fresh ticket). On tab-hide the client sends best-effort
`player.suspended`; on visible it re-requests a snapshot.

## 4. Room state + state machine

**Snapshot payload** (`WsSnapshotPayload`) — the whole truth the UI renders: `{ room, players, phase, version,
serverSeq, locationStatus, activeCatches, safetyState, missedAnnouncements }`. `room` is `{ roomId, roomCode,
hostPlayerId, phase, version, config, createdAt, startedAt, endsAt, pausedAt, result }`; `result` is `{ outcome,
durationSeconds, caughtRunnerIds, survivingRunnerIds }` — no routes, no coordinate trails. `players` are
`PlayerView`: each seat sees its **own** role/team only — every other seat's role is `null` (the Hunter's catch
picker shows names only; caught/survivor lists come from `room.result` only). `locationStatus` is per-player
`known | unknown`; `activeCatches` holds pending catches only (confirmed ones never appear — the catch page keeps
a session-only list of those it saw arrive); `safetyState` is `{ paused, pausedBy, pausedAt, sosActive }`.

**What a snapshot never carries:** raw coordinates, pending pings, token hashes. Pings arrive only as `ping`
events after connect; a reconnect loses earlier pings.

**DO state machine — 12 phases:** `DRAFT | LOBBY | READY_CHECK | COUNTDOWN | HEAD_START | ACTIVE | SAFETY_PAUSED |
RESOLVING | COMPLETED | CANCELLED | ABANDONED | EXPIRED`. Only the server changes phase; illegal edges throw
`INVALID_STATE`. The clock starts at `HEAD_START`, not `ACTIVE`. A safety pause freezes the clock and resume
returns to the phase paused from. Terminal phases (`COMPLETED / CANCELLED / ABANDONED / EXPIRED`) have no outgoing
edge. The DO ticks its alarm every 1 s while live, every 30 s in the lobby, never once terminal: head-start
expiry, match end, outside-zone ejection, zone shrink, scheduled pings — in that order. Nothing completes while
safety-paused.

**DO stored state (split that must be preserved):** durable — room, players (incl. token hashes, never sent),
catches, host-token hashes, `serverSeq`, pause/SOS state, redacted event log (cap 500), `lastPingAtMs`. Memory
only, never persisted — latest fixes (purged after 120 s and at match end), pending pings, outside-zone countdown,
tickets, rate-limit windows, idempotency set.

## 5. Supabase schema in brief

**Verdict: no schema change is needed.** Deploy set stays **0001 + 0003 + 0004** in order on the same project
(Mumbai); **0002 RLS stays held** in `migrations-deferred/` until the auth-method decision (OD-022) lands — guest
seats have no profile, so the held policies could never satisfy them. If the schema ever changes, write a new
numbered migration; never edit 0001/0003/0004 in place on a live project. The Worker talks to Supabase over plain
`fetch` to PostgREST, no client SDK; `SUPABASE_URL` is a plain `[vars]` value in `wrangler.toml`, the service-role
key is a secret. Persistence is best-effort by design — a failed insert never fails a game request. Never
persisted: raw coordinates, raw tokens of any kind (hashes only), WS tickets.

| Table | What it holds |
|---|---|
| `profiles` | Host accounts (future; guest seats have none) |
| `rooms` | One row per room: code, host, phase, version, full config (jsonb), result |
| `players` | One row per seat: name, host flag, role/team, reconnect-token hash, suspension count |
| `room_events` | The one event log (redacted; trigger rejects coordinate payloads) |
| `catches` | One row per catch: hunter, runner, state, QR-token hash |
| `safety_events` | SOS / pause / resume audit |
| `bug_reports` | Bug intake, no location ever attached |
| `grievances` | Grievance intake, distinct from bugs |
| `audit_log` | Report / block audit records |
| `telemetry_daily` | Daily counts only — no payloads, no identifiers |

**PostGIS (0004):** `restricted_areas` (host-drawn no-go polygons, geography); `zone_polygon(room_id)` builds the
play-zone boundary from `rooms.config`; `point_in_zone` / `point_in_restricted_area` take the point as arguments
and never store it. Uses `ST_Covers`, not `ST_Contains` (the latter is geometry-only and failed live with ERROR
42883; `ST_Covers` also counts a point exactly on the boundary as inside). PostGIS tests containment only — it
cannot judge whether a place is dangerous; the real safety layer is the host's venue choice.

## 6. Built-in from the start (do not defer any of these)

- [ ] **DO-owned WS ticket registry.** Tickets are validated and redeemed by the room's DO, never against
  per-isolate Worker memory. The Worker mints and registers hashes only; the DO redeems atomically and owns the
  socket. Sticky routing is not viable on Workers — do not attempt it. Note: the old tree's latest code already
  had this implemented by a cancelled fix mission, never verified or deployed. The fresh build implements it from
  this spec, **not** by copying that code.
- [ ] **Resume a suspended player on hello / reconnect.** The DO resumes the seat when its socket (re)connects
  after a valid hello; the demo path resumes on catch-page arrival and on tab-visible. A suspended Runner must be
  able to confirm a catch — that was the old catch-22.
- [ ] **Catch auto-select + name-only picker, QR + manual fallback, no catch code** (§2 catch flow).
- [ ] **Readiness gate: every player ready + MIN_PLAYERS = 3** (§2), client and server gates agreeing.
- [ ] **Random next zone per shrink, never concentric** (§2).
- [ ] **Pings stay until the next ping** (§2), with age shown.
- [ ] **Team-only voice radio.** WebRTC P2P between teammates only; the DO rejects cross-team signals.
  Push-to-talk, max 10 s per burst, free public STUN only, no TURN, no recording, no storage. Text radio (≤140
  chars, team-only, last 50, ephemeral) is the fallback; P2P failure says so in plain words.
- [ ] **Heartbeat actually configured.** A real interval + missed limit, set on both client and server, so a dead
  socket is detected and the ticket-renewal warning can fire without inbound traffic. The old build had the timer
  code but no caller ever passed an interval — the heartbeat never ran.
- [ ] **Catch token ≥ 128 bits.** The old token was 12 hex chars (48 bits) — too short. Same hash construction
  (`sha256(catchId + ':' + raw)`), same single-use + TTL semantics, QR-only carriage.
- [ ] **Per-route HTTP rate limiting.** Every route in §3.1, including the 9 mutating/auth routes the old build
  left un-limited: `config`, `remove-player`, `regenerate-code`, `catch-token`, `lifecycle`, `host/token`,
  `host/transfer`, `catches/:cid/resolve`, `results` (plus `GET …/:id` state and the WS upgrade, also un-limited
  at the HTTP layer). Per-seat keys for seat-scoped actions, per-IP for unauthenticated ones; rate-limit state
  that must survive isolate eviction belongs in the DO or a shared store. WS per-message limits are preserved
  alongside, not instead.
- [ ] **Snapshot + privacy rules** (§4): no raw coordinates, no pending pings, no token hashes; role secrecy;
  fixes in DO memory only.
- [ ] **CSP / HSTS headers** on the Worker (the old build had none).
- [ ] **Catch-resolve path decided:** either wire the host resolve endpoint into the UI or delete it — no
  half-wired third state.
- [ ] **Demo parity:** demo pings auto-fire on schedule; demo shrink uses the random-offset draw; demo SOS says
  plainly it notifies nobody.
- [ ] **Session credentials:** one sessionStorage key, two separate tokens (reconnect vs host — sending one as
  the other 403s), empty token on restore never overwrites a good stored token.

## 7. Pointers

- Full protocol reference (payloads, validation, DO ops, calibration, known defects):
  `../pakdam-scram-rebuild/PROTOCOL-MAP.md`
- Frontend design spec (SCRAM base + ShadowHunt minimalism, Pakdam red, single dark theme, screens, defaults,
  exact copy): `../pakdam-scram-rebuild/SCRAM-SPEC.md`
- Where the two disagree, the decided Pakdam rule in this file wins. Where this file is silent, the protocol map
  decides the backend and the SCRAM spec decides the frontend. Open calibration values are placeholders to be
  measured in the field before any public pilot — never hard-code them as requirements.
