# API contract (v2.1 Issue 8 — exact, not illustrative)

Base: `/v1`. All requests carry `v: 1`. Server timestamps authoritative.
Errors: versioned codes in `@pakdam/shared` ERROR_CODES; payloads never
contain raw coordinates, tokens or secrets.

## REST
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /v1/rooms | Host | Create room; body = RoomConfig (validated, HNT-011/012) |
| GET | /v1/rooms/{id} | Participant | Recipient-specific view only (HNT-038) |
| POST | /v1/rooms/{id}/join | Guest credential | Body: roomCode + displayName; returns reconnect credential |
| POST | /v1/rooms/{id}/ws-ticket | Participant | Returns short-lived single-use WS ticket (17 §2.5; `wsTicketTtlSeconds` OPEN) |
| POST | /v1/rooms/{id}/ws-ticket/revoke | Participant / host | Revokes unredeemed tickets; closes a connected socket with 4403 for remove/security (17 §2.6) |
| POST | /v1/rooms/{id}/lifecycle | Host / any (pause) | start/pause/resume/end |
| POST | /v1/rooms/{id}/catches | Hunter | Request catch; returns catchId + token TTL |
| POST | /v1/rooms/{id}/catches/{cid}/confirm | Runner | Finalises ONLY on Runner confirm |
| POST | /v1/rooms/{id}/catches/{cid}/dispute | Runner | Neutral review |
| POST | /v1/rooms/{id}/safety/sos | Any player | Host-only notification, best-effort (HNT-059) |
| POST | /v1/rooms/{id}/leave | Any player | Stops location sharing immediately |
| POST | /v1/reports | Any player | Report/block (HNT-064) |
| POST | /v1/support/bugs | Any player | HNT-117, no location |
| POST | /v1/support/grievances | Any | Rule 20 grievance, distinct from bugs |
| GET | /v1/rooms/{id}/results | Participant | HNT-030, no routes |

## WebSocket — /v1/rooms/{id}/ws (17 §3, v2.1 FROZEN contract)
1. Client gets a ticket via POST /v1/rooms/{id}/ws-ticket (HTTPS, auth:
   host token or guest reconnect credential; purpose `connect` / `renew`).
   Issuing a new ticket invalidates other UNREDEEMED tickets for the seat.
2. The ticket travels ONLY in the handshake query string:
   `wss://<api-host>/v1/rooms/{id}/ws?ticket=<ticket>`. It is consumed
   (invalidated) the moment the handshake succeeds. A second handshake
   with the same ticket fails with `TICKET_REUSED` (close 4401); a ticket
   for another room/seat is `TICKET_INVALID`; a past-TTL ticket is
   `TICKET_EXPIRED`. Ticket values are never logged — only `ticketId`.
3. `hello` carries NO credential — `{ protocolVersion: 1, clientVersion,
   lastServerSeq }` only. Any hello containing `token`/`ticket`/`password`
   is rejected with `VALIDATION_FAILED` and audited. The v2
   hello-with-ticket shape is deleted.
4. The ONLY message that carries a ticket is `auth.refresh` (renewal):
   the server sends `ticket.renewal-required` (`{expiresAt}`), the client
   calls POST /ws-ticket with purpose `renew`, then sends one
   `auth.refresh` over the existing socket; the server replies
   `auth.refreshed` and invalidates the old binding.
5. Server replies `welcome` then `snapshot` (recipient-specific, HNT-038:
   NO raw coordinates, NO pending pings, NO token hashes; every player's
   location is `unknown` until a fresh foreground fix arrives).
6. Every command carries `commandId` + `idempotencyKey`
   (crypto.randomUUID, 17 §3.6); duplicates return the original outcome.
   Server events carry monotonic `serverSeq` + `serverTs`; the client
   drops events with `serverSeq` <= last applied and applies a snapshot
   as the whole truth.
7. Reconnect (17 §3.5): fresh ticket via HTTPS, new handshake, hello with
   `lastServerSeq`, then `snapshot.request` / `resync.request`. Close
   codes: 1000/4403/4409 do NOT reconnect; 1001/1006/1011/4400 reconnect
   with exponential backoff + jitter (max attempts OPEN); 4401 fetches a
   fresh ticket first, then reconnects once; 4413 backs off until
   `retryAfterSeconds`. No offline backfill — commands sent while
   disconnected are discarded.
8. Heartbeats (17 §3.7): the client sends `heartbeat` only when the
   server asked for it; the server replies `heartbeat.ack`. Interval and
   missed-heartbeat limit are OPEN. Tab-hidden sends a best-effort
   `player.suspended` notice; on visible the client requests a fresh
   snapshot.
9. Message types: see `packages/shared/src/types.ts` (WsClientMessage /
   WsServerMessage — the full 17 §3.3 catalogue). Client:
   `apps/web/src/lib/websocket.ts` (PakdamSocket). Server:
   `workers/src/room-do.ts` (validateHello, buildWsSnapshot,
   handleWsClientMessage, closeCodeFor) + `workers/src/auth.ts`
   (WsTicketStore) + `workers/src/index.ts` (handleWsUpgrade).
   Telemetry is counts only — no coordinates, no ticket values.
   Team Radio text (D-M7, 2026-11-17): `radio.send` (client → server,
   text 1–140 chars, kind quick/text) → `radio` (server → the sender's
   team only; lobby scope: the whole lobby). Ephemeral — no snapshot
   carries radio history. Next zone (same date): the DO re-draws the
   next zone per shrink at the alarm tick; the stored phase boundary
   is a size placeholder only.
