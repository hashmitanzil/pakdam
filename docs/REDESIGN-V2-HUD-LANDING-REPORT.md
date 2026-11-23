# Pakdam — Redesign v2: HUD delta + landing fix (worker report)

Worker: HUD delta + landing fix (Brief v2). Date: 2026-11-17.
Area (only these files): `apps/web/src/app/page.tsx`, `how-it-works/page.tsx`,
`game-modes/page.tsx`, `about/page.tsx`, `faq/page.tsx`, `safety/page.tsx`,
`room/[roomId]/play/page.tsx`, `room/[roomId]/catch/page.tsx`,
`room/[roomId]/results/page.tsx`, `apps/web/src/components/match/*`,
`apps/web/e2e/smoke.spec.ts`. Create, profile, lobby, host-setup, engine,
shared and demo-store were read, never edited.

This report extends the v1 HUD and landing workers; it does not redo their work.
It also records that a second HUD worker ("Worker 3") rebuilt the play page
during this task (new `components/hud/`, `components/catch/`,
`components/radio/`), and that a sibling keeps reverting the mode-count
wording — see §6. Where this report says "verified", the evidence is a real
command run listed in §7, not a summary.

## 1. What changed, per file

### HUD — play screen (`room/[roomId]/play/page.tsx`, `components/match/*`)

- **Team assignment (founder update, Brief v2).** The HUD shows the mode and
  the team-assignment mode plainly, from the real room config:
  `Classic Manhunt · Teams: random` / `Teams: host picked`. The label helper
  is `teamAssignmentLabel()` in `components/match/ModeZonePanel.tsx`
  (`random` → "Teams: random", `selected` → "Teams: host picked",
  `undefined` → "Teams: not recorded"). Host-picked Hunter names are
  resolved from `selectedHunterIds`, never inferred from join order.
  The same line is shown on the catch and results pages.
- **Infection / turning modes.** Role flips are live: `confirmCatch()` in the
  demo store calls the engine's `applyConfirmedCatch()`, which flips a tagged
  Runner to Hunter in Infection and Zombie (`modeTurnsRunner()`), and the
  roster, the coarse dots and the catch panel all read the live `matchRole`
  records. The catch page states the mode rule in plain words
  ("In this mode, a confirmed catch flips this Runner to Hunter" vs
  "takes the Runner out"). The results page uses mode-aware wording
  ("Turned Runners" in turning modes, "Caught Runners" otherwise).
- **Outside-zone rule — founder rule, 2026-11-17 (this supersedes the brief's
  original wording).** The rule the app now implements is a fixed 30-second
  return countdown, then **ejection** — not "30 s = live, 2 min = tagged".
  Evidence: `OUTSIDE_ZONE_RETURN_SECONDS = 30` (`packages/shared/src/types.ts`),
  engine `zone.ts` `outsideZoneReturnRemainingSeconds` /
  `isOutsideZoneEjectionDue`, demo-store `ejectPlayer()` (sets `ejectedAt`,
  logs the event, completes the match as a Hunters win when no Runner is left
  in play), and the play-page effect that ejects the current player when
  their own fix has been outside for 30 s (HEAD_START/ACTIVE only, once per
  page session, never while paused or in the lobby). The engine test
  "zone: outside-zone rule is a fixed 30-second return countdown, then
  ejection" passes. The play page, the zone banner and the landing page all
  state the rule the same way: "30 seconds to get back inside, or you are
  ejected from the game."
- **Outside-zone clock.** Computed on the play page from the player's own fix
  against the zone boundary (`pointInPolygon`, guarded by `playZoneEnabled`
  and `boundary.length >= 3`). The clock starts on first going outside and
  resets on return inside or loss of fix. No zone (`playZoneEnabled` off)
  means no inside/outside at all. The banner only appears when outside;
  the rule text is printed on the play page at all times.
- **No-zone games.** When the play zone is off, the HUD shows
  "No zone — classic hide and seek", "Next ping —", and the small print
  "No play zone in this game — no outside-zone rule." Pings are forced off
  with the zone (`pingIntervalSeconds: 0`).
- **NaN fix (coordinator ruling 3).** The play page already guarded the
  division (`nextPingIn` is `null` when `pingIntervalSeconds` is 0), and a
  two-room diagnostic (zone-on and zone-off, both driven to ACTIVE) showed
  **zero "NaN" lines** on the play page in either case. As a last line of
  defence this worker hardened `formatClock()` in
  `components/match/freshness.ts`: a non-finite input now renders `0:00`
  instead of `NaN:NaN`. The sibling's no-zone test (see §5) now covers this
  permanently.
- **Worker 3's rebuild (not mine, recorded for the record).** The play page
  was rebuilt during this task with a new floating HUD
  (`components/hud/HudBar`, root is a region named "Match status" — there is
  no `.hud` class any more), `OutsideZoneBanner`, `PlayerDots`, `BottomTabs`,
  `CatchPanel` and `TeamRadio`, plus role hiding ("No peeking — tap to find
  out your role"). My `ModeZonePanel` is therefore **currently unrendered**
  on the play page; the file stays because it is the shared home of
  `teamAssignmentLabel()` (imported by play, catch and results) and its
  header comment now says so. My old `components/match/HudBar.tsx` was
  deleted by that rebuild (it had no importers left). The rebuild kept my
  outside-zone computation, my `teamAssignmentLabel` import and my
  `nextPingIn` guard verbatim.

### Landing (`app/page.tsx`)

- Visible Pakdam heading restored: `Pakdam — your city is the playing field.
  Run from real Hunters.` (the v1 landing had removed it and broken e2e).
- Free statement in the hero: "Everything is free — no payment, no
  membership, no paywall." No payment/membership/pricing UI or wording
  anywhere in my pages (verified by grep, §7) — the only payment words are
  that negation and the same statement on the game-modes page.
- Combined-features showcase ("Everything in one game — free"): free PWA,
  3–16 players, 18+, private invite-only, room code, host presets, the four
  game modes, host-picked/Random teams, house-rule presets, the outside-zone
  rule, location-first zone, head start, coarse pings/compass/hot-cold,
  shrinking zone, in-person tag, Team Radio text, host dashboard, round card
  + leaderboard, safety, and the demo round against bots (`/demo` link).
  "Planned after the pilot": Find-a-Room, Friends/"Played with", voice radio.
  The stale `<ModesPreview />` usage was removed from the landing (the
  component file itself, owned by a sibling, still claims only Classic is
  playable — flagged in §6).

### Game modes (`app/game-modes/page.tsx`)

- All four modes as cards driven by the engine's `MODE_INFO` (single source
  of truth): Classic, Infection, Zombie (exactly 1 starting Hunter), Breach
  (zone must shrink). Free statement top and bottom. Mode-aware ground-rules
  card (teams host-picked or Random; tag counts at once when confirmation is
  off, Runner may still dispute). See §6 for the title wording conflict.

### Other landing pages

- `how-it-works`, `about`, `faq`, `safety`: checked; the only payment wording
  in my area was the old game-modes line, removed. No changes needed.

### E2E (`apps/web/e2e/smoke.spec.ts`) — 5 tests, all passing

- Landing test asserts the Pakdam heading, foreground warning,
  "Everything is free", and the Host/Join links.
- Game-modes test asserts all four mode headings, the free statement and a
  Host link.
- Full loop (create → join → lobby → start → play → catch → results)
  rewritten for the current app: single-screen host setup, Standard preset,
  codename field, mocked geolocation (23.36, 85.33), "Use my location",
  venue/on-site checkboxes, "CREATE LOBBY"; lobby ready with a
  curly-apostrophe-proof regex (`/I.m ready/i`); `Players (5/6)` (default
  draft sizes the game for 6); HUD assertions against the rebuilt HUD
  (region "Match status", "Active — hunt on", role reveal tap, host's actual
  role from the store — the Random draw is now a real shuffle, so the host
  is not necessarily the Hunter); outside-zone rule text; catch loop in a
  **second tab** (see §5); results assertions against the current wording.
- No real assertion was weakened. Every fix below is a disambiguation or a
  wording update to what the app actually renders.

## 2. Engine-wired vs spec'd (current truth)

Engine-wired and shown live: four modes and their catch/win rules; Infection
and Zombie role flips on confirmed catch; team assignment Random/Selected
with host-picked names; outside-zone 30-second return countdown with
**enforced ejection**; mode-aware outcomes including ejected Runners never
counting as survivors; ping-off (`null`, never a division by zero).

Spec'd, not wired (labelled as such where shown): live reveal of an
outside Runner's coarse area to Hunters (the rule text says Hunters can see
your coarse area while outside, but no live-reveal is sent in this build —
the ejection at 30 s is what is enforced); Find-a-Room; Friends/"Played
with"; voice radio (text radio only).

Dead config (flag, not fixed — shared/engine are outside my area):
`outsideZoneLiveSeconds`, `outsideZoneTagSeconds` and the engine's
`outsideZoneStatus()` have **zero usages** outside their definitions. They
are the old "30 s live / 2 min tagged" model, fully superseded by the
ejection rule. Recommend removal or repurposing by the shared/engine owner
so hosts are not confused by dead settings.

## 3. Coordinator rulings — compliance

1. **Demo/find files:** not deleted, moved or edited by this worker. No file
   under `apps/web/src/app/demo/`, `apps/web/src/components/demo/`,
   `apps/web/src/lib/demo-bots.ts`, `apps/web/src/app/find/` or
   `apps/web/src/components/find/` was touched. Stayed inside the assigned
   file area throughout.
2. **Zone-size range (Brief v2 wins: zone DIAMETER 200 m–3 km).** There is
   **no** `HOST_RANGES` / `ZONE_RADIUS_*` / radius control in any file I own
   (my files only display a zone size via `zoneSizeLabel`, never enforce a
   range). Controls outside my area that still enforce the wider range —
   for the owner to align:
   - `packages/shared/src/types.ts:134-135` — `ZONE_RADIUS_MIN_M = 200`,
     `ZONE_RADIUS_MAX_M = 10000` (radius 200 m–10 km → diameter 400 m–20 km).
   - `packages/shared/src/validation.ts:18,92-93` — `HOST_RANGES.zoneDiameterMeters
     = { min: 400, max: 20000 }`, error message "zone diameter must be
     400 m–20 km across (radius 200 m–10 km)".
   - `packages/shared/src/calibration.ts:45` — comment citing the 10 km max.
   - `apps/web/src/components/host-setup/draft.ts:24,50` — comment "Zone
     radius: 200 m–10 km, step 50 m, default 500 m" and `RADIUS_BOUNDS`
     built from the shared constants.
   - `apps/web/src/components/host-setup/HostSetupForm.tsx:82-83,224-227` —
     radius stepper from `RADIUS_BOUNDS`.
   - `apps/web/src/components/host-setup/PlayAreaMap.tsx:5,397,406` — uses
     `ZONE_RADIUS_MAX_M`/`MIN_M` (×2 for diameter scaling).
   Correct values for diameter 200 m–3 km would be radius 100 m–1.5 km
   (`ZONE_RADIUS_MIN_M = 100`, `ZONE_RADIUS_MAX_M = 1500`,
   `zoneDiameterMeters = { min: 200, max: 3000 }`). The Standard preset's
   500 m radius (≈999 m across, as shown live in the HUD) is inside the
   corrected range either way.
3. **Play-page NaN when pings are off:** fixed and verified — see §1
   (`formatClock` hardening) and the diagnostic result (0 NaN lines in both
   a zone-on and a zone-off room driven to ACTIVE). The division itself was
   already guarded; the hardening is the last line of defence.

## 4. Verification (real output, 2026-11-17)

- `npm run typecheck`: **PASS, zero errors** in all four workspaces
  (shared, engine, workers, web). The earlier `leaderboard.ts` breakage
  (profile worker's file) is fixed — typecheck is clean.
- `npm test`: workers **18 pass / 0 fail**; engine **27 pass / 0 fail /
  3 skipped** (the 3 skips are Phase-1 native background-GPS tests). The
  earlier failing engine test ("room config: host ranges + mode rules")
  now passes — a sibling fixed the engine/validation side.
- Production build (`PAKDAM_ALLOW_PLACEHOLDER_URL=1 npm run build
  --workspace=apps/web`): **PASS, exit 0** (route table printed, incl.
  `/room/[roomId]/play`, `/catch`, `/results`). Note the build refuses
  without the placeholder escape: `next.config.ts` blocks production while
  `NEXT_PUBLIC_SITE_URL` is still the placeholder — that is the trademark
  gate working as intended, not a bug. `next start` needs the same escape
  for verification only.
- Playwright smoke suite, run against the **production build**
  (`next start` on 3105): **5 passed / 0 failed** (landing, game-modes,
  join-unknown-code, full loop, no-zone). The no-zone test asserts zero
  "NaN" lines on the play page and the no-zone banner.
- Live curl: landing 200, game-modes 200 on both dev and production servers.

## 5. Test fixes made during verification (all in `smoke.spec.ts`)

Each failure below was diagnosed from the Playwright error-context snapshot,
not guessed:

1. **Start-game "failure" was churn, twice.** The first failures were a
   sibling `next build` rewriting `.next` under the running dev server
   (`routes-manifest.json` ENOENT → 500s) and, once, my own build started
   while the suite was running — my mistake, recorded here so it is not
   repeated: **never run `next build` while a suite runs against the dev
   server.** A two-room diagnostic (zone-on + zone-off, driven through
   create → join → lobby → start → play → ACTIVE) proved Start works in
   both cases. The scratch diagnostic (`apps/web/diag-nozone.cjs`) was
   deleted; a sibling had already turned it into the permanent no-zone test.
2. **Head start strict-mode:** `getByText(/Head start/i)` now matches 3
   elements (HUD phase label, banner, card heading) — now matches the card
   heading by role.
3. **HUD assertions:** the rebuilt HUD has no `.hud` class and shows phase
   words, not `ACTIVE` — now asserts the "Match status" region contains
   "Active — hunt on", "N of N Runners", "Teams: random"; role requires a
   tap on "Tap to find out your role" first; the inside-zone assertion was
   replaced with the room's outside-zone rule line (the zone banner only
   renders when outside).
4. **Suspended-Runner catch block (real test-navigation artifact).** The
   catch loop failed with "Catch is disabled: the Runner is suspended" when
   the Random draw made the host a Runner. Cause: `page.goto()` (full
   reload) away from `/play` fires `visibilitychange`, and the play page
   records a suspension for the current player. Real users navigate with
   `router.push` (soft — the document never hides), so this does not affect
   real play; but the test's hard navigations do suspend. Fix: the catch
   loop now runs in a second tab while the play tab stays open and visible.
   **Open gap for the demo-store owner:** suspension has no resume path —
   nothing restores a suspended player to `connected`, so the catch page's
   "they must reopen the PWA first" currently cannot be satisfied by
   reopening. That is a real (if narrow) product gap, not a test artifact.
5. **Second tab had no origin:** a fresh tab is `about:blank`, where
   `localStorage` throws `SecurityError` — the catch tab now loads `/`
   first so `setPlayer` works.
6. **Strict-mode duplicates from sibling UI additions:** "Catch confirmed"
   (card heading + status message) → match the heading; "Caught Runners: N"
   and "Confirmed catches: N" (summary + round-recap `<pre>`) → `.first()`;
   "No play zone in this game" (banner + next-zone note + small print) →
   `.first()`.
7. **Results wording updates:** "3 confirmed catches" → "Confirmed
   catches: 3"; "Create a new game" link → "Play again — start a fresh
   game". No assertion was dropped — the rematch-button absence is still
   asserted (`toHaveCount(0)`).

Flake note: the no-zone test asserts `expect(errors).toEqual([])` on
`pageerror`. It passed in the final run but failed once earlier on a
`pageerror` that could not be reproduced; the sandbox has no external tile
network and maplibre logs tile-fetch failures there. If it flakes again,
scope that assertion to non-map errors rather than deleting it.

## 6. OPEN CONFLICT — mode scope (needs arbitration, do not edit-war)

A sibling landing worker has reverted the mode-count wording in my files
**five times**. Latest revert 2026-11-17 ~07:51 (after my last restore):

- `game-modes/page.tsx` title + metadata now say: "Two modes in the pilot.
  Two more deferred." / "Classic Manhunt and Infection in the pilot; Zombie
  and Breach deferred."
- `page.tsx` showcase now says: "Two game modes — Classic Manhunt and
  Infection — picked in host setup".
- The `MODES` array on the same page is still all four
  (`['classic','infection','zombie','breach']`), so the page renders four
  mode cards under a "Two modes" title — internally contradictory, and the
  game-modes test still passes because the headings exist.

The engine (`MatchMode`, `MODE_INFO`), the host setup (all four offered)
and the four rendered cards all say four modes. This worker's assigned task
says four modes. The sibling's title says two. **I have stopped re-editing
after the latest restore, per the earlier decision.** The parent/coordinator
must arbitrate the pilot mode scope with the founder and tell both workers
the answer once; further silent reverts will keep churning the suite.

## 7. Other flags for owners (not my area, not fixed here)

- `components/TrustStrip.tsx` (landing component, not my file) still says
  "No purchase flow, no paywall" — payment-adjacent wording the landing
  owner should align with the "Everything is free" statement.
- `components/ModesPreview.tsx` (not my file) still claims "Only Classic
  Manhunt is playable in the pilot. Infection planned after the pilot" —
  stale/false against the engine; its usage was removed from the landing,
  but the component should be fixed or deleted by its owner.
- `outsideZoneLiveSeconds` / `outsideZoneTagSeconds` / `outsideZoneStatus`
  are dead config (see §2) — shared/engine owner.
- Zone-size range still the wider 200 m–10 km radius in shared + host-setup
  (see §3.2) — shared/host-setup owner.
- Suspension has no resume path (see §5.4) — demo-store owner.
- Sibling's open item in the test file: roster size varies run to run
  ("possible cross-tab localStorage lost-update in the demo store") — the
  test asserts the HUD matches whatever the store holds (min. 3 runners);
  not investigated further here.
- Dev-server hazard (for all workers): a `next build` while a dev server
  runs deletes `.next` under it (`routes-manifest.json` ENOENT → 500s).
  Recovery is kill-by-PID, `rm -rf .next`, restart dev. Never pattern-pkill
  `next dev` (it can match the caller's own shell).
- Demo/find files were restored from backup by the coordinator after three
  deletions by a concurrent worker; this worker did not touch them.

## 8. Files changed by this worker (final list)

- `apps/web/src/components/match/ModeZonePanel.tsx` — team-assignment
  labels, mode/zone panel (ejection model), header note that the panel is
  currently unrendered on the play page (Worker 3's banner replaced it).
- `apps/web/src/components/match/HudBar.tsx` — deleted by Worker 3's
  rebuild, not by this worker (recorded here).
- `apps/web/src/components/match/freshness.ts` — `formatClock` non-finite
  guard (`0:00` instead of `NaN:NaN`).
- `apps/web/src/app/page.tsx`, `apps/web/src/app/game-modes/page.tsx` —
  Pakdam heading, free statement, combined-features showcase, four-mode
  cards (see §6 for the current title wording, reverted by a sibling).
- `apps/web/src/app/room/[roomId]/play/page.tsx`,
  `catch/page.tsx`, `results/page.tsx` — mode/teams lines, mode-aware
  wording, outside-zone rule text (play page substantially rebuilt by
  Worker 3 during this task; this worker's wiring — `teamAssignmentLabel`,
  outside-zone clock, `nextPingIn` guard — was retained in the rebuild).
- `apps/web/e2e/smoke.spec.ts` — see §1 and §5.
- This report: `pakdam-app/docs/REDESIGN-V2-HUD-LANDING-REPORT.md`.
