# REDESIGN-V2-MODES-REPORT — Modes + schema worker (Pakdam Brief v2 + founder update)

- Date: 2026-11-17
- Worker: modes + schema (packages/shared, packages/engine, create/host flow, demo-store, admin)
- Briefs read first: `pakdam-masterpiece-brief-v2.md`, `pakdam-competitor-deep-dive-2026-11-17.md`, `pakdam-app/docs/KABIR-REDESIGN-REPORT.md` (Kabir's v1 host setup — not redone).
- Status: built + verified below, except where flagged. **NOT complete until Meera passes it.**
- All copy/rules below are Pakdam's own wording. No ShadowHunt/SCRAM code, text, images, copy, or brand was used. No thresholds were invented as facts: every numeric default is a calibration placeholder, labelled OPEN.

## 1. `venueName` — removed from the schema entirely

- `packages/shared/src/types.ts`: `RoomConfig.venueName` deleted. `RoomConfig` now extends the new `HouseRules` interface (see §3). A comment in the type states no place-name field may be re-added.
- `packages/shared/src/validation.ts`: the `venueName is required` check deleted. Nothing checks a venue name any more.
- `apps/web/src/lib/demo-store.ts`: `createRoom(hostName, config: RoomConfig)` — the `Omit<RoomConfig, 'venueName'>` signature and the `'Play zone'` shim are deleted. Nothing fills a venue name in.
- `apps/web/src/app/admin/page.tsx`: the `r.room.config.venueName` read is deleted; incident events are now listed by room code (`Room ABC123 — …`). The `Live payment gateway: None.` line is also deleted (see §6).
- Repo-wide grep (src only, excluding `dist/`, `.next/`, `test-results/`): the only remaining `venueName` occurrences are one test assertion (`'venueName' in mkConfig()` is `false`) and one code comment in `demo-store.ts` explaining the removal. **No other screen reads it any more** — the lobby / play / results / profile reads Kabir listed as open are gone (removed by sibling workers in the same pass; verified by grep, not assumed). The remaining `Play zone` strings are generic UI headings for the zone on the map (`ZoneEditor`, `PlayAreaMap`, lobby settings sheet), not a venue name.
- Old demo rooms already in a browser's localStorage may still carry a `venueName` key in stored JSON; nothing reads it.

## 2. Modes — Classic / Infection / Zombie / Breach, in the engine, not just labels

New `packages/engine/src/modes.ts` (`describeMode`, `modeTurnsRunner`, `modeStartsWithSingleHunter`, `modeForcesShrink`, `applyConfirmedTag`, `resolveModeOutcome`, `MODE_INFO`):

- **Classic** — a tagged Runner is OUT (watches live). Hunters win when every Runner is caught; Runners win if any survive the clock.
- **Infection** — a tagged Runner JOINS the Hunters (role flips to Hunter). Hunters win when no Runner is left.
- **Zombie** — like Infection, but the game always starts with exactly **one** Hunter (patient zero); validation rejects `hunterCount !== 1` for Zombie. Every tagged Runner turns.
- **Breach** — Classic catch rules, but the zone **must** shrink (validation rejects shrink-off for Breach). The host-setup form labels Breach BETA and states plainly on the card that flag capture is not built yet: the beta plays as Classic catches with a forced shrinking zone. That is stated, not hidden.

Zombie/Breach have no published rulebook in the competitor research, so their rules above are Pakdam's own design, stated on the create screen. `MatchMode` is now `'classic' | 'infection' | 'zombie' | 'breach'`; the create screen offers all four as host-selectable cards (Manhunt card covers Classic + Infection variant radios; Breach and Zombie are their own cards).

`demo-store.ts` applies the mode on every confirmed catch (`applyConfirmedTag` + `resolveModeOutcome`): Classic/Breach record the Runner as caught, Infection/Zombie flip the Runner to Hunter, and the match completes only when the mode's win rule is met. The demo store's old Classic-only "all runners caught" completion is replaced by the mode-aware resolver.

## 3. Host-customisable rules — everything on sliders / steppers, no hidden defaults

New `HouseRules` in `packages/shared/src/types.ts` (shared by `RoomConfig` and `HouseRulePreset`); enforced by `validateRules` / `validateRoomConfig` / `validateHousePreset` in `packages/shared/src/validation.ts` (`HOST_RANGES`):

| Rule | Host range (enforced) | UI control |
|---|---|---|
| Game time / duration | 5 min–3 h (300–10800 s) | Duration stepper: 5/10/15/30/45/60/90/120/180 min |
| Head start | 0–30 min (0–1800 s) | Head-start stepper: none/30 s/1 m 30 s/3/5/10/15/30 min |
| Ping time | 0 = no pings, else 30 s–30 min | Ping stepper: none/30 s/1/3/5/7/10/15/30 min |
| Hunters | 1 to players − 1 (Zombie: exactly 1) | Hunters stepper / Balance toggle (provisional table 1 for 3–4, 2 for 5–8, 3 for 9–16 — calibration OPEN) |
| Team assignment | Random or Selected | "Random hunters" toggle; Selected = host picks exactly `hunterCount` Hunters in the lobby (see §4) |
| Zone size | Radius 200 m–10 km (diameter 400 m–20 km) — see conflict note §8 | Radius stepper + slider on the map; suggested from player count (`suggestZoneRadiusMeters`) |
| Zone shrink | On/off + every 1–60 min | Shrink toggle + "Shrinks every" stepper; each shrink keeps 75% of the radius (`shrunkRadiusMeters`); shrink schedule in `shrinkTimesSeconds` |
| Catch rules | Runner confirmation on/off; dispute always allowed | "Runner confirms every catch" toggle; off = a Hunter tag counts at once, Runner may still dispute |
| Outside-zone rules | Seen live 5–300 s; tagged 10–600 s; tagged > live | Two sliders; defaults 30 s live / 2 min tagged (Brief v2 reference values, calibration OPEN). Engine: `outsideZoneStatus(secondsOutside, liveAfter, taggedAfter)` → `inside | live | tagged` |

Notes on ranges: the sibling host-setup worker's steppers originally offered duration from 15 min and ping only to 7 min; I widened them to the brief's full ranges (duration 5/10 min added; ping 10/15/30 min added) in `components/host-setup/draft.ts` (`DURATION_STEPS_S`, `PING_STEPS_S`). Ping's 30 s floor and shrink's 1 min floor are the sibling's ranges, kept as-is (validation allows them; the brief's "1–30 min" ping is inside the enforced range).

## 4. Team assignment — Random or Selected (host picks)

- Schema: `RoomConfig.teamAssignment: 'random' | 'selected'` + `selectedHunterIds: string[]` (empty at creation; picked in the lobby from joined players).
- Engine (`packages/engine/src/roles.ts`): `assignRoles(players, hunterCount, { teamAssignment, selectedHunterIds, shuffle })` — Random is a real Fisher–Yates shuffle when `randomDraw` is on, legacy join-order draw when off (the demo board relies on join order: host first = Hunter); Selected requires exactly `hunterCount` joined, non-repeated ids. `balancedHunterCount(totalPlayers)` is the provisional Balance table.
- Demo store: `setTeamAssignment(roomId, assignment)` and `setSelectedHunters(roomId, playerIds)` (lobby only, validated); `setPhase` to HEAD_START/ACTIVE assigns roles honouring assignment + Balance + Random, with Zombie forced to 1 Hunter; a stale/incomplete host pick falls back to a random draw (logged as a room event) so a match never fails to start over a stale pick. `updateRoomConfig` (lobby settings sheet) clears a stale pick when the Hunter count or assignment changes.
- Lobby (`apps/web/src/app/room/[roomId]/page.tsx`, minimal edit for this item only): "This game" facts now show the real mode label, "No pings" when ping is off, Teams (Random / Host picks), and zone shrink; the host gets a Teams picker (switch Random ↔ Selected, checkboxes, Save Hunters) and Start is blocked until exactly `hunterCount` Hunters are picked when Selected.
- Create flow: the "Random hunters" toggle switches Random ↔ Selected, with the note that Selected is picked in the lobby.

## 5. House-rule presets + live host dashboard

- Presets: built-in Quick / Standard / Big Park (full rule sets) plus **saved house-rule presets** — the host names the current rules and saves them to localStorage (`pakdam.house-presets.v1`, this device only), then loads/deletes them. Saving validates through `validateHousePreset` (same rules as a room). Implemented in the shared host-setup form (`components/host-setup/HostSetupForm.tsx` + `draft.ts`: `loadHousePresets` / `saveHousePresets` / `applyPresetToDraft` / `BUILT_INS`).
- Live host dashboard: (a) the create screen's sticky bar shows a **live-updating room summary strip** (`roomSummaryStrip`: zone size · Hunters · ping · match length) as the host changes any rule; (b) the Host dashboard (`apps/web/src/app/host/page.tsx`) lists rooms by room code with phase, player count, check-ins, zone size, and the live summary strip, plus a Settings button reopening the same setup controls in the lobby; (c) `getHostDashboard(roomId)` in `demo-store.ts` returns the structured dashboard (mode, teams, timings, zone diameter via `zoneDiameterMeters`, roster, caught/turned counts, check-ins, recent events) with no coordinates and no exact locations, for the host flow to use.

## 6. No payment UI

- No payment, membership, subscription, checkout, pricing, or paywall UI exists in my files. The admin page's `Live payment gateway: None.` line was removed. The create/host-setup screens state "Everything is free — no payment, no membership, no paywall." The only remaining payment/membership wording in my area is one comment in `packages/shared/src/types.ts` stating presets live on the host's device and are never a payment or membership.

## 7. What the sibling host-setup worker built on top of this (not redone)

While this work was in progress, a sibling worker restructured the create flow around `components/host-setup/` (`HostSetupForm`, `PlayAreaMap`, `HostSettingsSheet`, `draft.ts`) and extended `packages/shared` / `packages/engine` / `demo-store` in place (optional host toggles `balanceHunters` / `randomDraw` / `showPingHistory` / `listedNearby` with `DEFAULT_HOST_TOGGLES` + `resolveHostToggles`; `ZONE_RADIUS_*` constants; `suggestZoneRadiusMeters`; `shrunkRadiusMeters`; `updateRoomConfig`; public-lobby listing helpers; host dashboard page). My original `create/page.tsx` rewrite was superseded by their one-screen design — I did **not** re-impose it; the modes/rules/presets/dashboard above now live in their form, which builds on my schema/engine work (it imports `describeMode`, `balancedHunterCount`, `shrinkTimesSeconds`, `HouseRulePreset`). Files outside my original area that I touched, and why: `draft.ts` (stepper ranges only, §3); `apps/web/src/app/demo/page.tsx` (one mechanical schema-conformance fix to its `createRoom` call, flagged for the demo worker to review); `apps/web/src/app/room/[roomId]/page.tsx` (team-assignment UI only, per the founder follow-up explicitly assigning "create + lobby role assignment").

## 8. Open items / conflicts for the coordinator (do not silently resolve)

1. **Zone-size range conflict — needs a founder/coordinator decision.** Brief v2 (SCRAM research) says zone **200 m–3 km across**. The sibling's implementation deliberately allows radius 200 m–10 km (diameter **400 m–20 km**, "no 1 km cap"), enforced in `HOST_RANGES.zoneDiameterMeters` and `ZONE_RADIUS_*`. I kept their wider range and flagged it rather than overwriting a sibling's live work. My UI enforces the brief range nowhere now (my create-page radius clamp is gone with the superseded rewrite). Decide: brief 200 m–3 km, or the wider 400 m–20 km — then one worker aligns `HOST_RANGES`, `ZONE_RADIUS_*`, the radius slider/stepper, and `validateDraft` together.
2. **E2E spec is stale for the new create flow** (`apps/web/e2e/smoke.spec.ts`, not my area): it fills a `Venue` label that no longer exists, fills a `display name` label (now "Your codename"), clicks "Next — zone" (now a one-screen form with a sticky CREATE LOBBY bar), and expects `Players (5/16)` while `maxPlayers` is now the host-chosen player count. It also still fails on the landing heading (landing worker's area, pre-existing). The spec needs a rewrite by whoever owns it.
3. **Play page ping display with pings off:** `apps/web/src/app/room/[roomId]/play/page.tsx` computes `nextPingIn` with `% pingIntervalSeconds` — with ping 0 (no pings) that is a division by zero (NaN display). The HUD worker should guard it (show "No pings"). Typecheck passes (still a number); this is a runtime display gap only.
4. **Calibration stays OPEN and labelled:** preset durations, head start, ping, shrink timing, zone-size suggestion, the Balance Hunter table, and the outside-zone 30 s / 2 min defaults are placeholders, not measured values. No thresholds were invented as facts.
5. **Breach flag capture is not built** — the beta plays as Classic catches with a forced shrinking zone, stated on the mode card. Flag capture is a follow-up, not in this change.
6. **Meera review pending — do not claim complete until she passes it.**
7. **Visual check on a real phone is still owed** (text/DOM-only verification, no screenshots, per the gateway rule).
8. **Production build is BROKEN at "Collecting page data" — needs coordinator triage, not caused by this worker's files.** `next build` compiles successfully, then fails with `[Error: Invariant: no direct app page entry found for /_not-found]`, reproduced 3× including on a clean `.next`. No `notFound()` call, no `generateStaticParams`, no route-segment config exists anywhere in `src`; the root layout is intact. Kabir's build passed earlier on 2026-11-17, so the breakage arrived with a change since then — sibling workers added routes (`account`, `find`, `leaderboards`) and edited `layout.tsx` / `page.tsx` in the same window (their mtimes fall inside my build runs). None of my files touch the router root, the layout, or route-manifest generation, and typecheck + tests pass, so I did not attempt a fix outside my area. A clean `.next` rebuild was tried and fails identically. Whoever owns the app shell should triage (suspects: a new route/layout interaction with Next 15.5's internal `/_not-found` page, or a Serwist/build interaction).

## Verification (real output, 2026-11-17)

| Check | Result |
|---|---|
| `npm run typecheck` (all 4 workspaces: shared, engine, workers, web) | **PASS, 0 errors** (re-run after the sibling's edits; one transient TS6053 about stale `.next/types` files on an earlier run cleared on re-run — stale build output, not a code error) |
| `npm test` (root: builds shared/engine/workers, runs engine + workers tests) | **PASS — engine 26 pass / 0 fail / 3 skipped (Phase-1-only skips), workers 18 pass / 0 fail** (44 total, 0 fail). New tests: `packages/engine/test/modes.test.ts` (5 tests: mode rules, tag flip, outcomes, selected assignment, zone/shrink/presets) plus the rewritten host-ranges test in `engine.test.ts` |
| `npm run build` (with the documented dev/CI escape `PAKDAM_ALLOW_PLACEHOLDER_URL=1`) | **FAIL — see §8 item 8.** Compiles successfully (21–104 s), then fails at "Collecting page data" with `[Error: Invariant: no direct app page entry found for /_not-found]`. Reproduced 3×, including once on a clean `.next` (deleted and rebuilt). Not a stale cache. |
| Grep `venueName` (src only) | Only a test assertion (`'venueName' in mkConfig()` is `false`) + one removal comment in `demo-store.ts` |
| Grep payment/membership wording (my files) | Only one comment in `packages/shared/src/types.ts` stating presets are never a payment or membership; no payment UI anywhere |
| Smoke check of the merged create flow | Not run as a browser flow (text-only, no screenshots, no live browser in this worker). The create flow is the sibling's one-screen form; its controls are wired to the same `validateRules` / `draftToConfig` / `createRoom` path the tests cover. A Playwright pass over the new form is owed (e2E owner, see §8 item 2). |
