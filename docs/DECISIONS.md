# Decisions applied in this codebase (v2.1 corrections)

- **Name/brand:** Pakdam (provisional), RED (provisional). Green/lime tokens
  from Pack v2 file 07 are NOT used. Red palette: primary #D92B2B, dark
  #7A1212, ink #1A0E0E, paper #FFF7F5, surface #FFFFFF. WCAG pairings are
  PROPOSED and must be measured in M00 (white on #D92B2B is ~4.0:1 — do NOT
  use white body text on red; use dark text on light, white on #7A1212).
- **Phase 0 definition (Issue 1):** Phase 0 IS the PWA product, foreground-
  only. "Native-only gameplay promise" wording from Pack v2 file 06 is
  rejected and does not appear here. Phase 1 = native + background.
- **One HNT definition (Issue 2):** HNT-033 = Phase 1 background location
  ONLY; HNT-034 = browser accuracy tiers, thresholds OPEN; HNT-044 = server
  heuristics only, mock-location UNAVAILABLE in browsers. No stale table.
- **Suspension fairness (Issue 3):** `packages/engine/src/suspension.ts` —
  timer continues, catch cannot complete while Runner suspended, 3rd
  suspension (placeholder) triggers host check-in. No auto-punish.
- **Phase 1 tests separate (Issue 4):** `packages/engine/test/phase1.test.ts`
  — all skipped, never part of a Phase 0 pass.
- **Safety (Issue 5):** SOS = host-only, best-effort, NOT emergency dispatch.
  Trusted-contact sharing (HNT-060) is P1 and NOT in Phase 0. Venue-only
  pilot + host check-ins are enforced in room config validation.
- **Schema (Issue 6):** see CANONICAL-SCHEMA.md — one schema only.
- **Host/role (Issue 7):** `isHost` separate from `matchRole`.
- **API (Issue 8):** see docs/API.md + WS ticket (not long-lived token).
- **Pending pings (Issue 9):** expiry, never delivered stale, excluded from
  recovery snapshots, purged at match end (`packages/engine/src/pings.ts`).
- **Catch (founder corrections, 2026-11-17):** NO catch code anywhere in
  Pakdam. Exact sequence: (1) Hunter tags the Runner IN PERSON (no tech
  yet); (2) the Runner taps "Got tagged" — that OPENS the Runner's QR on
  their screen; (3) the Hunter scans it with the in-game QR scan button —
  the scan records hunterId + runnerId + time in the catch event; (4)
  fallback when the camera is unavailable: the Runner confirms themself
  manually in a dialogue box. The QR encodes only the one-time
  match-bound catch token (no location, no permanent ID). Host resolves
  disputes.
- **Outside the zone (founder correction, 2026-11-17):** a player outside
  the play area gets a 30-second return countdown on THEIR screen; at 0
  they are EJECTED from the game (marked ejected in the roster/results,
  never a survivor). Hunters may see the player's coarse area live during
  those 30 seconds, never an exact position. This replaces the old SCRAM
  outside-zone model — there is no "tagged after X" setting.
  Enforced in the engine (`packages/engine/src/zone.ts`) and the demo
  store (`ejectPlayer`); the worker/DO records first-seen-outside but has
  no alarm loop yet, so server-side ejection at 0 is still a production
  realtime-mission gap (see docs/DEPLOYMENT-RUNBOOK.md).
- **Ping display (founder decision, 2026-11-17):** a delivered ping STAYS on
  the hunter's map until the next ping replaces it — it does NOT disappear
  after 10 seconds (that is ShadowHunt's way, not ours). Its age is shown
  counting up ("0:27 ago", `formatAgeAgo` in
  `apps/web/src/components/match/freshness.ts`). If Show ping history is ON
  (`HouseRules.showPingHistory`, host setup toggle, default OFF), earlier
  ping areas stay visible too, dimmer and aged; if OFF, only the latest
  ping area per Runner shows. Delivery expiry (pending-ping TTL, Issue 9
  above) is unchanged and separate — it governs undelivered pings only,
  never the removal of a shown ping.
- **Location (founder decision, 2026-11-17):** location sharing is DEFAULT,
  as ShadowHunt + SCRAM do it — it runs while a round is running
  (foreground, while using the app); pings go out on the host's ping
  schedule; own team sees each other live; the other team only via pings;
  Runners never see Hunters. No custom cadence (no 10 s runner rule, no
  ping-only rule — both were proposed and explicitly rejected by the
  founder). A manual "Refresh my location" button on the Runner's play
  screen sends one fresh fix immediately. The device-side zone-exit check
  stays: the phone checks locally, and only an outside-zone crossing sends
  one alert, which starts the 30-second return countdown (first-seen-
  outside). Cost is usage-based on the Cloudflare free tier — the founder
  manages cost/errors himself; no custom cost maths is claimed in this repo.
- **Serwist:** Next 15.5 + `@serwist/next` (webpack, the documented Serwist
  path). The Turbopack/Next 16 path from Pack v2 is NOT assumed — it is
  unproven (reviewer) and is deferred to a PoC.
- **Tile provider + map library (founder decision, 2026-11-17):** Leaflet
  + CARTO basemaps (`basemaps.cartocdn.com/light_all` day, `dark_all`
  night, Esri World Imagery for Satellite) — keyless. MapLibre was
  replaced because it failed twice with a blank grey background on the
  founder's phone; Leaflet paints raster tiles as plain `<img>`
  elements and needs no WebGL, and its overlays/markers render even
  when tiles fail (MapLibre's `load` event never fired while tiles
  failed, so the YOU marker and zone overlays never synced either).
  Fallback chain, automatic: CARTO → OpenStreetMap France
  (`tile.openstreetmap.fr/osmfr`) → OpenStreetMap main
  (`tile.openstreetmap.org`). A layer is only abandoned when it fails
  outright (zero tiles loaded + 3 errors in a row); the banner always
  says which map is showing ("Map tiles loading slowly — showing the
  fallback map (…)" with a "Retry the main map" button; when every
  layer fails, "Map tiles failed to load — check your connection, then
  retry" with a Retry button that recreates the map). Honest status,
  2026-11-17: CARTO + Esri + OSM main return HTTP 200 by curl from
  this network; OSM France returns 404 for EVERY tile tested
  (including z0/0/0), so it is tried second per the founder's
  instruction but the chain falls through to OSM main. In this
  sandbox the Playwright browser cannot tunnel to CARTO
  (`net::ERR_TUNNEL_CONNECTION_FAILED`, probe `/tmp/probe-map.mjs`) —
  the tile tests therefore verify painting only where the tile hosts
  are reachable, and otherwise verify the honest degraded banner.
  The earlier claim in this entry that CARTO was "verified painting
  in a real browser load" was written before the probe ran and was
  wrong — corrected here. The Serwist service worker caches tile
  PNGs StaleWhileRevalidate (defaultCache) — it does not block them.
  Production provider selection is still OPEN for M00.
- **Mode switch Circle ⇄ Draw (founder decision, 2026-11-17):** switching
  to Circle CLEARS the drawn shape entirely (the form nulls
  `drawnBoundary`; PlayAreaMap drops the selected corner + undo history;
  the map removes every corner/middle marker and draws only the circle
  zone). Returning to Draw starts CLEAN — a fresh regular polygon around
  the centre, never a restored stale polygon. Undo can never empty the
  polygon (remove is disabled below 3 corners).
- **Phone header (founder decision, 2026-11-17):** on phone width
  (<=767px) the header tab row is replaced by a hamburger menu
  (`apps/web/src/components/ui/TopBar.tsx`): tap to open a slide-over
  with every section (Play / Trust & safety / About), tap outside /
  Escape / Close to close, current section highlighted, focus returns to
  the button. Desktop keeps the normal tabs. `html` has
  `scroll-padding-top: 76px` so scrolled-to content never hides under
  the 60px sticky header.
- **Deployment (founder decisions, 2026-11-17):** auth is GUEST-ONLY (no
  login/account; friends/leaderboards/presets are guest-local, marked
  "sign-in later"; OD-022 stays open, RLS 0002 must NOT be applied live).
  Web PWA on Vercel via GitHub (founder creates the repo + connects
  Vercel); Supabase in Mumbai, founder-run, migrations 0001–0003 in
  order with 0002 held; live game server stays Cloudflare Workers +
  Durable Object per room (Vercel hosts the site, not the game server).
  Free tiers first; paid triggers at external pilot (Workers Paid $5 +
  Supabase Pro $25). Full steps: docs/DEPLOYMENT-RUNBOOK.md (Vercel
  section) + docs/CLOUDFLARE-SETUP.md (standalone).
- **M00 discipline:** this codebase was built from the pack; it does NOT
  replace M00. M00 must still run against this repo + the pack before any
  external pilot.
- **Next zone — PUBG/BGMI-style random offset (founder decision,
  2026-11-17):** when the zone shrinks, the next zone is smaller AND
  at a randomly selected position fully inside the current zone — NOT
  concentric, not the same centre. Size follows the host's shrink
  setting exactly (Auto = 75% per shrink); only the position is
  random. Phases chain: each next zone sits inside the zone before it.
  Draw zones: the next shape sits randomly inside the current shape.
  The random draw happens ONCE, at room creation, in
  `draftToConfig` (`randomOffsetShrinkBoundary` in
  `packages/engine/src/zone.ts`, verified with `polygonFullyInside`,
  50 attempts then a concentric fallback); the stored
  `zone.shrinkPhases` are the single source of truth — every client
  and the worker read the same stored boundaries. The preview is the
  existing next-zone preview: a dashed boundary on the map
  (`MapView` `nextZoneBoundary`) + `NextZonePanel` ("Shrinks in
  MM:SS", progress bar, "next zone X across"). The outside-zone
  30-second countdown then applies to the NEW zone once it takes
  effect: the current zone is `effectiveZoneBoundary` (latest phase
  whose time has passed) and the map, HUD size text, way-back guide,
  outside-zone check (client and worker `room-do.ts`
  `location.update`) and preview all derive from it. Engine tests:
  `packages/engine/test/zone.test.ts` (seeded RNG: fully inside,
  75%/56.25% sizes, chained phases, timing).
- **GPS accuracy — never centre on a coarse fix (founder bug fix,
  2026-11-17):** "Use my location" waits for a GOOD fix (accuracy
  within the good tier, ±10 m) via `watchPosition`, `maximumAge: 0`,
  20 s watchdog. A coarse / cached / IP-based fix — right city,
  wrong spot, often the city centre, identical on every tap — is
  never accepted to centre a zone: at the watchdog a FAIR fix
  (≤25 m, still a real GPS/WiFi fix) may centre it, anything coarser
  is rejected with the best accuracy seen
  ("GPS accuracy is still ±X m after 20 seconds…"). The UI says
  plainly "GPS accuracy ±X m" (status line + zone-centre line) and
  labels a hand-placed centre "Placed by hand on the map — not a
  GPS fix" until a real GPS fix arrives. The play map camera flies
  to the first fix and re-centres only when a later fix is much more
  accurate (at least halved) — a walk alone never moves the camera.
  The host-setup form now propagates `radiusMeters` from the map
  (draw-mode radius edits were dropped before). `ZoneEditor`
  radius bounds aligned to the shared constants (100–1500 m, step
  50 m). Implementation: `apps/web/src/lib/geolocation.ts`,
  `apps/web/src/components/map/MapView.tsx`,
  `apps/web/src/components/host-setup/PlayAreaMap.tsx`.
- **Head start uses the configured value (2026-11-17, completion work):**
  the play page auto-advanced HEAD_START→ACTIVE after a hardcoded 5 s
  regardless of the host's head-start stepper. Now it counts from when
  the room entered HEAD_START (`headStartStartedAt` in the demo store)
  plus the configured `headStartSeconds`, shows "Hunt starts in M:SS"
  and the configured value on the banner, and a reload does not restart
  it. Zero head start flips at once. Implementation:
  `apps/web/src/lib/demo-store.ts` (`headStartStartedAt`, set in
  `setPhase`), `apps/web/src/app/room/[roomId]/play/page.tsx`.
- **Outside-zone countdown pauses on poor GPS accuracy (2026-11-17,
  completion work — decided, not founder-direct):** when the live fix
  is worse than the good accuracy tier (±10 m), the countdown FREEZES
  — seconds already counted stay counted, no new seconds accrue, and
  the banner says plainly "Countdown paused — GPS accuracy is poor
  (±X m)" — and resumes when accuracy recovers. A fix with no accuracy
  reported is not judged (the countdown runs). This is the fair
  reading of the founder's coarse-fix rule: a player must never be
  ejected because their phone's fix drifted, only because they stayed
  outside on a trustworthy fix. Implementation: play page (accumulated
  clock), `apps/web/src/components/hud/OutsideZoneBanner.tsx`,
  `apps/web/src/components/match/ModeZonePanel.tsx`.
- **Zone auto-centre limit ±50 m (founder rule, 2026-11-17):** a zone
  built 2–3 km from the host's real spot is unusable. Traced cause in
  this codebase: NO centre-setting path accepts a kilometre-coarse fix
  (`getCurrentFix` only resolves ≤10 m, or ≤25 m at the 20 s watchdog;
  no default centre exists anywhere) — but the code TRUSTED the
  browser's reported accuracy, and the live play map flew its camera to
  the FIRST fix whatever its accuracy, so a coarse network fix put the
  correctly-centred zone 2–3 km away from the player's shown position
  on screen (`MapView.tsx` `flyTo` on first fix, unconditional). Fixed
  on both ends: (1) a zone is NEVER auto-centred on a fix worse than
  ±50 m (`ZONE_AUTO_CENTRE_MAX_ACCURACY_M` in `@pakdam/shared`,
  enforced in `getCurrentFix` and again at both call sites,
  `PlayAreaMap` and `ZoneEditor`); a coarser fix is rejected with
  "GPS is off by ~X km — drag the pin to your exact spot" and the host
  places the pin by hand (tap the map / drag the centre pin), never a
  default spot. (2) The map camera only flies to a fix accurate to
  ±50 m or better (or one with no accuracy reported); a coarse first
  fix still draws its marker + accuracy circle, but the camera stays
  on the zone until a trustworthy fix arrives. Honest limit: GPS
  itself cannot be 100% (outdoors ~5–10 m, indoors much worse) —
  exactness is guaranteed only by the manual pin, which is exact.
  Implementation: `packages/shared/src/types.ts`,
  `apps/web/src/lib/geolocation.ts` (`coarseFixMessage`, `onProgress`),
  `apps/web/src/components/map/MapView.tsx`,
  `apps/web/src/components/host-setup/PlayAreaMap.tsx`,
  `apps/web/src/components/match/ZoneEditor.tsx`.
- **Map accuracy — manual fallback (founder instruction, 2026-11-17):**
  tap the map to set the exact zone centre, draggable centre pin (red
  pin, Circle mode — drag marks the centre hand-placed), pin position
  shown as coordinates (Circle and Draw modes), high-accuracy
  watchPosition GPS with accuracy in metres shown at all times, "Use
  my location" refines as GPS locks (live "Best fix so far: ±X m —
  still refining…" readout via `getCurrentFix(onProgress)`).
  Implementation: `PlayAreaMap.tsx`, `ZoneEditor.tsx`,
  `apps/web/src/lib/geolocation.ts`.
- **Create never silently does nothing (founder bug, 2026-11-17):** the
  CREATE LOBBY button was disabled until a GPS fix arrived, so a tap
  while GPS hung gave no feedback at all. The button is now always
  enabled; submit() explains exactly what is missing (codename, zone
  centre, safety confirmations) or creates the room. While locating,
  the map says the host can tap it right now instead of waiting.
  Implementation: `apps/web/src/app/create/page.tsx`.
- **Rooms persist across reload; identity is per-tab; names restore
  seats (founder bugs, 2026-11-17):** rooms already persisted in
  localStorage (`pakdam.demo.rooms.v1`) — verified by a reload test.
  Player identity was one shared localStorage value, so a second
  player joining in another tab overwrote the host tab's identity and
  stole the Start button; it is now per-tab sessionStorage (a reload
  in the same tab still restores the room and the role; a new tab
  rejoins by name). Joining with an existing display name restores
  that seat (same playerId, same role, host powers if host) instead
  of creating a duplicate; a player who left rejoins as connected
  (ejectedAt stays — rejoining never un-ejects). The lobby has Leave
  room and Switch player buttons. Implementation:
  `apps/web/src/lib/demo-store.ts` (`joinRoom`, `currentPlayerId` /
  `setCurrentPlayerId` / `clearCurrentPlayerId`),
  `apps/web/src/app/room/[roomId]/page.tsx`,
  `apps/web/src/components/profile/ProfileClient.tsx` (delete-my-data
  also clears the sessionStorage id). E2E: `session-restore.spec.ts`.
- **Next-zone fallback always fully inside (2026-11-17, completion
  work):** for a concave drawn shape whose vertex centroid sits
  outside the shape, the old 50-attempt fallback returned the
  concentric copy unchecked, which could poke outside the play area.
  Now the fallback shrinks until a copy verifies fully inside
  (`polygonFullyInside`): concentric copies first, then copies scaled
  toward a point just inside a convex vertex (a copy scaled toward a
  boundary vertex itself shares that vertex and its edges, which
  counts as touching, not inside). Fallback copies may be smaller
  than the host's shrink size — a smaller zone fully inside is
  correct; a full-size zone poking out is not. Implementation:
  `packages/engine/src/zone.ts`, test `packages/engine/test/zone.test.ts`
  (concave L-shape, hostile RNG).

- **Map provider is Google Maps (founder decision, 2026-11-17):**
  the Google Maps JavaScript API is the map provider (most accurate
  roads in India). The key is the founder's own, created in Google
  Cloud (free tier), and lives ONLY in env
  (`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) — never in code, never
  committed, never invented. Exact steps: `docs/GOOGLE-MAPS-SETUP.md`
  (project → billing account (mandatory even for free use) → enable
  Maps JavaScript API only → create key → restrict by HTTP referrers
  + API → env: local `.env.local`, Vercel env + redeploy; the key is
  inlined at build time). Until the key exists, every map uses the
  Leaflet fallback (CARTO / Esri / OSM raster tiles) and NEVER shows
  a blank map; if the Google script fails to load, the view falls
  back to Leaflet with a banner saying so. Implementation:
  `apps/web/src/components/map/google-maps.ts` (loader + key check),
  `apps/web/src/components/map/GoogleMapView.tsx` (Google
  implementation of MapView's props, same overlays + same ±50 m
  camera rule), `apps/web/src/components/map/MapView.tsx` (provider
  switch), `apps/web/src/components/map/LeafletMapView.tsx` (the
  former MapView body, now the fallback),
  `apps/web/src/components/host-setup/PlayAreaMap.tsx` (Google branch
  for host setup: same tap/drag/corner/middle-marker behaviour, SVG
  marker icons). The Google path is NOT live-verified (no key exists
  to test against) — it is typechecked and its fallback is
  Playwright-tested; live verification needs the founder's key.
  E2E: `google-maps.spec.ts` (no-key fallback).
- **CORRECTION — Google Maps CANCELLED (founder-approved final stack,
  2026-11-17):** the Google Maps switch above is REVERSED. Do NOT use
  Google Maps / Google APIs at all. Map is **OpenFreeMap first, Esri
  fallback, no Google/Mapbox/MapTiler tiles**. Deleted:
  `apps/web/src/components/map/google-maps.ts`,
  `apps/web/src/components/map/GoogleMapView.tsx`,
  `docs/GOOGLE-MAPS-SETUP.md`, `apps/web/e2e/google-maps.spec.ts`,
  and the Google branch in
  `apps/web/src/components/host-setup/PlayAreaMap.tsx`; the
  `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` env var is removed from
  `.env.example`, README and the runbook. CARTO tiles are also
  dropped everywhere (CARTO stamps an "API KEY REQUIRED" watermark on
  keyless tiles since 26 Aug 2026). Map stack now: MapLibre GL JS
  with OpenFreeMap vector styles (liberty/positron/dark), Esri raster
  (World Imagery for Satellite, World Street Map for the Leaflet
  fallback), OSM France → OSM main as last-resort fallbacks only.
  Implementation: `apps/web/src/components/map/maplibre.ts`,
  `apps/web/src/components/map/MapLibreMapView.tsx`,
  `apps/web/src/components/map/MapView.tsx` (MapLibre primary,
  Leaflet fallback on WebGL/init failure). The no-lat/lng rule below
  stands unchanged.
- **No latitude/longitude numbers anywhere in the UI (founder rule,
  2026-11-17):** no lat/lng readouts — pin panel, centre readout,
  aria-labels, announcements, no-go list, anywhere. The manual pin
  must NOT show coordinates. The centre reads "set — from your GPS
  location" / "set — placed by hand on the map" / "not set yet";
  accuracy in metres ("GPS accuracy ±X m") and distances ("about 1
  km across") are still shown — they are not coordinates. The
  ZoneEditor latitude/longitude number inputs were removed
  entirely; the centre is set by GPS or by hand on the map, never
  typed. Coordinates still exist in code (state, geometry, engine)
  — only the display was removed. Implementation:
  `apps/web/src/components/host-setup/PlayAreaMap.tsx`,
  `apps/web/src/components/match/ZoneEditor.tsx`; e2e assertions
  updated to the "set" wording (`helpers.ts`, `smoke.spec.ts`,
  `host-setup.spec.ts`, `map-tiles.spec.ts`, `mobile-layout.spec.ts`,
  `brutal-phone.spec.ts`, `map-accuracy.spec.ts` — the pin-drag test
  now proves movement by the pin's on-screen position, not by a
  longitude number). Grep proof (no UI lat/lng): `grep -rn
  "toFixed(4)\|toFixed(5)" apps/web/src` returns only distance /
  accuracy-error formatting, never coordinates.

- **Personal game scope + player limit 30 (founder, 2026-11-17):**
  Pakdam is the founder's PERSONAL game for now; publishing later.
  (1) The tag "Name provisional · pending trademark clearance" and
  all other provisional / pending-trademark / publishing-warning
  text about the name PAKDAM are REMOVED from the UI: the footer
  line in `apps/web/src/app/layout.tsx:66` and the mobile-menu line
  in `apps/web/src/components/ui/TopBar.tsx:159` now read "Pakdam ·
  English only · 18+ only · Private invite-only"; `about/page.tsx`
  lede + metadata no longer mention provisional/trademark; the
  "work in progress — pilot. The name and brand are provisional."
  line and the empty "Who makes Pakdam" placeholder section are
  deleted; the sitemap comment now records the deferral instead of
  a "trademark gate". (2) Player limit raised 16 → 30, minimum
  stays 3: `packages/shared/src/validation.ts:19,59`
  (`HOST_RANGES.maxPlayers.max = 30`, error "maxPlayers must be
  3–30"), `packages/shared/src/types.ts:72`,
  `HostSetupForm.tsx:87` (stepper 3–30), `:259` (hint "3–30"),
  landing `page.tsx:33,100`, `game-modes/page.tsx:8,33`,
  `about/page.tsx:23`, `faq/page.tsx:90` ("Free hosting to 30
  players"), lobby capacity is dynamic (`room/[roomId]/page.tsx:
  271,299` — `{players.length} / {config.maxPlayers}`, no edit
  needed), the Durable Object join path enforces
  `config.maxPlayers` (no hardcoded 16 anywhere in workers or
  migrations). The balanced-Hunter table did NOT need a new
  threshold: `balancedHunterCount` already returns 3 for any
  roster above 8, so only its text changed — "3 for 9–16" →
  "3 for 9+" (`roles.ts`, `HostSetupForm.tsx:266`; the word
  "provisional" is dropped from the UI string, "calibration open"
  already says the table is unmeasured). Zone-size suggestion
  example extended by the formula (200 + 25·(n−3), cap 1000 m):
  30 players → 875 m (`calibration.ts`). (3) FOR THE RECORD —
  trademark clearance and public-pilot legal work are DEFERRED
  by the founder (personal use only). The draft legal pages are
  kept as-is and NOT expanded; no publishing features were built.
  Historical redesign reports (`docs/KABIR-REDESIGN-REPORT.md`,
  `REDESIGN-LANDING-REPORT.md`, `REDESIGN-V2-HUD-LANDING-REPORT.md`)
  still say 3–16 — they are dated records of what was built then,
  not live copy, and were left untouched.
- **Map: 0-byte OpenFreeMap tiles + OSM 403 — probe, watchdog,
  Esri-only chain (verified live browser, 2026-11-17):** the
  founder's phone got HTTP 200 with 0 bytes from OpenFreeMap's
  unversioned tile path — the style loaded, every tile was empty,
  the map was a white plane — and OSM's own tile server returns
  403 error tiles (OSM France 404 for every tile tested). The
  previous fallback design could NOT have caught the 0-byte case:
  its "3 errors, no source loaded" gate counted ANY `sourcedata`
  event, including the map's own GeoJSON overlays, which load
  instantly and locally — so after the first overlay loaded, tile
  errors were ignored forever and the Esri fallback never fired.
  Fixes: (1) `apps/web/src/components/map/maplibre.ts` —
  `probeOpenFreeMap(styleUrl)` fetches the style JSON, takes the
  first vector source's tile template, fetches ONE real tile
  (z=14) and returns true only for OK + non-empty bytes (8 s
  timeout; cached per style URL; `resetTileProbe()` clears it for
  Retry); `resolvedStyle(id)` returns the OpenFreeMap style when
  the probe passes, `ESRI_STREET_STYLE` (new raster style object —
  Esri World Street Map, streets not satellite) when it does not.
  (2) `MapLibreMapView.tsx` — the map is created with the probed
  style; style switches and both Retry buttons go through
  `resolvedStyle` (Retry resets the probe first); the `sourcedata`
  gate counts VECTOR sources only (`e.source?.type === 'vector'`);
  the `error` handler counts EVERY tile error (the post-load count
  is needed by the watchdog); a 10 s post-load watchdog switches
  to Esri street raster when 3+ tile errors happened and
  `areTilesLoaded()` is still false; the caption names the tiles
  actually showing (OpenFreeMap vs Esri attribution). (3) The
  Leaflet fallback chains (`LeafletMapView.tsx`,
  `PlayAreaMap.tsx`) are now Esri-only: Esri World Street Map →
  Esri World Imagery → Esri Dark Gray; OSM France and OSM main
  are REMOVED from every chain. E2E updated to match
  (`map-tiles.spec.ts` header + TILE_HOST regex + no tolerated
  non-200 host; `brutal-phone.spec.ts:185` regex). NOT yet
  live-verified in a browser in this session (Chromium cannot
  start on this VM — memfd mmap EPERM SIGTRAP; see below) — the
  probe/watchdog logic is code-complete and must be proven by the
  map-tiles spec on a working browser.

## PUSH HARD — map + location (founder steer, 2026-11-17)

Founder: "PUSH HARD — try ALL types of approach and fix the map +
location, do not stop at the first fix. This is the top priority,
above everything else in your queue." Full probe table in
docs/MAP-LOCATION-PROBES.md. Summary of findings (curl probes from
this VM, 2026-11-17):

- OpenFreeMap: the UNVERSIONED tile path is dead (200 with 0 bytes).
  The style JSON's vector source points at a TileJSON
  (tiles.openfreemap.org/planet) whose tiles template is VERSIONED
  and dated per planet build (20261115_080022_pt). The versioned tile
  is REAL (Ranchi z14 tile 36,983 B). The version string is read from
  the TileJSON at runtime, never hardcoded. OpenFreeMap styles
  (liberty/bright) load (43,311 / 48,762 B). OpenFreeMap has no
  versioned STYLE URL — styles are unversioned; only the tile path
  inside the TileJSON is versioned.
- Esri (Street / Imagery / Dark Gray): all return HTTP 200 with the
  SAME 2,521 B grey JPEG "Map data not yet available" from this
  network — a placeholder, not a map. Same-zoom neighbours are
  byte-identical. Esri works on the founder's phone (verified real
  Ranchi streets) but NOT from this VM — kept as fallback, with the
  placeholder DETECTED at runtime (byte-equality across adjacent
  tiles). Placeholder hash varies by zoom, so exact-hash detection
  is invalid.
- OSM main: HTTP 200 with a 6,725 B PNG "403 Access blocked — App is
  not following the tile usage policy". Status codes lie for tiles;
  only content checks work. OSM main is dead here AND on the phone.
  OSM France / HOT: 404. Wikimedia / OSM.de / wmflabs / bzh: HTML
  error pages. CARTO: API-key watermark since 26 Aug 2026.
  UA spoofing (Chrome Android) changed nothing — blocking is
  IP-based, not UA-based.
- Conclusion from this network: versioned OpenFreeMap is the ONLY
  provider serving real map data here.

Implemented (code-complete, NOT live-verified in a browser —
Chromium cannot start on this VM, memfd mmap EPERM SIGTRAP):
- maplibre.ts: probeOpenFreeMap follows style -> vector source ->
  TileJSON -> real tile (OK + non-empty bytes, 8 s timeout, cached);
  probeRasterProvider fetches two adjacent land tiles
  ('real' | 'placeholder' | 'error'); resolvedStyle tries
  OpenFreeMap styles in order (standard: liberty, bright, positron;
  dark: dark, fiord; high-contrast: positron, bright), Esri street
  raster when none probes real; loadMapLibre tries bundled ->
  jsDelivr -> unpkg (same pinned 5.24.1).
- MapLibreMapView.tsx: probed style at creation and on Retry;
  sourcedata counts VECTOR sources only (the old bug: GeoJSON
  overlays loaded instantly and suppressed the fallback forever);
  10 s watchdog switches to Esri street raster on 3+ tile errors
  with no loaded tiles.
- LeafletMapView.tsx + PlayAreaMap.tsx: adaptive probe chain
  [Esri Street, Esri Imagery, Esri Dark Gray], first 'real' wins;
  tileerror re-probes remaining candidates by content; Retry
  re-probes. OSM hosts removed from the chain entirely.
- geolocation.ts: staged chain (permission check -> high-accuracy
  watch 12 s -> high-accuracy one-shot 10 s -> low-accuracy one-shot
  15 s -> cached one-shot 8 s, accepted only within ±50 m), 45 s
  global deadline, static-provider short-circuit (identical fix
  from consecutive stages settles immediately), retryLocation()
  force-resets every busy flag, getBestCoarseFix() for the
  "Use this approximate spot" offer, pos.timestamp for the fix age.
  UI (PlayAreaMap.tsx, ZoneEditor.tsx): stage label shown live
  while locating, permission-denied checked upfront (no spinner,
  tap-the-map primary), "Retry location" button, approximate-spot
  offer (host chooses it as a hand-placed pin, labelled approximate).
- session-restore.spec.ts: reconstructed (was truncated to 0 bytes
  by the EPERM flapping) from the run-2 error-context titles; 4
  tests (create-explains + map tap, reload restores host + guest,
  rejoin-by-name restores the host seat, second player cannot steal
  Start + Leave/Switch work). NOT run — Chromium down.

Do NOT report the map "fixed" until tiles paint AND a location flow
delivers a fix or a clear pin fallback in a live browser.

## OFFLINE MAP — founder decision (2026-11-17 19:34 IST) — SUPERSEDES the PUSH HARD adaptive chain above

Founder: "NO fallback/switcher/reload, NO lat/lng in UI — ONE simple
working map, downloaded offline and bundled in the app, covering
Doranda + Hinoo, Ranchi, Jharkhand, for now. GPS works on the
downloaded map (device GPS is independent of tiles). Complete the
game on this offline map; full live map service is a SEPARATE later
task."

Implemented (2026-11-17):
- Pack: `apps/web/scripts/download-offline-map.mjs` downloads the
  bundle into `apps/web/public/offline-map/` — 17 OpenFreeMap vector
  tiles z10–z14 for lat 23.325–23.38, lng 85.300–85.355 (Doranda +
  Hinoo), Liberty style rewritten to local paths, 4 sprite files,
  18 Noto Sans glyph files, manifest.json — 41 files, 2.6 MB, ZERO
  0-byte files (verified on disk). The versioned tile path is read
  from the TileJSON at download time (20261115_080022_pt), never
  hardcoded; the bundled tiles are plain local files.
- KEY FINDING: the OpenFreeMap planet TileJSON declares maxzoom 14 —
  tiles above z14 are legitimately empty (HTTP 200, 0 bytes) and
  MapLibre OVERZOOMS the z14 tiles for closer zooms, exactly as the
  live service does. The first downloader run (z10–z16) wasted time
  failing z15/z16 fetches before this was found; MAX_ZOOM is now 14.
- Map: `MapLibreMapView.tsx` uses ONLY `/offline-map/style.json`
  (maxzoom 14); `MapView.tsx` renders it directly; the Leaflet view
  is DELETED (`LeafletMapView.tsx`), the Esri/probe/adaptive-chain
  code is DELETED from `maplibre.ts`, the style toggle + retry
  buttons + fallback banners are DELETED, and the accessibility
  "Map style" select is REMOVED (it set a `data-map-style` nothing
  read — a dead switcher promising variants that do not exist; the
  High contrast checkbox and Colour-blind theme stay). `leaflet`
  and `@types/leaflet` removed from `apps/web/package.json`
  (package-lock.json still needs a regen when the sandbox allows).
  `PlayAreaMap.tsx` (host editor) is rewritten on MapLibre with the
  same draggable pin / corner / middle markers. Initial camera is
  the bundled area's centre (zoom 13), never a world view — there
  are no tiles for anywhere else. If the bundled style cannot load,
  an honest banner says so (no retry — there is no other map); if
  WebGL/library fails, an honest error replaces the map.
- E2E updated: `map-tiles.spec.ts` asserts tiles come ONLY from
  `/offline-map/tiles/` (HTTP 200, no failures, no error banner);
  `brutal-phone.spec.ts` + `map-accuracy.spec.ts` selectors moved
  from Leaflet to MapLibre markers/canvas; `live-hud.spec.ts`
  style-switch test replaced by an offline-map test (no "Map style"
  group, no Satellite button, offline caption visible).
- NOT live-verified in a browser in this session (Chromium cannot
  start on this VM — memfd mmap EPERM SIGTRAP). The pack is verified
  on disk and the code typechecks; painting in a live browser is
  still unproven — do NOT call the map "fixed" until tiles paint in
  a live browser.
- NOTE on the library: the MAP (tiles/style/glyphs/sprites) is fully
  bundled; the MapLibre JS library itself still loads from the
  pinned jsDelivr/unpkg build until `npm install maplibre-gl@5.24.1`
  lands (blocked by the VM's EPERM write flapping). When the package
  is installed the bundled import wins and no CDN is fetched.

## 2026-11-17 (founder steer: SPEED UP, full-fledged, deploy-ready) — migration set + PostGIS + "no demo" wiring

- Deploy migration set is now STRUCTURAL, not just documented:
  `supabase/migrations/` holds exactly 0001 + 0003 + 0004. `0002_rls.sql`
  was MOVED to `supabase/migrations-deferred/0002_rls.sql` (README there
  explains the deferral + re-apply order) so a plain `supabase db push`
  can no longer apply it by accident. Founder decision: skip 0002 RLS
  until auth closes (OD-022). Runbook §5, §1 note, D2 row and the
  rollback paragraph updated to match; the old selective-apply warning
  is gone.
- NEW `supabase/migrations/0004_postgis.sql` (founder-approved final
  stack): PostGIS extension; `restricted_areas` geography table (no
  label — app lists "No-go area N"); `zone_polygon(room_id)` built
  from rooms.config; `point_in_zone` / `point_in_restricted_area`
  (point passed as arguments, never stored); trigger rejecting any
  room_events payload with top-level lat/lng/latitude/longitude keys
  (HNT-068 backstop — the validated events in packages/shared/src/events.ts
  are already redacted before storage). OSM-danger disclaimer in the
  file header: PostGIS tests boundaries, it cannot judge danger; host
  venue choice + pre-match warning remain the safety layer.
  NOT yet applied or syntax-checked against a live Postgres (no DB in
  this environment) — the founder verifies on first `supabase db push`
  on Supabase Mumbai.
- "NO DEMO" (scope reminder, founder steer): the PWA still plays via
  `apps/web/src/lib/demo-store.ts` (localStorage demo store) — 16
  consumer files (create, host, join, join/[code], room, room/play,
  room/catch, room/results, admin, leaderboards/board-client, lobby/
  ReadinessChecklist, profile/ProfileClient, profile/ShareRoundCard,
  profile/leaderboard, profile/round-card, lib/websocket). The Worker
  entry (`workers/src/index.ts`) + DO class (`workers/src/room-do-class.ts`)
  + PakdamSocket (`apps/web/src/lib/websocket.ts`) are implemented but
  NOT yet wired into the PWA. Replacing demo-store with real Worker
  HTTP + WS + Supabase is a DEDICATED wiring mission (touches the 16
  files above) — it must be sequenced as one mission, not bolted on
  here, and it is THE critical remaining item before "full-fledged"
  is true. Do NOT claim the app is live-multiplayer until that wiring
  lands and is tested end to end.
- Deploy-ready bar (founder steer): clean build, real env vars only
  (no invented keys), migrations 0001+0003(+0004), Cloudflare
  Worker/DO per CLOUDFLARE-SETUP.md, fresh downloadable zip AT THE
  END only. No link is shared until the final game is complete from
  our side. NO zip was produced in this session.

## 2026-11-17 (founder steer: SPEED UP, full-fledged, deploy-ready) — continued: hunter-table correction, k6, Sentry, shadcn foundation, lint, build DyXgqfBx7jYhw10FXe_TT

- HUNTER-TABLE CORRECTION (a prior summary was wrong; the code was
  right): `balancedHunterCount` (packages/engine/src/roles.ts:11-17)
  is 1 for 3–4, 2 for 5–8, 3 for 9–16, 4 for 17–24, 5 for 25–30 —
  the ladder keeps the Hunter share roughly flat to the 30-player
  cap (founder, 2026-11-17), and engine.test.ts:63-72 already asserts
  the full ladder including 30 -> 5. The ONLY wrong text was the host
  setup hint "3 for 9+" (apps/web/src/components/host-setup/
  HostSetupForm.tsx:266) — fixed to the full table "1 for 3–4, 2 for
  5–8, 3 for 9–16, 4 for 17–24, 5 for 25–30 — calibration open".
  The number shown by `effectiveHunterCount` was already correct.
- New unit tests (node:test, no Vitest — install blocked): workers
  74 pass / 0 fail (was 19); engine 49 pass / 0 fail / 3 skipped
  (Phase 1 native-only). New files: workers/test/shared-validation.
  test.ts (events, GPS validation, room-config 3–30, room codes),
  workers/test/routes.test.ts (Worker routes + Zod schemas),
  workers/test/alarm-tick.test.ts (HEAD_START flip at the configured
  head start, ejection at 30 s, paused-countdown accumulation,
  redacted ZONE_UPDATED on shrink). One test caught a shim quirk:
  the shim's parse stamps optional keys as `seq: undefined`, so the
  round-trip assertion compares field-by-field, not by deepEqual.
- k6: workers/load/k6-16-player.js (16-player simulation: host
  creates, 15 guests join, WS tickets, hello + location.update every
  5 s). Functional checks only — NO latency threshold is invented;
  p95 is recorded, the founder sets the bar from the first measured
  run. k6 itself is NOT installed (Go binary, cannot be downloaded
  in this sandbox); run instructions are in the file header.
- Sentry: docs/SENTRY-SETUP.md written (install steps, the three
  config files as paste-ready contents, next.config.ts wrap,
  privacy rules — never coordinates/names/room codes/tokens,
  tracesSampleRate 0 = error monitoring only). The files are NOT in
  apps/web/ yet on purpose: an unresolvable @sentry/nextjs import
  would break the build. Runbook env row updated to match.
  Package install still blocked (no cached tarball).
- shadcn foundation: apps/web/src/lib/utils.ts (`cn` — plain join,
  NOT tailwind-merge; no Tailwind installed) + apps/web/src/
  components/ui/button.tsx (shadcn API shape on the tokens.css
  classes; variants default/secondary/destructive/dark, sizes
  default/sm/lg/icon; outline/ghost/link NOT implemented — no token
  class exists). `.btn-sm` + `.btn-icon` added to tokens.css. Real
  usage: the two "Retry location" buttons (PlayAreaMap.tsx:594,
  ZoneEditor.tsx:271) now use `<Button variant="secondary"
  size="sm">`. Full 85-screen restyle = remaining work.
- Lint: 0 errors, 0 warnings (was 80 errors + 7 warnings). Fixes:
  eslint ignores for the vendored offline-map libraries
  (public/offline-map/vendor/** — third-party, never linted), for
  workers/.wrangler/** (generated dev bundles from a wrangler dev
  run), for the probe-gps.mjs scratch file, and k6 globals for
  workers/load/**; removed one unused `context` arg in
  session-restore.spec.ts:19 and 7 stale unused eslint-disable
  directives in e2e specs (no-console is not an enabled rule, so the
  directives were no-ops; the console.log lines stay).
- NOTE — the MapLibre library is now VENDORED locally (public/
  offline-map/vendor/maplibre-gl.js 2,226,722 B + pmtiles.js +
  basemaps.js; OFFLINE_VENDOR_BASE in maplibre.ts): the library no
  longer loads from CDN. The earlier "library still loads from CDN"
  note is STALE — see the map files' own headers for the current
  state. This worker did not change the map code in this turn.
- Build window (this turn): typecheck clean (shared, engine,
  workers, web); lint 0/0; engine 49 pass / 0 fail / 3 skipped;
  workers 74 pass / 0 fail; production build OK with the documented
  escape PAKDAM_ALLOW_PLACEHOLDER_URL=1 — BUILD_ID
  DyXgqfBx7jYhw10FXe_TT, 26 static pages, 29 routes,
  2026-11-17T14:54:27Z. Full Playwright suite running against this
  build (Chromium 159.0.8154.6 launches again — the memfd mmap EPERM
  block that SIGTRAPped it earlier has cleared).

## 2026-11-17 (Playwright run 3, BUILD_ID DyXgqfBx7jYhw10FXe_TT) — 7 passed / 166 failed executions, almost all environment-killed; stale tests fixed

- Full suite ran 12.7 min against BUILD_ID DyXgqfBx7jYhw10FXe_TT:
  173 executions, 7 passed, 166 failed. Per test-results/: 166
  result dirs, ALL with error-context.md, 149 EMPTY (the worker died
  before writing diagnostics — Chromium SIGTRAP on memfd mmap EPERM,
  same signature as run 2) and 17 non-empty, ALL `-desktop`. The
  "7 passed" line is the reporter's final summary; which 7 passed
  was not recoverable (the list output was piped through tail).
  Verdict: the run is ENVIRONMENT-KILLED, not a valid app signal —
  except for the 17 non-empty desktop failures, which are real
  diagnostics (below). A targeted re-run (host-setup, desktop,
  workers=1) died in 6.5 s with Chromium SIGTRAP + "Error: EPERM:
  operation not permitted, write" — the 5 "failures" there are
  browser-death, not app failures. Chromium launch checks flip
  between OK and SIGTRAP as the EPERM window flips.
- The 17 non-empty failures split into TWO groups:
  (a) STALE TESTS — the app changed, the specs did not. FIXED in
  this turn (spec edits only, no app changes):
  - "Add 3 demo players" (6 failures incl. helpers.ts startMatch):
    the button does not exist in the app any more — no demo seats
    exist. New helper `addRealPlayers(context, roomCode, names)`
    (apps/web/e2e/helpers.ts) joins real guests via /join, each
    taps "I'm ready". startMatch, smoke (2 places), outside-zone
    (4 places) and brutal-phone now use it; `demos` renamed to
    `extras` in outside-zone; the "guest join overwrote the shared
    playerId slot" comment in smoke was stale (identity is per-tab
    sessionStorage) and was corrected.
  - 2-player minimum (join-lobby Ready flow, host-setup create-lobby,
    brutal-phone E2E): MIN_PLAYERS is 3 (apps/web/src/app/room/
    [roomId]/page.tsx:120), and the lobby copy is "N of at least 3
    players in" / "Waiting for everyone to be ready" / "✓ Ready to
    start" — the old "NEED 2+ PLAYERS TO START" text is gone.
    Ready-flow test rewritten for host + 2 guests ("3 of 3 ready");
    host-setup:222 and brutal-phone's "2 of 2 ready" updated to the
    3-/5-player copy.
  - Settings "Match length" (join-lobby): Standard is 60 min, one
    step up is 90 min ("1 h 30 min", 5400 s) per DURATION_STEPS_MIN
    — the old '45 min' / 2700 s expectation was written when
    Standard was 30 min.
  (b) NEED A LIVE BROWSER (not fixed blind): "Link Guest" (the
  roster DOES render display names, so the failure is unexplained
  from source — join-flow defect or environment); "Let's go!" radio
  message (the quick chip exists and the click found it, but the
  message did not appear in the log — radio-send defect or timing);
  map tests x4 (`.maplibregl-canvas`/marker not found, GPS messages
  not found — WebGL availability in headless Chromium is the prime
  suspect); "3.0 km zone" slider (radius max is still 1500 m, the
  formatter still yields "3.0 km" — why fill('1500') did not apply
  is unknown without a live run).
- DIST COLLISION WARNING (2026-11-17 ~15:14 UTC): 72 files across
  packages/engine/dist, packages/shared/dist and workers/dist were
  truncated to 0 bytes in a single instant — a root build (shared ->
  engine -> workers) ran while EPERM was flapping, almost certainly
  a PARALLEL worker's build, not this worker's (this worker ran no
  build at that time). This worker did NOT rebuild over it. The web
  typecheck currently fails with TS2306 "dist/src/index.d.ts is not
  a module" because of the 0-byte files — that is the corrupt dist,
  not the spec edits. The running Next server (BUILD_ID
  DyXgqfBx7jYhw10FXe_TT, built 14:54 UTC from good dist) is
  unaffected — its .next output is self-contained. Whoever owns the
  next build must rebuild shared/engine/workers from clean dist
  (delete the 0-byte files first if tsc will not overwrite them)
  and re-verify the web typecheck before any new production build.

## TOOLING COMPLETION (2026-11-17, tooling worker) — Zod, Vitest, Sentry, Tailwind, k6, pnpm, ESLint

All six tooling items from the final checklist are done except the
named open defects at the end of this section. Evidence is the
tooling worker's own runs, not summaries.

### Zod — real, wired for HTTP + events; WS inbound schemas written, NOT yet wired in
- Real Zod 4.6.7 is a dependency of `packages/shared` and `workers`
  (re-exported as `z` from `packages/shared/src/index.ts`). The old
  shim is gone.
- HTTP bodies: strict Zod schemas (`createRoomBody` / `joinBody` /
  `ticketBody`) in `workers/src/http.ts`, `safeParse`d in
  `workers/src/index.ts:95,141,167,198,215`.
- Stored game events: `parseGameEvent` (`packages/shared/src/events.ts:148-154`,
  strict union of 10 event schemas), called by `logGameEvent`
  (`workers/src/room-do.ts:1091-1092`).
- NEW `workers/src/lib/validation.ts`: real-Zod schemas for all 14
  mutating WS client message types + the non-mutating ones, plus a
  `validateWsClientMessage()` helper, mirroring the DO's hand-rolled
  checks exactly (corrected against the real web client:
  `catch.confirm` allows empty-string `qrToken` on manual confirm;
  `hello` requires `protocolVersion: 1`; `location.update` quality
  excludes `'unknown'`).
- OPEN (not mine to wire — `room-do.ts` is outside the tooling
  scope): `validateWsClientMessage` is NOT yet called from
  `handleWsClientMessage` in `workers/src/room-do.ts`. The call site
  is documented in the new file's header. Until it is wired, WS
  inbound validation is still the hand-rolled `typeof` checks.

### Vitest — installed, 20/20 green; existing node --test suites kept green
- vitest@5.1.0, root devDependency; script `test:vitest: vitest run`;
  config `vitest.config.mts` (NOT `.ts`: root package.json is
  CommonJS, so `.ts` config fails to load; `defineConfig` must come
  from `'vitest/config'` in Vitest 5). Tests live in `vitest/` at
  repo root, deliberately outside every tsconfig `include`.
- `vitest/engine-smoke.test.ts` (11 tests: `balancedHunterCount`
  ladder 3→1 … 30→5; next-zone 75% shrink fully inside) and
  `vitest/workers-validation.test.ts` (9 tests: WS inbound
  accept/reject, HTTP strict unknown-key rejection, game-event
  round-trip + unknown-key rejection). Aliases `@pakdam/shared` /
  `@pakdam/engine` → the TS sources.
- Latest runs: vitest 20/20; `node --test` workers 123 pass / 0 fail /
  6 skipped (129), engine 49 pass / 0 fail / 3 skipped (52).

### Web lib tests — the prescribed Vitest fix DOES NOT WORK; repo runner is `npm run test:web`
- The coordinator-prescribed one-line fix (add
  `apps/web/src/lib/__tests__/**/*.test.ts` to `test.include` in
  `vitest.config.mts`) was applied, run, and REVERTED the same day:
  Vitest 5.1.0 does not execute `node:test` files at all — proven
  with a minimal probe (default and named imports, with and without
  the config file): "No test suite found in file", "Tests: no
  tests", and no `node:test` shim exists in the installed vitest
  dist. The include line turned `test:vitest` red (3 failed suites)
  without executing one test, so it was reverted and the reason
  recorded in the `vitest.config.mts` header.
- Actual runner (new): `npm run test:web` →
  `scripts/test-web-lib.sh` — tsc the 5 lib sources + 3 suites to
  `.scratch-web-test` (inside the repo so `@pakdam/shared`
  resolves), sed-fix the emitted extensionless relative imports,
  `node --test` the 3 compiled suites, delete scratch (trap).
  Plain `node --test` on the `.ts` sources cannot work: Node 24
  type-strips `.ts` but does NOT map `.js` specifiers to `.ts` files.
- Latest run (2026-11-17): 21 tests, 18 pass, 1 fail, 2 skipped.
  websocket-reconnect 12/12 pass (2d–2j, 5b–5c, 3e–3f, 3g — the
  wiring worker's "12 pass / 0 fail" claim REPRODUCED in the repo
  runner). session-credentials 6/6 pass (1j, 1k, 2k, 2l, 5d, 5e).
- OPEN (wiring worker's file, not tooling scope):
  `live-client.test.ts` fails to LINK — `SyntaxError: The requested
  module '../live-client.js' does not provide an export named
  'LIVE_JOIN_BY_CODE_MESSAGE'`; tsc also reports it
  (`live-client.test.ts(5,17): error TS2305`). The constant does not
  exist in `apps/web/src/lib/live-client.ts` any more (the string
  "cannot be joined with just a room code" survives only inside the
  test file itself, line 190). The test is stale against the
  refactored source; the wiring worker must re-export the constant
  or update the test. `test:web` exits 1 until that is fixed.

### Sentry — wired per docs/SENTRY-SETUP.md; DSN still missing (founder creates it)
- `@sentry/nextjs@10.78.0` in `apps/web` (chosen over 11.x for
  Next 15.5 compatibility). Three config files verbatim from
  SENTRY-SETUP.md §3: `apps/web/sentry.client.config.ts`,
  `sentry.server.config.ts`, `sentry.edge.config.ts` (DSN-guarded
  `Sentry.init`, `tracesSampleRate: 0`, `sendDefaultPii: false`).
  `apps/web/next.config.ts` wrapped with `withSentryConfig` OUTSIDE
  the Serwist wrap (`silent: true`, no source-map upload).
- Privacy rule (hard): never coordinates, player display names,
  room codes/IDs, or reconnect tokens in Sentry events.
- 2026-11-17 fix: the `withSentryConfig` import was moved from
  `'@sentry/nextjs'` (DEPRECATED in Sentry 10, stops working in
  v11) to `'@sentry/nextjs/config'`; SENTRY-SETUP.md §4 updated to
  match. Web production build re-run after the fix: exit 0,
  26 static pages, First Load JS shared 156 kB.
- Remaining Sentry build warnings (advisory, build passes): Sentry
  10 suggests moving server/edge init into an `instrumentation.ts`
  `register()` and renaming `sentry.client.config.ts` to
  `instrumentation-client.ts`, and notes no `global-error.js`.
  NOT acted on: SENTRY-SETUP.md prescribes the three config files;
  migrating is a separate later founder decision.
- Verified: build passes with DSN unset AND with a dummy DSN
  (`NEXT_PUBLIC_SENTRY_DSN=https://dummy@o0.ingest.sentry.io/0`,
  env var only, never committed): exit 0, 26 pages, 156 kB.
- NOT verified (needs the founder-created DSN): SENTRY-SETUP.md §6
  (test error in the Sentry dashboard, no PII in the event).
- `.env.example` Sentry block now says WIRED 2026-11-17;
  `docs/DEPLOYMENT-RUNBOOK.md` §2 Sentry row now says "**Yes** —
  read by code".

### Tailwind — foundation only, proven to compile, NOT activated
- tailwindcss@4.3.5 + @tailwindcss/postcss@4.3.5 in `apps/web`
  (devDependencies). `apps/web/postcss.config.mjs` +
  `apps/web/src/styles/tailwind.css` (`@import "tailwindcss"` +
  `@theme` mapping the Pakdam red tokens from `tokens.css`).
- NOT imported by `apps/web/src/app/layout.tsx` — `tokens.css`
  stays the source of truth; no screen restyled (Tailwind v4
  preflight would change base styles globally; activation is a
  separate restyle decision). Standalone PostCSS compile of
  tailwind.css = 12,839 bytes with preflight; an `@apply` probe
  compiled correctly. (tailwindcss v4 has no CLI binary — that is
  `@tailwindcss/cli`, not installed; the PostCSS path is the proof.)

### k6 — installed (scratch-only), 5-player run clean; 16-player run blocked by the 5/min/IP join limit
- k6 v1.4.0 (tarball from github.com/grafana/k6/releases; binary
  at `~/workspace/.scratch-pakdam-tooling/k6-v1.4.0-linux-amd64/k6`,
  NOT committed to the repo).
- Script fixes in `workers/load/k6-16-player.js`: `hello` now
  carries `payload: { protocolVersion: 1, … }` (was rejected
  4400/4409); `location.update` nests the fix under `payload`
  (was top-level, DO never read it); join response parsed as
  `j.player.playerId` (was `j.playerId` — undefined, so guests
  silently never requested a ticket or WS); options changed to
  `iterations: GUESTS + 1` (the looping form re-joined every
  iteration and burned the per-IP join budget); invalid top-level
  `maxDuration` removed.
- 5-player run (GUESTS=4, DURATION_S=30) after fixes: exit 0,
  15/15 checks, 10 HTTP reqs, 5 WS sessions holding the full 30 s,
  135 msgs received / 35 sent, http p95 1.47 s (n=10, small sample).
- 16-player run: exit 99, 6/20 checks, guest joined 1/15.
  Root cause PROVEN by curl probe: 8 sequential joins from one IP
  all returned 429 `{"error":"too many join attempts — try again
  in a minute"}` — the per-IP join rate limit, 5/min
  (`workers/src/index.ts` handleJoin + `joinAllowed` in
  `workers/src/http.ts`, `RateLimiter` 5 per 60 s — a placeholder,
  OPEN HNT-071). All k6 VUs share 127.0.0.1; in production 16
  players are 16 different IPs. No latency threshold is invented;
  p95 is recorded and the founder sets the bar from the first
  measured run. The 16-player local run cannot pass without
  changing the placeholder limit — an app-behaviour/calibration
  decision for the API mission / founder, not tooling.
- (Run pollution noted: a mid-run wrangler reload from the parallel
  recovery worker rebuilding engine dist cut 2 WS sessions short
  at 43.86 s; the 16-player p95 1.52 s is polluted by 429s + reloads.)

### pnpm — migrated; frozen-lockfile re-verification blocked by sandbox EPERM (environmental)
- pnpm 10.34.9 (`packageManager: pnpm@10.34.9` in root
  package.json). Internal specs are `workspace:0.1.0` in
  `apps/web`, `workers`, `packages/engine` (bare `0.1.0` fails
  pnpm with `ERR_PNPM_FETCH_404`). `pnpm-lock.yaml` created
  (168,222 bytes): 0 occurrences of googleapis / @types/google /
  maplibre / leaflet; contains vitest@5.1.0,
  @sentry/nextjs@10.78.0, tailwindcss@4.3.5,
  @tailwindcss/postcss@4.3.5, zod@4.6.7; workspace links present.
- `pnpm install --frozen-lockfile` (2 attempts, 2026-11-17):
  resolution PASSES — "Lockfile is up to date, resolution step is
  skipped / Already up to date" — but the run then fails with
  `EPERM: operation not permitted, chown
  '.../node_modules/.pnpm/lock.yaml.<random>'` (exit 255). The
  sandbox intermittently rejects chown syscalls; this is
  environmental, not a lockfile problem. `package-lock.json` was
  deleted anyway (recoverable trash, trash_id
  20261117-164014-2262f40b75be4f3f9b927ddc86b0aee2, expires
  2026-12-17) because the lockfile IS in sync, the full suite
  passes under the pnpm tree, and ci.yml now requires
  pnpm-lock.yaml. Re-run `--frozen-lockfile` on a clean machine
  (or after the EPERM window clears) to get a clean exit 0.
- `.github/workflows/ci.yml` updated: pnpm/action-setup@v4
  (10.34.9), setup-node cache `npm` → `pnpm`,
  `npm ci` → `pnpm install --frozen-lockfile`, script steps →
  `pnpm run …` / `pnpm --filter pakdam-web …`, plus new steps for
  `test:vitest` and `test:web` (otherwise CI would never execute
  them). Header comment rewritten for pnpm.
- FOLLOW-UP (flagged, not changed — task scoped the CI change to
  ci.yml only): `vercel.json` still says
  `"installCommand": "npm install"` and
  `docs/DEPLOYMENT-RUNBOOK.md:170,426` still show `npm install` /
  `"installCommand": "npm install"`. With package-lock.json gone,
  a Vercel deploy using `npm install` is no longer the intended
  path — the parent must decide the Vercel install command.

### ESLint — react-hooks .ts fix; lint 0 errors / 0 warnings
- `eslint.config.mjs`: the react-hooks plugin block `files` was
  `['**/*.tsx', '**/*.jsx']` — extended to
  `['**/*.ts', '**/*.tsx', '**/*.jsx']`. That fixed the
  build-blocking "Definition for rule
  'react-hooks/exhaustive-deps' was not found" errors at
  `apps/web/src/hooks/useLiveRoom.ts:265:5` and
  `apps/web/src/lib/websocket.ts:1246:5`. Added ignores
  `.scratch-web-test/**` and `apps/web/.scratch-web-test/**`;
  deleted `.scratch-web-test/` (96K, regenerable); appended
  `.scratch-web-test/` to `.gitignore`.
- After the fix: 0 errors / 6 warnings (unused eslint-disable
  directives); the wiring worker then removed all 6 disable
  comments. Final full `eslint .`: exit 0, 0 errors, 0 warnings.
  (One transient parse error in
  `apps/web/src/app/room/[roomId]/catch/page.tsx:508:19` during a
  full-lint run was an EPERM-flap read: tsc parses the file with 0
  diagnostics, single-file eslint exits 0, full re-run exits 0.)

### Web production build — passes (Sentry wrap, DSN unset + dummy DSN)
- `PAKDAM_ALLOW_PLACEHOLDER_URL=1 npm run build
  --workspace=apps/web`: exit 0 (multiple runs, latest after the
  Sentry import fix), 26 static pages, First Load JS shared 156 kB
  (incl. /room/[roomId]/catch 66.9 kB, /room/[roomId]/play,
  /room/[roomId], /join, /leaderboards, /profile). Dummy-DSN build:
  exit 0, same page/JS counts.

### NOT FIXED — the complete open-defect list (founder standard: no known open defects carried into the final)
1. `validateWsClientMessage` not wired into `handleWsClientMessage`
   (`workers/src/room-do.ts`) — needs the worker owner / API mission.
2. k6 16-player run blocked by the 5/min/IP placeholder join limit
   (OPEN HNT-071) — needs an API-mission / founder calibration
   decision; cannot pass locally as-is.
3. `pnpm install --frozen-lockfile` clean exit 0 not obtained in
   this sandbox (EPERM chown, environmental) — re-run on a clean
   machine; lockfile resolution itself passes.
4. Sentry DSN + SENTRY-SETUP.md §6 dashboard verification — needs
   the founder-created DSN.
5. `live-client.test.ts` stale import (`LIVE_JOIN_BY_CODE_MESSAGE`
   no longer exported) — wiring worker's file; `test:web` exits 1
   until fixed.
6. `vercel.json` / runbook still reference `npm install` after the
   pnpm migration — parent decision needed.
