// Join + lobby e2e — TEXT/DOM assertions only, no screenshots.
// Covers the brief's guest flow: join by 6-char code or invite link
// with a display name and NO login, the Ready flow that gates Start,
// the lobby settings sheet, report/block, and the minimal-lobby
// absence checks (the safety strip, lobby radio, readiness
// checklist, role preview, host check-in and event log are gone from
// the lobby — safety and radio still live on the play screen, see
// live-hud.spec.ts). Plus profile friends / Played with / opt-in board.
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
  // Scope to the roster, the proof the guest is in the room: the
  // roster name div lives in the Players region (Roster.tsx,
  // room page.tsx: the roster <section aria-label="Players">).
  // (Minimal lobby 2026-11-19: the readiness checklist — whose
  // "Your checks (Link Guest)" heading used to carry the name a
  // second time — is deleted, as are the "You are playing as …"
  // note, the "All players" duplicate list and the "What has
  // happened" event log, so the roster is the name's home here.)
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
  // The host is ready by default (demo-store createRoom: isReady true),
  // so the Players card reads "1 of 1 ready." and the host's button
  // already shows the ready state.
  await expect(page.getByRole('button', { name: /Start game/i })).toBeDisabled();
  await expect(page.getByText(/NEED 3\+ PLAYERS TO START/)).toBeVisible();
  await expect(page.getByText(/1 of at least 3 players in/i)).toBeVisible();
  await expect(page.getByText(/Players \(1\/30\)/)).toBeVisible();
  await expect(page.getByText(/1 of 1 ready\./)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Players' }).getByText('✓ Ready', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /I.m ready — tap to change/ })).toBeVisible();

  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await setPlayer(page, hostId);
  // Two players in: still short of the 3-player minimum. The guest is
  // not ready yet — the roster says so in words ("… Not ready yet"),
  // and the old not-ready sub-line ("Tap when you have read the rules
  // and run your checks.") is gone in the minimal lobby.
  await expect(page.getByText(/NEED 3\+ PLAYERS TO START/)).toBeVisible();
  await expect(page.getByText(/2 of at least 3 players in/i)).toBeVisible();
  await expect(page.getByText(/1 of 2 ready\./)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Players' }).getByText('… Not ready yet', { exact: true })).toHaveCount(1);
  await expect(guest.getByText(/Tap when you have read the rules and run your checks\./)).toHaveCount(0);

  // Guest taps "I'm ready" (their own page) — the single tap IS the
  // readiness mechanism now (no checks to run, no rules checkbox);
  // the minimum is still unmet.
  await guest.getByRole('button', { name: /I.m ready/i }).click();
  await expect(guest.getByText(/You are ready\. The host starts the game when everyone is ready\./)).toBeVisible();
  await expect(page.getByText(/2 of at least 3 players in/i)).toBeVisible();
  await expect(page.getByText(/2 of 2 ready\./)).toBeVisible();

  // A second guest joins: 3 players in, but the second guest is not ready yet.
  const guest2 = await joinAsGuest(context, roomCode, 'Guest Two');
  await expect(guest2).toHaveURL(`/room/${roomId}`);
  await expect(page.getByText(/Waiting for everyone to be ready/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Start game/i })).toBeDisabled();
  await expect(page.getByText(/Waiting for: Guest Two/)).toBeVisible();
  await expect(page.getByText(/Need at least 3 players, and everyone ready\./)).toBeVisible();
  await expect(page.getByText(/2 of 3 ready\./)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Players' }).getByText('✓ Ready', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Players' }).getByText('… Not ready yet', { exact: true })).toHaveCount(1);

  // Second guest readies: everyone is ready, Start enables.
  await guest2.getByRole('button', { name: /I.m ready/i }).click();
  await expect(guest2.getByText(/You are ready\. The host starts the game when everyone is ready\./)).toBeVisible();
  await expect(page.getByText(/✓ Ready to start/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Start game/i })).toBeEnabled();
  // The Players card shows all three players ready.
  await expect(page.getByText(/3 of 3 ready\./)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Players' }).getByText('✓ Ready', { exact: true })).toHaveCount(3);
  await guest.close();
  await guest2.close();
});

test('lobby minimal: removed readiness, role-preview, check-in and event-log blocks are absent', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context);
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await setPlayer(page, hostId);

  // Kept UI still here: the lobby heading, the Players card and the
  // single-tap ready button (the host is ready by default, the guest
  // is not — "1 of 2 ready.").
  await expect(page.getByRole('heading', { name: 'Lobby', exact: true })).toBeVisible();
  await expect(page.getByText(/Players \(2\/30\)/)).toBeVisible();
  await expect(page.getByText(/1 of 2 ready\./)).toBeVisible();
  await expect(guest.getByRole('button', { name: /I.m ready/i })).toBeVisible();

  // Readiness checklist — all of it is gone: the "Get ready to play"
  // heading, the "Your checks" line, every check row (Location
  // permission / GPS quality / Screen-on / Wake Lock / Network /
  // Briefing confirmed), the "Run checks / Retry" button, and the
  // "Before you play" rules checkbox.
  await expect(page.getByRole('heading', { name: 'Get ready to play' })).toHaveCount(0);
  await expect(page.getByText(/Your checks/)).toHaveCount(0);
  await expect(page.getByText(/Location permission/)).toHaveCount(0);
  await expect(page.getByText(/GPS quality/)).toHaveCount(0);
  await expect(page.getByText(/Screen-on \/ Wake Lock/)).toHaveCount(0);
  await expect(page.getByText(/Network/)).toHaveCount(0);
  await expect(page.getByText(/Briefing confirmed/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Run checks/ })).toHaveCount(0);
  await expect(page.getByText(/Before you play — read this/)).toHaveCount(0);
  await expect(page.getByText(/I understand the rules and the screen-on warning\./)).toHaveCount(0);

  // Role preview, host check-in and the event log are gone too.
  await expect(page.getByRole('heading', { name: 'Your role is decided when the game starts' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Host check-in: lobby' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Host check-ins' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What has happened' })).toHaveCount(0);

  // The not-ready sub-line under "I'm ready" is gone as well — the
  // guest has not tapped ready yet, so it would have shown here
  // before the strip. Tapping "I'm ready" is the whole readiness
  // mechanism now: no checks, no checkbox, just the tap.
  await expect(guest.getByText(/Tap when you have read the rules and run your checks\./)).toHaveCount(0);
  await guest.getByRole('button', { name: /I.m ready/i }).click();
  await expect(guest.getByText(/You are ready\. The host starts the game when everyone is ready\./)).toBeVisible();
  await guest.close();
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
  // The report landed in the room's stored events (roomState) — the
  // lobby's "What has happened" event-log section is gone in the
  // minimal lobby, so there is no DOM log to check; the store record
  // is the proof. (A report was filed, so events are non-empty — the
  // log section would have rendered here before the strip.)
  await expect(page.getByText(/What has happened/i)).toHaveCount(0);
  const state = await roomState(page);
  expect(state!.events.some((e) => /Report filed about Guest Runner/i.test(e.text))).toBe(true);
  await guest.close();
});

test('lobby: safety strip and lobby radio are gone — absence on the lobby', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context);
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await setPlayer(page, hostId);

  // Minimal lobby (2026-11-19): the "Safety — always here" block is
  // gone from the lobby — no SOS, no safety pause, no hold-to-reveal
  // "Tell everyone". Safety still lives on the PLAY screen (SOS +
  // safety pause, live-hud.spec.ts; SOS in the brutal-phone flow).
  await expect(page.getByRole('heading', { name: 'Safety — always here' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /SOS/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Safety pause/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Tell everyone/ })).toHaveCount(0);
  await expect(page.getByText(/Position shared with everyone/)).toHaveCount(0);

  // And the lobby radio is gone too — no region, no scope line, no
  // quick chips. Radio still lives on the play screen (Hunters /
  // Runners channels, live-hud.spec.ts).
  await expect(page.getByRole('region', { name: 'Lobby radio' })).toHaveCount(0);
  await expect(page.getByText(/Everyone in this lobby can read these messages/)).toHaveCount(0);
  await expect(page.getByText(/Let.s go!/)).toHaveCount(0);
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
