/**
 * map-tiles.spec.ts — the Ola map mounts when a key is configured, and the
 * one-line missing-key banner shows when it is not. The VM has no Ola key,
 * so the no-key tests run here and the with-key tests skip cleanly.
 * Text-only, no screenshots.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  OLA_KEY_SET,
  createHostRoom,
  startDemoMatch,
} from './helpers';

test.describe('map tiles — no Ola key', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');
  test.skip(OLA_KEY_SET, 'no-key spec — skip when NEXT_PUBLIC_OLA_MAPS_API_KEY is set');

  test('lobby zone map shows the missing-key banner, not a blank canvas', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    await expect(
      hostPage.getByText('Map needs an Ola Maps key — set NEXT_PUBLIC_OLA_MAPS_API_KEY.'),
    ).toBeVisible();
    await expect(hostPage.locator('[aria-label="Play zone map"] canvas')).toBeHidden();
  });

  test('play map shows the missing-key banner and the game still works', async ({
    context,
  }) => {
    const { hostPage } = await startDemoMatch(context);
    await expect(
      hostPage.getByText('Map needs an Ola key — the game still works without it.'),
    ).toBeVisible();
    await expect(hostPage.locator('[aria-label="Play map"] canvas')).toBeHidden();
    await expect(hostPage.getByText('Time left')).toBeVisible();
  });

  test('zone editor without a key still opens and offers Circle / Draw', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    await hostPage.getByRole('button', { name: /Zone size/ }).click();
    const dialog = hostPage.getByRole('dialog', { name: 'Play zone' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeVisible();
    // Shape toggle labels are lowercase DOM text ("circle"/"draw", CSS
    // capitalised) — exact match, or "Drop a no-go circle" / "Redraw"
    // also match a substring search for Circle / Draw.
    await expect(dialog.getByRole('button', { name: 'circle', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'draw', exact: true })).toBeVisible();
    await expect(
      dialog.getByText('Map needs an Ola Maps key — set NEXT_PUBLIC_OLA_MAPS_API_KEY.'),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });
});

test.describe('map tiles — Ola key configured', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');
  test.skip(!OLA_KEY_SET, 'with-key spec — skip when NEXT_PUBLIC_OLA_MAPS_API_KEY is not set');

  test('lobby zone map mounts a canvas', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    await expect(hostPage.locator('[aria-label="Play zone map"] canvas')).toBeVisible({
      timeout: 30000,
    });
  });

  test('play map mounts a canvas', async ({ context }) => {
    const { hostPage } = await startDemoMatch(context);
    await expect(hostPage.locator('[aria-label="Play map"] canvas')).toBeVisible({
      timeout: 30000,
    });
  });

  test('Draw mode: Start again clears corners, three map taps place three', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    await hostPage.getByRole('button', { name: /Zone size/ }).click();
    const dialog = hostPage.getByRole('dialog', { name: 'Play zone' });
    await expect(dialog.locator('[aria-label="Play zone map"] canvas')).toBeVisible({
      timeout: 30000,
    });
    await dialog.getByRole('button', { name: 'Draw' }).click();
    // Switching to Draw seeds 6 corners from the circle; clear them first.
    await expect(dialog.getByText('(6 placed)')).toBeVisible();
    await dialog.getByRole('button', { name: 'Start again' }).click();
    await expect(dialog.getByText('(0 placed)')).toBeVisible();
    const map = dialog.locator('[aria-label="Play zone map"]');
    await map.click({ position: { x: 120, y: 80 } });
    await map.click({ position: { x: 200, y: 140 } });
    await map.click({ position: { x: 90, y: 160 } });
    await expect(dialog.getByText('(3 placed)')).toBeVisible();
    await expect(dialog.getByText('Tap the map to place numbered corners — 3 taps make a triangle. (3 placed)')).toBeVisible();
  });

  test('no-go: Drop a no-go circle then tap the map lists No-go 1', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    await hostPage.getByRole('button', { name: /Zone size/ }).click();
    const dialog = hostPage.getByRole('dialog', { name: 'Play zone' });
    await expect(dialog.locator('[aria-label="Play zone map"] canvas')).toBeVisible({
      timeout: 30000,
    });
    await dialog.getByRole('button', { name: 'Drop a no-go circle' }).click();
    await expect(dialog.getByRole('button', { name: 'Done placing' })).toBeVisible();
    await dialog.locator('[aria-label="Play zone map"]').click({ position: { x: 150, y: 120 } });
    await expect(dialog.getByText('No-go 1')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Remove' })).toBeVisible();
  });
});
