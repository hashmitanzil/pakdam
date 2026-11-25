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
    // v32 (Arjun-vs-Diya adjudication — Diya right that bringToFront
    // ALONE does not fix this; Arjun right that it is half the fix).
    // No geolocation at all is NOT a fix-less seat: without a grant
    // the watch errors permission-denied at start and the v28 F16
    // rule suspends the seat instead of letting the 30 s ejection
    // take it — and shouldEjectForMissingFix never ejects a suspended
    // seat (play-map-logic.ts), so ejectedAt could never fire. Worse,
    // bringToFront alone cannot hold the seat connected: the play
    // page mounts hidden, so no watch exists yet, and the return
    // creates a FRESH watch that errors denied again and re-suspends
    // within a second — long before the 30 s (4a) clock runs out.
    // The rule under test governs a seat whose watch is ALIVE but
    // silent, so grant the permission with NO position: the watch
    // starts, the provider fails (position-unavailable / timeout),
    // neither of which suspends (play/page.tsx onError — only
    // permission-denied suspends), no fix ever arrives, and the
    // (4a) clock runs. bringToFront (below) is the other half: it
    // resumes the tab-hidden suspension from setup, so the seat is
    // connected while the clock runs. Assertion unchanged.
    //
    // v32 fix round (Diya A7 — ASSUMPTION, stated explicitly): this
    // test's grant sufficiency rests on unpinned provider behaviour —
    // the headless geolocation provider must NEVER deliver a fix when
    // no position is emulated. If it ever delivered one unprompted,
    // `lastFixAt` would be stamped, the (4a) clock would never run,
    // and this test would time out on the ejectedAt poll instead of
    // passing. No code can pin that; if this test ever flakes that
    // way, the provider assumption is the first suspect.
    const context = await browser.newContext();
    await context.grantPermissions(['geolocation']);
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    await readyAll([hostPage, ...guestPages]);
    await startMatchAsHost(hostPage);
    await waitForPlay(hostPage);
    await dismissRoleReveal(hostPage);
    // v32: front the host so the tab-hidden suspension from setup
    // resumes — a suspended seat never ejects (see above) — and the
    // poll below proves the seat is connected before the clock runs.
    await hostPage.bringToFront();
    await expect
      .poll(
        async () => {
          const room = await getDemoRoom(hostPage, roomId);
          return room?.players.find((p) => p.displayName === HOST_NAME)?.connectionState ?? null;
        },
        { timeout: 10000 },
      )
      .toBe('connected');
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
