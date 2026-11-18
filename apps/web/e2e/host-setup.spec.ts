// Host setup e2e — TEXT/DOM assertions only, no screenshots.
// Covers the brief's ShadowHunt customisation surface on /create:
// map-centred area, radius stepper unlimited beyond 1 km, Balance /
// Random toggles, match / head-start / ping steppers, shrink toggle +
// shrinks-every, ping-history toggle, presets, sticky Start bar, and
// the lobby code + summary strip.
// Also the negative guards: NO area-name field, NO payment/membership,
// NO Find-a-Room / public listing, NO Zombie or Breach mode.
// Two modes are playable (Classic / Infection).
import { test, expect } from '@playwright/test';
import { clickPresetChip, createLobby, roomState, setPlayer, ROOM_KEY } from './helpers';

test('host setup: every stepper and toggle moves the live summary strip', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await page.goto('/create');
  await clickPresetChip(page, 'Standard');
  await page.getByLabel(/codename/i).fill('Test Host');

  // Default Standard draft: 500 m radius (1.0 km across), 2 Hunters,
  // 3 min ping, 60 min match. The strip appears twice (intro line +
  // sticky bar) — assert the first. Text is the app's own formatters:
  // formatDistance(1000) -> "1.0 km", formatMinutes(60) -> "1 h".
  await expect(page.getByText(/1\.0 km zone . 2 hunters . 3 min pulse . 1 h/i).first()).toBeVisible();

  // --- Mode: two modes are playable in host setup (Classic /
  // Infection). Zombie and Breach are later, not now — no radios,
  // no disabled buttons.
  await expect(page.getByRole('radio', { name: /^Classic/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Infection/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Zombie/ })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /^Breach/ })).toHaveCount(0);
  await page.getByRole('radio', { name: /^Infection/ }).check();
  await expect(page.getByRole('radio', { name: /^Infection/ })).toBeChecked();

  // --- Play area: Zone size stepper (no slider on /create — the
  // slider lives only in the lobby Zone Editor; the old
  // #zone-radius slider fill + "Radius 1.5 km" lines are gone). ---
  await page.getByRole('button', { name: /Increase Zone size/ }).click();
  await expect(page.getByText(/1\.1 km zone . 2 hunters/i).first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Zone size' }).locator('output')).toHaveText('about 1.1 km across');
  // The "Radius at least 100 m, no maximum" line was removed in
  // simplification §5c — assert the removed text stays gone.
  await expect(page.getByText(/Radius at least 100 m, no maximum/i)).toHaveCount(0);

  // --- Draw mode: corners stepper appears, size-across line updates. ---
  await page.getByRole('button', { name: /Use my location/ }).click();
  // The old "Zone centre: set" status line was removed in the
  // simplification round (§5c) — the centre-set evidence now is
  // the "Location found — … (GPS accuracy ±N m)" status line.
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±\d+ m\)/i).first()).toBeVisible();
  await page.getByRole('radio', { name: /Draw/ }).check();
  // "6 corners" also appears in the map's "Drawn zone: 6 corners"
  // line, so assert the Corners stepper's own output exactly.
  await expect(page.getByRole('group', { name: 'Corners' }).locator('output')).toHaveText('6 corners');
  await page.getByRole('button', { name: /Increase Corners/ }).click();
  await expect(page.getByRole('group', { name: 'Corners' }).locator('output')).toHaveText('8 corners');
  await expect(page.getByText(/Size across:/)).toBeVisible();
  await page.getByRole('radio', { name: /Circle/ }).check();

  // --- Players: Balance OFF reveals the Hunters stepper. ---
  await page.getByRole('switch', { name: 'Balance hunters' }).click();
  await expect(page.getByRole('switch', { name: 'Balance hunters' })).toHaveAttribute('aria-checked', 'false');
  // Balance OFF reads the stored hunter count (2, from the Standard
  // preset — nothing before this changes it): step it up to 3, then
  // back down to 2.
  await page.getByRole('button', { name: /Increase Hunters/ }).click();
  await expect(page.getByText(/3\.0 km zone . 3 hunters/i).first()).toBeVisible();
  await page.getByRole('button', { name: /Decrease Hunters/ }).click();
  await expect(page.getByText(/3\.0 km zone . 2 hunters/i).first()).toBeVisible();
  // Random OFF = host picks the Hunters in the lobby.
  await page.getByRole('switch', { name: 'Random hunters' }).click();
  await expect(page.getByText(/You pick the Hunters yourself in the lobby/i)).toBeVisible();
  await page.getByRole('switch', { name: 'Random hunters' }).click();

  // --- Timing steppers: match length, head start, ping. Each stepper
  // is a role=group named after its label; assert its own output. ---
  // Standard is 60 min: Increase steps 60 -> 90 ("1 h 30 min"), then
  // Decrease steps back to 60 ("1 h").
  await page.getByRole('button', { name: /Increase Match length/ }).click();
  await expect(page.getByRole('group', { name: 'Match length' }).locator('output')).toHaveText('1 h 30 min');
  await expect(page.getByText(/3\.0 km zone . 1 hunter . 3 min pulse . 1 h 30 min/i).first()).toBeVisible();
  await page.getByRole('button', { name: /Decrease Match length/ }).click();
  await expect(page.getByRole('group', { name: 'Match length' }).locator('output')).toHaveText('1 h');
  await page.getByRole('button', { name: /Increase Head start/ }).click();
  await expect(page.getByRole('group', { name: 'Head start' }).locator('output')).toHaveText('5 min');
  await page.getByRole('button', { name: /Decrease Head start/ }).click();
  await page.getByRole('button', { name: /Increase Location ping/ }).click();
  await expect(page.getByRole('group', { name: 'Location ping' }).locator('output')).toHaveText('5 min');
  await expect(page.getByText(/3\.0 km zone . 1 hunter . 5 min pulse . 1 h/i).first()).toBeVisible();

  // --- Rules: shrink toggle + shrinks-every, ping history, radio. ---
  await expect(page.getByRole('switch', { name: 'Shrinking zone' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: /Increase Shrinks every/ }).click();
  await expect(page.getByRole('group', { name: 'Shrinks every' }).locator('output')).toHaveText('20 min');
  await page.getByRole('switch', { name: 'Show ping history' }).click();
  await expect(page.getByRole('switch', { name: 'Show ping history' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('switch', { name: 'Hunters can talk' }).click();
  await expect(page.getByText(/radio is off for this game/i)).toBeVisible();
  await page.getByRole('switch', { name: 'Hunters can talk' }).click();

  // --- Discovery: REMOVED (founder decision, 2026-11-17). Private
  // invite-only by room code — no "List to players nearby" switch, no
  // nearby-rooms list, no public listing anywhere.
  await expect(page.getByRole('switch', { name: /List to players nearby/i })).toHaveCount(0);
  await expect(page.getByText(/nearest 100 m/i)).toHaveCount(0);

  // --- Negative guards: no area/place-name field, no payment. ---
  // Textbox only: the two safety checkboxes legitimately contain
  // the word "venue" in their labels ("I have checked the venue…",
  // "…on site at the venue…") — they are confirmations, not a
  // name field, so an unscoped getByLabel(/venue/…) has always
  // matched them. The guard is that no TEXT field asks for a name.
  await expect(page.getByRole('textbox', { name: /venue|place name|area name/i })).toHaveCount(0);
  await expect(page.getByText(/Everything is free: no payment, no membership, no paywall/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /subscribe|upgrade|pay now|buy/i })).toHaveCount(0);

  // --- Sticky CREATE LOBBY bar: still in the viewport at the bottom. ---
  await page.getByLabel(/I have checked the venue/i).check();
  await page.getByLabel(/I will be on site/i).check();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const createBtn = page.getByRole('button', { name: /CREATE LOBBY/ });
  await expect(createBtn).toBeVisible();
  const box = await createBtn.boundingBox();
  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(box, 'CREATE LOBBY must be visible without scrolling back up').not.toBeNull();
  // boundingBox() returns {x, y, width, height} — there is no
  // .bottom, so the button's bottom edge is y + height.
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight + 1);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  // Create with the customised draft and verify the store kept it.
  await createBtn.click();
  await expect(page).toHaveURL(/\/room\/[0-9a-f-]+$/);
  const created = await roomState(page);
  expect(created!.room.config.mode).toBe('infection');
  expect(created!.room.config.pingIntervalSeconds).toBe(300);
  expect(created!.room.config.showPingHistory).toBe(true);
  expect(created!.room.config.zoneShrinkIntervalSeconds).toBe(1200);
});

test('host setup: play zone off disables ping + shrink and needs no centre', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/create');
  await clickPresetChip(page, 'Standard');
  await page.getByLabel(/codename/i).fill('No Zone Host');
  await page.getByRole('switch', { name: 'Play zone' }).click();
  await expect(page.getByRole('switch', { name: 'Play zone' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText(/No play zone in this game — and no pings/i)).toBeVisible();
  await expect(page.getByText(/No shrinking zone in this game/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Increase Location ping/ })).toBeDisabled();
  await expect(page.getByText(/no zone . 2 hunters . no pings . 1 h/i).first()).toBeVisible();
  // No centre needed: create works without "Use my location".
  await page.getByLabel(/I have checked the venue/i).check();
  await page.getByLabel(/I will be on site/i).check();
  await page.getByRole('button', { name: /CREATE LOBBY/ }).click();
  await expect(page).toHaveURL(/\/room\/[0-9a-f-]+$/);
  const created = await roomState(page);
  expect(created!.room.config.playZoneEnabled).toBe(false);
  expect(created!.room.config.pingIntervalSeconds).toBe(0);
});

test('host setup: house preset saves and reloads on this device', async ({ page, context }) => {
  test.setTimeout(60_000);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('Preset Host');
  await page.getByRole('button', { name: /Increase Match length/ }).click();
  await page.getByLabel(/Save the current settings as a preset/i).fill('E2E House Rules');
  await page.getByRole('button', { name: /Save preset/ }).click();
  await expect(page.getByText(/Saved “E2E House Rules”/i)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/E2E House Rules/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Load$/ })).toBeVisible();
  await page.getByRole('button', { name: /^Load$/ }).click();
  await expect(page.getByText(/Loaded “E2E House Rules”/i)).toBeVisible();
});

test('host setup: an Infection room can be created through the UI', async ({ page, context }) => {
  test.setTimeout(120_000);
  // Room ids are read from the lobby URL, not from the store's first
  // room — this test creates one room in its context.
  const configFor = async (roomId: string) =>
    page.evaluate(([key, id]) => {
      const all = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, { room: { config: { mode: string; hunterCount: number; balanceHunters: boolean; zoneShrinkEnabled: boolean } } }>;
      return all[id]!.room.config;
    }, [ROOM_KEY, roomId]);

  await createLobby(page, context, {
    preset: 'Standard',
    codename: 'Infection Host',
    configureDraft: async (p) => {
      await p.getByRole('radio', { name: /^Infection/ }).check();
      await expect(p.getByRole('radio', { name: /^Infection/ })).toBeChecked();
    },
  });
  const infectionRoomId = page.url().split('/room/')[1]!;
  const infection = await configFor(infectionRoomId);
  expect(infection.mode).toBe('infection');
  expect(infection.hunterCount).toBe(2);
});

test('host setup: create lobby shows code, invite actions and summary strip', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context, { preset: 'Standard' });
  expect(roomCode).toMatch(/^[A-Z0-9]{6}$/);
  // Code hero + invite actions.
  await expect(page.getByText(roomCode)).toBeVisible();
  await expect(page.getByRole('button', { name: /Copy code/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Share code/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Copy invite link/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Settings/ })).toBeVisible();
  // Summary strip: Zone / Hunters / Ping every / Duration.
  const strip = page.getByRole('region', { name: 'Match summary' });
  await expect(strip).toContainText('Zone');
  await expect(strip).toContainText('Hunters');
  await expect(strip).toContainText('2 Hunters');
  await expect(strip).toContainText('Ping every');
  await expect(strip).toContainText('3 min');
  await expect(strip).toContainText('Duration');
  // Standard duration is 3600 s; the lobby's fmtMinutes renders it
  // as "60 min" (unlike the create strip's formatMinutes "1 h").
  await expect(strip).toContainText('60 min');
  // "This game" facts agree with the strip.
  await expect(page.getByText(/Players \(1\/6\)/)).toBeVisible();
  await expect(page.getByText(/1 of at least 3 players in/i)).toBeVisible();
  await setPlayer(page, hostId);
  expect(roomId).toMatch(/^[0-9a-f-]+$/);
});
