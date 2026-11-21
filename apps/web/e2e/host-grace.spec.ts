/**
 * host-grace.spec.ts — v24 host reconnect grace (founder decision D1,
 * 2026-11-21): "Host stays host until they've really left. If the
 * disconnected host comes back within 30 s they stay host, otherwise
 * the earliest joiner becomes host. Voluntary leave counts as really
 * left → immediate succession." Grace applies to disconnects
 * ('network-lost' / 'heartbeat-timeout') only.
 *
 * Text-only assertions throughout (DOM text, roles, element state).
 *
 * Demo specs run by default (no Worker URL): the demo store mirrors
 * the server grace (`hostGraceEndsAtMs`, 30 s, `expireHostGrace` on
 * the 1 s poll). The suspend trigger is the real one — the
 * visibilitychange handler in `useRoomState` suspends the seat on
 * tab-hide and resumes it on tab-visible — driven here with the same
 * `hideTab` simulation `host-cancel-room-deleted.spec.ts` uses
 * (a faked `document.hidden` + a dispatched `visibilitychange`).
 * The expiry test fast-forwards the deadline in localStorage instead
 * of waiting out the real 30 s, the same white-box pattern as
 * `forceDemoMatchEnd` in helpers.ts.
 * Live specs skip unless NEXT_PUBLIC_WORKER_URL is set on the dev
 * server (same gating as the host-rules live specs). They are listed
 * for founder CI, not run in this VM.
 *
 * v24 fix round (F5): the hostless re-trigger — a grace that expires
 * with no successor, or a voluntary leave with no connected
 * successor, leaves the crown with the gone host until the first
 * seat joins or resumes, which then takes it.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  collectPageErrors,
  DEMO_ROOMS_KEY,
  expectNoPageErrors,
  getDemoRoom,
  GUEST_NAMES,
  HOST_NAME,
  LIVE,
  playerIdOf,
  readyAll,
  setupThreePlayerLobby,
  startMatchAsHost,
  waitForPlay,
} from './helpers';

const WAITING_LINE = 'Waiting for the host to reconnect…';

/** Simulate a tab-hidden disconnect: the visibility handler suspends the seat in the demo store. */
async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Simulate the tab coming back: the visibility handler resumes the seat. */
async function showTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** White-box demo helper: move the host grace deadline into the past so the next 1 s poll expires it. Demo-only; localStorage is the demo store. */
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

/** Read the demo grace deadline (null when no grace is running). Demo-only. */
async function getDemoGraceEndsAtMs(page: Page, roomId: string): Promise<number | null> {
  return page.evaluate(
    ({ key, roomId: id }) => {
      const rooms = JSON.parse(window.localStorage.getItem(key) ?? '[]') as Array<{
        room: { roomId: string };
        hostGraceEndsAtMs?: number | null;
      }>;
      return rooms.find((r) => r.room.roomId === id)?.hostGraceEndsAtMs ?? null;
    },
    { key: DEMO_ROOMS_KEY, roomId },
  );
}

test.describe('host grace (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('demo host suspend shows the waiting line; the host keeps host during the grace', async ({
    context,
  }) => {
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const anaErrors = collectPageErrors(anaPage);
    const hostId = await playerIdOf(hostPage, roomId, HOST_NAME);

    // Before: no waiting line anywhere, and only the host has host controls.
    await expect(anaPage.getByRole('status', { name: WAITING_LINE })).toHaveCount(0);
    await expect(hostPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toBeVisible();
    await expect(anaPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toHaveCount(0);

    // The host backgrounds the tab: the demo store suspends the seat
    // and starts the 30 s grace — no transfer yet.
    await hideTab(hostPage);
    await expect
      .poll(
        async () =>
          (await getDemoRoom(anaPage, roomId))?.players.find((p) => p.playerId === hostId)
            ?.connectionState,
        { timeout: 5000 },
      )
      .toBe('suspended');
    await expect
      .poll(() => getDemoGraceEndsAtMs(anaPage, roomId), { timeout: 5000 })
      .not.toBeNull();

    // The waiting line appears for the joiners on the next poll…
    await expect(anaPage.getByRole('status', { name: WAITING_LINE })).toBeVisible({
      timeout: 10000,
    });
    // …but the suspended host themself never sees it, and the crown
    // has not moved: Ana still has no host controls.
    await expect(hostPage.getByRole('status', { name: WAITING_LINE })).toHaveCount(0);
    await expect(
      anaPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(async () => (await getDemoRoom(anaPage, roomId))?.room.hostPlayerId, {
        timeout: 5000,
      })
      .toBe(hostId);
    await expect(
      benPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toHaveCount(0);

    expectNoPageErrors(anaErrors);
  });

  test('demo host resumes within the grace and stays host', async ({ context }) => {
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const anaErrors = collectPageErrors(anaPage);
    const hostId = await playerIdOf(hostPage, roomId, HOST_NAME);

    await hideTab(hostPage);
    await expect(anaPage.getByRole('status', { name: WAITING_LINE })).toBeVisible({
      timeout: 10000,
    });

    // The host comes back inside the grace: the tab-visible handler
    // resumes the seat and cancels the grace — no transfer, ever.
    await showTab(hostPage);
    await expect
      .poll(
        async () =>
          (await getDemoRoom(anaPage, roomId))?.players.find((p) => p.playerId === hostId)
            ?.connectionState,
        { timeout: 5000 },
      )
      .toBe('connected');
    await expect.poll(() => getDemoGraceEndsAtMs(anaPage, roomId), { timeout: 5000 }).toBeNull();

    // The line goes away on the next poll and the host keeps the crown.
    await expect(anaPage.getByRole('status', { name: WAITING_LINE })).toHaveCount(0);
    await expect
      .poll(async () => (await getDemoRoom(anaPage, roomId))?.room.hostPlayerId, {
        timeout: 5000,
      })
      .toBe(hostId);
    await expect(hostPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toBeVisible();
    await expect(
      anaPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toHaveCount(0);

    expectNoPageErrors(anaErrors);
  });

  test('demo grace expiry transfers to the earliest joiner', async ({ context }) => {
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const anaErrors = collectPageErrors(anaPage);
    const anaId = await playerIdOf(anaPage, roomId, GUEST_NAMES[0]);

    await hideTab(hostPage);
    await expect(anaPage.getByRole('status', { name: WAITING_LINE })).toBeVisible({
      timeout: 10000,
    });

    // Fast-forward the deadline: the next 1 s poll expires the grace
    // and the crown moves to the earliest-joined remaining seat.
    await fastForwardDemoGrace(anaPage, roomId);
    await expect
      .poll(async () => (await getDemoRoom(anaPage, roomId))?.room.hostPlayerId, {
        timeout: 10000,
      })
      .toBe(anaId);
    await expect.poll(() => getDemoGraceEndsAtMs(anaPage, roomId), { timeout: 5000 }).toBeNull();

    // No reload anywhere: Ana gains the host controls, the line is
    // gone, and Ben stays a joiner.
    await expect(anaPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toBeVisible();
    await expect(anaPage.getByRole('status', { name: WAITING_LINE })).toHaveCount(0);
    await expect(hostPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toHaveCount(0);
    await expect(
      benPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toHaveCount(0);

    // The new host can actually use host powers: start the match.
    await readyAll([anaPage, benPage]);
    await expect(anaPage.getByRole('button', { name: 'START GAME', exact: true })).toBeVisible();
    await startMatchAsHost(anaPage);
    await waitForPlay(benPage);
    expectNoPageErrors(anaErrors);
  });

  test('demo grace expires with no successor: the first seat to resume later becomes host', async ({
    context,
  }) => {
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const anaErrors = collectPageErrors(anaPage);
    const hostId = await playerIdOf(hostPage, roomId, HOST_NAME);
    const anaId = await playerIdOf(anaPage, roomId, GUEST_NAMES[0]);

    // Both joiners background first, then the host: the grace starts
    // with nobody connected to take the crown.
    await hideTab(anaPage);
    await hideTab(benPage);
    await hideTab(hostPage);
    await expect(anaPage.getByRole('status', { name: WAITING_LINE })).toBeVisible({
      timeout: 10000,
    });

    // Fast-forward the deadline: the next 1 s poll expires the grace
    // with no successor — the suspended host keeps the crown.
    await fastForwardDemoGrace(anaPage, roomId);
    await expect
      .poll(async () => (await getDemoRoom(anaPage, roomId))?.room.hostPlayerId, {
        timeout: 10000,
      })
      .toBe(hostId);
    await expect.poll(() => getDemoGraceEndsAtMs(anaPage, roomId), { timeout: 5000 }).toBeNull();
    await expect(
      anaPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toHaveCount(0);

    // Ana comes back: her tab-visible resume re-triggers succession
    // (F5) and she — earliest-joined connected seat — takes the crown.
    await showTab(anaPage);
    await expect
      .poll(async () => (await getDemoRoom(anaPage, roomId))?.room.hostPlayerId, {
        timeout: 10000,
      })
      .toBe(anaId);
    await expect(anaPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toBeVisible();
    await expect(anaPage.getByRole('status', { name: WAITING_LINE })).toHaveCount(0);
    await expect(
      benPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toHaveCount(0);

    expectNoPageErrors(anaErrors);
  });

  test('demo host leaves with no connected successor: the first seat to resume later becomes host', async ({
    context,
  }) => {
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const anaErrors = collectPageErrors(anaPage);
    const hostId = await playerIdOf(hostPage, roomId, HOST_NAME);
    const anaId = await playerIdOf(anaPage, roomId, GUEST_NAMES[0]);

    // Both joiners background their tabs: suspended, still in the room.
    await hideTab(anaPage);
    await hideTab(benPage);
    await expect
      .poll(
        async () =>
          (await getDemoRoom(anaPage, roomId))?.players.find((p) => p.playerId === anaId)
            ?.connectionState,
        { timeout: 5000 },
      )
      .toBe('suspended');

    // The host leaves through the real UI — with nobody connected
    // there is no successor, so the crown has nowhere to go:
    // hostPlayerId still points at the leaver and nobody is host.
    await hostPage.getByRole('button', { name: 'Leave', exact: true }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'Leave room?' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Leave room', exact: true }).click();
    await hostPage.waitForURL('/');
    await expect
      .poll(async () => (await getDemoRoom(anaPage, roomId))?.room.hostPlayerId, {
        timeout: 10000,
      })
      .toBe(hostId);
    await expect(anaPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toHaveCount(0);

    // Ana comes back: her tab-visible resume re-triggers succession
    // (F5) and she — earliest-joined connected seat — takes the crown.
    await showTab(anaPage);
    await expect
      .poll(async () => (await getDemoRoom(anaPage, roomId))?.room.hostPlayerId, {
        timeout: 10000,
      })
      .toBe(anaId);
    await expect(anaPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toBeVisible();
    await expect(anaPage.getByRole('status', { name: WAITING_LINE })).toHaveCount(0);
    await expect(
      benPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toHaveCount(0);

    expectNoPageErrors(anaErrors);
  });

  test('demo voluntary host leave transfers immediately — no grace, no waiting line', async ({
    context,
  }) => {
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const anaErrors = collectPageErrors(anaPage);
    const anaId = await playerIdOf(anaPage, roomId, GUEST_NAMES[0]);

    // The host leaves through the real UI: Leave → confirm sheet → Leave room.
    await hostPage.getByRole('button', { name: 'Leave', exact: true }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'Leave room?' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Leave room', exact: true }).click();
    await hostPage.waitForURL('/');

    // Immediate succession: Ana is host on the next poll — no 30 s
    // wait, and the waiting line never appears for anyone.
    await expect
      .poll(async () => (await getDemoRoom(anaPage, roomId))?.room.hostPlayerId, {
        timeout: 10000,
      })
      .toBe(anaId);
    await expect.poll(() => getDemoGraceEndsAtMs(anaPage, roomId), { timeout: 5000 }).toBeNull();
    await expect(anaPage.getByRole('button', { name: 'Cancel lobby', exact: true })).toBeVisible();
    await expect(anaPage.getByRole('status', { name: WAITING_LINE })).toHaveCount(0);
    await expect(
      benPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toHaveCount(0);

    expectNoPageErrors(anaErrors);
  });
});

test.describe('host grace (live)', () => {
  test.skip(!LIVE, 'live-only spec — needs NEXT_PUBLIC_WORKER_URL on the dev server');

  test('live host disconnect + return within 30 s stays host', async ({ context }) => {
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const anaErrors = collectPageErrors(anaPage);

    // A reload drops the socket (grace starts) and re-hellos with the
    // saved session within seconds — well inside the grace.
    await hostPage.reload();
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expect(
      hostPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toBeVisible({ timeout: 20000 });

    // The host kept the crown: its host controls are back, and Ana
    // never gained host controls.
    await expect(
      anaPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toHaveCount(0);
    await expect(
      anaPage.getByRole('button', { name: 'START GAME', exact: true }),
    ).toHaveCount(0);
    expectNoPageErrors(anaErrors);
  });

  test('live host returns after the transfer is a regular player', async ({ context }) => {
    test.setTimeout(180000);
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const anaErrors = collectPageErrors(anaPage);
    const hostErrors = collectPageErrors(hostPage);

    // Take ONLY the host offline (per-page CDP emulation — the whole
    // context must stay online so Ana can still receive the transfer):
    // the socket dies, the grace runs, and the transfer lands at ~30 s.
    const cdp = await context.newCDPSession(hostPage);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });

    // The earliest joiner (Ana) becomes host — Ben stays a guest.
    await expect(
      anaPage.getByRole('button', { name: 'START GAME', exact: true }),
    ).toBeVisible({ timeout: 60000 });
    await expect(
      anaPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      benPage.getByRole('button', { name: 'START GAME', exact: true }),
    ).toHaveCount(0);

    // Back online: the host's socket exhausted its reconnects while
    // dark, so it sits in reconnect-failed — the manual Retry
    // re-fetches state. (If an in-flight retry already re-synced the
    // page, it lands straight on the guest lobby instead — accept
    // either path, the end state is the same.)
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    // `expect.poll` does not return the polled value, so poll by hand
    // until one of the two end states shows.
    let returnPath: 'retry' | 'guest' | 'pending' = 'pending';
    const retryDeadline = Date.now() + 90000;
    while (Date.now() < retryDeadline && returnPath === 'pending') {
      if (
        (await hostPage.getByRole('button', { name: 'Retry', exact: true }).count()) > 0
      ) {
        returnPath = 'retry';
      } else if (
        (await hostPage
          .getByRole('button', { name: 'WAITING FOR THE HOST TO START' })
          .count()) > 0
      ) {
        returnPath = 'guest';
      } else {
        await hostPage.waitForTimeout(1000);
      }
    }
    expect(
      returnPath,
      'expected the returned host page to reach Retry or the guest lobby',
    ).not.toBe('pending');
    if (returnPath === 'retry') {
      await hostPage.getByRole('button', { name: 'Retry', exact: true }).click();
    }
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible({
      timeout: 20000,
    });

    // The returned host is a regular player now: no host controls,
    // just the guest waiting state — and Ana is still the host.
    await expect(hostPage.getByRole('button', { name: 'START GAME', exact: true })).toHaveCount(
      0,
    );
    await expect(
      hostPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toHaveCount(0);
    await expect(
      hostPage.getByRole('button', { name: 'WAITING FOR THE HOST TO START' }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      anaPage.getByRole('button', { name: 'START GAME', exact: true }),
    ).toBeVisible({ timeout: 10000 });
    expectNoPageErrors(anaErrors);
    expectNoPageErrors(hostErrors);
  });
});
