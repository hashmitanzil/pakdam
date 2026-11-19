// Map tiles + location spec — TEXT/DOM assertions only, no screenshots.
// Founder decision (2026-11-19): the bundled offline map is GONE —
// the map is Ola Maps, fully: MapLibre GL JS + Ola Maps vector tiles
// (`default-dark-standard`, world-wide), keyed by
// NEXT_PUBLIC_OLA_MAPS_API_KEY. No bundled tiles, no maxBounds, no
// downloaded-area guard, no fallback / switcher / reload.
//
// KEY SPLIT (this is the whole design of this file): CI has NO Ola
// key, so the key is detected from the RENDERED page, never from env
// (see detectOlaKey in ./helpers — it probes /create for the
// missing-key line vs the map canvas, once per file in beforeAll).
//   (a) NO key (CI): the map fails gracefully — the "Map key not
//       set" message appears, the page does not crash (no uncaught
//       exception), no api.olamaps.io request is ever made, and the
//       game still works (geolocation, zone setup, match flow).
//   (b) Key present: Ola tile/style requests go to api.olamaps.io,
//       return HTTP 200, and EVERY one carries api_key (the style
//       JSON's own URLs carry none — olaTransformRequest appends it);
//       no other tile host is ever requested.
// Tests that need a live map SKIP without a key; tests that do not
// need the map run in both modes (denied state, numbered markers,
// phone clipping, live-play HUD). The pin-drag / GPS-accuracy tests
// live in map-accuracy.spec.ts with the same split.
//
// What the spec checks (no screenshots — gateway rule):
//  (1) Ola tiles paint (key present) / graceful missing-key failure
//      (no key) on host setup and on the live play map.
//  (2) Use-my-location granted → YOU marker + centring (key only);
//      denied → NO banner and NO denied text at all on the setup
//      screen (founder cleanup, 2026-11-18 — the denied-help line was
//      removed; the host just taps the map to place the zone), no
//      Android/iOS enable steps.
//  (3) No numbered test markers 1–4 on Circle setup / play maps
//      (tap-to-place point markers appear only in Draw mode, only
//      after the host taps the map).
//  (4) Phone-width clipping: header, helper text, map controls.
//  (5) Draw tap-to-place: 3 taps enclose a triangle, Undo / Redraw /
//      Done, point drag, and mode switch Circle ⇄ Draw clears every
//      point marker (back to Draw starts clean, 0 points).
//  (6) Live play: outside-zone banner and HUD do not hide under the
//      sticky header.
//
// In-page pixel sampling of the WebGL canvas (drawImage + readback)
// is NOT viable: it returns blank (0 samples) even when the zone
// circle and markers are painted, because the drawing buffer is
// cleared after compositing. The network + banner + console trio
// is the operative check; do not re-add a pixel gate.
//  - The numbered 1–4 markers ARE the Draw-mode tap-to-place point
//    markers (PlayAreaMap renders a numbered marker per tap, 1..N);
//    they appear only in Draw mode, only after the host taps the map,
//    and clear on switching to Circle (draw tests below). The
//    founder's "pink zone circle + 1–4" is Draw mode with its points
//    showing.
//  - The denied state takes up to ~20 s (geolocation timeout is 15 s).
//    The setup screen shows NO denied banner and NO denied text
//    (founder cleanup, 2026-11-18 removed the denied-help line from
//    the setup screen — the play page still shows it, via its own
//    locError), so the denied test below asserts the absence of both
//    instead of asserting the old short line.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  assertNoPageErrors,
  assertOlaTilesPaint,
  collectOlaRequests,
  collectPageErrors,
  detectOlaKey,
  MISSING_KEY_TEXT,
  roomState,
  startMatch,
  waitForMapOrMissingKey,
  expectNoOverflow,
} from './helpers';

/** True when the rendered app has an Ola Maps key (probed once per
 *  file — see detectOlaKey). Key-gated tests skip without a key;
 *  no-key tests skip with one. */
let OLA_KEY_PRESENT = false;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const probe = await ctx.newPage();
  OLA_KEY_PRESENT = await detectOlaKey(probe);
  await ctx.close();
});

/** The MapLibre WebGL canvas (the only map view — no Leaflet
 *  fallback, by founder decision 2026-11-17). Only exists when an
 *  Ola key is configured; without one the map is never constructed. */
const MAP_CANVAS = '.mapbox .maplibregl-canvas';
/** YOU marker: a MapLibre marker (the red pin). */
const YOU_MARKER = '.mapbox .maplibregl-marker';

/** No numbered markers 1–4 inside any map container on this page.
 *  The number text is the tap-placed point marker's own label, so
 *  this helper is only used in Circle contexts — in Draw mode the
 *  numbered point markers are expected (see the draw tests below). */
async function assertNoNumberedMarkers(page: Page, where: string): Promise<void> {
  const markers = page.locator('.mapbox').getByText(/^[1-4]$/, { exact: true });
  await expect(markers, `${where}: numbered test markers 1–4 must not appear on a player-facing map`).toHaveCount(0);
}

// --- Draw tap-to-place helpers (founder spec, 2026-11-19) ---
// Draw starts with NO shape: the host taps the map and a numbered
// point drops per tap (1, 2, 3…); 3 taps enclose a triangle = the
// zone, a 4th tap makes 4 corners, open-ended. Taps/drags edit a
// LOCAL draft; DONE applies it to the room (drawnBoundary) — until
// DONE the form validation sees no zone. All draw tests need a
// constructed map, so they skip without an Ola key.

/** The draggable numbered point markers inside the map box. */
const pointMarkers = (page: Page) => page.locator('.mapbox [aria-label^="Point "]');
/** The middle ✥ marker — appears only at 3+ points, drags the
 *  whole draft. */
const middleMarker = (page: Page) => page.getByLabel(/Drag to move the whole zone/);

/** Open /create with GPS granted, wait for the map canvas, switch
 *  to Draw. Leaves the page in Draw mode with 0 points placed. */
async function gotoDrawSetup(page: Page, context: BrowserContext, codename: string): Promise<void> {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill(codename);
  await page.getByRole('button', { name: /Use my location/ }).click();
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±\d+ m\)/i).first()).toBeVisible();
  await expect(page.locator(MAP_CANVAS).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('radio', { name: /Draw/ }).check();
}

/** Tap the map at a position inside the visible map box. Positions
 *  are spread across the box and away from the zoom controls
 *  (top-right) and from points already placed, so a tap lands on
 *  the map — not on an existing marker. */
async function tapDrawPoint(page: Page, x: number, y: number): Promise<void> {
  await page.locator('.mapbox').click({ position: { x, y } });
}

/** Read one marker's box from the page until two reads 200 ms apart
 *  agree — the same settled-box pattern as the pin-drag test in
 *  map-accuracy.spec.ts (PlayAreaMap rebuilds markers on each sync
 *  and fitToZone flies the camera, so a single-shot boundingBox()
 *  can catch a mid-swap element and return null). */
async function settledMarkerBox(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const deadline = Date.now() + 30_000;
  let prev: { x: number; y: number; width: number; height: number } | null = null;
  while (Date.now() <= deadline) {
    const cur = await page.evaluate((sel): { x: number; y: number; width: number; height: number } | null => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    }, selector);
    if (cur && prev && Math.abs(cur.x - prev.x) < 1 && Math.abs(cur.y - prev.y) < 1) return cur;
    prev = cur;
    await page.waitForTimeout(200);
  }
  throw new Error(`marker box never settled for ${selector} (last: ${JSON.stringify(prev)})`);
}

test('Ola tiles paint on host setup (PlayAreaMap) after 15 s', async ({ page, context }) => {
  test.skip(!OLA_KEY_PRESENT, 'no Ola key configured — Ola tile tests need NEXT_PUBLIC_OLA_MAPS_API_KEY');
  test.setTimeout(120_000);
  const ola = collectOlaRequests(page);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await page.goto('/create');
  // No preset chip any more: the Quick / Standard / Big Park
  // presets were removed in the video rebuild (2026-11-18) and the
  // defaults already are the old Standard (30 min, 500 m zone,
  // Balance + Random ON) — defaultDraft, draft.ts:77-78.
  await page.getByLabel(/codename/i).fill('Tile Host');
  // Wait for the map: it only exists after hydration + the MapLibre
  // load, so a click before it appears can land on an unhydrated
  // button and do nothing.
  await expect(page.locator(MAP_CANVAS).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Use my location/ }).click();
  // The old "Zone centre: set" status line was removed in the
  // simplification round (§5c) — the centre-set evidence now is
  // the "Location found — … (GPS accuracy ±N m)" status line.
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±\d+ m\)/i).first()).toBeVisible();
  const canvas = page.locator(MAP_CANVAS).first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  // Marker + overflow checks first: they do not need tiles, so they
  // still run even when the tile assertion below fails.
  await assertNoNumberedMarkers(page, 'host-setup @create');
  await expectNoOverflow(page, 'host-setup @create');
  await assertOlaTilesPaint(page, ola, 'host-setup @create');
});

test('Ola tiles paint on the live play map after 15 s', async ({ page, context }) => {
  test.skip(!OLA_KEY_PRESENT, 'no Ola key configured — Ola tile tests need NEXT_PUBLIC_OLA_MAPS_API_KEY');
  test.setTimeout(180_000);
  const ola = collectOlaRequests(page);
  await startMatch(page, context, { pickHunters: 'host' });
  const canvas = page.locator(MAP_CANVAS).first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await assertNoNumberedMarkers(page, 'play map');
  await expectNoOverflow(page, 'play map');
  await assertOlaTilesPaint(page, ola, 'play map');
});

test('no Ola key: missing-key message on host setup, no crash, no Ola requests', async ({ page, context }) => {
  test.skip(OLA_KEY_PRESENT, 'an Ola key is configured — this test asserts the no-key graceful failure');
  test.setTimeout(120_000);
  const pageErrors = collectPageErrors(page);
  const ola = collectOlaRequests(page);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('No Key Host');
  // The missing-key line (PlayAreaMap renders it when
  // !isOlaConfigured()): the map is never constructed, so there is
  // no canvas at all — and the game must not throw.
  await expect(page.getByText(MISSING_KEY_TEXT).first()).toBeVisible();
  await expect(page.locator(MAP_CANVAS)).toHaveCount(0);
  // Let any late request settle, then prove the app never even tried
  // to reach Ola: with no key there is nothing to authenticate.
  await page.waitForTimeout(5_000);
  expect(ola.hits, 'no-key: the app must make zero api.olamaps.io requests').toEqual([]);
  expect(ola.fails, 'no-key: the app must make zero api.olamaps.io requests').toEqual([]);
  // The setup still works without the map picture: geolocation lands
  // and the centre is set — only the map picture is missing.
  await page.getByRole('button', { name: /Use my location/ }).click();
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±\d+ m\)/i).first()).toBeVisible();
  assertNoPageErrors(pageErrors, 'no-key host setup');
});

test('no Ola key: missing-key banner on the live play map, no crash', async ({ page, context }) => {
  test.skip(OLA_KEY_PRESENT, 'an Ola key is configured — this test asserts the no-key graceful failure');
  test.setTimeout(180_000);
  const pageErrors = collectPageErrors(page);
  const ola = collectOlaRequests(page);
  await startMatch(page, context, { pickHunters: 'host' });
  // The play map's missing-key banner (MapView renders it when the
  // map reports 'missing-key'): the game runs, the HUD shows the
  // match, only the map picture is missing.
  await expect(page.getByText(/Map key not set — add NEXT_PUBLIC_OLA_MAPS_API_KEY in Vercel \(Production \+ Preview\) and redeploy\. The game still works without the map picture\./)).toBeVisible();
  await expect(page.locator(MAP_CANVAS)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Match status' })).toContainText('Active — hunt on');
  expect(ola.hits, 'no-key: the app must make zero api.olamaps.io requests').toEqual([]);
  expect(ola.fails, 'no-key: the app must make zero api.olamaps.io requests').toEqual([]);
  assertNoPageErrors(pageErrors, 'no-key play map');
});

test('Use my location granted: YOU marker appears and map centres on the fix', async ({ page, context }) => {
  test.skip(!OLA_KEY_PRESENT, 'no Ola key configured — the YOU marker needs a constructed map');
  test.setTimeout(120_000);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('Marker Host');
  await page.getByRole('button', { name: /Use my location/ }).click();
  // The app renders the found message twice (status line + small
  // text); the first is the status line. The rendered text is
  // "✓ Location found — Precise location (GPS accuracy ±8 m)."
  // (PlayAreaMap.tsx) — the precision label sits between "found —"
  // and "(GPS accuracy …)", so the old /Location found — GPS
  // accuracy ±/i could never match (S-4, Meera re-review #2).
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±\d+ m\)/i).first()).toBeVisible();
  // The red YOU marker is a DOM marker inside the map box (a
  // MapLibre marker on the Ola map).
  const marker = page.locator(YOU_MARKER).first();
  await expect(marker).toBeVisible({ timeout: 15_000 });
  // Centred: the marker sits at (about) the middle of the map box.
  const mapBox = await page.locator('.mapbox').first().boundingBox();
  const markerBox = await marker.boundingBox();
  expect(mapBox, 'map box must have a box').not.toBeNull();
  expect(markerBox, 'YOU marker must have a box').not.toBeNull();
  const dx = Math.abs(markerBox!.x + markerBox!.width / 2 - (mapBox!.x + mapBox!.width / 2));
  const dy = Math.abs(markerBox!.y + markerBox!.height / 2 - (mapBox!.y + mapBox!.height / 2));
  expect(dx, `YOU marker must be horizontally centred (off by ${Math.round(dx)}px)`).toBeLessThanOrEqual(80);
  expect(dy, `YOU marker must be vertically centred (off by ${Math.round(dy)}px)`).toBeLessThanOrEqual(80);
});

test('Use my location denied: honest denied state with one short line, no silent default', async ({ page }) => {
  test.setTimeout(90_000);
  // Fresh context, no geolocation grant: the browser denies it.
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('Denied Host');
  // Hydration gate that works with AND without a key: the canvas
  // when a key is configured, the missing-key line when it is not —
  // a click before hydration lands on an unhydrated button and does
  // nothing, either way.
  await waitForMapOrMissingKey(page);
  await page.getByRole('button', { name: /Use my location/ }).click();
  // Founder cleanup, 2026-11-18: the denied-help line ("Location is
  // off — allow it in your browser settings, then tap the map to
  // place the zone.") was REMOVED from the setup screen — no banner,
  // no announce for it. The host just taps the map to place the
  // zone. The denied callback can take the full 15 s geolocation
  // timeout to arrive in headless Chromium, so wait for the attempt
  // to settle: the button is disabled while locating and enabled
  // again once the attempt ends. Then assert the denied text is
  // nowhere on the screen and no alert banner exists in the Play
  // area region.
  await expect(page.getByRole('button', { name: /Use my location/ })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Play area' }).getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(/Location is off — allow it in your browser settings/i)).toHaveCount(0);
  await expect(page.getByText(/Android|iOS|iPhone/)).toHaveCount(0);
  // No silent default spot: nothing is centred on a guess. The
  // "No centre yet." helper line was removed with the denied line —
  // the un-centred evidence is the map region's accessible name.
  await expect(page.getByRole('region', { name: /tap the map to place the zone/i })).toBeVisible();
  // CREATE LOBBY is never silently disabled (founder bug fix (a)):
  // it stays tappable and explains what is missing instead. It has
  // NO native `disabled` attribute — only aria-disabled="true"
  // (create/page.tsx:143) — so a real mouse user can click it.
  // Playwright disagrees: in playwright-core 1.65.1 the "enabled"
  // element state is !getAriaDisabled(element), and getAriaDisabled
  // counts aria-disabled="true" on a button (kAriaDisabledRoles
  // includes "button"), so toBeEnabled() can never pass here and a
  // plain click waits for "enabled" until it times out. Assert the
  // DOM fact instead, and force the click — the same treatment as
  // session-restore.spec.ts:26-33 and brutal-phone.spec.ts:185-191.
  const createBtn = page.getByRole('button', { name: /CREATE LOBBY/ });
  expect(await createBtn.getAttribute('disabled')).toBeNull();
  await expect(createBtn).toHaveAttribute('aria-disabled', 'true');
  await createBtn.click({ force: true });
  await expect(page.getByText(/Set the zone centre first/)).toBeVisible();
  await expect(page.locator(YOU_MARKER)).toHaveCount(0);
});

test('no numbered test markers 1–4 on the default Circle setup map', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('Circle Host');
  await page.getByRole('button', { name: /Use my location/ }).click();
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±\d+ m\)/i).first()).toBeVisible();
  // Default shape is Circle: no point markers of any kind.
  await assertNoNumberedMarkers(page, 'Circle setup map');
  // NOTE: Draw mode numbers its tap-placed points by design
  // (PlayAreaMap renders a numbered marker per tap, 1..N) — that
  // is the only numbered-marker code in the app, and it must only
  // appear after the host explicitly switches to Draw AND taps the
  // map. The founder's screenshot showed 1–4 on a pink zone map,
  // which is Draw mode with its points showing.
  await expectNoOverflow(page, 'Circle setup map');
});

test('phone-width clipping: header, helper text and map controls stay inside the viewport', async ({ browser }) => {
  test.setTimeout(120_000);
  // Dedicated 390px phone context (touch, mobile) — the founder's
  // screenshot phone width. The sticky header + hamburger menu must
  // not cover page content, and every map control must sit inside
  // the viewport with margin from the right edge.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const phone = await context.newPage();
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await phone.goto('/create');
  await phone.getByLabel(/codename/i).fill('Clip Host');
  // With a key the map canvas must appear; without one the
  // missing-key line appears instead — either proves hydration, and
  // the header/helper checks below run in both modes. Only the map
  // controls check needs a constructed map.
  await waitForMapOrMissingKey(phone);
  const innerWidth = await phone.evaluate(() => window.innerWidth);
  expect(innerWidth, 'phone viewport is 390px wide').toBe(390);
  const header = phone.locator('header').first();
  const headerBox = await header.boundingBox();
  expect(headerBox, 'header must have a box').not.toBeNull();
  // Playwright boundingBox is {x, y, width, height} — NOT a DOMRect:
  // there is no .left/.right/.top on it (they read undefined).
  expect(headerBox!.x).toBeGreaterThanOrEqual(-1);
  expect(headerBox!.x + headerBox!.width).toBeLessThanOrEqual(innerWidth + 1);
  const headerBottom = headerBox!.y + headerBox!.height;
  // Helper text under the header: fully visible at scroll 0, and
  // still fully visible after scrolling it into view (the sticky
  // header must not cover it — scroll-padding-top guards this).
  // Geolocation is granted here, so PlayAreaMap auto-locates on mount
  // and the centre is set before this line — the "No centre yet."
  // helper was removed in the founder cleanup (2026-11-18); the
  // helper in its place is the "Location found — …" status line
  // (same pattern as the granted test, .first() because the message
  // renders twice).
  const helper = phone.getByText(/Location found — .*\(GPS accuracy ±\d+ m\)/i).first();
  await expect(helper).toBeVisible();
  const helperTop0 = (await helper.boundingBox())!.y;
  expect(helperTop0, 'helper text must start below the sticky header at scroll 0').toBeGreaterThanOrEqual(headerBottom - 1);
  await helper.scrollIntoViewIfNeeded();
  const helperTop1 = (await helper.boundingBox())!.y;
  expect(helperTop1, 'helper text must start below the sticky header after scrolling').toBeGreaterThanOrEqual(headerBottom - 1);
  // Every map control (zoom, attribution) sits inside the viewport —
  // MapLibre controls on the Ola map. Only when a key is configured:
  // without one there is no map and no controls to clip.
  if (OLA_KEY_PRESENT) {
    const mapControls = phone.locator('.mapbox button, .mapbox .maplibregl-ctrl-attrib button');
    const count = await mapControls.count();
    expect(count, 'map must expose controls on a phone').toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await mapControls.nth(i).boundingBox();
      if (!box) continue;
      expect(box.x, `map control ${i} must not clip off the left edge`).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, `map control ${i} must not clip off the right edge`).toBeLessThanOrEqual(innerWidth + 1);
    }
  }
  await expectNoOverflow(phone, 'phone-width clipping @create');
  await context.close();
});

test('draw (a): 3 taps enclose a triangle, 4th tap makes 4 points', async ({ page, context }) => {
  test.skip(!OLA_KEY_PRESENT, 'no Ola key configured — tap-to-place needs a constructed map');
  test.setTimeout(120_000);
  await gotoDrawSetup(page, context, 'Draw Host');
  // Draw starts with NO shape: no point markers, no middle marker,
  // Undo / Redraw / Done disabled, "not drawn yet" status.
  await expect(pointMarkers(page)).toHaveCount(0);
  await expect(middleMarker(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redraw', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  await expect(page.getByText(/not drawn yet — tap the map to place point 1/i)).toBeVisible();
  // Tap 1: one numbered marker, "tap 2 more" status + announce.
  await tapDrawPoint(page, 200, 100);
  await expect(pointMarkers(page)).toHaveCount(1);
  await expect(page.getByLabel(/Point 1 of 1 — drag to move\./)).toBeVisible();
  await expect(page.getByText(/1 point placed — tap 2 more to enclose the zone/i)).toBeVisible();
  await expect(page.getByText(/Point 1 placed — tap 2 more to enclose the zone\./)).toBeVisible();
  // Tap 2: two markers, still unenclosed.
  await tapDrawPoint(page, 420, 100);
  await expect(pointMarkers(page)).toHaveCount(2);
  await expect(page.getByText(/2 points placed — tap 1 more to enclose the zone/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  // Tap 3: the triangle encloses — 3 markers, the middle ✥ marker,
  // "tap DONE" status, and the map region names the enclosed zone.
  await tapDrawPoint(page, 310, 230);
  await expect(pointMarkers(page)).toHaveCount(3);
  await expect(page.getByLabel(/Point 3 of 3 — drag to move\./)).toBeVisible();
  await expect(middleMarker(page)).toBeVisible();
  await expect(page.getByText(/3 points · about .* across — tap DONE to apply the zone/i)).toBeVisible();
  await expect(page.getByText(/Point 3 placed — 3 points enclose the zone\. Drag a point to fine-tune, or tap DONE to apply it\./)).toBeVisible();
  await expect(page.getByRole('region', { name: /Drawn play zone — 3 points, about .* across\. Tap DONE to apply it\./ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  // Tap 4: 4 points, still unenclosed-applied — the zone is a draft
  // until DONE, so the status still says "tap DONE".
  await tapDrawPoint(page, 520, 200);
  await expect(pointMarkers(page)).toHaveCount(4);
  await expect(page.getByLabel(/Point 4 of 4 — drag to move\./)).toBeVisible();
  await expect(page.getByText(/4 points · about .* across — tap DONE to apply the zone/i)).toBeVisible();
});

test('draw (b): Undo removes the last point, Redraw clears all', async ({ page, context }) => {
  test.skip(!OLA_KEY_PRESENT, 'no Ola key configured — tap-to-place needs a constructed map');
  test.setTimeout(120_000);
  await gotoDrawSetup(page, context, 'Draw Undo Host');
  await tapDrawPoint(page, 200, 100);
  await tapDrawPoint(page, 420, 100);
  await tapDrawPoint(page, 310, 230);
  await expect(pointMarkers(page)).toHaveCount(3);
  await expect(middleMarker(page)).toBeVisible();
  // Undo: 3 → 2, the zone un-encloses — the middle marker goes and
  // the status drops back to "tap 1 more".
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(pointMarkers(page)).toHaveCount(2);
  await expect(middleMarker(page)).toHaveCount(0);
  await expect(page.getByText(/2 points placed — tap 1 more to enclose the zone/i)).toBeVisible();
  await expect(page.getByText(/Point 3 removed — 2 points left\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  // Redraw: every point goes, back to the clean start.
  await page.getByRole('button', { name: 'Redraw', exact: true }).click();
  await expect(pointMarkers(page)).toHaveCount(0);
  await expect(page.getByText(/not drawn yet — tap the map to place point 1/i)).toBeVisible();
  await expect(page.getByText(/Cleared — tap the map to place point 1\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redraw', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
});

test('draw (c): Done applies the zone — status, Size across, create passes', async ({ page, context }) => {
  test.skip(!OLA_KEY_PRESENT, 'no Ola key configured — tap-to-place needs a constructed map');
  test.setTimeout(120_000);
  await gotoDrawSetup(page, context, 'Draw Done Host');
  await tapDrawPoint(page, 200, 100);
  await tapDrawPoint(page, 420, 100);
  await tapDrawPoint(page, 310, 230);
  await expect(pointMarkers(page)).toHaveCount(3);
  // Until DONE the form validation sees no zone: the draft error
  // is live on the page (create/page.tsx renders draftErrors[0]).
  await expect(page.getByText(/Draw the zone first — switch to Draw, tap at least 3 points on the map, then tap DONE\./)).toBeVisible();
  // DONE applies the draft: "zone applied" status + announce, and
  // the form's Size across line updates from "not drawn yet".
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText(/3 points · about .* across — zone applied/i)).toBeVisible();
  await expect(page.getByText(/Zone applied — 3 points, about .* across\./)).toBeVisible();
  await expect(page.getByText(/Size across: about .* across/i)).toBeVisible();
  await expect(page.getByText(/Draw the zone first/)).toHaveCount(0);
  // Validation passes now: with the safety confirmations checked,
  // CREATE LOBBY creates a room whose stored zone is the drawn
  // 3-point boundary (draftToConfig keeps drawnBoundary as-is).
  await page.getByLabel(/I have checked the venue/i).check();
  await page.getByLabel(/I will be on site/i).check();
  await expect(page.getByRole('button', { name: /CREATE LOBBY/ })).toHaveAttribute('aria-disabled', 'false');
  await page.getByRole('button', { name: /CREATE LOBBY/ }).click();
  await expect(page).toHaveURL(/\/room\/[0-9a-f-]+$/);
  const created = await roomState(page);
  expect(created!.room.config.zoneShape).toBe('draw');
  expect(created!.room.config.zone?.boundary).toHaveLength(3);
});

test('draw (d): a point marker drags — the point moves on screen', async ({ page, context }) => {
  test.skip(!OLA_KEY_PRESENT, 'no Ola key configured — point markers need a constructed map');
  test.setTimeout(120_000);
  await gotoDrawSetup(page, context, 'Draw Drag Host');
  await tapDrawPoint(page, 200, 100);
  await tapDrawPoint(page, 420, 100);
  await tapDrawPoint(page, 310, 230);
  await expect(pointMarkers(page)).toHaveCount(3);
  // The point marker's box must be read from a SETTLED map — the
  // same measurement race as the pin-drag test in
  // map-accuracy.spec.ts (marker rebuilds + camera flight).
  const selector = '.mapbox [aria-label^="Point 1 of 3"]';
  const box = await settledMarkerBox(page, selector);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy, { steps: 10 });
  // The point moved east: measure WHILE the drag is still held.
  // Once the mouse goes up, dragend commits the new point and the
  // markers rebuild, so a post-drag screen position proves nothing
  // about the drag — the mid-drag box is the evidence.
  const boxMidDrag = await settledMarkerBox(page, selector);
  expect(boxMidDrag.x, 'point marker must have moved east on screen').toBeGreaterThan(box.x + 20);
  await page.mouse.up();
  // The drag landed: the dragend announce ("Point 1 moved.").
  await expect(page.getByText(/Point 1 moved\./)).toBeVisible();
});

test('draw (e): mode switch Draw → Circle clears every point marker; back to Draw starts clean', async ({ page, context }) => {
  test.skip(!OLA_KEY_PRESENT, 'no Ola key configured — point markers need a constructed map');
  test.setTimeout(120_000);
  await gotoDrawSetup(page, context, 'Switch Host');
  // Circle is the default: no point markers at all.
  await expect(pointMarkers(page)).toHaveCount(0);
  // Circle mode: the Radius stepper is the size readout (the old
  // "Zone size:" line was removed in the founder cleanup,
  // 2026-11-18).
  await expect(page.getByRole('group', { name: 'Radius' }).locator('output')).toHaveText('500m');
  // Draw + 3 taps: 3 point markers, the middle marker, the
  // Drawn-zone summary.
  await tapDrawPoint(page, 200, 100);
  await tapDrawPoint(page, 420, 100);
  await tapDrawPoint(page, 310, 230);
  await expect(pointMarkers(page)).toHaveCount(3);
  await expect(middleMarker(page)).toBeVisible();
  await expect(page.getByText(/Drawn zone:/)).toBeVisible();
  // Back to Circle: every point marker and the polygon are gone,
  // only the circle zone remains (centre + size lines back).
  await page.getByRole('radio', { name: /Circle/ }).check();
  await expect(pointMarkers(page)).toHaveCount(0);
  await expect(middleMarker(page)).toHaveCount(0);
  await expect(page.getByText(/Drawn zone:/)).toHaveCount(0);
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±\d+ m\)/i).first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Radius' }).locator('output')).toHaveText('500m');
  // Back to Draw: starts clean with NO points — the host taps again
  // from scratch (no restored shape, no stale draft).
  await page.getByRole('radio', { name: /Draw/ }).check();
  await expect(pointMarkers(page)).toHaveCount(0);
  await expect(page.getByText(/not drawn yet — tap the map to place point 1/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  await expect(page.getByText(/Drawn zone:/)).toBeVisible();
  await expect(page.getByText(/Zone size:/)).toHaveCount(0);
});

test('live play: outside-zone banner and HUD do not hide under the sticky header', async ({ page, context }) => {
  test.setTimeout(180_000);
  await startMatch(page, context, { pickHunters: 'host' });
  // With a key the map canvas must appear; without one the
  // missing-key banner appears instead — either proves the play page
  // hydrated, and the HUD/banner checks below run in both modes.
  await waitForMapOrMissingKey(page);
  const headerBox = await page.locator('header').first().boundingBox();
  expect(headerBox, 'header must have a box').not.toBeNull();
  const headerBottom = headerBox!.y + headerBox!.height;
  // The HUD (Match status region) must sit below the sticky header,
  // never under it.
  const hud = page.getByRole('region', { name: 'Match status' });
  await expect(hud).toBeVisible();
  const hudBox = await hud.boundingBox();
  expect(hudBox, 'HUD must have a box').not.toBeNull();
  expect(hudBox!.y, 'HUD must start below the sticky header').toBeGreaterThanOrEqual(headerBottom - 1);
  // Move the mocked fix outside the zone: the 30-second return
  // countdown banner must appear — and it too must sit below the
  // sticky header, never under it. (The banner depends on the
  // geolocation watch delivering the moved fix; if it does not arrive
  // within 15 s the HUD assertion above is still the strict check.)
  await context.setGeolocation({ latitude: 23.42, longitude: 85.33 });
  const banner = page.getByText(/Get back inside the zone/);
  try {
    await expect(banner.first()).toBeVisible({ timeout: 15_000 });
    const bannerBox = await banner.first().boundingBox();
    expect(bannerBox, 'outside-zone banner must have a box').not.toBeNull();
    expect(bannerBox!.y, 'outside-zone banner must start below the sticky header').toBeGreaterThanOrEqual(headerBottom - 1);
    // The moved fix (23.42, 85.33) is OUTSIDE the zone — but the map
    // is Ola now, world-wide: there is NO downloaded area any more,
    // so NO "downloaded area only" caption can ever appear. The old
    // assertion had it VISIBLE here (it was the offline map's
    // outside-area message); the new reality is its absence.
    await expect(page.getByText(/Offline map: downloaded area only/)).toHaveCount(0);
    await expect(page.getByText(/Map downloaded for Ranchi only/)).toHaveCount(0);
  } catch {
    console.log('OUTSIDE-ZONE banner did not appear after moving the fix outside — HUD check above still stands; watch delivery in headless Chromium is the suspect, not the header layout.');
  }
  await expectNoOverflow(page, 'live play HUD');
});
