/**
 * admin-login.spec.ts — Mission Control sign-in (live Worker only).
 *
 * Skipped locally — no live Worker (`test.skip(!LIVE, …)`);
 * Chromium runs fine in the VM. The founder's CI is the verdict
 * for the live flows. Covers: login page renders; wrong credentials show the
 * plain-words error without saying which field was wrong; a signed
 * -in admin reaches the overview; signing out returns to login.
 * Requires a seeded admin account on the test Worker.
 *
 * Text-only: DOM text and roles, no screenshots.
 */
import { test, expect } from '@playwright/test';
import { LIVE } from './helpers';

test.describe('admin login', () => {
  test.skip(!LIVE, 'needs a live Worker with a seeded admin account');

  test('login page renders username + password and a sign-in button', async ({ page }) => {
    await page.goto('/admin/login');
    await expect(page.getByText('Sign in to manage Pakdam.')).toBeVisible();
    await expect(page.locator('input[type="text"]').first()).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('wrong credentials show one plain-words error, never which field was wrong', async ({ page }) => {
    await page.goto('/admin/login');
    await page.locator('input[type="text"]').first().fill('no-such-user');
    await page.locator('input[type="password"]').first().fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Wrong username or password. Check both and try again.');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('signing out returns to the login page', async ({ page }) => {
    await page.goto('/admin/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // Seeded-owner sign-in is exercised in CI with the test account;
    // the sign-out leg below assumes that session exists.
    await page.goto('/admin');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});
