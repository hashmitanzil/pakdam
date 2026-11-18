// Catch + results e2e — TEXT/DOM assertions only, no screenshots.
// Covers the brief's catch flow (tag in person → Runner taps Got
// tagged → QR opens → Hunter scans; camera-unavailable path is the
// manual-confirm fallback) and the results page (awards, round card,
// trail card, no one-tap rematch). There is NO one-time code anywhere:
// no code to type, no code input on the catch page.
import { test, expect, type Page } from '@playwright/test';
import { roomState, setPlayer, startMatch } from './helpers';

/** Run one full catch for a Runner via the manual-confirm fallback
 *  (camera unavailable in headless Chromium, same as a real phone
 *  whose camera cannot scan). `catchPage` stays a second tab so the
 *  play tab never hard-navigates away (that would suspend the player). */
async function manualCatch(
  catchPage: Page,
  roomId: string,
  hunterId: string,
  runner: { playerId: string; displayName: string },
): Promise<void> {
  await setPlayer(catchPage, hunterId);
  await catchPage.goto(`/room/${roomId}/catch?runner=${runner.playerId}`);
  await expect(catchPage.getByRole('heading', { name: `Catch — ${runner.displayName}` })).toBeVisible();
  await catchPage.getByRole('button', { name: /Request a catch/i }).click();
  await expect(catchPage.getByText(/Claim state:/)).toContainText('Awaiting confirmation');

  await setPlayer(catchPage, runner.playerId);
  await catchPage.goto(`/room/${roomId}/catch?runner=${runner.playerId}`);
  await expect(catchPage.getByRole('heading', { name: /You are the Runner/ })).toBeVisible();
  await catchPage.getByRole('button', { name: /Got tagged.*show my QR/i }).click();
  await expect(catchPage.getByRole('heading', { name: /Show this to the Hunter/ })).toBeVisible();
  await expect(catchPage.getByRole('img', { name: /Catch QR code/ })).toBeVisible();
  await catchPage.getByRole('button', { name: /Confirm manually.*camera unavailable/i }).click();
  await catchPage.getByRole('button', { name: /Yes, I was tagged/i }).click();
  await expect(catchPage.getByRole('heading', { name: /Catch confirmed/ })).toBeVisible();
  await expect(catchPage.getByText(/Confirmed.*catch counts/).first()).toBeVisible();
}

test('catch flow via manual confirm → results with awards, no one-time code', async ({ page, context }) => {
  test.setTimeout(180_000);
  const { roomId, hunterId, runners } = await startMatch(page, context, { pickHunters: 'host' });
  expect(runners.length).toBeGreaterThanOrEqual(3);

  // No one-time code anywhere on the catch page: no code input, no
  // "enter a code" instruction — the only paths are QR scan or
  // manual confirm.
  const catchPage = await context.newPage();
  await catchPage.goto('/');
  await setPlayer(catchPage, hunterId);
  await catchPage.goto(`/room/${roomId}/catch?runner=${runners[0]!.playerId}`);
  await expect(catchPage.getByText(/enter (a|the|your).*code/i)).toHaveCount(0);
  await expect(catchPage.locator('input[type="text"]')).toHaveCount(0);

  for (const runner of runners) {
    await manualCatch(catchPage, roomId, hunterId, runner);
  }
  await catchPage.close();

  const finished = await roomState(page);
  expect(finished!.room.phase).toBe('COMPLETED');

  await page.goto(`/room/${roomId}/results`);
  await expect(page.getByRole('heading', { name: /Hunters win/ })).toBeVisible();
  await expect(page.getByText(new RegExp(`Caught Runners: ${runners.length}`)).first()).toBeVisible();
  await expect(page.getByText(new RegExp(`Confirmed catches: ${runners.length}`)).first()).toBeVisible();

  // Awards, computed from the real match data.
  const awards = page.getByRole('region', { name: 'Standout players' });
  await expect(awards).toContainText('Most tags:');
  await expect(awards).toContainText(`Test Host`);
  await expect(awards).toContainText(`${runners.length} confirmed tags`);
  await expect(awards).toContainText('Never caught:');
  await expect(awards).toContainText(/Nobody.*every Runner was caught/);
  await expect(awards).toContainText('Clean sweep:');
  await expect(awards).toContainText(/Yes.*every Runner was caught/);
  await expect(awards).toContainText('First catch:');
  await expect(awards).toContainText(`Test Host caught ${runners[0]!.displayName}`);
  await expect(awards).toContainText('Longest survivor / last Runner standing:');
  await expect(awards).toContainText(/No Runner survived/);

  // Shareable cards: round recap + trail card, no locations/routes.
  await expect(page.locator('pre', { hasText: 'round recap' })).toContainText('Clean sweep');
  await expect(page.locator('pre', { hasText: 'trail card' })).toContainText('Most tags: Test Host');
  await expect(page.getByText(/No locations or routes are shared/i).first()).toBeVisible();

  // No one-tap rematch in Phase 0 (HNT-031 is P1) — only fresh setup.
  await expect(page.getByRole('button', { name: /rematch/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Play again — start a fresh game/ })).toBeVisible();
});

test('catch: QR opens after Got tagged; a disputed catch is not confirmed', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, hunterId, runners } = await startMatch(page, context, { pickHunters: 'host' });
  const runner = runners[0]!;

  const catchPage = await context.newPage();
  await catchPage.goto('/');
  await setPlayer(catchPage, hunterId);
  await catchPage.goto(`/room/${roomId}/catch?runner=${runner.playerId}`);
  await catchPage.getByRole('button', { name: /Request a catch/i }).click();
  await expect(catchPage.getByText(/Claim state:/)).toContainText('Awaiting confirmation');

  await setPlayer(catchPage, runner.playerId);
  await catchPage.goto(`/room/${roomId}/catch?runner=${runner.playerId}`);
  await catchPage.getByRole('button', { name: /Got tagged.*show my QR/i }).click();
  await expect(catchPage.getByRole('heading', { name: /Show this to the Hunter/ })).toBeVisible();
  await expect(catchPage.getByRole('img', { name: /Catch QR code/ })).toBeVisible();
  await expect(catchPage.getByText(/QR lifetime:/)).toBeVisible();
  // Dispute instead of confirming: the catch is not counted.
  await catchPage.getByRole('button', { name: /Dispute/ }).first().click();
  await expect(catchPage.getByText(/Catch disputed.*host will review it/i)).toBeVisible();
  const state = await roomState(catchPage);
  expect(state!.catches.find((c) => c.runnerPlayerId === runner.playerId)?.state).toBe('disputed');
  expect(state!.room.phase).toBe('ACTIVE');
  await catchPage.close();
});

test('infection: a caught Runner turns Hunter and the HUD count drops', async ({ page, context }) => {
  test.setTimeout(180_000);
  const { roomId, hunterId, runners } = await startMatch(page, context, {
    pickHunters: 'host',
    configureDraft: async (p) => {
      await p.getByRole('radio', { name: /Infection/ }).check();
    },
  });
  const state0 = await roomState(page);
  expect(state0!.room.config.mode).toBe('infection');
  const hud = page.getByRole('region', { name: 'Match status' });
  await expect(hud).toContainText(`${runners.length} of ${runners.length} Runners`);

  const catchPage = await context.newPage();
  await catchPage.goto('/');
  await manualCatch(catchPage, roomId, hunterId, runners[0]!);
  await catchPage.close();

  // The turned Runner is a Hunter now — not a free Runner any more.
  const state1 = await roomState(page);
  expect(state1!.players.find((p) => p.playerId === runners[0]!.playerId)?.matchRole).toBe('hunter');
  expect(state1!.room.phase).toBe('ACTIVE');
  await expect(hud).toContainText(`${runners.length - 1} of ${runners.length - 1} Runners`);
  expect(state1!.events.some((e) => /turned Hunter/i.test(e.text))).toBe(true);
});
