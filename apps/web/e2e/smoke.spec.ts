/**
 * smoke.spec.ts — home loads, HOST A GAME → mode select, Join Room input,
 * no console errors on load. Demo-only (the app is live when a Worker URL
 * is configured; the same UI flow is covered live in join-lobby.spec.ts).
 *
 * Text-only: DOM text and roles, no screenshots.
 */
import { test, expect } from '@playwright/test';
import { LIVE, collectPageErrors, expectNoHorizontalOverflow, expectNoPageErrors } from './helpers';

test.describe('smoke', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('home loads with the headline, two actions and the footer line', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Pakdam', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Your city is the battlefield')).toBeVisible();
    await expect(page.getByRole('heading', { name: /You are the/ })).toBeVisible();
    await expect(page.getByText('Target.', { exact: true })).toBeVisible();
    await expect(page.getByText("Hide. Run. Don't get caught.")).toBeVisible();
    await expect(page.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
    await expect(page.getByText('START A NEW MATCH')).toBeVisible();
    await expect(page.getByText('Join Room', { exact: true })).toBeVisible();
    await expect(page.getByText('Enter a code to join a match.')).toBeVisible();
    await expect(page.getByPlaceholder('ABC123')).toBeVisible();
    await expect(page.getByRole('button', { name: 'JOIN', exact: true })).toBeVisible();
    await expect(page.getByText('Free · No download · 3–30 players · No account needed.')).toBeVisible();
  });

  test('HOST A GAME goes to mode select with both mode cards', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /HOST A GAME/ }).click();
    await expect(page.getByRole('heading', { name: 'Pick a mode' })).toBeVisible();
    await expect(page.getByLabel('Your codename')).toBeVisible();
    await expect(page.getByPlaceholder('e.g. Teo')).toBeVisible();
    await expect(page.getByRole('button', { name: /Classic/ })).toBeVisible();
    await expect(page.getByText("Tagged? You're out. Watch live.")).toBeVisible();
    await expect(page.getByRole('button', { name: /Infection/ })).toBeVisible();
    await expect(page.getByText('Tagged? You join the Hunters.')).toBeVisible();
  });

  test('mode select needs a codename before a mode card creates a room', async ({ page }) => {
    await page.goto('/create/mode');
    await page.getByRole('button', { name: /Classic/ }).click();
    await expect(page.getByText('Enter a codename between 1 and 30 characters.')).toBeVisible();
    await expect(page).toHaveURL(/\/create\/mode/);
  });

  test('a short code on Home is rejected in one line', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Room code').fill('ABC');
    await page.getByRole('button', { name: 'JOIN', exact: true }).click();
    await expect(page.getByText("That code didn't match a room — check it and try again.")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test('an unknown 6-letter code is rejected after the codename step', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Room code').fill('ZZZZZZ');
    await page.getByRole('button', { name: 'JOIN', exact: true }).click();
    await expect(page).toHaveURL(/\/join\/ZZZZZZ/);
    await expect(page.getByRole('heading', { name: 'Join a game' })).toBeVisible();
    await page.getByLabel('Your codename').fill('Ana');
    await page.getByRole('button', { name: 'JOIN', exact: true }).click();
    await expect(page.getByText("That code didn't match a room — check it and try again.")).toBeVisible();
  });

  test('no console errors on Home and Mode select, no horizontal overflow at 360px', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/');
    await page.waitForTimeout(2000);
    await expectNoHorizontalOverflow(page);
    await page.goto('/create/mode');
    await page.waitForTimeout(1000);
    await expectNoHorizontalOverflow(page);
    expectNoPageErrors(errors);
  });
});
