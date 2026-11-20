/**
 * no-forge-office.spec.ts — the Pakdam PWA contains no Forge-office
 * references: no office UI, no Hermes, no Forge branding on any screen.
 * Text-only (visible text), no screenshots.
 *
 * The check runs over visible text on every screen because the PWA is a
 * standalone game; the Forge office lives elsewhere and must not leak in.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  createHostRoom,
  expectNoForgeOfficeText,
  startDemoMatch,
} from './helpers';

test.describe('no Forge office in the PWA (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('Home and Mode select have no Forge-office references', async ({ page }) => {
    await page.goto('/');
    await expectNoForgeOfficeText(page);
    await expect(page).toHaveTitle(/Pakdam/);
    await page.getByRole('button', { name: /HOST A GAME/ }).click();
    await expectNoForgeOfficeText(page);
  });

  test('lobby, play, catch and results have no Forge-office references', async ({
    context,
  }) => {
    // The lobby can only be checked BEFORE the match starts: once the
    // phase leaves LOBBY the lobby page auto-navigates to /play, so a
    // post-start visit to /room/[id] never shows the Lobby heading.
    const lobbyPage = await context.newPage();
    await createHostRoom(lobbyPage);
    await expect(lobbyPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expectNoForgeOfficeText(lobbyPage);
    await lobbyPage.close();
    const { hostPage, roomId } = await startDemoMatch(context);
    await expectNoForgeOfficeText(hostPage);
    await hostPage.goto(`/room/${roomId}/catch`);
    await expect(hostPage.getByRole('heading', { name: 'Catch' })).toBeVisible();
    await expectNoForgeOfficeText(hostPage);
    await hostPage.goto(`/room/${roomId}/results`);
    await expect(hostPage.getByText('Match hasn’t finished yet.')).toBeVisible();
    await expectNoForgeOfficeText(hostPage);
  });

  test('no Forge-office word appears in any page title or heading', async ({ context }) => {
    const { hostPage } = await startDemoMatch(context);
    const headings = await hostPage.evaluate(() =>
      [...document.querySelectorAll('h1, h2, title')].map((el) => el.textContent ?? ''),
    );
    for (const heading of headings) {
      expect(heading.toLowerCase()).not.toContain('forge');
      expect(heading.toLowerCase()).not.toContain('hermes');
    }
  });
});
