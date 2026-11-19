// Responsive e2e — TEXT/DOM assertions only, no screenshots.
// Runs on every project (desktop 1280 / tablet 768 / phone 360
// portrait + landscape / 130% zoom). Checks per route + width:
// no horizontal overflow (document.scrollWidth <= innerWidth),
// no clipped primary buttons, and the play tab bar fits without
// overflowing on narrow screens. Per-route measurements are logged
// as OVERFLOW lines so the report can tabulate them.
import { test, expect } from '@playwright/test';
import { expectNoOverflow, overflowProbe, startMatch } from './helpers';

const KEY_ROUTES = [
  '/', '/create', '/join', '/host',
  '/leaderboards',
];

test('responsive: key routes have no horizontal overflow at this width', async ({ page }) => {
  const size = page.viewportSize();
  const width = size?.width ?? 0;
  for (const route of KEY_ROUTES) {
    await page.goto(route);
    await expect(page.getByRole('heading').first()).toBeVisible();
    const probe = await overflowProbe(page);
    console.log(
      `OVERFLOW route=${route} width=${width} scrollWidth=${probe.scrollWidth} innerWidth=${probe.innerWidth} overflow=${probe.overflowing} offenders=${probe.offenders.join(' | ') || 'none'}`,
    );
    await expectNoOverflow(page, `${route} @${width}px`);
  }
});

test('responsive: primary buttons are not clipped at this width', async ({ page }) => {
  const size = page.viewportSize();
  const width = size?.width ?? 0;
  for (const route of KEY_ROUTES) {
    await page.goto(route);
    await expect(page.getByRole('heading').first()).toBeVisible();
    const clipped = await page.evaluate(() => {
      const bad: string[] = [];
      const innerWidth = window.innerWidth;
      for (const el of document.querySelectorAll('a.btn, button.btn')) {
        const r = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
        if (r.left < -1 || r.right > innerWidth + 1) {
          const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
          bad.push(`"${label}" left=${Math.round(r.left)} right=${Math.round(r.right)}`);
        }
      }
      return bad;
    });
    expect(clipped, `${route} @${width}px: clipped primary buttons: ${clipped.join(' | ')}`).toEqual([]);
  }
});

test('responsive: hamburger menu on phones, tab row on desktop', async ({ page }) => {
  const size = page.viewportSize();
  const width = size?.width ?? 0;
  const isPhone = width < 768;
  await page.goto('/join');
  await expect(page.getByRole('heading').first()).toBeVisible();

  if (!isPhone) {
    // Desktop/tablet: normal tab row, no hamburger button.
    await expect(page.locator('.menu-button')).toBeHidden();
    await expect(page.locator('.topbar-nav')).toBeVisible();
    await expect(page.locator('#mobile-menu')).toHaveCount(0);
    return;
  }

  // Phone: tab row hidden, hamburger visible, header is one row.
  await expect(page.locator('.topbar-nav')).toBeHidden();
  const menuButton = page.locator('.menu-button');
  await expect(menuButton).toBeVisible();
  await expect(menuButton).toHaveAccessibleName('Open menu');
  await expect(page.locator('#mobile-menu')).toHaveCount(0);

  // Open: full menu with every section, current section highlighted.
  await menuButton.click();
  const menu = page.locator('#mobile-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('heading', { name: 'Play' })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Host a Game' }).first()).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Join a Game' })).toBeVisible();
  const current = menu.locator('a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText('Join a Game');

  // Escape closes and returns focus to the hamburger button.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(menuButton).toBeFocused();
  await expect(menuButton).toHaveAccessibleName('Open menu');

  // Backdrop tap closes (tap the far left, outside the right-side panel).
  await menuButton.click();
  await expect(menu).toBeVisible();
  await page.locator('.mobile-menu-backdrop').click({ position: { x: 5, y: 200 } });
  await expect(menu).toHaveCount(0);

  // Following a link navigates and closes the menu.
  await menuButton.click();
  await expect(menu).toBeVisible();
  await menu.getByRole('link', { name: 'Host a Game' }).first().click();
  await expect(page).toHaveURL(/\/create\/mode/);
  await expect(menu).toHaveCount(0);
  await expectNoOverflow(page, `/create/mode @${width}px (after menu navigation)`);
});

test('responsive: live play page fits — tab bar fits, thumb zone reachable', async ({ page, context }) => {
  test.setTimeout(180_000);
  const size = page.viewportSize();
  const width = size?.width ?? 0;
  const { roomId } = await startMatch(page, context, { pickHunters: 'host' });

  // The Map / Radar / Radio / More bar: every tab inside the viewport,
  // and the bar itself does not scroll horizontally.
  const tabs = page.getByRole('tablist', { name: 'Match view' });
  await expect(tabs).toBeVisible();
  const tabMetrics = await page.evaluate(() => {
    const bar = document.querySelector('[role="tablist"]') as HTMLElement | null;
    if (!bar) return null;
    const buttons = [...bar.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { label: (b.textContent ?? '').trim(), left: Math.round(r.left), right: Math.round(r.right) };
    });
    return { barScroll: bar.scrollWidth, barClient: bar.clientWidth, innerWidth: window.innerWidth, buttons };
  });
  expect(tabMetrics, 'tab bar must exist').not.toBeNull();
  expect(
    tabMetrics!.barScroll,
    `tab bar must not overflow its own width @${width}px (scroll ${tabMetrics!.barScroll} vs client ${tabMetrics!.barClient})`,
  ).toBeLessThanOrEqual(tabMetrics!.barClient + 1);
  for (const b of tabMetrics!.buttons) {
    expect(b.left, `tab "${b.label}" must not start off-screen @${width}px`).toBeGreaterThanOrEqual(-1);
    expect(b.right, `tab "${b.label}" must fit @${width}px (right ${b.right} > ${tabMetrics!.innerWidth})`).toBeLessThanOrEqual(tabMetrics!.innerWidth + 1);
  }

  await expectNoOverflow(page, `/room/${roomId}/play @${width}px (map view)`);
  await page.getByRole('tab', { name: 'Radar' }).click();
  await expect(page.getByRole('heading', { name: /Compass radar/ })).toBeVisible();
  await expectNoOverflow(page, `/room/${roomId}/play @${width}px (radar view)`);
  await page.getByRole('tab', { name: 'Radio' }).click();
  await expect(page.getByRole('region', { name: /Hunters channel/ })).toBeVisible();
  await expectNoOverflow(page, `/room/${roomId}/play @${width}px (radio view)`);
  await page.getByRole('tab', { name: 'Map' }).click();

  // Thumb-zone primary action: reachable and >= 44px tall.
  const thumb = page.locator('.thumb-zone');
  await thumb.scrollIntoViewIfNeeded();
  const catchBtn = thumb.getByRole('button', { name: /Catch.*pick a Runner/ });
  await expect(catchBtn).toBeVisible();
  const box = await catchBtn.boundingBox();
  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(box, 'thumb-zone Catch button must have a box').not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  // boundingBox() is {x, y, width, height} — no .bottom/.right.
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight + 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
});
