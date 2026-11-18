# Pakdam live-game HUD redesign — report (2026-11-17)

Worker: live-game HUD. Founder feedback: the UI did not meet expectations.
Goal: a SCRAM-grade HUD, Pakdam's own design — never copied code, text,
images, or brand from ShadowHunt or SCRAM. All copy written fresh.
Reference: `../pakdam-competitor-deep-dive-2026-11-17.md`.

## What changed

### Shared helpers — `apps/web/src/components/match/freshness.ts`
- Added `pingAgeLabel()` — seconds-aware freshness wording ("Reported just
  now" / "45 s ago" / "2 min ago") for pings; `lastReportedLabel()` kept
  for players.
- Added `formatDistance()` ("180 m" / "1.2 km"), `zoneDiameterMeters()` +
  `zoneSizeLabel()` (approximate zone width, always labelled "about" — a
  polygon boundary is not a circle, so the figure is never presented as a
  surveyed size), `hotColdLevel()` (0–4 meter level for the tier bar), and
  `nextShrinkPhase()` — one shared shrink computation used by both the HUD
  bar and the next-zone panel so the two can never disagree.
- All existing exports unchanged; no game logic, safety, or privacy rules
  touched. No exact opponent positions anywhere; pings stay coarse areas.

### Timer — `components/match/Timer.tsx`
- Same server-end-time-only behaviour, now large tabular numerals with an
  "Almost over" state under 2 minutes shown with words + a border, never
  colour alone. New optional `light` prop for the dark HUD bar.

### New: HUD bar — `components/match/HudBar.tsx`
- Floating sticky top bar (root keeps class `hud`): deep-red header card
  with the big time-left timer, human phase label, and **SOS + Pause
  buttons riding along** so safety is never a scroll away.
- Two chips: **Next ping** (countdown + "Coarse area only — never an exact
  pin") and **Zone** (size "about X across" + "Shrinks in MM:SS — shrink
  N of M", or "Fixed zone — no shrink scheduled").
- **Runners still free N of N** with a labelled progress bar (role=
  progressbar) and a plain-words line ("Nobody caught yet" / "N caught so
  far" / "Every Runner caught"). Phase raw text retained in the HUD region
  for the existing e2e assertions.

### Play — `app/room/[roomId]/play/page.tsx`
- HUD bar replaces the old definition-list HUD; all existing logic kept
  (location watch, wake lock, suspension recording, head-start auto-flip,
  offline/silence banners, simulated location + simulated ping, host
  check-in, calibration note).
- **Map / Radio tabs** (was Map / Compass radar): Map tab = map + next-zone
  panel; Radio tab = compass radar + hot/cold readout (Hunter) or a plain
  explanation (Runner — Runners never see Hunter positions).
- Heading is now "Match — Room {roomCode}". **All area-name / venue-name
  wording removed from this screen** (no `venueName` rendered here).
- Latest-ping line uses fresh-vs-stale wording ("Latest ping: reported
  2 min ago — roughly 180 m north-east of you").
- SOS/pause handlers shared between the HUD bar and the bottom safety bar
  (one confirm step for SOS in both places; SafetyControls still confirms
  internally, the HUD confirms before calling its handler — no double
  confirm anywhere).

### Next-zone panel — `components/match/NextZonePanel.tsx`
- Now shows zone size now + next-zone size, shrink countdown with a
  progress bar through the current shrink interval, and "shrink N of M".
  Way-back guide unchanged in logic, distances now formatted ("about
  1.2 km that way (north-east)"). Still honest when no shrink is
  scheduled or no fix exists.

### Compass radar + hot/cold — `components/match/CompassRadar.tsx`
- Radar dial gains a north marker; readout gains a 5-segment heat meter
  (role=meter, tier word always shown beside it) and seconds-aware ping
  freshness ("Ping reported 2 min ago — 14:32:10"). Tier thresholds still
  labelled calibration OPEN; no new thresholds invented.

### Role toolbar + roster — `components/match/RoleToolbar.tsx`
- Roster rows gain a Fresh / Stale / Suspended / Unknown chip (words +
  shape + letter, never colour alone). Role toolbar: one full-width
  primary action per role, quick signals unchanged (preset buttons only,
  demo-local labelling kept). `SilenceBanner` unchanged in wording.

### Safety — `components/match/SafetyControls.tsx`
- Same four controls, same SOS confirm copy, now 52 px minimum touch
  targets. Sticky bottom bar unchanged. SOS still shares position with
  the host and pauses the match; Pakdam is not an emergency service.

### Catch — `app/room/[roomId]/catch/page.tsx`
- New two-step stepper (`components/match/CatchFlow.tsx`): Step 1 Claim →
  Step 2 Confirm → Done, with the visible claim-state chip (Requested /
  Awaiting confirmation / Confirmed / Disputed / Rejected / Expired) and
  "requested X ago" freshness. Code-check step is its own card; a matched
  code shows "✓ Code matches — now Step 2" and still never counts as a
  catch. Runner confirm/dispute are large side-by-side buttons.
- All e2e-visible strings preserved: heading `Catch — {name}`, "Request a
  catch", "Claim state: … Awaiting confirmation", "Code matches",
  "You are the Runner", "Confirm catch", "Catch confirmed",
  "Confirmed — catch counts". Wrong-code 3-attempt / 30 s cooldown
  unchanged (calibration OPEN).

### Results — `app/room/[roomId]/results/page.tsx`
- Deep-red outcome header (outcome + room code + player count +
  duration). **Venue name removed from the heading.**
- Scoreboard cards: Caught / Still free / Confirmed catches, plus a
  caught-progress bar. Kept strings: "Caught Runners: N", "N confirmed
  catches", no rematch button, "Create a new game" link.
- Awards are all computed from the data: most catches, last Runner
  standing, **first catch** (new — earliest confirmed catch, from
  `requestedAt`), disputed-catch count when any exist. No invented stats.
- Recap timeline entries now carry freshness ("14:32:10 · Reported
  2 min ago — …"). Reveal section unchanged (honest "nothing recorded").
- New shareable round card (`components/match/RoundCard.tsx`): plain-text
  recap (outcome, room code, caught/survivors, confirmed catches, most
  catches, duration, "no locations or routes") with a copy button and a
  manual-select fallback. **Text only — no invented sharing service,
  no posting anywhere.**

### All-safe check — `components/match/AllSafeCheck.tsx`
- Progress bar + "N of N safe" chip, per-player ✓/○ rows, 140-char host
  note unchanged. Placeholder changed from "venue gate" to "meeting
  point" (venue wording removal).

### Files NOT touched (disjoint ownership)
- `components/map/MapView.tsx` (read-only, Kabir owns it), `tokens.css`,
  lobby/create/host/admin pages, `ZoneEditor.tsx`, demo store, engine,
  shared types. No styling-token changes were needed: new visuals use
  inline styles on top of the existing `.card` / `.btn` / `.banner` /
  `.tag` / `.steps` classes.

## Verification (real output, 2026-11-17)

- `npm test` (root): **36 tests, 33 pass, 3 skipped, 0 fail**
  (engine 18 tests: 15 pass + 3 skipped; workers 18 tests: 18 pass).
- `npx tsc -p apps/web/tsconfig.json --noEmit`: **0 errors in any of the
  13 HUD files** (checked by grep across three runs). The HUD files are
  `play/page.tsx`, `catch/page.tsx`, `results/page.tsx`, `HudBar.tsx`,
  `CatchFlow.tsx`, `RoundCard.tsx`, `NextZonePanel.tsx`,
  `CompassRadar.tsx`, `RoleToolbar.tsx`, `SafetyControls.tsx`,
  `Timer.tsx`, `AllSafeCheck.tsx`, `freshness.ts`.
- `npm run typecheck` (root) and the production build do **not** pass
  right now — but the failures are **not in HUD files**:
  - First run: `components/lobby/LobbySafety.tsx:103` — `null` not
    assignable to `LobbyPause`.
  - Build run: `app/room/[roomId]/page.tsx:68` —
    `useState<LobbyPause>(null)` (same `LobbyPause` nullability issue).
  - Latest run: `app/create/page.tsx:114` (ZoneEditor `venue` prop) and
    `components/match/ZoneEditor.tsx:149–152` (`centreLat`/`centreLng`
    possibly null) — 9 errors total, all in sibling workers' files.
  - The error set changed between runs, i.e. sibling workers are
    actively editing those files while this HUD work ran.
  - The plain `npm run build` also stops earlier at a pre-existing
    config gate: `NEXT_PUBLIC_SITE_URL` is still the placeholder
    `https://pakdam.example` (trademark gate). With the documented CI
    escape `PAKDAM_ALLOW_PLACEHOLDER_URL=1`, the web bundle compiles
    successfully in 21.5 s and then stops at the same lobby type error
    above. A real production build needs the real domain (trademark
    gate) plus the lobby/create type errors fixed by their owners.
- Playwright e2e (`apps/web/e2e/smoke.spec.ts`) was **not** re-run here:
  it needs a passing production build first (blocked as above). All
  strings it asserts on the HUD screens were preserved verbatim (listed
  per screen above); the one renamed label is the play-view tab
  ("Compass radar" → "Radio"), which no e2e assertion references.

## Still open
- Lobby `LobbyPause` nullability (`LobbySafety.tsx`, `room/[roomId]/
  page.tsx`) and create-flow `ZoneEditor` prop/nullability errors —
  sibling workers' areas; HUD work is unblocked on them only for the
  full typecheck/build gate.
- Production build needs the real `NEXT_PUBLIC_SITE_URL` after the
  trademark gate clears (pre-existing, not a HUD issue).
- Calibration stays OPEN everywhere it was OPEN: ping interval, catch
  token TTL (120 s), hot/cold tier thresholds, silence interval (60 s
  demo), zone grace period, wrong-code cooldown (30 s). No thresholds
  were invented or hardened.
- No visual check was possible (text-only output, no screenshots); the
  HUD should be eyeballed on a real phone at 100% and 130% zoom and on a
  wall display, per the earlier owner-run residuals.
- Venue-name removal is complete on the three HUD screens; the lobby,
  host, create, admin, and profile screens still render `venueName`
  (other workers' areas — the create flow is mid-redesign to
  location-first setup per the deep dive).
