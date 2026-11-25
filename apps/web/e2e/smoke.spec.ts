/**
 * smoke.spec.ts — home loads, HOST A GAME → mode select, the /join screen
 * (the room-code input lives there, not on Home), no console errors on
 * load. Demo-only (the app is live when a Worker URL is configured; the
 * same UI flow is covered live in join-lobby.spec.ts).
 *
 * Text-only: DOM text and roles, no screenshots.
 */
import { test, expect } from '@playwright/test';
import { LIVE, collectPageErrors, dismissOnboardingIfShown, expectNoHorizontalOverflow, expectNoPageErrors } from './helpers';

test.describe('smoke', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('home loads with the headline, two actions and the footer line', async ({ page }) => {
    await page.goto('/');
    // Home header logo is the lockup wordmark image now, not text.
    // exact:true — plain 'Pakdam' also matches the WelcomeScreen pin art
    // ('Pakdam pin art — …') and wordmark ('Pakdam wordmark') images
    // (strict-mode violation since the v20–v22 branding).
    await expect(page.getByAltText('Pakdam', { exact: true })).toBeVisible();
    await expect(page.getByText('Your city is the battlefield')).toBeVisible();
    await expect(page.getByRole('heading', { name: /You are the/ })).toBeVisible();
    await expect(page.getByText('Target.', { exact: true })).toBeVisible();
    // "Hide. Run. Don't get caught." also appears in <title>, so scope to
    // <main> — an unscoped getByText is a strict-mode violation.
    await expect(
      page.locator('main').getByText("Hide. Run. Don't get caught."),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
    await expect(page.getByText('START A NEW MATCH')).toBeVisible();
    await expect(page.getByRole('button', { name: /JOIN A GAME/ })).toBeVisible();
    await expect(page.getByText('ENTER A ROOM CODE TO JOIN')).toBeVisible();
    // Home takes no code — there is no Join Room section, no code input
    // and no JOIN button here; the code lives only on the /join screen
    // (covered by the join tests below).
    await expect(page.getByPlaceholder('ABC123')).toBeHidden();
    await expect(page.getByText('Free · No download · 2–30 players · No account needed.')).toBeVisible();
  });

  test('JOIN A GAME goes to the join screen with the code input', async ({ page }) => {
    await page.goto('/');
    await dismissOnboardingIfShown(page);
    await page.getByRole('button', { name: /JOIN A GAME/ }).click();
    await expect(page.getByRole('heading', { name: 'Join a game' })).toBeVisible();
    await expect(page.getByLabel('Room code')).toBeVisible();
    await expect(page.getByPlaceholder('ABC123')).toBeVisible();
    await expect(page.getByLabel('Your codename')).toBeVisible();
    await expect(page.getByRole('button', { name: 'JOIN', exact: true })).toBeVisible();
  });

  test('HOST A GAME goes to mode select with both mode cards', async ({ page }) => {
    await page.goto('/');
    await dismissOnboardingIfShown(page);
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

  test('mode select needs the on-site confirmation before a mode card creates a room', async ({
    page,
  }) => {
    // hostOnSiteConfirmed is a real gate — the server rejects configs
    // without it, so the mode card must do nothing until the host ticks
    // "I'm at the play location".
    await page.goto('/create/mode');
    await page.getByLabel('Your codename').fill('Ana');
    await page.getByRole('button', { name: /Classic/ }).click();
    await expect(
      page.getByText("Confirm you're at the play location — the host must be on site to create a game."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/create\/mode/);
    await page.getByRole('checkbox', { name: /I'm at the play location/ }).click();
    await page.getByRole('button', { name: /Classic/ }).click();
    await page.waitForURL(/\/room\/[^/]+\/setup/);
  });

  test('a short code on the join screen is rejected in one line', async ({ page }) => {
    await page.goto('/join');
    await page.getByLabel('Room code').fill('ABC');
    await page.getByLabel('Your codename').fill('Ana');
    await page.getByRole('button', { name: 'JOIN', exact: true }).click();
    await expect(page.getByText("That code didn't match a room — check it and try again.")).toBeVisible();
    await expect(page).toHaveURL(/\/join$/);
  });

  test('an unknown 6-letter code is rejected on the join screen', async ({ page }) => {
    await page.goto('/join');
    await page.getByLabel('Room code').fill('ZZZZZZ');
    await page.getByLabel('Your codename').fill('Ana');
    await page.getByRole('button', { name: 'JOIN', exact: true }).click();
    await expect(page.getByText("That code didn't match a room — check it and try again.")).toBeVisible();
    await expect(page).toHaveURL(/\/join$/);
  });

  test('an unknown code via the /join/<code> deep link is rejected after the codename step', async ({
    page,
  }) => {
    await page.goto('/join/ZZZZZZ');
    await expect(page.getByRole('heading', { name: 'Join a game' })).toBeVisible();
    await expect(page.getByText('ZZZZZZ', { exact: true })).toBeVisible();
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
