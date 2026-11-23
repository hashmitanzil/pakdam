# Kabir — Pakdam MASTERPIECE redesign report (host setup, location-first)

- Date: 2026-11-17
- Builder: Kabir (lead builder, redesign)
- Trigger: founder feedback 2026-11-17 — the UI did not meet expectations; the area-name field was wrong. The game must start from LOCATION.
- Scope: ONLY `apps/web/src/app/create/page.tsx`, `apps/web/src/app/host/page.tsx`, `apps/web/src/components/match/ZoneEditor.tsx`, `apps/web/src/components/map/MapView.tsx`, `apps/web/src/lib/demo-store.ts` (venueName removal only), `apps/web/src/lib/geolocation.ts` (one-shot fix only). No other files touched.
- References read first: `pakdam-competitor-deep-dive-2026-11-17.md` (ShadowHunt + SCRAM, live-site research). All copy in this redesign is written by us — no ShadowHunt/SCRAM text, images, or brand copied. SCRAM-style slider is our own design.
- Status: built + verified below. **NOT complete until Meera passes it.**

## What changed per screen

### 1. Create a game — Step 1 (Mode / preset) — `app/create/page.tsx` (rewritten)
- **DELETED: the venue / area-name input.** There is no place-name field anywhere in host setup any more.
- Presets are now large tappable radio cards (Quick / Standard / Big Park / Custom Classic) with one-line blurbs; Quick stays the Phase 0 default. Preset values come from `CALIBRATION_OPEN`, not literals.
- New sliders (all `type="range"`, 44 px touch height, ember accent, live value readout, min/max end labels):
  - Players 3–16 (default 6) — shows "6 players — 1 Hunter · 5 Runners" live.
  - Hunters 1 to (players − 1).
  - Duration 5–120 min, step 5.
  - Head start 0–10 min ("No head start" at 0).
  - Ping interval 1–15 min ("every 3 min").
- Editing any rule slider switches the preset to Custom automatically. Changing player count re-suggests the zone size.
- Mode control: Classic Manhunt (selected) / Infection (shown, **disabled** — "After the pilot — Classic only in Phase 0"). `MatchMode` is `'classic'`-only in the frozen Phase 0 contract, so Infection cannot be created; showing it disabled is honest, not a fake option. The room is always created with `mode: 'classic'`.
- `maxPlayers` is now the host's chosen player count (was hardcoded 16). `hunterCount` comes from the slider.
- Intro copy rewritten location-first: "The game starts from where you are standing — no place name to type."
- Step 1 → 2 requires only a display name (≥ 2 chars).

### 2. Create a game — Step 2 (Play zone) — `components/match/ZoneEditor.tsx` (rewritten)
- **DELETED: the venue prop, the venue-derived area-check code (`areaCheckCode`), and the typed no-go name list.**
- **"Use my location" is the one primary action** (large ember button). It uses the new one-shot GPS fix (`getCurrentFix`, see below). On success: centre = the host's real GPS, accuracy shown ("accuracy about 12 m"), map flies to the host.
- **No hardcoded Ranchi centre.** Zone starts with `centreLat/centreLng: null`. Until GPS or a tap, the map shows a world view and says "No centre yet… Nothing is centred on a guessed place." Verified: zero occurrences of `23.36`, `85.33`, `Ranchi` in any of my four UI/geolocation files.
- **Permission-denied fallback (plain language, in a banner + live region):** "Location permission denied — tap the map to place the zone where you are standing, or allow location in your browser settings and try again." Timeout and unavailable cases have their own messages. The fallback is tap-to-place on the map, plus manual lat/lng inputs.
- **Real map, live:** `MapView` renders the zone circle as a red line + light fill, the GPS accuracy ring (blue dashed), and the centre marker. Overlays re-sync on every render — dragging/resizing the zone updates the map immediately.
- **Zone size slider (SCRAM-style, our own design):** range 50–2000 m radius, step 25 m, with −25 m / +25 m step buttons and "Reset to suggested size". Readout shows the **diameter in m/km** ("about 550 m across", "about 1.2 km across") via the existing `formatDistance` helper.
- **Size auto-suggested from player count:** `suggestedRadiusMeters(players) = clamp(200 + 25 × (players − 3), 200, 1000)` m radius. Labelled on screen as a starting point, not a measured value — "sizes are calibration OPEN, so check the circle against the real ground". 6 players → 275 m radius → 550 m across.
- **No-go areas are drawn, not typed:** a "No-go mode" toggle (aria-pressed); while on, taps on the map drop a no-go circle (~50 m across, dark-red hatched on the map). Each is listed with its centre coordinates and a Remove button. No typed name list remains. Drawn no-go polygons are now passed into the room config (`noGoAreas`), where the old code passed `[]` and only kept names on a list.
- Kept from the old editor: undo history (U), keyboard controls (arrows move centre ~55 m, +/− radius, U undo — now guarded with "Set the zone centre first" when there is no centre), saved zone presets in localStorage (a saved zone shape, not a place name), live announcements.
- Step 2 → 3 is blocked until a centre exists, with an inline error.

### 3. Create a game — Step 3 (Rules & confirm) — `app/create/page.tsx`
- Rule preview now shows the zone as coordinates + diameter + drawn no-go count ("Zone: centre 23.36420, 85.33100 · about 600 m across · 1 no-go area drawn on the map") instead of a venue name.
- Safety briefing and the two checkboxes are unchanged in wording ("I have checked the venue for roads, water, and private land." / "I will be on site at the venue, and I confirm players are 18+.") — "venue" here is the spec's word for the physical place, not a name field; keeping the wording also keeps the existing e2e checkbox selectors working.
- Foreground-only warning kept. Venue-only pilot banner kept (spec term, no name).
- Create is disabled until display name + zone centre + both safety confirmations are complete.

### 4. Host dashboard — `app/host/page.tsx`
- **DELETED: the `config.venueName` room title.** Rooms are listed by room code ("Room KJSMZ") plus phase, players, check-ins, and the zone size label ("Zone: About 550 m across" via the existing `zoneSizeLabel`). Intro line updated: "Rooms are listed by room code, not by a place name."

### 5. Map — `components/map/MapView.tsx` (rewritten internals, same public contract + additions)
- **No hardcoded Ranchi fallback:** centre is the fix, otherwise world view `[0, 0]`, zoom 2. Caption says so.
- **Live overlay sync:** zone / next-zone / ping / no-go / accuracy-ring / centre marker are created, updated (`setData`) or removed idempotently on every render while the map is loaded. The map is still created once per style; prop changes never rebuild it.
- **Tap-to-place:** new optional `onMapClick(lat, lng)` prop (crosshair cursor). New optional `keyboardPan` prop (host setup passes `false` so arrow keys move the zone instead of panning the map; play page default `true`, unchanged).
- **No-go rendering:** dark-red hatched fill + dashed outline, from a GeoJSON FeatureCollection.
- **Accuracy circle:** the GPS accuracy ring is now actually drawn (the old comment claimed an uncertainty circle but only a marker existed). Marker is created once and moved afterwards; the camera flies to the centre only on the first fix — later moves never yank the map.
- Play-page usage is unchanged (same props it already passed); it gains live marker/overlay updates and the accuracy ring for free.

### 6. Location — `lib/geolocation.ts` (one function added, existing `watchForegroundLocation` untouched)
- New `getCurrentFix(): Promise<ForegroundFix>` — one-shot high-accuracy fix with plain-language rejection messages per failure kind (denied / timeout / unavailable / unsupported). Used only by host setup.

### 7. Demo store — `lib/demo-store.ts` (venueName removal only)
- `createRoom(hostName, config)` now takes `Omit<RoomConfig, 'venueName'>` — no caller can pass a host-typed place name any more.
- **Compat shim (documented in code, see Open items):** `RoomConfig.venueName` is still a *required* field in `packages/shared` (not my area) and is still read by the lobby / play / results / admin / profile screens, and `validateRoomConfig` requires it non-empty. The store fills it with one fixed generic label, `'Play zone'` — never a host-typed name, never coordinates (rooms persist to localStorage without coordinates, HNT-068). The shim goes away when the shared schema drops `venueName`.

## Design
- ShadowHunt minimalism (one primary action per screen, calm setup separate from live play) + SCRAM map-first richness (map + slider + presets), Pakdam red (`#B91C1C` ember, existing tokens), mobile-first, thumb-zone (primary buttons `btn-lg`, 56 px), large touch targets (sliders 44 px, preset cards ≥ 56 px), colour-blind safe (zone = red line + words + numbers, never colour alone; no-go = dark-red hatch + label; Hunter/Runner tokens untouched), one clear primary action per screen.
- All copy is ours. No competitor text, images, or brand. No invented thresholds: every duration/ping/size is labelled a calibration placeholder / OPEN, and the size suggestion is explicitly "a starting point, not a measured value".

## Verification (real output, 2026-11-17)

| Check | Result |
|---|---|
| `npm run typecheck` (all 4 workspaces) | PASS, 0 errors (after fixing 2 errors: mode literal, keyboard-handler null narrowing) |
| `npm test` (root) | PASS — engine 15 pass / 0 fail, workers 18 pass / 0 fail (33 total, 0 fail) |
| `npm run build` | PASS with the documented dev/CI escape `PAKDAM_ALLOW_PLACEHOLDER_URL=1`. **Unescaped build is intentionally refused by `next.config.ts`** (pre-existing guard: `NEXT_PUBLIC_SITE_URL` is still the placeholder `https://pakdam.example` until the trademark gate clears — not caused by this change). `/create` and `/host` in the route list. |
| `npx eslint` on my 6 files | CLEAN, 0 errors, 0 warnings (after removing one unused eslint-disable directive) |
| Smoke run — throwaway Playwright script (`/tmp/kabir-smoke.mjs`, production build on :3105, NOT in the repo) | **16/16 PASS.** Mocked GPS (23.3642, 85.3310) → "Location found", centre readout `23.36420, 85.33100`; suggested size for 6 players "about 550 m across"; +25 m step → "about 600 m across"; no-go area drawn by map tap; rule preview shows coords + diameter + 1 no-go area; room created → lobby URL; stored config `venueName === 'Play zone'` (shim only), zone boundary 8-point polygon, no-go area 1 × 8-point polygon, `maxPlayers 6, hunterCount 2` (Standard); host dashboard lists "Room 6D2MQ" with no venue title; permission-denied flow shows the fallback message and a map tap then places the centre (no hardcoded fallback). No page errors. |
| Grep for hardcoded centre | 0 occurrences of `23.36` / `85.33` / `Ranchi` across `create/page.tsx`, `ZoneEditor.tsx`, `MapView.tsx`, `geolocation.ts` |
| Grep for venue field | No `#venue` input, no `venue`/`venueName` input in my files. Remaining "venue" mentions are only the safety-copy checkboxes/banner ("checked the venue…", "on site at the venue", "Venue-only pilot") and code comments explaining the removal. |

## Existing e2e suite — status (important, not hidden)
`npx playwright test` (repo suite, `apps/web/e2e/smoke.spec.ts`): **2 failed, 1 passed** — but both failures trip on the **landing page heading** (`getByRole('heading', { name: /Pakdam/ })` not found; the landing h1 is now "Hide in the real world." — the landing worker's redesign, not my area, not my change) before ever reaching the create flow. A targeted probe of the spec's create section confirmed: `getByLabel(/Standard/).check()`, display-name fill, "Next — zone", and the Step 2 heading all still work; the spec's `getByLabel(/Venue/i).fill('Test Park')` now fails with a timeout, as intended by this redesign. The spec needs updating by whoever owns it (see Open items) — I did not edit it; it is outside my area.

## Still open / for Meera + parent
1. **Meera review pending — do not claim complete until she passes it.**
2. **`venueName` in the shared schema (not my area):** `packages/shared/src/types.ts` (`RoomConfig.venueName`, required) and `packages/shared/src/validation.ts` (requires it non-empty) still exist, as do reads in `app/admin/page.tsx`, `app/room/[roomId]/page.tsx` (lobby heading "Lobby — Play zone" with the shim), `app/room/[roomId]/play/page.tsx`, `app/room/[roomId]/results/page.tsx`, `components/profile/ProfileClient.tsx`, and `packages/engine/test/engine.test.ts`. The schema owner should remove the field + validation + those reads; then delete the `'Play zone'` shim in `demo-store.ts`. Until then, lobby/play/results headings show "Play zone".
3. **E2E spec update needed (`apps/web/e2e/smoke.spec.ts`, not my area):** (a) landing heading `/Pakdam/` no longer exists (landing worker); (b) delete the `getByLabel(/Venue/i).fill('Test Park')` line — there is no venue field; the flow now needs a centre (grant geolocation in the test context, or tap the map); (c) `getByRole('heading', { name: /Lobby — Test Park/ })` must expect the new heading once (2) is done.
4. **Infection mode** is shown disabled by design (Classic only in Phase 0, frozen contract). Enabling it is a product/contract decision, not a UI toggle.
5. **Calibration stays OPEN and labelled:** preset durations, head start, ping interval, and the zone-size suggestion formula (`200 + 25 × (players − 3)` m radius, capped 200–1000 m) are placeholders, not measured values. No thresholds were invented as facts.
6. **Drawn no-go circles are a fixed ~50 m across** and cannot be resized individually yet — a host who needs a bigger exclusion zone draws several overlapping circles. Resizable no-go shapes are a follow-up, not in this change.
7. **Build guard:** production build without the placeholder-URL escape is refused until the trademark gate clears and a real `NEXT_PUBLIC_SITE_URL` is set (pre-existing, unrelated).
8. **Visual check on a real phone is still owed:** this redesign was verified text/DOM-only (no screenshots, per the gateway rule). The founder's eye on a real device — map legibility, slider feel, thumb-zone — is the remaining gate, plus Meera's review.
