/**
 * outside-zone.spec.ts — the 30 s outside-zone rule (BEHAVIOUR.md §2):
 * banner + countdown, back-inside clears it, poor GPS freezes it, 0 s
 * ejects (demo enforces; live is server-enforced). Demo-only.
 *
 * v18 item 4: the match starts even if a player's GPS has not reported
 * yet (no start-gate GPS refusal), and 30 s with NO fix at all also
 * ejects — the missing-fix rule, same 30 s as out-of-zone. A
 * poor-but-present fix still freezes the countdown; it never ejects.
 * Demo enforces the missing-fix ejection via the play page, live via
 * the server.
 *
 * Geolocation is emulated: the zone sits on the Ranchi default
 * (23.36, 85.33); the far point (23.40, 85.40) is well outside the 500 m
 * zone. Text-only, no screenshots.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  HOST_NAME,
  getDemoRoom,
  readyAll,
  setupThreePlayerLobby,
  startMatchAsHost,
  waitForPlay,
  dismissRoleReveal,
} from './helpers';

const CENTRE = { latitude: 23.36, longitude: 85.33, accuracy: 10 };
const FAR = { latitude: 23.4, longitude: 85.4, accuracy: 10 };
const FAR_ROUGH = { latitude: 23.4, longitude: 85.4, accuracy: 100 };
// FAR nudged ~1 m — still ~7 km outside the 500 m zone, but a NEW
// position, so Chromium delivers a fresh fix (see the eject test).
const FAR_NUDGED = { latitude: 23.40001, longitude: 85.40001, accuracy: 10 };

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
    // The emulated fix is delivered ONCE: after ~10 s the app
    // (correctly, by its stale-fix rule) freezes the outside countdown,
    // and (4a) ejects for missing location at 30 s with the OTHER
    // notice — so the zone ejection could never fire. Keep the fix
    // fresh by nudging the emulated position every 4 s (both points
    // are ~7 km outside the zone); the countdown then runs to 0.
    const keepFresh = (async () => {
      try {
        for (let i = 0; i < 10; i++) {
          await hostPage.waitForTimeout(4000);
          await context.setGeolocation(i % 2 === 0 ? FAR_NUDGED : FAR);
        }
      } catch {
        // Test ended (pass or fail) — the context is closed.
      }
    })();
    await expect(hostPage.getByText('You were ejected — you left the zone.')).toBeVisible({
      timeout: 60000,
    });
    await keepFresh;
    await context.close();
  });

  test('no fix for 30 s ejects the player (v18 missing-fix rule)', async ({ browser }) => {
    test.setTimeout(120000);
    // No geolocation at all: no fix is ever reported for any seat.
    // v18 item 4(a): the match STARTS anyway — there is no GPS-freshness
    // refusal at the gate. v18 item 4(b): 30 s with no fix at all ejects,
    // following the out-of-zone rule. A poor-but-present fix still freezes
    // the countdown instead (see 'poor GPS freezes the countdown at 0:30').
    const context = await browser.newContext();
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    await readyAll([hostPage, ...guestPages]);
    await startMatchAsHost(hostPage);
    await waitForPlay(hostPage);
    await dismissRoleReveal(hostPage);
    // The ejection is asserted as a store fact (ejectedAt), not copy: the
    // notice wording for a missing-fix ejection is the app's choice, so
    // this test does not assert on it.
    await expect
      .poll(
        async () => {
          const room = await getDemoRoom(hostPage, roomId);
          return room?.players.find((p) => p.displayName === HOST_NAME)?.ejectedAt ?? null;
        },
        { timeout: 60000 },
      )
      .not.toBeNull();
    await context.close();
  });
});
