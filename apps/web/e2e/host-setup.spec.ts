/**
 * host-setup.spec.ts — mode select, rules steppers, inline zone, team
 * controls. Demo-only. Text-only: DOM text and roles, no screenshots.
 *
 * Grounded in the built UI: steppers are the "Increase/Decrease <label>"
 * buttons inside the group labelled <label>; toggles are switches by
 * aria-label; the zone is edited inline on the lobby (Circle | Draw
 * toggle above the map, Zone size / Corners steppers below it).
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  createHostRoom,
  setStepper,
  setupThreePlayerLobby,
} from './helpers';

test.describe('host setup (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('mode select: Infection card creates an Infection lobby', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage, 'Teo', 'Infection');
    await expect(hostPage.getByText('Infection', { exact: true }).first()).toBeVisible();
    await expect(hostPage.getByText('Tagged? You join the Hunters.')).toBeVisible();
  });

  test('Change on the mode card swaps Classic ↔ Infection in place', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    await hostPage.getByRole('button', { name: 'Change', exact: true }).click();
    await expect(hostPage.getByText('Tagged? You join the Hunters.')).toBeVisible();
    await expect(hostPage.getByLabel('Game summary')).toContainText('500m zone');
    await hostPage.getByRole('button', { name: 'Change', exact: true }).click();
    await expect(hostPage.getByText("Tagged? You're out. Watch live.")).toBeVisible();
  });

  test('Round length stepper changes the value and the summary strip', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    const roundLength = hostPage.getByRole('group', { name: 'Round length' });
    await expect(roundLength.getByText('30 min')).toBeVisible();
    await setStepper(hostPage, 'Round length', 0); // 10 min
    await expect(roundLength.getByText('10 min')).toBeVisible();
    await expect(hostPage.getByLabel('Game summary')).toContainText('· 10m');
    await setStepper(hostPage, 'Round length', 5); // 60 min
    await expect(roundLength.getByText('60 min')).toBeVisible();
    await expect(hostPage.getByLabel('Game summary')).toContainText('· 60m');
  });

  test('Head start stepper reaches None; Pings stepper reaches Off with its hint', async ({
    context,
  }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    await setStepper(hostPage, 'Head start', 0);
    await expect(
      hostPage.getByRole('group', { name: 'Head start' }).getByText('None'),
    ).toBeVisible();
    await setStepper(hostPage, 'Pings every', 0);
    await expect(
      hostPage.getByRole('group', { name: 'Pings every' }).getByText('Off'),
    ).toBeVisible();
    await expect(
      hostPage.getByText('No pings. Hunters only see runners who leave the zone.'),
    ).toBeVisible();
    await expect(hostPage.getByLabel('Game summary')).toContainText('no pings');
    await setStepper(hostPage, 'Pings every', 4); // 3 min
    await expect(hostPage.getByText('How often hunters see where runners are.')).toBeVisible();
  });

  test('Zone shrinks toggle hides the Shrinks every stepper when OFF', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    await expect(hostPage.getByText('Shrinks every')).toBeVisible();
    await expect(hostPage.getByText('How long players get between each shrink.')).toBeVisible();
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
    await createHostRoom(hostPage);
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
    await createHostRoom(hostPage);
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
    await expect(hostPage.getByText('Set from the roster when the match starts — 2 for 6 players, 3 for 16.')).toBeVisible();
    await hostPage.getByRole('switch', { name: 'Balance hunters' }).click();
    await expect(hostPage.getByText('You choose the number yourself, below.')).toBeVisible();
    await expect(hostPage.getByText('Hunters', { exact: true }).first()).toBeVisible();
    await hostPage.getByRole('switch', { name: 'Random hunters' }).click();
    await expect(hostPage.getByText('Tap players in the roster to pick the Hunters.')).toBeVisible();
    await expect(hostPage.getByText('0 of 1 Hunters picked — tap a player to pick them.')).toBeVisible();
  });

  test('Random OFF: tapping a roster row picks that Hunter', async ({ context }) => {
    const { hostPage } = await setupThreePlayerLobby(context);
    await hostPage.getByRole('switch', { name: 'Balance hunters' }).click();
    await hostPage.getByRole('switch', { name: 'Random hunters' }).click();
    await hostPage.getByRole('button', { name: 'Pick Ana as Hunter' }).click();
    await expect(hostPage.getByText('1 of 1 Hunters picked — tap a player to pick them.')).toBeVisible();
    await expect(hostPage.getByText('Hunter', { exact: true })).toBeVisible();
  });

  test('Show ping history toggle flips on', async ({ context }) => {
    const hostPage = await context.newPage();
    await createHostRoom(hostPage);
    const toggle = hostPage.getByRole('switch', { name: 'Show ping history' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(
      hostPage.getByText("Hunters see each runner's earlier pings, not just the latest."),
    ).toBeVisible();
  });

  test('guest cannot change settings: summary tap answers in one line', async ({ context }) => {
    const { hostPage, guestPages } = await setupThreePlayerLobby(context);
    const guest = guestPages[0]!;
    await guest.getByLabel('Game summary').click();
    await expect(guest.getByText('Only the host can change the game settings.')).toBeVisible();
    // Guest steppers are disabled.
    await expect(guest.getByRole('button', { name: 'Decrease Round length' })).toBeDisabled();
    await expect(hostPage.getByRole('button', { name: 'Decrease Round length' })).toBeEnabled();
  });
});
