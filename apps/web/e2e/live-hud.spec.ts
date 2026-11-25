/**
 * live-hud.spec.ts — the play HUD: role reveal, status strip, bottom tabs,
 * radio, safety pause, suspended banner, per-role catch buttons.
 * Demo-only. Text-only: DOM text and roles, no screenshots.
 *
 * NOTE (flagged in the report): the PTT mic renders only with a live voice
 * radio — in demo mode there is no mic button at all, so this spec asserts
 * its absence in demo and its presence is covered only by the live run.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  GUEST_NAMES,
  HOST_NAME,
  dismissRoleReveal,
  getDemoRoom,
  readyAll,
  setupThreePlayerLobby,
  startDemoMatch,
  startMatchAsHost,
  waitForPlay,
} from './helpers';

test.describe('live HUD (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('role reveal shows the right copy per role, then Let\'s go enters the HUD', async ({
    context,
  }) => {
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    await readyAll([hostPage, ...guestPages]);
    await startMatchAsHost(hostPage);
    await waitForPlay(hostPage);
    const room = await getDemoRoom(hostPage, roomId);
    const hostRole = room?.players.find((p) => p.displayName === HOST_NAME)?.matchRole;
    expect(hostRole === 'hunter' || hostRole === 'runner').toBe(true);
    await expect(hostPage.getByText('PAKDAM', { exact: true })).toBeVisible();
    await expect(hostPage.getByText(`Your role · ${hostRole === 'hunter' ? 'Hunter' : 'Runner'}`)).toBeVisible();
    if (hostRole === 'hunter') {
      await expect(hostPage.getByText('You’re it.', { exact: true })).toBeVisible();
      await expect(hostPage.getByText(/Find and tag all 2 runners in 10 min/)).toBeVisible();
    } else {
      await expect(hostPage.getByText('Stay hidden.', { exact: true })).toBeVisible();
      await expect(hostPage.getByText('Outlast the clock. Hunters see you only when you ping.')).toBeVisible();
    }
    await expect(
      hostPage.getByText("Keep the app open — alerts arrive while you're playing. There are no push notifications when the app is closed."),
    ).toBeVisible();
    await hostPage.getByRole('button', { name: "Let's go", exact: true }).click();
    await expect(hostPage.getByText('You’re it.', { exact: true })).toBeHidden();
    await expect(hostPage.getByText('Stay hidden.', { exact: true })).toBeHidden();
  });

  test('status strip: time left, next ping, zone shrink, runners left', async ({ context }) => {
    // Default 30-min round (roundShort: false): with the 10-min shrink
    // interval the first shrink is pending, so the strip shows its
    // countdown. The shortened 10-min round would put the first shrink at
    // round end and the strip correctly shows "no shrink left" instead.
    const { hostPage, guestPages, roles } = await startDemoMatch(context, { roundShort: false });
    const page = hostPage;
    // v34: NO bringToFront + connected-poll here. That premise was
    // false in headless CI: real backgrounding never fires
    // `visibilitychange` (every page reads `document.hidden ===
    // false`), so fronting resumes nothing — and this fixture grants
    // no geolocation, so the play page's GPS watch denies and the
    // seat stays `gps-denied`-suspended by design (F16) until a fix
    // arrives, which never happens here. The strip does not depend
    // on connectionState, so assert it directly; the suspended-guest
    // premise below (banner on Ana's page) is the one that pins the
    // suspension, and it holds for the same reason.
    await expect(page.getByText('Time left')).toBeVisible();
    await expect(page.getByText('Next ping')).toBeVisible();
    await expect(page.getByText(/Runners left 2 of 2/)).toBeVisible();
    // Countdown minutes are NOT zero-padded (formatAgeLabel: "9:59", not
    // "09:59"), so the minutes half is \d+, not \d\d.
    await expect(page.getByText(/Zone 500 m shrinks in \d+:\d\d/)).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Runners left' })).toBeVisible();
    // No fix has ever arrived in a headless context without geolocation
    // — but assert it on a GUEST seat, not the host's own dot. v34:
    // there is no bringToFront above any more (it resumed nothing —
    // see the comment at the top of this test), and no resume ever
    // stamps `lastFixAt` here, so the host's dot reads 'Suspended'
    // too, never an age. The guest banner is still the assertion to
    // make: it pins BOTH halves of the premise at once (suspended
    // AND never reported) in one exact string, where a dot label
    // alone pins only the first half — and a teammate dot only
    // exists when the host drew Runner, so the host page matches
    // zero or one elements by role draw. A guest page never
    // hid-and-resumed (it was created backgrounded and never brought
    // forward), so its seat is still suspended — deterministic
    // (Diya-verified) — and no fix ever arrived for it.
    //
    // v32 fix round (Diya A2 — the old assertion was wrong): Ana's
    // own YOU dot does NOT read "Location never reported". While the
    // seat is suspended the dot label reads 'Suspended'
    // (play/page.tsx:1166-1174); "Location never reported" is the
    // freshness half of the SUSPENDED BANNER
    // (`formatSuspendedLabel`, freshness.ts:38-44), shown because no
    // fix ever arrived. The old `.first()` match came from that
    // banner and/or a teammate dot, not deterministically from the
    // YOU dot. Assert the banner's full exact text instead: it pins
    // both halves of the premise at once (suspended AND never
    // reported).
    await expect(
      guestPages[0]!.getByText('Suspended — location unknown · Location never reported', {
        exact: true,
      }),
    ).toBeVisible();
    expect(roles.size).toBe(3);
  });

  test('head start: hunters see the waiting line, runners see the hidden line', async ({
    context,
  }) => {
    const { hostPage, guestPages } = await setupThreePlayerLobby(context, {
      headStartNone: false,
      roundShort: false,
    });
    await readyAll([hostPage, ...guestPages]);
    await startMatchAsHost(hostPage);
    for (const guest of guestPages) await waitForPlay(guest);
    const allPages = [hostPage, ...guestPages];
    const names = [HOST_NAME, ...GUEST_NAMES];
    // Roles come from the host page's copy of the demo store.
    const roomId = hostPage.url().split('/room/')[1]!.split('/')[0]!;
    const hostRoom = await getDemoRoom(hostPage, roomId);
    const roles = new Map<string, string | null>();
    for (const p of hostRoom?.players ?? []) roles.set(p.displayName, p.matchRole);
    const hunterName = [...roles.entries()].find(([, r]) => r === 'hunter')?.[0];
    const runnerName = [...roles.entries()].find(([, r]) => r === 'runner')?.[0];
    expect(hunterName).toBeTruthy();
    expect(runnerName).toBeTruthy();
    const hunterPage = allPages[names.indexOf(hunterName!)]!;
    const runnerPage = allPages[names.indexOf(runnerName!)]!;
    await expect(hunterPage.getByText('Head start', { exact: true })).toBeVisible();
    await expect(hunterPage.getByText('Hunters wait — runners are scattering.')).toBeVisible();
    await expect(runnerPage.getByText('HIDDEN FROM HUNTERS — Hunters never shown')).toBeVisible();
    await dismissRoleReveal(hunterPage);
    await dismissRoleReveal(runnerPage);
  });

  test('bottom tabs: Map / Radio / More switch the HUD', async ({ context }) => {
    const { hostPage } = await startDemoMatch(context);
    const nav = hostPage.getByRole('navigation', { name: 'Game' });
    await expect(nav.getByRole('button', { name: 'Map' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Radio' })).toBeVisible();
    await expect(nav.getByRole('button', { name: '···' })).toBeVisible();
    await nav.getByRole('button', { name: 'Radio' }).click();
    await expect(hostPage.getByRole('heading', { name: 'Radio' })).toBeVisible();
    await expect(hostPage.getByText(/channel · \d on air/)).toBeVisible();
    await expect(
      hostPage.getByText('Voice radio needs a live connection — text radio still works.'),
    ).toBeVisible();
    await expect(hostPage.getByPlaceholder('Message your team')).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await nav.getByRole('button', { name: 'Map' }).click();
    await expect(hostPage.getByRole('heading', { name: 'Radio' })).toBeHidden();
  });

  test('radio: quick chip set matches the team, and a sent text appears', async ({ context }) => {
    const { hostPage, roomId, roles } = await startDemoMatch(context);
    const hostRole = roles.get(HOST_NAME);
    await hostPage.getByRole('navigation', { name: 'Game' }).getByRole('button', { name: 'Radio' }).click();
    if (hostRole === 'hunter') {
      await expect(hostPage.getByText('Hunters channel · 0 on air')).toBeVisible();
      await expect(hostPage.getByRole('button', { name: 'Cover the far edge' })).toBeVisible();
      await expect(hostPage.getByRole('button', { name: 'I need backup' })).toBeVisible();
    } else {
      await expect(hostPage.getByText('Runners channel · 1 on air')).toBeVisible();
      await expect(hostPage.getByRole('button', { name: 'I’m safe for now' })).toBeVisible();
    }
    await expect(hostPage.getByText('No messages yet — say something to your team.')).toBeVisible();
    await hostPage.getByPlaceholder('Message your team').fill('Moving to a new spot');
    await hostPage.getByRole('button', { name: 'Send', exact: true }).click();
    // The sent message is a <p>; a quick chip with the same text is a
    // <button> — scope to the paragraph so the chip does not double-match.
    await expect(hostPage.locator('p:text-is("Moving to a new spot")')).toBeVisible();
    void roomId;
  });

  test('PTT mic is absent in demo (no live voice radio)', async ({ context }) => {
    const { hostPage } = await startDemoMatch(context);
    await expect(hostPage.getByRole('button', { name: 'Hold to talk' })).toBeHidden();
  });

  test('More sheet: safety pause and Leave game', async ({ context }) => {
    const { guestPages } = await startDemoMatch(context);
    const guest = guestPages[0]!;
    await guest.getByRole('navigation', { name: 'Game' }).getByRole('button', { name: '···' }).click();
    const sheet = guest.getByRole('dialog', { name: 'More' });
    await expect(sheet.getByText('Safety pause')).toBeVisible();
    await expect(sheet.getByText('Pauses the match for everyone and freezes the clock.')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Leave game' })).toBeVisible();
    // Item 2: "Sound & vibration" section — haptics on by default, cue
    // sounds off by default; both persist in localStorage.
    await expect(sheet.getByText('Sound & vibration', { exact: true })).toBeVisible();
    const haptics = sheet.getByRole('switch', { name: 'Vibration (Android only)', exact: true });
    const sounds = sheet.getByRole('switch', { name: 'Cue sounds', exact: true });
    await expect(haptics).toBeVisible();
    await expect(sounds).toBeVisible();
    await expect(haptics).toHaveAttribute('aria-checked', 'true');
    await expect(sounds).toHaveAttribute('aria-checked', 'false');
    await sounds.click();
    await expect(sounds).toHaveAttribute('aria-checked', 'true');
    expect(await guest.evaluate(() => window.localStorage.getItem('pakdam-cues-sounds'))).toBe(
      'on',
    );
    await haptics.click();
    await expect(haptics).toHaveAttribute('aria-checked', 'false');
    expect(await guest.evaluate(() => window.localStorage.getItem('pakdam-cues-haptics'))).toBe(
      'off',
    );
  });

  test('safety pause freezes the clock and resume returns to live play', async ({ context }) => {
    const { hostPage } = await startDemoMatch(context);
    await hostPage.getByRole('navigation', { name: 'Game' }).getByRole('button', { name: '···' }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'More' });
    await sheet.getByRole('button', { name: 'Pause the match' }).click();
    await expect(sheet.getByText(/Match paused by Teo — clock frozen\./)).toBeVisible();
    await expect(sheet.getByText('Resume returns to live play.')).toBeVisible();
    // exact:true — plain 'Paused' also matches the sheet's
    // 'Match paused by Teo — clock frozen.' (strict-mode violation).
    await expect(hostPage.getByText('Paused', { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Resume the match' }).click();
    await expect(hostPage.getByText('Paused', { exact: true })).toBeHidden();
    await expect(hostPage.getByText('Time left')).toBeVisible();
  });

  test('suspended banner: tab-hide suspends, Resume sharing clears it', async ({ browser }) => {
    // Geolocation granted + an emulated fix at the Ranchi default zone
    // centre (the outside-zone.spec.ts CENTRE, accuracy 10 m): without
    // it the play-page watch errors permission-denied at mount, the
    // seat suspends for GPS-denied (v28 F16) and v30 hides "Resume
    // sharing" while GPS is denied — the button this test clicks never
    // renders, so the test fails before the tab-hide path is even
    // exercised. With fixes flowing, the seat suspends ONLY for the
    // faked tab-hide below, which is what this test is about. Both the
    // coordinates AND the permission are needed (Playwright: permission
    // is a separate control from the emulated position).
    const context = await browser.newContext({
      geolocation: { latitude: 23.36, longitude: 85.33, accuracy: 10 },
      permissions: ['geolocation'],
    });
    const { hostPage } = await startDemoMatch(context);
    await hostPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(hostPage.getByText(/Suspended — location unknown/)).toBeVisible();
    await expect(
      hostPage.getByText('Your location is unknown until a fresh fix arrives.'),
    ).toBeVisible();
    // Click Resume sharing WHILE still hidden: dispatching the visible
    // event first would auto-resume (useRoomState resumes on tab-visible)
    // and the button would already be gone.
    await hostPage.getByRole('button', { name: 'Resume sharing' }).click();
    await expect(hostPage.getByText(/Suspended — location unknown/)).toBeHidden();
    // And tab-visible auto-resume: hide again, show again, banner clears.
    await hostPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(hostPage.getByText(/Suspended — location unknown/)).toBeVisible();
    await hostPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(hostPage.getByText(/Suspended — location unknown/)).toBeHidden();
    await context.close();
  });

  test('catch buttons are one per role: hunter gets Tag a runner, runner gets Got Tagged', async ({
    context,
  }) => {
    const { hostPage, guestPages, roles } = await startDemoMatch(context);
    const allPages = [hostPage, ...guestPages];
    const names = [HOST_NAME, ...GUEST_NAMES];
    for (let i = 0; i < allPages.length; i++) {
      const page = allPages[i]!;
      const role = roles.get(names[i]!);
      if (role === 'hunter') {
        await expect(page.getByRole('button', { name: 'Tag a runner', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Got Tagged' })).toBeHidden();
      } else {
        // No "SHOW MY QR" button exists on the play screen — the
        // runner's button is "Got Tagged", which opens /catch where the
        // QR itself is shown automatically.
        await expect(page.getByRole('button', { name: 'Got Tagged' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Tag a runner', exact: true })).toBeHidden();
      }
    }
  });
});
