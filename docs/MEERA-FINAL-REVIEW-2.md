# Meera — Final Re-Review #2 (independent)

**Reviewer:** Meera (independent reviewer)
**Date:** 2026-11-18 ~00:18–01:20 IST (2026-11-17 18:48–19:51 UTC)
**Brief (only authoritative source):** `pakdam-final-checklist-2026-11-17.md`
**App:** `~/workspace/goals/hide-and-seek-combo-game/files/pakdam-app/` (Next.js 15.5.29)
**Previous verdict:** NEEDS FIXES (`docs/MEERA-FINAL-CHECKLIST-REVIEW.md`, D-M1–D-M7 + D-M11, harness D-M12/D-M13)
**Method:** read, run, report only. No app source was modified by this review.
Three workers ran in parallel, all read-only on app source: (1) checklist +
Meera-fix verification, (2) Playwright triage, (3) own runs (typecheck /
lint / unit / vitest / test:web / independent playthrough). Every number
below is from their own runs or source reads in this session; nothing is
taken from a summary on trust. Where a claim could not be re-run here,
that is stated plainly instead of claimed as tested.

## Verdict: NEEDS FIXES

The fix mission landed real, substantial code — 11 of 13 fix items pass,
including the free WebRTC voice radio, live lobby settings, live
host-remove, live Tell-everyone, live radio text, the uncapped radius,
and server-drawn next zones. The core game loop is independently
reproduced again (45/45 checks, fresh room 523QDT). But the founder's
absolute bar is **no errors, no bugs, no issues**, and this tree does
not meet it tonight:

1. **One genuine web type error** — `play/page.tsx:89` `snapshotToDemoRoom`
   builds a `DemoRoom` missing required `pausedFrom` and
   `catchExpiresAtMs` (TS2739). The only typecheck failure in the tree
   once the dist cascade is removed.
2. **One lint regression** — `live-client.ts:56` unused `PakdamSocketState`
   (previous report: lint 0/0).
3. **Two checklist items still partial** — D-M3 (Precise/Approximate label
   exists on create + play maps, **not in the lobby**, where the checklist
   puts it) and the city-name string (`maplibre.ts:69`, "Map downloaded
   for Ranchi only.").
4. **No production build exists any more** — the `.next` build was
   destroyed mid-review (19:18 UTC, 458 files / 684 MB → 51 files,
   `BUILD_ID` gone). The previous report's 28/28 HTTP sweep described
   a build that no longer exists.
5. **Playwright has still never had a green run.** Two stale assertions
   remain open (S-3, S-4), and the CI e2e step has a blocker (G-1):
   it does not set `PAKDAM_ALLOW_PLACEHOLDER_URL=1`, so `next start`
   refuses to boot and the whole e2e run would be 0/x.
6. **The tree was being destroyed while this review ran** — a concurrent
   rebuild loop zeroed `packages/shared/dist` (18:51 UTC, 28/29 files),
   `packages/engine/dist` and `workers/dist` (18:57 UTC, 72/72 and
   76/76), then the `.next` build. Any dist-based test run in that
   window is vacuous (worker 3 caught its own first engine run
   "passing" 7/7 on 0-byte files, 0 assertions). All numbers below are
   therefore from **current source, in memory** — never from dist.

READY would require: fixing (1)–(3), a rebuilt production build that
serves, the S-3/S-4 + G-1 Playwright fixes, and a green full-matrix CI
run — then a Meera re-review on a quiet tree.

## 0. Environment limits that shaped this review (read first)

- **EPERM-write wave, still active:** child processes' `write()` calls
  fail intermittently. `npm` wrappers die on their own log writes;
  `tsc` emit / `esbuild --outfile` fail with TS5033/EPERM and create
  0-byte files; `node --test` on dist is untrustworthy (0-byte files
  pass vacuously); shell redirects intermittently produce 0-byte
  files; Vitest cannot start (Vite bundles its config to a temp
  file); Chromium cannot launch. Workarounds used: direct binaries,
  in-memory esbuild bundles (`write: false`) + `data:`-URL imports
  under plain `node`, `/tmp` tsconfigs with `paths` pointing at
  source. All scratch lives under `/tmp/meera3/` and
  `/tmp/meera-playwright-triage-2026-11-18.md`.
- **Concurrent mutation:** the fix mission edited specs mid-triage
  (`live-hud.spec.ts` 18:51:50 UTC, `host-setup.spec.ts` 18:55:54
  UTC) and app source 18:53–18:55 UTC; a sibling rebuild loop was
  still running at 19:20 UTC retrying `tsc -p` emits 5× per package.
  Worker 1 snapshotted mtimes 18:48 → 18:51 UTC (identical — no
  change during its window); workers 2 and 3 re-verified every
  finding against post-edit source at ~19:00 UTC and later.
- **No browser launches here.** No Playwright execution, no tile
  painting, no phone-width / 130% zoom check, no QR-camera scan, no
  real two-peer WebRTC call. Nothing in this report claims otherwise.

## 1. Meera-fix verification — 11 of 13 PASS, 2 PARTIAL (worker 1)

Review window 18:48–18:53 UTC. All fix files last modified 18:18–18:35
UTC, i.e. before this review started. Grep + file read with line
evidence; no app source modified, no suites or builds run.

| Item | Verdict | File + line evidence |
|---|---|---|
| D-M1 Voice radio (free WebRTC, PTT ≤10 s, team-only, STUN-only, text fallback, no recording) | **PASS** (source-verified; live P2P not exercised — no mic/browser here) | `apps/web/src/lib/voice-radio.ts:38` `VOICE_MAX_BURST_MS = 10_000`; `:46-52` `VOICE_STUN_URLS` = `stun:stun.l.google.com:19302` + `stun1` only; `:265-271` burst timer auto-`stopTalk()` at 10 s; `:19-20` mic track disabled except while held. Team-only enforced server-side: `workers/src/room-do.ts:1957` rejects cross-team/lobby signals, `:1960` honours `huntersCanTalk === false`; fan-out sends to the named recipient only. Text fallback: `TeamRadio.tsx:312-313` "Voice is peer-to-peer, no recording… never recorded or stored"; mute at `:364-368`. Wired in play page `:924-925` `sendSignal`/`incomingSignal`, `:286-292` `voice.signal` forwarding. Zero hits for Twilio/Agora/LiveKit/100ms/TURN/`MediaRecorder` in `apps/web/src`, `workers/src`, `packages`. Tests: `apps/web/src/lib/__tests__/voice-radio.test.ts` 13 `test(` incl. STUN-only/no-TURN, 10 s auto-stop, non-teammate ignored; `workers/src/test/voice-radio.test.ts` exists. Old "not available in the PWA / Phase 1 (native)" text: zero hits in `TeamRadio.tsx`. Voice is play-only by design (`voiceAvailable` requires `scope !== 'lobby'`) — correct, teams don't exist in the lobby. |
| D-M2 Regenerate room code | **PASS** | UI `apps/web/src/app/room/[roomId]/page.tsx:896` "Change code" button (host only), `:632-669` `regenerateCode()` with confirm + old-code-dead notice. Client `apps/web/src/lib/live-room-client.ts:193-206` `POST /v1/rooms/:id/regenerate-code`, `:444-451` `LiveRoomClient.regenerateRoomCode()`. Server `workers/src/index.ts:483-540` (new code registered, old unregistered after swap), `workers/src/room-do-class.ts:789-820` `regenerate-code` op — host-only, LOBBY-only, broadcasts `room.state` reason `code-regenerated`. Tests `live-client.test.ts:274-311` (3 regenerate tests incl. 403 mapping). Demo path also regenerates locally (`:663-669`). |
| D-M3 Precise/Approximate permission displayed in game UI | **PARTIAL** | Fixed on create + play maps: `apps/web/src/lib/geolocation.ts:63-82` `locationPrecision()` / `locationPrecisionLabel()` (≤25 m → "Precise location", else "Approximate location"); rendered in `PlayAreaMap.tsx:671,717,735`, `ZoneEditor.tsx:267`, `MapLibreMapView.tsx:346`. Tests `map-location.test.ts:52-55`. Lobby Mode is shown (`page.tsx:961` `describeMode(...)` in the "This game" facts strip `:960-973`). **But the lobby shows no Precise/Approximate anywhere** — zero hits in the lobby page; `ReadinessChecklist.tsx:163` shows only "Location permission — Granted/Denied" and `:104-115` "GPS quality — Accuracy ~X m — good/fair/poor", never the Precise/Approximate words. The checklist puts this item under Lobby. One-line fix: add a "Location" fact next to Mode, or the label in the GPS-quality row. |
| D-M4 Lobby settings editable after creation (LIVE) | **PASS** | Route `workers/src/index.ts:927-929` `config` → `handleSeatAction(..., updateConfigBody, 'update-config')`. DO `workers/src/room-do-class.ts:723-752` `update-config` — host-only (403), LOBBY-only (409), full re-validation, broadcasts `room.state` reason `config-updated`. UI lobby `:1185-1200` `HostSettingsSheet` opens in live mode, `onDone` → `saveSettingsLive` (`:572-630`, incl. hunter-pick save `:598-622`). Tests `workers/src/test/lobby-host-controls.test.ts` exists. Settings remain LOBBY-only by design (409 after start). |
| D-M5 Host remove player (LIVE) | **PASS** | Route `workers/src/index.ts:931-933` `remove-player` → `handleSeatAction(..., removePlayerBody, 'remove-player')`. DO `workers/src/room-do-class.ts:754-788` — host-only, LOBBY-only, never the host seat, marks `leftAt`, broadcasts `player.removed`. UI lobby `:533` `removePlayerLive(...)` in live mode, `:564` call, `Roster` `onRemove` wired for host (`:995`). |
| D-M6 Tell everyone live channel | **PASS** | UI lobby `:756-795` `revealLive()` — 2 s hold, then `socket.sendCommand('reveal.send', { fix })`, `:791` event log. Server `workers/src/room-do.ts:2000-2050` `reveal.send` — validates fix like `location.update`, broadcasts `reveal` to EVERY socket with a coarse 150 m area (`PING_AREA_RADIUS_M`), never an exact pin; rate limit `:1341` 5/min. Old `REVEAL_LIVE_NOTE` ("no live channel yet") is gone — zero hits. |
| D-M7 Team Radio text reaches other players (LIVE) | **PASS** | Server `workers/src/room-do.ts:1864-1903` `radio.send` — 1–140 chars, team-only fan-out (`room-do-class.ts broadcastRecipients`), lobby scope = whole lobby; ejected seats and muted Hunters blocked. Client send `apps/web/src/lib/websocket.ts` `sendRadioMessage`; tests `websocket-reconnect.test.ts:403-436` (3 D-M7 tests). Play page `play/page.tsx:916-920` `liveText` wired; lobby page too `room/[roomId]/page.tsx:1078-1088` `TeamRadio` with `liveText` in live mode (`liveRadio` state `:152`). Minor doc inconsistency: lobby header comment `:73-74` still says "NOT LIVE YET: lobby radio is demo-only localStorage, so it is hidden in live mode" — false now; comment needs updating, not code. |
| D-M11 "Runner's QR code" wording | **PASS** | `apps/web/src/components/match/freshness.ts:86` now reads "A catch still needs the Runner's QR code and their confirmation." |
| D-M12 `test-web-lib.sh` aborts when tsc emit fails | **PASS** | `scripts/test-web-lib.sh` captures `TSC_EXIT=$?` after the emit and exits 1 with "aborting before node --test so stale scratch output is never reported as passing" (D-M12 comment in-script). Now includes `voice-radio.ts` + `voice-radio.test.ts` (5 suites). Script itself not executed in this read-only review. **Residual (worker 3): the script still omits `map-location` (8 tests) and `demo-store-parity` (10 tests) — 18 tests never run by `npm run test:web`.** |
| D-M13 `ws-protocol.test.ts` no temp-file write at load | **PASS** | `packages/engine/test/ws-protocol.test.ts:1-35` transpiles `websocket.ts` and loads via `` `data:text/javascript;base64,...` `` import; header states "no temp file is written at load (D-M13…)". Grep for `mkdtemp`/`writeFileSync`: only the historical comment at `:13`. |
| Radius cap removed (unlimited past 1 km) | **PASS** | `packages/shared/src/types.ts:136` — "the old 1.5 km cap (ZONE_RADIUS_MAX_M) is deleted"; `:148` `ZONE_RADIUS_UI_MAX_M = 10000` (UI soft bound only). `HostSetupForm.tsx:86-90` stepper list extends past current radius (`radiusStepsTop = max(RADIUS_BOUNDS.max, value.radiusMeters + 500)`, "founder decision, 2026-11-17, unlimited past 1 km"); slider max likewise grows (`:240`). Validation `packages/shared/src/validation.ts:29,92-94` — diameter minimum 200 m, "(no maximum)". Old "Radius 100 m–1.5 km" hint: gone. Strictly, the UI list tops out at 10 km until the user steps past it, then grows — effectively unbounded, not literally infinite in one list. |
| Map zone centred on chosen centre; city name out of normal map UI | **PARTIAL** | Zone: `ZoneEditor.tsx:58,186,296` centre is `null` until a GPS fix or map tap — no default centre; `:150` centres on the GPS fix; `:207` manual pin; `:263,266` "Finding your location…" waiting state. Lobby strip even says "there is no place name to remember" (`page.tsx:959`). **But the city name is still user-visible in one map string:** `apps/web/src/components/map/maplibre.ts:69` `OUTSIDE_MAP_AREA_MESSAGE = 'Map downloaded for Ranchi only.'`, rendered at `MapLibreMapView.tsx:343` whenever the fix is outside the pack. Its own comment (`:67`) says these are "the brief's exact words" — founder to rule whether that message is exempt or reworded (e.g. "Map downloaded for this area only"). Map viewport still starts at Doranda (`MapLibreMapView.tsx:67-71` `BBOX_CENTRE`, `PlayAreaMap.tsx:58-61`) — viewport only, not the zone, and unavoidable (no tiles elsewhere; 808 tiles on disk, `public/offline-map/tiles/`). The `offline-map/mode.ts:64` label "Downloaded map — Doranda & Hinoo, Ranchi" exists in code; its user-visible rendering was not traced in this pass. |
| Next-zone randomness drawn per-shrink by the server (DO) | **PASS** | `workers/src/room-do.ts:924-978`: "the random POSITION is drawn HERE, by the DO, at the moment the shrink fires (2026-11-17)… the stored phase boundary… is only a size placeholder — the live boundary is re-drawn per shrink"; `:971` `liveBoundary = randomOffsetShrinkBoundary(prevBoundary, factor)` with size from the stored phase's diameter ratio; `:974` replaces the stored phase so snapshots/previews agree; `zone.update` broadcast with `shrinkStep`. `draft.ts:216-225` still pre-computes shrink-phase boundaries at creation — now harmless size placeholders only (documented at `draft.ts:200-204`). |
| Stale docs corrected (CI.md, CLOUDFLARE-SETUP.md, SENTRY-SETUP.md, vercel.json buildCommand) | **PASS with residual** | `docs/CI.md:19,54-65` now pnpm-only ("Installer note (pnpm, not npm — corrected 2026-11-17)"); `docs/CLOUDFLARE-SETUP.md:59,86,272` `pnpm install --frozen-lockfile`; `docs/SENTRY-SETUP.md:31` `pnpm --filter pakdam-web add @sentry/nextjs`; `vercel.json` now `{"buildCommand": "pnpm run build", "installCommand": "pnpm install --frozen-lockfile"}`. `package.json:5` declares `"packageManager": "pnpm@10.34.9"`. **Residual:** root `package.json` scripts still call `npm run … --workspace=…` (`dev`/`build`/`typecheck`/`test`); `README.md:37-40` and `docs/DEPLOYMENT-RUNBOOK.md:171-174,182` still print `npm run typecheck/test/build/dev`. Cosmetic; suggest aligning them to `pnpm run …`. |
| Live-browser defects 2026-11-17 22:11 (map blank white after movement pad; zoom buttons centre on map not pin; zone circle ring; Doranda/Hinoo labels at street zoom) | **SOURCE-FIXED, LIVE-UNVERIFIED** | Blank map: `MapLibreMapView.tsx:40-54,159-177` — camera NEVER flies to a fix outside the tile pack ("there are no tiles there, so the map paints white — and on reload the same fix would re-centre it there again"); fly only when fix moved >25 m or accuracy halved; canvas re-measured on container resize. "Movement pad" = arrow-key centre stepping (`ZoneEditor.tsx:214-224`, `PlayAreaMap.tsx:612-617`). Zoom: `:185-209` `zoomAnchor()` = pin, else zone centroid, else camera centre — "never the middle of the screen by default"; buttons `:331-334` labelled "Zoom in/out, centred on your location". Ring: `:104-110` — fill-opacity 0.2 over a white 9 px halo under a 5 px red line, comment cites the 22:11 live check ("the old 3px line / 0.07 fill was barely visible"). Labels: tiles are raster OSM World Street Map zooms 12–17 (`:23`), 808 tile files on disk, so Doranda/Hinoo names are baked into tiles and render iff tiles paint. **All four need one live phone/desktop check to close.** |

### §10.1 clean items re-grep — ALL STILL CLEAN (worker 1)

Classic + Infection only (only "later, not now" mentions;
`ModesPreview.tsx:3`, `HostSetupForm.tsx:31`, `game-modes/page.tsx:15`;
"breach" hits are legal-notification text only). No `/demo` route;
`addDemoPlayers` has no callers outside `demo-store.ts`. No catch
code: `catch/page.tsx:120` "There is no one-time code anywhere in
Pakdam"; "type a different code" hits are the 6-letter **room** code
on join pages only. Outside-zone 30 s only: zero hits for "2 minutes
— you're tagged" / "hunters see you live". Guest only:
`create/page.tsx:92`, `page.tsx:35` "no account, no sign-in";
sign-in hits are "no sign-in" statements. No nearby rooms: zero hits
for "nearby room(s)"/"find a room" in landing/lobby. 3–30 players:
`validation.ts:20,61` `maxPlayers 3–30`. No lat/lng in UI: `.tsx`
lat/lng hits are code/props/maths; distances render via
`formatDistance`, ages as `0:27 ago`. No payment: only "no payment,
no membership, no paywall" statements.

## 2. Own runs — from current source, in memory (worker 3)

The concurrent rebuild loop zeroed `packages/shared/dist` (18:51 UTC,
28/29 files 0 bytes), `packages/engine/dist` (18:57 UTC, 72/72) and
`workers/dist` (18:57 UTC, 76/76), and destroyed the `.next` build
(19:18 UTC). **Any dist-based test run in that window is vacuous.**
All numbers below are from current source via in-memory esbuild
bundles (`write: false`) + `data:`-URL imports under plain `node`.
No app source was modified; scratch under `/tmp/meera3/`.

| Check | Command (direct binaries, no npm wrappers) | Result |
|---|---|---|
| Typecheck `packages/shared` | `./node_modules/.bin/tsc -p packages/shared/tsconfig.json --noEmit` | **PASS, exit 0, 0 errors** |
| Typecheck `packages/engine` | In-tree run failed on TS2306 cascade from zeroed shared `dist/index.d.ts`. Re-ran via `/tmp` tsconfig with `paths: @pakdam/shared → packages/shared/src/index.ts`, `--noEmit` | **PASS, exit 0, 0 errors** (earlier `modes.ts:33` / zone implicit-`any` lines were cascade artifacts of the broken `.d.ts`, not real) |
| Typecheck `workers` | Same source-path method (`@pakdam/*` → src, `types: [node, @cloudflare/workers-types]`) | **PASS, exit 0, 0 errors** |
| Typecheck `apps/web` | In-tree run (`--incremental false`) failed on the same TS2306 cascade. Re-ran via `/tmp` tsconfig, `paths` → src | **FAIL, exit 2, exactly 1 error — genuine:** `src/app/room/[roomId]/play/page.tsx(89,3) TS2739`: `snapshotToDemoRoom` builds a `DemoRoom` missing `pausedFrom` and `catchExpiresAtMs` (both required by `demo-store.ts:59`; the store's own `createRoom` supplies them). Live-mode rooms therefore carry `undefined` for both; any consumer indexing `dr.catchExpiresAtMs[…]` on a live room would throw. The web `HostSetupDraft` cascade in the in-tree run was an artifact. |
| Lint | `./node_modules/.bin/eslint .` | **FAIL, exit 1: 1 error, 0 warnings** — `apps/web/src/lib/live-client.ts:56:40 'PakdamSocketState' is defined but never used` (`@typescript-eslint/no-unused-vars`). Previous report said 0/0; this is a regression in current source. |
| Engine unit tests | esbuild JS API, `write: false`, bundle each `packages/engine/test/*.test.ts` from source, import via `data:` URL under plain `node` (ws-protocol needed 2 in-memory patches: `createRequire(data:)` throws, so TS compiler imported by absolute file URL; `clientSrcPath` pointed at the real `websocket.ts`) | **52 tests: 49 pass, 0 fail, 3 skipped** (the 3 are `phase1` native-only skips). All 7 files incl. `ws-protocol` (5 tests). |
| Workers unit tests | Same in-memory method, all 10 `workers/test/*.test.ts` incl. the 3 with no dist output (`lobby-host-controls`, `radio`, `voice-radio`) | **164 tests: 157 pass, 0 fail, 7 skipped** — replicated twice, identical both runs. |
| Vitest | Real runner tried: `./node_modules/.bin/vitest run` dies at startup, `EPERM … syscall: 'write'` inside Vite `resolveConfig` (config bundling to temp file). Replicated all 4 `vitest/*.test.ts` under plain node with my own shim (`describe`/`it`/`it.each`/`expect` incl. `toMatchObject`, `vi` fake timers) | **37 tests: 37 pass, 0 fail, 0 skipped** (incl. the 10 s burst fake-timer test). |
| test:web | Shipped `scripts/test-web-lib.sh` **could not run as shipped**: it emits with `tsc` to in-repo scratch (EPERM zeroes the emit) and it covers only 5 of the 7 suites in `src/lib/__tests__/`. Ran all 7 suites via the same in-memory esbuild method | **71 tests: 71 pass, 0 fail, 0 skipped** (websocket-reconnect 17, live-client 15, voice-radio 13, map-location 8, session-credentials 6, demo-store-roles 2, demo-store-parity 10). **Coverage gap in the shipped script: it omits `map-location` (8 tests) and `demo-store-parity` (10 tests, Worker-2 suite dated 2026-11-18) — 18 tests never run by `npm run test:web`.** |
| Independent playthrough | Own driver `/tmp/meera3/playthrough.mjs`, fresh room, 6 players (host Zara + Imran/Noor/Dev/Sana/Arif), Classic, Balance ON, Random ON, demo-store + engine + round-card bundled from current source in memory | **45 checks: 45 pass, 0 failed.** Steps: create (code `523QDT`, LOBBY, resolvable by code) → join/ready (host starts ready, `isReady`) → READY_CHECK→COUNTDOWN→HEAD_START (2 hunters / 4 runners, clock set) → tick→ACTIVE (roles not re-drawn, clock not reset) → pings (hunters-only, 150 m, age 0 s, fixes recorded) → outside-zone (29 s not due / 30 s due, eject succeeds, `ejectedAt` + log) → QR catch (awaiting-confirmation, token in-memory only, correct scan verifies / wrong does not, qr-scan confirm) → safety pause (SAFETY_PAUSED, `pausedFrom: ACTIVE`, tick never completes while paused, resume→ACTIVE, `endsAt` shifted +30 s) → manual-confirm fallback (Runner confirms) → last Runner caught → COMPLETED hunters-win → round card ("Hunters win · Classic Manhunt", 3 of 4 caught, 1 ejected, 3 confirmed, "Most tags: Zara (3)", duration 60 min). Two driver bugs of mine found and fixed en route (field is `isReady` not `ready`; qr-scan confirm requires a prior verified scan — the app correctly throws `VALIDATION_FAILED` otherwise). Not covered, as before: DOM, taps, map tiles, camera QR scan, layout — need Playwright (blocked here). |
| Production build exists/serves? | `ls .next`, `next start` (foreground; background+redirect swallowed all output), **no `next build` run** | **NO production build exists any more — cannot serve.** At 18:52 UTC: `BUILD_ID` `MEwm2yRbhLVDlOZHxi9Sp`, 458 files, 0 zero-byte, 684 MB (but already stale: source edited 18:19–18:36 UTC after it). At 19:18 UTC the build was destroyed (51 files left: only `cache/` + `types/` + empty `trace`; no `BUILD_ID`, no `server/`, no `static/`). `next start` now fails twice over: (a) without escape, the deliberate guard in `next.config.ts` refuses — `NEXT_PUBLIC_SITE_URL` is still the placeholder `https://pakdam.example` (trademark gate; escape is dev/CI-only); (b) with `PAKDAM_ALLOW_PLACEHOLDER_URL=1` used once for diagnosis, `Could not find a production build in the '.next' directory`. A rebuild is required; worker 3 did not attempt one (task forbade it, and the EPERM wave would zero the emit anyway). Previous report's "build #2 HTTP sweep 28/28" described a build that no longer exists. |

## 3. Playwright triage (worker 2)

Read all 13 spec files (73 test definitions), verified every asserted
string against current app source, computed the 999 m geometry with the
real functions in node, and probed the installed Playwright 1.65.1
`expect` bundle in node. Read-only on app source; full report at
`/tmp/meera-playwright-triage-2026-11-18.md`. Concurrent-edit warning:
the fix mission edited spec files DURING this triage
(`live-hud.spec.ts` 18:51:50 UTC, `host-setup.spec.ts` 18:55:54 UTC)
and app source 18:53–18:55 UTC; first reads saw pre-fix versions;
every finding below was re-verified against post-edit source at
~19:00 UTC. `e2e/README.md` was listed at session start and is absent
at 19:00 UTC (EPERM flapping).

**Suite size (current files):** 73 test definitions, **196 executions**
across 6 projects (desktop 67, tablet 17, phone-360-portrait 67,
phone-360-landscape 11, brutal-phone 17, mobile-zoom130 17). The "63
test definitions" in `ci.yml:109` and `docs/CI.md` is stale. Meera's
14/159 = 173 predates the current suite and cannot be reconciled —
stands unconfirmed.

### 3.1 Stale-assertion table

| # | Spec : line | Asserted text | Current source | Verdict |
|---|---|---|---|---|
| S-1 | `live-hud.spec.ts:225-229` (old 224-238) | `await expect(page.evaluate(() => document.documentElement.classList.contains('cb-theme'))).toBe(true)` + 5 siblings (dark on/off, `pakdam.dark-mode` on/off) | `ThemeControls.tsx:89-90` — checkbox `aria-label="Dark mode"`, key `pakdam.dark-mode`, toggles `dark` class | **TEST BUG, now FIXED by the fix mission mid-session (18:51 UTC).** `page.evaluate()` returns a Promise; `await expect(promise)` awaits the (synchronous) assertion, so the matcher received the Promise object and could never pass. **Proven in node against the repo's own Playwright 1.65.1 bundle** (`lib/matchers/expect.js`, `invokeMatcher` never awaits a raw promise actual): `await expect(Promise.resolve(true)).toBe(true)` FAILS with `expect(received).toBe(expected) // Object.is equality`. The targeted-run report's "missing await at :225" was imprecise but pointed at the right place — the await belongs INSIDE expect. Fixed form now on disk: `expect(await page.evaluate(...)).toBe(true)` with explanatory comment at :225-229. |
| S-2 | `host-setup.spec.ts:44` (old) | `getByText(/Radius 100 m–1\.5 km, about 200 m–3 km across/i)` | `HostSetupForm.tsx:247` — current hint: `Radius {d} — about {2d} across. … Radius at least 100 m, no maximum — set any size past 1 km.` The 1.5 km cap was deleted (`lib/__tests__/map-location.test.ts:14,82`) | **STALE, now FIXED by the fix mission mid-session (18:55 UTC).** Lines 44-45 now assert `/Radius 1\.5 km — about 3\.0 km across/i` + `/Radius at least 100 m, no maximum/i`, matching the current hint after the slider is filled to 1500 m. |
| S-3 | `outside-zone.spec.ts:131` | `getByText(/Location permission denied/i)` (after `clearPermissions()` + reload) | `lib/geolocation.ts:49` — `LOCATION_DENIED_HELP = 'Location unavailable — location permission is denied. …'`; play page surfaces it via watch onError → `locError` → `<p role="alert">` (`play/page.tsx:217,827`) | **STALE — OPEN.** "location permission **is** denied" does not contain "permission denied" adjacently, so the regex can never match the only denial text the play page renders. Fix: `/Location permission is denied/i`. |
| S-4 | `map-tiles.spec.ts:188` | `getByText(/Location found — GPS accuracy ±/i).first()` | `PlayAreaMap.tsx:671` — `✓ Location found — {locationPrecisionLabel} (GPS accuracy ±{n} m). …` e.g. "✓ Location found — Precise location (GPS accuracy ±8 m)." | **STALE — OPEN.** "Location found — GPS accuracy" is not contiguous in the rendered text (the precision label intervenes). Fix: `/Location found — .*\(GPS accuracy ±\d+ m\)/i`. |

**No other stale assertions found.** Strongest verifications (all quoted
in the /tmp report): **Correction to Meera §7.2 #4:** "Let's go!"
EXISTS — `TeamRadio.tsx:56`, `'Let’s go!'` with a **curly** apostrophe
(U+2019); Meera's straight-apostrophe grep missed it. Test regex
`/Let.s go!/` matches. Not stale. "About 999 m across" is exact —
computed in node with the real `circlePolygon` (32-gon, 500 m) +
`haversineMeters`: max pairwise distance = **999 m** →
`formatDistance(999)="999 m"`. Summary strip, all steppers (60→90
"1 h 30 min", 180→300 "5 min", head start 180→90→30 "30s", shrink
600→1200 "20 min", corners 6→8), lobby counts, radio channels, catch
flow, results, outside-zone banner/countdown, map captions, denied
help (Android+iOS), TopBar menu, /accessibility's 4 checkboxes +
layout strip, no-Forge (only "forged" in a code comment) — all
verified. Systematic async scan: no other un-awaited async call in
any spec.

### 3.2 Failure diagnosis

| Run | Diagnosis |
|---|---|
| **Targeted run** (join-lobby 7 + live-hud 8 = 15 tests; 4 passed, 7 failed, 4 killed by timeout) | **No failure list is on file** — per-test attribution is impossible. From source: **1 genuine test bug (S-1, now fixed)** — the appearance test failed deterministically pre-fix (at most 1 of the 7 failures, 2 executions across projects). **The other 6 failures + 4 timeout-kills have no stale assertion behind them** — every other asserted string in both files verifies. Most likely: (a) the environmental chunk failure below, if the run shared a corrupted `.next`; (b) **timeouts are structural** — each `startMatch` costs ~40–60 s (5 real joins + 30 s head start + wait ACTIVE up to 60 s) against `test.setTimeout(120_000)`, plus a 12 s ping-age wait; with `workers: 2` and a cold server, tests overrun 120 s and are killed — the 4 killed-by-timeout fit this exactly; (c) known flake: cross-tab localStorage lost-update in the demo store (documented in `smoke.spec.ts` itself). **Verdict: 1 test bug (fixed) + the rest environmental/timing, NOT app defects — but this is a bounded diagnosis, not proof. Only a CI re-run with a JSON reporter closes it.** |
| **15-failure environmental run** (all `/_next/static/chunks/*.js` HTTP 400, zero client JS; three concurrent `next build`s corrupted `.next`) | **ENVIRONMENTAL, not an app defect.** Uniform 400s on every chunk with zero client JS is the signature of a build writing over a live `.next` mid-serve (served HTML references chunk filenames from BUILD_ID *N* while on-disk chunks belong to *N+1* or are half-written). No app code path produces uniform 400s across all chunks while HTML still serves; a uniform failure across 15 unrelated tests points at the serving layer, not 15 app bugs; consistent with this VM's EPERM/flapping history. Fix is procedural: the sequential runbook below. |
| **Meera 14/159** (12 triaged, 147 unexamined) | Unreproduced from current files. Of the 12: #4 is **wrong** (see above); #1–2, #5, #6, #7 all re-verify against current source; none is an app copy defect. The 147 unexamined remain unexamined until CI runs with a JSON reporter. |

### 3.3 Sequential CI runbook (exact order — the fix for the environmental failures)

**Preconditions — fix BEFORE this can go green:**
- **G-1 (blocks everything):** `ci.yml`'s e2e step does **not** set
  `PAKDAM_ALLOW_PLACEHOLDER_URL=1`. `next.config.ts:14-22` throws at
  config-load when `NODE_ENV=production` and the URL is the
  placeholder; `next start` sets `NODE_ENV=production`, so the
  Playwright `webServer` **refuses to boot** (verified empirically by
  Meera §0/§6). The build step's env does not carry to later GitHub
  Actions steps. Without this fix the whole e2e run is 0/x.
- **G-2:** Fix S-3 and S-4, or 2 executions fail deterministically.
- **G-3:** No concurrent builds (the 15-failure cause). Keep
  `ci.yml`'s `concurrency` group; never run a second `next build`
  against the same checkout while e2e runs.

**Steps (single job, `ubuntu-latest`, in order):**
1. `actions/checkout@v4`. 2. `pnpm/action-setup@v4` (10.34.9).
   3. `actions/setup-node@v4` (node 24, `cache: pnpm`).
   4. `pnpm install --frozen-lockfile`. 5. `pnpm run lint` →
   `typecheck` → `test` → `test:vitest` → `test:web` (unchanged
   order). 6. **ONE production build, once:** `pnpm run build` with
   `PAKDAM_ALLOW_PLACEHOLDER_URL: '1'`; record
   `BUILD_ID_BEFORE=$(cat apps/web/.next/BUILD_ID)` and echo it. No
   other build runs after this step. 7. `pnpm --filter pakdam-web
   exec playwright install --with-deps chromium`. 8. **Pre-flight
   gates (fail the job if any fails):** (a) kill anything on port
   3105 (`fuser -k 3105/tcp || true`) — `reuseExistingServer: true`
   must never pick up a stale server; (b) start the server explicitly
   so boot failure is visible: `cd apps/web &&
   PAKDAM_ALLOW_PLACEHOLDER_URL=1 PLAYWRIGHT_BASE_URL=http://localhost:3105
   npx next start -p 3105` (background); (c) readiness loop —
   `curl -fsS http://localhost:3105/` must succeed within 120 s;
   (d) **BUILD_ID stability check** — `BUILD_ID_AFTER` must equal
   `BUILD_ID_BEFORE`, else stop; (e) **chunk-200 gate** — `curl` every
   `apps/web/.next/static/chunks/*.js` as
   `/_next/static/chunks/<name>` — every one must return **200**
   (any 400 reproduces the 15-failure run: stop, check for a
   concurrent build); plus spot-check one tile
   `http://localhost:3105/offline-map/tiles/16/48301/28392.jpg` →
   200. 9. **The suite — one command, sequential, full matrix, JSON
   reporter:**
   ```sh
   cd apps/web
   PAKDAM_ALLOW_PLACEHOLDER_URL=1 PLAYWRIGHT_BASE_URL=http://localhost:3105 \
     pnpm exec playwright test --workers=1 --reporter=json > playwright-report.json
   ```
   `--workers=1` overrides config `workers: 2`; `--reporter=json`
   overrides config `reporter: 'list'` (verified the CLI accepts
   `--reporter=json`; stdout is the JSON report). All 6 projects in
   this one invocation, config order (desktop, tablet,
   phone-360-portrait, phone-360-landscape, brutal-phone,
   mobile-zoom130) — 73 definitions → 196 executions. Do NOT split
   per-project and do NOT use `--project` subsets for the green run.
   Budget ~25–35 min; set step `timeout-minutes: 45`. 10. **After
   the run (always):** re-check `BUILD_ID` still equals
   `BUILD_ID_BEFORE` (else the run is invalid, re-run from step 6);
   summarise `playwright-report.json` by spec + project; upload
   `apps/web/test-results` **plus** `playwright-report.json` on
   failure; stop the server and confirm port 3105 is down.
   11. **Reading the result:** green = 196/196 (minus the
   known-skipped zoom130 test on non-277 px projects). Triage any
   failure from the JSON against §3.1 above; S-3/S-4 would already
   be known, anything else is new evidence.

**What Playwright triage could NOT run, and what must be proven on CI:**
No browser launch in this sandbox (Chromium cannot launch; the
worker's own `playwright test` attempt died at config load on EPERM
write). No test was executed; no tile-paint, WebGL, or phone-width
observation was made. All verification is source-level. **Must be
proven on CI (§3.3 runbook):** the full 196-execution matrix green;
the 4 timeout-kills resolved by `--workers=1` + sequential order (if
they persist, the 120 s timeouts / `startMatch` flow need work, not
more workers); map canvas + tile painting with WebGL; S-3/S-4 fixes
passing; Meera's 12 triaged failures re-checked against fresh
failures from `playwright-report.json`. **Not provable by CI:** real
outdoor GPS, QR-camera scan, 130% zoom *look* (only the 277 px
layout equivalent), KDS on a real wall display — founder phone
checks, as before. **Open items carried forward:** S-3, S-4 (spec
fixes); G-1 (CI env var — blocks the whole e2e step); G-5 (stale
"63 tests" in `ci.yml`/`docs/CI.md`); `e2e/README.md` missing; the
targeted run's failure list was never filed — if it still exists
anywhere, attach it to the next triage instead of re-diagnosing from
memory.

## 4. Corrections to my own previous review (adversarial honesty)

- **§7.2 #4 was wrong.** "Let's go!" exists —
  `TeamRadio.tsx:56`, `'Let’s go!'` with a curly apostrophe (U+2019);
  my straight-apostrophe grep missed it. The test regex
  `/Let.s go!/` matches. Not stale.
- **The "app is Leaflet-based" claim in the verification report was
  already rejected in the previous review (D-M14) and is rejected
  again here:** the app is vendored MapLibre v5; the
  `.mapbox .maplibregl-canvas` selector is correct.
- **Previous numbers no longer describe this tree.** The previous
  report's typecheck 4/4, lint 0/0, unit 178/0/9, vitest 21/21,
  test:web 34/34, and build #2 HTTP sweep 28/28 were verified then;
  the tree has since gained code (voice radio, lobby controls,
  regenerate-code, per-shrink next zones) and lost its build
  artifacts. Current source numbers are §2 above: web typecheck
  1 error, lint 1 error, engine 49/52, workers 157/164, vitest
  37/37 (replicated), test:web 71/71 (in memory), playthrough
  45/45, **no production build exists**.

## 5. What would flip this to PASS

1. Fix the web type error (`play/page.tsx:89` — supply `pausedFrom`
   and `catchExpiresAtMs` in `snapshotToDemoRoom`) and the lint error
   (`live-client.ts:56` — remove the unused `PakdamSocketState`
   import).
2. Finish D-M3 in the lobby (one-line: show `locationPrecisionLabel`
   next to Mode or in the ReadinessChecklist GPS-quality row) and get
   the founder ruling on the "Map downloaded for Ranchi only."
   string (exempt, or reword to "Map downloaded for this area
   only").
3. Fix S-3 and S-4 in the specs, fix G-1 in `ci.yml` (set
   `PAKDAM_ALLOW_PLACEHOLDER_URL=1` on the e2e step), correct the
   stale "63 tests" count, and extend `scripts/test-web-lib.sh` to
   cover `map-location` + `demo-store-parity` (18 tests currently
   never run).
4. **Stop concurrent builds on this tree** — the rebuild loop that
   zeroed dist and destroyed `.next` mid-review must be halted
   before any verification run; rebuild once, sequentially, on a
   quiet tree (or on CI), and verify the build serves (BUILD_ID
   stable, chunk-200 gate).
5. Run the §3.3 sequential CI runbook: full 196-execution matrix
   green, then a Meera re-review on the quiet tree.
6. Still owed outside this VM and unchanged: live deployment,
   real-phone GPS + outdoor field test, QR-camera scan, dark-mode /
   130% zoom / KDS eyeball checks, Sentry DSN, HNT-071 calibration,
   public-pilot legal/trademark work (deferred per the founder's
   personal-game decision).

## Evidence files (this review; ephemeral, under /tmp)

- `/tmp/meera-playwright-triage-2026-11-18.md` — full Playwright
  triage report with quoted evidence.
- `/tmp/meera3/` — `run-mem.mjs`, `bundle.mjs`, `vitest-shim.mjs`,
  `playthrough.mjs`, `repro-step9.mjs`, `manifest*.json`,
  `tsconfig.{engine,workers,web}.json`, `bundles/` (all 0-byte, from
  the failed disk-write attempt).
