# Pakdam — Redesign v2: triage report (coordinator rulings settled)

Worker: triage (all 8 build workers done). Date: 2026-11-17.
Briefs read first: `pakdam-masterpiece-brief-v2.md`,
`pakdam-app/docs/REDESIGN-V2-HUD-LANDING-REPORT.md`,
`pakdam-app/docs/REDESIGN-V2-MODES-REPORT.md`,
`pakdam-app/docs/REDESIGN-V2-FIND-DEMO-REPORT.md`.
Work in `~/workspace/goals/hide-and-seek-combo-game/files/pakdam-app/`.

Every coordinator ruling below was applied as written; none was
re-litigated. Where this report says "verified", the evidence is a
real command run listed in §7, not a summary. No e2e assertion was
edited or weakened. No threshold, contact, domain or price was
invented. No payment UI was built. No copied text or brand was used.

## 1. Ruling 1 — four game modes are playable (wording + host setup)

The contradiction was worse than wording: the engine offered all four
modes, but host setup only offered Classic/Infection, while the
game-modes page, the landing showcase and `ModesPreview` each said
something different. All four layers now agree.

- `apps/web/src/app/game-modes/page.tsx` — title is now "Four modes
  in the pilot — all playable.", metadata no longer says Zombie and
  Breach are deferred, the `DEFERRED` map and muted/deferred cards
  are deleted. All four cards render from the engine's `MODE_INFO`
  with "In the pilot" / "available now" and a Host a Game CTA. The
  Breach card states the beta honestly: "flag capture is not built
  yet — Breach plays as Classic catches with a forced shrinking
  zone."
- `apps/web/src/app/page.tsx` (landing showcase) — "Two game modes —
  Classic Manhunt and Infection" is now "Four game modes — Classic
  Manhunt, Infection, Zombie and Breach — picked in host setup".
- `apps/web/src/components/landing/ModesPreview.tsx` — rewritten:
  four live cards (Classic, Infection, Zombie, Breach), heading
  "Four modes to play now.", Breach beta note included, each card
  with a Host a Game CTA. The old "Only Classic Manhunt is playable
  in the pilot. Infection … planned after the pilot" copy is gone.
- `apps/web/src/components/landing/TrustStrip.tsx` — **no change
  needed.** The stale "No purchase flow, no paywall" wording the
  HUD report flagged is not in the current file: the strip lists
  Live GPS pings / Shrinking zone / Compass / Room codes, with no
  payment wording at all (verified by grep). The only remaining
  "no purchase flow" sentence in the app is in `app/faq/page.tsx`
  ("There is no purchase flow in Phase 0 — no payment, no
  membership."), which is the current free/no-membership wording,
  not stale wording — left as is.
- `apps/web/src/components/host-setup/HostSetupForm.tsx` — Zombie
  and Breach are now selectable in host setup, so "four modes
  playable" is true in the app, not just on the page. A "More modes"
  radio group sits under the Manhunt Classic/Infection radios:
  Zombie ("One Hunter starts it. Every Runner tagged turns.") and
  Breach (engine copy + "Flag capture is not built yet, so Breach
  plays as Classic catches with a forced shrinking zone.").
  Picking a mode applies its rule at once (`changeMode`): Zombie
  forces `hunterCount: 1` and Balance off; Breach forces the
  shrinking zone on. The Hunters stepper is clamped to 1 while the
  mode is Zombie, and the Balance toggle cannot be switched on for
  Zombie. The file's header comment ("Breach and Zombie are
  DEFERRED … no room can be created in those modes") is corrected.
- `apps/web/src/lib/demo-store.ts` (`setPhase`) — backstop for the
  same rules at match start: Zombie's effective Hunter count is
  clamped to 1 even if Balance is on, so a match can never start
  with 2–3 Zombies. The stale comment ("Only Manhunt … is offered
  in host setup; Breach and Zombie are deferred") is corrected.

## 2. Ruling 2 — zone size: diameter 200 m–3 km (radius 100 m–1.5 km)

Aligned in every place the HUD and modes reports listed, plus the
radius slider labels/hint and the demo bot comment:

- `packages/shared/src/types.ts` — `ZONE_RADIUS_MIN_M` 200 → **100**,
  `ZONE_RADIUS_MAX_M` 10000 → **1500**; comment now reads
  "Diameter 200 m–3 km (radius 100 m–1.5 km). Default 500 m."
- `packages/shared/src/validation.ts` — `HOST_RANGES.zoneDiameterMeters`
  `{ min: 400, max: 20000 }` → **`{ min: 200, max: 3000 }`**; header
  comment and the diameter error message updated to
  "zone diameter must be 200 m–3 km across (radius 100 m–1.5 km)".
- `packages/shared/src/calibration.ts` — no change needed:
  `suggestZoneRadiusMeters` returns 200–1000 m, inside the new range,
  and its comment already refers generically to `ZONE_RADIUS_MAX_M`.
  The Big Park preset (radius 1000 m, 2 km across) and the Standard /
  Quick presets (500 m) are inside the new range; no preset changed.
- `apps/web/src/components/host-setup/draft.ts` — header comment
  ("Zone radius: 100 m–1.5 km (200 m–3 km across), step 50 m,
  default 500 m"); drawn-zone check `dia < 400 || dia > 20000` →
  `dia < 200 || dia > 3000`, message "Drawn zone must be 200 m–3 km
  across." `RADIUS_BOUNDS` follows the shared constants, so the
  radius stepper/slider now run 100–1500 m (verified live: slider
  `max` attribute reads 1500).
- `apps/web/src/components/host-setup/HostSetupForm.tsx` — slider
  labels "400 m across" / "20 km across" → **"200 m across" /
  "3 km across"**; hint "There is no 1 km cap: you can grow the zone
  to …" → "Radius 100 m–1.5 km, about 200 m–3 km across."
- `apps/web/src/components/host-setup/PlayAreaMap.tsx` — comment
  "so a 10 km zone is actually visible" → "so a 3 km zone is
  actually visible". The `ZONE_RADIUS_MAX_M * 2` diameter scalings
  are generic and now scale against 1500 m; no code change needed.
- `packages/engine/test/engine.test.ts` — comment only: the ~550 m
  test boundary is "inside the 200 m–3 km diameter bound".
- `apps/web/src/lib/demo-bots.ts` (restored file) — comment
  "(400 m–20 km across)" → "(200 m–3 km across)". The demo zone
  (400 m radius, ~800 m across) is inside the new range.
- No other source enforces a zone range: `workers/src` has no
  `ZONE_RADIUS_*` / diameter validation (grep verified).

## 3. Ruling 3 — dead outside-zone config: already gone, verified

`outsideZoneLiveSeconds`, `outsideZoneTagSeconds` and
`outsideZoneStatus` have **zero** occurrences in `apps/web/src`,
`packages/*/src` and `workers/src` — the only hits anywhere are the
two engine-test assertions confirming the fields are absent
(`'outsideZoneLiveSeconds' in mkConfig()` is `false`, same for
`outsideZoneTagSeconds`). The fields were removed by a sibling
before this triage; nothing was left for me to delete. The one place
they still existed was the restored demo page (backup predates the
removal) — see §5: the two fields were deleted from its
`createRoom` call as part of the restore. The founder rule stands
unchanged and enforced: fixed 30-second return countdown
(`OUTSIDE_ZONE_RETURN_SECONDS = 30`), then ejection
(`ejectPlayer` in the demo store, engine `zone.ts`).

## 4. Ruling 4 — suspension resume path (demo store + play page)

The gap the HUD report flagged was real: nothing restored a
suspended player to `connected`, so the catch page's "they must
reopen the PWA first" could never be satisfied. Fixed:

- `apps/web/src/lib/demo-store.ts` — new `resumePlayer(roomId,
  playerId)`: a suspended player returns to `connected` (fresh
  `lastFixAt`, room event "… reopened the app — back to connected").
  Returns true only when a suspended player was actually resumed;
  a no-op otherwise, so it can run unconditionally on mount.
  The suspension count stays on the record and the timer kept
  running while away — resume does not rewind anything.
- `apps/web/src/app/room/[roomId]/play/page.tsx` — three resume
  paths, all calling `resumePlayer`:
  1. **Reopen:** on mount, a suspended current player is resumed
     (a reload/reopen is a reopen).
  2. **Return to foreground:** the `visibilitychange` handler now
     resumes when the document becomes visible again (it previously
     only suspended on hide).
  3. **Resume button:** the suspended banner ("Suspended — location
     unknown. … Reopen the app to resume sharing.") now has a
     "Resume sharing" button next to it.
- Verified in a real browser against the production build (§7):
  fake hide → `suspended`; fake show → `connected`; Resume button
  → `connected`, banner gone; reload while suspended → `connected`.
  Note: in headless Chromium, switching tabs did **not** flip
  `document.hidden`, so the hide/show path was verified by
  dispatching real `visibilitychange` events with `document.hidden`
  overridden — the handler code itself is what was tested. The
  catch page's "must reopen the PWA first" text is now satisfiable;
  the catch page itself needed no change.

## 5. Ruling 5 — demo/find files: deleted a 4th and 5th time, restored twice

At triage start the demo files were already missing (3rd deletion,
as the find-demo report records). Restored from
`docs/find-demo-backup-2026-11-17/` per its `RESTORE.md` (md5s
matched the backup: demo `page.tsx` 58a65545…, `demo-bots.ts`
c77d33e7…), then found them **deleted again** — a 4th deletion,
after the repo production build had already succeeded with `/demo`
in its route table — and restored a second time. A **5th deletion**
happened later during the smoke runs; restored a third time. A
**6th deletion** happened while this report was being written;
restored a fourth time in this triage. Final state at the end of
this triage (verified by `ls`, §7): all present —

- `apps/web/src/app/demo/page.tsx`, `components/demo/DemoBoard.tsx`,
  `components/demo/DemoResult.tsx`, `apps/web/src/lib/demo-bots.ts`
- `apps/web/src/app/find/page.tsx`, `components/find/PublicRoomList.tsx`,
  `components/find/MyPublicListing.tsx`, `components/find/public-listing.ts`
- `apps/web/src/app/join/page.tsx` still carries the "Find a public
  game" link (line 158, verified).

Two conformance fixes were needed on the restored demo page, because
the backup predates later schema renames (re-applied after each
restore; the restored files are otherwise byte-identical to the
backup):
- `verifyCatchCode` → `verifyCatchScan` (the demo store renamed it;
  same `(roomId, catchId, raw)` signature — the catch page already
  uses `verifyCatchScan`).
- Deleted the dead `outsideZoneLiveSeconds: 30` /
  `outsideZoneTagSeconds: 120` from its `createRoom` call (see §3).

Deliberately **not** overwritten: the live `find/page.tsx` differs
from the backup (md5 b535dbb8… vs backup ba7df132…) — it is the
sibling's canonical `PublicLobbyListing` version, and Find was
present throughout. Restoring the backup's Find page over it would
have re-imposed the Brief-v2 design over the sibling's version
without a ruling. The Find spec conflict (coarse bands + code on
card vs 100 m-rounded distance + host codename + 15-min TTL) is
still the parent's decision, as the find-demo report records. The
deleter is still unidentified and still active — five deletions
total. **Do not treat the restore as durable until the deleter is
found; Meera should re-check presence before reviewing.**

## 6. Ruling 6 — no e2e weakening, no invented data, no payment UI

- No e2e file was edited by this worker. `smoke.spec.ts` is
  untouched (the failures in §7.4 are in the app/environment, not
  in the spec).
- No thresholds, contacts, domains or prices invented. The only
  numbers touched are the coordinator-ruled zone bounds and the
  mode copy from the engine's own `MODE_INFO`.
- Payment/membership grep over `apps/web/src`,
  `packages/shared/src`, `packages/engine/src`: zero payment /
  membership / paywall / subscription / checkout / pricing hits
  outside "Everything is free — no payment, no membership, no
  paywall" negations.

## 7. Verification (real output, 2026-11-17)

### 7.1 Typecheck — PASS, all four workspaces

`npm run typecheck` (final run, after the last restore): exit 0,
zero errors in shared, engine, workers, web. Two transient
failures on the way, both environmental, both recorded:
- First run failed in `workers` on `cloudflare:workers` types
  (`DurableObjectNamespace`/`DurableObjectState`); the identical
  command passed on immediate re-run with no code change — a
  sibling's concurrent `npm install`/build had the nested
  `@cloudflare/workers-types` (4.20260702.1) mid-rewrite while the
  lockfile pins 5.20261117.1. Not a code error; do not "fix" the
  workers code for it.
- The web run then failed on stale `.next/types` referencing a
  deleted `src/app/account/` route plus the restored demo page's
  stale `verifyCatchCode` import. Fixed by `rm -rf apps/web/.next`
  (build output only) and the rename in §5 — not by touching the
  typecheck config.

### 7.2 Tests — PASS, 0 failures

`npm test`: engine **27 pass / 0 fail / 3 skipped** (the 3 skips
are the Phase-1 native background-GPS tests), workers **19 pass /
0 fail**. Total 46 pass, 0 fail, exit 0.

### 7.3 Production build — PASS (twice), `/demo` and `/find` in the route table

- Repo tree: `PAKDAM_ALLOW_PLACEHOLDER_URL=1 npm run build`,
  exit 0, **28 static pages**, route table includes `/demo`
  (6.14 kB) and `/find` (4.78 kB). (This build ran before the 4th
  demo deletion.)
- Isolated copy (`/tmp/pakdam-triage-verify/web`, own `.next`,
  own port 3107, symlinked `node_modules`, repo `tsconfig.base.json`
  copied to `/tmp` — the copy was needed because a sibling kept
  deleting `.next` and running builds under the live tree): exit 0,
  `/demo` and `/find` both present as built routes; live curl on
  the production server: landing 200, game-modes 200, `/demo` 200,
  `/find` 200.
- The placeholder escape is dev/CI-only, as documented; the build
  refuses without it (trademark gate working as intended).

### 7.4 Playwright smoke suite (desktop) — 5/5 on a Hunter draw, 4/5 on a Runner draw

Run against the isolated production server
(`PLAYWRIGHT_BASE_URL=http://localhost:3107`, desktop project
only — see mobile note below):

| Run | Result | Host draw |
|---|---|---|
| 1 (repo tree) | 4 passed, full loop failed at `smoke.spec.ts:169` | Runner |
| 2 (isolated) | 4 passed, full loop failed at `:169` | Runner |
| 3 (isolated) | 4 passed, full loop failed at `:169` | Runner |
| 4 (isolated) | **5 passed** | Hunter |

The four passing tests every time: landing, game-modes (asserts
all four mode headings + free statement), join-unknown-code,
no-zone (zero "NaN", no-zone banner). The full loop fails **only**
when the Random draw makes the host a Runner, at the "Refresh my
location" step: the "Location refreshed — one fresh fix sent"
message never appears within the 10 s expect timeout. This is a
**pre-existing app/environment interaction, not caused by this
triage** (no triage edit touches geolocation or the refresh
handler) — root cause isolated with probes in §7.5.

**Mobile project: not runnable in this VM.** All 5 mobile tests
fail at browser launch: `Executable doesn't exist at
~/.cache/ms-playwright/webkit-2388/pw_run.sh` (webkit never
installed). Pre-existing environment gap; run `npx playwright
install webkit` (or webkit-dependent projects) on a machine that
has it before claiming mobile coverage.

### 7.5 Root cause of the Runner-draw failure (probes, all real browser runs)

- Direct `navigator.geolocation.getCurrentPosition` on the
  **landing page** with the mocked position resolves instantly
  (all option sets, accuracy 0).
- The same call **on the live play page** times out (15 s): the
  play page runs an active high-accuracy `watchPosition`
  (`watchForegroundLocation`), and the one-shot `getCurrentFix`
  never resolves while that watch is pending.
- Controlled reproduction on the landing page: start a
  high-accuracy watcher, wait 8 s (cache stale), one-shot with any
  options → **TIMEOUT every time** (high/low/default accuracy).
  Control with **no watcher**, same 8 s wait → **OK instantly**.
  With a **low-accuracy watcher**, the high-accuracy one-shot →
  **OK instantly**. So the trigger is specifically the active
  high-accuracy watch starving one-shots under Playwright's
  static geolocation mock (the mock delivers one position; the
  watcher's pending high-accuracy request never completes, and
  one-shots queue behind it).
- On a real phone this does not bite the same way: live GPS feeds
  the watcher continuously, so the one-shot returns the fresh
  cache. In this sandbox it is deterministic: every Runner draw
  fails at the refresh step; every Hunter draw skips that branch
  and passes. That also explains the HUD report's 5/5 (their run
  most likely drew Hunter).
- **Left open deliberately (no fake fix).** The safe app-side
  options all change product behaviour beyond this triage's
  rulings: dropping the watcher's high accuracy (hurts real
  zone-edge detection), or making Refresh reuse the watcher's
  latest fix instead of taking a fresh one-shot (contradicts the
  founder rule "one fresh one-shot fix, sent immediately" and
  would claim "refreshed" from a stale fix). Extending the test
  timeout would not help — the one-shot never resolves, it only
  errors at its 15 s timeout. **Owner decision needed:** accept
  as a mock-environment limitation (verify Refresh on a real phone
  instead), or authorise a follow-up fix to the refresh path.

### 7.6 Resume path — verified live (§4)

Against the isolated production server: hide → `suspended`;
show → `connected`; "Resume sharing" button → `connected`,
banner gone; reload while suspended → `connected`. (Hide/show
driven by dispatched `visibilitychange` events with
`document.hidden` overridden — headless Chromium does not flip
visibility on tab switch.)

### 7.7 Concurrent-worker interference during this triage

- A sibling ran the full 117-test Playwright suite and another
  ran `rm -rf apps/web/.next && npm run build` concurrently with
  this triage: the sibling suite's webServer failed to start
  ("Could not find a production build in the '.next' directory"),
  and `.next/BUILD_ID` was absent for a window. That is why the
  first smoke run's failures were re-checked in the isolated
  copy before being trusted.
- The demo deleter struck three more times during triage (4th, 5th
  and 6th deletions, §5). The 4th deletion happened after a successful
  repo build that included `/demo`; the 6th happened while this
  report was being written. No process observed doing the deleting
  (a sibling `rm -rf apps/web/.next && npm run build` was running
  at 09:03, but that only removes `.next`, not `src`).
- Self-inflicted note: a `pkill -f "next start -p 3107"` matched
  my own shell and killed it (SIGTERM) — the HUD report's warning
  about pattern-pkill is correct; kill by PID instead.

## 8. Open items (for the coordinator / Meera)

1. **Full-loop smoke is draw-dependent (Runner draw fails at
   refresh).** See §7.4–7.5. Needs an owner decision, not a silent
   fix. Real-phone verification of Refresh is still owed.
2. **Demo files were deleted 6 times total; deleter unidentified
   and still active.** Restored for the 4th/5th/6th time in this
   triage (the 6th struck while this report was being written);
   re-check presence immediately before Meera reviews. The live
   tree's `.next` was also rebuilt by a sibling after the restore,
   so the repo's current `.next` may or may not contain `/demo` —
   the isolated build is the proof that current source builds with
   it.
3. **`e2e/host-setup.spec.ts` is stale against the rulings and
   fails 3/4 on desktop** (1 passed: house-preset save/reload).
   It asserts the pre-ruling scope and pre-existing text that this
   triage did not change — I did **not** edit it (ruling: do not
   weaken e2e assertions; updating scope assertions is its owner's
   call):
   - `toHaveCount(0)` for Breach/Zombie text and the header
     comment "Breach/Zombie deferred (not offered in host setup)"
     — directly contradicts ruling 1.
   - "There is no 1 km cap" — removed by ruling 2 (new wording:
     "Radius 100 m–1.5 km, about 200 m–3 km across").
   - Strip text: spec expects "1 km zone … 30 min"; the app
     renders "1.0 km zone · 2 hunters · 3 min pulse · 1 h"
     (`formatDistance(1000)` → "1.0 km"; Standard duration is
     3600 s = 1 h in `CALIBRATION_OPEN`). Neither the strip format
     nor the calibration value was touched by this triage.
   - "Match summary" region: the lobby page has
     `<div aria-label="Match summary">` with no `role="region"`,
     so `getByRole('region', …)` never matches — pre-existing.
   - Test 1 also flaked once at the Standard radio click
     ("clicking did not change its state") on a cold browser —
     classic pre-hydration click; the same click passes by hand
     and in the smoke suite.
   The spec owner should update it to the ruled scope (four
   modes, 200 m–3 km, actual strip text) and decide the region
   role; Meera should not treat its current red as a triage
   failure.
4. **Mobile Playwright coverage is unrunnable here** (webkit
   binary missing, §7.4). Desktop only is proven.
5. **Find spec conflict still open** (parent decision, §5): live
   Find is the sibling's `PublicLobbyListing` version; the backup
   holds the Brief-v2 version. Only one should stand.
6. **Calibration stays OPEN** — nothing in this triage sets a
   real-match value; the zone bounds are the coordinator-ruled
   brief values, not measured ones.

## 9. Files changed by this worker

- `packages/shared/src/types.ts` — zone radius bounds 100–1500 m.
- `packages/shared/src/validation.ts` — diameter range 200–3000 m,
  comments, error message.
- `apps/web/src/components/host-setup/draft.ts` — header comment,
  drawn-zone check 200–3000 m.
- `apps/web/src/components/host-setup/HostSetupForm.tsx` — Zombie /
  Breach mode cards + `changeMode`, Zombie hunter/balance clamps,
  radius slider labels/hint, header comment.
- `apps/web/src/components/host-setup/PlayAreaMap.tsx` — comment
  (10 km → 3 km).
- `packages/engine/test/engine.test.ts` — comment only (zone bound).
- `apps/web/src/app/game-modes/page.tsx` — four playable modes,
  metadata/title/lede, Breach beta note.
- `apps/web/src/app/page.tsx` — landing showcase "Four game modes".
- `apps/web/src/components/landing/ModesPreview.tsx` — rewritten,
  four live mode cards.
- `apps/web/src/lib/demo-store.ts` — `resumePlayer()`, Zombie
  effective-count clamp in `setPhase`, stale comments.
- `apps/web/src/app/room/[roomId]/play/page.tsx` — resume on
  mount / on visible / "Resume sharing" button.
- `apps/web/src/app/demo/page.tsx`, `components/demo/*`,
  `apps/web/src/lib/demo-bots.ts` — restored from backup (twice in
  this triage) + `verifyCatchScan` rename, dead outside-zone fields
  removed, demo zone comment range.
- This report: `pakdam-app/docs/REDESIGN-V2-TRIAGE-REPORT.md`.
- Not changed: `TrustStrip.tsx` (already compliant, §1),
  `packages/shared/src/calibration.ts` (suggestion in range),
  `apps/web/e2e/*` (untouched), `workers/src` (no zone range there).
