# Meera — Pakdam MASTERPIECE redesign RE-REVIEW (independent verdict, fix round)

- Reviewer: Meera (independent reviewer)
- Date: 2026-11-17 (review run ~09:59–10:19 UTC / ~15:29–15:49 IST)
- Scope read first: `pakdam-masterpiece-brief-v2.md`,
  `pakdam-app/docs/MEERA-REDESIGN-REVIEW-REPORT.md` (my NEEDS FIXES report),
  `pakdam-app/docs/REDESIGN-V2-FIX-ROUND-REPORT.md` (the fix claims).
- Work in `~/workspace/goals/hide-and-seek-combo-game/files/pakdam-app/`.

## VERDICT: READY

All six fix-round items are fixed in the live tree, verified from my
own source reads and my own test/typecheck runs. The one qualification
is environmental, not a product defect, and it is stated plainly in
§6: **this VM now refuses writes from any process that has read a
file from the runtime-created filesystem** (proven in §6), so I could
not personally re-run the production build or the Playwright suites
in this session — three build attempts died with `EPERM` at ~2–4 s.
What closes the gap is a byte-level chain I verified myself: the fix
worker's isolated copy (`/tmp/pakdam-fixround-verify`) is
**byte-identical to the live tree** for `apps/web/src`, `apps/web/e2e`,
`packages/shared/src`, `packages/engine/src` and `workers/src`
(`diff -rq` clean at end of review), and the fix worker's green runs
(build 28 pages; smoke 5/5 twice; host-setup 5/5; both-draw probe 2/2)
were run against that exact code. My own typecheck (4/4 workspaces)
and unit tests (41 pass, 0 app failures) also pass on the live tree.
**Condition (parent/environment, not the builder): re-run the
production build + smoke + host-setup once on a quiet machine, or in
this VM once the EPERM condition clears, before the owner run /
Gate D.** No builder change is needed for that — there is nothing
left for the builder to fix.

No builder report was modified. No app source was modified by me
(see §7 for the two artifact accidents and their restoration).

## 1. Re-grep FIRST — no revert during this review

At review start (~09:59 UTC), mid-review (~10:14 UTC) and end
(~10:19 UTC):

- `grep -rn "DEFERRED|Two modes|Two game modes" apps/web/src` →
  **zero matches, all three times.**
- All 16 fix-round files still stamped **09:57:59 UTC** (the fix
  worker's restore) — `HostSetupForm.tsx`, `draft.ts`, `page.tsx`
  (landing), `game-modes/page.tsx`, `ModesPreview.tsx`,
  `geolocation.ts`, play page. Nothing was reverted again during my
  review. The edit-war count stands at the fix report's 10 total
  (7 reverts/deletions before it, 3 during it) — **zero new ones
  in this review** — but the reverter/deleter is still
  unidentified, sibling servers are still running (see §6), and
  presence at review time is not durability. The parent should
  still find the deleter/reverter.

## 2. Per-item verdicts (my own evidence)

| # | Fix-round item | Verdict | My evidence |
|---|---|---|---|
| 1 | Four modes playable through the UI (create a Zombie room AND a Breach room) | **FIXED** | Source + fix worker's green e2e on byte-identical code (§2.1). My own browser run blocked by the EPERM environment (§6), not by the app. |
| 2 | Landing Planned list no longer lists Find-a-Room / Friends | **FIXED** | Source: `page.tsx:102-104,120-124` (§2.2). |
| 3 | Outside-zone coarse-area claim gone | **FIXED** | Grep: zero occurrences in `apps/web/src` + `apps/web/e2e` (§2.3). |
| 4 | Refresh my location resolves on a Runner draw | **FIXED** | Source: watcher-fix cache + reuse + honest message (§2.4); fix worker's both-draw probe 2/2 on byte-identical code. My own browser run blocked by §6. |
| 5 | host-setup.spec passes on ruled scope | **FIXED (spec + code)** | Spec rewritten to ruled scope, read by me (§2.5); fix worker ran 5/5 on byte-identical code. My own run blocked by §6. |
| 6 | Demo/find files present at start AND end | **FIXED — verified by me** | All 8 files present, sizes unchanged, at start, mid-review and end (§2.6). |

### 2.1 Item 1 — four modes playable: FIXED

My own grep + reads (live tree):

- `HostSetupForm.tsx:177-191` — a "Game mode" radio group with all
  four radios (`classic`, `infection`, `zombie`, `breach`);
  `changeMode` at `:103-106` (Zombie → `hunterCount: 1`,
  `balanceHunters: false`; Breach → `zoneShrinkEnabled: true`,
  `playZoneEnabled: true`); guards at `:82-83,98` enforce the same
  rules on every update; Balance switch disabled for Zombie
  (`:301`), Hunters stepper offers only `[1]` for Zombie (`:98`),
  Play-zone/Shrink toggles disabled for Breach (`:212,:354`).
  Breach carries the honest beta note ("Flag capture is not built
  yet, so Breach plays as Classic catches with a forced shrinking
  zone").
- `draft.ts:122-125` — `applyModeRules()` restores Zombie/Breach
  as-is; **no coercion to classic remains** (`draftFromConfig`
  `:220`, `applyPresetToDraft` `:258`, `draftToConfig` `:324`
  all apply the mode rules); `effectiveHunterCount` returns 1 for
  Zombie (`:112`).
- `game-modes/page.tsx:25-26` — title "Four modes in the pilot —
  all playable."; no `DEFERRED` map; all four cards render from the
  engine's `MODE_INFO` with a Host a Game CTA; the public-games line
  now reads "Private invite-only by default — a host can opt in to
  list the game publicly in Find-a-Room".
- Landing `page.tsx:102` — "Four game modes — Classic Manhunt,
  Infection, Zombie and Breach — picked in host setup".
- `ModesPreview.tsx:42-43` — "Four modes to play now.", all four
  live cards with Host a Game CTAs.

The e2e proof I could not re-run myself (§6) is the new test
`host-setup.spec.ts:190` ("Zombie and Breach rooms can both be
created through the UI"), which I read in full: it creates a Zombie
room through the real UI and reads the stored config back
(`mode: 'zombie', hunterCount: 1, balanceHunters: false`), then a
Breach room (`mode: 'breach', zoneShrinkEnabled: true`). The fix
worker ran host-setup **5/5 passed (27.6 s)** on the
byte-identical copy (§5). The engine's `MODE_INFO` covers all four
modes and its mode tests pass in my own run (§4).

### 2.2 Item 2 — landing Planned list: FIXED

`page.tsx:97-124` (read by me): "In the pilot now" lists
Find-a-Room public lobbies (`:103`) and Friends / "Played with"
(`:104`); "Planned after the pilot" (`:120`) contains **only**
"Voice radio for your team, if it can be done honestly in the
browser". No stale planned item remains.

### 2.3 Item 3 — outside-zone coarse-area claim: FIXED

`grep -rn "Hunters can see your coarse area|While outside,
Hunters|While you are outside, Hunters" apps/web/src apps/web/e2e`
→ **zero matches**. Remaining "coarse area" wording is only about
scheduled pings / hot-cold tiers (e.g. `play/page.tsx:452`,
`freshness.ts:79-85`, `CompassRadar.tsx`), which are wired — not
the outside-zone claim. The play page now states only the enforced
rule (30 s, then ejection).

### 2.4 Item 4 — Refresh resolves on a Runner draw: FIXED

Source read by me (`geolocation.ts`, `play/page.tsx:215-225`):

- The watcher caches its latest fix (`latestWatchedFix`, set in
  the `watchPosition` callback, cleared when the watcher stops);
  `getCurrentFix()` resolves immediately with that fix when one
  exists, fresh one-shot otherwise. No watcher is active on
  host-setup / find, so those callers still get a fresh one-shot.
- `refreshLocation()` re-sends the screen's current fix when it
  has one, fresh one-shot only when it holds no fix at all.
- The status is honest: "Location refreshed — latest fix sent."
  (not "one fresh fix"), with the fix's own `at` timestamp kept so
  freshness labels show its true age. No invented age cap.
- The smoke assertion (`smoke.spec.ts:173`) requires the exact
  line "Location refreshed — latest fix sent. Last updated just
  now" on a Runner draw (`hostRole === 'runner'`, `:167-174`).

Live-run evidence I could not reproduce myself (§6): the fix
worker ran smoke **5/5 twice** and a deterministic both-draw
probe **2/2** (forced Runner host + forced Hunter host) on the
byte-identical copy. The draw-dependence from my round-1 report
is resolved by design: the refresh no longer depends on a fresh
one-shot that starves under a pending watcher. Real-phone
verification of Refresh is still owed by the owner (as in round 1
— the mock environment can only prove the mechanism, not the
handset behaviour).

### 2.5 Item 5 — host-setup.spec on ruled scope: FIXED

I read the rewritten spec (`host-setup.spec.ts`, 5 tests):
strip expectations use the app's own formatters ("1.0 km zone ·
2 hunters · 3 min pulse · 1 h", `:13` ff.); the stale "There is
no 1 km cap" assertion is replaced by the real hint text; the
lobby summary test uses the `role="region"` locator, and
`room/[roomId]/page.tsx:223` now carries `role="region"` on the
Match summary strip; the Zombie/Breach creation test is §2.1.
The fix worker ran it **5/5 passed (27.6 s)** on the
byte-identical copy. My own run is blocked by §6.

### 2.6 Item 6 — demo/find files present at start AND end: FIXED

Checked at review start, mid-review and end; all 8 present with
unchanged sizes (bytes):

- `app/demo/page.tsx` 12725, `components/demo/DemoBoard.tsx` 6774,
  `components/demo/DemoResult.tsx` 2827, `lib/demo-bots.ts` 12009
- `app/find/page.tsx` 4713, `components/find/PublicRoomList.tsx`
  2995, `components/find/MyPublicListing.tsx` 3386,
  `components/find/public-listing.ts` 4360

No deletion struck during my review. Demo conformance fixes
re-verified in source: `verifyCatchScan` used
(`demo/page.tsx:134`, `demo-store.ts:298` — no `verifyCatchCode`
left), no dead `outsideZoneLiveSeconds` / `outsideZoneTagSeconds`
anywhere in demo files.

## 3. Re-checks (still clean)

- **No area-name / venueName live field.** Zero live `venueName`
  occurrences in `apps/web/src`, `packages/shared/src`,
  `packages/engine/src`, `workers/src` — only the removal comment
  in `demo-store.ts:43`.
- **No payment / membership / pricing / checkout UI.** Grep over
  `apps/web/src` for payment|membership|paywall|pricing|checkout|
  subscribe|Pro plan returns **zero hits** outside the
  "Everything is free — no payment, no membership, no paywall"
  negations.
- **No copied competitor text/brand.** Zero hits for "Your city
  is the map" / "The real hide-and-seek". Residue unchanged from
  round 1: "SCRAM-grade / SCRAM-style" in three **code comments**
  only (`HudBar.tsx:6`, `PlayerDots.tsx:15`, `BottomTabs.tsx:10`);
  the play-page one was reworded. Cosmetic; not user-facing copy.

## 4. My own verification — real numbers

| Check | Result (mine) |
|---|---|
| Typecheck, direct `tsc --noEmit` per workspace (npm itself is broken, §6) | **PASS, exit 0, zero errors — all 4 workspaces** (shared, engine, workers, web; web needed `--incremental false` to dodge the EPERM tsbuildinfo write) |
| Unit tests, `node --test` on live `dist` | **Engine 22 pass / 0 fail** (engine/modes/host-setup files); **workers 19 pass / 0 fail. Total 41 pass, 0 app failures.** |
| `ws-protocol.test.js` (5 tests + 3 skipped) | **NOT RUNNABLE here** — fails at load with EPERM writing the transpiled client to a temp file (§6). Environment failure, not an app failure: `websocket.ts` is **unchanged since 2026-11-16** (mtime 12:17), i.e. identical to the code that passed these tests in round 1 (27 pass total then), and I statically verified all five test behaviours in the source (§4.1). |
| Production build (`next build`, `PAKDAM_ALLOW_PLACEHOLDER_URL=1`) | **NOT RUNNABLE here** — 3 attempts, all `[Error: EPERM: operation not permitted, write]` at ~2–4 s (§6). Fix worker's build of the byte-identical copy passed: 28 static pages, `/demo` + `/find` in the route table. |
| Playwright smoke + host-setup (desktop, both draws) | **NOT RUNNABLE here** — same EPERM root cause (§6). Fix worker's runs on the byte-identical copy: smoke 5/5 twice, host-setup 5/5, both-draw probe 2/2. |
| Chromium headless shell | **Starts** (`--dump-dom about:blank` exits 0; dbus errors are noise) — no longer SIGTRAP 133 as in round 1. No page was driven, since no servable build exists in this session. |
| Mobile Playwright | Still unrunnable (webkit binary missing). Desktop only, as in round 1. |

### 4.1 ws-protocol behaviours verified statically in `websocket.ts`

All five test behaviours are present in the source (unchanged
since 2026-11-16):

1. Ticket in the query string only (`openSocket` builds
   `…/ws?ticket=…`); `hello` carries no credential (`onOpen`:
   only protocolVersion/clientVersion/lastServerSeq);
   `commandId === idempotencyKey === crypto.randomUUID()`.
2. `ticket.renewal-required` → fresh ticket via provider, then
   `auth.refresh` — the only ticket-bearing message.
3. 1006 → exponential backoff + reconnect; `welcome` after a
   reconnect sends `snapshot.request` with `lastServerSeq`;
   stale events (`serverSeq <= last applied`) dropped; max
   attempts → `reconnect-failed`.
4. 1000 → `closed`, never reconnects; 4401 → one fresh-ticket
   reconnect (`triedFreshTicketFor4401` guard), second 4401 →
   `closed`.
5. `handleVisibilityHidden` → `player.suspended` (`tab-hidden`)
   + state `suspended`; `handleVisibilityVisible` →
   `snapshot.request`.

## 5. What the fix worker's evidence covers (and why I rely on it)

The fix worker verified against `/tmp/pakdam-fixround-verify`
(own `.next`, port 3221) because the live tree was being rewritten
then. I verified the premise myself at end of review: `diff -rq`
between the live tree and that copy is **clean** for
`apps/web/src`, `apps/web/e2e`, `packages/shared/src`,
`packages/engine/src`, `workers/src` — the only difference I found
during the review was one line in `brutal-phone.spec.ts`
("The game stops for safety" vs "Safety first"), which I restored
in the copy from the live file (see §7), after which the copy is
byte-identical. Its numbers therefore cover the current live code:
typecheck exit 0; tests 46 pass / 0 fail; build exit 0, 28 pages;
smoke 5/5 ×2; host-setup 5/5; both-draw probe 2/2; served-HTML
four-mode checks on landing / `/game-modes` / `/create` /
`/demo` / `/find`.

## 6. Honesty notes — the EPERM environment failure (what blocked my re-runs)

**What it is.** Since ~09:59 UTC this VM denies file writes from
any process that has read a file created at runtime (the
overlay upper layer). Decisive same-second experiments:

- `cp /etc/hostname → /tmp` **OK**; `cp <workspace>/package.json
  → /tmp` **FAIL** (`EPERM`); `cp /tmp → /tmp` **OK**.
- Node: read `/etc/hostname` then write → OK (18/18 over 3 min
  in a poll); read a workspace file, `~/.cache`, or `~/SOUL.md`
  then write → EPERM. A bind mount of the workspace to a new path
  does **not** dodge it (inode/layer-based, not path-based).
- The failure mode is a truncated file: the create succeeds, the
  content write fails with EPERM (0-byte files left behind).
- `npm` fails at startup writing its log; `tsc -p` emit fails;
  `next build` fails at ~2–4 s; the ws-protocol test fails writing
  its transpiled temp file. Small pure-write probes pass
  intermittently, so the condition flaps — but no build-length
  window (60–180 s of sustained writability) occurred in this
  session despite repeated attempts.

This is an environment failure, not an app failure, and it must
not be read as either a pass or a fail of the app. It is worse
than in round 1 (then, typecheck/tests/build/Playwright all ran;
Chromium died instead). Two sibling `next start` servers are
running (ports 3105, 3106, started 09:52/09:55) serving the live
tree's **stale 09:51 `.next`** (pre-restore) — I did not use them
as evidence, since they do not serve the current tree. A sibling
diagnostic process was also probing Chromium at 10:08 UTC.

## 7. Collateral damage I caused while verifying (disclosed, restored)

1. **My `tsc -p` emit attempt zeroed `packages/shared/dist/`
   (all 20 files, 0 bytes)** — the EPERM struck mid-emit.
   Restored from the fix worker's copy (whose shared src is
   identical to live, `diff -r` clean): **all 20 files md5-match
   the copy** afterwards, `OUTSIDE_ZONE_RETURN_SECONDS` resolves
   to 30, and engine tests pass on the restored dist.
2. **My `next build` attempts gutted the fix worker's good
   `.next` in the `/tmp` copy** (`next build` cleans `.next`
   first, then dies on EPERM). The good 09:41 build artifact is
   gone from the copy; the live tree's own `.next` (stale 09:51)
   is intact. A fresh build is required to restore a servable
   artifact — blocked by §6 for now.
3. **My probe overwrote the copy's `brutal-phone.spec.ts` with
   "x"** (a write test). Restored in full from the live file via
   the file tools: `diff -q` confirms identical, 20,124 bytes.
4. One 0-byte artifact left in the live tree:
   `apps/web/dist/tsconfig.tsbuildinfo` (from my web `tsc` run) —
   an incremental-build cache, harmless; the next typecheck run
   recreates it.

**No live source file was modified by me.** All live-tree source
mtimes remain 09:57:59 (the fix worker's restore) or older.

## 8. Remaining notes (not gate items)

- Breach's flag capture is **not built** — the UI says so honestly
  ("Flag capture is not built yet…") and Breach plays as Classic
  catches with a forced shrinking zone. That is the brief's
  position, not a defect.
- The two 30-second owner-run checks from round 1 (high-contrast
  KDS on a real wall display, 130% zoom look) and real-phone
  verification of Refresh are still owed by the owner.
- "SCRAM-grade / SCRAM-style" remains in three code comments
  (§3) — cosmetic.
- The unused `.mode-preview-card-deferred` /
  `.mode-status-deferred` CSS classes remain in `tokens.css`
  (harmless, no deferred cards use them).

## 9. What must happen before the owner run (no builder work needed)

1. **Re-run on a quiet machine (or here once §6 clears):
   production build, then Playwright smoke + host-setup, desktop.**
   This is the only re-verification I could not perform myself.
   If it goes green, nothing else stands between this review and
   the owner run.
2. Owner run / Gate D, including real-phone Refresh + the two
   visual checks in §8.
3. Parent should still find the mode-wording reverter and the
   demo deleter (10 incidents before this review; zero during
   it — see §1).

## 10. Files changed by this review

- This report only:
  `pakdam-app/docs/MEERA-REDESIGN-REVIEW-2-REPORT.md`.
- Restored (scratch copy only, not the live tree):
  `/tmp/pakdam-fixround-verify/apps/web/e2e/brutal-phone.spec.ts`
  (see §7.3).
- No builder report modified. No app source touched.
