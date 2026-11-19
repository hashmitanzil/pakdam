// Catch-navigation probe (2026-11-19) — TEXT/DOM assertions only, no
// screenshots (gateway rule). UI-ONLY navigation to the catch screen:
// no /catch?runner= URL is ever typed by this spec. The Hunter reaches
// the catch screen through the play page's "Catch — pick a Runner"
// button, picks a Runner by NAME from the Step 1 picker, and requests;
// the Runner reaches the same screen through the CatchPanel "Open the
// Catch screen" link and is auto-selected onto their own Step 2 by the
// open claim. The manual-confirm fallback stands in for the camera
// (unavailable in headless Chromium, same as a real phone whose camera
// cannot scan). There is NO one-time code anywhere in Pakdam.
import { test, expect } from '@playwright/test';
import { roomState, setPlayer, startMatch } from './helpers';

test('catch navigation via UI links only: picker request + runner auto-select', async ({ page, context }) => {
  test.setTimeout(240_000);
  const { roomId, roomCode, hunterId, runners } = await startMatch(page, context, { pickHunters: 'host' });
  expect(runners.length).toBeGreaterThanOrEqual(2);
  const runner = runners[0]!;
  expect(hunterId).toBeTruthy();

  // Runner tab: enter through the lobby URL (the app auto-routes an
  // ACTIVE match to /play); the catch navigation itself is UI-only.
  const runnerPage = await context.newPage();
  await runnerPage.goto('/');
  await setPlayer(runnerPage, runner.playerId);
  await runnerPage.goto(`/room/${roomId}`);
  await expect(runnerPage).toHaveURL(`/room/${roomId}/play`, { timeout: 15_000 });
  await expect(runnerPage.getByRole('heading', { name: 'Match' })).toBeVisible();

  // HUNTER (host tab, already on /play): thumb-zone button to the
  // BARE catch screen — no ?runner= anywhere. (Two identical
  // buttons exist — thumb zone + "Hunter tools" group — both go to
  // the same bare /catch; take the first.)
  await page.getByRole('button', { name: /Catch — pick a Runner/i }).first().click();
  await expect(page).toHaveURL(`/room/${roomId}/catch`);
  await expect(page.getByRole('heading', { name: 'Catch — Runner' })).toBeVisible();
  // Step 1 picker: names only, no roles — the target Runner is one
  // of the buttons, the other Hunter is too (server validates).
  await expect(page.getByRole('heading', { name: /Step 1 — Claim the catch/i })).toBeVisible();
  await expect(page.getByRole('button', { name: `Catch ${runner.displayName}` })).toBeVisible();
  await page.getByRole('button', { name: `Catch ${runner.displayName}` }).click();
  await expect(page.getByRole('heading', { name: `Catch — ${runner.displayName}` })).toBeVisible();
  await expect(page.getByText(/No Runner selected/)).toHaveCount(0);
  await page.getByRole('button', { name: /Request a catch/i }).click();
  await expect(page.getByText(/Claim state:/)).toContainText('Awaiting confirmation');

  // RUNNER: the open-claim banner appears, then the BARE CatchPanel
  // link — no ?runner= — lands on their own Step 2 (auto-selected).
  await expect(runnerPage.getByText(/You are the Runner in an open claim/i)).toBeVisible({ timeout: 15_000 });
  await runnerPage.getByRole('link', { name: /Open the Catch screen/i }).click();
  await expect(runnerPage).toHaveURL(`/room/${roomId}/catch`);
  await expect(runnerPage.getByText(/No Runner selected/)).toHaveCount(0);
  await expect(runnerPage.getByRole('heading', { name: /You are the Runner/ })).toBeVisible();
  await runnerPage.getByRole('button', { name: /Got tagged.*show my QR/i }).click();
  await expect(runnerPage.getByRole('heading', { name: /Show this to the Hunter/ })).toBeVisible();
  await expect(runnerPage.getByRole('img', { name: /Catch QR code/ })).toBeVisible();
  await runnerPage.getByRole('button', { name: /Confirm manually.*camera unavailable/i }).click();
  await runnerPage.getByRole('button', { name: /Yes, I was tagged/i }).click();
  await expect(runnerPage.getByRole('heading', { name: /Catch confirmed/ })).toBeVisible();
  // Hunter tab sees the same confirmed catch (demo polling).
  await expect(page.getByRole('heading', { name: /Catch confirmed/ })).toBeVisible({ timeout: 15_000 });

  const state = await roomState(page);
  const done = state!.catches.find((c) => c.runnerPlayerId === runner.playerId);
  expect(done?.state).toBe('confirmed');
  console.log(`CATCH-NAV-PROBE roomCode=${roomCode} roomId=${roomId} hunter=${hunterId} runner=${runner.displayName} (${runner.playerId}) catch=confirmed`);
});
