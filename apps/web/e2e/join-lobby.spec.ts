/**
 * join-lobby.spec.ts — join by code, the lobby-is-setup screen, the
 * "I'm ready" tap, the start gate, and the F2 demo guest auto-navigate.
 *
 * Demo tests run without NEXT_PUBLIC_WORKER_URL; the two live tests at the
 * end run only when it is set (they drive the same UI against the Worker).
 * Text-only: DOM text and roles, no screenshots.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  GUEST_NAMES,
  HOST_NAME,
  collectPageErrors,
  createHostRoom,
  expectDemoMode,
  expectNoPageErrors,
  joinRoomAsGuest,
  readyAll,
  setupThreePlayerLobby,
  startMatchAsHost,
  waitForPlay,
} from './helpers';

test.describe('join + lobby (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('join by code lands in the lobby with both players on the roster', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    const errors = collectPageErrors(hostPage);
    const { code } = await createHostRoom(hostPage);
    await expectDemoMode(hostPage);
    const guestPage = await joinRoomAsGuest(context, code, GUEST_NAMES[0]);
    await expect(guestPage.locator('section[aria-label="Game code"] .pakdam-code')).toHaveText(code);
    await expect(hostPage.getByText('2 joined')).toBeVisible();
    // The roster renders the current player's name as "Teo (you)" in one
    // span (Roster.tsx), so the host's own name never matches exactly.
    await expect(hostPage.getByText(`${HOST_NAME} (you)`, { exact: true })).toBeVisible();
    await expect(hostPage.getByText(GUEST_NAMES[0], { exact: true })).toBeVisible();
    await expect(hostPage.getByText('HOST', { exact: true })).toBeVisible();
    expectNoPageErrors(errors);
  });

  test('lobby-is-setup renders: code card, summary strip, rules, roster, ready, blocked start', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    const { code } = await createHostRoom(hostPage);
    await expect(hostPage.getByText('Game code')).toBeVisible();
    await expect(hostPage.locator('section[aria-label="Game code"] .pakdam-code')).toHaveText(code);
    await expect(hostPage.getByText('Share the code — no account needed to join.')).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'Share code' })).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'Settings' })).toBeVisible();
    // Summary strip: zone · hunters · ping interval · match length.
    await expect(hostPage.getByLabel('Game summary')).toContainText(
      '500m zone · 1 hunter · 3m pulse · 30m',
    );
    // Mode card.
    await expect(hostPage.getByText('Game mode')).toBeVisible();
    await expect(hostPage.getByText("Tagged? You're out. Watch live.")).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'Change', exact: true })).toBeVisible();
    // Rules + teams.
    await expect(hostPage.getByText('Round length')).toBeVisible();
    await expect(hostPage.getByText('Head start')).toBeVisible();
    await expect(hostPage.getByText('Pings every')).toBeVisible();
    await expect(hostPage.getByText('Zone shrinks')).toBeVisible();
    await expect(hostPage.getByText('Play zone')).toBeVisible();
    await expect(hostPage.getByText('Balance hunters')).toBeVisible();
    await expect(hostPage.getByText('Random hunters')).toBeVisible();
    await expect(hostPage.getByText('Show ping history')).toBeVisible();
    // Roster + readiness + blocked start (1 player). The host is created
    // ready, so the lobby opens on the flipped ready state.
    await expect(hostPage.getByRole('heading', { name: 'Players' })).toBeVisible();
    await expect(hostPage.getByText('1 joined')).toBeVisible();
    await expect(
      hostPage.getByRole('button', { name: /I'm ready — tap to change/ }),
    ).toBeVisible();
    await expect(
      hostPage.getByRole('button', { name: 'NEED 3+ PLAYERS TO START' }),
    ).toBeVisible();
  });

  test('COPY flips to COPIED ✓ for a few seconds', async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await context.newPage();
    const { code } = await createHostRoom(hostPage);
    await hostPage.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(hostPage.getByRole('button', { name: 'Copied ✓' })).toBeVisible();
    await expect(hostPage.locator('section[aria-label="Game code"] .pakdam-code')).toHaveText(code);
    await context.close();
  });

  test("I'm ready flips to the ready state and back again", async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    // The host is created ready (live DO + demo store agree) — the lobby
    // opens on the flipped state, not on "I'm ready".
    await expect(
      hostPage.getByRole('button', { name: /I'm ready — tap to change/ }),
    ).toBeVisible();
    await expect(hostPage.getByText('READY', { exact: true })).toBeVisible();
    await hostPage.getByRole('button', { name: /I'm ready — tap to change/ }).click();
    await expect(hostPage.getByRole('button', { name: "I'm ready", exact: true })).toBeVisible();
    await hostPage.getByRole('button', { name: "I'm ready", exact: true }).click();
    await expect(
      hostPage.getByRole('button', { name: /I'm ready — tap to change/ }),
    ).toBeVisible();
    await expect(hostPage.getByText('READY', { exact: true })).toBeVisible();
  });

  test('start gate blocked below 3 players, and the tap says why', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    await hostPage.getByRole('button', { name: 'NEED 3+ PLAYERS TO START' }).click();
    await expect(
      hostPage.getByText('Need at least 3 players — share the room code above.'),
    ).toBeVisible();
    await expect(hostPage).toHaveURL(/\/room\/[^/]+$/);
  });

  test('start gate blocked until everyone is ready, and the tap names who is waiting', async ({
    context,
  }) => {
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    // Host is created ready — guests not ready.
    await expect(
      hostPage.getByRole('button', { name: /I'm ready — tap to change/ }),
    ).toBeVisible();
    await expect(
      hostPage.getByRole('button', { name: 'WAITING FOR EVERYONE TO BE READY' }),
    ).toBeVisible();
    await hostPage.getByRole('button', { name: 'WAITING FOR EVERYONE TO BE READY' }).click();
    await expect(hostPage.getByText(`Waiting for: ${GUEST_NAMES[0]}, ${GUEST_NAMES[1]}.`)).toBeVisible();
    // A guest sees the host-only bar instead of a start button.
    await expect(
      guestPages[0]!.getByRole('button', { name: 'WAITING FOR THE HOST TO START' }),
    ).toBeVisible();
    await guestPages[0]!.getByRole('button', { name: 'WAITING FOR THE HOST TO START' }).click();
    await expect(guestPages[0]!.getByText('Only the host can start the game.')).toBeVisible();
  });

  test('start gate opens when all 3 players are ready', async ({ context }) => {
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    await readyAll([hostPage, ...guestPages]);
    await expect(hostPage.getByRole('button', { name: 'START GAME', exact: true })).toBeVisible();
  });

  test('F2: demo guests auto-navigate to /play after the host starts', async ({ context }) => {
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    await readyAll([hostPage, ...guestPages]);
    await startMatchAsHost(hostPage);
    for (const guest of guestPages) {
      await waitForPlay(guest);
      await expect(guest.getByText(/Time left|Head start/)).toBeVisible();
    }
  });

  test('host can remove a guest from the roster (confirm dialog)', async ({ context }) => {
    const { hostPage } = await setupThreePlayerLobby(context);
    await expect(hostPage.getByText(GUEST_NAMES[0], { exact: true })).toBeVisible();
    hostPage.on('dialog', (dialog) => void dialog.accept());
    await hostPage
      .getByRole('button', { name: `Options for ${GUEST_NAMES[0]}`, exact: true })
      .click();
    await hostPage.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(hostPage.getByText(GUEST_NAMES[0], { exact: true })).toBeHidden({ timeout: 10000 });
    await expect(hostPage.getByText('2 joined')).toBeVisible();
  });

  test('Leave asks for confirmation and returns Home', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    hostPage.on('dialog', (dialog) => void dialog.accept());
    await hostPage.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(hostPage).toHaveURL(/\/$/);
    await expect(hostPage.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
  });
});

test.describe('join + lobby (live)', () => {
  test.skip(!LIVE, 'live-only spec — needs NEXT_PUBLIC_WORKER_URL on the dev server');

  test('join by code on the live Worker lands in the lobby', async ({ context }) => {
    const hostPage = await context.newPage();
    const { code } = await createHostRoom(hostPage);
    const guestPage = await joinRoomAsGuest(context, code, GUEST_NAMES[0]);
    await expect(guestPage.locator('section[aria-label="Game code"] .pakdam-code')).toHaveText(code);
    await expect(hostPage.getByText('2 joined')).toBeVisible();
    await expect(hostPage.getByText(GUEST_NAMES[0], { exact: true })).toBeVisible();
  });

  test('live start gate: 3 players, all ready, host starts, guests reach /play', async ({
    context,
  }) => {
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    await readyAll([hostPage, ...guestPages]);
    await startMatchAsHost(hostPage);
    for (const guest of guestPages) await waitForPlay(guest);
  });
});
