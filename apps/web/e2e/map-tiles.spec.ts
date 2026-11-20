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
  createHostSetupRoom,
  startDemoMatch,
} from './helpers';

test.describe('map tiles — no Ola key', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');
  test.skip(OLA_KEY_SET, 'no-key spec — skip when NEXT_PUBLIC_OLA_MAPS_API_KEY is set');

  test('setup zone map shows the missing-key banner, not a blank canvas', async ({
    context,
  }) => {
    // The lobby has NO map — the zone map (and its missing-key banner)
    // lives on the create screen (/room/[id]/setup).
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
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

  test('setup zone section without a key offers Circle / Draw inline', async ({ context }) => {
    // Again the setup screen, not the lobby: the lobby has no map and no
    // shape toggle at all.
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    // Shape toggle labels are lowercase DOM text ("circle"/"draw", CSS
    // capitalised).
    await expect(hostPage.getByRole('button', { name: 'circle', exact: true })).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'draw', exact: true })).toBeVisible();
    await expect(
      hostPage.getByText('Map needs an Ola Maps key — set NEXT_PUBLIC_OLA_MAPS_API_KEY.'),
    ).toBeVisible();
  });
});

test.describe('map tiles — Ola key configured', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');
  test.skip(!OLA_KEY_SET, 'with-key spec — skip when NEXT_PUBLIC_OLA_MAPS_API_KEY is not set');

  test('setup zone map mounts a canvas', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
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
    await createHostSetupRoom(hostPage);
    await expect(hostPage.locator('[aria-label="Play zone map"] canvas')).toBeVisible({
      timeout: 30000,
    });
    await hostPage.getByRole('button', { name: 'Draw' }).click();
    // Switching to Draw seeds 6 corners from the circle; clear them first.
    await expect(hostPage.getByText('(6 placed)')).toBeVisible();
    await hostPage.getByRole('button', { name: 'Start again' }).click();
    await expect(hostPage.getByText('(0 placed)')).toBeVisible();
    const map = hostPage.locator('[aria-label="Play zone map"]');
    await map.click({ position: { x: 120, y: 80 } });
    await map.click({ position: { x: 200, y: 140 } });
    await map.click({ position: { x: 90, y: 160 } });
    await expect(hostPage.getByText('(3 placed)')).toBeVisible();
    await expect(hostPage.getByText('Tap the map to place numbered corners — 3 taps make a triangle. (3 placed)')).toBeVisible();
  });
});
