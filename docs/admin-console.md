# Pakdam Admin Console ("Mission Control") — server notes

Server side (Kabir), 2026-11-25. Working tree:
`~/workspace/goals/hide-and-seek-combo-game/files/pakdam-admin/`.
NEVER merge into the live tree from here — the parent merges after v34.

The web half (Meera) lives in the same tree:
`packages/shared/src/admin.ts` (the contract), `apps/web/src/lib/admin/`,
`apps/web/src/app/admin/`. The server implements Meera's FIXED contract
exactly — response bodies are the bare payloads her client types expect,
not the game's `{ ok: true, ... }` envelope.

## 1. What exists

- **RBAC** — matrix in `packages/shared/src/admin.ts`
  (`ADMIN_PERMISSIONS` + `adminCan`). Owner = everything (incl. exact
  live locations + admin-account management). Admin = everything except
  live locations and user management. Staff = view-only + creating
  safety flags. The Worker enforces it server-side on every route
  (`workers/src/admin.ts` → `requireAdmin`); the client gate is display
  only. Permission names are Meera's (`view.rooms`, `players.viewLocation`,
  `view.users`, …) — the brief's names (`rooms.view`, `players.viewLiveLocation`,
  `users.view`) map onto these; see §7.
- **Auth** — `workers/src/admin-auth.ts` + `workers/src/admin.ts`.
  Separate `admin_users` table (NOT Supabase Auth, NOT game guest flow —
  decision on evidence in `admin-auth.ts`). PBKDF2-SHA256, 600,000
  iterations (OWASP 2023), 16-byte salt, 32-byte output.
  Server-side sessions (`admin_sessions`, 12 h absolute), bearer token
  `v1.<id>.<random>.<hmac>` (HMAC-SHA256 with `ADMIN_SESSION_SECRET`).
  Session minting REFUSES when `ADMIN_SESSION_SECRET` is unset unless
  `ADMIN_DEV_MODE=true` is set explicitly (fail closed; the `nosecret`
  token form exists only behind that flag). Login: lockout is per
  (account, IP) pair — 5 failures from one (account, IP) locks THAT
  pair for 15 min (423 `ACCOUNT_LOCKED`); an attacker elsewhere can
  never lock the Owner out of their own IP. Every failed login path
  (unknown username, disabled account, locked pair) runs exactly one
  dummy PBKDF2 before answering, so a locked account answers no faster
  than a wrong password (no timing oracle). Password policy: 12+
  characters; Owner-created accounts start with `must_change_password`
  and must rotate on next login — enforced server-side (fix round
  B3 re-review, 2026-11-26): a flagged session is refused with 403
  `PASSWORD_CHANGE_REQUIRED` on every admin route except the
  change-password endpoint and logout; login itself still succeeds
  (and reports the flag) so the client can redirect to the change
  page. Self-service password change for ANY role
  (`POST /v1/admin/auth/change-password`, verifies the current
  password, revokes ALL sessions for that user, clears the flag) —
  it operates on the caller's session identity only and takes no
  target user, so nobody can change anyone else's password through
  it. Changing another account's password stays Owner-only via
  `PUT /v1/admin/users/:id {password}` (which re-arms the flag).
  Per-user session revocation (`POST /v1/admin/users/:id/revoke-sessions`) exists;
  disabling a user deletes their session rows. Logout deletes the
  session row. Owner bootstrap (`POST /v1/admin/auth/setup`) requires
  the `ADMIN_SETUP_TOKEN` env secret: absent OR wrong token → 403,
  unconfigured token → 503 (fail closed); the token comparison is
  constant-time (`timingSafeEqual`, same loop as the session HMAC
  check). Concurrent first setups are
  serialised by the `admin_setup_owner()` RPC (advisory lock,
  `0011_admin_guards.sql`); the last enabled Owner cannot be demoted,
  disabled or deleted — enforced by a DB trigger
  (`admin_users_last_owner_guard`), not by re-checking.
- **Endpoints** — all under `/v1/admin` in `workers/src/index.ts`
  (handlers in `workers/src/admin.ts`, DO ops in `workers/src/room-do.ts`
  + `workers/src/room-do-class.ts`):
  auth (login/logout/me/setup), overview, rooms (+ detail/end/cancel/
  force-results), players (+ live location Owner-only, kick/block/unblock,
  erase Owner-only), flags (+ public), config (+ public), safety
  (reports/blocks/flags), metrics, audit, announcements (+ public),
  users (admin accounts, Owner-only), billing (6 reads), users-directory
  (+ detail/ban/suspend/unban), data-requests, login-methods.
- **Room ops are REAL**: end/force-results → DO `admin-force-results`
  (`completeMatch` with current standings; room stays for results +
  replay); cancel → DO `admin-end` (`cancelMatch` + the v23 host-cancel
  delete flow — the room is gone); kick → DO `admin-kick` (lobby:
  remove + socket close 4403; live: eject via `ejectWithWinCheck` +
  socket close 4405, incl. win check). End and force-results share the
  `completeMatch` primitive; cancel is the only delete primitive.
- **Feature flags** — `workers/src/admin-flags.ts` (`getRuntimeFlags`,
  60 s cache, fails OPEN to shared defaults). Consulted server-side at
  runtime in exactly two places: `gameStart` kill-switch in `handleStart`
  (`workers/src/http.ts`) and `radio` in the DO WS path
  (`room-do-class.ts` `webSocketMessage`: `radio.send` / `voice.signal` /
  `signal.send` are refused with an `error` event when OFF, never
  silently dropped). Pings (`pings`) and zone (`zone`) are specified
  consult points with NO wiring yet — they are built in the DO tick
  (`buildPing` / zone enforcement in `room-do.ts`) and need an async
  flag read threaded through the tick (OPEN merge item). `demoMode` has
  no consult point: no demo mode exists in the game.
- **Blocks enforcement** — `workers/src/admin-db.ts`
  (`isReconnectHashBlocked`): a banned seat rejoining with its stored
  reconnect token is refused 403 at `handleJoin` / `handleJoinByCode`.
  A fresh join with no token cannot be matched — there is NO device key
  in the game today, so a ban binds to the seat credential
  (`reconnect_token_hash`), not the hardware. Stated, not hidden.

## 2. Founder runbook (first login)

1. Apply migrations `0009_admin.sql`, then `0010_admin_billing.sql`,
   then `0011_admin_guards.sql` (Supabase SQL editor or
   `supabase db push`). Until 0009 lands, every admin endpoint answers
   503 and the game is unaffected.
2. Set the Worker secrets (never in `wrangler.toml`):
   `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (already set for the
   game), `wrangler secret put ADMIN_SESSION_SECRET`,
   `wrangler secret put ADMIN_SETUP_TOKEN` (**required** — setup is
   refused outright while it is unset, §6 OPEN-2).
   `DO_OP_SECRET` should already be set; the admin DO ops travel the
   same secret-gated `/op` channel. If it is unset the Worker logs a
   once-per-isolate error and the overview reports it — the game still
   runs, because refusing `/op` calls would break every room (the DO
   is only reachable via the Worker binding, so the residual risk is
   defence-in-depth only).
3. Deploy the Worker, open `/admin/setup`, create the Owner account.
   The setup endpoint becomes inert afterwards (409). The Owner is the
   only account that can create Admin/Staff accounts (`/admin/users`).
4. Sign in at `/admin/login`. Sessions last 12 h and live in
   `sessionStorage` (one tab = one session, like the game seat token).

## 3. Payments & Billing (INACTIVE — designed, not live)

- Endpoints: `GET /v1/admin/billing/{overview,transactions,plans,
  providers,refunds,tax}`. Each returns `{ available: false, reason,
  unlocksWhen, willDo, ...empty honest data }`. Plans lists the one
  planned plan: Host Pass ₹299 one-time, status
  `"planned — not on sale, legal gate pending"`. No fake revenue, no
  fake transactions, no fake users — ever.
- Flags (one per capability, default OFF): `billing.overview`,
  `billing.transactions`, `billing.plans`, `billing.providers`,
  `billing.refunds`, `billing.tax`. When a flag flips ON the endpoint
  STAYS inert without a provider (`available: false`, reason names the
  missing provider) — there is no charge path in this codebase at all.
- Schema: `0010_admin_billing.sql` — `billing_plans`,
  `billing_transactions`, `billing_refunds`, `billing_payouts`,
  `billing_invoices` (all empty, design only). Money is integer paise,
  never float. NO card data anywhere: no card number, CVV, expiry or
  cardholder name in any table, endpoint or log.
- Integration with the v2 track at merge: the v2 constant
  `HOST_PASS_PRICE_INR = 299` (`pakdam-fresh-v2/packages/shared/src/
  host-pass.ts`) is the source of truth for the price; this tree's
  `HOST_PASS_PLAN` (shared `admin.ts`) is a reference to that decision
  — if the two disagree at merge, that is a merge conflict to resolve,
  not a silent override. The billing tables plug into the v2 Host Pass
  scaffolding (flag-only, no purchase path) when the legal gate clears
  and a provider is connected. No provider SDKs are added here.

## 4. Users & Accounts (directory REAL today, accounts future)

- **Admin accounts vs player directory — different things.**
  `/v1/admin/users` = RBAC admin accounts (staff who run the panel).
  `/v1/admin/users-directory` = game players (guests). Never confuse them.
- Directory (`GET /v1/admin/users-directory`, `/:id`): REAL today —
  guest players by codename + room + status, from the `players` mirror.
  No invented identity fields (no email, no phone, no name beyond the
  codename). Purchases: `[]` (no provider, no sales). NOT flag-gated:
  the guest data already exists, so gating it OFF would hide real
  safety information. The `accounts.directory` flag governs the FUTURE
  account-level views, not the guest directory.
- Ban/suspend/unban (`POST /v1/admin/users-directory/:id/{ban,suspend,
  unban}`): REAL — live-kick via the DO `admin-kick` (best-effort) +
  a `blocks` row keyed by playerId + the seat's `reconnect_token_hash`
  (ban = indefinite, suspend = time-boxed, default 7 days). Rejoin
  with the blocked token is refused at the join gate (§1). Unban
  removes the rows. All three are audit-logged.
- Data requests (`GET /v1/admin/data-requests`): FUTURE — flag
  `accounts.dataRequests` OFF → not-available shape. Table
  `data_requests` exists in 0010 for the future intake (access /
  correction / erasure). Erasure TODAY is the Owner-only
  `POST /v1/admin/players/:id/erase` endpoint (deletes the player's
  rows by playerId; the admin audit log is deliberately NOT erased).
- Login methods (`GET /v1/admin/login-methods`): FUTURE — Google /
  email magic link per the v2 login feature, no phone OTP ever. Flag
  `accounts.loginMethods` OFF → not-available; even with the flag ON
  it stays `available: false` until the v2 login feature is built.

## 5. Compliance checklist (evidence or OPEN)

| # | Requirement | Evidence / status |
|---|-------------|-------------------|
| C-1 | Purpose limitation + data minimisation via RBAC | Matrix in `packages/shared/src/admin.ts`; server-enforced per route (`workers/src/admin.ts` `requireAdmin`); tests: `packages/shared/test/admin.test.mjs` (10 tests, every role × every permission), `workers/test/admin-rbac.test.mjs` (35 tests, incl. a sweep over all 45 gated handlers × owner/admin/staff asserting exactly the matrix). |
| C-2 | No raw coordinates stored | No admin table has a lat/lng column (0009/0010/0011 — grep: `lat\|lng` appears only in comments about NOT storing them). Admin summary is a redacted shape (`room-do.ts` `adminSummaryOp` — the zone boundary is excluded on purpose). Players list carries `lastFixAt` + `gpsOk` only. |
| C-3 | Live-location view Owner-only, in-session only, never logged/stored/exported | `players.viewLocation` is owner-only in the matrix; handler `handleAdminPlayerLocation` calls the DO `admin-live-fix` (DO memory only); audit row records THAT it happened, never the coordinates (test asserts the audit JSON contains no lat/lng). |
| C-4 | Audit log retained 180 days (vs 7-day game logs) | `admin_audit_log` + `deleteOldAdminAudit` (180 d) in `workers/src/admin-db.ts`, wired into the scheduled handler (`workers/src/index.ts`, cron 03:00 UTC). Game logs stay 7 d (`deleteOldLogs`). The difference is deliberate and commented. |
| C-5 | Breach / incident path | DOCS ONLY, not code: notify the Owner immediately; preserve the audit log; DPDP Board notification within 72 hours and CERT-In within 6 hours (CERT-In Directions 2022) — the exact procedure needs the founder's incident contact + a lawyer's confirmation (OPEN-5). No auto-reporting is built. |
| C-6 | Data-principal rights (access / correction / erasure) | Erasure is live: Owner-only `POST /v1/admin/players/:id/erase` (404 on an unknown playerId; deletes players, room_events, catches, safety_events, bug_reports, logs, blocks by player_id AND device_id, game `audit_log` rows, `billing_transactions` rows, `data_requests` rows; the DO kick is verified before the mirror deletes, but only a genuine DO error aborts the erase — a 409 CONFLICT / INVALID_STATE kick (already-left/ejected seat, host the DO will not kick, terminal-phase room) means the seat is already gone and the erase proceeds; every delete is checked and a partial failure is reported honestly as 500 with `deleted` + `failed` lists — never `erased:true` on partial; the admin audit log is retained). JSONB scrub (fix round M3 re-review, extended M3-3/M3-4, 2026-11-26): the id is also redacted IN PLACE with the marker `[erased]` in `room_events.payload` rows that survive the actor delete (e.g. a PLAYER_TAGGED row whose hunter is the actor), in `rooms.result` (caught/surviving lists + tags) AND in `rooms.config` (`selectedHunterIds`) — history rows and result shapes are preserved, only the id is gone; both scrubs page through their tables (1000 rows/page, keyset since fix round 4: `order=<id>.asc` + `<id>=gt.<last-seen>`, so a concurrent DELETE mid-scrub can no longer shift rows past the cursor and skip one) so residue past a cap can never be reported deleted; a scrub failure is reported in `failed` like any other step. `rooms.host_player_id` is nulled for the erased player (M3-2, only when the mirror row names them). DO redact (M3-B, hardened fix round 4, 2026-11-26): the erase also tells the DO itself to forget the player (`admin-redact-player`). The round-3 doc claim — "a later persistRoom can never rewrite the id back" — was FALSE as stated and was falsified live by Diya: the rewrite did not come via a plain persistRoom, it came via a REBUILT result (unredacted `state.catches` feeding `caughtRunnerIds()` / `confirmedTags()` into force-results, which re-persisted the id through the MATCH_COMPLETED room_event, the match-result PATCH, and the room-upsert). The actual guarantee after fix round 4 is the redact invariant, pinned by tests: after `admin-redact-player`, NO DO state, DO memory, persist intent, snapshot, summary, or live-fix read contains the erased id or codename, and the seat can never be restored or re-created under its codename in that room. What is redacted where: `room.result` / `room.config` / `room.hostPlayerId` / host-grace host → `[erased]`; `state.catches` hunter/runner ids → `[erased]` (so rebuilt results carry the marker); the SEAT RECORD is DROPPED from `state.players` (it kept its reconnect token, so a LOBBY rejoin by display name + saved token restored it and its player-upsert re-created the deleted players row) and its codename is tombstoned in durable `erasedSeatNames` — `add-player` refuses any join under it (403), the tombstone survives replay and DO wake (`durableSnapshot` carries it); `hostTokens` / `lastPingAtMs` / 30 s deadline / WS tickets / runner QR tokens / pending-ping recipient entries / per-seat mem maps / announcements / game-event + event logs / log buffer / last-succession event are cleared or redacted; the seat's sockets are closed (4403) and every session record deleted. Pins (workers/test/admin-do-ops.test.mjs, fix round 4): redact-then-force-results persists no id in any mirror write; redact-then-rejoin in LOBBY 403s and the summary never re-serves id or codename; erase a caught runner from a COMPLETED room, then replay + admin-summary show the id nowhere. What the DO redact does NOT guarantee: it cannot retract mirror rows already written before the erase (that is the mirror scrub's job, above), and it cannot erase a codename from a client that already saw it. A redact failure never aborts the erase (the mirror scrub is authoritative) but is reported in the response (`doRedact`) and the audit row. Persist boundary: `[erased]` is not a UUID and `rooms.host_player_id` is a uuid column, so `roomRow` translates the marker to null there — the mirror host column ends null, result/config carry `[erased]`. Host guard is live-phase only PLUS DRAFT (M3-A): a host of a COMPLETED / CANCELLED / ABANDONED / EXPIRED room (or a room whose mirror row is gone) CAN be erased; a live-room OR DRAFT-room host 409s (a DRAFT still has a host and no pre-LOBBY succession, so erasing its host would orphan a draft that can never start — cancel it first). Access/correction intake is future (`data_requests`, flag OFF); the flag-ON list read is audit-logged (M4-1, count only). |
| C-7 | Children's data: no age data exists | No age / date-of-birth field exists in any admin table or endpoint, and none is collected. The game has an age GATE (a boolean, `ageGatePassed`) but no age value. Stated explicitly; do not add age collection without a DPDP review. |
| C-8 | Billing (future): RBI card token-only | No card data ever touches our servers (no card columns in 0010, no card fields in any endpoint). When a provider connects, card handling is the provider's job. |
| C-9 | Billing (future): PCI-DSS via provider | We never store/process card numbers, so PCI-DSS scope is the provider's. No SAQ claim is made here. |
| C-10 | Billing (future): GST invoicing + record retention | GST invoicing starts with the first sale (`billing_invoices` design in 0010). **The exact GST record-retention period is NOT stated anywhere in this tree — it is CA-verification pending (OPEN-6). Do not guess a year count.** |
| C-11 | Billing (future): DPDP for billing data | Billing rows carry a playerId + provider refs only, no card data, no contact data beyond what the provider returns. Consent/retention rules for billing data need the CA/lawyer review (OPEN-6). |
| C-12 | Accounts (future): DPDP rights / consent / children | Directory holds guest codenames only (data minimisation by design). When accounts land: consent records, per-account erasure (what happens to their games/logs — the erase endpoint is the template), and children's handling all need a DPDP review before activation (OPEN-7). |
| C-13 | Account deletion (future) | Design: deleting an account deletes the account row + their player rows (via the erase procedure) and keeps the admin audit log. Not built — accounts do not exist yet. |

## 6. OPEN items (need a founder / coordinator decision)

- **OPEN-1 — Permission-name mapping (PARTIALLY CLOSED).** The brief
  named permissions `rooms.view`, `players.viewLiveLocation`,
  `users.view`, `billing.view`, `billing.manage`, `accounts.view`,
  `accounts.manage`. The contract already in the tree (Meera) uses
  `view.rooms`, `players.viewLocation`, `view.users`, `view.billing`,
  `view.accounts` — and has NO `billing.manage` / `accounts.manage`
  permissions. The server enforces Meera's names. Billing reads use
  `view.billing`; directory ban/suspend reuse `players.block`, unban
  uses `players.unblock`; erasure now uses a real matrix permission
  `players.erase` (Owner only, added in the fix round) and password
  change uses `users.changePassword` (held by EVERY role since the
  B3 re-review, 2026-11-26 — self-service, own password only; see
  §1). What remains:
  `billing.manage` / `accounts.manage` still do not exist — future
  billing/accounts flags are Owner-only by role check in
  `handleAdminFlagsPut`, not by a matrix permission. If the
  coordinator wants those two as contract permissions, they are
  one-line matrix additions.
- **OPEN-2 — Setup token (CLOSED, fix round B1).** The server now
  enforces it strictly: `ADMIN_SETUP_TOKEN` configured → absent OR
  wrong `setupToken` is 403 (identical responses, no oracle);
  unconfigured → setup is refused outright with 503
  `SETUP_TOKEN_UNCONFIGURED`. The setup page must send the token
  (Meera adds the field). Concurrent first setups are serialised by
  the `admin_setup_owner()` RPC (advisory lock, migration 0011) and
  the last-Owner trigger guards demote/disable/delete races.
- **OPEN-3 — Reads audit-logging (PARTIALLY CLOSED).** The brief says
  every admin endpoint writes an audit row. The server logs every
  MUTATION, every RBAC denial, every auth event and every
  live-location view — and, since the fix round, every BULK/LIST read
  (`admin.overview.listRead`, `admin.rooms.listRead`,
  `admin.players.listRead`, `admin.flags.listRead`,
  `admin.safety.listRead`, `admin.metrics.listRead`,
  `admin.audit.listRead`, `admin.announcements.listRead`,
  `admin.users.listRead`, `admin.accounts.listRead`, row count only,
  never row data), so silent exfiltration leaves a trail. Since fix
  round M4 (2026-11-26) two more reads are logged because they return
  bulk in substance: the room detail read
  (`admin.rooms.detailRead` — player count only, never ids or
  codenames; it returns the full roster of up to 30 seats) and the
  flag-ON data-requests list read (`admin.dataRequests.listRead` —
  count only, never player ids or contact refs). Single-PLAYER detail
  reads (one player) are still NOT logged — that stays a founder
  call, and no per-read logging is built for them. Full
  per-read logging remains a founder call — the coordinator can rule
  otherwise. Audit-write failures are no longer silent: the write
  retries once after 250 ms, then logs loudly (console.error) and
  increments a health counter surfaced in the overview as
  `auditHealth` (`writeFailures`, `lastWriteFailureAt`).
- **OPEN-4 — Pings / zone flag wiring.** `pings` and `zone` have no
  server-side consult yet (built in the DO tick; needs an async flag
  read threaded through the tick). Radio + gameStart are wired.
- **OPEN-5 — Breach procedure.** C-5 is docs only; needs the founder's
  incident contact and a lawyer's confirmation of the 72 h / 6 h steps.
- **OPEN-6 — GST + billing compliance.** Retention period, invoicing
  rules and DPDP handling for billing data need a CA's verification
  before any sale. The legal gate for Host Pass is still pending.
- **OPEN-7 — Accounts compliance.** Consent records, children's
  handling and account-deletion semantics need a DPDP review before
  the login feature activates.
- **OPEN-8 — `gameStart` flag.** Added to `ADMIN_FLAG_DEFS` by the
  server track (kill-switch, consulted in `handleStart`). Meera's flag
  page renders it from the defs — no client change needed, but the
  addition is recorded here as a contract change.
- **OPEN-9 — Ban binds to the seat credential, not hardware (CLOSED,
  fix round M5).** The arbitrary-deviceId block creation path is
  REMOVED: `POST /v1/admin/safety/blocks` now requires a real
  playerId (UUID, must exist), looks up the seat's reconnect-token
  hash, and writes a seat-credential block. Responses carry
  `enforcement: 'seat-credential'` and block/ban/suspend responses
  carry `liveKick: 'ok' | 'room-gone' | 'failed'`, so no endpoint
  claims enforcement it lacks. A banned player who rejoins with a
  fresh name and no stored token still cannot be matched — there is
  NO device key in the game today. A real device identity (if ever
  wanted) is a game change, not an admin change.
- **OPEN-10 — `gameStart` fail-open needs founder confirmation (fix
  round n11).** The flag consult fails OPEN: if Supabase is down (or
  the flag row is missing) the flag reads as ON and matches start.
  The reasoning: a Supabase outage must never block a match start.
  The cost: an Owner who turns gameStart OFF during an outage cannot
  enforce the kill-switch until Supabase recovers. Founder to confirm
  fail-open is acceptable, or the consult flips to fail-closed.

## 7. Contract changes made by the server track (report to coordinator)

1. Added `gameStart` to `ADMIN_FLAG_DEFS` (kill-switch flag).
2. Fixed `adminCan` throwing on an unknown permission key (it now
   denies, as its docstring promises).
3. CORS `Access-Control-Allow-Methods` now includes PUT + DELETE (the
   admin client uses them; without this the preflight fails).
4. Safety-block creation is gated by `players.block` (no
   `safety.blocksManage` permission exists in the matrix).
5. `POST /v1/admin/rooms/:id/end` and `/force-results` share the
   `completeMatch` primitive; `/cancel` is the delete primitive.
6. **Fix round (2026-11-25):** new matrix permissions `players.erase`
   (Owner only) and `users.changePassword` (Owner only at the time —
   SELF-SERVICE for every role since the B3 re-review, 2026-11-26:
   any signed-in admin changes their OWN password only; the endpoint
   takes no target user); new endpoints
   `POST /v1/admin/auth/change-password` and
   `POST /v1/admin/users/:id/revoke-sessions`; future flags
   (`billing.*`, `accounts.*`) are flippable via `PUT /v1/admin/flags`
   but Owner-only; public flags/announcements strip `updatedBy` /
   `createdBy`; password policy is 12+ characters with first-login
   rotation (`must_change_password`), server-enforced since the
   re-review (flagged sessions get 403 `PASSWORD_CHANGE_REQUIRED` on
   every route except change-password and logout); every authenticated admin JSON
   response carries `Cache-Control: no-store` (router-level,
   `workers/src/index.ts`; the three public reads keep their own
   `public, max-age=60`); setup requires `ADMIN_SETUP_TOKEN`
   (fail-closed, 403 absent/wrong, 503 unconfigured — the token
   comparison is constant-time since the re-review) — **the setup
   page must send the token (Meera)**; the setup/login/user-create
   pages still say "at least 8 characters" — **Meera must update that
   copy to 12**; audit-write failures retry once, log loudly and
   surface in the overview as `auditHealth`. Since the re-review
   every BULK/LIST read leaves an audit row (overview, rooms,
   players, flags, safety, metrics, audit, announcements, users,
   directory — row counts only); erasure also scrubs the id in place
   (`[erased]`) from `room_events.payload`, `rooms.result` and
   `rooms.config`, deletes `data_requests` rows, nulls
   `rooms.host_player_id`, pages both scrubs, tolerates 409 kicks
   from terminal rooms / already-gone seats, tells the DO itself to
   forget the player, and its host guard is live-phase plus DRAFT
   (fix round M3/M4, 2026-11-26). The room detail read and the
   flag-ON data-requests list read are now audit-logged too (counts
   only); single-player detail reads stay unlogged (OPEN-3, founder
   call).
7. **Fix round, billing/accounts honesty:** safety-block creation no
   longer accepts an arbitrary deviceId (requires a real playerId);
   responses carry `enforcement: 'seat-credential'` and `liveKick`.
   Block / directory-ban refuse 409 `HOST_PROTECTED` when the
   target is the room host; erase refuses only when the host's room
   is still live (a host of a finished room is erasable — M3
   re-review, 2026-11-26). Metrics is gated on `view.costs`.

## 8. Game-side integration points (for the merge)

- Public reads the game client calls at startup (60 s cache):
  `GET /v1/admin/flags/public`, `GET /v1/admin/config/public`,
  `GET /v1/admin/announcements/public` (all no-auth, `Cache-Control:
  public, max-age=60`; defaults when Supabase is down).
- Server-side flag consults (already wired): `gameStart` in
  `handleStart`; `radio` in the DO WS path. Not yet wired: `pings`,
  `zone` (OPEN-4), `demoMode` (no consult point — no demo mode).
- Join gate: `handleJoin` / `handleJoinByCode` refuse a blocked
  reconnect-token hash (403) before the DO `add-player` op.
- The v2 track's Host Pass (`HOST_PASS_PRICE_INR = 299`) and login
  feature (Google / email magic link, no phone OTP) plug into the
  billing/accounts sections at merge: price constant, plan row and
  login-methods shape are already aligned; no code is duplicated here.
- Migrations to apply, in order: `0009_admin.sql`,
  `0010_admin_billing.sql`, `0011_admin_guards.sql` (after 0001 +
  0003 + 0004 + 0008). Do NOT renumber.

## 9. What only the founder / CI can prove

- First admin login + setup on the live Worker (needs the deployed
  secrets + the migration applied).
- Playwright e2e runs locally (VM Chromium launches fine here —
  proven 2026-11-26) — but the live admin flows still need a live
  Worker, so the founder's CI remains the verdict for those; no live
  e2e specs are claimed as run here.
- The Cloudflare DO request meter (not queryable from the Worker —
  the console reports `doRequestsToday: 0` + a note pointing at the
  Cloudflare dashboard; the 100,000/day free cap is the known limit).
- Supabase migration application (written, not applied — the founder
  applies them).
