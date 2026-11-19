/**
 * session-restore.spec.ts — reload in lobby/play restores the session
 * (reconnect token in sessionStorage), and the no-seat state is handled
 * in one line. Demo tests + one live test. Text-only, no screenshots.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  SESSION_STORAGE_KEY,
  createHostRoom,
  dismissRoleReveal,
  joinRoomAsGuest,
  readyAll,
  setupThreePlayerLobby,
  startMatchAsHost,
} from './helpers';

test.describe('session restore (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('reload in the lobby restores the seat, code, roster and ready state', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    const { code } = await createHostRoom(hostPage);
    const guestPage = await joinRoomAsGuest(context, code, 'Ana');
    // Ana (guest) taps ready — the host is created ready, so the guest is
    // the seat whose ready state a tap actually sets.
    await guestPage.getByRole('button', { name: "I'm ready", exact: true }).click();
    await expect(guestPage.getByRole('button', { name: /I'm ready — tap to change/ })).toBeVisible();
    await guestPage.reload();
    await expect(guestPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expect(guestPage.locator('section[aria-label="Game code"] .pakdam-code')).toHaveText(code);
    await expect(guestPage.getByText('2 joined')).toBeVisible();
    await expect(guestPage.getByRole('button', { name: /I'm ready — tap to change/ })).toBeVisible();
  });

  test('reload in play restores the HUD (no re-join, no new role reveal)', async ({
    context,
  }) => {
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    await readyAll([hostPage, ...guestPages]);
    await startMatchAsHost(hostPage);
    await hostPage.waitForURL(/\/room\/[^/]+\/play/);
    await dismissRoleReveal(hostPage);
    await hostPage.reload();
    await expect(hostPage).toHaveURL(/\/room\/[^/]+\/play/);
    await expect(hostPage.getByText('Time left')).toBeVisible();
    await expect(hostPage.getByRole('navigation', { name: 'Game' })).toBeVisible();
  });

  test('guest reload in the lobby restores the guest seat', async ({ context }) => {
    const hostPage = await context.newPage();
    const { code } = await createHostRoom(hostPage);
    const guestPage = await joinRoomAsGuest(context, code, 'Ana');
    await guestPage.reload();
    await expect(guestPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expect(guestPage.getByText('Ana (you)')).toBeVisible();
    await expect(
      guestPage.getByRole('button', { name: 'WAITING FOR THE HOST TO START' }),
    ).toBeVisible();
  });

  test('the seat lives in one sessionStorage key and survives a reload', async ({ context }) => {
    const hostPage = await context.newPage();
    const { roomId } = await createHostRoom(hostPage);
    const stored = await hostPage.evaluate((key) => window.sessionStorage.getItem(key), SESSION_STORAGE_KEY);
    expect(stored).not.toBeNull();
    // One key holds an ARRAY of sessions (one per room the tab has joined).
    const sessions = JSON.parse(stored!) as Array<{ roomId?: string; playerId?: string }>;
    expect(Array.isArray(sessions)).toBe(true);
    const session = sessions.find((s) => s.roomId === roomId);
    expect(session).toBeDefined();
    expect(session!.playerId).toBeTruthy();
    await hostPage.reload();
    const storedAfter = await hostPage.evaluate(
      (key) => window.sessionStorage.getItem(key),
      SESSION_STORAGE_KEY,
    );
    expect(storedAfter).toBe(stored);
  });

  test('no seat for the room: one line + Go home', async ({ page }) => {
    await page.goto('/room/00000000-0000-0000-0000-000000000000');
    await expect(page.getByText('No live seat saved on this device for this room.')).toBeVisible();
    await page.getByRole('button', { name: 'Go home' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
  });
});

test.describe('session restore (live)', () => {
  test.skip(!LIVE, 'live-only spec — needs NEXT_PUBLIC_WORKER_URL on the dev server');

  test('reload in a live lobby restores the seat and code', async ({ context }) => {
    const hostPage = await context.newPage();
    const { code } = await createHostRoom(hostPage);
    await hostPage.reload();
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expect(hostPage.locator('section[aria-label="Game code"] .pakdam-code')).toHaveText(code);
  });
});
