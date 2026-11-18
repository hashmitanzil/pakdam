# Status — what is built, what is not (honest)
# Corrected 2026-11-18 (deploy-readiness pass). Earlier versions of this
# file said the live backend was "NOT wired yet" — that is no longer true.

BUILT
- packages/shared: types, calibration (OPEN placeholders), validation
- packages/engine: state machine, roles, catch, safety, suspension, pings,
  zone, scoring, authorised snapshot
- workers: Worker entry (create / join / by-code lookup / ws-ticket /
  get-state / start / catch-token / WebSocket), DO state/recovery, WS
  ticket auth (single-use, upgrade validation, TICKET_REUSED/INVALID/
  EXPIRED), WS protocol handler, rate limits, host-token auth, server
  pings, fix purge at match end + TTL, Worker → Supabase client
  (workers/src/supabase.ts, plain-fetch PostgREST, best-effort game
  writes, fail-loud support intake)
- supabase: canonical schema, deploy set 0001 + 0003 + 0004 (0004 PostGIS
  written, never applied/syntax-checked against a live Postgres);
  0002 RLS HELD in supabase/migrations-deferred/ (OD-022 open)
- apps/web: Next.js PWA — landing, create, join, lobby, play, catch,
  results, host, admin, help, safety, legal, install, plus
  /how-it-works, /game-modes, /about, /contact, /faq, /grievance,
  /accessibility, /profile, sitemap + robots. Pages ARE wired to the
  live transport: lobby, play, catch and results call
  createLivePakdamSocket() when NEXT_PUBLIC_WORKER_URL is set; demo
  loop only when it is unset. Offline map: bundled Esri raster,
  808 tiles, zooms 12–17, Doranda + Hinoo, Ranchi (~13 MB).
  Dark mode, 48px tap targets, hamburger menu, phone + 130% zoom.
  CI workflow (.github/workflows/ci.yml): lint → typecheck → unit →
  vitest → web lib → production build → Playwright (63 tests).
NOT BUILT / NOT RUN YET
- Live Cloudflare deployment (wrangler dev smoke 14/14 local; no deploy,
  no account). Blocked on — all OPEN, none invented: (1) Cloudflare
  account + API token with Workers / Durable Objects permissions;
  (2) Supabase project URL + anon key + service-role key;
  (3) a real production domain (NEXT_PUBLIC_SITE_URL — the build
  refuses the https://pakdam.example placeholder; trademark gate).
  No credentials exist in this repo and none were created.
- Live Supabase project (migrations not applied anywhere); Supabase
  Auth method OPEN (OD-022)
- Real multi-device realtime end to end (code exists, unit-tested,
  wrangler-dev smoke green — but no live deployment, no live game
  played, no real-phone GPS check, no two-phone field test)
- Production build / full Playwright suite: never green anywhere yet.
  This VM cannot run them (EPERM on child-process writes); CI on a
  clean runner is the only evidence that counts and it has not run.
- Pen test, legal classification, trademark clearance, grievance
  officer (deferred — personal game for now), calibration (all OPEN,
  to be measured in the field, never invented)
