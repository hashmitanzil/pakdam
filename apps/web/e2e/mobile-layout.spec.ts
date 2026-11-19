// Mobile layout e2e — TEXT/DOM assertions only, no screenshots.
// Runs on every project (desktop / tablet / phone 360 portrait +
// landscape / 130% zoom). Checks: no horizontal overflow on the key
// screens, tap-target sizes for the primary actions (>= 44px), the
// thumb-zone primary action reachable at the bottom of the play
// screen, and the sticky CREATE LOBBY bar.
// The 130%-zoom check is a layout-equivalent viewport: at 130% zoom
// a 360px phone lays out at 360/1.3 = 277 CSS px, which is the
// mobile-zoom130 project's viewport.
import { test, expect } from '@playwright/test';
import { expectNoOverflow, overflowProbe, startMatch } from './helpers';

/** All visible buttons smaller than 44px tall, for the audit log. */
async function smallTapTargets(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('button')) {
      const r = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (r.height < 44) {
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 36);
        out.push(`"${label}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  });
}

test('mobile: landing, create and join have no horizontal overflow', async ({ page }) => {
  for (const route of ['/', '/create', '/join']) {
    await page.goto(route);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expectNoOverflow(page, route);
  }
  // Hero primary actions are big enough to tap.
  await page.goto('/');
  const hostCta = page.getByRole('link', { name: /Host a Game/ }).first();
  const hostBox = await hostCta.boundingBox();
  expect(hostBox, 'Host a Game CTA must have a box').not.toBeNull();
  expect(hostBox!.height).toBeGreaterThanOrEqual(44);
});

test('mobile: host setup fits — steppers usable, sticky CREATE LOBBY reachable', async ({ page, context }) => {
  test.setTimeout(60_000);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('Mobile Host');
  await page.getByRole('button', { name: /Use my location/ }).click();
  // The old "Zone centre: set" status line was removed in the
  // simplification round (§5c) — the centre-set evidence now is
  // the "Location found — … (GPS accuracy ±N m)" status line.
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±\d+ m\)/i).first()).toBeVisible();
  await expectNoOverflow(page, '/create (top)');

  // Stepper buttons are tappable and change the value. The setup
  // form's zone stepper is "Radius" (HostSetupForm.tsx — the old
  // "Zone size" stepper is gone; the Radius display is the compact
  // radius, formatRadiusCompact: 500m -> 550m on one + tap).
  await page.getByRole('button', { name: /Increase Radius/ }).click();
  await expect(page.getByRole('group', { name: 'Radius' }).locator('output')).toHaveText('550m');
  await expectNoOverflow(page, '/create (after stepper)');

  // Sticky bar: CREATE LOBBY stays in the viewport at the bottom even
  // after scrolling to the end of the long setup screen.
  await page.getByLabel(/I have checked the venue/i).check();
  await page.getByLabel(/I will be on site/i).check();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const createBtn = page.getByRole('button', { name: /CREATE LOBBY/ });
  await expect(createBtn).toBeVisible();
  const box = await createBtn.boundingBox();
  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(box, 'CREATE LOBBY must be visible without scrolling back up').not.toBeNull();
  // boundingBox() is {x, y, width, height} — there is no .bottom, so
  // the button's bottom edge is y + height.
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight + 1);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(200);
});

test('mobile: lobby + play fit, thumb-zone primary action is reachable', async ({ page, context }) => {
  test.setTimeout(180_000);
  const { roomId } = await startMatch(page, context, { pickHunters: 'host' });
  await expectNoOverflow(page, `/room/${roomId}/play`);

  // Bottom tabs fit and switch views.
  const tabs = page.getByRole('tablist', { name: 'Match view' });
  await expect(tabs).toBeVisible();
  await page.getByRole('tab', { name: 'Radar' }).click();
  await expect(page.getByRole('heading', { name: /Compass radar/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Map' }).click();
  await expectNoOverflow(page, 'play (radar back to map)');

  // Thumb zone: the primary action sits at the bottom of the screen
  // and is >= 44px tall — reachable by thumb without hunting.
  const thumb = page.locator('.thumb-zone');
  await thumb.scrollIntoViewIfNeeded();
  const catchBtn = thumb.getByRole('button', { name: /Catch — pick a Runner/ });
  await expect(catchBtn).toBeVisible();
  const box = await catchBtn.boundingBox();
  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(box, 'thumb-zone Catch button must have a box').not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  // boundingBox() is {x, y, width, height} — no .bottom/.top.
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight + 1);
  expect(box!.y).toBeGreaterThan(viewportHeight * 0.5);
  await expectNoOverflow(page, 'play (thumb zone in view)');
});

test('mobile: tap-target audit — primaries >= 44px; log everything smaller', async ({ page, context }) => {
  test.setTimeout(180_000);
  // Audit on the two densest screens: host setup and the live game.
  await page.goto('/create');
  const createSmall = await smallTapTargets(page);
  console.log(`TAP-TARGETS /create (<44px tall): ${createSmall.length ? createSmall.join(' | ') : 'none'}`);

  await startMatch(page, context, { pickHunters: 'host' });
  const playSmall = await smallTapTargets(page);
  console.log(`TAP-TARGETS /play (<44px tall): ${playSmall.length ? playSmall.join(' | ') : 'none'}`);

  // Nothing interactive may be unusably small (< 24px tall).
  const tiny = [...createSmall, ...playSmall].filter((s) => /x(1\d|2[0-3])$/.test(s));
  expect(tiny, `unusable tap targets (<24px tall): ${tiny.join(' | ')}`).toEqual([]);

  // The audit itself is reported, not failed, for 24–43px controls:
  // record how many sit below the 44px guidance so the report can
  // name them instead of hiding them behind a pass.
  test.info().annotations.push({
    type: 'tap-targets-under-44px',
    description: `/create: ${createSmall.length} — ${createSmall.join(' | ') || 'none'}; /play: ${playSmall.length} — ${playSmall.join(' | ') || 'none'}`,
  });
  const probe = await overflowProbe(page);
  expect(probe.overflowing, `play overflow: ${probe.offenders.join(' | ')}`).toBe(false);
});

test('zoom130: key screens fit a 277px layout viewport (360px at 130% zoom)', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 999) > 320, 'only the mobile-zoom130 project has a 300px viewport');
  for (const route of ['/', '/create', '/join']) {
    await page.goto(route);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expectNoOverflow(page, `${route} @130% zoom`);
  }
  // Host setup at 130% zoom: the CREATE LOBBY bar must still be usable.
  await page.goto('/create');
  const createBtn = page.getByRole('button', { name: /CREATE LOBBY/ });
  await expect(createBtn).toBeVisible();
  const box = await createBtn.boundingBox();
  expect(box, 'CREATE LOBBY must have a box at 130% zoom').not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
