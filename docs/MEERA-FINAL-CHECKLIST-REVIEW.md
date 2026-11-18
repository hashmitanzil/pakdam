# Meera — Final Checklist Review (independent)

**Reviewer:** Meera (independent reviewer)
**Date:** 2026-11-17 (evening IST, after the final-verification report)
**Brief (only authoritative source):** `pakdam-final-checklist-2026-11-17.md`
**App:** `~/workspace/goals/hide-and-seek-combo-game/files/pakdam-app/` (Next.js 15.5.29)
**Method:** read, run, report only. No app source was modified. Every number
below is from my own runs or my own source reads in this session; nothing is
taken from a summary on trust. Where a claim could not be re-run here, that is
stated plainly instead of claimed as tested.

## Verdict: NEEDS FIXES

The core game loop is real and proven (my own 16-step Node playthrough,
fresh room ARY2CZ, all steps passed), and every re-runnable check is green:
typecheck 4/4, lint 0/0, unit 178 pass / 0 fail / 9 skipped (reconciled),
vitest 21/21 (replicated), test:web 34/34 (verified against current source),
production build artifacts serve 28/28 routes × 200, k6 log shows 48/48.
But the founder-approved final checklist is the bar, and **seven checklist
items are missing from the product** (defects D-M1–D-M7 below): voice radio
is absent everywhere; Change-room-code and the Precise/Approximate permission
display are absent everywhere; and on the **live (Worker/DO) path — the
production path** — lobby settings changes, host remove, Tell everyone, and
live radio do not work (the demo store has them; the live backend has no
endpoints for them). On top of that, the Playwright suite (14 passed /
159 failed of 173, with 12 confirmed genuine DOM assertion failures) could
not be re-run or triaged by execution here — no browser launches in this
sandbox — so the DOM/layout/phone-width evidence is still open. READY would
require the D-M1–D-M7 fixes (or a founder decision deferring them) plus a
clean Playwright re-run on CI.

## 0. Environment limits that shaped this review (read first)

This sandbox is in an **EPERM-write wave**: child processes' `write()`
calls fail (`EPERM: operation not permitted, write`). Observed in this
session, repeatedly:

- `npm run typecheck` dies inside npm itself (its own log-file write).
  Workaround used: direct `./node_modules/.bin/tsc` — no writes, works.
- `node --test` on the engine suite: `ws-protocol.test.js` fails at
  module load on a top-level `writeFileSync` (dist line 25). See §3.
- Vitest cannot start at all: Vite bundles its config to a temp file
  (EPERM), with the stock `.mts` config and with a plain-JS config alike.
  See §4.
- `scripts/test-web-lib.sh`: tsc emit to scratch fails with TS5033 on
  all 9 files. See §5.
- `npx -y pnpm@10.34.9 install` fails inside npx (npm log write).
  See §8.
- `next start` needs `PAKDAM_ALLOW_PLACEHOLDER_URL=1` in the
  environment or it refuses to boot (config guard, working as designed).
  See §6.
- **No browser launches here.** Three variants tried (headless shell,
  full Chromium `chromium-1255/chrome-linux64/chrome`, single-process /
  no-zygote): all die immediately with `browserType.launch: Target page,
  context or browser has been closed`. No system Chrome/Firefox exists.
  The Playwright suite and any browser playthrough are therefore
  **NOT done** in this review. See §7.

The file tool uses a different write path and works, which is how the
in-memory bypasses below were built (all in `/tmp`, app source untouched).

## 1. Typecheck — VERIFIED 4/4

Direct `tsc` (bypassing the EPERM-blocked npm wrapper), each `--noEmit`:

| Workspace | Command | Result |
|---|---|---|
| shared | `tsc -p packages/shared/tsconfig.json --noEmit` | exit 0, no errors |
| engine | `tsc -p packages/engine/tsconfig.json --noEmit` | exit 0, no errors |
| workers | `tsc -p workers/tsconfig.json --noEmit` | exit 0, no errors |
| web | `tsc -p tsconfig.json --noEmit --incremental false` (from `apps/web`) | exit 0, no errors |

Claim "typecheck 4/4" **verified**. Note: the web run needs
`--incremental false` (its tsconfig writes a `.tsbuildinfo`, blocked by
EPERM) — same workaround the verification report used.

## 2. Lint — VERIFIED 0/0

`./node_modules/.bin/eslint .` → exit 0, no output (0 errors, 0 warnings).
Claim "lint 0/0" **verified**.

## 3. Unit tests (`node --test`, engine + workers dist) — VERIFIED 178 / 0 / 9 (reconciled)

My direct runs:

- Engine: `node --test packages/engine/dist/test/*.test.js` →
  **48 tests counted, 44 pass, 1 fail, 3 skipped**. The 1 fail is the
  whole `ws-protocol.test.js` file failing at load:
  `Error: EPERM: operation not permitted, write` at
  `packages/engine/dist/test/ws-protocol.test.js:25`
  (`writeFileSync(compiledPath, transpiled)` — the test transpiles the
  web WS client and writes it to a temp file). Environmental, not an app
  defect. That file holds **5 tests**
  (`packages/engine/test/ws-protocol.test.ts`, 5× `test(`), so the
  engine total is 52 (16 + 5 + 7 + 3 + 5 + 5 + 11 across the 7 files).
- Workers: `node --test workers/dist/test/*.test.js` →
  **135 tests, 129 pass, 0 fail, 6 skipped**. Matches the report exactly.
- Three re-runs of the ws-protocol file alone all failed identically at
  the same `writeFileSync` (EPERM wave still closed).

To verify the 5 un-executed tests, I ran an exact copy of the compiled
test with the temp-file write replaced by a `data:` URL import
(`/tmp/meera-ws-protocol-check.mjs`, same 5 tests, same assertions,
same `apps/web/src/lib/websocket.ts` source): **5/5 pass**.
Reconciled total: 44 + 5 + 129 = **178 pass, 0 fail, 9 skipped
(3 engine + 6 workers), 187 total**. Claim **verified**, with two
caveats: (a) the as-shipped test file cannot run in a write-blocked
environment — harness weakness D-M13; (b) `packages/shared/dist/*` had
no 0-byte files in this session (the §7 repair held).

## 4. Vitest — 21/21 REPLICATED (runner itself cannot start here)

`./node_modules/.bin/vitest run` fails at startup, twice, identically:
`failed to load config from .../vitest.config.mts` →
`Error: EPERM: operation not permitted, write` at Vite's
`loadConfigFromBundledFile` (it bundles the config to a temp file). A
plain-JS config in `/tmp` fails the same way — Vite bundles every config.
The runner cannot execute a single test in this sandbox. This is
environmental, not a test failure.

Independent replication: I re-ran all 21 assertions under plain `node`
against the compiled dist — the exact tsc emit of the same sources
(`/tmp/meera-vitest-replica.mjs`): engine-smoke 11 (10 ladder cases
3→1, 4→1, 5→2, 8→2, 9→3, 16→3, 17→4, 24→4, 25→5, 30→5 hunters; plus
the 75% random-offset shrink sitting fully inside) and
workers-validation 10 (WS accept/reject incl. the junk-field case,
HTTP strict bodies, event round-trip). **21/21 passed.** The claim
"vitest 21/21" is **verified-by-replica**; a real `vitest run` still
needs a healthy machine/CI.

## 5. Web lib tests (`test:web`) — VERIFIED 34/34 (against current source)

The as-shipped `scripts/test-web-lib.sh` **cannot verify anything in
this sandbox**: tsc emit fails with `TS5033: Could not write file ...`
(EPERM) on all 9 files, and the `node --test` that follows then runs
whatever stale files survive in `apps/web/.scratch-web-test/` — in my
run it printed 4/4 file-level passes on stale emit from the verification
run, while the script itself exits 1 on the tsc failure. (My earlier
piped read of its exit code was tail's, not the script's — corrected
here: the script exits 1.) The per-suite ✔ output in that situation is
misleading; see harness weakness D-M12.

Independent verification: I bundled each of the 4 suites in-memory
with esbuild (`write: false`, `@pakdam/*` aliased to current TS source)
and imported the bundles from `data:` URLs so `node:test` executed them
(`/tmp/meera-testweb-driver.mjs`). Result: **34 tests, 34 pass,
0 fail** — websocket-reconnect 14, live-client 12,
session-credentials 6, demo-store-roles 2 (incl. both roles-stability
tests). Claim "test:web 34/34" **verified against current source**.
The D1-adjacent WS-wiring behaviour and the demo-store roles fix are
covered by these passing suites.

## 6. Production build + HTTP sweep — VERIFIED (artifacts + serving)

- `apps/web/.next/BUILD_ID` reads **`MEwm2yRbhLVDlOZHxi9Sp`** — matches
  the claimed build #2 ID.
- `apps/web/package.json` Next.js is **15.5.29**; the build log on file
  (`pakdam-final-verification-2026-11-17/production-build.log`, build #1)
  shows `Generating static pages (26/26)`, First Load JS shared 156 kB,
  26 page routes. The build #2 log is 0 bytes (EPERM, as reported), so
  the "26 pages" count for build #2 itself is not re-provable from a
  log. What is provable: the current `.next` holds **22 prerendered
  `.html` files** (plus the 5 dynamic routes `/join/[code]`,
  `/room/[roomId]`, `/catch`, `/play`, `/results` rendered on demand,
  and `/robots.txt` + `/sitemap.xml` route handlers). I did **not**
  re-run `next build` (it writes heavily; EPERM would kill it).
- HTTP sweep, my own run against the served build #2 (port 3105,
  `PAKDAM_ALLOW_PLACEHOLDER_URL=1 next start`; without that var the
  server refuses to boot — see §0): **28/28 routes × 200** —
  `/`, `/about`, `/accessibility`, `/admin`, `/contact`, `/create`,
  `/faq`, `/game-modes`, `/grievance`, `/help`, `/host`, `/how-it-works`,
  `/install`, `/join`, `/leaderboards`, `/legal`, `/legal/community`,
  `/legal/privacy`, `/legal/terms`, `/profile`, `/safety`,
  `/join/ABC123`, `/room/<uuid>`, `/room/<uuid>/play`,
  `/room/<uuid>/catch`, `/room/<uuid>/results`, `/robots.txt`,
  `/sitemap.xml` (uuid `d6f899f0-4c23-4791-9693-2ba412316158`).
  The claim was 27/27; my sweep is a superset (28 routes, all 200),
  so the claim is **verified and superseded**. Server stopped afterwards
  (port 3105 confirmed down, no `next-server` process left).
- k6: **not re-run** (needs `wrangler dev` + k6). Log-verified only:
  `pakdam-final-verification-2026-11-17/pakdam-k6-16p.log` lines
  212–214 show `checks_total 48`, `checks_succeeded 100.00% 48 out of
  48`, `checks_failed 0`; `http_req_duration p(95)=590.04ms`;
  `ws_msgs_received 2871`, `ws_msgs_sent 200`, `ws_sessions 16`.
  Matches the claimed 48/48 exactly.

## 7. Playwright — NOT RUN HERE; source-based triage only

### 7.1 The 14/159 split is not reproduced

The full suite did not run in this session: Chromium cannot launch
(§0). `apps/web/test-results/` now holds only the 5 host-setup dirs
left by the verification run's retries — the 159 per-test dirs are
gone, exactly as the verification report said. Per-spec counts cannot
be reconstructed. The 14/159 split stands **unconfirmed either way**.

### 7.2 Triage of the 12 readable failure strings (source reads)

| # | Quoted failure | App source | Triage |
|---|---|---|---|
| 1–2 | Summary strip `3.0 km zone · 1 hunter · 3 min pulse · 1 h 30 min` not visible; Match summary missing `1 h 30 min` | `apps/web/src/components/host-setup/draft.ts:122` `formatMinutes(90)` → `"1 h 30 min"`; `:151` `roomSummaryStrip` builds exactly `"<dist> zone · <n> hunter(s) · <ping> pulse · <dur>"`; `apps/web/src/components/match/freshness.ts:168` `formatDistance(3000)` → `"3.0 km"` | **App text verified correct.** The app can render the exact expected string. The failure is in *reaching* that state via the steppers/slider (e.g. radius slider to 1500 m, duration stepper 60→90), not in copy. Needs CI re-run with per-step context. Not an app defect on current evidence. |
| 3 | `Link Guest` not visible | `apps/web/e2e/join-lobby.spec.ts:33,37` fills display name `Link Guest` on `/join/<code>` and expects it in the lobby; the lobby renders player display names (`apps/web/src/app/room/[roomId]/page.tsx` roster) | **Flow failure, not copy.** The invite-link join did not complete (or the lobby did not re-render) in the test run. Needs CI re-run. |
| 4 | Lobby radio `Let's go!` not visible | The string `Let's go!` / `let's go` occurs **nowhere** in current `apps/web/src` or `apps/web/e2e` (case-insensitive grep, zero hits). Current mode radios are Classic / Infection (`apps/web/e2e/host-setup.spec.ts:30-31`) | **Untraceable / stale test copy.** No current test asserts it and no app element carries that label. Cannot be an app defect on current evidence. |
| 5 | Ping-history `Shaded blue areas:` not visible | `apps/web/src/components/map/MapLibreMapView.tsx:242` renders it **only when `pingAreas.length > 0`** | **Flow/timing, not copy.** No ping areas materialised in the test run, so the line legitimately does not render. Needs CI re-run. |
| 6 | Map canvas `.mapbox .maplibregl-canvas` not visible | **Correction to the verification report:** the app is **not** Leaflet-based. It is vendored MapLibre v5 (`apps/web/src/components/map/MapLibreMapView.tsx:228` `<div className="mapbox">`, `:5-13` imports `loadMapLibre` from `./maplibre`; `apps/web/public/offline-map/vendor/maplibre-gl.js` + `maplibre-gl.css` on disk; 808 tiles in `public/offline-map/tiles/`). The selector matches the app's own markup exactly | **No test/app drift — the selector is correct.** The canvas never became visible, i.e. map init failed in the headless run (WebGL unavailable, vendored script/tile load, or hydration gate) — or a real map defect. Cannot distinguish here; needs CI re-run with WebGL. |
| 7 | `GPS accuracy ±8 m` not visible | `apps/web/src/components/match/ZoneEditor.tsx:151,267` renders `GPS accuracy ±{Math.round(...)} m` when a good fix lands; `apps/web/e2e/map-accuracy.spec.ts:57-58` sets geolocation accuracy 8 and expects it | **Flow/environment, not copy.** The good fix never landed in the test run (geolocation chain / hydration timing). Needs CI re-run. |

Net: **none of the 12 is proven to be an app copy defect**; the
summary-strip strings are verified correct in source; the map-selector
drift hypothesis in the verification report is **rejected** (app is
MapLibre, vendored — see D-M14). The failures are flow / timing /
environment candidates. But that is not an exoneration: 12 genuine DOM
assertion failures plus 147 unexamined ones is an open verdict, and it
cannot be closed from this sandbox.

### 7.3 Browser playthrough — NOT DONE (blocked, with evidence)

Attempted in this session, all against the served build #2 on :3105:
headless shell, full Chromium, single-process/no-zygote — all fail at
launch (§0). No system Chrome/Firefox. **No multi-context playthrough,
no taps, no map-tile check, no QR-camera scan, no phone-width layout,
no 130% zoom check was performed.** Do not treat this review as having
covered the browser. (Note: the repo's own
`apps/web/playwright.config.ts` header says TEXT/DOM assertions only,
no screenshots — the gateway rule — so a screenshot playthrough would
also cut against the project's own suite rule.)

## 8. The six tooling defects (D1–D6) — re-checked from source

- **D1 — WS validator wiring: CLOSED, verified.** `workers/src/room-do.ts:9`
  imports `validateWsClientMessage`; `:1882-1884` calls it inside
  `handleWsClientMessage` and returns `VALIDATION_FAILED` on failure.
  `workers/src/lib/validation.ts:21-25` documents the deliberate
  `z.object` (not `strictObject`) choice; `:53,69-70` use `z.object`.
  Covered by the workers suite (129 pass) and my vitest replica
  (junk-field case passes).
- **D2 — stale live-client import: CLOSED, verified.** The only mention
  of `LIVE_JOIN_BY_CODE_MESSAGE` in
  `apps/web/src/lib/__tests__/live-client.test.ts` is the comment at
  `:193` saying it is NOT re-added. The 12 live-client tests pass in
  my §5 run.
- **D3 — k6 16-player join limit: CLOSED, verified in source.**
  `workers/src/rate-limit.ts:42` `parsePerMinuteLimit`;
  `workers/src/index.ts:142,235,275,345` env vars
  `PAKDAM_*_PER_MINUTE` with fallback 5; production default unchanged
  (5/min/IP). k6 itself log-verified (§6), not re-run.
- **D4 — pnpm frozen lockfile: lockfile in sync (not re-proven to exit
  0).** `apps/web/package.json:27` has `"serwist": "^9.5.15"`;
  `pnpm-lock.yaml` carries the serwist importer entries
  (`apps/web` importer, `serwist:` lines). But a clean `pnpm install
  --frozen-lockfile` exit 0 is **still unobtainable here** — `npx`
  itself dies on EPERM before pnpm starts. Remains OPEN for a clean
  machine / CI (see §11).
- **D5 — vercel.json / runbook installCommand: CLOSED, verified.**
  `vercel.json` has `"installCommand": "pnpm install
  --frozen-lockfile"`; `docs/DEPLOYMENT-RUNBOOK.md:170,426` and
  `README.md:31,88` match. Note: `vercel.json` `buildCommand` is still
  `"npm run build"` and root `package.json` scripts still call
  `npm run … --workspace=…` — flagged in the verification report §8.6,
  unchanged.
- **D6 — Sentry DSN: CLOSED as far as possible without the founder,
  verified.** No `.env*` files exist; `NEXT_PUBLIC_SENTRY_DSN` is
  unset in the environment; `apps/web/sentry.client.config.ts:2,6-8`
  initialises Sentry only when the DSN is set (inert otherwise). The
  dashboard check (SENTRY-SETUP.md §6) remains OPEN — needs the
  founder-created DSN (see §11).

## 9. Independent Node playthrough — 16/16 steps passed (fresh room)

I re-ran the full game loop with my own driver
(`/tmp/meera-playthrough-driver.mjs`, esbuild-bundled `demo-store.ts` +
`@pakdam/engine` from current source, in-memory localStorage stub) —
**not** the verification run's room BTFWUV. Fresh room **ARY2CZ**,
4-player Classic, Balance ON, Random ON:

1. create room — 6-char code, LOBBY, resolvable by code
2. join ×3 (Riya, Kabir, Meera), all ready
3. READY_CHECK → COUNTDOWN → HEAD_START — 1 Hunter (Meera), 3 Runners
4. HEAD_START → ACTIVE — same Hunter, clock started (`startedAt`/`endsAt` set)
5. role stability **5/5 fresh-room trials** HEAD_START→ACTIVE (the §4 fix holds)
6. pings — engine `buildPing` returns `recipientRole: 'hunters'`,
   150 m radius, age 0 s; fixes timestamped; **no player coordinates
   in localStorage** (only the zone boundary, by design — my first
   assertion was too broad and failed on the boundary's own lat/lng;
   the corrected structural check confirms fixes are absent)
7. outside zone — Kabir exits, event names the 30-second countdown
8. eject Kabir — `ejectedAt` set (engine: `OUTSIDE_ZONE_RETURN_SECONDS
   = 30`, `packages/shared/src/types.ts:146`; 29 s not due / 30 s due
   verified via `isOutsideZoneEjectionDue`)
9. QR catch requested on Arjun — `awaiting-confirmation`
10. QR token verifies on scan; wrong token rejected
11. QR-scanned catch confirmed (`qr-scan`)
12. safety pause → `SAFETY_PAUSED`
13. resume → ACTIVE
14. manual-confirm fallback on last Runner Riya — confirmed, no code backup
15. auto-complete — `COMPLETED`, `hunters-win`
16. round card — `Hunters win · Room ARY2CZ · Caught 2 of 3 ·
    Ejected: Kabir · Most tags: Meera (2) · Never caught: nobody`

The verification report's playthrough claims are **independently
reproduced** (different room code, same flow, same outcomes). NOT
covered (same limits as the verification run): DOM rendering, taps,
map tiles, the QR-camera scan, phone/tablet layout, 130% zoom, SOS
button taps, radio UI. The demo-store path was exercised; the live
Worker/DO path is covered by the workers unit tests, not by a live
playthrough.

## 10. Final-checklist re-grep — violations found

Scope re-checked by grep over `apps/web/src` (plus `packages/*`,
`workers/src` where relevant). Clean items first, then the defects.

### 10.1 Clean (verified, with evidence)

- **Classic + Infection only; no Zombie/Breach playable.** Only
  mentions are "later, not now" comments
  (`apps/web/src/components/landing/ModesPreview.tsx:3`,
  `apps/web/src/components/host-setup/HostSetupForm.tsx:31`) and the
  legal-privacy "breach notification" text (a legal term, not a mode).
  Infection exists in `packages/engine/src/modes.ts:26` and in host
  setup (`HostSetupForm.tsx:171`).
- **No demo route, no demo timers, no demo mockup.** No `/demo`
  route. `addDemoPlayers` has no callers outside `demo-store.ts`
  (dead helper, not UI). User-visible "Demo game" / "Demo mode — no
  server configured" banners (`apps/web/src/app/create/page.tsx:95`,
  `apps/web/src/app/room/[roomId]/play/page.tsx:716`) appear only when
  `NEXT_PUBLIC_WORKER_URL` is unset — i.e. not in a live deployment.
  Observation only, not a violation.
- **No catch code.** No one-time/typed catch code anywhere
  (`apps/web/src/app/room/[roomId]/catch/page.tsx:120`,
  `apps/web/src/components/catch/CatchPanel.tsx:20`,
  `apps/web/src/lib/demo-store.ts:305-307` — "There is NO typed code
  in Pakdam"). QR scan + manual-confirm + host dispute only. Minor
  wording note D-M11 below (`freshness.ts:86` says "the Runner's
  code").
- **Outside-zone 30 s countdown then ejection only.** Consistent
  everywhere: `apps/web/src/app/page.tsx:109`,
  `apps/web/src/app/game-modes/page.tsx:25,39`,
  `apps/web/src/app/room/[roomId]/play/page.tsx:954`,
  `packages/shared/src/types.ts:146` (`OUTSIDE_ZONE_RETURN_SECONDS =
  30`). No "hunters see you live" / "2 minutes — you're tagged"
  wording found in the app. The old contradictory line is gone.
- **Guest only; no sign-in.** Zero matches for sign-in / log-in /
  password in `apps/web/src` UI. Join is display-name only
  (`apps/web/e2e/join-lobby.spec.ts:7-18` asserts no password/email
  fields on `/join`).
- **No nearby rooms / Find-a-Room.** Only mention is the landing page
  stating "no public lobbies, no nearby-rooms list"
  (`apps/web/src/app/page.tsx:105`). `listRooms` is used by
  `/host`, `/admin`, `/leaderboards` for the user's **own** on-device
  rooms only, not discovery.
- **3–30 players.** `packages/shared/src/validation.ts:19`
  (`maxPlayers: { min: 3, max: 30 }`), `:59` (`maxPlayers must be
  3–30`); lobby `MIN_PLAYERS = 3`
  (`apps/web/src/app/room/[roomId]/page.tsx:387`).
- **No lat/lng numbers in UI.** All `lat`/`lng` matches in `.tsx`
  files are code (refs, props, fix objects, distance/bearing maths);
  no component renders raw coordinates as text. Distances render as
  metres/kilometres, bearings as words, ages as `0:27 ago`.
  Zone centre reads `set` / `not set yet`
  (`apps/web/src/components/match/ZoneEditor.tsx:296`), never numbers.
- **No payment / membership / Pro / paywall.** Zero UI matches; the
  only "membership" hit is a code comment about result membership
  (`apps/web/src/app/room/[roomId]/results/page.tsx:40`).
- **Zone centred on real GPS; manual pin fallback; GPS accuracy shown.**
  `apps/web/src/components/match/ZoneEditor.tsx:150` centres on the
  GPS fix; `:207` tap-the-map manual pin; `:223-224` arrow-key pin
  moves; `:263,266` "Finding your location…" waiting state;
  `:151,267` "GPS accuracy ±X m". Play page `:790` shows the same
  waiting state. Zone centre is `null` until a fix or a tap
  (`ZoneEditor.tsx:58,186,296`) — **no default zone centre**.
  Next zone is PUBG-style random offset: engine
  `packages/engine/src/zone.ts:272` `randomOffsetShrinkBoundary`
  (my vitest replica: a 75% shrink sits fully inside); the shrink
  schedule is pre-computed at creation
  (`apps/web/src/components/host-setup/draft.ts:216-225`, "only the
  position is random") and enforced by the server by elapsed time
  (`workers/src/room-do.ts:898`); preview + countdown bar in
  `apps/web/src/components/match/NextZonePanel.tsx:41,59`. Nuance:
  the random draw happens in the host client at creation, not in the
  DO per shrink — the DO stores and enforces the schedule. See §10.3.
- **Role reveal, head start, SOS, pause, results, round card,
  leaderboards opt-in, presets — present.** Role reveal "No peeking /
  Tap to find out your role"
  (`apps/web/src/app/room/[roomId]/play/page.tsx:795-798`); "Runners
  are hiding" head-start screen
  (`apps/web/src/app/room/[roomId]/play/page.tsx:760`);
  SOS always-visible safety bar
  (`apps/web/src/components/match/SafetyControls.tsx:3,18`); pause
  freezes the server clock and shifts `endsAt` on resume
  (`workers/src/room-do.ts:657,830`); results + `RoundCard` +
  text-only trail card (`apps/web/src/app/room/[roomId]/results/page.tsx:6-7,326`);
  leaderboards opt-in only
  (`apps/web/src/app/leaderboards/board-client.tsx:18,163`);
  points `+1 per 3 min free, +10 never caught, +3 per tag, +10 clean
  sweep` (`board-client.tsx:21-22`); house-rule presets
  (`HostSetupForm.tsx:64` quick/standard/big-park/custom).

### 10.2 Defects (checklist items missing — NEEDS FIXES)

**D-M1 — Voice radio is absent (all modes).**
Checklist: "Radio — Team Radio, text and voice; voice messages up to
10 seconds". `apps/web/src/components/radio/TeamRadio.tsx:68-71`:
"Voice push-to-talk is NOT available in this web (PWA) version …
there is no voice relay or transport in the worker or the demo store
to carry a clip to the team, so voice is Phase 1"; `:179-182`
renders "Text only in this web version. Voice push-to-talk is not
available in the PWA … Voice is Phase 1 (native)". No voice code in
`workers/src` either (grep: zero hits). No founder deferral of voice
is on record in `docs/DECISIONS.md` or `docs/STATUS.md` (grep: zero
hits). Text radio exists; voice does not exist anywhere.

**D-M2 — No Change / regenerate room code (all modes).**
Checklist (Lobby): "Big room code, Copy and Change; share code".
The lobby renders Copy code, Share code, Copy invite link, Settings
(`apps/web/src/app/room/[roomId]/page.tsx:683-686`) — no Change
control. No regenerate function exists anywhere in `apps/web/src`
(grep `regenerat|new room code|change.*room code`: zero relevant
hits); the settings sheet has no code control; `updateRoomConfig`
never touches `roomCode` (`apps/web/src/lib/demo-store.ts:62`
assigns the code once at creation).

**D-M3 — Location permission Precise / Approximate is not displayed
(all modes).** Checklist (Lobby): "Game mode shown, location
permission Precise / Approximate". Mode is shown
(`apps/web/src/app/room/[roomId]/page.tsx:749`). But `Precise`
appears nowhere in game UI (only admin/privacy/faq pages) and
`Approximate` appears only in ping-area labels
(`apps/web/src/app/room/[roomId]/play/page.tsx:105,113,586`). No
lobby (or play/create) surface shows the room's location permission.

**D-M4 — Lobby settings cannot be changed after creation (LIVE only).**
Checklist (Lobby): "settings to change rules again".
`apps/web/src/app/room/[roomId]/page.tsx:83` `SETTINGS_LIVE_NOTE`:
"Settings can't be changed from the live lobby yet — they were fixed
when the room was created. The live server has no settings-update
endpoint."; `:686` shows the note instead of the settings sheet in
live mode. `:84` `HUNTERS_LIVE_NOTE`: Balance / Random / Hunter count
/ host picks cannot change from the live lobby either. Demo mode can
change settings; live cannot.

**D-M5 — Host cannot remove a player (LIVE only).**
Checklist (Safety): "host can remove from lobby".
`apps/web/src/lib/live-client.ts:24-30` documents it as NOT LIVE YET
("removing a player (no remove endpoint)"); the lobby wires remove
only when `mode === 'demo' && isHost`
(`apps/web/src/app/room/[roomId]/page.tsx:785`).

**D-M6 — Tell everyone has no live channel (LIVE only).**
Checklist (Safety): "Tell everyone — hold to show your location to
all players". `apps/web/src/app/room/[roomId]/page.tsx:85`
`REVEAL_LIVE_NOTE`: "Tell everyone has no live channel yet — no
position was shared." Demo only.

**D-M7 — Team Radio text does not reach other players (LIVE only).**
Checklist: "Team Radio, text and voice". The Radio tab exists in
live mode (`apps/web/src/components/hud/BottomTabs.tsx:42`), but
`apps/web/src/app/room/[roomId]/play/page.tsx:874` states: "Live
mode: Team Radio on this screen is still stored on this device only
(demo) — live radio is a separate wiring task and does not reach
other players yet." (Voice is absent everywhere — D-M1.)
Root cause shared by D-M4–D-M7: the live backend has no
config-update, remove-player, reveal-channel, or radio-relay
endpoints; the demo store has the features. The production path is
live, so these are launch-relevant, not demo-only trivia.

### 10.3 Observations (not defects — founder to rule)

- **O-1 — Map viewport starts at Doranda; one city name in map UI.**
  `apps/web/src/components/map/MapLibreMapView.tsx:49-52` and
  `apps/web/src/components/host-setup/PlayAreaMap.tsx:58-61`: "Centre
  of the bundled area (Doranda) — the map starts here when no
  location is set yet. There are no tiles for anywhere else."
  That is the map **viewport** default only; the **zone** stays
  un-centred (see §10.1). But `apps/web/src/components/map/maplibre.ts:69`
  `OUTSIDE_MAP_AREA_MESSAGE = 'Map downloaded for Ranchi only.'` is a
  user-visible string naming the city, against the checklist's letter
  ("no city name anywhere in the map UI"). The Ranchi-only offline
  map is itself a founder decision (2026-11-17 19:34), so the message
  is honest — the checklist wording and the message conflict. Founder
  to rule: reword the message, or amend the checklist.
- **O-2 — Radius capped at 1.5 km vs "unlimited past 1 km".**
  `ZONE_RADIUS_MAX_M` caps the circle radius at 1.5 km (zone ≤3 km
  across); `apps/web/src/components/host-setup/HostSetupForm.tsx:242`
  hint: "Radius 100 m–1.5 km, about 200 m–3 km across." The old 1 km
  cap is gone, but a 1.5 km cap remains. Likely acceptable (matches
  the zone-diameter validation), but the checklist says "unlimited".
  Founder to confirm.
- **O-3 — Next-zone randomness is drawn at creation, not by the
  server per shrink.** `apps/web/src/components/host-setup/draft.ts:216-225`
  pre-computes all shrink-phase boundaries with
  `randomOffsetShrinkBoundary`; the DO enforces the stored schedule
  (`workers/src/room-do.ts:898`). All clients agree and no client can
  change it mid-game, so "single source of truth" holds in practice —
  but the letter ("Server decides the next zone") is only half true:
  the host client draws the random positions. Acceptable for a
  personal game; record it, don't rebuild it.
- **O-4 — "Trails — your path on the map" is text-only.**
  `apps/web/src/components/hud/TrailCard.tsx`: the round card has
  "moments and counts only — no positions, no routes, no
  coordinates — because location data is deleted at match end"
  (HNT-069). No map-drawn trail exists. Checklist vs privacy rule
  tension — founder to rule.
- **O-5 — Demo-mode banners.** See §10.1. Not a violation, but the
  shipped app without a Worker URL presents itself as a "Demo game".
  Fine for the pilot (Worker URL will be set); keep it in mind for
  any no-server distribution.

### 10.4 Minor wording

- **D-M11 — `freshness.ts:86` says "the Runner's code".**
  `apps/web/src/components/match/freshness.ts:86` (CompassRadar
  Burning tier note): "A catch still needs the Runner's code and
  their confirmation." In a product with explicitly no catch code,
  "code" reads as a typed code; it means the Runner's QR code.
  Suggest "the Runner's QR code". Trivial fix, no behaviour change.

### 10.5 Harness / environment notes (not app defects)

- **D-M12 — `scripts/test-web-lib.sh` reports stale suites as passing
  when tsc emit fails.** When `tsc` exits non-zero (TS5033 here), the
  script continues to `node --test` on whatever is in the scratch dir
  and prints ✔ lines for it, even though it exits 1 overall. It
  should abort before `node --test` when the emit fails.
- **D-M13 — `ws-protocol.test.ts` writes a temp file at module load.**
  `packages/engine/test/ws-protocol.test.ts:26-27` (`mkdtempSync` +
  `writeFileSync`) makes the whole engine suite un-runnable in
  write-blocked environments. The 5 tests themselves pass (verified
  via a `data:` URL import, §3). Consider loading the transpiled
  client in-memory.
- **D-M14 — Correction to the verification report §6:** the report
  says "the app's map is Leaflet-based". It is not. It is vendored
  MapLibre v5 (§7.2, row 6). The `.mapbox .maplibregl-canvas`
  Playwright selector is correct for this app; the "possible test/app
  drift" hypothesis is rejected.

## 11. Known open items — re-checked

1. **Playwright triage (top priority):** still open. 14/159 unreproduced
   here; 12 failures source-triaged (§7.2); the rest unexamined.
   Re-run on CI (ubuntu-latest, per `ci.yml`) with a JSON reporter.
2. **Sentry dashboard:** still open — needs the founder-created DSN (§8 D6).
3. **HNT-071 calibration:** still OPEN
   (`workers/src/rate-limit.ts:1,12,31`, `workers/src/room-do.ts:1231`,
   `workers/src/index.ts:103,134` — 5/min/IP is a placeholder; the env
   override is a test lever, not a decision).
4. **pnpm clean exit 0:** still open — unobtainable in this sandbox
   (§8 D4). Needs a clean machine / CI.
5. **Stale docs — confirmed, unchanged:** `docs/CI.md:19` still shows
   `` `npm ci` `` (and mentions `package-lock.json`, which does not
   exist — the repo uses `pnpm-lock.yaml`); `docs/CLOUDFLARE-SETUP.md:67,94,422`
   still say `npm install`; `docs/SENTRY-SETUP.md:31` still says
   `npm install @sentry/nextjs`; `vercel.json` `buildCommand` is still
   `npm run build`; root `package.json` scripts still call
   `npm run … --workspace=…`.
6. **Not re-run here:** production `next build`, k6 load run, browser
   playthrough, phone-width layout, 130% zoom, map-tile painting,
   QR-camera scan. All need a capable machine / CI.

## 12. What would flip this to READY

1. Fix or founder-defer D-M1 (voice), D-M2 (Change code), D-M3
   (permission display), and the live gaps D-M4–D-M7 (or the endpoints
   behind them). D-M11 is a one-word fix.
2. Full Playwright suite re-run on CI with a JSON reporter; per-spec
   pass/fail; the 12 triaged failures (§7.2) re-checked against the
   fresh run, and the map-canvas failures re-checked with WebGL
   available.
3. pnpm clean exit 0 on CI + Sentry dashboard check once the founder
   DSN exists + HNT-071 calibration decision (tracked separately).
4. Founder rulings on O-1–O-4 (wording/scope, not code).

## Evidence files (this review; all in /tmp, ephemeral)

- `/tmp/meera-ws-protocol-check.mjs` — the 5 ws-protocol tests, data-URL
  import (5/5 pass).
- `/tmp/meera-vitest-replica.mjs` — all 21 vitest assertions vs dist
  (21/21 pass).
- `/tmp/meera-testweb-driver.mjs` — the 4 web-lib suites vs current
  source via in-memory esbuild (34/34 pass).
- `/tmp/meera-playthrough-driver.mjs` — independent 16-step playthrough,
  fresh room ARY2CZ (16/16 pass).
- `/tmp/meera-browser-probe.mjs`, `probe2`, `probe3` — Chromium
  launch attempts (all fail at launch).
- `/tmp/meera-vitest.config.mjs` — plain-JS vitest config attempt
  (still fails: Vite bundles every config).
