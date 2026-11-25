/**
 * v34 Scope C (Tara) — e2e pins for the 9 takes + D10 fixes, demo mode.
 *
 * Each test drives the real flow in a centred-GPS demo context. The
 * onboarding tests use a fresh page (first visit = cards show); every
 * other test Skips the cards first via dismissOnboardingIfShown.
 *
 * VM LIMIT: this VM's Chromium cannot launch, so `playwright test`
 * cannot be executed here — `playwright test --list` only. Founder CI
 * is the verdict for every test in this file.
 */
import { expect, test } from '@playwright/test';
import {
  LIVE,
  collectPageErrors,
  createHostRoom,
  createHostSetupRoom,
  dismissOnboardingIfShown,
  expectNoPageErrors,
  joinRoomAsGuest,
  newCentredDemoContext,
  readyAll,
  setStepper,
  setupThreePlayerLobby,
  startDemoMatch,
} from './helpers';

test.describe('v34 Scope C (demo)', () => {
  test.skip(LIVE, 'demo-only pins — run without NEXT_PUBLIC_WORKER_URL');

  test('C1: onboarding shows before the first game, Skip closes it and it stays closed', async ({
    browser,
  }) => {
    const context = await newCentredDemoContext(browser);
    const page = await context.newPage();
    const errors = collectPageErrors(page);
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'How Pakdam works' });
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(dialog.getByText('Stay inside the zone')).toBeVisible();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(dialog.getByText('Hunters can’t see you live')).toBeVisible();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(dialog.getByText('The zone keeps shrinking')).toBeVisible();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(dialog.getByText('Your turn')).toBeVisible();
    await dialog.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(dialog).toBeHidden();
    // Reload: seen, so the cards never auto-show again.
    await page.reload();
    await expect(dialog).toBeHidden({ timeout: 10000 });
    // "How to play" re-opens them.
    await page.getByRole('button', { name: 'How to play', exact: true }).click();
    await expect(dialog).toBeVisible();
    expectNoPageErrors(errors);
    await context.close();
  });

  test('C1+C9: the final Your turn card hosts a game, and home has three doors', async ({
    browser,
  }) => {
    const context = await newCentredDemoContext(browser);
    const page = await context.newPage();
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'How Pakdam works' });
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await dialog.getByRole('button', { name: 'Host a game', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Pick a mode' })).toBeVisible();
    // Back home: the three doors are all there.
    await page.goBack();
    await expect(page.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /JOIN A GAME/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /TRY A DEMO/ })).toBeVisible();
    await context.close();
  });

  test('C9: Try a demo opens mode select as a demo round', async ({ browser }) => {
    const context = await newCentredDemoContext(browser);
    const page = await context.newPage();
    await page.goto('/');
    await dismissOnboardingIfShown(page);
    await page.getByRole('button', { name: /TRY A DEMO/ }).click();
    await expect(page.getByRole('heading', { name: 'Pick a mode' })).toBeVisible();
    await expect(page.getByText('Demo round — played on this device only.')).toBeVisible();
    await expect(page).toHaveURL(/\/create\/mode\?demo=1/);
    await context.close();
  });

  test('C5: Quick preset applies, a stepper change drops to Custom, Save stores it', async ({
    browser,
  }) => {
    const context = await newCentredDemoContext(browser);
    const page = await context.newPage();
    const errors = collectPageErrors(page);
    await createHostSetupRoom(page);
    // Standard is the default (30 min / 500 m): the Standard pill is active.
    const presets = page.getByRole('group', { name: 'House rules presets' });
    await expect(presets.getByRole('button', { name: 'Standard', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await presets.getByRole('button', { name: 'Quick', exact: true }).click();
    await expect(presets.getByRole('button', { name: 'Quick', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Round length now reads 10 min.
    await expect(page.locator('section[aria-label="Timing"]').getByText('10m').first()).toBeVisible();
    // Change a stepper: the preset drops to Custom with the Save line.
    await setStepper(page, 'Round length', 1); // 10 min -> 15 min
    await expect(page.getByText('Changed. Save them to pick them next time.')).toBeVisible();
    await page.getByRole('button', { name: '+ Save', exact: true }).click();
    await expect(page.getByText('Saved — pick Custom next time.')).toBeVisible();
    await expect(presets.getByRole('button', { name: 'Custom', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expectNoPageErrors(errors);
    await context.close();
  });

  test('C6: every setup control carries its one-line explainer', async ({ browser }) => {
    const context = await newCentredDemoContext(browser);
    const page = await context.newPage();
    await createHostSetupRoom(page);
    await expect(page.getByText('The host draws the zone. Everyone plays inside it.')).toBeVisible();
    await expect(page.getByText('Circle: one round zone. Draw: your own shape, placed corner by corner.')).toBeVisible();
    await expect(page.getByText('Runners win if they last this long. The shrink time follows it — 3 shrinks per game.')).toBeVisible();
    await expect(page.getByText('Time runners get before hunters are released.')).toBeVisible();
    await expect(page.getByText('How often both sides see where the other team is.')).toBeVisible();
    await expect(page.getByText('The play area loses a quarter of its radius each time.')).toBeVisible();
    await expect(page.getByText('The zone is on — runners must stay inside it.')).toBeVisible();
    await expect(page.getByText('Set from the roster when the match starts — 2 for 6 players, 3 for 16.')).toBeVisible();
    await expect(page.getByText('Hunters are drawn at random when the match starts.')).toBeVisible();
    await context.close();
  });

  test('C7: CREATE LOBBY states its zone blocker in Draw with fewer than 3 corners', async ({
    browser,
  }) => {
    const context = await newCentredDemoContext(browser);
    const page = await context.newPage();
    await createHostSetupRoom(page);
    await page.getByRole('button', { name: 'Draw', exact: true }).click();
    // A fresh Draw has the circle sampled as 6 corners — remove them all
    // with the Corners stepper, then the CTA must block with its reason.
    await setStepper(page, 'Corners', 0);
    await expect(page.getByText('Place at least 3 corners — the zone is not set yet.')).toBeVisible();
    const cta = page.getByRole('button', { name: 'PLACE AT LEAST 3 CORNERS', exact: true });
    await expect(cta).toBeVisible();
    await cta.click();
    // Still on setup — the lobby never opened.
    await expect(page.getByRole('heading', { name: 'Create lobby' })).toBeVisible();
    await context.close();
  });

  test('C7: the lobby Start button says WAITING FOR PLAYERS until everyone is ready', async ({
    browser,
  }) => {
    const context = await newCentredDemoContext(browser);
    const { hostPage, guestPages, code } = await setupThreePlayerLobby(context);
    void code;
    // Two guests joined; the host is ready, the guests are not.
    await expect(
      hostPage.getByRole('button', { name: 'WAITING FOR PLAYERS', exact: true }),
    ).toBeVisible();
    await readyAll(guestPages);
    await expect(hostPage.getByRole('button', { name: 'START GAME', exact: true })).toBeVisible();
    await context.close();
  });

  test('C4: Get help is one tap away in the More sheet', async ({ browser }) => {
    const context = await newCentredDemoContext(browser);
    const { hostPage } = await startDemoMatch(context);
    await hostPage.getByRole('navigation', { name: 'Game' }).getByRole('button', { name: '···' }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'More' });
    await expect(sheet.getByRole('button', { name: 'Get help', exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Get help', exact: true }).click();
    await expect(sheet.getByText(/In trouble during a round\?/)).toBeVisible();
    await expect(sheet.getByText(/Tap Safety pause below/)).toBeVisible();
    await context.close();
  });

  test('D10: a guest who joined sees the lobby summary strip', async ({ browser }) => {
    const context = await newCentredDemoContext(browser);
    const { code } = await createHostRoom(await context.newPage());
    const guest = await joinRoomAsGuest(context, code, 'Ana');
    await expect(guest.getByText(/500m zone · 1 hunter · 3m pulse · 30m/)).toBeVisible();
    await context.close();
  });
});
