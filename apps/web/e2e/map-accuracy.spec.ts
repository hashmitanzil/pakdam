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
  // The rough-fix line is rendered TWICE — the banner alert AND the
  // polite announce line with the same text (PlayAreaMap.tsx: the
  // banner is <div role="alert">, the announce is a plain
  // <p aria-live="polite">) — so a bare getByText violates strict
  // mode. Scope to the banner inside the Play area region. (The
  // setup is already right: the staged chain rejects the 2.5 km fix
  // with this line — geolocation.ts LOCATION_TIMEOUT_HELP /
  // coarseFixMessage — the CI failure was the duplicate, not a
  // missing message.)
  const roughBanner = page.getByRole('region', { name: 'Play area' }).getByRole('alert');
  await expect(roughBanner).toBeVisible({ timeout: 30_000 });
  await expect(roughBanner).toContainText(/GPS is too rough here — tap the map to place the zone/i);
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
  // "GPS accuracy ±8 m" alone matches THREE lines (status line, the
  // "GPS fix — …" line, the announce line — PlayAreaMap.tsx), so the
  // bare pattern violated strict mode. The "Location found — …
  // (GPS accuracy ±8 m)" shape below is unique: the announce has no
  // parens and the "GPS fix" line has no "Location found". It
  // replaces both the loose line and the .first() line that followed.
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±8 m\)/i)).toBeVisible({ timeout: 15_000 });
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
  // The map must be up before the pin is measured: the "Location
  // found" line can land before MapLibre finishes loading (the mocked
  // fix arrives fast, the map script/style take longer), and the pin
  // only exists once the map loads — the marker is built by
  // syncOverlays on map 'load' (PlayAreaMap.tsx).
  await expect(page.locator('.mapbox .maplibregl-canvas').first()).toBeVisible({ timeout: 30_000 });
  const pin = page.locator('.mapbox .maplibregl-marker').first();
  await expect(pin).toBeVisible({ timeout: 15_000 });
  // The pin's box must be read from a SETTLED map. PlayAreaMap
  // rebuilds every marker on each render (syncOverlays removes +
  // recreates them, PlayAreaMap.tsx), and fitToZone flies the camera
  // to the zone on load (fitBounds without `linear` uses flyTo, per
  // the vendored MapLibre), so a single-shot boundingBox() taken the
  // instant the pin first appears can catch the element mid-swap and
  // return null — the dbfaffd failure (line 95, right after
  // toBeVisible passed). The pin DOES render: toBeVisible passed on
  // both projects, and the identical pattern passes in the map-tiles
  // "YOU marker" test — this is a measurement race, not a render
  // defect. Read the box in the page, atomically, until two reads
  // 200 ms apart agree: that proves the camera flight is done and no
  // marker swap is in flight.
  const settledPinBox = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
    const deadline = Date.now() + 30_000;
    let prev: { x: number; y: number; width: number; height: number } | null = null;
    while (Date.now() <= deadline) {
      const cur = await page.evaluate((): { x: number; y: number; width: number; height: number } | null => {
        const el = document.querySelector('.mapbox .maplibregl-marker');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      });
      if (cur && prev && Math.abs(cur.x - prev.x) < 1 && Math.abs(cur.y - prev.y) < 1) return cur;
      prev = cur;
      await page.waitForTimeout(200);
    }
    throw new Error(`centre pin box never settled (last: ${JSON.stringify(prev)})`);
  };
  const box = await settledPinBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy, { steps: 10 });
  // The pin moved east: measure WHILE the drag is still held. Once
  // the mouse goes up, dragend reports the new centre and fitToZone
  // flies the camera back to the zone, so a post-drag screen position
  // proves nothing about the drag — the mid-drag box is the evidence.
  const boxMidDrag = await settledPinBox();
  expect(boxMidDrag.x, 'pin must have moved east on screen').toBeGreaterThan(box.x + 20);
  await page.mouse.up();
  // The drag landed: the dragend announce plus the hand-placed label
  // (centreSource 'placed') — no numbers shown.
  await expect(page.getByText(/Centre pin dragged to your exact spot/)).toBeVisible();
  await expect(page.getByText(/Placed by hand on the map/)).toBeVisible();
});
