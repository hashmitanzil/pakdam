/**
 * catch-results.spec.ts — catch → confirm → results (red hero, one-line
 * stats, max-6 timeline, START A FRESH GAME). Demo-only. Text-only.
 *
 * The match is ended by moving the demo room's endsAt into the past in
 * localStorage (the demo tick completes it on the next 1 s poll); the
 * stats duration is real elapsed time, so it is asserted by pattern, not
 * by an exact value.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  GUEST_NAMES,
  HOST_NAME,
  forceDemoMatchEnd,
  startDemoMatch,
} from './helpers';
import type { Page } from '@playwright/test';

test.describe('catch → results (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  async function setupMatch(context: import('@playwright/test').BrowserContext) {
    const { hostPage, guestPages, roomId, roles } = await startDemoMatch(context);
    const names = [HOST_NAME, ...GUEST_NAMES];
    const pages = [hostPage, ...guestPages];
    const hunterIdx = names.findIndex((n) => roles.get(n) === 'hunter');
    const runnerIdxs = names.map((n, i) => (roles.get(n) === 'runner' ? i : -1)).filter((i) => i >= 0);
    const hunterPage = pages[hunterIdx]!;
    const runnerPages = runnerIdxs.map((i) => pages[i]!);
    const runnerNames = runnerIdxs.map((i) => names[i]!);
    const hunterName = names[hunterIdx]!;
    return { hostPage, roomId, hunterPage, runnerPages, runnerNames, hunterName };
  }

  async function catchRunner(hunterPage: Page, runnerPage: Page, roomId: string, runnerName: string) {
    await hunterPage.goto(`/room/${roomId}/catch`);
    await hunterPage.getByRole('button', { name: runnerName }).click();
    await hunterPage
      .getByRole('button', { name: `I TAGGED ${runnerName.toUpperCase()}` })
      .click();
    await runnerPage.goto(`/room/${roomId}/catch`);
    await runnerPage.getByRole('button', { name: 'Self confirm' }).click();
    // Classic: the tagged Runner is out — after-tagged screen.
    await expect(runnerPage.getByText('You were tagged')).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Spectate match' })).toBeVisible();
    await expect(hunterPage.getByText('✓ Catch confirmed')).toBeVisible({ timeout: 15000 });
  }

  async function goToResults(page: Page, roomId: string) {
    await page.goto(`/room/${roomId}/results`);
    await expect(page.getByText('MATCH OVER')).toBeVisible();
  }

  test('one tag then time up: Runners Win, one-line stats, timeline, fresh game', async ({
    context,
  }) => {
    const { hostPage, roomId, hunterPage, runnerPages, runnerNames, hunterName } =
      await setupMatch(context);
    await catchRunner(hunterPage, runnerPages[0]!, roomId, runnerNames[0]!);
    await forceDemoMatchEnd(hostPage, roomId);
    await goToResults(hostPage, roomId);
    await expect(hostPage.getByText('Runners Win!', { exact: true })).toBeVisible();
    await expect(hostPage.getByText(/Classic Mode · Room [A-Z0-9]{6}/)).toBeVisible();
    // One-line stats: "<elapsed> · 1 tag · 1 runner never caught".
    await expect(hostPage.getByText(/· 1 tag · 1 runner never caught/)).toBeVisible();
    await expect(hostPage.getByRole('heading', { name: 'What happened' })).toBeVisible();
    await expect(hostPage.getByText('Match started — 3 players')).toBeVisible();
    await expect(hostPage.getByText(`${hunterName} tagged ${runnerNames[0]}`)).toBeVisible();
    await expect(hostPage.getByText('Time up — runners win')).toBeVisible();
    // Max 6 timeline entries.
    await expect(hostPage.locator('.border-l-2')).toHaveCount(3);
    await hostPage.getByRole('button', { name: 'START A FRESH GAME' }).click();
    await expect(hostPage).toHaveURL(/\/$/);
    await expect(hostPage.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
  });

  test('all runners caught: Hunters Win, Last runner caught, no never-caught line', async ({
    context,
  }) => {
    const { hostPage, roomId, hunterPage, runnerPages, runnerNames } = await setupMatch(context);
    await catchRunner(hunterPage, runnerPages[0]!, roomId, runnerNames[0]!);
    // Tag someone else: the hunter's done card offers the next claim.
    await hunterPage.getByRole('button', { name: 'Tag someone else' }).click();
    await hunterPage.getByRole('button', { name: runnerNames[1]! }).click();
    await hunterPage
      .getByRole('button', { name: `I TAGGED ${runnerNames[1]!.toUpperCase()}` })
      .click();
    await runnerPages[1]!.goto(`/room/${roomId}/catch`);
    await runnerPages[1]!.getByRole('button', { name: 'Self confirm' }).click();
    // Catching the last free runner completes the match at once, so the
    // catch page may show the done card or the match-over card — either
    // proves the confirm landed.
    await expect(
      runnerPages[1]!.getByText(/You were tagged|Match over — see the results page/),
    ).toBeVisible();
    // Catching the last free runner completes the match at once.
    await goToResults(hostPage, roomId);
    await expect(hostPage.getByText('Hunters Win!', { exact: true })).toBeVisible();
    await expect(hostPage.getByText(/· 2 tags/)).toBeVisible();
    await expect(hostPage.getByText(/never caught/)).toBeHidden();
    await expect(hostPage.getByText('Last runner caught')).toBeVisible();
    await expect(hostPage.locator('.border-l-2')).toHaveCount(4);
  });

  test('results before the match finishes says so and links back to the match', async ({
    context,
  }) => {
    const { hostPage, roomId } = await setupMatch(context);
    await hostPage.goto(`/room/${roomId}/results`);
    await expect(hostPage.getByText('Match hasn’t finished yet.')).toBeVisible();
    await hostPage.getByRole('button', { name: 'Back to the match' }).click();
    await expect(hostPage).toHaveURL(/\/room\/[^/]+\/play/);
  });

  test('a fresh game after results gets a new room code', async ({ context }) => {
    const { hostPage, roomId } = await setupMatch(context);
    await forceDemoMatchEnd(hostPage, roomId);
    await goToResults(hostPage, roomId);
    const oldCode = (await hostPage.getByText(/Classic Mode · Room [A-Z0-9]{6}/).innerText()).slice(-6);
    await hostPage.getByRole('button', { name: 'START A FRESH GAME' }).click();
    await hostPage.getByRole('button', { name: /HOST A GAME/ }).click();
    await hostPage.getByLabel('Your codename').fill('Teo');
    // The mode card does nothing until the on-site box is ticked.
    await hostPage.getByRole('checkbox', { name: /I'm at the play location/ }).click();
    await hostPage.getByRole('button', { name: /Classic/ }).click();
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    const newCode = (await hostPage.locator('section[aria-label="Game code"] .pakdam-code').innerText()).trim();
    expect(newCode).not.toBe(oldCode);
  });
});
