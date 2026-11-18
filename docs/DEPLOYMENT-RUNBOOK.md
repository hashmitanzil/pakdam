# Pakdam — Deployment Runbook (Cloudflare Workers / Durable Object + Supabase)

> **Read this first. This runbook deploys what exists today — it does not
> make the game live.**
>
> - The Worker in `workers/src/index.ts` is **implemented, not a
>   skeleton** (corrected 2026-11-17): its `fetch` handler routes
>   `POST /v1/rooms`, `POST /v1/rooms/{id}/join`,
>   `POST /v1/rooms/{id}/ws-ticket`, `POST .../ws-ticket/revoke`,
>   `POST /v1/rooms/{id}/start` (host only, QA BE-11),
>   `GET /v1/rooms/{id}` and `WS /v1/rooms/{id}/ws` to the
>   `RoomDurableObject` (`workers/src/room-do-class.ts`), which handles
>   room messages against the authoritative engine. No `501` remains in
>   `workers/src` — the old "skeleton" description in this runbook was
>   stale and has been corrected. Deploying it proves the deploy
>   pipeline works; it does not prove the game works — the web app is
>   still not wired to the Worker and the Worker never talks to
>   Postgres.
> - **The web → Worker transport is WIRED (corrected 2026-11-18).**
>   `apps/web/src/lib/websocket.ts` has `PakdamSocket` plus
>   `createLivePakdamSocket()`, switched on by `NEXT_PUBLIC_WORKER_URL`
>   (unset = local demo loop). The lobby, play, catch and results pages
>   call it. Worker → Supabase exists as a client
>   (`workers/src/supabase.ts`, plain-fetch PostgREST, best-effort game
>   writes, fail-loud support intake). What is still missing is the
>   DEPLOYMENT itself — no Cloudflare deploy, no Supabase project, no
>   live game played. Do not present a deploy as "live multiplayer"
>   until the two-phone field test passes.
> - **No accounts, keys, domains, or hosting exist yet.** Nothing in this
>   runbook creates an account, logs in, or deploys anything. Every
>   credential is a name only — no values anywhere in this file or repo.
> - Supabase Auth method is **OPEN (OD-022)** and migration `0002_rls.sql`
>   **must NOT be applied to a live database** until it is decided (see
>   §5). Applying it now would deny every guest read. Founder decision
>   2026-11-17: the file was MOVED to `supabase/migrations-deferred/`
>   so a plain `supabase db push` cannot apply it — the deploy set is
>   0001 + 0003 + 0004.
>
> Status sources: `docs/STATUS.md`, `docs/DECISIONS.md`, `README.md`,
> `docs/KABIR-FAST-BUILD-REPORT.md`. If this file disagrees with one of
> those, the status doc wins and this file must be corrected.

## 1. What is being deployed

| Piece | Source in repo | Target |
|---|---|---|
| Web PWA | `apps/web/` — Next.js 15.5, React 19, MapLibre GL JS + BUNDLED offline map (Doranda + Hinoo, Ranchi — `apps/web/public/offline-map/`, built by `apps/web/scripts/download-offline-map.mjs`; no live tile provider, no fallback/switcher/reload), Serwist (`@serwist/next`, webpack path) | **Vercel** (founder decision, 2026-11-17) — `vercel.app` subdomain via GitHub; `vercel.json` at the repo root; see §8. |
| API + realtime | `workers/` — one Worker + one Durable Object class per room | Cloudflare Workers + Durable Objects |
| Database | `supabase/migrations/` 0001, 0003, 0004, canonical schema, 10 tables | Supabase Postgres (region: **Mumbai** — founder decision, 2026-11-17; see §5) |

Canonical schema tables (`0001_init.sql`): `profiles`, `players`, `rooms`,
`room_events`, `catches`, `safety_events`, `bug_reports`, `grievances`,
`audit_log`, `telemetry_daily`. No table stores raw coordinates, ever
(HNT-068). Location fixes live only in Durable Object active-room state
and are purged at match end / TTL.

**Location rule (founder decision, 2026-11-17 — see `docs/DECISIONS.md`).**
Location sharing is DEFAULT, as ShadowHunt + SCRAM do it: it runs while
a round is running (foreground, while using the app); pings go out on
the host's ping schedule; own team sees each other live; the other team
only via pings; Runners never see Hunters. No custom cadence (no 10 s
runner rule, no ping-only rule — both were proposed and explicitly
rejected). A manual "Refresh my location" button on the Runner's play
screen sends one fresh fix. The phone checks the zone locally — only an
outside-zone crossing sends one alert, which starts the 30-second
return countdown (first-seen-outside). Cost is usage-based on the
Cloudflare free tier — the founder manages cost/errors himself; no
custom cost maths is claimed in this runbook. A delivered ping stays on
the hunter's map until the next ping replaces it (never removed on a
timer); Show ping history ON keeps earlier pings visible (dimmer), OFF
shows only the latest.

API contract (frozen, `docs/API.md`): base `/v1`, all requests carry
`v: 1`. REST: `POST /v1/rooms`, `GET /v1/rooms/{id}`,
`POST /v1/rooms/{id}/join`, `POST /v1/rooms/{id}/ws-ticket`,
`POST /v1/rooms/{id}/ws-ticket/revoke`, `POST /v1/rooms/{id}/lifecycle`,
`POST /v1/rooms/{id}/catches`, `POST /v1/rooms/{id}/catches/{cid}/confirm`,
`POST /v1/rooms/{id}/catches/{cid}/dispute`, `POST /v1/rooms/{id}/safety/sos`,
`POST /v1/rooms/{id}/leave`, `POST /v1/reports`,
`POST /v1/support/bugs`, `POST /v1/support/grievances`,
`GET /v1/rooms/{id}/results`. **Implemented in the Worker today:**
`POST /v1/rooms`, `GET /v1/rooms/{id}`, `POST .../join`,
`POST .../ws-ticket`, `POST .../ws-ticket/revoke`,
`POST /v1/rooms/{id}/start` (host only — the match start),
`POST .../config` (host changes lobby settings),
`POST .../remove-player` (host removes a lobby player),
`POST .../regenerate-code`, `POST .../catch-token`,
`POST .../lifecycle` (pause/resume/end), `POST .../host/token`,
`POST .../host/transfer`, `POST .../catches/{cid}/resolve`,
`GET .../results`, `POST /v1/reports`, `POST /v1/support/bugs`,
`POST /v1/support/grievances`, and the WS upgrade.
**NOT implemented as REST:** `/catches*` (except resolve),
`/safety/sos`, `/leave` — catches, safety pause/resume/SOS and leave
exist only as WebSocket messages (`docs/API.md` §3.3). Do not
smoke-test a REST endpoint from this list until its implementation
lands. WebSocket:
`wss://<api-host>/v1/rooms/{id}/ws?ticket=<ticket>` — ticket in the
handshake query string only, single-use, consumed on upgrade;
`hello` carries no credential.

## 2. Environment variables — NAMES ONLY, no values

Names come from the repo-root `.env.example` (commented out, no values)
plus two names read by code. **Three of them ARE read by code today:**
`NEXT_PUBLIC_SITE_URL` (layout + sitemap), `NEXT_PUBLIC_WORKER_URL`
(`apps/web/src/lib/websocket.ts` — `getWorkerUrl()` /
`createLivePakdamSocket()`, called by the lobby, play, catch and
results pages), and
`NEXT_PUBLIC_SENTRY_DSN` (`apps/web/sentry.*.config.ts` — guarded
`Sentry.init`; inert until the DSN is set). The Supabase names are
still unread by the web app — setting them changes nothing until a
web Supabase path exists; the WORKER reads `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` from its bindings. Set them anyway at
deploy time so the wiring work has them to read; verify each one is
actually read before claiming it is live.

| Name | Where it is set | Read by code today? | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Web host env (build-time, public) | No | Supabase project URL. From `.env.example`. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Web host env (build-time, public) | No | Anon/public key only. Never the service-role key. From `.env.example`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker secret only (`wrangler secret put`, §7) — **never** in the web app, never `NEXT_PUBLIC_`, never committed | No | Bypasses RLS; all DB writes go through it via the Worker/DO. From `.env.example`. |
| `NEXT_PUBLIC_WORKER_URL` | Web host env (build-time, public) | **Yes** — `apps/web/src/lib/websocket.ts` (`getWorkerUrl()` / `createLivePakdamSocket()`), called by the lobby, play, catch and results pages | Deployed Worker base URL (no trailing slash), e.g. `https://pakdam.<subdomain>.workers.dev`. From `.env.example`. Replaces the old `WORKERS_API_URL` name, which no code reads. |
| `MAP_TILE_URL` | — | No — DEAD | Legacy tile-provider URL, removed from `.env.example` 2026-11-18. Superseded by the BUNDLED offline map (founder decision 2026-11-17: no live tile provider). Nothing reads this variable. Do not set it. |
| `NEXT_PUBLIC_SENTRY_DSN` | Web host env (build-time, public) | **Yes** — `apps/web/sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts` (`Sentry.init` guarded on the DSN; `tracesSampleRate: 0`, `sendDefaultPii: false`; `@sentry/nextjs` 10.78.0 installed 2026-11-17; `next.config.ts` wrapped with `withSentryConfig` outside the Serwist wrap). No DSN exists yet — the founder creates it in Sentry (see `docs/SENTRY-SETUP.md` §1). Until set, Sentry stays inactive. Privacy: never attach coordinates, player names, room codes/IDs, or tokens to a Sentry event. | Founder's Sentry DSN (free allowance) — name only in `.env.example`. **Never commit a value.** |
| `NEXT_PUBLIC_SITE_URL` | Web host env (build-time) | **Yes** — `apps/web/src/app/layout.tsx` (`metadataBase`) and `apps/web/src/app/sitemap.ts` | Canonical site URL. Code default is `https://pakdam.example` — a **placeholder, not a real domain**. Must be replaced with the real deployed URL. |
| `ENVIRONMENT` | `workers/wrangler.toml` `[vars]` — currently `"dev"` | Yes (as a Worker var) | Change to the production value only by a deliberate wrangler.toml edit + review. There is **no separate production environment** in `wrangler.toml` today (see §6). |
| `NODE_ENV` | Set by Next.js / runtime, not by hand | Yes — `apps/web/next.config.ts` disables Serwist when `NODE_ENV === 'development'` | Production build must run with `NODE_ENV=production` (Next.js default for `next build` / `next start`). |

Cloudflare / Supabase **account credentials** (not app env vars, not in
the repo): a Cloudflare account + API token with Workers / Durable
Objects permissions (per `docs/STATUS.md`), and a Supabase project
(URL + anon key + service-role key, plus project ref + database password
for the CLI). The standard Wrangler credential env var is
`CLOUDFLARE_API_TOKEN` — **TO VERIFY** in this environment (see §10);
prefer `wrangler login` (interactive OAuth) for a first deploy and do
not paste any token into chat, files, or this runbook.

Rules, no exceptions:

- Never commit a real `.env`. The repo has `.env.example` (names only)
  and no `.env` files. Keep it that way.
- Never put a secret in a URL, a log line, a ticket value log, or a
  screenshot. WS ticket *values* are never logged — only `ticketId`
  (`workers/src/auth.ts`, `WsTicketStore.logRef`).
- Never put raw coordinates in logs, payloads, or any table.

## 3. Blockers — a real deployment cannot happen until these close

Named exactly. None of these is closed by this runbook.

| # | Blocker | Owner / decider |
|---|---|---|
| B1 | No Cloudflare account, no API token with Workers / Durable Objects permissions | Founder |
| B2 | No Supabase project (no project URL, anon key, service-role key, project ref, DB password) | Founder |
| B3 | ~~No production tile provider selected or keyed (M00 decision; demo CARTO is demo-only)~~ — DECIDED 2026-11-17 (founder, offline map): the map is **ONE bundled offline map** — MapLibre GL JS + OpenFreeMap vector tiles z10–z14 for Doranda + Hinoo, Ranchi, downloaded by `apps/web/scripts/download-offline-map.mjs` into `apps/web/public/offline-map/`. No live tile provider, no fallback, no switcher, no reload. Google Maps is CANCELLED — no Google/Mapbox/MapTiler. CARTO is dropped (API-key watermark on keyless tiles since 26 Aug 2026). CLOSED as a decision; live verification of tile painting is a Playwright check on the final build. The full live map service is a SEPARATE later task. | Founder |
| B4 | ~~No web host chosen and no domain~~ — CLOSED 2026-11-17 (founder decision): web host is Vercel (`vercel.app` subdomain via GitHub, `vercel.json` at the repo root, §8). The domain is the Vercel-assigned subdomain until the founder chooses otherwise; the code default `https://pakdam.example` is still a placeholder and must be replaced with the real URL in Vercel env. | Founder |
| D1 | **Auth method OPEN (OD-022).** Supabase Auth is the pilot *candidate*; the method by which a host or guest obtains a JWT (magic link, OTP, password, or other) is undecided. Guest seats have `players.profile_id NULL` and therefore can satisfy **no** RLS policy as written. | API/auth mission + founder |
| D2 | **Migration `0002_rls.sql` must not be applied live** until D1 closes and a guest identity path exists. See §5. The file was MOVED to `supabase/migrations-deferred/` (founder decision 2026-11-17) so a plain `db push` cannot apply it. | API/auth mission |
| D3 | ~~Supabase region not decided~~ — CLOSED 2026-11-17 (founder decision): region is Mumbai (data residency). `supabase/config.toml` still sets only local `[db] port = 54322` and records no region — the region is chosen at project creation in the Supabase dashboard, not in this file. | Founder (ADR-002) |
| D4 | Architecture ADRs not approved. `workers/wrangler.toml` header: "leading candidate — ADR-001, NOT approved. Deploy ONLY after founder approves the M00 report + architecture." Same for Supabase/ADR-002. | Founder (M00) |
| D5 | ~~Web → Worker and Worker → Supabase wiring does not exist in code~~ — CLOSED 2026-11-17/18 (wiring mission): pages call `createLivePakdamSocket()` and the Worker has a Supabase client (`workers/src/supabase.ts`). What is still missing is the DEPLOYMENT + live proof (two-phone field test). | Founder (deploy) |
| D6 | Calibration values are placeholders labelled `OPEN — TO BE MEASURED` (`packages/shared/src/calibration.ts`): GPS tiers, catch distance, ping schedule, grace, catch-token TTL, rate limits. No threshold in the repo is a measured fact. Do not deploy a public pilot on placeholder calibration. | M00 / field measurement |
| D7 | Legal: trademark **not cleared** (Pakdam name + red brand are provisional; IP India search + lawyer opinion required before public use); legal classification / Indian Gaming Act / DPDP / CERT-In gates per the low-cost stack doc are not cleared in this repo. | Founder / lawyer |
| D8 | No pen test, no alerting/monitoring decision, no backup/restore decision for Supabase. | Founder |

## 4. Pre-flight checklist (do all of this, in order, before any deploy)

Run from the repo root `pakdam-app/`. All commands below are repo
scripts from the root `package.json` / `workers/package.json` /
`apps/web/package.json` — they are the project's own commands, not
invented ones. Node `>= 20` is required (`package.json` `engines`).

```bash
cd pakdam-app
pnpm install --frozen-lockfile
npm run typecheck   # shared + engine + workers + web, all must pass
npm test            # builds shared/engine/workers, runs engine + workers unit tests
npm run build       # shared + engine + workers + web production builds
npm run lint        # eslint .
```

Local smoke (baseline recorded in `docs/STATUS.md`: typecheck clean,
production build succeeds — 22 pages — smoke test 20/20 routes
HTTP 200):

```bash
npm run dev --workspace=apps/web   # http://localhost:3000
```

Play the local demo end to end on one device: Create a game → share
the room code → Join as a guest (same device / second tab) → Ready →
Countdown → Head start → Active. Keep the tab visible and the screen
on — location stops when the tab is hidden or the phone locks (Phase 0
foreground-only limitation, not a bug).

**Do not proceed to deploy if any of the above fails.** Fix it in the
repo first; a deploy never fixes a failing build or test.

### Config checks (verify the files say what this runbook assumes)

`workers/wrangler.toml` — verify before deploy:

```toml
name = "pakdam"
main = "src/index.ts"
compatibility_date = "2026-11-01"
compatibility_flags = ["nodejs_compat"]
[durable_objects]
bindings = [{ name = "ROOM_DO", class_name = "RoomDurableObject" }]
[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomDurableObject"]
[vars]
ENVIRONMENT = "dev"
```

Checklist: Worker name is `pakdam`; entry is `src/index.ts`; the DO
binding name is `ROOM_DO` and the class is `RoomDurableObject`
(the class lives in `workers/src/room-do-class.ts` and is re-exported
from the entrypoint `workers/src/index.ts` — wrangler requires the
class exported from the entrypoint; the `ROOM_DO_CLASS` string
constant in `workers/src/room-do.ts` is the name only and must NOT be
exported from the entrypoint, or workerd rejects the module); the
migration tag is `v1` with `new_sqlite_classes = ["RoomDurableObject"]`;
`ENVIRONMENT` is `"dev"`. If any value differs, stop — the deploy
target has drifted from this runbook and the runbook must be updated
first. There is no `[env.production]` (or any other named environment)
in this file: a production deploy today would deploy the same file with
`ENVIRONMENT = "dev"` unless someone edits it — that edit is a
deliberate decision, not a deploy-time accident (see §7).

`supabase/config.toml` — verify before deploy:

```toml
[db]
port = 54322
```

That is the entire file. It configures the **local** Supabase database
port only. It contains no project ref, no region, no credentials.
Do not read a region or a project into it — region is blocker D3.

`.env.example` (repo root) — verify it still lists only names, all
commented out, no values:

```text
# NEXT_PUBLIC_SUPABASE_URL=
# NEXT_PUBLIC_SUPABASE_ANON_KEY=
# NEXT_PUBLIC_SITE_URL=
# NEXT_PUBLIC_WORKER_URL=
# SUPABASE_SERVICE_ROLE_KEY=
# (MAP_TILE_URL removed 2026-11-18 — dead name, nothing reads it.)
```

If any value has appeared in it, remove it and rotate the credential —
it must never have been committed with a value.

## 5. Supabase — migration order

Migrations live in `supabase/migrations/`. Apply **in filename order**.
There are no down migrations in the repo — see §9 for what that means
for rollback.

| Order | File | What it does | Apply? |
|---|---|---|---|
| 1 | `0001_init.sql` | Creates the 10 canonical tables (`profiles`, `players`, `rooms`, `room_events`, `catches`, `safety_events`, `bug_reports`, `grievances`, `audit_log`, `telemetry_daily`); `pgcrypto` extension; no raw coordinates | **Yes** — first migration on a fresh project |
| — | `0002_rls.sql` | Enables RLS + fail-closed policies keyed to `auth.uid() = profiles.profile_id`; no INSERT/UPDATE/DELETE policy for anon/authenticated; all writes via service role | **NO — DO NOT APPLY LIVE. MOVED to `supabase/migrations-deferred/`** (founder decision 2026-11-17) so a plain `db push` cannot apply it. See below. |
| 2 | `0003_indexes.sql` | Indexes: `rooms(room_code)`, `room_events(room_id, seq)`, `players(room_id)`, `catches(room_id, state)`, `audit_log(created_at)`, `grievances(status)` | **Yes** — after 0001 |
| 3 | `0004_postgis.sql` | PostGIS extension; `restricted_areas` geography table; `zone_polygon` / `point_in_zone` / `point_in_restricted_area` functions; trigger rejecting raw-coordinate event payloads (HNT-068) | **Yes** — after 0003. **NOT yet applied or syntax-checked against a live Postgres** — verify on first apply. |

**Why 0002 is held — and why it was moved.** Quoted from the file header: the policies assume
Supabase Auth issues JWTs and a seat's `profile_id` is the JWT subject,
but the method is OPEN (OD-022), and guest seats have
`players.profile_id NULL`, so guests "can NEVER satisfy any policy
below" and "have no working participant read path through RLS at all."
Applying it now is fail-closed and safe, but it is not a working
participant read path. The API/auth mission must close OD-022 first
(define a guest identity path — e.g. a guest profile created at join,
or a signed seat claim), then apply this file and verify it against a
live database. The file was also **not syntax-checked against a live
Postgres** (no psql in the build environment) — validate before
applying, do not apply on the basis of the file alone.

### Supabase steps (standard Supabase CLI — TO VERIFY, see §10)

```bash
supabase login                                  # TO VERIFY — interactive, creates no project
supabase link --project-ref <project-ref>       # TO VERIFY — <project-ref> from the Supabase dashboard, never invented
supabase db push --dry-run                      # TO VERIFY — validates 0001 + 0003 + 0004 WITHOUT applying
supabase db push                                # TO VERIFY — applies pending migrations in order
```

Rules:

- Run `--dry-run` first and read its output. If it reports an error,
  stop and fix the migration in the repo; never force-push past it.
- `supabase db push` applies **all** pending migrations in order —
  which is now exactly the deploy set (0001, 0003, 0004), because
  0002 was moved out of `supabase/migrations/` into
  `supabase/migrations-deferred/` (founder decision 2026-11-17). A
  plain push can no longer apply 0002 by accident. Still verify the
  push output lists ONLY 0001, 0003 and 0004 before confirming.
  (The old selective-apply problem is gone; the dashboard SQL-editor
  alternative below is no longer needed.)
- After applying, verify in the dashboard / `psql`: all 10 tables
  exist; `rooms.room_code` is unique; no RLS is enabled yet on a
  pre-auth database (because 0002 was held, tables are readable only
  through the service role — confirm no client key can read them
  directly, and confirm the anon key cannot write).
- Local alternative (development only, no cloud project needed):
  `supabase start` — **TO VERIFY** — starts local Postgres on port
  54322 per `supabase/config.toml`. Use it to syntax-check the
  migrations before any cloud apply.

## 6. Cloudflare Workers / Durable Object — deploy steps

> Standalone version of this section: `docs/CLOUDFLARE-SETUP.md`
> (account, wrangler, deploy, check it worked, troubleshooting,
> rollback). The runbook keeps the short version here; the standalone
> file is the one the founder follows.

Prerequisites: blocker B1 closed (Cloudflare account + token with
Workers / Durable Objects permissions) and D4 (M00 + architecture
approved). Pre-flight §4 green.

```bash
cd pakdam-app/workers
npm run build        # tsc -p tsconfig.json — must pass; output in workers/dist/
npm test             # node --test dist/test/*.test.js — Worker unit tests, must pass
wrangler login       # TO VERIFY — interactive OAuth; do this once per machine, never paste a token into a file
wrangler deploy      # TO VERIFY — repo script is `npm run deploy` (wrangler deploy); deploys workers/wrangler.toml
```

What `wrangler deploy` does with this repo:

- Deploys Worker `pakdam` (`main = "src/index.ts"`).
- Creates/updates the Durable Object class `RoomDurableObject` under
  migration tag `v1` (`new_sqlite_classes`). This is the **first**
  DO migration: it creates the class. Later DO schema changes need a
  new migration tag — do not edit tag `v1` in place after a deploy.
- Sets the plain var `ENVIRONMENT = "dev"` from `[vars]`. It does
  **not** set any secret. Secrets are separate (§7).
- Prints the deployed Worker URL (a `*.workers.dev` subdomain unless
  a custom domain/route is configured — none is configured in this
  repo). **Record that URL.** It becomes the value of
  `NEXT_PUBLIC_WORKER_URL` for the web app, and `<api-host>` in every smoke
  URL in §8. Do not invent it in advance; it does not exist until
  deploy succeeds.

Expected result today: deploy succeeds, and the Worker answers with
its real statuses — unknown paths **404**, `GET /v1/rooms/abc`
**400** (`playerId` required), `POST /v1/rooms` with an empty body
**400** (`invalid request`). That proves the pipeline; it does not
prove the API is live end to end — the web app is not wired to the
Worker yet and the Worker never talks to Postgres. If you get a
Cloudflare error page instead of a JSON error, stop and check you
deployed this repo's Worker and not something else.

### Local Worker check (before deploy)

```bash
cd pakdam-app/workers
npm run dev          # wrangler dev — local Worker + DO
```

**VERIFIED 2026-11-17 (wrangler 4.163.0):** `wrangler dev` starts,
lists the bindings (`env.ROOM_DO (RoomDurableObject) Durable Object
local`, `env.ENVIRONMENT ("dev")`), prints `Ready on
http://localhost:8787`. Two real gaps were found and fixed during this
verification (the DO class did not exist at all, and the entrypoint
exported the `ROOM_DO_CLASS` string, which workerd rejects) — see
`workers/src/room-do-class.ts` and `workers/src/index.ts`.
**Correction 2026-11-17:** the entrypoint has since been implemented —
it is no longer a 501 skeleton, and the DO class is a full
implementation (WS fan-out, alarms, catch tokens), not a shell. The
local check below now expects **404** for an unknown path and **400**
for `GET /v1/rooms/abc` (no `playerId`). The WS session lifecycle
still needs the API mission's wiring (web → Worker, blocker D5).

Use it to confirm the Worker starts and routes locally before
spending a cloud deploy on it.

```bash
curl -i http://localhost:8787/no-such-path
# Expect: HTTP 404, body {"error":"not found"}
curl -i http://localhost:8787/v1/rooms/abc
# Expect: HTTP 400, body {"error":"playerId query parameter is required"}
```

## 7. Secrets — set, never commit

Set each secret with the Wrangler CLI from the `workers/` directory.
Commands are standard Wrangler — **TO VERIFY** (see §10). Values are
entered interactively / piped by the operator; they never appear in
this file, in the repo, or in chat.

```bash
cd pakdam-app/workers
wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # TO VERIFY
```

- `SUPABASE_SERVICE_ROLE_KEY` is the only Worker secret this repo
  names. It is server-side only. It is **not** read by any code today
  (§2) — setting it is preparation for the wiring in D5, not a live
  integration.
- Do **not** set `NEXT_PUBLIC_SUPABASE_ANON_KEY` or
  `NEXT_PUBLIC_SUPABASE_URL` as Worker secrets — they are public
  web-app values and belong in the web host's env, not in the Worker.
- `ENVIRONMENT` is a plain `[vars]` value in `wrangler.toml`, not a
  secret. To run production, change it by editing the file (reviewed,
  committed) — and add a named `[env.production]` only as a reviewed
  repo change, never as an unrecorded deploy-time override.
- Rotate a secret immediately if it is ever pasted, logged, committed,
  or shown on screen. There is no secret-rotation procedure in this
  repo beyond that rule.

## 8. Web PWA — Vercel via GitHub (founder decision, 2026-11-17)

Vercel hosts the website. It does **not** replace the game server —
the live game server is still Cloudflare Workers + Durable Object
(§6, `docs/CLOUDFLARE-SETUP.md`). The founder creates the GitHub repo
and connects Vercel himself; no agent creates either. Free tiers first
(Vercel Hobby free, Supabase Free, Workers Free); paid triggers at the
external pilot (Workers Paid $5 + Supabase Pro $25).

`vercel.json` at the repo root (read by Vercel on import):

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm run build",
  "outputDirectory": "apps/web/.next"
}
```

`pnpm run build` is the root script: it builds shared → engine →
workers → web in order. The web app resolves `@pakdam/shared` /
`@pakdam/engine` from their built `dist/`, so the shared/engine build
must run before `next build` — the root script guarantees that. Do not
point Vercel at `apps/web` as the Root Directory with a bare `next
build`: the package builds would be skipped and the build would fail
on the missing `dist/` files.

### Founder checklist (do in order)

1. **GitHub repo.** Create a repo and push this folder (`pakdam-app/`)
   as the repo root. Do not commit `node_modules/`, `.next/`,
   `dist/` or any `.env` — `.gitignore` already excludes them.
   Verify with `git status` that no `.env` file is listed.
2. **Vercel connect.** In Vercel: **Import Project** → pick the repo.
   Root Directory: the repo root (the default). Framework: leave the
   auto-detected setting alone — `vercel.json` supplies the install /
   build / output commands above.
3. **Environment variables (Vercel dashboard, names only — no values
   in this repo).** `NEXT_PUBLIC_SITE_URL` = your real `*.vercel.app`
   URL — **required**: the build refuses the
   `https://pakdam.example` placeholder unless
   `PAKDAM_ALLOW_PLACEHOLDER_URL=1` is set, which is dev/CI-only and
   must NEVER be set in a real deploy. Also set
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `NEXT_PUBLIC_WORKER_URL` (= the deployed Worker URL from §6, once it
   exists — this is what switches the web app from the demo loop to
   the live Worker transport; the pages are wired to it, so setting it
   makes the game live). Do NOT set `WORKERS_API_URL` or `MAP_TILE_URL`
   — both are dead names no code reads. The Supabase names are still
   unread by the web app (§2) — set them anyway so the wiring work
   has them to read.
4. **Deploy.** Trigger the first deploy from Vercel. The build log
   must show the shared → engine → workers → web builds succeeding.
   If it fails, fix it in the repo first — a deploy never fixes a
   failing build.
5. **Smoke test.** Run the route list below against the deployed URL
   (replace `<web-host>` with the real `*.vercel.app` URL). All routes
   must return HTTP 200. Then play the local demo end to end on one
   device (Create → share the room code → Join as a guest → Ready →
   Countdown → Head start → Active) and confirm the PWA installs
   (service worker `public/sw.js` served, built by Serwist).

### Local build + serve (before any deploy)

```bash
cd pakdam-app
pnpm --filter apps/web build    # next build; Serwist enabled (NODE_ENV=production)
pnpm --filter apps/web start    # next start — serves the production build locally
```

### Post-deploy verification (smoke)

Replace `<web-host>` with the real deployed web URL and `<api-host>`
with the deployed Worker URL from §6. Both are unknown until deploy —
**there is no real domain in this repo to write here**.

Web routes (all must return HTTP 200; page count as printed by the
build log):

```text
<web-host>/                     <web-host>/create
<web-host>/join/<code>          <web-host>/room/<roomId>
<web-host>/host                 <web-host>/admin
<web-host>/grievance            <web-host>/safety
<web-host>/help                 <web-host>/legal
<web-host>/how-it-works         <web-host>/game-modes
<web-host>/about                <web-host>/contact
<web-host>/faq                  <web-host>/accessibility
<web-host>/profile              <web-host>/install
```

Also verify: PWA installs (service worker `public/sw.js` served,
built by Serwist from `src/app/sw.ts`); the app works with the screen
on and location permission granted; hiding the tab / locking the phone
suspends location (expected Phase 0 behaviour — verify it is visible
to the player, not silent).

API smoke (against `<api-host>`; Worker routes are implemented in
code — see §6 — and the web app is wired to them; Supabase
persistence exists in the Worker as a best-effort client):

```text
GET  <api-host>/no-such-path               -> 404 {"error":"not found"}
GET  <api-host>/v1/rooms/<id>              -> 400 without ?playerId=<seat-id>; 404 for an unknown room; 200 + recipient-specific view for a real seat
POST <api-host>/v1/rooms                   -> 400 with an empty/invalid body; 201 + roomId/roomCode with a valid room config (docs/API.md)
POST <api-host>/v1/rooms/<id>/join         -> 403 with a wrong room code; 200 + seat + reconnect token with the right code
POST <api-host>/v1/rooms/<id>/start        -> 403 for a non-host seat; 409 until 3+ Ready players; 200 + HEAD_START once the start rules pass
POST <api-host>/v1/rooms/<id>/ws-ticket    -> 403 with a wrong reconnect token; 200 + ticket with the right one
WS   wss://<api-host>/v1/rooms/<id>/ws?ticket=<ticket>
                                            -> valid ticket -> welcome + snapshot; reused ticket -> TICKET_REUSED / close 4401;
                                               wrong room/seat -> TICKET_INVALID; past TTL -> TICKET_EXPIRED
```

Do **not** mark API smoke as passing on a 404/400. A 404/400 means
"deployed and routing" — the endpoints answer, but no live game has
been played through them yet. The API smoke passes only when the
endpoints in `docs/API.md` return the documented shapes with real
room IDs, driven by two real devices (see the end-to-end check
below).

Database smoke (after §5): 10 tables exist; insert a test room row
via the service role only and confirm the anon key cannot read or
write it directly; confirm `room_events` accepts an event row and
`idx_room_events_room_seq` is present; delete the test row and confirm
no test data remains. Never insert real player data as a smoke test,
and never store coordinates in any smoke row.

End-to-end check (only after D5 wiring lands): two devices, host
creates a room on one, guest joins by code on the other, both Ready,
countdown → head start → Active, a Hunter catch request confirmed by
the Runner, SOS from a player reaches the host, leave stops location
sharing immediately. If any step needs the demo local engine, the
check has not tested the deployment — say so.

## 9. Rollback

There is **no automated rollback tested in this repo**. The procedures
below are the honest minimum; the first real deploy should rehearse
the Worker rollback before any public pilot.

**Worker (Cloudflare).** Standard Wrangler — **TO VERIFY** (see §10):

```bash
cd pakdam-app/workers
wrangler deployments list    # TO VERIFY — find the previous good deployment id
wrangler rollback            # TO VERIFY — rolls back to the previous deployment; confirm the exact flags in the installed CLI's help
```

If rollback is unavailable or fails, redeploy the previous known-good
commit: check out that commit, run §4 pre-flight, then `wrangler
deploy`. Keep the deployed commit hash recorded with every deploy
(see §10's deploy log) so "previous good" is a fact, not a guess.
Durable Object caveat: the `v1` migration tag creates the
`RoomDurableObject` class; rolling back the Worker does **not** undo a
DO class migration, and in-flight room state in a DO is not restored
by a Worker rollback. Active rooms at rollback time should be treated
as lost — end them cleanly and have players re-create rooms.

**Web.** Redeploy the previous known-good build from the host (or
`npm run start` the previous build locally). There is no web rollback
script in this repo.

**Supabase.** There are **no down migrations** in the repo. Rolling
back 0001 or 0003 means either restoring the project from a Supabase
backup / point-in-time recovery (a Supabase dashboard operation —
confirm availability on the project's plan before you need it) or
writing and reviewing manual `DROP` SQL. Never hand-write a drop
against production without a backup first. Rolling back 0002 is not
applicable — it must never have been applied live (see §5); the file
lives in `supabase/migrations-deferred/`, not in the deploy set.

**When to roll back.** Any of: deploy fails part-way; smoke §8 fails
on the web host; the Worker returns a Cloudflare error page instead
of a JSON error, or anything other than the documented API shapes
once the web → Worker wiring lands; the database smoke shows tables
missing, RLS unexpectedly enabled, or the anon key able to read/write;
any secret appears in a log or output (rotate the secret first, then
roll back).

**After a rollback:** re-run §8 smoke against the rolled-back
deployment, confirm the previous good behaviour is actually back,
and record the incident (what broke, which deployment, which commit)
before attempting another deploy.

## 10. TO VERIFY (not verified in this environment)

These are standard CLI commands / facts this runbook relies on but
which were **not** run to completion while writing it. Do not present
them as verified until someone runs them and records the result here.

- `wrangler --version` — **VERIFIED 2026-11-17: 4.163.0**, installed
  as a devDependency of `workers/package.json` (so the repo's own
  `npm run dev` / `npm run deploy` scripts in `workers/` work).
  `supabase --version` — CLI availability and version on the deploy
  machine are unconfirmed.
- `wrangler login`, `wrangler deploy`,
  `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`,
  `wrangler deployments list`, `wrangler rollback` — standard
  Wrangler commands; `wrangler deploy` is also the repo's own
  `workers/package.json` script (`deploy`), which grounds the command
  name, but no deploy or login was performed. `wrangler dev` —
  **VERIFIED 2026-11-17** (see §6): starts, bindings register; the
  local Worker routes (404 unknown path, 400 for
  `GET /v1/rooms/abc` without `playerId`) — corrected 2026-11-17,
  the old "501 skeleton" line was stale.
- `CLOUDFLARE_API_TOKEN` as the Wrangler credential env var — standard
  Wrangler behaviour, not named anywhere in this repo; confirm against
  the installed Wrangler's help before relying on it.
- `supabase login`, `supabase link --project-ref <project-ref>`,
  `supabase db push`, `supabase db push --dry-run`, `supabase start` —
  standard Supabase CLI commands; `--dry-run` is recommended in §5,
  but no Supabase CLI run was performed.
- Selective application of migrations 0001 + 0003 while holding 0002:
  no selective-apply command is recorded in this repo — confirm the
  exact supported mechanism in the installed Supabase CLI (or use the
  dashboard SQL editor, one file at a time, in order) and record it
  here.
- The deployed Worker URL / `*.workers.dev` subdomain shape — unknown
  until the first `wrangler deploy` succeeds.
- Supabase backup / point-in-time recovery availability on the chosen
  plan — confirm in the dashboard before the first production deploy.
- The web host's deploy flow — Vercel flow is documented in §8
  (blocker B4 closed 2026-11-17); no real Vercel deploy has been
  performed yet.

## 11. Deploy log (fill in per deploy — keep this file honest)

Copy this block per deploy. If a field is unknown, write UNKNOWN —
never invent it.

```text
Date/time (IST):
Deployer:
Repo commit hash:
Pre-flight §4 (typecheck/test/build/lint): pass / FAIL (which step)
Supabase project ref:            (or: none — local only)
Migrations applied: 0001 / 0003 / 0004 (0002 HELD — reason: OD-022 open; file lives in supabase/migrations-deferred/, not in the deploy set)
Worker URL (<api-host>):
Web URL (<web-host>):
Secrets set: SUPABASE_SERVICE_ROLE_KEY (date, by whom — no values)
Smoke §8 result: web routes __/18, API ___, DB ___
Known deviations from this runbook:
Rollback rehearsed: yes / no
```

## 12. What this runbook deliberately does not contain

- No credentials, tokens, keys, URLs, or domains — none exist, none
  are invented. `https://pakdam.example` is the code's placeholder
  default, not a deployment target.
- No deployment was performed while writing this file, no account was
  created, no `wrangler login` / `supabase login` was run.
- No thresholds: GPS accuracy tiers, catch distance, ping schedule,
  grace, catch-token TTL, and rate limits are OPEN placeholders
  (D6) — this runbook sets none of them.
- No copied text from Pack v2 or any other document beyond short
  factual references (file names, table names, route paths) needed to
  make the commands exact.
