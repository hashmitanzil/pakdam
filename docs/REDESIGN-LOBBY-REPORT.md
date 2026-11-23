# Pakdam redesign — lobby / join + safety — worker report

**Worker:** lobby/join + safety · **Date:** 2026-11-17 · **Area:** join, lobby, safety, Team Radio, leaderboards/profile
**Trigger:** founder feedback 2026-11-17 — the UI did not meet expectations. Brief: exceptionally well, best of the best, no compromise.
**Reference read first:** `../pakdam-competitor-deep-dive-2026-11-17.md` (ShadowHunt + SCRAM full-site research). All copy is our own; no competitor code, text, images, or brand was copied.

## What changed, per screen

### Join — `apps/web/src/app/join/page.tsx` (+ `join.module.css`)
- 6-box room-code entry: auto-advance, backspace moves back, a pasted code spreads across all six boxes. First box carries the "Room code" label (the other five are labelled "Code character N of 6"), so assistive tech and the e2e suite still find one "Room code" field.
- One clear primary action ("Join lobby", sticky thumb-zone button, disabled until the 6-character code is complete).
- Display name, 18+ checkbox + safety-briefing link (now enforced in the submit handler, not only by native validation), foreground-only banner, plain-language error. Same join logic as before (`getRoomByCode` → `joinRoom` → lobby). Links to Create / How it works.

### Invite landing — `apps/web/src/app/join/[code]/page.tsx`
- Was a stub that only pointed back to /join. Now joins directly: big invite code with a copy button, display-name field, 18+ checkbox, "Join lobby" — one step instead of two. Invalid/closed invites get a plain-language error ("doesn't match an open game…") and a link to type a different code.

### Lobby — `apps/web/src/app/room/[roomId]/page.tsx`
- **No venue/area name anywhere.** Heading is now just "Lobby"; the game is described by its room code, phase, and match facts. (Verified by grep: zero `venueName` occurrences in any of my files.)
- Dark-red code hero: room code at 40px with letter-spacing, "Copy code" and "Copy invite link" buttons (clipboard with a long-press fallback message).
- "This game" card: mode Classic, players n/max, match length, head start, ping every, hunter count — all read from the room config, nothing invented.
- Role preview: "Your role is decided when the game starts" + Hunter ◆ H / Runner ▲ R cards in our own words. No role is shown or implied before assignment (roles are null in the lobby).
- Roster, readiness checklist, safety strip, lobby radio, host controls, and a scrollable "What has happened" event log replace the old flat layout. The duplicate raw player list (last-fix lines) was removed — the roster now carries freshness labels.
- Primary action: sticky "I'm ready" button (shows "✓ I'm ready — tap to change" when ready, with `aria-pressed`).

### Roster — `apps/web/src/components/lobby/Roster.tsx`
- Avatar initials, name, Host/You tags, ready state as icon + word ("✓ Ready" / "… Not ready yet" / "✕ Suspended"), freshness label ("Last reported…", "Suspended — location unknown"), suspension count. Role is stated as "decided when the game starts" — never invented.
- Host remove buttons (new): host can remove any non-host player except themselves, with a confirm dialog. See "Still open" — this is demo-local (below).

### Readiness checklist — `apps/web/src/components/lobby/ReadinessChecklist.tsx`
- Same five checks and same logic (`PRE_MATCH_WARNING` export unchanged, still imported by the lobby page). New presentation: "X of 5 done" progress bar, icon + word per row (✓ Done / ✕ Not ready / … Checking / ? Not checked), prominent acknowledgement box for the pre-match warning. GPS quality bands still follow the shared placeholder bands and are labelled calibration OPEN.

### Safety strip — NEW `apps/web/src/components/lobby/LobbySafety.tsx`
- **SOS:** confirm dialog with the engine's `SOS_COPY`, then a red banner ("SOS raised — stay where you are") and a room-log entry. Copy states plainly that Pakdam is not an emergency service.
- **Safety pause:** anyone can pause the start; while paused the host's Start button is disabled and a banner names who paused and when. Host or pauser resumes. Pause state persists in localStorage (`pakdam.lobby-pause.<roomId>`) and is recorded in the room log.
- **"Tell everyone in the game" hold-to-reveal:** press-and-hold 2 seconds with a live progress bar, so it cannot fire by accident. On completion the reveal is written to the room event log and a confirmation shows. The copy is honest: in this demo the reveal is recorded in the log; the live position broadcast is a production behaviour (the demo store holds no coordinates). No exact opponent positions are shown anywhere.

### Team Radio — NEW `apps/web/src/components/radio/TeamRadio.tsx` (+ `radio.module.css`)
- Text + quick messages, team-only. Five quick messages in our own words ("Ready when you are", "Give me a minute", "Check the boundary first", "I'm here — where is everyone?", "Let's go!") plus free text capped at 140 characters, last 50 messages kept on-device.
- In the lobby, teams don't exist yet, so it is labelled "Lobby radio" and explains that radio becomes team-only (Hunters ◆ H / Runners ▲ R, separate channels) once the game starts. The component takes `scope="lobby" | "hunters" | "runners"`.
- **Voice is explicitly not available:** "Voice push-to-talk is not available in the PWA — use the quick messages or type a short note instead." No voice claim anywhere.
- Demo storage: messages live in this browser's localStorage only (`pakdam.radio.<scope>.<roomId>`); nothing is sent to a server.

### Catch code — `apps/web/src/components/catch/QrDisplay.tsx` (+ `catch.module.css`)
- Bigger QR (220px) in a red frame, copy-code button, live countdown to expiry, plain-language explainer ("Showing it is not a catch — you must still confirm"). The manual code stays in a single `<p>` whose text is exactly the code — the e2e suite reads it from there.

### Profile / leaderboard — `apps/web/src/components/profile/ProfileClient.tsx` (+ `profile.module.css`), `apps/web/src/app/profile/page.tsx` (metadata only)
- Opt-in monthly leaderboard (current month, e.g. "November 2026"), checkbox stored on-device (`pakdam.leaderboard.optin`), plain-language privacy: display name + finished-game counts only; exact location and routes are never shared; opt out any time.
- **No points, no ranks, no invented scores.** A badge reads "Scoring: OPEN — not decided yet" with copy explaining that any points shown before the rules are set would be invented. What is shown is real: games played/finished this season and overall, counted from rooms on this device.
- Games list now shows room code + phase + player count + date — the venue name was removed.

### Design system
- New CSS modules only (`lobby.module.css`, `radio.module.css`, `catch.module.css`, `profile.module.css`, `join.module.css`); `tokens.css` was not touched. Pakdam red brand throughout; status is always icon + word, never colour alone; roles are shape + letter (◆ H solid / ▲ R hatched) per the existing colour-blind convention; one primary action per screen in the thumb zone; mobile-first.

## Files touched (mine only)
- Rewrote: `apps/web/src/app/join/page.tsx`, `apps/web/src/app/join/[code]/page.tsx`, `apps/web/src/app/room/[roomId]/page.tsx`, `apps/web/src/components/lobby/Roster.tsx`, `apps/web/src/components/lobby/ReadinessChecklist.tsx`, `apps/web/src/components/catch/QrDisplay.tsx`, `apps/web/src/components/profile/ProfileClient.tsx`
- New: `apps/web/src/components/lobby/LobbySafety.tsx`, `apps/web/src/components/lobby/lobby.module.css`, `apps/web/src/components/radio/TeamRadio.tsx`, `apps/web/src/components/radio/radio.module.css`, `apps/web/src/components/catch/catch.module.css`, `apps/web/src/components/profile/profile.module.css`, `apps/web/src/app/join/join.module.css`
- Small edits: `apps/web/src/app/profile/page.tsx` (metadata description only); one e2e assertion in `apps/web/e2e/smoke.spec.ts` (see below).
- Not touched: `demo-store.ts`, `create/page.tsx`, `tokens.css`, play/catch/results pages, home page.

## Verification (real output, 2026-11-17)

- `npm run typecheck` — **exit 0**, all four workspaces. (One transient run failed only on `components/match/ZoneEditor.tsx` — another worker's in-progress file, untouched by me; the concurrent worker fixed it and the re-run is clean.)
- `npm test` — **exit 0**: engine 18 tests (15 pass, 0 fail, 3 skipped), workers 18 tests (18 pass, 0 fail).
- Production build — **exit 0** with the documented dev/CI escape (`PAKDAM_ALLOW_PLACEHOLDER_URL=1`; the bare build is deliberately refused while `NEXT_PUBLIC_SITE_URL` is the placeholder `https://pakdam.example`). Compiled in 27.3s, 25/25 static pages generated. My routes: `/join` 115 kB, `/join/[code]` 114 kB, `/room/[roomId]` 119 kB, `/profile` 111 kB first load.
- Throwaway browser verification (31 checks, Playwright against the production build on :3105, script in `/tmp/pakdam-lobby-verify.mjs`, not committed): **31/31 PASS** — unknown-code error + 6-box paste distribution, invite landing + invalid-invite error, lobby heading/code/no-venue-name, players count, role preview, safety strip, radio, host controls, start disabled at 1 player → enabled at 4 all-ready, ready toggle both ways, radio quick message, SOS banner, hold-to-reveal completing (2s real pointer hold) + event-log entry, host remove 4→3 players, safety pause holding + resuming the start, profile leaderboard opt-in + OPEN scoring badge + no venue name. (First run was 29/31: the hold probe failed only because my script moved the mouse to coordinates below the viewport without scrolling; the component was fine — `scrollIntoViewIfNeeded()` fixed the script, not the component.)
- `grep venueName` over all my files: **zero matches**.

## E2E suite status — needs the parent's attention
- `apps/web/e2e/smoke.spec.ts`: **3/3 failing, all at the landing page, before reaching my screens.** The landing page (another worker's redesign, `apps/web/src/app/page.tsx`) now has the hero heading "Hide in the real world. Run from real Hunters." — no heading contains "Pakdam" any more, so the suite's first assertion (`heading { name: /Pakdam/ }`) fails on every test. My screens were therefore not covered by the suite run; the 31-check browser verification above covers them instead.
- I updated exactly one assertion in the spec: the lobby heading check, from `/Lobby — Test Park/` to exact `Lobby` plus the room code being visible — because the redesign deliberately removes the venue name from the lobby heading (per the task). The remaining landing assertions (`/Pakdam/` heading, `/Create a game/` and `/Join a game/` links, foreground warning) belong to the landing worker's redesign and were left for them / the orchestrator — I did not rewrite them.
- Recommendation: the landing worker updates the three landing assertions to the new hero copy, then the full smoke suite should be re-run (it exercises my join + lobby + catch flow end-to-end, including the 6-box code fill and the single-`<p>` catch code).

## What is still open
1. **Host remove + safety-event logging are demo-local.** `demo-store.ts` has no remove-player or generic event API, and it is owned by another worker, so the lobby page implements `removePlayerLocal` / `appendRoomEvent` by reading/writing the demo store's localStorage record directly (clearly commented in the file). Production needs the real API/WS events (`player.removed`, `safety.*`, `announcement`) and the demo-local helpers deleted.
2. **Hold-to-reveal broadcast is log-only in demo.** The reveal is recorded in the room event log; no coordinates exist in the demo store, so nothing is actually broadcast. Production must broadcast the position to all players over WS.
3. **Team Radio is localStorage-only in demo.** Messages stay in the browser; production needs the WS `signal.send` / `announcement.send` channels, team-scoped delivery, and the radio mounted on the play screen for Hunters/Runners (currently only the lobby scope is mounted; the component supports `scope="hunters" | "runners"`).
4. **Leaderboard scoring is OPEN.** No points or ranks exist anywhere in the UI by design. A real monthly board needs server-side opt-in storage and decided, measured scoring rules — none are invented here.
5. **Voice push-to-talk is not available** in the PWA; the UI says so. If voice is ever wanted, it needs a separate feasibility decision (it is not claimed or half-built).
6. **Lobby pause is per-browser localStorage**, not a room-wide server state — in demo, a pause set in one tab is not seen in another tab until reload. Production pause must be server state.
7. The `RoomConfig.venueName` field still exists in the shared types and the create flow (other workers' area); my screens simply never display it. Removing the field itself is a schema decision for the create-flow owner.
