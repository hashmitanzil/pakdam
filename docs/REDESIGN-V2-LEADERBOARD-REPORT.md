# Redesign v2 — Leaderboards + Friends + Account — Worker Report

**Worker:** leaderboards + friends + account · **Date:** 2026-11-17 · **Brief:** `pakdam-masterpiece-brief-v2.md` + `pakdam-competitor-deep-dive-2026-11-17.md`
**Area only:** `apps/web/src/components/profile/*`, `apps/web/src/app/profile/page.tsx`, `apps/web/src/app/account/page.tsx`. No other files touched.

## What was built

### 1. Monthly leaderboard — points from real match data only
New pure module `apps/web/src/components/profile/leaderboard.ts` (no runtime imports, no location data):

| Rule (shown plainly on the page) | Points |
|---|---|
| +1 per 3 minutes free as a Runner | up to 10 per match |
| Never caught in a finished match | +10 |
| Per confirmed tag, as a Hunter | +3 |
| Clean sweep — Hunters catch every Runner (each Hunter in that match) | +10 |

Honesty rules enforced in code and surfaced in the UI:
- **Only COMPLETED matches count.** In-progress, cancelled or abandoned matches earn no points and are counted as skipped, with the count shown.
- **Free time** = match start (when Hunters start moving) → catch confirmation time, or match end for survivors. **Head-start minutes are NOT counted** — the demo store records no separate head-start start time, so counting them would be guessing; this is stated on the page.
- A Runner whose catch has no confirmation time, or a survivor in a match with no recorded end time (missing `endsAt` and a `result.durationSeconds` of 0 is treated as "no end time recorded", never as a 0-minute match), gets **no free-time points for that match** and the match is flagged `incompleteData` with the reason shown per match. Never-caught/tag/clean-sweep points from that match still count.
- **Only confirmed catches count.** Requested / disputed / expired / rejected catches earn nothing and cannot create a clean sweep.
- **Opt-in only.** The board shows only the opted-in player. There is no server board in this demo, so other players' points are never shown — they appear only after they opt in on their own device. The old "Scoring: OPEN — not decided yet" badge is gone: the rules are now decided and published on the page, with a per-match breakdown table (role, free minutes, never-caught, tags, clean sweep, total, data-quality notes).

### 2. Friends + "Played with" (last 7 days)
- **Played with:** everyone the player shared a room with in the last 7 days, computed from real local match history (`pakdam.demo.rooms.v1`). Names only, games-together count, last-played date, roles played. Grouped by display name (stated on the page: the same person rejoining gets a new player record, so names are the only stable key on this device). No locations, no contact details.
- **Friends:** local list (`pakdam.friends.v1`) — add someone from "Played with", remove any time. Friends are enriched with real shared-game counts from history. Starts empty; no contacts invented.
- No exact locations or routes are shown anywhere on the profile.

### 3. Free account surface — `/account` (new)
- **Email code:** design + local demo only. The code is generated on this device and shown on screen, labelled "Demo only — no email is actually sent". 6-digit code, 10-minute expiry, 3 attempts then a new code is required. On verify, a demo account (`pakdam.account.v1`: method, email, date) is stored locally; sign-out deletes it.
- **Google sign-in:** design preview only. The button is shown with a plain note that it is not connected; tapping it creates no account and sends nothing to Google.
- **No password is ever asked for or stored. No paid account, no payment, no membership UI anywhere** — the page states in plain text that accounts are free and there is no paid account. Content scan of the whole area confirms the only matches for price/payment/membership wording are statements that they do not exist; no area-name field anywhere in the area.
- Profile links to `/account` and back; profile page metadata updated (points now computed, free account).

### Files changed / created
- `apps/web/src/components/profile/leaderboard.ts` — NEW, pure scoring + played-with/friends logic.
- `apps/web/src/components/profile/ProfileClient.tsx` — rewritten: display name, leaderboard (rules + opt-in + points table), friends, Played with (7 days), stats, games.
- `apps/web/src/components/profile/AccountClient.tsx` — NEW, free account demo.
- `apps/web/src/components/profile/profile.module.css` — added rules box, points table, friends list, demo-note/code styles.
- `apps/web/src/app/account/page.tsx` — NEW route `/account`.
- `apps/web/src/app/profile/page.tsx` — metadata only.

## Verification (real output)

| Check | Result |
|---|---|
| Scoring unit checks (18 assertions, compiled `leaderboard.ts` + `node /tmp/lb-check/check.js`) | **18 passed, 0 failed** — clean sweep + tags = 16, caught-runner free points 4/7, survivor capped at 10 + never-caught 10 = 20, unfinished match earns nothing, disputed catch earns nothing, missing start/end time flags incomplete without inventing free points, season filter, played-with 7-day window |
| `npm run typecheck` (root, all workspaces) | **PASS at first run** (before concurrent workers changed shared types — see below) |
| `npm run typecheck --workspace=apps/web` (re-run at end) | My files: **0 errors**. Only error left in the tree: `src/app/demo/page.tsx` (outside my area) |
| `npx eslint` on my area (`components/profile/`, `app/profile/`, `app/account/`) | **exit 0, no findings** |
| `npm test` (root) | **PASS** — engine 15 passed / 0 failed (18 tests, 3 skipped), workers 18 passed / 0 failed |
| Production build | **BLOCKED by other workers' in-flight files, not by mine** (see below). SWC compile itself succeeds every run ("Compiled successfully in 16.5s / 17.2s / 90s"), which includes my routes |

### Production build — what actually happened
- Plain `npm run build` refuses first on the **pre-existing** `NEXT_PUBLIC_SITE_URL` placeholder guard in `next.config.ts` (trademark gate) — expected; the documented dev/CI escape `PAKDAM_ALLOW_PLACEHOLDER_URL=1` was used for verification only, never for a deploy (same as prior workers' reports).
- With the escape, the build's lint/type phase failed on files **outside my area**, and the failing file changed between runs as parallel workers edited: first `src/app/room/[roomId]/play/page.tsx` (unused vars — fixed by its owner mid-run), then `src/app/create/page.tsx` + `src/app/demo/page.tsx` (type error: `RoomConfig` gained new required fields `selectedHunterIds`, `teamAssignment`, `zoneShrinkEnabled`, … in `packages/shared/src/types.ts` at 07:02:56 UTC, after my clean typecheck; create was fixed by its owner, demo still open), then `src/components/catch/CatchPanel.tsx:33` (unused `meId`). I touched none of these files and did not fix them — they are not mine to fix.
- One build failure **was** mine and I fixed it: an unused `eslint-disable` directive in `ProfileClient.tsx` (reported as a warning in the first build). Fixed by restructuring the season date into a `useMemo` (`seasonInfo`) with correct dependencies; eslint on my area is now clean.
- **Meera / parent note:** the production build needs re-running once the other workers' edits land; my area is verified clean by typecheck + eslint + SWC compile + the 18 scoring assertions above.

## Open / known limits (not defects to hide)
- No server leaderboard exists in this demo, so the board shows only the opted-in player on this device. Other players appear only after they opt in on their own device.
- Free-time points exclude head-start minutes (no separate head-start start time is recorded) — stated on the page.
- The demo store sets `result.durationSeconds = 0`; free time for survivors therefore relies on `endsAt`. Matches with neither are flagged incomplete rather than scored.
- Demo "(demo)" practice players appear in "Played with" by name like any other player; the page notes they are practice players.
- No real auth: email codes are shown on screen in the demo, Google sign-in is a design preview. Both are labelled as such on the page.
