/**
 * responsive.spec.ts — the layout holds at 320 / 360 / 768 / 1280 px:
 * no horizontal overflow anywhere, bottom tabs reachable on play.
 * Demo-only. Text-only, no screenshots.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  createHostRoom,
  expectNoHorizontalOverflow,
  startDemoMatch,
} from './helpers';

test.describe('responsive widths (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  for (const width of [320, 360, 768, 1280]) {
    test(`home holds at ${width}px with no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      await expectNoHorizontalOverflow(page);
      await expect(page.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
      await expect(page.getByPlaceholder('ABC123')).toBeVisible();
    });
  }

  test('lobby holds at 320px and 1280px with no horizontal overflow', async ({ context }) => {
    for (const width of [320, 1280]) {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 800 });
      await createHostRoom(page);
      await expectNoHorizontalOverflow(page);
      await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
      // The host is created ready — the lobby opens on the flipped state.
      await expect(page.getByRole('button', { name: /I'm ready — tap to change/ })).toBeVisible();
      await page.close();
    }
  });

  test('play bottom tabs stay reachable at 360px and 768px', async ({ context }) => {
    const { hostPage } = await startDemoMatch(context);
    for (const width of [360, 768]) {
      await hostPage.setViewportSize({ width, height: 800 });
      await expectNoHorizontalOverflow(hostPage);
      const nav = hostPage.getByRole('navigation', { name: 'Game' });
      await expect(nav).toBeVisible();
      const box = await nav.getByRole('button', { name: 'Radio' }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(800);
    }
  });
});
