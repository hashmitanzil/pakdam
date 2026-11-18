# Pakdam — Redesign v2: fix-round report (Meera NEEDS FIXES → fixed)

- Worker: fix-round worker (this report)
- Date: 2026-11-17 (work ~09:05–10:00 UTC / ~14:35–15:30 IST)
- Scope read first: `pakdam-masterpiece-brief-v2.md`,
  `pakdam-app/docs/MEERA-REDESIGN-REVIEW-REPORT.md`,
  `pakdam-app/docs/REDESIGN-V2-TRIAGE-REPORT.md`.
- Work in `~/workspace/goals/hide-and-seek-combo-game/files/pakdam-app/`.
- Meera's report was NOT modified. No payment UI was built. No
  competitor text/brand was copied. No thresholds, contacts,
  domains or prices were invented. Text-only, no credentials.

## Verdict: all six Meera findings FIXED (with evidence below)

Every finding in Meera §2/§4/§5/§8 was fixed and verified with real
output. The verification ran against an isolated copy of the tree
(`/tmp/pakdam-fixround-verify`, own `.next`, own port 3221) because
the live tree was being rewritten by concurrent workers throughout
this round (see §7 — three reverts of my own edits, three demo
deletions). The live tree was restored from that verified copy at
09:57:59 UTC and all 16 touched files were byte-identical to it at
09:58:09 UTC (see §6).

## 1. BLOCKING — four modes playable: FIXED

Meera §2: host setup offered only Classic/Infection; the
DEFERRED wording was back in four places; `draft.ts` coerced
zombie/breach back to classic on restore.

What changed:

- `apps/web/src/components/host-setup/HostSetupForm.tsx` — a
  "Game mode" radio group now offers all four modes (Classic,
  Infection, Zombie, Breach). Picking a mode applies its rule at
  once (`changeMode`): Zombie forces `hunterCount: 1` and Balance
  off; Breach forces the shrinking zone on (and the play zone on).
  Guards in `update()` enforce the same rules for every stepper /
  toggle, so no control can build an invalid draft: the Balance
  toggle is disabled for Zombie, the Hunters stepper offers only
  [1] for Zombie, and the Play-zone and Shrink toggles are disabled
  for Breach. The header comment now states four playable modes.
  Breach carries the honest beta note ("Flag capture is not built
  yet, so Breach plays as Classic catches with a forced shrinking
  zone"). The shared validator already enforces these rules
  (`validateRules`: zombie ⇒ exactly 1 Hunter, breach ⇒ shrink
  on), so the form can never produce a room the validator rejects.
- `apps/web/src/components/host-setup/draft.ts` — the coercion is
  gone: `draftFromConfig` and `applyPresetToDraft` restore a stored
  Zombie/Breach mode as-is (new `applyModeRules()` applies the mode
  rules instead of coercing), `draftToConfig` applies the same
  rules, and `effectiveHunterCount` returns 1 for Zombie whatever
  Balance says. (Two ordering traps fixed: the preset path's later
  `hunterCount`/`balanceHunters`/`playZoneEnabled` lines used to
  override the mode rules back — they are now mode-aware.)
- `apps/web/src/app/game-modes/page.tsx` — rewritten: title "Four
  modes in the pilot — all playable.", metadata no longer says
  Zombie/Breach are deferred, the `DEFERRED` map is deleted, all
  four cards render from the engine's `MODE_INFO` with "In the
  pilot" and a Host a Game CTA, Zombie/Breach carry their honest
  notes. Also fixed Meera §8.1's second half: "Private invite-only
  — no public games" now reads "Private invite-only by default —
  a host can opt in to list the game publicly in Find-a-Room".
- `apps/web/src/app/page.tsx` (landing showcase) — "Four game
  modes — Classic Manhunt, Infection, Zombie and Breach — picked
  in host setup".
- `apps/web/src/components/landing/ModesPreview.tsx` — rewritten:
  four live cards, heading "Four modes to play now.", Breach beta
  note, Host a Game CTA on every card. No deferred wording left.

Evidence (real output, not code reading):

- Grep over all scope files at the end: zero "DEFERRED", zero
  "Two modes", zero "Two game modes" (exit 1 = no matches).
- Served HTML from my own production server (port 3221):
  landing 200 and contains "Four game modes"; `/game-modes` 200
  and contains "Four modes in the pilot"; `/create` 200 and
  contains Zombie (1) and Breach (2) as selectable modes.
- New e2e test in `host-setup.spec.ts` ("Zombie and Breach rooms
  can both be created through the UI", §5) creates a Zombie room
  and a Breach room through the real host-setup UI and reads the
  stored configs back: Zombie room `mode: 'zombie',
  hunterCount: 1, balanceHunters: false`; Breach room
  `mode: 'breach', zoneShrinkEnabled: true`. It passed in the
  5/5 host-setup run (§5).

## 2. Landing "Planned after the pilot" listed Find-a-Room and Friends: FIXED

`apps/web/src/app/page.tsx`: Find-a-Room public lobbies and
Friends / "Played with" moved from "Planned after the pilot" into
the "In the pilot now" list. The planned list now contains only
"Voice radio for your team, if it can be done honestly in the
browser". Served landing HTML confirms the move (both items under
the live list; planned list has the single voice-radio item).

## 3. Play-page outside-zone live-reveal over-claim: FIXED by removal

Meera §8.2: no wiring sends an outside player's coarse area to
Hunters — only the 30-second countdown and ejection. I chose
removal over wiring (no new location-sharing path invented, no
false statement left):

- `apps/web/src/app/room/[roomId]/play/page.tsx` — the small-print
  sentence "While outside, Hunters can see your coarse area, never
  your exact position." is deleted; the paragraph now states only
  the enforced rule (30 s, then ejection) and the Refresh button
  "re-sends your latest fix immediately". The play page's
  "SCRAM-grade" header comment is reworded to Pakdam's own terms
  (Meera §8.3, this file only).
- `apps/web/src/components/host-setup/HostSetupForm.tsx` — the
  same sentence deleted from the Rules paragraph.
- `apps/web/src/app/game-modes/page.tsx` — the same sentence
  deleted from the ground-rules list.
- Same claim, adjacent files (same finding, minimal sentence
  removal): `apps/web/src/components/hud/OutsideZoneBanner.tsx`
  (banner body + header comment) and
  `apps/web/src/components/match/ModeZonePanel.tsx`.

Grep after the fix: zero occurrences of "Hunters can see your
coarse area" / "While outside, Hunters" / "While you are outside,
Hunters" in `apps/web/src` and `apps/web/e2e`. The remaining
"coarse area" wording elsewhere is about scheduled pings (which
are wired) or hot/cold tiers — not the outside-zone claim.
Not changed (out of scope, code comments only, not user-facing):
"SCRAM-grade / SCRAM-style" still appears in comments in
`HudBar.tsx`, `PlayerDots.tsx`, `BottomTabs.tsx`. The unused
`.mode-preview-card-deferred` / `.mode-status-deferred` CSS
classes remain in `tokens.css` (harmless, no deferred cards use
them).

## 4. Smoke draw-dependence — "Refresh my location": FIXED

Meera §4 / triage §7.4–7.5: the full loop failed only on a Runner
draw — the fresh one-shot `getCurrentPosition` never resolves
while the play page's high-accuracy watcher is pending (proven
under Playwright's static geolocation mock; on a real phone the
watcher's fix is the freshest available). Authorised fix applied:

- `apps/web/src/lib/geolocation.ts` — the watcher caches its
  latest fix (`latestWatchedFix`, cleared when the watcher stops);
  `getCurrentFix()` resolves immediately with that fix when one
  exists, and takes a fresh one-shot otherwise. No watcher is
  active on the host-setup / find screens, so those callers still
  get a fresh one-shot exactly as before. The fix's own `at`
  timestamp is kept, so freshness labels still show its true age.
- `apps/web/src/app/room/[roomId]/play/page.tsx` —
  `refreshLocation()` re-sends the screen's current fix (watcher
  or simulated) when it has one, falling back to a fresh one-shot
  only when it holds no fix at all. The status message is now
  honest about what happened: "Location refreshed — latest fix
  sent." (not "one fresh fix"), with the send time shown as
  "Last updated just now". No age cap was invented: reuse is
  unconditional while a fix is held, and the fix's true receipt
  time stays visible elsewhere on the screen.

Evidence (real browser runs, desktop, isolated server :3221):

- `e2e/smoke.spec.ts` — **5/5 passed, twice** (runs 1 and 2,
  before Chromium died — see §7).
- Deterministic both-draw probe (temporary spec in the /tmp copy
  only, deleted after; uses `startMatch` with
  `pickHunters: 'others'` for a forced Runner host and
  `'host'` for a forced Hunter host): **2/2 passed** — Runner
  draw: "Location refreshed — latest fix sent. Last updated just
  now." appears; Hunter draw: radar ping flow works. One
  combined-probe run flaked on the Runner leg (unshown error,
  re-run passed twice after); recorded as a flake, not hidden.
- The smoke spec's "Last updated just now" assertion had to be
  scoped to the refresh status line (combined regex) because the
  "You are:" line also carries "Last updated just now" — a bare
  match hits two elements (strict-mode violation). This was never
  reachable before: the old spec always failed at the refresh
  step first on a Runner draw. The assertion is unchanged in
  strength — it still requires the exact refresh line.

## 5. host-setup.spec.ts rewritten to the ruled scope: FIXED, 5/5

`apps/web/e2e/host-setup.spec.ts` — updated to the ruled scope
with the app's own formatters as truth (`formatDistance(1000)` →
"1.0 km", `formatMinutes(60)` → "1 h"; Standard duration is
3600 s, lobby `fmtMinutes` renders it "60 min"):

- Strip: "1.0 km zone · 2 hunters · 3 min pulse · 1 h" (was the
  stale "1 km zone … 30 min"); slider to 1500 m: "3.0 km zone"
  (formatDistance gives "3.0 km", not "3 km"); the removed "There
  is no 1 km cap" assertion replaced by the actual hint text
  ("Radius 100 m–1.5 km, about 200 m–3 km across"); Match length
  60 → 90 min ("1 h 30 min") and back to "1 h" (Standard is 60,
  not 30); ping step strip ends "… 5 min pulse · 1 h".
- Mode section: four radios asserted visible (anchored names —
  the Breach label also contains "Classic", so an unanchored
  /Classic/ matched two radios); Zombie check asserts Balance
  off + "1 hunter" strip; Breach check asserts shrink on and
  shrink switch disabled; Balance is turned back on afterwards
  so the Players section starts from the Standard state.
- Play-zone-off strip: "no zone · 2 hunters · no pings · 1 h".
- Lobby summary test: Duration "60 min" (lobby `fmtMinutes`),
  plus the `role="region"` locator.
- New test: "Zombie and Breach rooms can both be created through
  the UI" (§1).
- Three further latent spec bugs found while getting the suite
  green (all pre-existing, never reachable while the spec failed
  at line 23): (a) "6 corners" / "8 corners" match two elements
  (map's "Drawn zone: 6 corners" line + stepper output) — now
  asserted on the Corners stepper's own output; (b) the
  no-area-name guard `getByLabel(/venue|…/)` always matched the
  two safety checkboxes ("I have checked the venue…", "…on site
  at the venue…") — now scoped to textboxes, which is the guard's
  actual intent (no name FIELD); (c) `boundingBox().bottom`
  does not exist (Playwright returns `{x, y, width, height}`) —
  now `y + height`. No real assertion was weakened: every fix
  either corrects a stale value to the app's own formatter output
  or scopes a locator to the element it meant.

Also: `apps/web/src/app/room/[roomId]/page.tsx` — `role="region"`
added to the lobby "Match summary" summary strip (the second of
two divs carrying that aria-label; the code-hero div was left
without a role so the locator stays unique).

Result: **host-setup 5/5 passed** on desktop against the isolated
production server (27.6 s).

## 6. Demo / find files: present at the end (restored 3 times)

Required files, verified present at 09:58:09 UTC (all 8):

- `apps/web/src/app/demo/page.tsx`, `components/demo/DemoBoard.tsx`,
  `components/demo/DemoResult.tsx`, `apps/web/src/lib/demo-bots.ts`
- `apps/web/src/app/find/page.tsx`, `components/find/PublicRoomList.tsx`,
  `components/find/MyPublicListing.tsx`, `components/find/public-listing.ts`

During this round the demo files were deleted **three more times**
(8th, 9th and 10th deletions overall, counting triage §5's six):
once during the first production build (the build failed on the
missing `demo/page.tsx`), once during the isolated-copy setup, and
once while the Playwright runs were in flight. Each time they were
restored from `docs/find-demo-backup-2026-11-17/` (md5s match the
backup: demo `page.tsx` 58a65545…, `demo-bots.ts` c77d33e7…),
with triage §5's conformance fixes re-applied after every restore
(`verifyCatchCode` → `verifyCatchScan`; dead
`outsideZoneLiveSeconds` / `outsideZoneTagSeconds` removed from
the demo `createRoom` call; demo zone comment range corrected to
200 m–3 km). Find files were never deleted and were NOT touched
(the live Find is the sibling's canonical version; the backup's
Find page was deliberately not copied over it). The deleter is
still unidentified and still active — presence at report time is
not durability; the parent should still find the deleter.

## 7. Verification — real numbers

All runs against the isolated copy (`/tmp/pakdam-fixround-verify`,
own `.next`, own port 3221, symlinked `node_modules`, config ports
patched 3105 → 3221 in the copy only) except where noted:

| Check | Result |
|---|---|
| `npm run typecheck` (live tree, before interference) | PASS, exit 0, all 4 workspaces |
| `npm run typecheck` (isolated copy) | PASS, exit 0 |
| `npm test` (live tree) | PASS, exit 0 — engine 27 pass / 0 fail / 3 skipped; workers 19 pass / 0 fail. Total 46 pass, 0 fail |
| Production build (isolated copy, `PAKDAM_ALLOW_PLACEHOLDER_URL=1`) | PASS, exit 0, 28 static pages; route table includes `/demo` (6.14 kB) and `/find` (4.98 kB) |
| Live-tree production build | FAILED once — the demo deleter removed `demo/page.tsx` mid-build (see §6); not a code failure. The isolated build above is the proof the current source builds |
| Playwright smoke, desktop (isolated server :3221) | 5/5 passed, run 1 (48.6 s); 5/5 passed, run 2 (35.6 s) |
| Playwright host-setup, desktop | 5/5 passed (27.6 s) |
| Both-draw refresh probe (temporary, /tmp only) | 2/2 passed (Runner 15.3 s, Hunter 18.9 s) |
| Served-HTML checks (curl vs :3221) | landing 200, `/game-modes` 200, `/create` 200, `/demo` 200, `/find` 200; four-mode wording + Zombie/Breach on `/create` confirmed |

Not re-run on the live tree after the final restore: the live
typecheck attempt at ~09:58 UTC hit the same EPERM (npm log
write) as §8 below, and the browser was already dead by then.
Instead, all 16 touched files were compared byte-for-byte with
the verified isolated copy at 09:58:09 UTC — all IDENTICAL —
so the live tree holds exactly the code that passed typecheck,
build and e2e in the copy.

## 8. Concurrent-worker interference during this round (parent action needed)

1. **The mode wording was reverted three times while I worked.**
   My HostSetupForm/draft.ts/landing edits landed, were verified
   clean by grep (zero DEFERRED), and were then reverted — twice
   for the form + draft (mtimes 09:36:19/09:36:43 and again
   09:38:37), and a third time the landing page went back to
   "Two game modes" too. The reverter's version keeps some of my
   changes (`applyModeRules`, `draftToConfig`, `describeMode(value.mode)`)
   but re-imposes the DEFERRED comments and the zombie/breach →
   classic coercion in `draftFromConfig`/`applyPresetToDraft`, and
   the two-mode form. I re-applied with a deterministic script
   (`/tmp/fix_modes.py` — asserts each replacement, fails loudly
   on a miss) and froze the correct state in the isolated copy
   for verification; the live tree was then restored from that
   copy at 09:57:59 UTC. This is the same edit-war Meera §2 and
   triage §5/§7.7 document (five reverts of the mode wording
   then; three more now). Until the reverter is found and
   stopped, any "fixed" verdict on the live tree is only true
   until the next revert. Meera should re-grep before reviewing.
2. **Demo deleter: three more deletions this round** (§6).
3. **Chromium died again (~09:54 UTC), same as Meera §7.2.**
   Both Playwright browser binaries exit 133 (SIGTRAP) on launch
   via Playwright, and `npx` fails writing its log with EPERM.
   Standalone `chrome-headless-shell --dump-dom` still starts.
   Consequence: smoke runs 3–5 could not execute (EPERM +
   SIGTRAP at browser launch — an environment failure, not an
   app failure). All e2e evidence above comes from the runs
   completed before the death (smoke 5/5 ×2, host-setup 5/5,
   probe 2/2). A quiet-machine re-run is still advisable.
4. **Mobile Playwright coverage** remains unrunnable here
   (webkit binary missing — triage §7.4). Desktop only is proven.
5. Self-inflicted note: a `pkill -f "next start -p 3221"`
   matched my own shell and killed it (SIGTERM) — the triage
   warning about pattern-pkill is correct; the server was then
   stopped by PID (6627) instead.

## 9. Files changed by this worker

- `apps/web/src/components/host-setup/HostSetupForm.tsx` — four
  modes, `changeMode`, mode-rule guards/disables, outside-zone
  claim removed.
- `apps/web/src/components/host-setup/draft.ts` — coercion removed,
  `applyModeRules()`, Zombie effective-count clamp, mode-aware
  preset/config restore.
- `apps/web/src/app/game-modes/page.tsx` — four playable modes,
  DEFERRED map deleted, public-listing line corrected,
  outside-zone claim removed.
- `apps/web/src/app/page.tsx` — four modes; Find-a-Room + Friends
  moved to the live list.
- `apps/web/src/components/landing/ModesPreview.tsx` — rewritten,
  four live mode cards.
- `apps/web/src/lib/geolocation.ts` — watcher latest-fix cache,
  one-shot reuse.
- `apps/web/src/app/room/[roomId]/play/page.tsx` — Refresh reuses
  the latest fix, honest status text, outside-zone claim removed,
  SCRAM-grade comment reworded.
- `apps/web/src/components/hud/OutsideZoneBanner.tsx`,
  `apps/web/src/components/match/ModeZonePanel.tsx` — same
  unwired outside-zone claim removed (same finding).
- `apps/web/src/app/room/[roomId]/page.tsx` — `role="region"` on
  the Match summary strip.
- `apps/web/e2e/host-setup.spec.ts` — ruled-scope rewrite (§5) +
  Zombie/Breach creation test.
- `apps/web/e2e/smoke.spec.ts` — refresh message + scoped
  "Last updated" assertion (§4).
- `apps/web/src/app/demo/page.tsx`, `components/demo/*`,
  `apps/web/src/lib/demo-bots.ts` — restored from backup (3×
  this round) + conformance fixes (§6).
- This report: `pakdam-app/docs/REDESIGN-V2-FIX-ROUND-REPORT.md`.
- Not changed: Meera's report; `apps/web/src/app/find/*`,
  `apps/web/src/components/find/*` (present, untouched);
  `apps/web/src/app/demo/*` content beyond the restore +
  conformance fixes; `workers/src`; `packages/*`.
