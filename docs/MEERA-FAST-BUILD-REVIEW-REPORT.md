# Meera — Independent Review: Kabir Fast Build, Pakdam Slice 1 (v2.1)

**Reviewer:** Meera (independent). **No code modified.** All verification below is from files I read and commands I ran myself, never from Kabir's summary alone. Text only, no screenshots.

**Spec:** `pakdam-build-pack-v2.1/` (PRD 15, API 17, test plan 18, wireframes 24).
**Build reviewed:** `pakdam-app/` + Kabir's report `docs/KABIR-FAST-BUILD-REPORT.md`.

## Verdict: NEEDS FIXES

The build is real, the tests pass, the server boots, and the front-end top 10 is present in code. But the realtime layer is protocol-only: the Durable Object rejects every gameplay command a live client would send, and no server-side idempotency exists. That is not a "wired" realtime contract, and it is the difference between a demo that plays locally and a platform that plays across devices. Fix HIGH-1 and HIGH-2, plus the MEDIUM items, before Founder Gate D. Nothing here requires a rebuild — the fixes are bounded.

## What I ran myself (real output)

- **Engine tests:** `npm test` → **15 pass, 0 fail, 3 skipped** (Phase 1 native, by design), 18 total. Confirmed, matches Kabir.
- **Workers tests:** `npm test --workspace=workers` (after `npm run build --workspace=workers`) → **12 pass, 0 fail**. Confirmed. Note: root `npm test` does NOT run these — see MEDIUM-1.
- **Typecheck:** `npm run typecheck` → clean across all 4 workspaces (shared, engine, workers, web). Exit 0. Confirmed.
- **Production build:** `npm run build` → compiled successfully, Serwist SW bundled, **22 static pages**. Confirmed.
- **Smoke test:** `next start -p 3105`, 20 routes curled → **20/20 HTTP 200**: `/`, `/create`, `/join`, `/host`, `/help`, `/safety`, `/legal`, `/install`, `/admin`, `/how-it-works`, `/game-modes`, `/about`, `/contact`, `/faq`, `/grievance`, `/accessibility`, `/profile`, `/manifest.webmanifest`, `/sitemap.xml`, `/robots.txt`, `/sw.js`. Landing HTML contains the foreground-only warning. Confirmed. (The shell's exit 15 in my run was my own `pkill` of the test server after all 20 responses, not a failure.)

## What passed (verified, not trusted)

- **v2.1 top-10 front-end — all 10 present in code:** `NextZonePanel.tsx` (54 lines), `CompassRadar.tsx` (61), `freshness.ts` (101, "Last reported X min ago"), `RoleToolbar.tsx` (93, silence alarm + "Location stopped"), `SafetyControls.tsx` ("I'm safe"), `AllSafeCheck.tsx` (52), `ReadinessChecklist.tsx` (159), `ZoneEditor.tsx` (162, keyboard-operable), catch page claim states requested/awaiting-confirmation/confirmed/disputed/expired + wrong-code cooldown, `ThemeControls.tsx` (`cb-theme` toggle). Caveat: I verified code presence, not rendering — no browser was run (see LOW-3). No rematch button: correct, HNT-031 is P1.
- **WS contract (§3.3) at the envelope level — matches spec:** credential-free `hello` (`packages/shared/src/types.ts:118-119`, `helloHasCredential()` at :287, rejected with VALIDATION_FAILED — test-confirmed in workers tests); `auth.refresh` the only ticket-bearing message (`types.ts:185`); ticket only in `?ticket=` handshake (`apps/web/src/lib/websocket.ts:203`, `ticketProvider()` over HTTPS); snapshot/resync with `lastServerSeq`, stale events dropped, heartbeat + missed-heartbeat counter, close-code action map (`types.ts:271-282`), 19 client types and 31 server types in code — I counted the spec §3.3 catalogue: it lists exactly these (the "18/24" count in the v2.1 coordinator's summary is wrong; the spec tables and the code agree, the summary does not — reporting error only, no code fix).
- **Canonical schema — only schema:** `supabase/migrations/0001_init.sql` creates exactly 10 tables (profiles, rooms, players, room_events, catches, safety_events, bug_reports, grievances, audit_log, telemetry_daily; lowercase `create table`, which is why a case-sensitive grep misses it). Old file-03 names appear only in deletion-mapping comments. `players.is_host` + `match_role` separate; engine test "host is a permission, not a match role — host can be a hunter" passes.
- **No hidden-coordinate leak:** snapshot excludes coordinates, pending pings and token hashes (`packages/engine/src/snapshot.ts:4-5`, `workers/src/room-do.ts:21,28,40`); `PlayerView`/`CatchView` omit hashes; workers tests confirm snapshot contents. Demo store persists rooms to localStorage without coordinates (`apps/web/src/lib/demo-store.ts:5`).
- **No copied code/text/assets:** zero hits for seekhunt/fang-x/hiderush/jetlag/snaphunt/shadowtag across `apps packages workers`.
- **No invented thresholds:** `packages/shared/src/calibration.ts` labels every value OPEN/placeholder with the rule that field evidence must replace it; `WS_OPEN_CALIBRATION` values are all null.
- **Admin P0, no fake green lights:** `apps/web/src/app/admin/page.tsx:57,63,68` — "Not deployed", "No green lights are shown for services that do not exist", "No live location is shown anywhere on this page". Super-admin correctly stated as a separate staff surface, P1, not this page. Admin has no auth — disclosed as a demo queue view, acceptable for Slice 1 only.
- **Public website P0 present:** all new routes return 200; sitemap/robots present; no invented contact (CT-XXXX / GRV-XXXX references).

## Findings

### HIGH-1 — The Durable Object rejects every gameplay command; the realtime contract is protocol-only, not wired
- **Evidence:** `workers/src/room-do.ts:244` — `handleWsClientMessage` has cases only for `snapshot.request`, `resync.request`, `heartbeat`, `auth.refresh`, `player.suspended`, `hello`; the `default:` branch returns `VALIDATION_FAILED: unknown WS message type` for everything else. Grep of `workers/src/` finds `catch.request`, `location.update`, `safety.pause` only in `rate-limit.ts` (as rate-limit keys), never as handled commands. A live WS client sending `catch.request`, `catch.confirm`, `location.update`, `safety.pause`, `safety.sos` or `leave` gets an error for every gameplay action.
- **Why it matters:** Kabir's report says "Realtime — v2.1 frozen contract wired". The envelope/ticket/snapshot layer is wired and tested; the game layer is not. The play page does not use the socket at all — it runs on `demo-store.ts` (localStorage). So no end-to-end realtime path has ever been exercised, in either direction.
- **Fix:** implement DO handlers for the mutating game commands that apply the engine transitions (catch, location, safety, leave, ready, signals/pins/announcements) and broadcast the resulting server events, with tests that drive a full catch over the DO handler; OR relabel the DO as a protocol skeleton and strike the word "wired" from the report and the handoff. Do not leave both claims standing.
- **File:line:** `workers/src/room-do.ts:188-244`.

### HIGH-2 — No server-side idempotency, despite spec §3.6 requiring it
- **Evidence:** Spec 17 §3.6 (also 17:36-38): "Duplicate delivery returns the original outcome with `replayed: true`, never a duplicate effect." The client sends `commandId` + `idempotencyKey` on every command (`apps/web/src/lib/websocket.ts:155-157`), but grep finds zero occurrences of `commandId` or `idempotency` anywhere in `workers/src/` or `packages/engine/src/`. Nothing reads, stores, or dedupes on it.
- **Why it matters:** harmless today only because HIGH-1 means no command is applied at all. The moment HIGH-1 is fixed, a retried `catch.request` (reconnect, timeout retry) double-applies. Fix it in the same mission as HIGH-1, not after.
- **Fix:** DO-side dedupe store keyed by `commandId` (per room/player, TTL-bounded), returning the stored outcome with `replayed: true` on duplicates; add a workers test proving a duplicate `catch.request` produces one effect and a replayed outcome.
- **File:line:** `workers/src/room-do.ts` (absence — no idempotency handling exists); `apps/web/src/lib/websocket.ts:155-157` (client side only).

### MEDIUM-1 — Root `npm test` and `npm run build` omit the workers workspace entirely
- **Evidence:** `package.json:13,15` — root `build` runs shared + engine + web; root `test` runs shared + engine builds then engine tests only. Workers tests run only when invoked explicitly (`npm test --workspace=workers`). Kabir's own report records the consequence: his first workers run showed only 3 tests because `dist/` was stale — he rebuilt and got 12. The same staleness will recur silently in CI.
- **Fix:** add `npm run build --workspace=workers` to root `build` and `npm test --workspace=workers` to root `test`; add both to `.github/workflows/ci.yml` (verify the workflow actually runs them — I did not check CI config in this review).
- **File:line:** `package.json:13,15`.

### MEDIUM-2 — RLS is principles only: RLS enabled, zero policies created
- **Evidence:** `supabase/migrations/0002_rls.sql` (16 lines) enables RLS on 7 tables and creates no policies; its own comment says exact policies are a mission deliverable. Fail-closed (no policy = deny) means this is a functionality gap, not a leak — no coordinates are in these tables at all — but there is currently no working participant read path.
- **Fix:** keep it labelled unimplemented until the auth method (OPEN) is decided, then add the participant/host/admin policies in the API mission; do not ship a "Supabase connected" claim before that.
- **File:line:** `supabase/migrations/0002_rls.sql`.

### MEDIUM-3 — No lint gate at all
- **Evidence:** root `package.json` `lint` script is an echo stub: "lint: eslint config is a Phase B mission deliverable". No eslint config exists in the repo. Typecheck passed, but style, unused-code and import hygiene are unchecked.
- **Fix:** add eslint config + `npm run lint` that actually runs, and run it in CI. Small, but it is a gate that currently does not exist.
- **File:line:** `package.json` (`lint` script).

### LOW-1 — Placeholder canonical/sitemap base URL
- **Evidence:** `apps/web/src/app/layout.tsx:11` and `apps/web/src/app/sitemap.ts:6` default to `https://pakdam.example` (overridable via `NEXT_PUBLIC_SITE_URL`). Disclosed by Kabir. Do not publish until a real domain is set and the trademark gate clears.
- **Fix:** set `NEXT_PUBLIC_SITE_URL` at deploy time; add a build-time fail if it is still the placeholder in a production deploy.

### LOW-2 — Four client pages have no per-page metadata
- **Evidence:** `apps/web/src/app/contact/page.tsx`, `grievance/page.tsx`, `accessibility/page.tsx`, `profile/page.tsx` are all `'use client'` and carry no metadata (App Router forbids it there). Disclosed by Kabir.
- **Fix:** split into server pages + client components in the next front-end pass.

### LOW-3 — No browser verification: e2e is a skeleton, top-10 UI verified in code only
- **Evidence:** `apps/web/e2e/smoke.spec.ts` is a 2-test skeleton, "not run in this task" by its own comment. I verified the top-10 components exist in code; I did not verify they render, that the MapLibre map loads, that Wake Lock works, or that the colour-blind theme is legible. Playwright was not run by Kabir or by me.
- **Fix:** run the Playwright smoke spec (and extend it to the catch flow and safety controls) before Gate D; record text/DOM results.

### LOW-4 — Reporting error, not a code defect: WS counts in the v2.1 summary are wrong
- **Evidence:** the v2.1 coordinator's handoff says "18 client→server, 24 server→client". The spec §3.3 catalogue and the code both have 19 client types and 31 server types. No code change needed; correct the count in the v2.1 changelog/register so a future reviewer does not "fix" the code to match a wrong summary.

## What is still NOT done (confirmed, not new — Kabir disclosed all of these)
No live multi-device realtime (no deployment, no Cloudflare/Supabase credentials, auth method OPEN, migrations not applied to a live DB); no live ping feed in demo mode (hot/cold only after the labelled demo-simulation button); host resolution of disputed catches has no store function; all calibration OPEN; legal pages are DRAFT; no server persistence, staff auth, or CMS; accessibility settings apply on the Accessibility page only. All disclosed and all correctly outside Slice 1 — except HIGH-1/HIGH-2, which are the boundary between "protocol skeleton" and "realtime wired" and must be settled, not left ambiguous.

## Gate recommendation
**NEEDS FIXES.** Fix HIGH-1 and HIGH-2 in one bounded mission (DO game-command handlers + idempotency, with workers tests driving a full catch over the handler), fix MEDIUM-1–3, and run the Playwright smoke spec (LOW-3). Then re-review. The front-end, schema, privacy model, tests, typecheck, build and smoke test are all genuinely good — this is close, but a green test suite is not proof the server applies a catch, and right now the server provably does not.
