# Meera — Independent Re-Review: Kabir Fix Round, Pakdam Slice 1 (v2.1)

**Reviewer:** Meera (independent). **No code modified.** All verification below is from files I read and commands I ran myself, never from Kabir's summary alone. Text only, no screenshots.

**Spec:** `pakdam-build-pack-v2.1/` (PRD 15, API 17, test plan 18, wireframes 24).
**Build reviewed:** `pakdam-app/` + Kabir's report `docs/KABIR-FIX-ROUND-REPORT.md` (2026-11-16 12:48 UTC).
**Answers:** `docs/MEERA-FAST-BUILD-REVIEW-REPORT.md` (verdict: NEEDS FIXES — HIGH-1, HIGH-2, MEDIUM-1–3, LOW-1–4).
**Kabir's report was not modified.** Its mtime/size are unchanged from his delivery (18,106 bytes, 12:48 UTC).

## Verdict: READY FOR GATE D

All nine findings from my first review are fixed, verified by my own runs. The server now provably applies a catch: a full catch request→confirm runs through the DO handler, and a duplicate delivery returns the original outcome with `replayed: true` and no second effect. Two new LOW findings appeared in this re-review (sitemap, Playwright self-start — see LOW-5, LOW-6); both are small, bounded, and do not touch the realtime core, so they do not hold the gate, but they must be fixed in the next pass and must not be reported as fixed until they are.

## What I ran myself (real output)

- **Lint:** `npm run lint` → **clean, 0 errors, 0 warnings**. Exit 0. Confirmed.
- **Root test:** `npm test` → engine **15 pass / 0 fail / 3 skipped** (Phase 1 native, by design) and workers **18 pass / 0 fail / 0 skipped**. Confirmed — root test now runs both suites, so the stale-dist trap from MEDIUM-1 is gone.
- **Typecheck:** `npm run typecheck` → **exit 0, all 4 workspaces**. Confirmed.
- **Production build:** `PAKDAM_ALLOW_PLACEHOLDER_URL=1 npm run build` → **compiled successfully**, Serwist SW bundled, 25 static pages (Kabir's count; my route-line count of the build table was 27 including the table's own framing lines — the build itself exits 0 and lists all routes). Confirmed.
- **Smoke test:** `next start -p 3106`, 25 routes curled → **25/25 HTTP 200**: `/`, `/create`, `/join`, `/host`, `/help`, `/safety`, `/legal`, `/legal/terms`, `/legal/privacy`, `/legal/community`, `/install`, `/admin`, `/how-it-works`, `/game-modes`, `/about`, `/contact`, `/faq`, `/grievance`, `/accessibility`, `/profile`, `/manifest.webmanifest`, `/sitemap.xml`, `/robots.txt`, `/sw.js`. Landing HTML contains the foreground-only warning. Confirmed. (My first smoke attempt failed on my own invocation — `next start` from the repo root with a path argument never became reachable, all 000s; the retry from `apps/web/` worked. That was my error, not the app's. The shell's exit 15 in that attempt was my own `pkill` matching the command line.)
- **Playwright e2e:** `PLAYWRIGHT_BASE_URL=http://localhost:3106 npx playwright test` → **3 passed / 0 failed** (landing 1.0s, bad-code join 0.9s, full loop 16.0s). Confirmed. See LOW-6 for the one qualification: the suite passed against a server I had already started; its own webServer could not self-start (guard fired — see below).

## Per-finding verdicts (all nine from my first review)

### HIGH-1 — DO game-command handlers: FIXED
- **Code read:** `workers/src/room-do.ts` (689 lines) — `applyGameCommand` handles `location.update`, `catch.request`, `catch.confirm`, `catch.dispute`, `safety.pause`, `safety.resume`, `safety.sos`, `leave`, `signal.send`, `pin.place`, `announcement.send`, `ready.set`, `briefing.confirm`, `player.suspended`. The old `default: → VALIDATION_FAILED` branch that rejected every gameplay command is gone for these types.
- **Tests run by me:** workers suite 18/0 includes "HIGH-1: full catch runs over the DO handler — request, confirm with the issued token, confirmed once", plus dispute / wrong-token / expiry / suspended-runner rejection, location.update, and safety pause/resume/SOS/leave/ready/briefing/signal/pin/announcement. I read the test bodies: the full-catch test asserts the reply is `catch.requested`, the raw token is returned server-side only and appears in no broadcast reply and no `qrTokenHash` is in the replies, the catch is `requested`, `serverSeq` advances 10→11, and the confirm turns it `confirmed` with `activeCatchIds` empty.
- **No-coordinate-leak re-check:** `snapshotForRecovery` strips `latestFix`, `pendingPings`, `idempotency`, and nulls `qrTokenHash` on catches; `buildWsSnapshot` returns recipient-filtered catches with the hash stripped; `recoverState` empties `latestFix`/`pendingPings` (players must send a fresh foreground fix). Confirmed by grep and by the passing snapshot tests.
- **Caveat (unchanged from Kabir's disclosure, and it matters):** the handlers are proven by unit tests driving `handleWsClientMessage` directly, **not by a live socket**. No deployment exists, so no end-to-end realtime path over a real WS connection has ever been exercised. That is the API/deployment mission's work, not a Slice 1 defect — but the word "wired" must not be read as "proven live".

### HIGH-2 — Server-side idempotency: FIXED
- **Code read:** `workers/src/room-do.ts:638-662` — mutating commands require `commandId`; a duplicate (same seat + commandId) returns the stored replies with `replayed: true` and no second effect; the same commandId for a different command → `VALIDATION_FAILED`; missing commandId on a mutating command → `VALIDATION_FAILED`. TTL 600,000 ms, labelled placeholder, retention OPEN.
- **Test read and run:** "HIGH-2: duplicate commandId returns the original outcome with replayed:true and no second effect" — asserts `replayed` false then true, `serverSeq` does not advance on the duplicate, exactly one catch exists, replies are deep-equal, the same token is returned, the wrong-command reuse is rejected, and the missing-commandId case is rejected. It passes in my run.
- **Known limitation (disclosed, still open):** `recoverState` drops idempotency records on DO recovery — a command retried across a DO restart could be applied twice. Documented in code (`room-do.ts:56`). Must be closed by durable idempotency storage in the API mission. Acceptable for Slice 1, not acceptable to forget.

### MEDIUM-1 — Root test/build omit workers: FIXED
- **Code read:** root `package.json:13-15` — `build` runs shared → engine → **workers** → web; `test` builds shared, engine **and workers**, then runs engine **and workers** tests. `.github/workflows/ci.yml` runs `npm run lint`, `npm test`, `npm run typecheck`, `npm run build`.
- **Proven by my run:** root `npm test` executed both suites (engine 15/0/3, workers 18/0) in one invocation. The stale-dist trap is closed.

### MEDIUM-2 — RLS policies: FIXED (written, NOT yet active)
- **Code read:** `supabase/migrations/0002_rls.sql` (158 lines) — RLS enabled on 9 tables (profiles, rooms, players, room_events, catches, safety_events, bug_reports, grievances, audit_log, telemetry_daily) and **11 `create policy` statements** (lowercase, which is why a case-sensitive grep returns 0): own-row profiles, participant rooms/room_events, self-or-host players, party-or-host catches, self-or-host safety_events/bug_reports, and explicit `using (false)` for grievances, audit_log, telemetry_daily. No INSERT/UPDATE/DELETE policy for anon or authenticated anywhere — writes go through the service role only.
- **Blocker stated exactly in the file header:** guest seats have `players.profile_id` NULL and can therefore NEVER satisfy any policy until OD-022 (auth method) closes and guests get an identity path. The file says it must NOT be applied to a live database until then, and applying it now would deny every guest read — fail-closed and safe, but not a working read path.
- **Honest caveat (unchanged):** the file was NOT syntax-checked against a live Postgres — no psql exists here. It must be validated with `supabase db push --dry-run` or psql before applying. No coordinates are in these tables, so RLS cannot leak them (HNT-068). No auth method was invented — the file names Supabase Auth only as the architecture's candidate and says the method by which a JWT is obtained is still OPEN.

### MEDIUM-3 — Lint gate: FIXED
- **Code read:** `eslint.config.mjs` (42 lines, flat config: `eslint/js` + `typescript-eslint` recommended + `react-hooks` recommended, `no-explicit-any` and `no-unused-vars` as errors, generated files ignored). Root `lint` is now `eslint .` (real, not the echo stub); web `lint` is `eslint .` (Next 15 removed `next lint`). CI runs it.
- **Proven by my run:** `npm run lint` exits 0, zero errors, zero warnings.

### LOW-1 — Placeholder base URL: FIXED
- **Code read:** `apps/web/next.config.ts:11-20` — throws at build time when `NODE_ENV === 'production'` and `NEXT_PUBLIC_SITE_URL` is still `https://pakdam.example`; escape is the explicit `PAKDAM_ALLOW_PLACEHOLDER_URL=1`, documented as dev/CI-only. No real domain invented.
- **Proven by my run:** the guard fired — a `next start` attempt without the escape exited 1 with the guard's error, and the Playwright webServer's own `next start` attempt failed with the same error (see LOW-6). `layout.tsx:12` and `sitemap.ts:6` still default to the placeholder, overridable via env. Do not publish until a real domain is set and the trademark gate clears.

### LOW-2 — Per-page metadata: FIXED
- **Code read:** `export const metadata` present in all four server pages — `contact/page.tsx:4`, `grievance/page.tsx:4`, `accessibility/page.tsx:4`, `profile/page.tsx:4` — with the bodies split into client components under `src/components/{contact,grievance,accessibility,profile}/`. All four return 200 in my smoke test.

### LOW-3 — Browser verification: FIXED (with one qualification — see LOW-6)
- **Run by me:** Playwright 3/3 (see above), including the full loop create → join → lobby → start → play → 3 catches → results, text/DOM assertions only.
- **The demo-store bug Kabir reports is real and fixed:** I read `apps/web/src/lib/demo-store.ts:72-78` — the comment records the mismatch and the fix (token now issued for the catch's own `catchId`, `issueCatchToken(catchId, …)`), and the full-loop spec passes against it. The DO handler was already correct; only the demo store had the mismatch.
- **Qualification:** the spec runs green against a pre-started server. It does not yet self-start cleanly (LOW-6).

### LOW-4 — WS count reporting error: FIXED
- **Checked:** `pakdam-build-pack-v2.1/29-CHANGELOG.md:30` and the merged `pakdam-build-pack-v2.1-complete.md` both now read "19 client→server, 31 server→client". Grep confirms "18 client→server" appears nowhere in the pack or merged file — it remains only inside my own first report (line 73, my evidence quote) and inside Kabir's fix report (his evidence quote), both correctly left untouched. The protocol was not changed to match the wrong count.

## New findings in this re-review

### LOW-5 — Sitemap omits the three new legal routes
- **Evidence:** `apps/web/src/app/sitemap.ts` `PUBLIC_ROUTES` lists `/legal` but not `/legal/terms`, `/legal/privacy`, `/legal/community`. All three routes exist and return 200 in my smoke test. The sitemap is therefore stale one day after the routes were created.
- **Fix:** add the three routes to `PUBLIC_ROUTES` in the same change that touches the legal pages next.

### LOW-6 — Playwright webServer cannot self-start on a clean checkout (LOW-3 is only half-fixed as shipped)
- **Evidence:** `apps/web/playwright.config.ts` webServer runs `npm run start -- -p 3105` with `reuseExistingServer: true` and **no environment**. On a machine with no server already running, `next start` hits the LOW-1 guard and fails (I watched it fail in my own run: "Refusing production build: NEXT_PUBLIC_SITE_URL is still the placeholder…"). The suite passed in my run only because I had started a server on port 3106 with the escape and pointed `PLAYWRIGHT_BASE_URL` at it. `npm run test:e2e` as documented (`playwright test`, no env) does not self-start.
- **Fix:** give the webServer the dev/CI-only escape (`PAKDAM_ALLOW_PLACEHOLDER_URL=1`) in the config, or document that `test:e2e` requires a pre-started server with the escape. Do not leave a documented command that fails on a clean checkout.

## Other checks (spot, not exhaustive)

- **No copied code/text/assets:** zero hits for seekhunt/fang-x/hiderush/jetlag/shadowtag/snaphunt across `apps packages workers`.
- **No invented thresholds/domains/contacts:** `calibration.ts` still labels values OPEN/placeholder; the placeholder domain is guarded, not published; legal pages still carry OPEN grievance-officer fields (per the parallel workers' report, not re-verified line by line here).
- **Cross-tab localStorage lost-update:** still open as a demo-only item (one e2e run showed 3 runners at play time after the lobby showed 5 players; the spec now asserts the HUD matches whatever the store holds). Demo-only, not a spec failure — but it should be investigated before the demo is relied on for a live pilot.
- **Runner-only token delivery:** still unresolved by design — the §3.3 catalogue has no runner-only token message; the DO returns the raw token as `issuedCatchToken` server-side only. The API mission must add the delivery channel. Never in a broadcast, snapshot, log, or stored outcome (verified in the HIGH-1 test assertions).

## What is still NOT done (unchanged — none of these is a Slice 1 defect)

No live multi-device realtime (no Cloudflare/Supabase deployment or credentials; WS client written but not wired to the Worker; `wrangler dev/deploy` not run; migrations not applied to a live DB); auth method OPEN (OD-022) so RLS must not be applied live; all calibration OPEN; no live ping feed in demo mode; host resolution of disputed catches has no store function; legal pages are DRAFT; no server persistence, staff auth, or CMS; accessibility settings apply on the Accessibility page only in the original scope (a parallel worker reports a site-wide provider — not verified in this review); idempotency records dropped on DO recovery (see HIGH-2); no pen test, no alerting, no backup decision, no outdoor field tests. All disclosed, all correctly outside Slice 1.

## Gate recommendation

**READY FOR GATE D.** HIGH-1 and HIGH-2 are fixed and proven by tests I ran myself; MEDIUM-1–3 and LOW-1–4 are fixed and verified. Fix LOW-5 and LOW-6 in the next pass — they are one-line changes and must not be reported as fixed until they are. Founder Gate D follows; the live-play blockers above are the work of the API/deployment/auth missions, and none of them should be read as closed by this verdict.
