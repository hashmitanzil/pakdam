// Join + lobby e2e — TEXT/DOM assertions only, no screenshots.
// Covers the brief's guest flow: join by 6-char code or invite link
// with a display name and NO login, the Ready flow that gates Start,
// the lobby settings sheet, report/block, Tell everyone, lobby Team
// Radio, Get help, and profile friends / Played with / opt-in board.
import { test, expect } from '@playwright/test';
import { createLobby, joinAsGuest, roomState, setPlayer } from './helpers';

test('guest join by code: display name only, no account, no password field', async ({ page, context }) => {
  test.setTimeout(60_000);
  const { roomId, roomCode } = await createLobby(page, context, { preset: 'Standard' });
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await expect(guest.getByRole('heading', { name: 'Lobby', exact: true })).toBeVisible();
  await expect(guest.getByText(roomCode)).toBeVisible();
  // No login anywhere on the join screen: no password / email field.
  const joinPage = await context.newPage();
  await joinPage.goto('/join');
  await expect(joinPage.locator('input[type="password"]')).toHaveCount(0);
  await expect(joinPage.locator('input[type="email"]')).toHaveCount(0);
  await expect(joinPage.getByText(/no account needed/i)).toBeVisible();
  await joinPage.close();
  await guest.close();
});

test('guest join by invite link shows the code big and joins directly', async ({ page, context }) => {
  test.setTimeout(60_000);
  const { roomId, roomCode } = await createLobby(page, context, { preset: 'Standard' });
  const guest = await context.newPage();
  await guest.goto(`/join/${roomCode}`);
  await expect(guest.getByRole('heading', { name: /You.re invited to a game/ })).toBeVisible();
  await expect(guest.getByText(roomCode)).toBeVisible();
  await guest.getByLabel(/Your display name/i).fill('Link Guest');
  await guest.getByLabel(/18 or older/i).check();
  await guest.getByRole('button', { name: /Join lobby/i }).click();
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await expect(guest.getByText(/Link Guest/)).toBeVisible();
  await guest.close();

  // A bad invite link explains itself instead of a blank error.
  const bad = await context.newPage();
  await bad.goto('/join/ZZZZZZ');
  await bad.getByLabel(/Your display name/i).fill('Lost Guest');
  await bad.getByLabel(/18 or older/i).check();
  await bad.getByRole('button', { name: /Join lobby/i }).click();
  await expect(bad.getByText(/doesn.t match an open game/i)).toBeVisible();
  await expect(bad.getByRole('link', { name: /Type a different code/ })).toBeVisible();
  await bad.close();
});

test('lobby Ready flow gates Start until everyone is ready', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context, { preset: 'Standard' });
  // Host alone: Start is disabled, the lobby says 3 players are needed
  // (MIN_PLAYERS = 3 — the old "NEED 2+ PLAYERS TO START" copy is gone).
  await expect(page.getByRole('button', { name: /Start game/i })).toBeDisabled();
  await expect(page.getByText(/1 of at least 3 players in/i)).toBeVisible();

  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await setPlayer(page, hostId);
  // Two players in: still short of the 3-player minimum.
  await expect(page.getByText(/2 of at least 3 players in/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Start game/i })).toBeDisabled();

  // Guest taps "I'm ready" (their own page); the minimum is still unmet.
  await guest.getByRole('button', { name: /I.m ready/i }).click();
  await expect(guest.getByText(/You are ready/)).toBeVisible();
  await expect(page.getByText(/2 of at least 3 players in/i)).toBeVisible();

  // A second guest joins: 3 players in, but the second guest is not ready yet.
  const guest2 = await joinAsGuest(context, roomCode, 'Guest Two');
  await expect(guest2).toHaveURL(`/room/${roomId}`);
  await expect(page.getByText(/Waiting for everyone to be ready/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Start game/i })).toBeDisabled();
  await expect(page.getByText(/Waiting for: Guest Two/)).toBeVisible();

  // Second guest readies: everyone is ready, Start enables.
  await guest2.getByRole('button', { name: /I.m ready/i }).click();
  await expect(guest2.getByText(/You are ready/)).toBeVisible();
  await expect(page.getByText(/Ready to start/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Start game/i })).toBeEnabled();
  // The Ready list shows all three players ready.
  await expect(page.getByText(/3 of 3 ready/)).toBeVisible();
  await guest.close();
  await guest2.close();
});

test('lobby settings sheet lets the host change rules before the start', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context, { preset: 'Standard' });
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await guest.getByRole('button', { name: /I.m ready/i }).click();
  await setPlayer(page, hostId);

  await page.getByRole('button', { name: /Settings/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Game settings' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: /Game settings/ })).toBeVisible();
  // Same controls as host setup, presets hidden in the sheet.
  await expect(sheet.getByRole('group', { name: 'Match length' })).toBeVisible();
  await expect(sheet.getByText(/House-rule presets/)).toHaveCount(0);
  await sheet.getByRole('button', { name: /Increase Match length/ }).click();
  // Standard is 60 min; one step up is 90 min ("1 h 30 min") per
  // DURATION_STEPS_MIN — the old '45 min' expectation was written
  // when Standard was 30 min.
  await expect(sheet.getByRole('group', { name: 'Match length' }).locator('output')).toHaveText('1 h 30 min');
  await sheet.getByRole('button', { name: /DONE/ }).click();
  await expect(sheet).toHaveCount(0);
  // The lobby summary strip follows the edit.
  const strip = page.getByRole('region', { name: 'Match summary' });
  await expect(strip).toContainText('1 h 30 min');
  const state = await roomState(page);
  expect(state!.room.config.durationSeconds).toBe(5400);
  await guest.close();
});

test('lobby: report/block sheet files a report and blocks on this device', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context, { preset: 'Standard' });
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await setPlayer(page, hostId);

  await page.getByRole('button', { name: /Report or block Guest Runner/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Report or block Guest Runner' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Report or block Guest Runner' })).toBeVisible();
  await expect(sheet.getByLabel(/What happened\?/)).toBeVisible();
  await expect(sheet.getByText(/hides them from your friends and “Played with” lists/i)).toBeVisible();
  await sheet.getByLabel(/Also block Guest Runner on this device/i).check();
  await sheet.getByRole('button', { name: /File report/ }).click();
  await expect(sheet.getByText(/Report filed about Guest Runner/i)).toBeVisible();
  await expect(sheet.getByText(/now blocked on this device/i)).toBeVisible();
  await sheet.getByRole('button', { name: /Done/ }).click();
  // The roster now marks the player "Blocked by you".
  await expect(page.getByText(/Blocked by you/)).toBeVisible();
  // The report landed in the room event log.
  const state = await roomState(page);
  expect(state!.events.some((e) => /Report filed about Guest Runner/i.test(e.text))).toBe(true);
  await guest.close();
});

test('lobby: Tell everyone (hold 2 s) shares position; lobby radio sends', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context, { preset: 'Standard' });
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await setPlayer(page, hostId);

  // Hold-to-reveal: press and hold the button for 2 seconds. (The
  // accessible name is the aria-label, not the visible button text.)
  const tellBtn = page.getByRole('button', { name: /Tell everyone in the game/ });
  await expect(tellBtn).toBeVisible();
  await tellBtn.hover();
  await page.mouse.down();
  await page.waitForTimeout(2300);
  await page.mouse.up();
  await expect(page.getByText(/Position shared with everyone/)).toBeVisible();

  // Lobby radio: a quick message lands in the channel, team-only note shown.
  const radio = page.getByRole('region', { name: 'Lobby radio' });
  await expect(radio).toBeVisible();
  await expect(radio).toContainText(/Once the game starts, radio becomes team-only/);
  await radio.getByRole('button', { name: /Let.s go!/ }).click();
  await expect(radio.getByText(/Let.s go!/)).toBeVisible();
  await expect(radio.getByText(/Test Host/)).toBeVisible();
  await guest.close();
});

test('get help page explains the three kinds of help; profile has friends + opt-in board', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/help');
  await expect(page.getByRole('heading', { name: /Stuck\? Start here/ })).toBeVisible();
  await expect(page.getByText(/Which help do you need/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /Grievance page/ }).first()).toBeVisible();

  await page.goto('/profile');
  await expect(page.getByText(/guest-only for now: no account, no sign-in/i).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Friends/ })).toBeVisible();
  await expect(page.getByText(/People you add from players you have actually played with/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Played with — last 7 days/ })).toBeVisible();
  // Opt-in leaderboard: off by default, persists on this device.
  const optin = page.getByLabel(/Show me on the monthly leaderboard/i);
  await expect(optin).not.toBeChecked();
  await optin.check();
  await expect(page.getByText(/You are opted in for/)).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem('pakdam.leaderboard.optin'));
  expect(stored).toBe('yes');
  await page.goto('/leaderboards');
  await expect(page.getByRole('heading', { name: /Monthly leaderboard/ })).toBeVisible();
});
