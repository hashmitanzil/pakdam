# @pakdam/workers — Pakdam live game server (fresh build)

Cloudflare Worker front door + one Durable Object per room (`RoomDO`) +
a single code-registry Durable Object (`CodeRegistryDO`). The DO is the
sole game authority; the Worker validates HTTP bodies, verifies credentials
by hash, and forwards. All game rules live in `@pakdam/engine`; all wire
types, validation, hashing and calibration live in `@pakdam/shared`. This
package is a thin shell over those two — it never re-implements a game rule.

## Public surface

### HTTP routes (base = `NEXT_PUBLIC_WORKER_URL`)

Success is flat `{ ok: true, … }`; errors are `{ error: '…' }`
(`{ error, issues }` for a bad body, 400). Every route is rate-limited
per `HTTP_RATE_LIMITS` in `@pakdam/shared` — including the 9 the old build
left un-limited.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/rooms` | Create room; returns roomId, code, host seat, reconnect + host tokens |
| GET | `/v1/rooms/by-code/:code` | Resolve a 6-letter invite code to a roomId |
| POST | `/v1/rooms/:id/join` | Join by code; restores a seat on matching name + token |
| POST | `/v1/rooms/:id/ws-ticket` | Issue a single-use WS ticket (60 s TTL) for connect / renew |
| POST | `/v1/rooms/:id/ws-ticket/revoke` | Revoke WS tickets for a seat (DO count authoritative) |
| GET | `/v1/rooms/:id?playerId=…` | Recipient-filtered room state (Bearer reconnect token) |
| POST | `/v1/rooms/:id/start` | Host starts the match (host token; 409 if the gate is unmet) |
| POST | `/v1/rooms/:id/config` | Host replaces the full lobby config (lobby only) |
| POST | `/v1/rooms/:id/remove-player` | Host removes a lobby player (never the host) |
| POST | `/v1/rooms/:id/regenerate-code` | Host swaps the room code; old code dies at once |
| POST | `/v1/rooms/:id/host/token` | Mint / rotate the host token for the host seat |
| POST | `/v1/rooms/:id/host/transfer` | Explicit host transfer (successor holds no host token until they call host/token) |
| POST | `/v1/rooms/:id/catch-token` | Runner fetches the raw one-time catch token for their QR (≥128 bits) |
| POST | `/v1/rooms/:id/catches/:cid/resolve` | Host resolves a disputed catch (confirmed / rejected — decision is final) |
| POST | `/v1/rooms/:id/lifecycle` | Server-only REST lifecycle: start / pause / resume / end |
| GET | `/v1/rooms/:id/results` | Match result, participant-only; 404 until a result exists |
| GET | `/v1/rooms/:id/ws?ticket=…` | WebSocket upgrade (ticket in the query string — the one sanctioned exception) |
| POST | `/v1/reports` | Report/block intake, audit record only (202); a block removes/silences nobody |
| POST | `/v1/support/bugs` | Bug intake, no location ever attached (202) |
| POST | `/v1/support/grievances` | Grievance intake, distinct from bugs (202) |

Deliberately NO REST routes (404 by design — WS only): catch
request/confirm/dispute, safety SOS, leave. No leaderboard route exists.

### WebSocket flows

- **Connect:** `POST …/ws-ticket` (HTTPS) → `wss://…/v1/rooms/{id}/ws?ticket=…`
  → `hello` first (protocolVersion 1, no credential) → `welcome` + `snapshot`.
  A missing/invalid ticket gets a real WS **4401** close frame, not HTTP 401.
- **Heartbeat:** client sends `heartbeat` every 30 s (`HEARTBEAT_INTERVAL_MS`);
  server replies `heartbeat.ack`. Missed limit 3 — the server closes a dead
  socket 1006 ('heartbeat timeout') and suspends the seat.
- **Ticket renewal:** the DO warns once when the socket's ticket expires
  within 30 s (`ticket.renewal-required`); the client fetches a fresh `renew`
  ticket and sends `auth.refresh` — the only message that ever carries a
  ticket. A `renew` ticket can never open a socket.
- **Close codes:** 1000 normal (do not reconnect) · 1001/1006/1011 backoff
  reconnect · 4400 bad request (fresh ticket, reconnect once; surface the
  failure) · 4401 ticket invalid/reused/expired (fresh ticket, reconnect
  once) · 4403 forbidden (do not reconnect) · 4409 protocol unsupported
  (do not reconnect) · 4413 rate-limited (back off, never before
  `retryAfterSeconds`).
- **Messages:** 22 client → server types, 34 server → client types
  (frozen contract v2.1). Direct messages go only to the sender;
  `voice.signal` and `radio` are team-only (lobby = whole lobby); `ping`
  is role-scoped (a Runner ping to Hunters, a Hunter ping to Runners); `reveal` goes to the whole room; catch events go to the
  parties + the host only (role secrecy); everything else broadcasts.
- **Suspension:** tab hidden / phone locked / socket closed = suspended
  ("location unknown"); the timer keeps running and a pending catch cannot
  complete while the Runner is suspended. Close → suspension only, NEVER
  removal. The DO resumes a suspended seat on `hello` / reconnect (P0-1).

### The DO's alarm tick (1 s while live, 30 s in the lobby, never terminal)

In order: purge stale fixes → HEAD_START → ACTIVE → match end (never while
paused) → outside-zone ejection (30 s countdown, frozen on poor GPS) →
zone shrink (random offset, never concentric) → scheduled pings (ACTIVE
only, coarse 150 m areas, mutual (Runner pings to Hunters, Hunter pings
to Runners), stay until the next ping).

## Deploy

```sh
# from the repo root
pnpm --filter @pakdam/shared build
pnpm --filter @pakdam/engine build
pnpm --filter @pakdam/workers deploy
```

Deploy is done by the founder (a real `wrangler deploy` needs his
Cloudflare auth). Never deploy from an agent session.

## The SUPABASE_URL rule (do not break this)

`SUPABASE_URL` is a plain `[vars]` value in `wrangler.toml` — declared HERE
in the file. The old deployment kept losing it when it lived only as a
secret / `--var` value: a plain `wrangler deploy` overwrote it and match
results silently stopped persisting. The project URL is public (it is also
the web app's `NEXT_PUBLIC_SUPABASE_URL`). Only the service-role KEY stays
a secret:

```sh
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Never put the key in `wrangler.toml` or in code. When either binding is
missing/empty, every Supabase helper returns false and does nothing —
persistence is best-effort by design and a failed insert never fails a
game request. The DO stays the authority when Supabase is absent.

## Design notes (the lessons, built in)

- **DO-owned WS ticket registry.** The Worker NEVER validates a ticket
  against its own store. Issuance mints the value and registers only its
  SHA-256 hash with the DO; the upgrade forwards ONLY the hash, and the DO
  validates + redeems atomically. A ticket issued on one isolate validates
  on any other. Sticky routing is not viable on Workers — do not attempt it.
- **Code registry DO.** Invite-code → roomId mappings live in the single
  `CodeRegistryDO` for the same single-owner reason: a lookup must work
  from any isolate.
- **Catch token ≥ 128 bits.** `newCatchToken()` (32 uppercase hex chars);
  same hash construction (`sha256(catchId + ':' + raw)`), same single-use +
  TTL semantics, QR-only carriage. The old 12-char (48-bit) form is rejected.
- **Catch-resolve: implemented.** Host resolves a disputed catch via
  `POST …/catches/:cid/resolve` (`confirmed` applies the mode rule and runs
  the win check; `rejected` voids the claim). The decision is final; a
  disputed catch can never be re-confirmed by the Runner.
- **Per-route HTTP rate limiting.** Every route in the table above, per
  `HTTP_RATE_LIMITS` (all OPEN placeholders — measure in the field). The
  limiter is in-memory per isolate, which is acceptable for rate limiting
  ONLY, never for ticket validation or any correctness-critical state.
  NAT-join caveat: a 30-player roster joining inside a minute from one NAT
  IP is legitimate — do not throttle it by a per-IP join cap without a
  field measurement.
- **Snapshot + privacy rules.** Snapshots carry no raw coordinates, no
  pending pings, no token hashes; each seat sees its OWN role/team only.
  Fixes live in DO memory only (purged after 120 s and at match end); raw
  catch tokens live in DO memory only; WS tickets are memory-only and never
  persisted. Raw tokens of any kind are never logged or stored.
- **CSP / HSTS** are set on every HTTP response (the old build had none).
- **Supabase schema:** no change needed — deploy set stays 0001 + 0003 +
  0004 in order; 0002 RLS stays held in `migrations-deferred/`.
- **Files:** `src/index.ts` (entry/routing/CORS/headers/rate limits),
  `src/http.ts` (route handlers), `src/room-do.ts` (DO state ops over
  `@pakdam/engine`), `src/room-do-class.ts` (DO classes: sockets, alarm,
  hibernation), `src/auth.ts` (ticket/token minting + hashing),
  `src/rate-limit.ts` (per-route limiter), `src/supabase.ts` (PostgREST
  durable writes + persist intents), `src/telemetry.ts`
  (`telemetry_daily` aggregation, best-effort).
