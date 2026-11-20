# Pakdam E2E suite (fresh rebuild)

Playwright specs for the new Pakdam PWA, written fresh against the built
UI in `apps/web/src` (SCRAM-SPEC §3–§11, BEHAVIOUR.md §2–§3). Every
assertion is DOM text, a role, or element state — **no screenshots and no
visual assertions** anywhere in the suite.

## How to run

```bash
cd apps/web
npm run test:e2e            # runs `playwright test` (starts `next dev` if needed)
npx playwright test e2e/smoke.spec.ts
```

The config (`../playwright.config.ts`) starts `npm run dev` on port 3000
unless a server is already running there (`reuseExistingServer: true`).
Set `PLAYWRIGHT_BASE_URL` to point at a different server.

## Demo vs live

The app is demo or live depending on `NEXT_PUBLIC_WORKER_URL` **at the
time the dev server starts** — it is baked into the client bundle, so the
variable must be set before the server starts, and the test process must
see the same value.

| Run | Command | What runs |
| --- | --- | --- |
| Demo (default) | `npm run test:e2e` with no Worker URL set | All demo specs. Live specs skip. |
| Live | `NEXT_PUBLIC_WORKER_URL=https://<worker> npm run test:e2e` (server started with the same variable) | The live specs in `join-lobby.spec.ts` and `session-restore.spec.ts`. Demo specs skip. |

The two modes are mutually exclusive in one run because the mode is
app-global: a demo spec cannot run against a live server and vice versa.
Demo rooms live in `localStorage` (`pakdam.demo.rooms.v1`); multi-player
demo tests open several pages in **one** browser context so they share
that store (each page keeps its own seat in `sessionStorage`).

## Ola Maps key

Map specs skip cleanly when no key is configured — the VM has none:

| Run | What runs |
| --- | --- |
| No key (default) | `map-tiles.spec.ts` "no Ola key" tests: the one-line missing-key banners in the lobby (`Map needs an Ola Maps key — set NEXT_PUBLIC_OLA_MAPS_API_KEY.`) and on play (`Map needs an Ola key — the game still works without it.`). The with-key tests skip. |
| Key set | `NEXT_PUBLIC_OLA_MAPS_API_KEY=<key> npm run test:e2e` (server started with the same variable): canvas-mount, Draw tap-to-place, and no-go tests run; the no-key tests skip. These need network access to `api.olamaps.io`. |

## Spec inventory

| File | Tests | Covers |
| --- | --- | --- |
| `helpers.ts` | — | Room create/join, 3-player lobby, ready + start, role reveal, demo-store reads, force-end, overflow / target / no-Forge checks |
| `smoke.spec.ts` | 6 | Home, HOST A GAME → mode select, codename required, code errors, no console errors |
| `join-lobby.spec.ts` | 12 | Join by code, lobby-is-setup, COPY, I'm ready, start gate (<3 / not-all-ready / all-ready), F2 guest auto-navigate, remove, Leave; + 2 live |
| `host-setup.spec.ts` | 11 | Mode change, steppers, shrink toggle/stepper, Play zone OFF, Balance/Random/ping-history, guest cannot edit |
| `live-hud.spec.ts` | 10 | Role reveal, status strip, head start lines, bottom tabs, radio, PTT (absent in demo), SOS, safety pause, suspended banner, per-role catch buttons |
| `catch-nav.spec.ts` | 13 | Name-only picker, claim card, scanner, manual fallback, no catch code, `?runner=` auto-select, `?scan=1` shows the picker, runner confirm/dispute, host resolve (ALLOW + REJECT in demo), P0-1 resume |
| `catch-results.spec.ts` | 4 | Runners Win / Hunters Win, one-line stats, max-6 timeline, START A FRESH GAME, new code |
| `session-restore.spec.ts` | 6 | Reload in lobby/play, guest reload, sessionStorage key, no-seat state; + 1 live |
| `outside-zone.spec.ts` | 4 | Banner + countdown, back-inside clears, poor GPS freezes, 30 s ejection (demo) |
| `mobile-layout.spec.ts` | 5 | 360px baseline, ≥48px targets, bottom tabs reachable, 130% zoom proxy (277px) |
| `responsive.spec.ts` | 6 | 320 / 360 / 768 / 1280px, no overflow, tabs reachable |
| `brutal-phone.spec.ts` | 2 | Full phone-viewport E2E (create → results), phone HUD basics |
| `map-tiles.spec.ts` | 6 | No-key banners (3) + with-key canvas / Draw taps (3) |
| `map-accuracy.spec.ts` | 6 | 500 m → 125 m default, 100 m minimum, no 1 km cap, always-Auto final size, next zone hidden, ±50 m GPS rule |
| `no-forge-office.spec.ts` | 3 | No Forge/Hermes/office text on any screen |

Total: **94 tests** (88 demo + 3 live + 3 with-key; the live and with-key
tests skip unless their environment is configured).

## Notes for the verifier

- Do **not** run with screenshots or visual comparison — the suite is
  text-only by design (the founder's sessions are text-only).
- The `outside-zone` ejection test and the GPS-rough test take 30–70 s
  each; they carry their own `test.setTimeout`.
- Two E2E-found defects from the earlier report are FIXED and their tests
  assert the fixed behaviour: `/catch?scan=1` with no open claim shows the
  name picker (`catch-nav.spec.ts`), and the "Shrinks every" stepper steps
  along the [1, 3, 5, 10, 15, 20] grid (`host-setup.spec.ts`).
- The host is created ready (live DO `create` + demo `createRoom` both set
  `isReady` + `briefingConfirmed` at creation), so `readyAll` skips pages
  already on the flipped ready state and the "I'm ready" flip test starts
  from that state. The lobby mode label is title-case DOM text
  (`Classic` / `Infection`), and the session-storage key holds an ARRAY of
  sessions (one per room).
- A 500 m zone measures exactly 500 m: the circle builder's metres-per-degree
  matches the haversine Earth radius (R = 6,371,000 m) in `@pakdam/shared`,
  so `boundaryRadiusMeters` of a nominal 500 m circle rounds to 500, not 499.
- Tailwind v4 needs `apps/web/postcss.config.mjs` (`@tailwindcss/postcss`).
  Without it the production build shipped ZERO utilities (the built CSS
  literally contained `@tailwind utilities`) — every Toggle measured 0 px
  wide and no switch was clickable. After a clean rebuild the utilities
  generate; a non-clean rebuild can reuse the stale CSS, so verify from a
  clean `.next` if the styles ever look wrong.
- Claiming a runner opens the QR scanner first (claim → scan); the
  claim-open card is reached by cancelling the scanner. The catch page's
  done card falls back to the latest confirmed catch, so "Tag someone
  else" records the dismissed catch id — without that the done card
  re-appears and a second tag is impossible.
- A test that needs a pending zone shrink must use the default 30-min
  round (`startDemoMatch(context, { roundShort: false })`): the shortened
  10-min round puts the first shrink at round end and the HUD correctly
  shows "no shrink left".
- Demo auto-resumes a suspended player on tab-visible (`useRoomState`),
  so the "Resume sharing" button must be clicked while still hidden.
- The roster renders the current player's name as "Teo (you)" in one
  span, so exact-text name assertions must include the suffix.
- Outside-zone banner waits are 45 s: the emulated FAR fix lands in ~2 s
  unloaded but the 15 s bound timed out under 4-worker parallel load.
