// Host setup e2e — TEXT/DOM assertions only, no screenshots.
// Covers the brief's ShadowHunt customisation surface on /create:
// map-centred area, radius stepper unlimited beyond 1 km, Balance /
// Random toggles, match / head-start / ping steppers, shrink toggle +
// shrinks-every, ping-history toggle, sticky Start bar, and
// the lobby code + summary strip.
// Also the negative guards: NO area-name field, NO payment/membership,
// NO Find-a-Room / public listing, NO Zombie or Breach mode.
// Two modes are playable (Classic / Infection).
import { test, expect } from '@playwright/test';
import { createLobby, roomState, setPlayer, ROOM_KEY } from './helpers';

test('host setup: every stepper and toggle moves the live summary strip', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('Test Host');

  // Default draft: 500 m radius, Balance ON, 3 min ping, 30 min
  // match. The strip appears twice (intro line + sticky bar) —
  // assert the first. Text is the app's own builder,
  // roomSummaryStrip (draft.ts:210): radius compact
  // (formatRadiusCompact: 500 -> "500m"), Balance ON with no roster
  // known reads the smallest game (3 players -> 1 hunter,
  // balancedHunterCount), ping compact (180 s -> "3m"), duration
  // compact (1800 s -> "30m").
  await expect(page.getByText(/500m zone . 1 hunter . 3m pulse . 30m/i).first()).toBeVisible();

  // --- Mode: two modes are playable in host setup (Classic /
  // Infection). Zombie and Breach are later, not now — no radios,
  // no disabled buttons.
  await expect(page.getByRole('radio', { name: /^Classic/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Infection/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Zombie/ })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /^Breach/ })).toHaveCount(0);
  await page.getByRole('radio', { name: /^Infection/ }).check();
  await expect(page.getByRole('radio', { name: /^Infection/ })).toBeChecked();

  // --- Play area: Radius stepper (no slider on /create — the
  // slider lives only in the lobby Zone Editor; the old
  // #zone-radius slider fill + "Radius 1.5 km" lines are gone).
  // One Increase steps the radius 500 -> 550 m (50 m step,
  // types.ts ZONE_RADIUS_STEP_M); the stepper shows the compact
  // radius ("550m", formatRadiusCompact, draft.ts:180). The map's
  // old "Zone size: about 1.1 km across" line was removed
  // (founder cleanup, 2026-11-18) — the Radius output is the only
  // size readout in Circle mode now. The strip follows the radius:
  // "550m zone …".
  await page.getByRole('button', { name: /Increase Radius/ }).click();
  await expect(page.getByRole('group', { name: 'Radius' }).locator('output')).toHaveText('550m');
  await expect(page.getByText(/Zone size: about/i)).toHaveCount(0);
  await expect(page.getByText(/550m zone . 1 hunter . 3m pulse . 30m/i).first()).toBeVisible();
  // The "Radius at least 100 m, no maximum" line was removed in
  // simplification §5c — assert the removed text stays gone.
  await expect(page.getByText(/Radius at least 100 m, no maximum/i)).toHaveCount(0);

  // --- Draw mode: tap-to-place, NO default shape, NO Corners
  // stepper (founder spec, 2026-11-19). Switching to Draw creates
  // no shape: no point markers, Undo / Redraw / Done present with
  // Done disabled under 3 points, "not drawn yet" status + Size
  // across lines, and the validation error (create blocked until
  // the host taps 3 points and DONE). No map taps here — the
  // interactive tap/drag flow lives in map-tiles.spec.ts (key-gated).
  await page.getByRole('button', { name: /Use my location/ }).click();
  // The old "Zone centre: set" status line was removed in the
  // simplification round (§5c) — the centre-set evidence now is
  // the "Location found — … (GPS accuracy ±N m)" status line.
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±\d+ m\)/i).first()).toBeVisible();
  await page.getByRole('radio', { name: /Draw — your own shape on the map/ }).check();
  await expect(page.getByRole('radio', { name: /Draw — your own shape on the map/ })).toBeChecked();
  // No Corners stepper anywhere (the old "6 corners" default
  // hexagon is gone — Draw starts with no shape at all).
  await expect(page.getByRole('group', { name: 'Corners' })).toHaveCount(0);
  await expect(page.getByText(/corners/i)).toHaveCount(0);
  // No point markers yet, no drag-the-middle marker, no removed
  // buttons ("Start again" / "Remove corner" never existed in the
  // tap-to-place flow).
  await expect(page.locator('[aria-label^="Point "]')).toHaveCount(0);
  await expect(page.getByLabel(/Drag to move the whole zone/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Start again|Remove corner/ })).toHaveCount(0);
  // Draw buttons: Undo / Redraw / Done, all disabled at 0 points
  // (Done needs 3 points to enclose a zone).
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redraw', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Redraw', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  // "Not drawn yet" status + Size across lines.
  await expect(page.getByText(/Drawn zone:/)).toBeVisible();
  await expect(page.getByText(/not drawn yet — tap the map to place point 1/i)).toBeVisible();
  await expect(page.getByText(/Size across:/)).toBeVisible();
  await expect(page.getByText(/not drawn yet — tap the map to place points, then DONE/i)).toBeVisible();
  // Validation blocks create until the zone is drawn + DONE:
  // the draft error renders live (create/page.tsx renders
  // draftErrors[0] as the alert) and CREATE LOBBY is aria-disabled.
  await expect(page.getByText(/Draw the zone first — switch to Draw, tap at least 3 points on the map, then tap DONE\./)).toBeVisible();
  await expect(page.getByRole('button', { name: /CREATE LOBBY/ })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('radio', { name: /Circle/ }).check();
  // Back in Circle mode the Draw validation error is gone.
  await expect(page.getByText(/Draw the zone first/)).toHaveCount(0);

  // --- Players: Balance OFF reveals the Hunters stepper. ---
  await page.getByRole('switch', { name: 'Balance hunters' }).click();
  await expect(page.getByRole('switch', { name: 'Balance hunters' })).toHaveAttribute('aria-checked', 'false');
  // Balance OFF reads the stored hunter count (2, the
  // defaultDraft hunterCount — nothing before this changes it):
  // step it up to 3, then back down to 2.
  await page.getByRole('button', { name: /Increase Hunters/ }).click();
  // Zone is still 550 m radius (the Draw/Circle dance never
  // resized it); only the Hunter count moved, 2 -> 3.
  await expect(page.getByText(/550m zone . 3 hunters . 3m pulse . 30m/i).first()).toBeVisible();
  await page.getByRole('button', { name: /Decrease Hunters/ }).click();
  await expect(page.getByText(/550m zone . 2 hunters . 3m pulse . 30m/i).first()).toBeVisible();
  // Random OFF = host picks the Hunters in the lobby.
  await page.getByRole('switch', { name: 'Random hunters' }).click();
  await expect(page.getByText(/You pick the Hunters yourself in the lobby/i)).toBeVisible();
  await page.getByRole('switch', { name: 'Random hunters' }).click();

  // --- Timing steppers: match length, head start, ping. Each stepper
  // is a role=group named after its label; assert its own output. ---
  // Default is 30 min: Increase steps 30 -> 45 ("45 min"), then
  // Decrease steps back to 30 ("30 min"). The strip shows the
  // compact duration ("45m" / "30m", formatCompactInterval,
  // draft.ts:189) and the compact ping ("3m" / "5m" pulse).
  await page.getByRole('button', { name: /Increase Match length/ }).click();
  await expect(page.getByRole('group', { name: 'Match length' }).locator('output')).toHaveText('45 min');
  await expect(page.getByText(/550m zone . 2 hunters . 3m pulse . 45m/i).first()).toBeVisible();
  await page.getByRole('button', { name: /Decrease Match length/ }).click();
  await expect(page.getByRole('group', { name: 'Match length' }).locator('output')).toHaveText('30 min');
  await page.getByRole('button', { name: /Increase Head start/ }).click();
  await expect(page.getByRole('group', { name: 'Head start' }).locator('output')).toHaveText('5 min');
  await page.getByRole('button', { name: /Decrease Head start/ }).click();
  await page.getByRole('button', { name: /Increase Location ping/ }).click();
  await expect(page.getByRole('group', { name: 'Location ping' }).locator('output')).toHaveText('5 min');
  await expect(page.getByText(/550m zone . 2 hunters . 5m pulse . 30m/i).first()).toBeVisible();

  // --- Rules: shrink toggle + shrinks-every, ping history, radio. ---
  await expect(page.getByRole('switch', { name: 'Shrinking zone' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: /Increase Shrinks every/ }).click();
  await expect(page.getByRole('group', { name: 'Shrinks every' }).locator('output')).toHaveText('20 min');
  await page.getByRole('switch', { name: 'Show ping history' }).click();
  await expect(page.getByRole('switch', { name: 'Show ping history' })).toHaveAttribute('aria-checked', 'true');
  // No "Hunters can talk" setup toggle any more (removed in the
  // video rebuild, 2026-11-18 — voice radio is a play-screen
  // feature, not a setup option): assert it stays gone.
  await expect(page.getByRole('switch', { name: 'Hunters can talk' })).toHaveCount(0);

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
  await page.getByLabel(/codename/i).fill('No Zone Host');
  await page.getByRole('switch', { name: 'Play zone' }).click();
  await expect(page.getByRole('switch', { name: 'Play zone' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText(/No play zone in this game — and no pings/i)).toBeVisible();
  await expect(page.getByText(/No shrinking zone in this game/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Increase Location ping/ })).toBeDisabled();
  // Zone off -> "no zone", ping 0 -> "no pings", Balance ON with no
  // roster known -> 1 hunter, duration compact "30m"
  // (roomSummaryStrip, draft.ts:210).
  await expect(page.getByText(/no zone . 1 hunter . no pings . 30m/i).first()).toBeVisible();
  // No centre needed: create works without "Use my location".
  await page.getByLabel(/I have checked the venue/i).check();
  await page.getByLabel(/I will be on site/i).check();
  await page.getByRole('button', { name: /CREATE LOBBY/ }).click();
  await expect(page).toHaveURL(/\/room\/[0-9a-f-]+$/);
  const created = await roomState(page);
  expect(created!.room.config.playZoneEnabled).toBe(false);
  expect(created!.room.config.pingIntervalSeconds).toBe(0);
});

// (House-preset save/load test DELETED with the feature — presets
// were removed in the video rebuild, 2026-11-18; there is no
// save/load UI left to test. The removal itself is guarded by the
// "House-rule presets" count-0 assertion in join-lobby.spec.ts.)

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
  const { roomId, roomCode, hostId } = await createLobby(page, context);
  expect(roomCode).toMatch(/^[A-Z0-9]{6}$/);
  // Code hero + invite actions.
  await expect(page.getByText(roomCode)).toBeVisible();
  await expect(page.getByRole('button', { name: /Copy code/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Share code/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Copy invite link/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Settings/ })).toBeVisible();
  // Summary strip: the compact builder line on the strip button
  // (room/[roomId]/page.tsx:926 renders roomSummaryStrip with NO
  // roster passed, so Balance ON reads the smallest game — 1
  // hunter — and the duration is compact "30m").
  const strip = page.getByRole('button', { name: /^Game settings:/ });
  await expect(strip).toContainText('500m zone · 1 hunter · 3m pulse · 30m');
  // Lobby trim (2026-11-19): the "This game" facts grid is deleted —
  // every fact already lives in the Game Settings sheet, and the
  // summary strip above is the lobby's single source for the match
  // settings (roomSummaryStrip: "500m zone · 1 hunter · 3m pulse · 30m").
  await expect(page.getByText(/Players \(1\/30\)/)).toBeVisible();
  await expect(page.getByText(/1 of at least 3 players in/i)).toBeVisible();
  await setPlayer(page, hostId);
  expect(roomId).toMatch(/^[0-9a-f-]+$/);
});
