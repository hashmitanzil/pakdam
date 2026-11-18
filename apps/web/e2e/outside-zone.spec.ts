// Outside-zone e2e — TEXT/DOM assertions only, no screenshots.
// Founder rule (2026-11-17): a player outside the play zone gets a
// 30-second return countdown on THEIR screen, then EJECTION. The demo
// store CAN simulate this end to end: Playwright's mocked geolocation
// moves the player's fix far outside the zone, and the play page's
// watchPosition delivers it. The no-fix banner is covered too (the
// "Zone check needs your location" state, reached by clearing the
// location permission and reloading).
import { test, expect } from '@playwright/test';
import { addRealPlayers, createLobby, joinAsGuest, roomState, setPlayer } from './helpers';

/** Read the big countdown ("0:29") from the outside-zone banner. */
async function countdownSeconds(page: import('@playwright/test').Page): Promise<number> {
  const label = await page.locator('div[aria-label$="seconds left to get back inside"]').textContent();
  const m = /0:(\d\d)/.exec(label ?? '');
  return m ? Number(m[1]) : -1;
}

test('outside zone: countdown appears, ticks down, player is ejected at 0', async ({ page, context }) => {
  test.setTimeout(180_000);
  // Centre on the mocked GPS position (23.36, 85.33), then move the
  // mock far outside the 500 m zone BEFORE the play page loads.
  // (No preset arg: presets were removed in the video rebuild —
  // the defaults already are the old Standard.)
  const { roomId, roomCode, hostId } = await createLobby(page, context);
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await guest.getByRole('button', { name: /I.m ready/i }).click();
  await setPlayer(page, hostId);
  // No "Add 3 demo players" button any more — no demo seats exist.
  await addRealPlayers(context, roomCode, ['Guest Two', 'Guest Three', 'Guest Four']);
  await expect(page.getByText(/Players \(5\/30\)/)).toBeVisible();

  // Host-picked Hunters: two extra guests, so the host stays a Runner
  // and is the one who gets ejected.
  await page.getByRole('button', { name: /Switch to host-picked Hunters/i }).click();
  const before = await roomState(page);
  const extras = before!.players.filter((p) => p.playerId !== hostId && p.displayName !== 'Guest Runner');
  await page.getByLabel(new RegExp(extras[0]!.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).check();
  await page.getByLabel(new RegExp(extras[1]!.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).check();
  await page.getByRole('button', { name: /Save Hunters/i }).click();
  await expect(page.getByText(/Saved Hunters:/)).toBeVisible();

  await context.setGeolocation({ latitude: 23.5, longitude: 85.5, accuracy: 5 });
  await page.getByRole('button', { name: /Start game/i }).click();
  await expect(page).toHaveURL(`/room/${roomId}/play`);
  await guest.close();

  // The banner appears with the 30-second return countdown.
  await expect(page.getByText(/Get back inside the zone.*\d+ s left/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/If the countdown reaches 0 you are ejected/i)).toBeVisible();
  const first = await countdownSeconds(page);
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThanOrEqual(30);
  await page.waitForTimeout(3_000);
  const second = await countdownSeconds(page);
  expect(second, `countdown must tick down (was ${first}, now ${second})`).toBeLessThan(first);

  // At 0 the player is ejected: banner, store flag, event log.
  await expect(page.getByText(/You were ejected from this game/i)).toBeVisible({ timeout: 40_000 });
  const ejected = await roomState(page);
  const me = ejected!.players.find((p) => p.playerId === hostId);
  expect(me!.ejectedAt).not.toBeNull();
  expect(ejected!.events.some((e) => /left the play zone — 30-second return countdown started/i.test(e.text))).toBe(true);
  expect(ejected!.events.some((e) => /was ejected — outside the play zone for 30 seconds/i.test(e.text))).toBe(true);

  // An ejected Runner cannot be caught any more.
  const hunterId = extras[0]!.playerId;
  const catchPage = await context.newPage();
  await catchPage.goto('/');
  await setPlayer(catchPage, hunterId);
  await catchPage.goto(`/room/${roomId}/catch?runner=${hostId}`);
  await expect(catchPage.getByText(/Catch is disabled: the Runner was ejected from the game/i)).toBeVisible();
  await catchPage.close();
});

test('outside zone: no banner and no false alarm while inside the zone', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode } = await createLobby(page, context);
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await guest.getByRole('button', { name: /I.m ready/i }).click();
  await setPlayer(page, (await roomState(page))!.players[0]!.playerId);
  // No "Add 3 demo players" button any more — no demo seats exist.
  await addRealPlayers(context, roomCode, ['Guest Two', 'Guest Three', 'Guest Four']);
  await page.getByRole('button', { name: /Start game/i }).click();
  await expect(page).toHaveURL(`/room/${roomId}/play`);
  await guest.close();
  const hud = page.getByRole('region', { name: 'Match status' });
  await expect(hud).toContainText('Active — hunt on', { timeout: 60_000 });
  // Mocked GPS is at the zone centre: no outside banner, no no-fix banner.
  await expect(page.getByText(/Get back inside the zone/)).toHaveCount(0);
  await expect(page.getByText(/Zone check needs your location/)).toHaveCount(0);
  await expect(page.getByText(/You were ejected from this game/)).toHaveCount(0);
  // A fix is present, so the "simulated location" fallback is not offered.
  await expect(page.getByRole('button', { name: /Use simulated location/i })).toHaveCount(0);
});

test('outside zone: no fix shows the "needs your location" banner state', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context);
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await guest.getByRole('button', { name: /I.m ready/i }).click();
  await setPlayer(page, hostId);
  // No "Add 3 demo players" button any more — no demo seats exist.
  await addRealPlayers(context, roomCode, ['Guest Two', 'Guest Three', 'Guest Four']);
  await page.getByRole('button', { name: /Start game/i }).click();
  await expect(page).toHaveURL(`/room/${roomId}/play`);
  await guest.close();

  // Clear the location permission and reload: the watch now errors,
  // there is no fix, and the banner must say so instead of guessing.
  await context.clearPermissions();
  await page.reload();
  await expect(page.getByText(/Zone check needs your location/i)).toBeVisible({ timeout: 30_000 });
  // The real denial text is the one short §5b line, "Location is
  // off — allow it in your browser settings, then tap the map to
  // place the zone." (LOCATION_DENIED_HELP, lib/geolocation.ts),
  // rendered via locError on the play page. The old
  // /Location permission is denied/i could never match it.
  await expect(page.getByText(/Location is off — allow it in your browser settings/i)).toBeVisible();
});

test('outside zone: poor GPS accuracy pauses the countdown; it resumes when accuracy recovers', async ({ page, context }) => {
  test.setTimeout(180_000);
  // Founder decision (2026-11-17): a coarse live fix must not eject
  // anyone — the countdown pauses and says so, and resumes when GPS
  // recovers. Accuracy 100 m is worse than the good tier (±10 m).
  const { roomId, roomCode, hostId } = await createLobby(page, context);
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await guest.getByRole('button', { name: /I.m ready/i }).click();
  await setPlayer(page, hostId);
  // No "Add 3 demo players" button any more — no demo seats exist.
  await addRealPlayers(context, roomCode, ['Guest Two', 'Guest Three', 'Guest Four']);
  await expect(page.getByText(/Players \(5\/30\)/)).toBeVisible();

  // Host-picked Hunters: two extra guests, so the host stays a Runner
  // and is the one who goes outside.
  await page.getByRole('button', { name: /Switch to host-picked Hunters/i }).click();
  const before = await roomState(page);
  const extras = before!.players.filter((p) => p.playerId !== hostId && p.displayName !== 'Guest Runner');
  await page.getByLabel(new RegExp(extras[0]!.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).check();
  await page.getByLabel(new RegExp(extras[1]!.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).check();
  await page.getByRole('button', { name: /Save Hunters/i }).click();
  await expect(page.getByText(/Saved Hunters:/)).toBeVisible();

  await context.setGeolocation({ latitude: 23.5, longitude: 85.5, accuracy: 100 });
  await page.getByRole('button', { name: /Start game/i }).click();
  await expect(page).toHaveURL(`/room/${roomId}/play`);
  await guest.close();

  // Paused banner: frozen at 30 s left, plainly saying why.
  await expect(page.getByText(/Countdown paused — GPS accuracy is poor/i)).toBeVisible({ timeout: 30_000 });
  const frozen1 = await countdownSeconds(page);
  expect(frozen1).toBe(30);
  await page.waitForTimeout(4_000);
  const frozen2 = await countdownSeconds(page);
  expect(frozen2, 'paused countdown must not tick down').toBe(frozen1);
  await expect(page.getByText(/You were ejected from this game/i)).toHaveCount(0);

  // GPS recovers (accuracy 5 m, still outside): the countdown resumes
  // from 30 and ticks down, and the running banner returns.
  await context.setGeolocation({ latitude: 23.5, longitude: 85.5, accuracy: 5 });
  await expect(page.getByText(/Get back inside the zone.*\d+ s left/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Countdown paused/i)).toHaveCount(0);
  const resumed1 = await countdownSeconds(page);
  expect(resumed1).toBeGreaterThan(0);
  expect(resumed1).toBeLessThanOrEqual(30);
  await page.waitForTimeout(3_000);
  const resumed2 = await countdownSeconds(page);
  expect(resumed2, `resumed countdown must tick down (was ${resumed1}, now ${resumed2})`).toBeLessThan(resumed1);
});
