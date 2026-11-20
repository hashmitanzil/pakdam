/**
 * outside-zone.spec.ts — the 30 s outside-zone rule (BEHAVIOUR.md §2):
 * banner + countdown, back-inside clears it, poor GPS freezes it, 0 s
 * ejects (demo enforces; live is server-enforced). Demo-only.
 *
 * Geolocation is emulated: the zone sits on the Ranchi default
 * (23.36, 85.33); the far point (23.40, 85.40) is well outside the 500 m
 * zone. Text-only, no screenshots.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  readyAll,
  setupThreePlayerLobby,
  startMatchAsHost,
  waitForPlay,
  dismissRoleReveal,
} from './helpers';

const CENTRE = { latitude: 23.36, longitude: 85.33, accuracy: 10 };
const FAR = { latitude: 23.4, longitude: 85.4, accuracy: 10 };
const FAR_ROUGH = { latitude: 23.4, longitude: 85.4, accuracy: 100 };

test.describe('outside zone (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  async function startAtCentre(browser: import('@playwright/test').Browser) {
    const context = await browser.newContext({
      geolocation: CENTRE,
      permissions: ['geolocation'],
    });
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    await readyAll([hostPage, ...guestPages]);
    await startMatchAsHost(hostPage);
    await waitForPlay(hostPage);
    await dismissRoleReveal(hostPage);
    return { context, hostPage, roomId };
  }

  test('outside the zone shows the banner with the 30 s countdown and chip', async ({
    browser,
  }) => {
    const { context, hostPage } = await startAtCentre(browser);
    await context.setGeolocation(FAR);
    // 45 s, not 15: the emulated FAR fix lands in ~2 s on an unloaded
    // run (probe 2026-11-19), but the 15 s bound timed out under the
    // 4-worker parallel load (run 2) while the 60 s eject test passed —
    // the bound was the emulation, not the app.
    // Countdown minutes are NOT zero-padded (formatAgeLabel: "0:30",
    // not "00:30").
    await expect(hostPage.getByText(/OUTSIDE ZONE — Return in 0:\d\d or ejected/)).toBeVisible({
      timeout: 45000,
    });
    await expect(hostPage.getByText('30s', { exact: true })).toBeVisible();
    await context.close();
  });

  test('back inside clears the banner', async ({ browser }) => {
    const { context, hostPage } = await startAtCentre(browser);
    await context.setGeolocation(FAR);
    await expect(hostPage.getByText(/OUTSIDE ZONE — Return in 0:\d\d or ejected/)).toBeVisible({
      timeout: 45000,
    });
    await context.setGeolocation(CENTRE);
    await expect(hostPage.getByText(/OUTSIDE ZONE — Return in 0:\d\d or ejected/)).toBeHidden({
      timeout: 15000,
    });
    await context.close();
  });

  test('poor GPS freezes the countdown at 0:30', async ({ browser }) => {
    const { context, hostPage } = await startAtCentre(browser);
    await context.setGeolocation(FAR_ROUGH);
    // Frozen at the full 30 s while the fix is too rough to trust —
    // "0:30", not "00:30" (minutes are not zero-padded).
    await expect(hostPage.getByText('OUTSIDE ZONE — Return in 0:30 or ejected')).toBeVisible({
      timeout: 45000,
    });
    await hostPage.waitForTimeout(5000);
    await expect(hostPage.getByText('OUTSIDE ZONE — Return in 0:30 or ejected')).toBeVisible();
    await context.close();
  });

  test('30 s outside ejects the player', async ({ browser }) => {
    test.setTimeout(120000);
    const { context, hostPage } = await startAtCentre(browser);
    await context.setGeolocation(FAR);
    await expect(hostPage.getByText('You were ejected — you left the zone.')).toBeVisible({
      timeout: 60000,
    });
    await context.close();
  });
});
