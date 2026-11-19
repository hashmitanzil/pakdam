# Pakdam

Pakdam is a real-world GPS hide-and-seek game played on phones in a city
neighbourhood. One host creates a room, players join with a 6-letter code,
teams are assigned at start, and the match runs on a live map against a clock
inside a shrinking play zone. Two modes only — **Classic** and **Infection** —
for 3–30 players (minimum 3 to start).

Free, guest-only, no accounts, no payment, no paywall. Private invite-only,
join by code. There is no public lobby, no leaderboard, no points store — the
match, its catches and its result are the whole product.

## Stack

- **Web:** Next.js 15.5 PWA on Vercel (`apps/web`) — SCRAM base + ShadowHunt
  minimalism, Pakdam red, single dark theme. Ola Maps dark vector style
  (`default-dark-standard`) via MapLibre GL JS.
- **Live backend:** Cloudflare Worker + one Durable Object per room
  (`workers/`) — the DO is the sole authority for presence, match state,
  timers, teams, pings, catches, zone transitions and completion.
- **Shared code:** `packages/shared` (frozen wire protocol v2.1, types,
  validation) and `packages/engine` (pure game rules: state machine, roles,
  zone/shrink, pings, catches, scoring, suspension).
- **Durable records:** Supabase (Mumbai) + PostGIS (`supabase/migrations/`) —
  the Worker talks to it over plain `fetch` to PostgREST, no client SDK.
  Persistence is best-effort by design: a failed insert never fails a game
  request. The web app never reads Supabase directly.

## Behaviour

The short behaviour spec is `pakdam-fresh/BEHAVIOUR.md` — read it first.
The full protocol reference (payloads, validation, DO ops, calibration) is
`../pakdam-scram-rebuild/PROTOCOL-MAP.md`; the frontend design spec is
`../pakdam-scram-rebuild/SCRAM-SPEC.md`. Where they disagree, the decided
Pakdam rule in `BEHAVIOUR.md` wins.

Key rules, built in from the start (do not defer any of these):

- DO-owned WS ticket registry — tickets validated/redeemed by the room's DO,
  never per-isolate Worker memory. Sticky routing is not viable on Workers.
- Resume a suspended player on hello/reconnect; a suspended Runner must be
  able to confirm a catch.
- Catch flow: tag → QR → Runner confirms → manual fallback, **no catch code**.
  Catch token ≥ 128 bits entropy, hash `sha256(catchId + ':' + raw)`.
- Readiness gate: active seats ≥ 3 **and** every active seat ready.
- Random next zone per shrink, never concentric.
- Pings stay until the next ping, with age shown.
- Team-only voice radio (WebRTC P2P, free public STUN only, no TURN, no
  recording) + team-only text radio (≤ 140 chars, last 50, ephemeral).
- Heartbeat actually configured — real interval + missed limit, both sides.
- Per-route HTTP rate limiting on every route.
- Snapshot privacy: no raw coordinates, no pending pings, no token hashes;
  a seat sees its own role only.
- CSP / HSTS headers on the Worker.
- Demo parity: demo pings auto-fire on schedule; demo shrink uses the
  random-offset draw; demo SOS says plainly it notifies nobody.

## Install

```sh
pnpm install
cp .env.example .env.local   # fill in real values; never commit .env.local
```

Requires Node.js 22 and pnpm 12.21.0 (`packageManager` is pinned in
`package.json`; `corepack enable` picks it up).

## Develop

```sh
pnpm dev        # web app (apps/web) on http://localhost:3000
```

With `NEXT_PUBLIC_WORKER_URL` unset the app runs in local demo mode (offline
fallback). Set it to the Worker URL for live mode (Worker + DO); a live room
is never silently downgraded to demo mid-room.

## Test / typecheck / lint / build

```sh
pnpm typecheck   # strict TypeScript across all workspaces
pnpm lint        # flat ESLint config (eslint.config.mjs)
pnpm test        # unit tests across all workspaces
pnpm build       # production build of every workspace
```

CI (`.github/workflows/ci.yml`) runs install → typecheck → lint → unit tests
→ production build on every push to `main` and every pull request.

## Deploy

- **Web (Vercel):** `vercel.json` points at `apps/web`; region `bom1`
  (Mumbai). Build-time env: `NEXT_PUBLIC_WORKER_URL`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_OLA_MAPS_API_KEY`.
- **Worker (Cloudflare):** `wrangler deploy` from `workers/` (name `pakdam`,
  DO binding `ROOM_DO`). `SUPABASE_URL` is a plain `[vars]` value in
  `wrangler.toml`; `SUPABASE_SERVICE_ROLE_KEY` is a secret
  (`wrangler secret put SUPABASE_SERVICE_ROLE_KEY`).
- **Supabase (Mumbai):** apply migrations in order — `0001_init`,
  `0003_indexes`, `0004_postgis`. **Do NOT apply a 0002 migration: RLS is
  HELD** until the auth-method decision (OD-022) lands; guest seats have no
  profile, so the held policies could never satisfy them. If the schema ever
  changes, write a new numbered migration — never edit 0001/0003/0004 in place
  on a live project.

## The old tree is never a source to copy from

The previous build (`pakdam-app/`, now in recoverable trash) is a **behaviour
reference only**. Do not read it, do not copy its code, do not import its
files. Every file in this project is written fresh from `BEHAVIOUR.md` and
the two reference specs above. If a behaviour is unclear, ask — do not go
digging in the old tree.
