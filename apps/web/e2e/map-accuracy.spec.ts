/**
 * map-accuracy.spec.ts — zone accuracy rules (BEHAVIOUR.md §2): radius
 * min 100 m, no maximum, Auto final size ≈ 25%, next zone hidden until
 * the shrink preview, and the ±50 m GPS rule. Demo-only. Text-only.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  createHostRoom,
  startDemoMatch,
} from './helpers';

test.describe('zone accuracy (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  async function openZoneEditor(context: import('@playwright/test').BrowserContext) {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    await hostPage.getByRole('button', { name: /Zone size/ }).click();
    const dialog = hostPage.getByRole('dialog', { name: 'Play zone' });
    await expect(dialog).toBeVisible();
    return { hostPage, dialog };
  }

  test('default zone is 500 m → 125 m (Auto final size is 25%)', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    await expect(hostPage.getByRole('button', { name: /Zone size 500 m → 125 m/ })).toBeVisible();
    await expect(hostPage.getByLabel('Game summary')).toContainText('500m zone');
  });

  test('Zone size stepper stops at the 100 m minimum', async ({ context }) => {
    const { dialog } = await openZoneEditor(context);
    const decrease = dialog.getByRole('button', { name: 'Decrease Zone size' });
    for (let i = 0; i < 8; i++) await decrease.click(); // 500 → 100 m
    await expect(dialog.getByText('100 m').first()).toBeVisible();
    await expect(dialog.getByText('200 m across')).toBeVisible();
    await expect(decrease).toBeDisabled();
  });

  test('Zone size has no 1 km cap: 1.1 km sticks and the summary updates on Done', async ({
    context,
  }) => {
    const { hostPage, dialog } = await openZoneEditor(context);
    const increase = dialog.getByRole('button', { name: 'Increase Zone size' });
    for (let i = 0; i < 12; i++) await increase.click(); // 500 → 1100 m
    await expect(dialog.getByText('1.1 km').first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(hostPage.getByRole('dialog', { name: 'Play zone' })).toBeHidden();
    await expect(hostPage.getByLabel('Game summary')).toContainText('1100m zone');
    await expect(hostPage.getByRole('button', { name: /Zone size 1.1 km → 275 m/ })).toBeVisible();
  });

  test('Final size defaults to Auto · 125 m; Fixed 250 m updates the lobby row', async ({
    context,
  }) => {
    const { hostPage, dialog } = await openZoneEditor(context);
    await expect(dialog.getByText('Auto · 125 m')).toBeVisible();
    await dialog.getByRole('button', { name: 'Auto', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Fixed — tap for Auto' })).toBeVisible();
    const increaseFinal = dialog.getByRole('button', { name: 'Increase Final size' });
    for (let i = 0; i < 5; i++) await increaseFinal.click(); // 125 → 250 m
    await expect(dialog.getByText('250 m').first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(hostPage.getByRole('button', { name: /Zone size 500 m → 250 m/ })).toBeVisible();
  });

  test('Cancel discards zone edits; Done applies them', async ({ context }) => {
    const { hostPage, dialog } = await openZoneEditor(context);
    await dialog.getByRole('button', { name: 'Increase Zone size' }).click();
    await expect(dialog.getByText('550 m').first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(hostPage.getByRole('button', { name: /Zone size 500 m → 125 m/ })).toBeVisible();
    await hostPage.getByRole('button', { name: /Zone size/ }).click();
    const dialog2 = hostPage.getByRole('dialog', { name: 'Play zone' });
    await dialog2.getByRole('button', { name: 'Increase Zone size' }).click();
    await dialog2.getByRole('button', { name: 'Done' }).click();
    await expect(hostPage.getByRole('button', { name: /Zone size 550 m → 138 m/ })).toBeVisible();
  });

  test('Draw needs at least 3 corners: Done with none answers in one line', async ({
    context,
  }) => {
    const { dialog } = await openZoneEditor(context);
    await dialog.getByRole('button', { name: 'Draw' }).click();
    // No corners placed: there is no "Start again" to click (it only
    // renders once corners exist) — Done straight away is the test.
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog.getByText('Place at least 3 corners to make a zone.')).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('the play HUD never shows the next zone (hidden until the shrink preview)', async ({
    context,
  }) => {
    // Default 30-min round (roundShort: false): with the 10-min shrink
    // interval the first shrink is pending, so the HUD shows its countdown.
    // The shortened 10-min round would put the first shrink at round end
    // and the HUD correctly shows "no shrink left" instead.
    const { hostPage } = await startDemoMatch(context, { roundShort: false });
    await expect(hostPage.getByText(/Next zone/i)).toBeHidden();
    await expect(hostPage.getByText(/Zone 500 m shrinks in \d\d:\d\d/)).toBeVisible();
  });

  test('a fix worse than ±50 m is never auto-centred: the GPS-rough line appears', async ({
    browser,
  }) => {
    test.setTimeout(150000);
    const context = await browser.newContext({
      geolocation: { latitude: 23.36, longitude: 85.33, accuracy: 100 },
      permissions: ['geolocation'],
    });
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    // getCurrentFix runs a staged chain (up to ~45 s) before giving up.
    await expect(
      hostPage.getByText('GPS is too rough here — tap the map to place the zone.'),
    ).toBeVisible({ timeout: 70000 });
    await expect(hostPage.getByLabel('Game summary')).toContainText('500m zone');
    await context.close();
  });
});
