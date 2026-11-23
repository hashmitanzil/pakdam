# Meera — Pakdam MASTERPIECE redesign review (independent verdict)

- Reviewer: Meera (independent reviewer)
- Date: 2026-11-17 (review run ~09:04–09:30 UTC / ~14:34–15:00 IST)
- Scope read first: `pakdam-masterpiece-brief-v2.md`,
  `pakdam-competitor-deep-dive-2026-11-17.md`, and all eight reports in
  `pakdam-app/docs/REDESIGN-*.md` (V1 landing/HUD/lobby/Kabir; V2
  modes/find-demo/leaderboard/HUD-landing; triage).
- Work in `~/workspace/goals/hide-and-seek-combo-game/files/pakdam-app/`.

## VERDICT: NEEDS FIXES

The build is green — typecheck, unit tests and the production build all
pass on my own runs — and most of the brief is genuinely built. But the
headline requirement, **four modes playable**, is NOT true in the live
tree: host setup offers only Classic/Infection, and the app says so in
three places. The triage report claims Ruling 1 was applied; the files
I read say otherwise. Until the mode-scope contradiction is resolved
and the host-setup spec is green against the ruled scope, this does not
pass. No builder report was modified.

## 1. My own verification (real output, not builders' claims)

| Check | Result (mine) |
|---|---|
| `npm run typecheck` (all 4 workspaces: shared, engine, workers, web) | **PASS, exit 0, zero errors** |
| `npm test` (root) | **PASS, exit 0 — engine 27 pass / 0 fail / 3 skipped** (Phase-1 native background-GPS skips), **workers 19 pass / 0 fail. Total 46 pass, 0 fail.** |
| Production build (`PAKDAM_ALLOW_PLACEHOLDER_URL=1 npm run build`) | **PASS, exit 0, 28 static pages.** Route table includes `/demo` (6.14 kB) and `/find` (4.86 kB). (Bare build is refused by the placeholder-URL trademark guard, as intended.) |
| Playwright smoke, desktop (`e2e/smoke.spec.ts`) | **Run 1: 4 passed, 1 failed. Run 2: 5 passed.** See §4 — draw-dependent, reproduced by me. |
| Playwright host-setup (`e2e/host-setup.spec.ts`), desktop, against my own server | **1 passed, 3 failed.** See §5. |
| Live curl vs my own production server (port 3210, my build) | landing 200, `/demo` 200, `/find` 200, `/game-modes` 200, `/create` 200. Served HTML confirms the mode wording in §2. |

## 2. BLOCKING — Four modes playable: NOT FIXED (triage Ruling 1 reverted or never landed)

Brief v2 + triage Ruling 1 require all four modes (Classic / Infection /
Zombie / Breach) selectable in host setup and stated as playable on the
game-modes page and landing. The live tree says the opposite, in four
places, all verified by my own grep + served HTML from my own build:

- `apps/web/src/components/host-setup/HostSetupForm.tsx:30-31` (header
  comment): *"Mode: Manhunt only in the pilot — Classic and Infection.
  Zombie and Breach are DEFERRED (founder decision, 2026-11-17): not
  offered in host setup, not selectable, no date promised."* Grep for
  `More modes|Zombie|Breach` in this file returns ONLY that comment —
  there is no "More modes" radio group, no `changeMode`, no Zombie
  hunter-clamp in the form. The triage report (§1) claims all three
  were added. They are not in the file I read.
- `apps/web/src/components/host-setup/draft.ts:245,311`: restoring a
  draft or preset **coerces `zombie`/`breach` back to `classic`** —
  *"Deferred modes (Zombie/Breach) can never be restored."*
- `apps/web/src/app/game-modes/page.tsx`: title *"Two modes in the
  pilot. Two more deferred."*, metadata *"Classic Manhunt and Infection
  in the pilot; Zombie and Breach deferred"*, the `DEFERRED` map is
  present, Zombie/Breach carry a "Deferred — not playable yet" pill and
  no Host-a-Game CTA. The triage report claims the `DEFERRED` map was
  deleted and the title rewritten. It was not.
- `apps/web/src/app/page.tsx:102` (landing showcase): *"Two game modes
  — Classic Manhunt and Infection — picked in host setup."* Served
  HTML from my own 3210 server contains "Two game modes" twice and no
  "Four game modes".
- `apps/web/src/components/landing/ModesPreview.tsx:2-3,46`: still the
  deferred wording (*"Zombie and Breach are deferred — not playable
  yet"*).
- `/create` served HTML contains "Classic Manhunt" and "Infection"
  only — no Zombie/Breach as selectable modes.

What DID survive from the modes work (engine side, verified): the
engine's `MODE_INFO` / `modes.ts` covers all four modes with their
rules; `demo-store.ts:94-100` still clamps Zombie's effective Hunter
count to 1; engine tests for modes pass. But no UI path can create a
Zombie or Breach room, so "four modes playable" is false in the
product. The smoke "game modes" test still passes only because all
four mode *headings* exist — it does not assert playability.

**Scope conflict the parent must arbitrate (I do not resolve it):**
the deferred wording cites a *"founder decision, 2026-11-17"* that
only Classic/Infection are playable in the pilot. That directly
contradicts Brief v2 ("Combine ALL features of BOTH games", Zombie +
Breach modes listed) and triage Ruling 1. One of the two is wrong.
Note the file mtimes: the deferred-wording files are stamped
08:43–08:53 UTC, the triage report 09:04 UTC — either the triage
edits were reverted by a sibling within the hour (the same edit-war
the HUD report §6 documents: five reverts of the mode wording), or
they never landed. Either way, the live tree is two-mode, and the
host-setup spec (§5) agrees with the live tree on modes. The fix is
either (a) re-apply Ruling 1 and stop the reverts, or (b) a founder
ruling that two-mode scope is correct, in which case Brief v2, the
triage report and this review's requirement must all be corrected
together — not by silent reverts.

## 3. Verified FIXED (my own evidence)

- **No area-name / venueName field.** Grep over `apps/web/src`,
  `packages/shared/src`, `packages/engine/src`, `workers/src`: zero
  live `venueName` occurrences — only one removal comment in
  `demo-store.ts:43`. "area name" hits are removal comments only.
  Host setup is location-first: "Use my location" is the primary
  action (`PlayAreaMap.tsx:458`, `ZoneEditor.tsx:203`), GPS centre,
  no hardcoded centre, tap-to-place fallback with plain-language
  permission-denied copy.
- **Zone 200 m–3 km across, auto-suggested.** `ZONE_RADIUS_MIN_M =
  100`, `ZONE_RADIUS_MAX_M = 1500` (`types.ts:134-135`);
  `HOST_RANGES.zoneDiameterMeters = { min: 200, max: 3000 }`
  (`validation.ts:27`); slider labels "200 m across" / "3 km across"
  with hint "Radius 100 m–1.5 km, about 200 m–3 km across"
  (`HostSetupForm.tsx:240-241`); drawn-zone check `dia < 200 ||
  dia > 3000` (`draft.ts:165`); size suggested from player count via
  `suggestZoneRadiusMeters` (`draft.ts:149-150`, `calibration.ts:46`).
- **Everything host-customisable.** Duration stepper 5–180 min
  (`DURATION_STEPS_MIN`), head start 0–30 min (`HEAD_START_STEPS_S`),
  ping 0 (none)–30 min (`PING_STEPS_S`), Hunters stepper, "Random
  hunters" toggle switching Random ↔ Selected
  (`HostSetupForm.tsx:281-286`), zone-size slider, shrink on/off +
  1–60 min timing (`SHRINK_STEPS_MIN`), catch-confirmation toggle
  "Runner confirms every catch" (`:363-366`), house-rule presets
  save/load/delete (`:105-130`, localStorage), live summary strip
  (`roomSummaryStrip`, `draft.ts:136-145`).
- **No payment / membership / pricing / checkout UI.** Grep over all
  app + package sources returns zero hits outside the "Everything is
  free — no payment, no membership, no paywall" negations (landing,
  game-modes, host setup, FAQ). No prices, no paywall, no checkout.
- **No copied ShadowHunt/SCRAM text, images, or brand.** No
  competitor hero lines anywhere ("Your city is the map" /
  "The real hide-and-seek": zero hits). Only residue: "SCRAM-grade" /
  "SCRAM-style" in four **code comments** (`play/page.tsx:41`,
  `hud/HudBar.tsx:6`, `hud/PlayerDots.tsx:15`,
  `hud/BottomTabs.tsx:10`) — developer shorthand, not user-facing
  copy. Acceptable, but the comments should be reworded to avoid the
  appearance of copying.
- **Find-a-Room.** Live tree holds the Brief-v2 version:
  private by default, opt-in "List publicly" (`MyPublicListing.tsx`),
  coarse distance bands only ("under 1 km", "about 1–3 km",
  "about 3–5 km", "about 5–10 km", "over 10 km" —
  `public-listing.ts:57-65`), direction word, no exact location/map
  pin/place name/host name; `/find` in the build route table; join
  page links to it (`join/page.tsx:158`). The sibling
  `PublicLobbyListing` version (100 m-rounded distance, host codename,
  15-min TTL) is NOT in the live tree — the spec conflict the
  find-demo report flagged is still open for the parent, but the live
  Find matches Brief v2.
- **Demo vs bots.** All files present (see §6). 5-minute demo
  (`DEMO_DURATION_SECONDS = 300`, `demo-bots.ts:64`), "Demo round —
  play against bots", real engine catch flow
  (`createRoom` → `addDemoPlayers` → `requestCatch` →
  `verifyCatchScan` → `confirmCatch`, `demo/page.tsx:129-143`), bots
  labelled "Bot" throughout. Served `/demo` HTML confirms the page
  renders from my build.
- **Leaderboards — points only from real match data.**
  `leaderboard.ts`: +1 per 3 min free (cap 10), +10 never caught,
  +3 per confirmed tag, +10 clean sweep; **only COMPLETED matches
  count** (`pointsForMatch` returns null otherwise); missing
  start/end times flag `incompleteData` instead of inventing points;
  disputed/requested catches earn nothing.
- **Team Radio text-only; voice NOT claimed.** `TeamRadio.tsx:179-182`
  renders *"Text only in this web version. Voice push-to-talk is not
  available in the PWA…"* and the header comment states there is no
  voice relay. The landing's "Voice radio … if it can be done
  honestly" line sits under "Planned after the pilot" — a future
  item, not a claim. Correct.
- **SOS / pause always visible.** `HudBar.tsx:71-75`: SOS + Safety
  Pause buttons ride in the floating top HUD; `SafetyControls` also
  renders the bottom safety bar on the play page (`play/page.tsx:455`).
- **Suspension resume works (source-verified).**
  `resumePlayer(roomId, playerId)` exists (`demo-store.ts:316`) and
  is called on all three paths in `play/page.tsx`: on mount (`:89`),
  on `visibilitychange` to visible (`:92`), and from a "Resume
  sharing" button in the suspended banner (`:330`). I did **not**
  re-verify this live in a browser (see §7 — Chromium died
  mid-review); the triage report's live verification stands
  unrebutted, and the code paths are present as claimed.
- **Outside-zone dead config gone.** Zero occurrences of
  `outsideZoneLiveSeconds` / `outsideZoneTagSeconds` /
  `outsideZoneStatus` in all sources (triage §3 confirmed; my grep
  agrees). Fixed rule is the 30-second return countdown then
  ejection (`OUTSIDE_ZONE_RETURN_SECONDS = 30`, `ejectPlayer`).

## 4. Smoke suite — draw-dependent failure CONFIRMED by my own runs

- **Run 1 (against the :3105 production server): 4 passed, full loop
  failed at `smoke.spec.ts:169`** — Runner draw: after clicking
  "Refresh my location", the text "Location refreshed — one fresh
  fix sent" never appears within the 10 s expect timeout. Identical
  failure point to triage §7.4.
- **Run 2 (same server): 5 passed** — Hunter draw; the refresh
  branch is skipped.
- This reproduces the triage finding exactly: the full loop passes
  only on a Hunter draw. I did **not** re-run the triage's §7.5
  probes (Chromium died before I could, §7), so I neither confirm
  nor dispute the root-cause mechanism (high-accuracy `watchPosition`
  starving one-shots under Playwright's static geolocation mock).
  What I confirm is the symptom, twice, at the same line.

  **Judgement:** this does not by itself hold the gate *if* the
  owner explicitly accepts it as a mock-environment limitation and
  verifies Refresh on a real phone — but it must be an explicit
  owner decision, recorded, not a silent pass. A 50%-ish coin-flip
  suite is not a green suite. Real-phone verification of Refresh is
  still owed.

## 5. host-setup.spec.ts — 3/4 fail on my own server (stale spec, confirmed)

Run against **my own** production server (port 3210, my build):
**1 passed** (house preset save/reload), **3 failed**:

1. `host-setup.spec.ts:12` — expects the strip
   `"1 km zone · 2 hunters · 3 min pulse · 30 min"`. The app renders
   `"1.0 km zone · 2 hunters · 3 min pulse · 1 h"`. Verified in
   source: `formatDistance(1000)` → `"1.0 km"`
   (`freshness.ts:167-170`); `formatMinutes(60)` → `"1 h"`
   (`draft.ts:115-120`); Standard duration is 3600 s. The spec's
   expected text is stale against the app's own formatters.
2. `host-setup.spec.ts:116` — expects `"no zone · 2 hunters ·
   no pings · 30 min"`. Same stale-duration cause (`"1 h"`, not
   `"30 min"`).
3. `host-setup.spec.ts:154` — `getByRole('region', { name:
   'Match summary' })` finds nothing. The lobby page renders
   `<div className={styles.summaryStrip} aria-label="Match summary">`
   (`room/[roomId]/page.tsx:223`) with **no `role="region"`** —
   pre-existing, as triage §8.3 noted.

Also stale but untested (test 1 fails at line 23 before reaching
them): the spec asserts Breach/Zombie text count 0 (`:28-29`) and
expects the text "There is no 1 km cap" (`:39`), which the app no
longer renders (ruling 2 replaced it). The spec is stale in both
directions at once — it asserts the **old strip text** and the
**reverted two-mode scope**. It needs a rewrite to the ruled scope,
and that rewrite cannot be done until the mode-scope arbitration
in §2 is settled. I did not edit the spec (ruling: no e2e weakening).

## 6. Demo/find files — present at review time (both ends)

Checked at review start and again at review end; all present:

- `apps/web/src/app/demo/page.tsx`, `components/demo/DemoBoard.tsx`,
  `components/demo/DemoResult.tsx`, `apps/web/src/lib/demo-bots.ts`
- `apps/web/src/app/find/page.tsx`, `components/find/PublicRoomList.tsx`,
  `components/find/MyPublicListing.tsx`,
  `components/find/public-listing.ts`

No deletion struck during my review. The deleter is still
unidentified (triage §5: six deletions); presence at review time is
not durability. The parent should still find the deleter.

## 7. Honesty notes — what I could NOT verify, and environment breakage

1. **My :3105 smoke runs were not against my own server.** When I
   started my production server on :3105 it failed with
   `EADDRINUSE` — a sibling's server already occupied the port —
   so my first smoke runs (4/5, 5/5) and the first host-setup run
   hit the sibling's server. That server was serving the same repo
   build and the results match the source evidence exactly, but I
   state it plainly: those two runs were not against my own server.
   I then started my own server on :3210 (killed by PID afterwards)
   and re-verified host-setup 1 passed / 3 failed there, plus curl
   content checks on :3210. The numbers are corroborated by source
   + served HTML, but the :3105 runs carry that caveat.
2. **Chromium died mid-review (~09:19 UTC).** Both Playwright
   browser binaries (`chromium_headless_shell-1255` and
   `chromium-1255`) now exit 133 (SIGTRAP) immediately, even
   standalone with `--dump-dom about:blank`, in every launch mode
   tried (`--no-zygote --single-process`, fresh profile dirs, new
   `--user-data-dir`). No missing libraries (`ldd` clean). They
   worked in this same VM ~40 minutes earlier (my successful runs
   above). Separately, Playwright's transform-cache writes fail
   with `EPERM` (`addToCache`, `writeFileSync`) and `npx` fails
   writing its log with `EPERM` — consistent with concurrent-worker
   interference on the shared overlay filesystem, though I could
   not prove the mechanism (`strace` is blocked: ptrace_scope=1).
   Consequence: I could **not** re-run the smoke suite against my
   own :3210 server, re-run the triage §7.5 geolocation probes, or
   live-verify the resume path in a browser. Those three items are
   therefore reported as "code present + earlier runs" rather than
   "re-verified live by me". This is an environment failure, not an
   app failure — it must not be read as either a pass or a fail of
   the app.
3. **Mobile Playwright coverage** remains unrunnable here (webkit
   binary missing — triage §7.4). Desktop only is proven.
4. **No real-phone / visual check** was possible (text/DOM only, per
   the gateway rule). Founder's eye on a real device is still owed.

## 8. Other defects found (fix, or explicitly accept)

1. **Stale "Planned after the pilot" copy on the landing**
   (`page.tsx:118-122`): lists **Find-a-Room** and **Friends /
   "Played with"** as planned — both are built and live (`/find`
   route; profile Played-with). False as written; move them to the
   built list or delete the section. Related: the game-modes page
   says *"Private invite-only — no public games"*
   (`game-modes/page.tsx:46`) while Find-a-Room now lists public
   games. Contradictory.
2. **Outside-zone live-reveal over-claim.** The play page
   (`play/page.tsx:454`) and the outside-zone banner state:
   *"While outside, Hunters can see your coarse area, never your
   exact position."* My grep finds **no wiring** that sends an
   outside player's coarse area to Hunters — only the 30-second
   countdown and ejection (`demo-store.ts:343-377`). The HUD report
   §2 already flagged this as "spec'd, not wired". Either wire the
   reveal or reword the claim; a stated rule that is not enforced
   is a false statement to the player.
3. **"SCRAM-grade / SCRAM-style" in code comments** (§3) — cosmetic;
   reword to Pakdam's own terms.

## 9. What must happen before READY

1. **Settle the mode scope (parent/founder arbitration, §2), then
   make the whole app agree**: host setup offers all four modes
   (or the brief + triage ruling are formally corrected to two),
   game-modes page, landing showcase, `ModesPreview`, and
   `draft.ts` coercion all aligned. This is the gate item.
2. **Rewrite `e2e/host-setup.spec.ts`** to the ruled scope and the
   app's actual strip text (`"1.0 km … · 1 h"`), and add
   `role="region"` to the Match summary strip (or fix the spec's
   locator) — then get it to 4/4.
3. **Fix or explicitly accept** §8 items 1–2 (stale "planned" copy;
   outside-zone reveal claim).
4. **Owner decision, recorded**: accept the Runner-draw refresh
   failure as a mock-environment limitation (with real-phone
   verification of Refresh), or authorise a fix to the refresh path.
5. Re-run the full smoke suite + host-setup spec once the above
   land, on a quiet machine if possible — the concurrent-worker
   interference in §7 makes any single run hard to trust.

## 10. Files changed by this review

- This report only:
  `pakdam-app/docs/MEERA-REDESIGN-REVIEW-REPORT.md`.
- No builder report modified. No app code touched. My production
  server on :3210 was stopped by PID after verification.
