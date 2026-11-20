/**
 * map-accuracy.spec.ts — zone accuracy rules (BEHAVIOUR.md §2): radius
 * min 100 m, no maximum, Auto final size ≈ 25%, next zone hidden until
 * the shrink preview, and the ±50 m GPS rule. Demo-only. Text-only.
 * The zone is edited inline on the create screen (Zone size stepper
 * below the map); the summary strip that reflects it lives on the
 * lobby. There is no separate editor dialog.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  createHostSetupRoom,
  startDemoMatch,
} from './helpers';

test.describe('zone accuracy (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('default zone is 500 m → 211 m (Auto final size is ~42%)', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    await expect(
      hostPage.getByRole('group', { name: 'Zone size' }).getByText('500 m'),
    ).toBeVisible();
    await expect(hostPage.getByText('Final size Auto · ~42% (211 m)')).toBeVisible();
    await hostPage.getByRole('button', { name: 'CREATE LOBBY', exact: true }).click();
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expect(hostPage.getByLabel('Game summary')).toContainText('500m zone');
  });

  test('Zone size stepper stops at the 100 m minimum', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    const decrease = hostPage.getByRole('button', { name: 'Decrease Zone size' });
    for (let i = 0; i < 8; i++) await decrease.click(); // 500 → 100 m
    await expect(
      hostPage.getByRole('group', { name: 'Zone size' }).getByText('100 m'),
    ).toBeVisible();
    await expect(hostPage.getByText('200 m across')).toBeVisible();
    await expect(decrease).toBeDisabled();
  });

  test('Zone size has no 1 km cap: 1.1 km sticks and the summary updates', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    const increase = hostPage.getByRole('button', { name: 'Increase Zone size' });
    for (let i = 0; i < 12; i++) await increase.click(); // 500 → 1100 m
    await expect(
      hostPage.getByRole('group', { name: 'Zone size' }).getByText('1.1 km'),
    ).toBeVisible();
    // Inline editing applies live — no Done step.
    await hostPage.getByRole('button', { name: 'CREATE LOBBY', exact: true }).click();
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expect(hostPage.getByLabel('Game summary')).toContainText('1100m zone');
  });

  test('Final size is always Auto · ~42% — no manual final-size control', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    await expect(hostPage.getByText('Final size Auto · ~42% (211 m)')).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'Increase Final size' })).toBeHidden();
    await expect(hostPage.getByText('Fixed — tap for Auto')).toBeHidden();
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
    await createHostSetupRoom(hostPage);
    // getCurrentFix runs a staged chain (up to ~45 s) before giving up.
    await expect(
      hostPage.getByText('GPS is too rough here — tap the map to place the zone.'),
    ).toBeVisible({ timeout: 70000 });
    await hostPage.getByRole('button', { name: 'CREATE LOBBY', exact: true }).click();
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expect(hostPage.getByLabel('Game summary')).toContainText('500m zone');
    await context.close();
  });
});
