// Join + lobby e2e — TEXT/DOM assertions only, no screenshots.
// Covers the brief's guest flow: join by 6-char code or invite link
// with a display name and NO login, the Ready flow that gates Start,
// the lobby settings sheet, report/block, Tell everyone, lobby Team
// Radio, Get help, and profile friends / Played with / opt-in board.
import { test, expect } from '@playwright/test';
import { createLobby, joinAsGuest, roomState, setPlayer } from './helpers';

test('guest join by code: display name only, no account, no password field', async ({ page, context }) => {
  test.setTimeout(60_000);
  const { roomId, roomCode } = await createLobby(page, context);
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
  const { roomId, roomCode } = await createLobby(page, context);
  const guest = await context.newPage();
  await guest.goto(`/join/${roomCode}`);
  await expect(guest.getByRole('heading', { name: /You.re invited to a game/ })).toBeVisible();
  await expect(guest.getByText(roomCode)).toBeVisible();
  await guest.getByLabel(/Your display name/i).fill('Link Guest');
  await guest.getByLabel(/18 or older/i).check();
  await guest.getByRole('button', { name: /Join lobby/i }).click();
  await expect(guest).toHaveURL(`/room/${roomId}`);
  // The guest's name shows up in several places — roster row, "Your
  // checks (Link Guest)", "You are playing as Link Guest", the room
  // event log — so a bare getByText violates strict mode (5 matches).
  // Scope to the roster, the proof the guest is in the room: the
  // roster name div lives in the Players region (Roster.tsx, room
  // page.tsx: the roster <section aria-label="Players">). The other
  // four matches live in the checklist / event-log regions, not here.
  await expect(guest.getByRole('region', { name: 'Players' }).getByText(/Link Guest/)).toBeVisible();
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
  const { roomId, roomCode, hostId } = await createLobby(page, context);
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
  const { roomId, roomCode, hostId } = await createLobby(page, context);
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await guest.getByRole('button', { name: /I.m ready/i }).click();
  await setPlayer(page, hostId);

  await page.getByRole('button', { name: /Settings/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Game settings' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: /Game settings/ })).toBeVisible();
  // Same controls as host setup; the sheet carries no saved-rule UI.
  await expect(sheet.getByRole('group', { name: 'Match length' })).toBeVisible();
  await expect(sheet.getByText(/House-rule presets/)).toHaveCount(0);
  await sheet.getByRole('button', { name: /Increase Match length/ }).click();
  // Default is 30 min (defaultDraft durationSeconds 1800, draft.ts);
  // one step up is 45 min per DURATION_STEPS_MIN (draft.ts).
  await expect(sheet.getByRole('group', { name: 'Match length' }).locator('output')).toHaveText('45 min');
  await sheet.getByRole('button', { name: /DONE/ }).click();
  await expect(sheet).toHaveCount(0);
  // The lobby summary strip follows the edit — compact builder form
  // (roomSummaryStrip, draft.ts:210): 45 min is "45m", and with no
  // roster passed the strip shows 1 hunter. The strip is the lobby's
  // "Game settings:" button (room/[roomId]/page.tsx:926), not a
  // "Match summary" region (no such region exists).
  const strip = page.getByRole('button', { name: /^Game settings:/ });
  await expect(strip).toContainText('500m zone · 1 hunter · 3m pulse · 45m');
  const state = await roomState(page);
  expect(state!.room.config.durationSeconds).toBe(2700);
  await guest.close();
});

test('lobby: report/block sheet files a report and blocks on this device', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context);
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
  const { roomId, roomCode, hostId } = await createLobby(page, context);
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
  // The sent message lands in the message list (<ul>); the quick chip
  // with the same text sits outside it, in the "Quick messages" group
  // (TeamRadio.tsx: messages render in <ul className={messageList}>,
  // chips in <div role="group" aria-label="Quick messages">), so a
  // bare getByText matches both and violates strict mode. Scope to
  // the list — the only <ul> in the radio region.
  await expect(radio.locator('ul').getByText(/Let.s go!/)).toBeVisible();
  await expect(radio.getByText(/Test Host/)).toBeVisible();
  await guest.close();
});

test('leaderboard opt-in lives on the leaderboard page and persists on this device', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/leaderboards');
  await expect(page.getByRole('heading', { name: /Monthly leaderboard/ })).toBeVisible();
  // Opt-in: off by default, persists on this device.
  await page.getByRole('button', { name: /Join the leaderboard/ }).click();
  await expect(page.getByText(/You are opted in for/)).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem('pakdam.leaderboard.optin'));
  expect(stored).toBe('yes');
  // Board name and country are edited here now (strip-down 2026-11-19:
  // the /profile page is gone, so the form lives on this page).
  await expect(page.getByLabel(/Display name/)).toBeVisible();
  await expect(page.getByLabel(/Country/)).toBeVisible();
});
