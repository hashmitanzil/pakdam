// Live HUD e2e — TEXT/DOM assertions only, no screenshots.
// Covers the brief's live game: head-start tutorial, HUD (time left,
// next ping, zone, runners left), persistent pings with an age that
// counts up ("0:27 ago" clock), the ONE bundled offline map (no map
// styles — no Standard / Dark / Satellite switcher), bottom tabs
// Map / Radar / Radio, the Hunters radio channel, safety pause +
// SOS + Get help, the colour-blind theme, and the app-wide Dark mode
// (see the last test — it exists now: a switch in the More sheet
// and on /accessibility, key pakdam.dark-mode).
import { test, expect } from '@playwright/test';
import { roomState, setPlayer, startMatch } from './helpers';

test('start → head-start tutorial → live HUD with time, ping, zone, runners', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, hostId, runners } = await startMatch(page, context, { pickHunters: 'host', waitActive: false });
  expect(runners.length).toBeGreaterThanOrEqual(3);

  // Head-start tutorial card (role-specific steps for the Hunter host).
  await expect(page.getByRole('heading', { name: 'Head start — what to do now' })).toBeVisible();
  await expect(page.getByText(/Wait where you are\. Runners are scattering/i)).toBeVisible();
  await expect(page.getByText(/A catch only counts in person/i)).toBeVisible();
  // The head start lasts the CONFIGURED time (30 s in this suite) and
  // the banner counts it down — never a hardcoded 5 s.
  await expect(page.getByText(/Hunt starts in 0:\d\d/i)).toBeVisible();
  await expect(page.getByText(/the configured head start is 0:30/i)).toBeVisible();

  // Role reveal: hidden until tapped ("No peeking").
  await expect(page.getByRole('heading', { name: /No peeking/ })).toBeVisible();
  await expect(page.getByText(/tap below to reveal/)).toBeVisible();
  await page.getByRole('button', { name: /Tap to find out your role/i }).click();
  await expect(page.getByText(/You are:/)).toContainText(/hunter/i);
  await expect(page.getByText(/You are.*a Hunter/)).toBeVisible();

  // Live HUD once ACTIVE: time left, next ping, zone + shrink, runners.
  const hud = page.getByRole('region', { name: 'Match status' });
  await expect(hud).toContainText('Active — hunt on', { timeout: 60_000 });
  await expect(hud).toContainText('Time left');
  // Standard is a 60 min match (CALIBRATION_OPEN.standardDurationSeconds
  // = 3600), so just after ACTIVE the clock reads 59:xx — the old
  // 29:xx was written when Standard was 30 min.
  await expect(hud).toContainText(/59:\d\d/);
  await expect(hud).toContainText('Next ping');
  await expect(hud).toContainText(/in \d:\d\d/);
  await expect(hud).toContainText('Coarse area only — never an exact pin');
  await expect(hud).toContainText('Zone');
  // Zone label is the app's own formatter: the Standard 500 m circle
  // polygon measures 999 m across (zoneDiameterMeters over the
  // equirectangular 32-gon), so the HUD reads "About 999 m across" —
  // never "About 1 km across".
  await expect(hud).toContainText(/About 999 m across/);
  await expect(hud).toContainText(/Shrinks in \d:\d\d/);
  await expect(hud).toContainText(`${runners.length} of ${runners.length} Runners`);
  await expect(hud).toContainText('Nobody caught yet.');
  await expect(hud).toContainText('Classic Manhunt');
  await expect(hud).toContainText('Teams: host picked');
  // Outside-zone rule is printed on the play page (the banner itself
  // only appears while outside — see outside-zone.spec.ts).
  await expect(page.getByText(/Outside-zone rule: 30 seconds to get back inside/i)).toBeVisible();
  // Location is default-on while the round runs (foreground only).
  await expect(page.getByText(/Location is shared by default while the round is running/i)).toBeVisible();

  // Bottom tabs: Map / Radar / Radio + More sheet.
  await expect(page.getByRole('tab', { name: 'Map' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Radar' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Radio' })).toBeVisible();
  await expect(page.getByRole('button', { name: /More options/ })).toBeVisible();
  expect(roomId).toMatch(/^[0-9a-f-]+$/);
  expect(hostId).toMatch(/^[0-9a-f-]+$/);
});

test('persistent ping stays with an age that counts up (history OFF)', async ({ page, context }) => {
  test.setTimeout(120_000);
  await startMatch(page, context, { pickHunters: 'host' });
  const state = await roomState(page);
  expect(state!.room.config.showPingHistory).toBe(false);

  // Hunter tool on the Radar tab: simulate two scheduled pings.
  await page.getByRole('tab', { name: 'Radar' }).click();
  await expect(page.getByRole('heading', { name: /Compass radar/ })).toBeVisible();
  await page.getByRole('button', { name: /Simulate a scheduled ping/i }).click();
  await page.getByRole('button', { name: /Simulate a scheduled ping/i }).click();
  await expect(page.getByText(/Latest ping:/)).toContainText(/Reported just now/);

  // Back on the Map tab only the latest area shows — and it STAYS:
  // pings are never removed on a timer, the age counts up.
  await page.getByRole('tab', { name: 'Map' }).click();
  const caption = page.getByText(/Shaded blue areas: Nearest ping area \(/);
  await expect(caption).toBeVisible();
  await expect(caption).toContainText(/Only the latest ping shows/);
  await expect(caption).toContainText(/Show ping history is off/);
  await expect(caption).toContainText(/just now/);
  await page.waitForTimeout(12_000);
  await expect(caption).toBeVisible();
  await expect(caption).toContainText(/Nearest ping area \(0:\d\d ago\)/);
});

test('ping history ON keeps earlier ping areas visible (dimmer, with ages)', async ({ page, context }) => {
  test.setTimeout(120_000);
  await startMatch(page, context, {
    pickHunters: 'host',
    configureDraft: async (p) => {
      await p.getByRole('switch', { name: 'Show ping history' }).click();
    },
  });
  const state = await roomState(page);
  expect(state!.room.config.showPingHistory).toBe(true);

  await page.getByRole('tab', { name: 'Radar' }).click();
  await page.getByRole('button', { name: /Simulate a scheduled ping/i }).click();
  await page.getByRole('button', { name: /Simulate a scheduled ping/i }).click();
  await page.getByRole('tab', { name: 'Map' }).click();
  const caption = page.getByText(/Shaded blue areas:/);
  await expect(caption).toBeVisible();
  await expect(caption).toContainText(/Nearest ping area \(/);
  await expect(caption).toContainText(/Earlier ping area \(/);
  await expect(caption).toContainText(/Earlier pings stay visible \(dimmer\) because Show ping history is on/);
});

test('offline map: one bundled map, no style switcher, tiles come from the app', async ({ page, context }) => {
  test.setTimeout(120_000);
  await startMatch(page, context, { pickHunters: 'host' });
  // ONE map, no switcher (founder decision, 2026-11-17): there is no
  // "Map style" group and no Standard / Satellite / Dark buttons.
  await expect(page.getByRole('group', { name: 'Map style' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Satellite', exact: true })).toHaveCount(0);
  // The offline map is showing: canvas + the bundled-map caption.
  // The offline map renders OFFLINE_MAP_AREA_MESSAGE
  // ('Offline map: downloaded area only') — the older
  // 'Offline map — Doranda + Hinoo' caption text no longer exists
  // in the UI (MapLibreMapView.tsx), so assert the text that is
  // actually rendered.
  await expect(page.locator('.mapbox .maplibregl-canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Offline map: downloaded area only/)).toBeVisible();
  // The fix (23.36, 85.33) is INSIDE the downloaded area, so the
  // outside-area message must NOT show — it is the one exception
  // that names Ranchi ("Map downloaded for Ranchi only") and only
  // renders when the fix leaves the downloaded area (see
  // map-tiles.spec.ts, live-play test).
  await expect(page.getByText(/Map downloaded for Ranchi only/)).toHaveCount(0);
  // The match still runs: the HUD shows the match.
  await expect(page.getByRole('region', { name: 'Match status' })).toContainText('Active — hunt on');
});

test('runner view: safe check-in + refresh, radar note, runner radio channel', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { hostId } = await startMatch(page, context, { pickHunters: 'others' });
  await setPlayer(page, hostId);
  // The role line only names the role after the "No peeking" reveal.
  await page.getByRole('button', { name: /Tap to find out your role/i }).click();
  await expect(page.getByText(/You are:/)).toContainText(/runner/i);

  // Thumb-zone primary action for a Runner (scoped: the same label
  // also appears in the role toolbar further down the page).
  const thumb = page.locator('.thumb-zone');
  await expect(thumb.getByRole('button', { name: /safe/ })).toBeVisible();
  await thumb.getByRole('button', { name: /safe/ }).click();
  await expect(page.getByText(/check-in recorded/i)).toBeVisible();

  // Manual refresh sends one fresh fix immediately.
  await thumb.getByRole('button', { name: /Refresh my location/i }).click();
  await expect(page.getByText(/Location refreshed/i)).toBeVisible();
  // The status says "latest fix", not "fresh fix" (play page
  // refreshLocation) — "one fresh fix sent" never renders.
  await expect(page.getByText(/latest fix sent/i)).toBeVisible();
  await expect(page.getByText(/Last updated just now/i)).toBeVisible();

  // Radar: Runners never see Hunter positions.
  await page.getByRole('tab', { name: 'Radar' }).click();
  await expect(page.getByText(/Runners never see Hunter positions/i)).toBeVisible();
  // Radio tab: the Runners-only channel (Hunters never see it).
  await page.getByRole('tab', { name: 'Radio' }).click();
  const radio = page.getByRole('region', { name: 'Runner radio ▲ R' });
  await expect(radio).toBeVisible();
  await expect(radio).toContainText(/Only Runners can read this channel/);
  await radio.getByRole('button', { name: /I.m safe for now/ }).click();
  await expect(radio.getByText(/I.m safe for now/)).toBeVisible();
});

test('hunter radio channel: quick messages are Hunters-only', async ({ page, context }) => {
  test.setTimeout(120_000);
  await startMatch(page, context, { pickHunters: 'host' });
  await page.getByRole('tab', { name: 'Radio' }).click();
  const radio = page.getByRole('region', { name: 'Hunter radio ◆ H' });
  await expect(radio).toBeVisible();
  await expect(radio).toContainText(/Only Hunters can read this channel/);
  await radio.getByRole('button', { name: /Cover the far edge/ }).click();
  await expect(radio.getByText(/Cover the far edge/)).toBeVisible();
  await expect(radio.getByText(/Text only in this web version/)).toBeVisible();
});

test('safety pause, SOS and Get help from the play screen', async ({ page, context }) => {
  test.setTimeout(120_000);
  await startMatch(page, context, { pickHunters: 'host' });

  // Safety pause from the HUD bar (scoped: the SafetyControls bar at
  // the bottom has a second pause button with the same aria-label),
  // then resume.
  const hud = page.getByRole('region', { name: 'Match status' });
  await hud.getByRole('button', { name: /Safety pause/ }).click();
  await expect(page.getByText(/Game paused\./)).toBeVisible();
  await expect(hud).toContainText('Paused');
  await hud.getByRole('button', { name: /Resume game/ }).click();
  await expect(hud).toContainText('Active — hunt on');

  // SOS asks for confirmation, then tells the host.
  page.once('dialog', (d) => d.accept());
  await hud.getByRole('button', { name: /shares your position with the host/ }).click();
  await expect(page.getByText(/SOS sent to your host\./)).toBeVisible();

  // Get help link goes to the help page.
  await page.getByRole('link', { name: /safety rules, report a problem/ }).click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByText(/Which help do you need/i)).toBeVisible();
});

test('appearance: one dark theme — no colour-blind theme, no Dark mode toggle anywhere', async ({ page, context }) => {
  test.setTimeout(120_000);
  await startMatch(page, context, { pickHunters: 'host' });
  await page.getByRole('button', { name: /More options/ }).click();
  const sheet = page.getByRole('region', { name: 'More options' });
  await expect(sheet).toBeVisible();
  // Simplification §5a (2026-11-18): ONE dark theme — the
  // colour-blind theme and the Dark mode toggle were removed
  // everywhere. The old test toggled them here and asserted the
  // `cb-theme` / `dark` classes and localStorage keys; now the
  // test asserts the controls are gone from the More sheet and
  // from /accessibility, and that no theme classes/keys appear.
  await expect(sheet.getByLabel(/Colour-blind theme/)).toHaveCount(0);
  await expect(sheet.getByLabel(/Dark mode/)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.classList.contains('cb-theme'))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('pakdam.colorblind-theme'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('pakdam.dark-mode'))).toBeNull();

  // The same controls are gone from /accessibility too (Large text
  // / High contrast stay). There is NO map Dark style and no
  // "Map style" setting any more (one-map decision, 2026-11-17):
  // the map is one bundled offline map with no style switcher.
  await page.goto('/accessibility');
  await expect(page.getByRole('heading', { name: /Accessibility/ })).toBeVisible();
  await expect(page.getByLabel(/Large text/)).toBeVisible();
  await expect(page.getByLabel(/High contrast/)).toBeVisible();
  await expect(page.getByLabel(/Colour-blind theme/)).toHaveCount(0);
  await expect(page.getByLabel(/Dark mode/)).toHaveCount(0);
  await expect(page.getByLabel(/Map style/)).toHaveCount(0);
});
