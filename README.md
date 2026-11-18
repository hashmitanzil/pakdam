# Pakdam — Forge Mission 001 (Phase 0 PWA)

Real-world GPS hide-and-seek / manhunt. Web PWA only, foreground-only
gameplay. Guest-only and free: join with a display name + room code, no
account, no sign-in (sign-in is a later decision — OD-022 stays open).
Name **Pakdam** and brand colour **red** are provisional (founder,
2026-11-16). Trademark NOT cleared — IP India search + lawyer opinion
required before public use.

> **Status (corrected 2026-11-18): Phase 0 PWA, live transport WIRED.**
> What is built: the pure-TS authoritative engine + shared
> types/validation, the full Next.js PWA (create, lobby, live game with
> map/radar/radio, catch, results, leaderboards, profile, safety, help),
> the Cloudflare Workers + Durable Object handler (one DO per room,
> routes: create / join / by-code lookup / ws-ticket / get-state /
> start / catch-token / WebSocket), the web pages wired to it
> (`createLivePakdamSocket()` called from lobby, play, catch and
> results; per-tab session credentials; demo loop only when
> `NEXT_PUBLIC_WORKER_URL` is unset), the Worker → Supabase client
> (`workers/src/supabase.ts`, plain-fetch PostgREST, best-effort game
> writes), and the canonical Supabase schema (migrations 0001 + 0003
> + 0004 to apply; 0002 RLS is HELD in `supabase/migrations-deferred/`
> — see below).
> What is NOT built: the live Workers/DO deployment, the live Supabase
> project, Supabase Auth (method OPEN), real multi-device realtime end
> to end (code exists and is unit-tested + wrangler-dev smoke 14/14;
> not deployed, no live game played yet), legal classification, pen
> test. Deploying the parts does not prove the game works until the
> two-phone field test passes — see `docs/DEPLOYMENT-RUNBOOK.md` §1
> and §3. See `docs/STATUS.md` for the exact built / not-built list.

## Quick start (local demo — no accounts, no keys)

```bash
cd pakdam-app
pnpm install --frozen-lockfile
npm run typecheck   # shared + engine + workers + web
npm test            # builds shared/engine/workers, runs engine + workers unit tests
npm run build       # production build (shared -> engine -> workers -> web)
npm run dev         # http://localhost:3000
```

Play it: Create a game → share the room code → Join as a guest on the
same device (or a second tab) → Ready → Countdown → Head start →
Active. Keep the PWA open and the screen on: location stops when the
tab is hidden or the phone locks. That is a Phase 0 limitation, not a
bug.

**Maps:** ONE bundled offline map (founder decision, 2026-11-17):
MapLibre GL JS + bundled **Esri World Street Map raster tiles,
808 tiles, zooms 12–17, bbox 23.325–23.38 N / 85.285–85.355 E,
~13 MB**, served from `apps/web/public/offline-map/tiles/` via
`apps/web/public/offline-map/style.json`, covering Doranda + Hinoo,
Ranchi. (A 2.2 MB PMTiles vector file also sits in that folder as a
documented spare — nothing loads it.) No live tile provider, no
fallback, no switcher, no reload — no
Google/Mapbox/MapTiler. If the device has no WebGL, an honest error
shows instead of a blank map. No latitude/longitude numbers are
shown anywhere in the UI — the zone centre reads "set", never
numbers.

## Founder rules (the short version — see `docs/DECISIONS.md`)

- **Catch:** in person first — the Runner taps "Got tagged", their QR
  opens, the Hunter scans it to complete the tag (hunter + runner +
  time recorded). If the camera is unavailable, the Runner confirms
  manually in a dialogue box. There is NO catch code anywhere.
- **Outside the zone:** a 30-second return countdown appears on the
  player's screen; get back inside before it ends, or they are
  ejected from the game. Enforced, not just displayed.
- **Location:** default sharing while a round is running (foreground
  only). Pings go out on the host's ping schedule; own team sees each
  other live; the other team only via pings; Runners never see Hunters.
  A "Refresh my location" button sends one fresh fix. The phone checks
  the zone locally — only an outside-zone crossing sends one alert,
  which starts the 30-second countdown. No custom cadence.
- **Pings:** a delivered ping stays on the hunter's map until the next
  ping replaces it — never removed on a timer. Its age counts up
  ("0:27 ago"). Show ping history ON keeps earlier pings visible
  (dimmer); OFF shows only the latest.
- **Game modes:** Classic + Infection in the pilot. Breach and Zombie
  are DEFERRED — not playable, not shown as playable.

## Deploy the web app — Vercel via GitHub (founder does this)

The founder creates the GitHub repo and connects Vercel himself. This
repo is ready for that — see `docs/DEPLOYMENT-RUNBOOK.md` §8 for the
full founder checklist.

1. Create a GitHub repo and push this folder (`pakdam-app/`) as the
   repo root. Do not commit `node_modules/`, `.next/`, `dist/` or any
   `.env` — `.gitignore` already excludes them.
2. In Vercel: **Import Project** → pick the repo. Root Directory: the
   repo root (default). Vercel reads `vercel.json` in this folder:
   install `pnpm install --frozen-lockfile`, build `pnpm run build` (builds shared →
   engine → workers → web), output `apps/web/.next`.
3. Set the environment variables in Vercel (names only — no values in
   this repo): `NEXT_PUBLIC_SITE_URL` = your real `*.vercel.app` URL
   (required — the build refuses the `https://pakdam.example`
   placeholder unless `PAKDAM_ALLOW_PLACEHOLDER_URL=1` is set, which is
   dev/CI-only and must NEVER be set in a real deploy),
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `NEXT_PUBLIC_WORKER_URL` (= the deployed Worker URL from the
   Cloudflare step — this is what switches the web app from the demo
   loop to the live Worker transport; the old name `WORKERS_API_URL`
   is dead and no code reads it, and `MAP_TILE_URL` is dead too — the
   map is bundled, nothing reads either name). The Supabase names are
   still unread by the web app — set them anyway so the wiring work
   has them to read.
4. Deploy, then smoke-test the routes in `docs/DEPLOYMENT-RUNBOOK.md`
   §8. Vercel hosts the website only — the live game server is still
   Cloudflare Workers + Durable Object (see below).

## Live game server — Cloudflare Workers + Durable Object

Vercel does not replace the game server. The live server is one
Durable Object per room (WebSocket, server-authoritative, no exact
opponent positions to clients). The full standalone setup is in
`docs/CLOUDFLARE-SETUP.md` — the founder creates the Cloudflare
account and deploys it; nothing here deploys anything. Free tiers
first (Vercel Hobby free, Supabase Free, Workers Free); paid triggers
at the external pilot (Workers Paid $5 + Supabase Pro $25).

## Supabase (founder does this)

Create the project in **Mumbai** (region: founder decision, 2026-11-17
— chosen in the Supabase dashboard at project creation, not in a
file). Run migrations **in order: `0001_init.sql` first, then
`0003_indexes.sql`, then `0004_postgis.sql`** — and **SKIP
`0002_rls.sql`**: it is HELD until the auth method closes (OD-022)
and lives in `supabase/migrations-deferred/`, outside the deploy
set, so a plain `supabase db push` can no longer apply it by
accident — still verify the push output lists ONLY 0001, 0003 and
0004 before confirming. Applying 0002 now would deny every guest
read. Copy the anon / service keys into Vercel / Wrangler by NAME
only (see `docs/DEPLOYMENT-RUNBOOK.md` §5). Note: 0004 (PostGIS)
has never been applied or syntax-checked against a live Postgres —
verify it on first apply.

## Calibration — OPEN, do not invent

GPS accuracy tiers, catch distance, ping schedule, grace, catch-token
TTL and rate limits are in `packages/shared/src/calibration.ts`. Every
value there is a placeholder labelled `OPEN — TO BE MEASURED`. No
threshold in this repo is a measured fact.

## Docs in this repo

- `docs/DEPLOYMENT-RUNBOOK.md` — the deploy runbook (Vercel via
  GitHub + founder checklist, Supabase, Cloudflare, smoke, rollback)
- `docs/CLOUDFLARE-SETUP.md` — standalone Cloudflare Workers + DO
  setup (account, wrangler, deploy, check it worked, troubleshooting,
  rollback)
- `docs/CANONICAL-SCHEMA.md` — the one schema (v2.1 Issue 6 fix)
- `docs/DECISIONS.md` — ADRs in brief + every v2.1 correction applied
  + founder decisions (catch, outside-zone, location, pings)
- `docs/STATUS.md` — exactly what is built / not built
- `docs/API.md` — exact REST + WebSocket contract (v2.1 Issue 8 fix)
