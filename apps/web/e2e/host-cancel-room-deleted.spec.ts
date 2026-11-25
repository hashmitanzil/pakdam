/**
 * Host cancel + host succession (founder decisions, 2026-11-21).
 *
 * Rule 1 — the host cancels, the lobby is deleted: every player still
 * in the room goes back home with ONE plain message,
 * "The host cancelled — this lobby is gone." (lobby + play pages,
 * plus the reload-after-deletion path).
 * Rule 2 — the host disconnects, the earliest joiner becomes host:
 * the new host's controls (start, settings, cancel) appear WITHOUT a
 * reload, and the new host can start the game.
 *
 * Demo-only (the live `room.deleted` event / 404 snapshot path needs a
 * live Worker — it is exercised in the live leg by the coordinator):
 * the demo store stands in for the server — `transferDemoHost` mirrors
 * `host.transferred`, `deleteDemoRoomFromStore` mirrors the server
 * deleting the room. Text-only assertions throughout, no screenshots.
 *
 * Fix round 1 (W3): demo succession also runs on SUSPENSION (a host
 * who backgrounds the tab transfers host to the earliest-joined
 * remaining CONNECTED seat — under v24 (D1) only once the 30 s grace
 * expires, with the "Waiting for the host to reconnect…" line while
 * it runs), and host-leave skips suspended seats.
 * Fix round 1 (W1/W2): the live-only block at the bottom covers manual
 * Retry discovering a deletion the socket missed.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  collectPageErrors,
  createHostRoom,
  deleteDemoRoomFromStore,
  DEMO_ROOMS_KEY,
  expectDemoMode,
  expectNoPageErrors,
  getDemoRoom,
  GUEST_NAMES,
  HOST_NAME,
  LIVE,
  playerIdOf,
  readyAll,
  setupThreePlayerLobby,
  startDemoMatch,
  startMatchAsHost,
  transferDemoHost,
} from './helpers';

const ROOM_DELETED_MESSAGE = 'The host cancelled — this lobby is gone.';
const WAITING_LINE = 'Waiting for the host to reconnect…';

/** Ranchi default zone centre (same as outside-zone.spec.ts) — inside the 500 m zone. */
const CENTRE = { latitude: 23.36, longitude: 85.33, accuracy: 10 };
/** CENTRE nudged ~1 m — a NEW position, so Chromium delivers a fresh fix to every running watch. */
const CENTRE_NUDGED = { latitude: 23.36001, longitude: 85.33001, accuracy: 10 };

/**
 * Geolocation for these two tests (v28 follow-up on the v27 CI
 * failures at :209/:244 — NOT H1): the tests run a live match, and a
 * live match with no GPS ejects every fix-less seat 30 s after start
 * (demo (4a), play/page.tsx) — both runners eject, the match
 * COMPLETES, tickDemoRoom stops expiring the host grace, and the
 * crown poll can never match (:209); :244's tail dies the same way
 * if it crosses T0+30 s. In the current tree the v28 F16
 * permission-denied path additionally suspends every seat at watch
 * start, so the grace expires with no connected successor. Granting
 * the permission + an emulated position makes fixes flow, so no seat
 * suspends for GPS reasons and no (4a) ejection fires. Both the
 * coordinates AND the permission are needed — setGeolocation alone
 * does not grant (Playwright: permission is a separate control).
 */
async function grantGeolocation(context: import('@playwright/test').BrowserContext): Promise<void> {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(CENTRE);
}

/** White-box demo helper: move the host grace deadline into the past so the next 1 s poll expires it (same pattern as host-grace.spec.ts). Demo-only; localStorage is the demo store. */
async function fastForwardDemoGrace(page: Page, roomId: string): Promise<void> {
  await page.evaluate(
    ({ key, roomId: id }) => {
      const rooms = JSON.parse(window.localStorage.getItem(key) ?? '[]') as Array<{
        room: { roomId: string };
        hostGraceEndsAtMs?: number | null;
      }>;
      const found = rooms.find((r) => r.room.roomId === id);
      if (!found) throw new Error(`demo room ${id} not found in localStorage`);
      if (found.hostGraceEndsAtMs == null) {
        throw new Error(`demo room ${id} has no grace running to expire`);
      }
      found.hostGraceEndsAtMs = Date.now() - 1000;
      window.localStorage.setItem(key, JSON.stringify(rooms));
    },
    { key: DEMO_ROOMS_KEY, roomId },
  );
}

/** Simulate a tab-hidden disconnect: the play page's visibility handler suspends the seat in the demo store. */
async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** The host-only "End the round" entry in the play page's More sheet. */
async function expectEndRound(page: Page, visible: boolean): Promise<void> {
  await page.getByRole('navigation', { name: 'Game' }).getByRole('button', { name: '···' }).click();
  const sheet = page.getByRole('dialog', { name: 'More' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'End the round' })).toHaveCount(visible ? 1 : 0);
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(sheet).toBeHidden();
}

test.describe('host cancel deletes the lobby', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('lobby cancel control is host-only and asks first', async ({ context }) => {
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    const errors = collectPageErrors(hostPage);
    const guest = guestPages[0]!;

    // Host-only: the host sees it, a joiner never does.
    await expect(hostPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Cancel lobby', exact: true })).toHaveCount(0);

    // A stray tap must never delete the lobby: the confirm sheet asks
    // first, and "Cancel" (keep the lobby) leaves the lobby intact.
    await hostPage.getByRole('button', { name: 'Cancel lobby', exact: true }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'Cancel lobby?' });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByText('Cancel this lobby? The lobby will be deleted and every player goes back home.'),
    ).toBeVisible();
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toBeVisible();

    expectNoPageErrors(errors);
  });

  test('host cancels from the lobby: host and joiner both land home with the message', async ({
    context,
  }) => {
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    const errors = collectPageErrors(hostPage);
    const guest = guestPages[0]!;

    await hostPage.getByRole('button', { name: 'Cancel lobby', exact: true }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'Cancel lobby?' });
    await sheet.getByRole('button', { name: 'Cancel lobby', exact: true }).click();

    // The host goes home at once; the joiner follows on the next poll.
    await hostPage.waitForURL('/');
    await guest.waitForURL('/');
    await expect(hostPage.getByText(ROOM_DELETED_MESSAGE)).toBeVisible();
    await expect(guest.getByText(ROOM_DELETED_MESSAGE)).toBeVisible();
    // The room is really gone — no stale lobby survives in the store.
    const stillThere = await hostPage.evaluate(
      ({ key, id }) =>
        (JSON.parse(window.localStorage.getItem(key) ?? '[]') as { room: { roomId: string } }[]).some(
          (r) => r.room.roomId === id,
        ),
      { key: DEMO_ROOMS_KEY, id: roomId },
    );
    expect(stillThere).toBe(false);

    expectNoPageErrors(errors);
  });

  test('reopening a deleted lobby lands home with the message (no error screen)', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    const { roomId } = await createHostRoom(hostPage, HOST_NAME);
    await expectDemoMode(hostPage);
    const errors = collectPageErrors(hostPage);

    // The room vanishes under the player (host cancel in another tab);
    // a reload must land home with the message, not a stale lobby or
    // an error screen.
    await deleteDemoRoomFromStore(hostPage, roomId);
    await hostPage.reload();
    await hostPage.waitForURL('/');
    await expect(hostPage.getByText(ROOM_DELETED_MESSAGE)).toBeVisible();

    // One-shot: a second visit home shows no stale notice.
    await hostPage.reload();
    await expect(hostPage.getByText(ROOM_DELETED_MESSAGE)).toHaveCount(0);

    expectNoPageErrors(errors);
  });

  test('host ends the round mid-game: host and runner both land home with the message', async ({
    context,
  }) => {
    const { hostPage, guestPages } = await startDemoMatch(context);
    const errors = collectPageErrors(hostPage);
    const guest = guestPages[0]!;

    await hostPage.getByRole('navigation', { name: 'Game' }).getByRole('button', { name: '···' }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'More' });
    await sheet.getByRole('button', { name: 'End the round' }).click();

    // The host goes home at once; the other player follows on the poll.
    await hostPage.waitForURL('/');
    await guest.waitForURL('/');
    await expect(hostPage.getByText(ROOM_DELETED_MESSAGE)).toBeVisible();
    await expect(guest.getByText(ROOM_DELETED_MESSAGE)).toBeVisible();

    expectNoPageErrors(errors);
  });
});

test.describe('host succession: earliest joiner becomes host', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('new host gets host controls without a reload — and can start', async ({ context }) => {
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    const errors = collectPageErrors(hostPage);
    const firstGuest = guestPages[0]!; // Ana — joined first after the host
    const secondGuest = guestPages[1]!; // Ben

    // Before: only the host has host controls; guests wait.
    await expect(hostPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toBeVisible();
    await expect(firstGuest.getByRole('button', { name: 'Cancel lobby', exact: true })).toHaveCount(0);
    await expect(
      firstGuest.getByRole('button', { name: 'WAITING FOR THE HOST TO START' }),
    ).toBeVisible();

    // The host "disconnects": the crown moves to the earliest joiner.
    await transferDemoHost(hostPage, roomId, GUEST_NAMES[0]);

    // No reload anywhere: Ana gains the host controls, Teo loses them.
    await expect(firstGuest.getByRole('button', { name: 'Cancel lobby', exact: true })).toBeVisible();
    await expect(
      firstGuest.getByRole('button', { name: 'WAITING FOR THE HOST TO START' }),
    ).toHaveCount(0);
    await expect(hostPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toHaveCount(0);
    await expect(
      hostPage.getByRole('button', { name: 'WAITING FOR THE HOST TO START' }),
    ).toBeVisible();
    // Ben, who joined later, stays a joiner.
    await expect(secondGuest.getByRole('button', { name: 'Cancel lobby', exact: true })).toHaveCount(0);

    // The new host can actually start the game — the full host powers,
    // not just the visible buttons.
    await readyAll([hostPage, firstGuest, secondGuest]);
    await expect(firstGuest.getByRole('button', { name: 'START GAME', exact: true })).toBeVisible();
    await startMatchAsHost(firstGuest);
    await expect(firstGuest).toHaveURL(/\/room\/[^/]+\/play/);

    expectNoPageErrors(errors);
  });

  test('demo host backgrounds the tab: the crown moves to the earliest-joined connected guest', async ({
    context,
  }) => {
    // GPS on: without fixes the (4a) no-fix ejection completes the
    // match at T0+30 s and freezes the host grace (v27 CI failure —
    // see grantGeolocation above); with fixes flowing, only the
    // tab-hide suspends the host.
    await grantGeolocation(context);
    const { hostPage, guestPages, roomId } = await startDemoMatch(context);
    const errors = collectPageErrors(hostPage);
    const firstGuest = guestPages[0]!; // Ana — joined first after the host
    const secondGuest = guestPages[1]!; // Ben

    // v32: reset the host BEFORE anything reads host controls.
    // Creating the guest pages backgrounded the host tab, so the play
    // page's useRoomState handler already suspended it (and started
    // the 30 s grace) in the lobby, before this test's hideTab. Without
    // the reset the grace is stale: it can expire mid-test (crown to
    // Ben, the only connected seat) before hideTab runs, so the waiting
    // line never appears — and the expectEndRound(host, true) below
    // would already fail on a host who lost the crown. Fronting
    // resumes the host and cancels the stale grace; the hideTab below
    // then starts a fresh one. (Same mechanism as host-grace.spec.ts
    // resetHostBeforeHide; geolocation is granted here, so fixes flow
    // and the resume holds.)
    await hostPage.bringToFront();

    // Before: only the host can end the round.
    await expectEndRound(hostPage, true);
    await expectEndRound(firstGuest, false);

    // The host "disconnects" by backgrounding the tab: the demo store
    // suspends the seat and starts the 30 s grace (v24 D1) — the crown
    // moves only when the grace expires, to the earliest-joined
    // remaining CONNECTED seat. The waiting line appears first, while
    // the crown is still with the suspended host — no reload anywhere.
    await hideTab(hostPage);
    // v32: Ana must be the CONNECTED successor at expiry. Creating
    // Ben's page backgrounded her, so she is suspended from setup and
    // expiry would hand the crown to Ben instead. Front her now — the
    // host stays suspended (its hide was faked) and Ben being
    // backgrounded is harmless. The poll below proves the premise:
    // Ana is observably connected before the grace expires.
    await firstGuest.bringToFront();
    await expect
      .poll(
        async () =>
          (await getDemoRoom(firstGuest, roomId))?.players.find((p) => p.displayName === GUEST_NAMES[0])
            ?.connectionState,
        { timeout: 5000 },
      )
      .toBe('connected');
    // Fresh fix for the still-visible seats: resets their (4a) 30 s
    // clock, so the tail below is safe even on a slow CI worker.
    await context.setGeolocation(CENTRE_NUDGED);
    await expect(firstGuest.getByRole('status', { name: WAITING_LINE })).toBeVisible({
      timeout: 10000,
    });
    // Fast-forward the deadline instead of waiting out the real 30 s
    // (host-grace.spec.ts pattern): the real wait collides with the
    // (4a) ejection boundary AND cannot fit the 60 s test timeout
    // after setup (playwright.config.ts) — the hide → suspend →
    // grace → expiry → transfer chain is otherwise fully exercised.
    await fastForwardDemoGrace(firstGuest, roomId);
    const anaId = await playerIdOf(firstGuest, roomId, GUEST_NAMES[0]);
    await expect
      .poll(async () => (await getDemoRoom(firstGuest, roomId))?.room.hostPlayerId, {
        timeout: 10000,
      })
      .toBe(anaId);

    await expectEndRound(firstGuest, true);
    await expectEndRound(hostPage, false);
    await expectEndRound(secondGuest, false);

    expectNoPageErrors(errors);
  });

  test('demo host leaves while the earliest joiner is suspended: the crown skips the suspended seat', async ({
    context,
  }) => {
    // GPS on: without fixes the v28 F16 permission-denied path
    // suspends Ben too at watch start, so the leave finds no
    // connected successor (v27 CI failure — see grantGeolocation
    // above); with fixes flowing, only the tab-hide suspends Ana.
    await grantGeolocation(context);
    const { hostPage, guestPages, roomId } = await startDemoMatch(context);
    const errors = collectPageErrors(hostPage);
    const firstGuest = guestPages[0]!; // Ana — suspended below
    const secondGuest = guestPages[1]!; // Ben — earliest-joined CONNECTED seat

    // v32 — pin the mechanism (it was never pinned: the old test hid
    // Ana without ever showing she was connected first, so her
    // suspension could have come from setup-time backgrounding
    // instead of the test's own hideTab, and the leave would have
    // skipped her vacuously). Reset the room to a known state first:
    // front the host (resumes it, cancels the stale setup-time grace
    // — the crown must still be Teo's when he leaves), then front Ana
    // (resumes her — the poll below proves she is observably
    // connected), then the test's own hideTab suspends her for real.
    // Front Ben LAST, before the leave: fronting Ana backgrounded
    // him, and the leave must find him CONNECTED — he is the
    // earliest-joined connected seat the crown skips to. Only one
    // page is front at a time, so the order is load-bearing: host,
    // then Ana (hide), then Ben (leave). Geolocation is granted, so
    // fixes flow and every resume holds.
    await hostPage.bringToFront();
    await firstGuest.bringToFront();
    const anaId = await playerIdOf(firstGuest, roomId, GUEST_NAMES[0]);
    await expect
      .poll(
        async () =>
          (await getDemoRoom(firstGuest, roomId))?.players.find((p) => p.playerId === anaId)
            ?.connectionState,
        { timeout: 5000 },
      )
      .toBe('connected');

    // Ana backgrounds her tab: suspended, still in the room.
    await hideTab(firstGuest);
    await secondGuest.bringToFront();
    // Fresh fix for the still-visible seats: resets their (4a) 30 s
    // clock, so the tail below is safe even on a slow CI worker.
    await context.setGeolocation(CENTRE_NUDGED);
    await expect
      .poll(
        async () =>
          (await getDemoRoom(firstGuest, roomId))?.players.find((p) => p.playerId === anaId)
            ?.connectionState,
        { timeout: 5000 },
      )
      .toBe('suspended');

    // The host leaves: the crown must skip suspended Ana and go to Ben.
    await hostPage.getByRole('navigation', { name: 'Game' }).getByRole('button', { name: '···' }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'More' });
    await sheet.getByRole('button', { name: 'Leave game' }).click();
    await sheet.getByRole('button', { name: 'Tap again to leave' }).click();
    await hostPage.waitForURL('/');

    const benId = await playerIdOf(secondGuest, roomId, GUEST_NAMES[1]);
    await expect
      .poll(async () => (await getDemoRoom(secondGuest, roomId))?.room.hostPlayerId, {
        timeout: 5000,
      })
      .toBe(benId);
    await expectEndRound(secondGuest, true);
    await expectEndRound(firstGuest, false);

    expectNoPageErrors(errors);
  });

  test('joining a deleted lobby code is refused, not resurrected', async ({ context }) => {
    const hostPage = await context.newPage();
    const { code } = await createHostRoom(hostPage, HOST_NAME);
    const roomId = hostPage.url().split('/room/')[1] ?? '';
    await deleteDemoRoomFromStore(hostPage, roomId);
    await hostPage.waitForURL('/');

    // The code dies with the room: a joiner gets a plain refusal.
    const joiner = await context.newPage();
    await joiner.goto('/join');
    await expect(joiner.getByRole('heading', { name: 'Join a game' })).toBeVisible();
    await joiner.getByLabel('Room code').fill(code);
    await joiner.getByLabel('Your codename').fill('Cara');
    await joiner.getByRole('button', { name: 'JOIN', exact: true }).click();
    await expect(joiner.getByText("That code didn't match a room — check it and try again.")).toBeVisible();
  });
});

test.describe('manual Retry discovers a deletion the socket missed (live)', () => {
  test.skip(!LIVE, 'live-only spec — needs NEXT_PUBLIC_WORKER_URL on the dev server');

  test('guest offline while the host ends the round: Retry lands home with the message', async ({
    context,
  }) => {
    const { hostPage, guestPages } = await startDemoMatch(context);
    const guest = guestPages[0]!;
    const errors = collectPageErrors(guest);

    // Take ONLY the guest offline (per-page CDP emulation — the whole
    // context must stay online so the host can still end the round):
    // the guest misses `room.deleted`, its socket exhausts reconnects
    // (max 5 attempts, ~15–31 s of backoff), and the auto-probe fires
    // while offline — a non-404 failure, so it re-arms instead of
    // dying (fix round 1, W2).
    const cdp = await context.newCDPSession(guest);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });

    // Host ends the round while the guest is dark — the room is deleted.
    await hostPage.getByRole('navigation', { name: 'Game' }).getByRole('button', { name: '···' }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'More' });
    await sheet.getByRole('button', { name: 'End the round' }).click();
    await hostPage.waitForURL('/');

    // Back online: the guest sits in reconnect-failed with a Retry
    // button, and the manual Retry re-fetches state — 404 — and goes
    // home with the one plain message (fix round 1, W1).
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await expect(guest.getByRole('button', { name: 'Retry', exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await guest.getByRole('button', { name: 'Retry', exact: true }).click();
    await guest.waitForURL('/');
    await expect(guest.getByText(ROOM_DELETED_MESSAGE)).toBeVisible();

    expectNoPageErrors(errors);
  });
});
