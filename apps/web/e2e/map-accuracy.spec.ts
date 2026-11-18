// Map accuracy e2e — TEXT/DOM assertions only, no screenshots.
// Founder rules (2026-11-17):
// - GPS itself cannot be 100%: outdoors ~5–10 m, indoors much worse.
//   Exactness comes from a MANUAL fallback the host controls: tap the
//   map to set the centre, drag the centre pin. No coordinates are
//   shown anywhere (founder rule, 2026-11-17) — the centre reads
//   "placed by hand", never numbers.
// - NEVER auto-centre a zone on a fix worse than ±50 m. A coarser fix
//   is rejected with the one short line "GPS is too rough here — tap
//   the map to place the zone." (simplification §5b, 2026-11-18 — the
//   old "GPS is off by ~X km — too coarse…" message is gone) and the
//   zone stays un-centred — never a default spot.
// - "Use my location" refines as GPS locks (live best-accuracy readout)
//   and GPS accuracy in metres is shown at all times.
// - The old "Zone centre: set …" / "Zone centre: not set yet" status
//   lines were removed in simplification §5c. Centre-set evidence
//   now is the "Location found — … (GPS accuracy ±N m)" status line
//   (GPS fix) or the "Placed by hand on the map" line (hand-placed);
//   the un-centred state reads "No centre yet."
//
// RECONSTRUCTED 2026-11-17: this file was truncated to 0 bytes by the
// VM's EPERM write flapping and rebuilt from the run-2 Playwright
// error-context source windows (lines 1–87, verbatim) with the
// known-broken assertions fixed: the `Zone centre:` locator now
// matches the full line (`getByText(/Zone centre: set …/)`) instead
// of the bare `<strong>` (which made every toContainText fail), and
// the coarse-message regex now matches the real message text
// ("— too coarse to centre the zone on", not "— drag the pin").
import { test, expect } from '@playwright/test';

test('coarse GPS (±2.5 km) never centres the zone — km message, manual pin fallback', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33, accuracy: 2500 });
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('Test Host');
  // Auto-locate on load waits for a good fix; the staged location
  // chain rejects the 2.5 km fix with the one short line (the
  // chain short-circuits when consecutive methods return the same
  // coarse fix, so the message lands in ~12 s, well inside 30 s).
  await expect(page.getByText(/GPS is too rough here — tap the map to place the zone/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/No centre yet/)).toBeVisible();
  // Manual fallback: tap the map to place the zone by hand. Wait for
  // the map canvas first (hydration gate — a tap before MapLibre
  // mounts lands on an empty container and places nothing).
  await expect(page.locator('.mapbox .maplibregl-canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('.mapbox').click({ position: { x: 180, y: 160 } });
  await expect(page.getByText(/No centre yet/)).toHaveCount(0);
  await expect(page.getByText(/Placed by hand on the map/)).toBeVisible();
});

test('"Use my location" refines live — best accuracy shown while waiting, then the good fix lands', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33, accuracy: 5000 });
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('Test Host');
  // Still refining: the coarse 5 km fix is the best seen so far.
  await expect(page.getByText(/Best fix so far: ±5000 m — still refining/i)).toBeVisible({ timeout: 15_000 });
  // GPS locks: accuracy 8 m — the good fix centres the zone.
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33, accuracy: 8 });
  await expect(page.getByText(/GPS accuracy ±8 m/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±8 m\)/i).first()).toBeVisible();
});

test('centre pin can be moved by hand — arrow keys move the centre (no coordinates shown)', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33, accuracy: 8 });
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('Test Host');
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±8 m\)/i).first()).toBeVisible();
  // Arrow keys move the centre ~55 m per press — the hand-placed
  // position is exact, and the panel says so without showing numbers.
  // Focus the map region (a click would move the centre first, so
  // focus without clicking).
  await page.locator('.mapbox').focus();
  await page.keyboard.press('ArrowUp');
  // Arrow keys move the centre by hand without an announce line —
  // the evidence is the hand-placed label plus the Zone size line.
  await expect(page.getByText(/Zone size:/)).toBeVisible();
  await expect(page.getByText(/Placed by hand on the map/)).toBeVisible();
});

test('centre pin drags — dragging the red pin moves the zone centre', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33, accuracy: 8 });
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('Test Host');
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±8 m\)/i).first()).toBeVisible();
  const pin = page.locator('.mapbox .maplibregl-marker').first();
  await expect(pin).toBeVisible();
  const box = await pin.boundingBox();
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy, { steps: 10 });
  await page.mouse.up();
  // The pin moved east: its on-screen position moved right, and the
  // panel now says the centre is hand-placed — no numbers shown.
  const boxAfter = await pin.boundingBox();
  expect(boxAfter).not.toBeNull();
  expect(boxAfter!.x, 'pin must have moved east on screen').toBeGreaterThan(box!.x + 20);
  await expect(page.getByText(/Centre pin dragged to your exact spot/)).toBeVisible();
  await expect(page.getByText(/Placed by hand on the map/)).toBeVisible();
});
