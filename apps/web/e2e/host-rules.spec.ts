/**
 * host-rules.spec.ts — v23 host/lobby rules (founder decisions, 2026-11-21):
 *   R1 — if the host cancels the match, the lobby is deleted.
 *   R2 — if the host gets disconnected, the player who joined the lobby
 *        first after the host automatically becomes the host (next
 *        earliest joiner if that player has also left).
 *
 * Text-only assertions throughout (DOM text, roles, element state).
 *
 * Demo specs run by default (no Worker URL): the demo store mirrors the
 * server deletion (`deleteDemoRoom` + `lib/room-deleted.ts`, one plain
 * message: "The host cancelled — this lobby is gone."). Demo has NO
 * socket layer, so demo host-disconnect succession does not exist —
 * Rule 2 is covered by the LIVE specs below, where the close is a real
 * socket close against the Worker.
 * Live specs skip unless NEXT_PUBLIC_WORKER_URL is set on the dev
 * server (same gating as join-lobby / session-restore live specs).
 */
import { expect, test, type Page } from '@playwright/test';
import {
  LIVE,
  SESSION_STORAGE_KEY,
  collectPageErrors,
  expectDemoMode,
  expectNoPageErrors,
  getDemoRoom,
  joinRoomAsGuest,
  readyAll,
  setupThreePlayerLobby,
  startDemoMatch,
  startMatchAsHost,
  waitForPlay,
  type LobbySetup,
} from './helpers';

const DELETED_MESSAGE = 'The host cancelled — this lobby is gone.';

/** Home shows the one plain deletion notice (role=status, one-shot). */
async function expectDeletedHome(page: Page): Promise<void> {
  await page.waitForURL('/', { timeout: 15000 });
  await expect(page.getByRole('status', { name: DELETED_MESSAGE })).toBeVisible({
    timeout: 10000,
  });
}

/**
 * After a host transfer the new host's page mints a host token in the
 * background (lobby A2 effect). Wait for it before tapping START GAME
 * so the first host action does not race the mint.
 */
async function waitForHostToken(page: Page, roomId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ key, id }) => {
            const sessions = JSON.parse(
              window.sessionStorage.getItem(key) ?? '[]',
            ) as Array<{ roomId: string; hostToken?: string }>;
            return sessions.find((s) => s.roomId === id)?.hostToken ?? null;
          },
          { key: SESSION_STORAGE_KEY, id: roomId },
        ),
      { timeout: 15000 },
    )
    .not.toBeNull();
}

/** Join by code must fail with the freed code (demo + live copy differ). */
async function expectJoinByDeadCode(
  page: Page,
  code: string,
  expectedError: RegExp,
): Promise<void> {
  await page.goto('/join');
  await expect(page.getByRole('heading', { name: 'Join a game' })).toBeVisible();
  await page.getByLabel('Room code').fill(code);
  await page.getByLabel('Your codename').fill('Dee');
  await page.getByRole('button', { name: 'JOIN', exact: true }).click();
  await expect(page.getByText(expectedError)).toBeVisible({ timeout: 10000 });
  await expect(page).toHaveURL(/\/join/);
}

test.describe('host rules (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('R1 host cancels the lobby: every player lands home with the one plain message, and the code is dead', async ({
    context,
  }) => {
    const { hostPage, guestPages, code, roomId } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const hostErrors = collectPageErrors(hostPage);
    const anaErrors = collectPageErrors(anaPage);
    const benErrors = collectPageErrors(benPage);
    await expectDemoMode(hostPage);

    // Guests never see the host-only cancel control.
    for (const guest of guestPages) {
      await expect(
        guest.getByRole('button', { name: 'Cancel lobby', exact: true }),
      ).toHaveCount(0);
    }

    // Host cancels: button -> confirm sheet -> confirm.
    await hostPage.getByRole('button', { name: 'Cancel lobby', exact: true }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'Cancel lobby?' });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByText('Cancel this lobby? The lobby will be deleted and every player goes back home.'),
    ).toBeVisible();
    await sheet.getByRole('button', { name: 'Cancel lobby', exact: true }).click();

    // Host lands home with the one plain message…
    await expectDeletedHome(hostPage);
    // …and so does every guest (demo poll finds the room gone).
    await expectDeletedHome(anaPage);
    await expectDeletedHome(benPage);
    // The demo room itself is gone from the store.
    expect(await getDemoRoom(hostPage, roomId)).toBeNull();

    // Rejoin by the same code fails.
    const joinPage = await context.newPage();
    await expectJoinByDeadCode(
      joinPage,
      code,
      /That code didn't match a room — check it and try again\./,
    );

    expectNoPageErrors(hostErrors);
    expectNoPageErrors(anaErrors);
    expectNoPageErrors(benErrors);
  });

  test('R1 host ends the round from play: every player lands home, never results', async ({
    context,
  }) => {
    const { hostPage, guestPages, roomId } = await startDemoMatch(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const hostErrors = collectPageErrors(hostPage);
    const anaErrors = collectPageErrors(anaPage);

    // Guests never see the host-only end control in the More sheet.
    const guestNav = anaPage.getByRole('navigation', { name: 'Game' });
    await guestNav.getByRole('button', { name: '···' }).click();
    await expect(anaPage.getByRole('button', { name: 'End the round' })).toHaveCount(0);
    await anaPage.keyboard.press('Escape');

    // Host ends the round from the More sheet.
    const hostNav = hostPage.getByRole('navigation', { name: 'Game' });
    await hostNav.getByRole('button', { name: '···' }).click();
    await hostPage.getByRole('button', { name: 'End the round' }).click();

    await expectDeletedHome(hostPage);
    await expectDeletedHome(anaPage);
    await expectDeletedHome(benPage);
    // Nobody went to results.
    for (const page of [hostPage, anaPage, benPage]) {
      await expect(page).not.toHaveURL(/\/results/);
    }
    expect(await getDemoRoom(hostPage, roomId)).toBeNull();

    expectNoPageErrors(hostErrors);
    expectNoPageErrors(anaErrors);
  });

  test('R1 a player who reopens the lobby after deletion lands home with the plain message', async ({
    context,
  }) => {
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!;
    const anaErrors = collectPageErrors(anaPage);

    // Ana navigates away BEFORE the cancel, so her seat stays intact
    // (she never goes through the auto-home path that drops the seat).
    // Reopening the lobby URL afterwards is a fresh first paint with a
    // seat but no room — that must land home with the plain message,
    // not on a stale lobby or an error screen.
    await anaPage.goto('/');
    await expect(anaPage).toHaveURL('/');

    await hostPage.getByRole('button', { name: 'Cancel lobby', exact: true }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'Cancel lobby?' });
    await sheet.getByRole('button', { name: 'Cancel lobby', exact: true }).click();
    await expectDeletedHome(hostPage);

    await anaPage.goto(`/room/${roomId}`);
    await expectDeletedHome(anaPage);
    expectNoPageErrors(anaErrors);
  });
});

test.describe('host rules (live)', () => {
  test.skip(!LIVE, 'live-only spec — needs NEXT_PUBLIC_WORKER_URL on the dev server');

  test('R2 host disconnect: the earliest joiner becomes host and can start the match', async ({
    context,
  }) => {
    const { hostPage, guestPages, roomId } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const anaErrors = collectPageErrors(anaPage);
    await readyAll([hostPage, anaPage, benPage]);

    // Ana is a guest: no host controls before the disconnect.
    await expect(
      anaPage.getByRole('button', { name: 'START GAME', exact: true }),
    ).toHaveCount(0);
    await expect(
      anaPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toHaveCount(0);

    // The host's page closes: a real socket close against the Worker.
    await hostPage.close();

    // The earliest joiner (Ana) becomes host — her controls appear
    // without a reload, and Ben stays a guest. v24 (D1): the
    // disconnect starts the 30 s host grace, so the crown lands at
    // ~30 s, not at once — the 60 s bound matches the host-grace
    // live spec.
    await expect(
      anaPage.getByRole('button', { name: 'START GAME', exact: true }),
    ).toBeVisible({ timeout: 60000 });
    await expect(
      anaPage.getByRole('button', { name: 'Cancel lobby', exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      benPage.getByRole('button', { name: 'START GAME', exact: true }),
    ).toHaveCount(0);

    // The new host can actually use host powers: start the match.
    await waitForHostToken(anaPage, roomId);
    await startMatchAsHost(anaPage);
    await waitForPlay(benPage);
    expectNoPageErrors(anaErrors);
  });

  test('R2 host + earliest joiner disconnect at once: the next-earliest joiner becomes host', async ({
    context,
  }) => {
    const { hostPage, guestPages, code, roomId } = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const benErrors = collectPageErrors(benPage);
    // A fourth seat so "next-earliest" is observable.
    const caraPage = await joinRoomAsGuest(context, code, 'Cara');
    const allPages = [hostPage, anaPage, benPage, caraPage];
    await readyAll(allPages);

    // Host + earliest joiner (Ana) drop at the same instant.
    await Promise.all([hostPage.close(), anaPage.close()]);

    // Ben — the next-earliest remaining joiner — becomes host. v24
    // (D1): the disconnects start the 30 s host grace, so the crown
    // lands at ~30 s, not at once (60 s bound as above).
    await expect(
      benPage.getByRole('button', { name: 'START GAME', exact: true }),
    ).toBeVisible({ timeout: 60000 });
    await expect(
      caraPage.getByRole('button', { name: 'START GAME', exact: true }),
    ).toHaveCount(0);

    await waitForHostToken(benPage, roomId);
    await startMatchAsHost(benPage);
    await waitForPlay(caraPage);
    expectNoPageErrors(benErrors);
  });

  test('R1 live host ends the round: guests land home with the message and the code is dead', async ({
    context,
  }) => {
    const { hostPage, guestPages, code } = await startDemoMatch(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const anaErrors = collectPageErrors(anaPage);

    const hostNav = hostPage.getByRole('navigation', { name: 'Game' });
    await hostNav.getByRole('button', { name: '···' }).click();
    await hostPage.getByRole('button', { name: 'End the round' }).click();

    await expectDeletedHome(hostPage);
    await expectDeletedHome(anaPage);
    await expectDeletedHome(benPage);
    for (const page of [hostPage, anaPage, benPage]) {
      await expect(page).not.toHaveURL(/\/results/);
    }

    const joinPage = await context.newPage();
    await expectJoinByDeadCode(joinPage, code, /No live room for that code\./);
    expectNoPageErrors(anaErrors);
  });

  test('R1 live host cancels the lobby: guests land home with the message', async ({
    context,
  }) => {
    const { hostPage, guestPages }: LobbySetup = await setupThreePlayerLobby(context);
    const anaPage = guestPages[0]!; // Ana — joined first after the host
    const benPage = guestPages[1]!; // Ben
    const anaErrors = collectPageErrors(anaPage);

    await hostPage.getByRole('button', { name: 'Cancel lobby', exact: true }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'Cancel lobby?' });
    await sheet.getByRole('button', { name: 'Cancel lobby', exact: true }).click();

    await expectDeletedHome(hostPage);
    await expectDeletedHome(anaPage);
    await expectDeletedHome(benPage);
    expectNoPageErrors(anaErrors);
  });
});
