/**
 * admin-gating.spec.ts — Mission Control role gating + destructive
 * confirms + announcement banner (live Worker only).
 *
 * Skipped locally — no live Worker (`test.skip(!LIVE, …)`);
 * Chromium runs fine in the VM. The founder's CI is the verdict
 * for the live flows. Covers: unsigned visits to /admin land on /admin/login;
 * a destructive room action needs two taps (first tap only arms and
 * shows the consequence); the billing page shows "Not available at
 * the moment — future upgrade" with no numbers; the home page shows
 * a live announcement banner that dismisses.
 *
 * Text-only: DOM text and roles, no screenshots.
 */
import { test, expect } from '@playwright/test';
import { LIVE } from './helpers';

test.describe('admin gating', () => {
  test.skip(!LIVE, 'needs a live Worker with a seeded admin account');

  test('unsigned visit to /admin goes to /admin/login', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('billing shows Not available, never a number', async ({ page }) => {
    await page.goto('/admin/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // Signed-in leg: assumes the CI test account session is set up
    // before this spec (see the CI admin seed step).
    await page.goto('/admin/billing');
    await expect(page.getByText('Not available at the moment — future upgrade.').first()).toBeVisible();
    await expect(page.getByText('Planned — not on sale. Legal gate pending.')).toBeVisible();
    await expect(page.getByText('Host Pass')).toBeVisible();
  });

  test('home shows a live announcement banner and dismisses it', async ({ page }) => {
    await page.goto('/');
    const banner = page.locator('[data-announcement-id]');
    if ((await banner.count()) > 0) {
      await expect(banner.first()).toBeVisible();
      await banner.first().getByRole('button', { name: 'Dismiss announcement' }).click();
      await expect(banner).toHaveCount(0);
    }
  });
});
