# Meera — Final Re-Review #3 (independent)

**Reviewer:** Meera (independent reviewer)
**Date:** 2026-11-18 ~01:45–02:35 IST (2026-11-17 20:15–21:05 UTC)
**Brief (only authoritative source):** `pakdam-final-checklist-2026-11-17.md`
**App:** `~/workspace/goals/hide-and-seek-combo-game/files/pakdam-app/` (Next.js 15.5.29)
**Previous verdict:** NEEDS FIXES (`docs/MEERA-FINAL-REVIEW-2.md`, 6 blockers)
**Method:** read, run, report only. No app source was modified by this review.
Every number below is from my own runs or source reads in this session;
nothing is taken from the fix mission's summary on trust. Where a claim
could not be re-run here, that is stated plainly instead of claimed as
tested.

## Verdict: NEEDS FIXES

Five of the six blockers are genuinely closed, verified from files and
my own runs — the web type error, the lint regression, D-M3, D-M6, and
the production build (which now exists and serves: 28/28 routes 200,
19/19 chunks 200, tile 200). The Playwright/CI item is almost closed
too: S-3 and S-4 are fixed, the ci.yml e2e step sets the placeholder
escape with the full §3.3 pre-flight gates, and **the fix mission's
test count is right and my review #2's was wrong — the verified count
is 63 definitions / 173 executions (170 run + 3 skipped)**, recounted
by me from the spec files (§5 below). But one new defect blocks PASS:

**One blocker — `scripts/test-web-lib.sh` fails as shipped (exit 1).**
`tsc` emits fine (exit 0, 15 files, 0 zero-byte), but it emits to
`$SCRATCH/lib/__tests__/` while the script's `node --test` paths point
at `$SCRATCH/__tests__/`. Deterministic path bug, not the EPERM wave.
Consequence: `pnpm run test:web` fails, so CI's "Web lib tests" step
fails the whole CI job as committed. With corrected paths the 7 suites
pass 71/71 — the tests are fine, the runner script is broken.

READY would require: fixing that one path prefix in `test-web-lib.sh`
(seven `node --test` arguments: `$SCRATCH/__tests__/` →
`$SCRATCH/lib/__tests__/`), a green `pnpm run test:web`, and then a
green full-matrix CI run (Playwright still never executed anywhere —
no browser here) plus a Meera re-review on the quiet tree.

## 0. Environment notes (read first)

- **EPERM wave: quiet this session.** Real `tsc`, `eslint`, `vitest`,
  `node --test`, `next start`, and `wrangler dev` all ran to completion
  with no EPERM failure. Dist was never zeroed: integrity checked
  before the runs (176 files, 0 zero-byte) and again after them
  (identical). The one self-inflicted incident was mine: a `pkill -f`
  in my first serve attempt matched my own exec session's command line
  and killed it (plus a wrong `next` binary path) — not app-related,
  and the serve check was re-run cleanly afterwards.
- **No browser launches here.** No Playwright execution, no tile
  painting, no phone-width / 130% zoom check, no QR-camera scan, no
  real two-peer WebRTC call. Nothing in this report claims otherwise.
- **No concurrent builds.** All runs sequential; no build was run in
  this review (the existing production build was served, never rebuilt).
- **Scratch:** `/tmp/meera3/` (`bundle.mjs`, `run.mjs`, logs).

## 1. Blocker 1 — web type error: CLOSED

`snapshotToDemoRoom` now supplies both missing fields:
`apps/web/src/app/room/[roomId]/play/page.tsx:88-101` — `pausedFrom:
null` (`:99`) and `catchExpiresAtMs: {}` (`:100`), with a comment
explaining there is no live source for either (snapshot carries no
paused-from phase; demo-store falls back to `requestedAt + TTL`).
Own run, all four workspaces, direct `tsc` binaries, `--noEmit`:

| Workspace | Result |
|---|---|
| `packages/shared` | PASS, exit 0, 0 errors |
| `packages/engine` | PASS, exit 0, 0 errors |
| `workers` | PASS, exit 0, 0 errors |
| `apps/web` (`--incremental false`) | **PASS, exit 0, 0 errors** — the TS2739 at `play/page.tsx:89` is gone |

## 2. Blocker 2 — lint regression: CLOSED

`apps/web/src/lib/live-client.ts:54-57` now imports only
`PakdamSocket, PakdamSocketCallbacks` from `./websocket`; the unused
`PakdamSocketState` import is gone. Own run: `./node_modules/.bin/eslint .`
→ **exit 0, 0 errors, 0 warnings**.

## 3. Blocker 3 — D-M3: CLOSED

- **Lobby Precise/Approximate:** `apps/web/src/components/lobby/ReadinessChecklist.tsx:109-119`
  — the GPS-quality row now appends `locationPrecisionLabel(acc)` in
  all three branches (`"Accuracy ~${acc} m — good enough. Precise
  location"`, fair ditto, poor ditto). `locationPrecisionLabel`
  (`apps/web/src/lib/geolocation.ts:73-76`): ≤25 m → "Precise
  location", else "Approximate location". This is the lobby's
  ReadinessChecklist, exactly where review #2 asked for it.
- **City-name string reworded:** `apps/web/src/components/map/maplibre.ts:70-71` —
  both `OFFLINE_MAP_AREA_MESSAGE` and `OUTSIDE_MAP_AREA_MESSAGE` are
  now `'Offline map: downloaded area only'`. Rendered at
  `MapLibreMapView.tsx:343` (outside-area) and `:352` (area message).
  The old `"Map downloaded for Ranchi only."` survives only inside
  the comment at `maplibre.ts:67-69` describing the rewording.
- **No user-visible "Ranchi" remains in map UI** (sweep of
  `apps/web/src`, rendered strings only — comments excluded):
  the only non-comment "Ranchi" string is
  `apps/web/src/lib/offline-map/mode.ts:64`
  (`label: 'Downloaded map — Doranda & Hinoo, Ranchi'`), and it is
  **dead code**: `decideMapMode` has zero callers and zero importers
  anywhere in `apps/web/src`, and no code renders a `MapSource`
  `.label`. Likewise the diagnostic string in
  `apps/web/src/lib/offline-map/pmtiles-loader.ts:186`
  ("…covering Doranda & Hinoo…") is only consumed by that same dead
  `decideMapMode` path. Both are hygiene residuals (delete or reword),
  not user-visible. The raster tiles themselves bake street names —
  inherent to the bundled pack, not a UI string.

## 4. Blocker 4 — D-M6: CLOSED

- `apps/web/src/app/room/[roomId]/play/page.tsx:670-712` — the
  play-screen hold-to-reveal `reveal()` in live mode calls
  `socketRef.current?.sendCommand('reveal.send', { fix: revealFix })`
  (`:703`) and sets `revealDone` only when the send actually went
  out. The comment (`:670-680`) records the old bug (announcement
  → FORBIDDEN for non-hosts while still marking done) as fixed.
  `announcement.send` at `:563` is the separate radio/check-in path,
  not the reveal path.
- `apps/web/src/components/hud/HoldToReveal.tsx:57` (aria-label) and
  `:74` (visible copy): "share a coarse 150 m area with everyone in
  the game" — coarse 150 m area, never an exact pin. Demo fallback
  (`play/page.tsx:715`) logs a host check-in with the same wording.
- Server side (already verified in review #2, unchanged):
  `workers/src/room-do.ts:2000-2050` `reveal.send` broadcasts a
  coarse 150 m area to every socket.

## 5. Blocker 5 — Playwright/CI: ALMOST CLOSED — one new defect

### 5.1 S-3 and S-4: FIXED (source-verified)

- **S-3** — `apps/web/e2e/outside-zone.spec.ts:118-120`: regex is now
  `/Location permission is denied/i`. It matches the only denial text
  the play page renders: `geolocation.ts:49`
  `LOCATION_DENIED_HELP = 'Location unavailable — location permission
  is denied. …'`, delivered via `watchForegroundLocation` onError
  (`geolocation.ts:100`, err.code 1) → `setLocError` (play page
  `:222`) → `<p role="alert">{locError}</p>` (play page `:871`).
- **S-4** — `apps/web/e2e/map-tiles.spec.ts:188-192`: regex is now
  `/Location found — .*\(GPS accuracy ±\d+ m\)/i`. It matches
  `PlayAreaMap.tsx:671`: `✓ Location found — {locationPrecisionLabel}
  (GPS accuracy ±{n} m). …` (the precision label intervenes, so the
  old contiguous regex could never match).
- S-1/S-2 fixes from review #2 still present on disk
  (`live-hud.spec.ts:225-229` await-inside-expect;
  `host-setup.spec.ts:44-45` "Radius 1.5 km — about 3.0 km across" /
  "no maximum").

### 5.2 ci.yml: FIXED (source-verified)

- **G-1:** the e2e step sets `PAKDAM_ALLOW_PLACEHOLDER_URL: '1'` in
  its step `env:` (`.github/workflows/ci.yml:212-214`), covering both
  the explicit server start and the Playwright webServer fallback.
  The build step records `BUILD_ID_BEFORE` (`:96-107`).
- **§3.3 pre-flight gates, all present** (`ci.yml:140-191`): (a) kill
  port 3105; (b) explicit `next start -p 3105` in background;
  (c) 120 s readiness loop; (d) BUILD_ID stability check;
  (e) chunk-200 gate over every `.next/static/chunks/*.js` plus the
  tile spot-check `16/48301/28392.jpg`. Suite runs once,
  `--workers=1 --reporter=json`, with post-run BUILD_ID re-check and
  port-down confirmation. `e2e/README.md` exists again (was missing
  in review #2).

### 5.3 Test counts — RECOUNTED BY ME: the fix mission is RIGHT, my review #2 was WRONG

**Method:** per-file count of lines matching
`^\s*test(\.skip|\.only)?\(['"]` across all 13 spec files, plus a
second pass listing every other `test(` occurrence to classify it.
Per-file definitions: brutal-phone 4, catch-results 3, host-setup 5,
join-lobby 7, live-hud 8, map-accuracy 4, map-tiles 8, mobile-layout 5,
no-forge-office 2, outside-zone 4, responsive 4, session-restore 4,
smoke 5. **Total: 63 definitions.** A naive `grep -c "test("`
returns **74** — the extra 11 are regex `.test(` calls (e.g.
`TILE_HOST.test(res.url())`, `/…/.test(e.text)`), not test
definitions. No `test.describe` blocks, no `test.fixme`, no loop-
generated tests anywhere in the suite.

**Executions** (from `apps/web/playwright.config.ts` project
filters): desktop 59 (all but brutal-phone), tablet 16
(responsive 4 + no-forge 2 + host-setup 5 + mobile-layout 5),
phone-360-portrait 59, phone-360-landscape 11, brutal-phone 12
(brutal 4 + map-tiles 8), mobile-zoom130 16. **Total: 173.**
The zoom130 test (`mobile-layout.spec.ts:131-132`,
`test.skip(viewport width > 320)`) skips on desktop, tablet, and
phone-360-portrait — the three non-277 px projects that run it — so
a green run is **170 passed + 3 skipped**. `ci.yml`'s comment and
`docs/CI.md:27` state exactly 63/173/170+3. **Meera review #2's
73/196 is withdrawn as a miscount** (it appears to have counted raw
`test(` occurrences as definitions).

### 5.4 `test-web-lib.sh`: NEW DEFECT — the one blocker

**The script fails as shipped: exit 1.**
```
Could not find 'apps/web/.scratch-web-test/__tests__/websocket-reconnect.test.js, ...'
```
Reproduced twice (once via the script itself, once by re-running its
exact `tsc` invocation manually). Diagnosis, step by step:

- The script's `tsc` step **succeeds** (exit 0; no D-M12 abort
  message): it emits 15 files, 0 zero-byte. So this is **not** the
  EPERM wave and **not** a stale-scratch false pass.
- `tsc` infers `rootDir` as `apps/web/src` (inputs span
  `src/lib/…` and `src/components/match/freshness.ts`), so the
  tests land at `$SCRATCH/lib/__tests__/*.test.js` — verified on
  disk after the manual emit.
- The script's `node --test` arguments point at
  `$SCRATCH/__tests__/*.test.js` — a path that never exists.
- The **lists** do cover all 7 suites (websocket-reconnect 17,
  session-credentials 6, live-client 15, demo-store-roles 2,
  demo-store-parity 10, voice-radio 13, map-location 8 = 71 tests),
  in both the `tsc` inputs and the `node --test` invocation. The
  coverage claim is true; the paths are wrong.

**Consequence:** `pnpm run test:web` exits 1, and CI's "Web lib
tests" step (`ci.yml`, `run: pnpm run test:web`) would fail the
whole CI job as committed. **Fix:** change the seven `node --test`
paths from `"$SCRATCH/__tests__/…"` to
`"$SCRATCH/lib/__tests__/…"` (minimal; do not add `--rootDir`,
which would break the `components/match/freshness.ts` input).

**The tests themselves pass:** re-running `node --test` with the
corrected paths (same emit, same sed fix-ups) gives **71 tests:
71 pass, 0 fail, 0 skipped** (see §7).

## 6. Blocker 6 — production build: CLOSED (re-verified, not trusted)

- **Dist integrity, checked twice** (before any run and again after
  all runs — identical): shared 28 files, engine 72, workers 76 =
  **176 files, 0 zero-byte**. `.next`: 463 files, 0 zero-byte,
  **BUILD_ID `pbbo8jgnRqQr7uMkZ7iep`** — matches the fix mission's
  claim exactly.
- **Serves:** `next start -p 3105` with
  `PAKDAM_ALLOW_PLACEHOLDER_URL=1` → "Ready in 5.8s", home 200 with
  real HTML (`<!--pbbo8jgnRqQr7uMkZ7iep-->` in the document).
  **HTTP sweep, my own route list from
  `.next/app-path-routes-manifest.json`: 28/28 → 200** (21 static
  pages + `/robots.txt` + `/sitemap.xml` + 5 dynamic samples
  `/join/ABCDEF`, `/room/TEST`, `/room/TEST/play`, `/room/TEST/catch`,
  `/room/TEST/results`). This exceeds the claimed 25/25 — their 25
  was presumably 21 static + robots + sitemap + 2 dynamic samples.
  **Chunks 19/19 → 200; tile
  `/offline-map/tiles/16/48301/28392.jpg` → 200; BUILD_ID stable
  through the serve.** Server stopped cleanly afterwards (port down,
  no leftover processes).
- **Wrangler smoke — partially corroborated, not fully re-verified:**
  the fix mission's "22/23 steps, 1 bad assertion" has no script on
  disk to re-run (no smoke script in the repo; only docs mention
  `wrangler dev`). My own minimal probe: `wrangler dev --port 8787`
  boots ("Ready on http://localhost:8787"), `GET /v1/rooms/:id`
  without playerId → `{"error":"playerId query parameter is
  required"}`, with playerId → `{"error":"reconnectToken is required
  …"}`, `POST /v1/rooms` with `{}` → 400. Auth gating and validation
  behave correctly against the live local Worker. The 22/23 figure
  itself remains the fix mission's claim, not mine.
- **Independent playthrough: 53/53 pass, fresh room `S6P3MP`**
  (own driver `/tmp/meera3/run.mjs`, demo-store + engine +
  round-card bundled from current source in memory; see §7.1).

## 7. Own runs — summary (all from this session)

| Check | Command / method | Result |
|---|---|---|
| Typecheck shared | `tsc -p packages/shared/tsconfig.json --noEmit` | PASS, exit 0, 0 errors |
| Typecheck engine | `tsc -p packages/engine/tsconfig.json --noEmit` | PASS, exit 0, 0 errors |
| Typecheck workers | `tsc -p workers/tsconfig.json --noEmit` | PASS, exit 0, 0 errors |
| Typecheck web | `tsc -p apps/web/tsconfig.json --noEmit --incremental false` | **PASS, exit 0, 0 errors** |
| Lint | `./node_modules/.bin/eslint .` | **PASS, exit 0, 0 errors, 0 warnings** |
| Engine unit tests | `node --test packages/engine/dist/test/*.test.js` (dist verified non-zero first) | **52 tests: 49 pass, 0 fail, 3 skipped** |
| Workers unit tests | `node --test workers/dist/test/*.test.js` (same) | **164 tests: 157 pass, 0 fail, 7 skipped** |
| Vitest (real runner) | `./node_modules/.bin/vitest run` | **37 tests: 37 pass, 0 fail** (4 files) |
| Web lib tests | shipped `scripts/test-web-lib.sh` | **FAIL, exit 1** — wrong `node --test` paths (§5.4). Same emit, corrected paths: **71 tests: 71 pass, 0 fail, 0 skipped** |
| Production serve | `next start` + curl sweep | **28/28 routes 200, 19/19 chunks 200, tile 200** |
| Wrangler (minimal probe) | `wrangler dev`, 3 HTTP probes | Boots, routes, auth-gating + validation correct |
| Independent playthrough | own driver, fresh room, in-memory bundle | **53/53 pass** |

### 7.1 Playthrough (53 checks, fresh room `S6P3MP`)

Create (code `S6P3MP`, LOBBY, host ready, resolvable by code, Classic
+ Balance ON + max 30) → 5 joins → all 6 ready → zone diameter 999 m
(500 m circle) → READY_CHECK → COUNTDOWN → HEAD_START (clock set,
endsAt−startedAt = 3600 s, Balance drew 2 hunters / 4 runners:
Noor, Sana / Zara, Imran, Dev, Arif) → tick at +31 s → ACTIVE, roles
not re-drawn, clock not reset → fix recorded, ping hunters-only,
coarse 150 m, age 0, deliverable now and at +60 s, snapshots carry no
pending pings → outside-zone 29 s not due / 30 s due / 30 s countdown,
exit logged, eject succeeds (`ejectedAt` set, stays in roster) → QR
catch: awaiting-confirmation, raw token in-memory only, wrong QR
fails, correct QR verifies, confirm → confirmed, `catchExpiresAtMs`
entry exists; confirm-with-no-scan correctly throws
`VALIDATION_FAILED: no verified QR scan…`; second QR catch confirms
after scan → safety pause (`SAFETY_PAUSED`, `pausedFrom: ACTIVE`),
tick never flips while paused, projected `endsAt` moves +60 s,
resume → ACTIVE with `endsAt` shifted exactly 60 s, roles unchanged
→ manual-confirm (Runner, camera fallback) → confirmed → last Runner
caught → COMPLETED, hunters-win → round card: "Hunters win · Classic
Manhunt", "Caught Runners: 3 of 4", "Most tags: Noor (3)", "Ejected:
Arif", no clean sweep, "No locations or routes are shared".
Not covered, as before: DOM, taps, map tiles, camera QR scan, layout
— needs Playwright (blocked here).

## 8. Corrections to my own previous review (adversarial honesty)

- **§3's 73 definitions / 196 executions was wrong.** Recounted from
  the spec files with two methods (§5.3): **63 definitions, 173
  executions (170 run + 3 skipped)**. The fix mission's count is
  correct. The 74 from naive `grep -c "test("` is 63 definitions +
  11 regex `.test(` calls.
- Review #2's other findings stand: the type error, lint error, D-M3
  gaps, S-3/S-4, G-1, and the destroyed build were all real at the
  time; all are now fixed as verified above.

## 9. What would flip this to PASS

1. **Fix `scripts/test-web-lib.sh`** — the seven `node --test`
   paths: `"$SCRATCH/__tests__/"` → `"$SCRATCH/lib/__tests__/"`.
   Then `pnpm run test:web` must exit 0 (expect 71/71).
2. Run the §3.3 sequential CI runbook (ci.yml as committed, once the
   script is fixed): full 173-execution matrix green (170 passed + 3
   skipped), then a Meera re-review on the quiet tree.
3. Still owed outside this VM and unchanged: live deployment,
   real-phone GPS + outdoor field test, QR-camera scan, dark-mode /
   130% zoom / KDS eyeball checks, Sentry DSN, HNT-071 calibration,
   public-pilot legal/trademark work (deferred per the founder's
   personal-game decision), and the fix mission's 22/23 wrangler
   smoke steps filed as a runnable script so they can be re-run.

## 10. Residuals (non-blocking)

- `offline-map/mode.ts:64` dead label still names Ranchi and
  `pmtiles-loader.ts:186` still names Doranda & Hinoo — unreachable
  from any UI (dead `decideMapMode` path). Delete or reword for
  hygiene; not a blocker.
- Root `package.json` scripts still call `npm run … --workspace=…`
  (cosmetic; CI uses `pnpm` directly). Unchanged since review #2.
- Playwright has still never had a green run anywhere — the suite is
  now source-consistent (S-1–S-4 fixed, counts corrected), but only
  a CI run with a JSON reporter proves it.

## Evidence files (this review; ephemeral, under /tmp)

- `/tmp/meera3/bundle.mjs`, `/tmp/meera3/run.mjs` — playthrough
  driver (in-memory esbuild bundle + 53 checks); logs
  `/tmp/meera3/next-start2.log`, `/tmp/meera3/wrangler.log`,
  `/tmp/meera3-testweb.log`.
