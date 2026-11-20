/**
 * brutal-phone.spec.ts — phone-viewport end-to-end (demo): create → join →
 * lobby → ready → start → play → catch → results, at 390×844 with touch.
 * Text-only, no screenshots.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  GUEST_NAMES,
  HOST_NAME,
  forceDemoMatchEnd,
  startDemoMatch,
} from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.describe('brutal phone end-to-end (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('create → join → ready → start → play → catch → confirm → results → fresh game', async ({
    context,
  }) => {
    test.setTimeout(180000);
    const { hostPage, guestPages, roomId, roles } = await startDemoMatch(context);
    const names = [HOST_NAME, ...GUEST_NAMES];
    const pages = [hostPage, ...guestPages];
    const hunterIdx = names.findIndex((n) => roles.get(n) === 'hunter');
    const runnerIdx = names.findIndex((n) => roles.get(n) === 'runner');
    const hunterPage = pages[hunterIdx]!;
    const runnerPage = pages[runnerIdx]!;
    const hunterName = names[hunterIdx]!;
    const runnerName = names[runnerIdx]!;

    // Play HUD on the phone: status strip + per-role catch button.
    // (The runner's button is "Got Tagged" — there is no "SHOW MY QR"
    // button on the play screen; the QR itself is shown on /catch.)
    await expect(hunterPage.getByText('Time left')).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: 'CATCH BY QR' })).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Got Tagged' })).toBeVisible();

    // Catch via the working path: /catch (no query) → pick a name → claim.
    // Claiming opens the QR scanner first (claim → scan); Cancel it to
    // reach the claim-open card, where the runner confirms on their phone.
    await hunterPage.goto(`/room/${roomId}/catch`);
    await expect(hunterPage.getByText('Who did you tag?')).toBeVisible();
    await hunterPage.getByRole('button', { name: runnerName }).click();
    await hunterPage
      .getByRole('button', { name: `I TAGGED ${runnerName.toUpperCase()}` })
      .click();
    await expect(hunterPage.getByText(`${runnerName} · Tag them?`)).toBeVisible();
    await hunterPage.getByRole('button', { name: 'Cancel' }).click();
    await expect(hunterPage.getByText(`Claim open — ${runnerName}`)).toBeVisible();

    // Runner confirms on their phone.
    await runnerPage.goto(`/room/${roomId}/catch`);
    await expect(runnerPage.getByText(`You were tagged by ${hunterName}?`)).toBeVisible();
    await runnerPage.getByRole('button', { name: 'Self confirm' }).click();
    // Classic: the tagged Runner is out — after-tagged screen.
    await expect(runnerPage.getByText('You were tagged')).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Spectate match' })).toBeVisible();
    await expect(hunterPage.getByText('✓ Catch confirmed')).toBeVisible({ timeout: 15000 });

    // Back to the map, end the match, results, fresh game.
    await hunterPage.getByRole('button', { name: 'Back to the map' }).click();
    await expect(hunterPage).toHaveURL(/\/room\/[^/]+\/play/);
    await forceDemoMatchEnd(hostPage, roomId);
    await hostPage.goto(`/room/${roomId}/results`);
    await expect(hostPage.getByText('MATCH OVER')).toBeVisible();
    await expect(hostPage.getByText('Runners Win!', { exact: true })).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'START A FRESH GAME' })).toBeVisible();
    await hostPage.getByRole('button', { name: 'START A FRESH GAME' }).click();
    await expect(hostPage).toHaveURL(/\/$/);
    await expect(hostPage.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
  });

  test('phone HUD basics: reveal, tabs, More sheet', async ({ context }) => {
    const { hostPage } = await startDemoMatch(context);
    // The reveal was dismissed by startDemoMatch; the HUD is underneath.
    await expect(hostPage.getByText('Time left')).toBeVisible();
    const nav = hostPage.getByRole('navigation', { name: 'Game' });
    await nav.getByRole('button', { name: 'Radio' }).click();
    await expect(hostPage.getByRole('heading', { name: 'Radio' })).toBeVisible();
    await nav.getByRole('button', { name: '···' }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'More' });
    await expect(sheet.getByText('Safety pause')).toBeVisible();
  });
});
