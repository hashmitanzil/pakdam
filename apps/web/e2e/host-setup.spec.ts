/**
 * host-setup.spec.ts — mode select, rules steppers, inline zone, team
 * controls. Demo-only. Text-only: DOM text and roles, no screenshots.
 *
 * Grounded in the built UI: the setup controls (mode card, steppers,
 * toggles, zone) live on the create screen (/room/[id]/setup); the
 * room code, players and summary strip live on the lobby (/room/[id]);
 * the same setup controls are also in the lobby's Settings sheet
 * (host only). Steppers are the "Increase/Decrease <label>" buttons
 * inside the group labelled <label>; toggles are switches by
 * aria-label; the zone is edited inline on the create screen
 * (Circle | Draw toggle above the map, Zone size / Corners steppers
 * below it).
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  createHostSetupRoom,
  setStepper,
  setupThreePlayerLobby,
} from './helpers';

test.describe('host setup (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('mode select: Infection card creates an Infection lobby', async ({ context }) => {
    const hostPage = await context.newPage();
    // The mode card is on the create screen — the code appears only
    // after CREATE LOBBY.
    await createHostSetupRoom(hostPage, 'Teo', 'Infection');
    await expect(hostPage.getByText('Infection', { exact: true }).first()).toBeVisible();
    await expect(hostPage.getByText('Tagged? You join the Hunters.')).toBeVisible();
  });

  test('Change on the mode card swaps Classic ↔ Infection in place', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    await expect(hostPage.getByText('Classic', { exact: true }).first()).toBeVisible();
    await expect(hostPage.getByText("Tagged? You're out. Watch live.")).toBeVisible();
    await hostPage.getByRole('button', { name: 'Change', exact: true }).click();
    await expect(hostPage.getByText('Tagged? You join the Hunters.')).toBeVisible();
    await hostPage.getByRole('button', { name: 'Change', exact: true }).click();
    await expect(hostPage.getByText("Tagged? You're out. Watch live.")).toBeVisible();
    // The summary strip lives on the lobby — CREATE LOBBY, then check it.
    await hostPage.getByRole('button', { name: 'CREATE LOBBY', exact: true }).click();
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expect(hostPage.getByLabel('Game summary')).toContainText('500m zone');
  });

  test('Round length stepper changes the value and the summary strip', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    const roundLength = hostPage.getByRole('group', { name: 'Round length' });
    await expect(roundLength.getByText('30 min')).toBeVisible();
    await setStepper(hostPage, 'Round length', 0); // 10 min
    await expect(roundLength.getByText('10 min')).toBeVisible();
    await hostPage.getByRole('button', { name: 'CREATE LOBBY', exact: true }).click();
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expect(hostPage.getByLabel('Game summary')).toContainText('· 10m');
    // The same stepper lives in the lobby Settings sheet — change it there.
    await hostPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await setStepper(hostPage, 'Round length', 5); // 60 min
    await expect(
      hostPage.getByRole('group', { name: 'Round length' }).getByText('60 min'),
    ).toBeVisible();
    await hostPage.getByRole('button', { name: 'Done' }).click();
    await expect(hostPage.getByLabel('Game summary')).toContainText('· 60m');
  });

  test('Head start stepper reaches None; Pings stepper reaches Off with its hint', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    await setStepper(hostPage, 'Head start', 0);
    await expect(
      hostPage.getByRole('group', { name: 'Head start' }).getByText('None'),
    ).toBeVisible();
    await setStepper(hostPage, 'Pings every', 0);
    await expect(
      hostPage.getByRole('group', { name: 'Pings every' }).getByText('Off'),
    ).toBeVisible();
    await expect(
      hostPage.getByText('No pings. Neither side sees the other — hunters get no locations at all, including for runners who leave the zone (no code emits a reveal on zone exit).'),
    ).toBeVisible();
    await hostPage.getByRole('button', { name: 'CREATE LOBBY', exact: true }).click();
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    await expect(hostPage.getByLabel('Game summary')).toContainText('no pings');
    await hostPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await setStepper(hostPage, 'Pings every', 4); // 3 min
    await expect(hostPage.getByText('How often both sides see where the other team is.')).toBeVisible();
    await hostPage.getByRole('button', { name: 'Done' }).click();
  });

  test('Zone shrinks toggle hides the Shrinks every stepper when OFF', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    await expect(hostPage.getByText('Shrinks every')).toBeVisible();
    await expect(
      hostPage.getByText('Auto from the round length — 3 shrinks per game. You can still change it below.'),
    ).toBeVisible();
    await hostPage.getByRole('switch', { name: 'Zone shrinks' }).click();
    await expect(hostPage.getByText('Shrinks every')).toBeHidden();
    await hostPage.getByRole('switch', { name: 'Zone shrinks' }).click();
    await expect(hostPage.getByText('Shrinks every')).toBeVisible();
  });

  test('Shrinks every stepper: steps along the snap grid [1, 3, 5, 10, 15, 20]', async ({
    context,
  }) => {
    // Grid stepping (fixed): − / + move to the adjacent grid value, so
    // Decrease from 10 min lands on 5, not 9 → snapped back to 10.
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    const stepper = hostPage.getByRole('group', { name: 'Shrinks every' });
    await expect(stepper.getByText('10 min')).toBeVisible();
    await hostPage.getByRole('button', { name: 'Decrease Shrinks every' }).click();
    await expect(stepper.getByText('5 min')).toBeVisible();
    await hostPage.getByRole('button', { name: 'Decrease Shrinks every' }).click();
    await expect(stepper.getByText('3 min')).toBeVisible();
    await hostPage.getByRole('button', { name: 'Increase Shrinks every' }).click();
    await expect(stepper.getByText('5 min')).toBeVisible();
    await hostPage.getByRole('button', { name: 'Increase Shrinks every' }).click();
    await expect(stepper.getByText('10 min')).toBeVisible();
    await hostPage.getByRole('button', { name: 'Increase Shrinks every' }).click();
    await expect(stepper.getByText('15 min')).toBeVisible();
    // Grid ends disable the buttons: 1 min has no Decrease, 20 min no Increase.
    await hostPage.getByRole('button', { name: 'Decrease Shrinks every' }).click();
    await hostPage.getByRole('button', { name: 'Decrease Shrinks every' }).click();
    await hostPage.getByRole('button', { name: 'Decrease Shrinks every' }).click();
    await hostPage.getByRole('button', { name: 'Decrease Shrinks every' }).click();
    await expect(stepper.getByText('1 min')).toBeVisible();
    await expect(
      hostPage.getByRole('button', { name: 'Decrease Shrinks every' }),
    ).toBeDisabled();
  });

  test('Play zone OFF hides the map and zone controls, shows the no-zone line', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    await hostPage.getByRole('switch', { name: 'Play zone' }).click();
    await expect(
      hostPage.getByText('No zone and no pings. Classic hide and seek — hunters get no locations at all.'),
    ).toBeVisible();
    await expect(hostPage.getByRole('group', { name: 'Zone size' })).toBeHidden();
    await hostPage.getByRole('switch', { name: 'Play zone' }).click();
    await expect(hostPage.getByRole('group', { name: 'Zone size' })).toBeVisible();
  });

  test('Balance OFF shows the Hunters stepper; Random OFF shows the pick hint', async ({
    context,
  }) => {
    const { hostPage } = await setupThreePlayerLobby(context);
    // Balance + Random live in the lobby Settings sheet (host only).
    await hostPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(hostPage.getByText('Set from the roster when the match starts — 2 for 6 players, 3 for 16.')).toBeVisible();
    await hostPage.getByRole('switch', { name: 'Balance hunters' }).click();
    await expect(hostPage.getByText('You choose the number yourself, below.')).toBeVisible();
    await expect(hostPage.getByText('Hunters', { exact: true }).first()).toBeVisible();
    await hostPage.getByRole('switch', { name: 'Random hunters' }).click();
    await expect(hostPage.getByText('Tap players in the roster to pick the Hunters.')).toBeVisible();
    await hostPage.getByRole('button', { name: 'Done' }).click();
    // Default hunter count is 2; the pick is cleared when the team
    // assignment changes, so the roster starts at 0 of 2.
    await expect(hostPage.getByText('0 of 2 Hunters picked — tap a player to pick them.')).toBeVisible();
  });

  test('Random OFF: tapping a roster row picks that Hunter', async ({ context }) => {
    const { hostPage } = await setupThreePlayerLobby(context);
    await hostPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await hostPage.getByRole('switch', { name: 'Balance hunters' }).click();
    await hostPage.getByRole('switch', { name: 'Random hunters' }).click();
    await hostPage.getByRole('button', { name: 'Done' }).click();
    await hostPage.getByRole('button', { name: 'Pick Ana as Hunter' }).click();
    await expect(hostPage.getByText('1 of 2 Hunters picked — tap a player to pick them.')).toBeVisible();
    await expect(hostPage.getByText('Hunter', { exact: true })).toBeVisible();
  });

  test('P1-26: no "Show ping history" toggle — the history was never implemented', async ({
    context,
  }) => {
    // The dead toggle is removed: a visible control must never promise a
    // feature that does not exist. The TeamControls section keeps Balance
    // hunters + Random hunters only.
    const hostPage = await context.newPage();
    await createHostSetupRoom(hostPage);
    await expect(hostPage.getByRole('switch', { name: 'Show ping history' })).toBeHidden();
    await expect(hostPage.getByText('Show ping history')).toBeHidden();
    await expect(
      hostPage.getByText("Hunters see each runner's earlier pings, not just the latest."),
    ).toBeHidden();
  });

  test('guest cannot change settings: summary strip opens the sheet read-only (v15), Settings shows a notice', async ({ context }) => {
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    const guest = guestPages[0]!;
    // v15: a joiner tapping the summary strip OPENS the sheet read-only —
    // the settings are visible, every control is disabled, the "View
    // only" line shows, and there is no Change button and no save path.
    await guest.getByLabel('Game summary').click();
    const sheet = guest.getByRole('dialog', { name: 'Settings' });
    await expect(sheet).toBeVisible();
    await expect(
      guest.getByText('View only — only the host can change settings.'),
    ).toBeVisible();
    await expect(guest.getByText('Round length')).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Decrease Round length' })).toBeDisabled();
    await expect(guest.getByRole('button', { name: 'Increase Round length' })).toBeDisabled();
    await expect(guest.getByRole('switch', { name: 'Zone shrinks' })).toBeDisabled();
    await expect(guest.getByRole('button', { name: 'Change', exact: true })).toBeHidden();
    await guest.getByRole('button', { name: 'Done' }).click();
    await expect(guest.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    // The RoomCodeCard SETTINGS button is a DIFFERENT control: a joiner
    // tapping it still gets the one-line notice and the sheet never opens.
    await guest.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(guest.getByText('Only the host can change the game settings.')).toBeVisible();
    await expect(guest.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    // The host CAN open it, and the steppers there are enabled.
    await hostPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(hostPage.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await expect(hostPage.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'Decrease Round length' })).toBeEnabled();
    await hostPage.getByRole('button', { name: 'Done' }).click();
  });
});
