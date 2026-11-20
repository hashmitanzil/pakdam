/**
 * mobile-layout.spec.ts — 360 px baseline (SCRAM-SPEC §11): no horizontal
 * overflow, ≥ 48 px primary targets, bottom tabs reachable. Demo-only.
 * Text-only, no screenshots.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  createHostRoom,
  dismissRoleReveal,
  expectButtonHeight,
  expectNoHorizontalOverflow,
  readyAll,
  setupThreePlayerLobby,
  startDemoMatch,
  startMatchAsHost,
  waitForPlay,
} from './helpers';

test.use({ viewport: { width: 360, height: 800 } });

test.describe('mobile layout — 360px (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('home at 360px: no overflow, HOST A GAME and JOIN are thumb targets', async ({
    page,
  }) => {
    await page.goto('/');
    await expectNoHorizontalOverflow(page);
    await expectButtonHeight(page, /HOST A GAME/);
    await expectButtonHeight(page, 'JOIN', 48);
    const codeInput = page.getByLabel('Room code');
    const box = await codeInput.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(48);
  });

  test('lobby at 360px: no overflow, ready + start bar are thumb targets', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    await hostPage.setViewportSize({ width: 360, height: 800 });
    const { code } = await createHostRoom(hostPage);
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    await expectNoHorizontalOverflow(hostPage);
    await expectButtonHeight(hostPage, "I'm ready", 48);
    await expectButtonHeight(hostPage, 'NEED 2+ PLAYERS TO START', 48);
    await expect(hostPage.locator('section[aria-label="Game code"] .pakdam-code')).toBeVisible();
  });

  test('play at 360px: no overflow, bottom tabs visible and reachable', async ({ context }) => {
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    await readyAll([hostPage, ...guestPages]);
    await startMatchAsHost(hostPage);
    await waitForPlay(hostPage);
    await dismissRoleReveal(hostPage);
    await hostPage.setViewportSize({ width: 360, height: 800 });
    await expectNoHorizontalOverflow(hostPage);
    const nav = hostPage.getByRole('navigation', { name: 'Game' });
    await expect(nav).toBeVisible();
    const mapTab = nav.getByRole('button', { name: 'Map' });
    const box = await mapTab.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(800);
    expect(box!.height).toBeGreaterThanOrEqual(48);
    const catchButton = hostPage.getByRole('button', { name: /CATCH BY QR|SHOW MY QR/ });
    await expect(catchButton).toBeVisible();
    await expectButtonHeight(hostPage, /CATCH BY QR|SHOW MY QR/, 48);
  });

  test('130% zoom proxy (277px CSS width): home and lobby do not overflow', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    await hostPage.setViewportSize({ width: 277, height: 800 });
    await hostPage.goto('/');
    await expectNoHorizontalOverflow(hostPage);
    await expect(hostPage.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
    await createHostRoom(hostPage);
    await expectNoHorizontalOverflow(hostPage);
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
  });

  test('play at 360px: radio tab input and Send are reachable', async ({ context }) => {
    const { hostPage } = await startDemoMatch(context);
    await hostPage.setViewportSize({ width: 360, height: 800 });
    await hostPage.getByRole('navigation', { name: 'Game' }).getByRole('button', { name: 'Radio' }).click();
    await expect(hostPage.getByPlaceholder('Message your team')).toBeVisible();
    const sendBox = await hostPage
      .getByRole('button', { name: 'Send', exact: true })
      .boundingBox();
    expect(sendBox).not.toBeNull();
    expect(sendBox!.height).toBeGreaterThanOrEqual(48);
    await expectNoHorizontalOverflow(hostPage);
  });
});
