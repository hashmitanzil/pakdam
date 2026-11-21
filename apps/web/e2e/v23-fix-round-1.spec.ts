/**
 * v23 fix round 1 — probe/retry gaps (Arjun, live-only).
 *
 * The other fix-round-1 web tests live in host-cancel-room-deleted.spec.ts:
 * demo succession on suspension + host-leave skipping suspended seats
 * (W3), and manual Retry discovering a deletion the socket missed (W1/W2).
 * This file holds the two probe items that file does NOT cover:
 *
 *   T9(a) [Diya A5] — a second socket close after a transient first close
 *   still probes and discovers the deletion (the probe re-arms: on a
 *   non-404 probe outcome, and on reconnect). Play page, two offline
 *   cycles: the first close is transient (Retry reconnects), the second
 *   close — after the host ends the round — must land the guest home
 *   AUTOMATICALLY, with no second Retry tap.
 *   T9(c) [Zara D3] — the lobby page probes on 'reconnect-failed' too
 *   (not only on 'closed', which a network drop never produces — the
 *   socket goes 'reconnecting' and then 'reconnect-failed'). Lobby page:
 *   the guest goes offline, the host cancels while the guest's reconnect
 *   attempts are still running, and the guest must land home when the
 *   attempts exhaust — no Retry tap.
 *
 * Live-only: demo mode has no socket layer, so there is no close to
 * probe. The guest alone goes offline (per-page CDP emulation — the
 * whole context must stay online so the host can still end/cancel the
 * round). Text-only assertions throughout, no screenshots.
 */
import { expect, test } from '@playwright/test';
import {
  collectPageErrors,
  expectNoPageErrors,
  LIVE,
  setupThreePlayerLobby,
  startDemoMatch,
} from './helpers';

const DELETED_MESSAGE = 'The host cancelled — this lobby is gone.';

/** Take one page offline (CDP, per-target — the rest of the context stays online). */
async function goOffline(context: import('@playwright/test').BrowserContext, page: import('@playwright/test').Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  return cdp;
}

/** Bring a page back online (same CDP session). */
async function goOnline(cdp: import('@playwright/test').CDPSession) {
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
}

test.describe('probe re-arms after a transient close (live)', () => {
  test.skip(!LIVE, 'live-only spec — needs NEXT_PUBLIC_WORKER_URL on the dev server');

  test('T9(a) second socket close after a transient first close still probes and discovers the deletion', async ({
    context,
  }) => {
    test.setTimeout(180_000);
    const { hostPage, guestPages } = await startDemoMatch(context);
    const guest = guestPages[0]!;
    const errors = collectPageErrors(guest);

    // Cycle 1 — TRANSIENT close: the guest drops, exhausts reconnects
    // (the probe fires while offline — a network error, not a 404 —
    // so it re-arms instead of dying), then comes back and reconnects
    // with a manual Retry. The probe must be armed again afterwards.
    const cdp1 = await goOffline(context, guest);
    await expect(guest.getByRole('button', { name: 'Retry', exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await goOnline(cdp1);
    await guest.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(guest.getByRole('button', { name: 'Retry', exact: true })).toBeHidden({
      timeout: 30_000,
    });
    await expect(guest).toHaveURL(/\/room\/[^/]+\/play/);

    // Cycle 2 — the room is deleted while the guest is dark again.
    // The host ends the round within seconds of the drop, well before
    // the guest's reconnect attempts exhaust, so the probe that fires
    // on the second 'reconnect-failed' sees the 404.
    const cdp2 = await goOffline(context, guest);
    await guest.waitForTimeout(3000);
    await hostPage.getByRole('navigation', { name: 'Game' }).getByRole('button', { name: '···' }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'More' });
    await sheet.getByRole('button', { name: 'End the round' }).click();
    await hostPage.waitForURL('/');

    // No second Retry tap: the second close's probe must discover the
    // deletion by itself and send the guest home with the one message.
    await guest.waitForURL('/', { timeout: 90_000 });
    await expect(guest.getByText(DELETED_MESSAGE)).toBeVisible();
    await goOnline(cdp2);

    expectNoPageErrors(errors);
  });
});

test.describe('lobby probes on reconnect-failed (live)', () => {
  test.skip(!LIVE, 'live-only spec — needs NEXT_PUBLIC_WORKER_URL on the dev server');

  test('T9(c) lobby page probes on reconnect-failed and discovers the cancel', async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    const guest = guestPages[0]!;
    const errors = collectPageErrors(guest);

    // The guest drops; the host cancels while the guest's reconnect
    // attempts are still running (a few seconds in — well before the
    // ~15–31 s exhaustion). The probe that fires when the attempts
    // exhaust must see the 404: a network drop never produces a
    // 'closed' state (the socket goes 'reconnecting', then
    // 'reconnect-failed'), so a probe on 'closed' alone would never run.
    await goOffline(context, guest);
    await guest.waitForTimeout(3000);
    await hostPage.getByRole('button', { name: 'Cancel lobby', exact: true }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'Cancel lobby?' });
    await sheet.getByRole('button', { name: 'Cancel lobby', exact: true }).click();
    await hostPage.waitForURL('/');

    // No Retry tap: the lobby's reconnect-failed probe must discover
    // the deletion by itself.
    await guest.waitForURL('/', { timeout: 90_000 });
    await expect(guest.getByText(DELETED_MESSAGE)).toBeVisible();

    expectNoPageErrors(errors);
  });
});
