// BRUTAL phone test — 390px touch, TEXT/DOM assertions only, no
// screenshots. Drives the REAL flows in a browser on phone width:
// create → join → lobby → start → play → ping → catch (QR scan
// attempt + manual-confirm fallback) → outside-zone countdown →
// SOS → results. Plus: the map renders (canvas + real Ola tiles
// when a key is configured; the "Map key not set" banner when it is
// not — the game still plays either way), the GPS-denied fallback
// is honest, no console errors, no overflow / clipping / dead tap
// targets / overlapping text on any screen, and the hamburger menu
// (built — TopBar renders it on phones, desktop keeps the tab row).
// Runs ONLY on the brutal-phone project (390x844, touch).
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  addRealPlayers,
  assertOlaTilesPaint,
  collectOlaRequests,
  detectOlaKey,
  expectNoOverflow,
  MISSING_KEY_TEXT,
  roomState,
  setPlayer,
} from './helpers';

/** True when the rendered app has an Ola Maps key (probed once per
 *  file — see detectOlaKey in ./helpers). The map assertions below
 *  branch on it: canvas + Ola tiles with a key, missing-key banner
 *  without one. The rest of the flow runs in both modes. */
let OLA_KEY_PRESENT = false;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const probe = await ctx.newPage();
  OLA_KEY_PRESENT = await detectOlaKey(probe);
  await ctx.close();
});

const KEY_ROUTES = [
  '/', '/create', '/join', '/host',
  '/leaderboards',
];

interface ErrorBucket { consoleErrors: string[]; pageErrors: string[] }

function attachErrorCollectors(page: Page, bucket: ErrorBucket): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error') bucket.consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => bucket.pageErrors.push(String(err).slice(0, 300)));
}

function attachToContext(context: BrowserContext, bucket: ErrorBucket): void {
  context.on('page', (p) => attachErrorCollectors(p, bucket));
}

/** Leaf text elements that visibly overlap each other (excluding
 *  sticky/fixed subtrees and the map, where overlap is by design).
 *  Returns "A" overlaps "B" lines. */
async function textOverlapOffenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const offenders: string[] = [];
    const leaves: { text: string; r: DOMRect }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n: Element | null;
    while ((n = walker.nextNode() as Element | null)) {
      if (n.children.length !== 0) continue;
      const t = n.textContent?.trim();
      if (!t) continue;
      const style = getComputedStyle(n);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      let p: Element | null = n;
      let skip = false;
      while (p) {
        const ps = getComputedStyle(p);
        if (ps.position === 'fixed' || ps.position === 'sticky') { skip = true; break; }
        if (p.classList?.contains('mapbox') || p.classList?.contains('maplibregl-canvas') || p.classList?.contains('maplibregl-marker')) { skip = true; break; }
        p = p.parentElement;
      }
      if (skip) continue;
      leaves.push({ text: t.slice(0, 30), r });
    }
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i]!;
        const b = leaves[j]!;
        const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ox > 4 && oy > 4) offenders.push(`"${a.text}" overlaps "${b.text}" by ${Math.round(ox)}x${Math.round(oy)}`);
      }
    }
    return offenders.slice(0, 10);
  });
}

async function assertNoOverlap(page: Page, where: string): Promise<void> {
  const offenders = await textOverlapOffenders(page);
  console.log(`OVERLAP ${where}: ${offenders.length ? offenders.join(' | ') : 'none'}`);
  expect(offenders, `${where}: overlapping text: ${offenders.join(' | ')}`).toEqual([]);
}

/** Visible buttons smaller than 44px tall on the current screen. */
async function smallTapTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('button')) {
      const r = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (r.height < 44) {
        out.push(`"${((el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 36))}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  });
}

async function assertTapTargets(page: Page, where: string): Promise<void> {
  const small = await smallTapTargets(page);
  console.log(`TAP-TARGETS ${where} (<44px tall): ${small.length ? small.join(' | ') : 'none'}`);
  const tiny = small.filter((s) => /x(1\d|2[0-3])$/.test(s));
  expect(tiny, `${where}: unusable tap targets (<24px tall): ${tiny.join(' | ')}`).toEqual([]);
}

test('brutal: every key route fits at 390px — no overflow, no overlap, no tiny targets', async ({ page }) => {
  for (const route of KEY_ROUTES) {
    await page.goto(route);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expectNoOverflow(page, `${route} @390px`);
    await assertNoOverlap(page, `${route} @390px`);
    await assertTapTargets(page, `${route} @390px`);
  }
});

test('brutal: hamburger menu on phones; desktop keeps normal tabs', async ({ page, browser }) => {
  test.setTimeout(120_000);
  // The current-section highlight only exists on a page the menu
  // links to — /join is in the menu ("Join a Game"), / is not (the
  // menu has no Home link), so open it from /join.
  await page.goto('/join');
  await expect(page.getByRole('heading', { name: /Join a game/ })).toBeVisible();
  const menuBtn = page.getByRole('button', { name: /menu/i });
  // The hamburger is built (TopBar): the button opens #mobile-menu.
  await expect(menuBtn, 'no hamburger menu button on phones — TopBar still renders the full desktop nav row at 390px').toBeVisible();
  await menuBtn.tap();
  // #mobile-menu, not a generic nav role: the desktop tab row is
  // display:none on phones but still matches a role query.
  const menu = page.locator('#mobile-menu');
  await expect(menu).toBeVisible();
  for (const name of ['Host a Game', 'Join a Game']) {
    await expect(menu.getByRole('link', { name }).first()).toBeVisible();
  }
  // Current section highlighted: exactly one aria-current in the menu.
  const current = menu.locator('a[aria-current="page"]');
  await expect(current, 'current section is not highlighted in the menu').toHaveCount(1);
  await expect(current.first()).toContainText(/Join a Game/);
  // Tap to close — through the panel's own Close button, not the
  // hamburger. Once the menu is open its fixed panel (right 320px,
  // z-index 61) covers the hamburger in the sticky header (z-40),
  // so tapping the hamburger retries until the test times out (CI
  // dbfaffd: 120s). The panel Close button is the reachable close
  // control; it calls the same closeMenu(true), so focus still
  // returns to the hamburger below.
  await menu.getByRole('button', { name: 'Close' }).tap();
  await expect(menu).toHaveCount(0);
  await expect(menuBtn).toBeFocused();

  // Desktop keeps the normal tab row — no hamburger at 1280px. The
  // tab row is just the Host a Game CTA now (strip-down 2026-11-19):
  // the info-page links are gone and must not come back.
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const desktopPage = await desktop.newPage();
  await desktopPage.goto('/');
  await expect(desktopPage.getByRole('button', { name: /menu/i })).toHaveCount(0);
  await expect(desktopPage.getByRole('link', { name: 'Host a Game', exact: true }).first()).toBeVisible();
  for (const name of ['How it works', 'Game modes', 'Safety', 'FAQ', 'Help']) {
    await expect(desktopPage.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  await desktop.close();
});

test('brutal: GPS denied shows an honest fallback on host setup', async ({ page }) => {
  test.setTimeout(60_000);
  // No geolocation grant in this context: the browser denies it.
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('No GPS Host');
  await page.getByRole('button', { name: /Use my location/ }).click();
  // Denied state, current behaviour (founder cleanup, 2026-11-18):
  // the denied-help line ("Location is off — allow it in your
  // browser settings, then tap the map to place the zone.") was
  // REMOVED from the setup screen — no banner, no announce for it.
  // The host just taps the map to place the zone. The old "Location
  // unavailable" line never existed on this screen (the only
  // "Location unavailable" in the app is the play page's fallback).
  // Wait for the attempt to settle — the button is disabled while
  // locating and enabled again once it ends — then assert the
  // denied text is nowhere and no alert banner exists in the Play
  // area region. (No grant in this context, so the permission check
  // fails fast — no long chain wait.)
  await expect(page.getByRole('button', { name: /Use my location/ })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Play area' }).getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(/Location is off — allow it in your browser settings/i)).toHaveCount(0);
  // Nothing is centred on a guess: create stays blocked, map still works.
  // The "No centre yet." helper was removed with the denied line —
  // the un-centred evidence is the map region's accessible name.
  await expect(page.getByRole('region', { name: /tap the map to place the zone/i })).toBeVisible();
  // CREATE LOBBY is never silently disabled (founder bug fix (a)):
  // it stays tappable and explains what is missing instead. It has
  // NO native `disabled` attribute — only aria-disabled="true"
  // (create/page.tsx:131) — so a real mouse user can click it.
  // Playwright disagrees: in the installed playwright-core 1.65.1
  // the "enabled" element state is !getAriaDisabled(element), and
  // getAriaDisabled counts aria-disabled="true" on a button
  // (kAriaDisabledRoles includes "button"), so toBeEnabled() can
  // never pass here and a plain click waits for "enabled" until it
  // times out. Assert the DOM fact instead, and force the click —
  // the same treatment as session-restore.spec.ts:26-33.
  const createBtn = page.getByRole('button', { name: /CREATE LOBBY/ });
  expect(await createBtn.getAttribute('disabled')).toBeNull();
  await expect(createBtn).toHaveAttribute('aria-disabled', 'true');
  await createBtn.click({ force: true });
  await expect(page.getByText(/Set the zone centre first/)).toBeVisible();
  // The map still renders even without GPS — canvas with a key,
  // missing-key line without one (the map is never constructed
  // without a key, so there is no canvas to expect then).
  if (OLA_KEY_PRESENT) {
    const canvas = page.locator('.mapbox .maplibregl-canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box, 'map canvas must render even without GPS').not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  } else {
    await expect(page.getByText(MISSING_KEY_TEXT).first()).toBeVisible();
    await expect(page.locator('.mapbox .maplibregl-canvas')).toHaveCount(0);
  }
});

test('brutal: full end-to-end on 390px touch — create to results', async ({ page, context }) => {
  test.setTimeout(300_000);
  const bucket: ErrorBucket = { consoleErrors: [], pageErrors: [] };
  attachToContext(context, bucket);
  attachErrorCollectors(page, bucket);
  // Ola requests on the host-setup page (style + tiles + sprites +
  // glyphs). With a key they must all carry api_key and return 200;
  // without a key there must be none at all.
  const ola = collectOlaRequests(page);

  // --- Landing ---
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Pakdam/ })).toBeVisible();
  await expectNoOverflow(page, 'landing @390px');
  await assertNoOverlap(page, 'landing @390px');
  await assertTapTargets(page, 'landing @390px');

  // --- Create: map REALLY renders (canvas + real Ola tiles, not a
  // container) — or, without a key, the missing-key line instead. ---
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await page.goto('/create');
  // Step the head start down to 30 s (as helpers.createLobby does):
  // the default is 3 min, and the play assertions below wait
  // at most 60 s for ACTIVE.
  await page.getByRole('button', { name: /Decrease Head start/ }).click();
  await page.getByRole('button', { name: /Decrease Head start/ }).click();
  await expect(page.getByRole('group', { name: 'Head start' }).locator('output')).toHaveText('30s');
  await page.getByLabel(/codename/i).fill('Brutal Host');
  await page.getByRole('button', { name: /Use my location/ }).click();
  // The old "Zone centre: set" status line was removed in the
  // simplification round (§5c) — the centre-set evidence now is
  // the "Location found — … (GPS accuracy ±N m)" status line.
  await expect(page.getByText(/Location found — .*\(GPS accuracy ±\d+ m\)/i).first()).toBeVisible();
  if (OLA_KEY_PRESENT) {
    const setupCanvas = page.locator('.mapbox .maplibregl-canvas').first();
    await expect(setupCanvas).toBeVisible({ timeout: 30_000 });
    const setupBox = await setupCanvas.boundingBox();
    expect(setupBox, 'host-setup map canvas must render').not.toBeNull();
    expect(setupBox!.width).toBeGreaterThan(100);
    expect(setupBox!.height).toBeGreaterThan(100);
    await assertOlaTilesPaint(page, ola, 'brutal host setup');
  } else {
    await expect(page.getByText(MISSING_KEY_TEXT).first()).toBeVisible();
    await expect(page.locator('.mapbox .maplibregl-canvas')).toHaveCount(0);
    expect(ola.hits, 'no-key: the app must make zero api.olamaps.io requests').toEqual([]);
  }
  // Default strip (roomSummaryStrip, draft.ts:210): 500 m radius,
  // Balance ON with no roster known -> 1 hunter, 3 min ping -> "3m",
  // 30 min -> "30m".
  await expect(page.getByText(/500m zone . 1 hunter . 3m pulse . 30m/i).first()).toBeVisible();
  // Steppers + toggles on phone width.
  await page.getByRole('button', { name: /Increase Radius/ }).click();
  await expect(page.getByRole('group', { name: 'Radius' }).locator('output')).toHaveText('550m');
  await page.getByRole('switch', { name: 'Show ping history' }).click();
  await expect(page.getByRole('switch', { name: 'Show ping history' })).toHaveAttribute('aria-checked', 'true');
  await expectNoOverflow(page, 'create @390px');
  await assertNoOverlap(page, 'create @390px');
  await assertTapTargets(page, 'create @390px');
  await page.getByLabel(/I have checked the venue/i).check();
  await page.getByLabel(/I will be on site/i).check();
  await page.getByRole('button', { name: /CREATE LOBBY/ }).click();
  await expect(page).toHaveURL(/\/room\/[0-9a-f-]+$/);
  const created = await roomState(page);
  expect(created).not.toBeNull();
  const roomId = created!.room.roomId;
  const roomCode = created!.room.roomCode;
  const hostId = created!.players[0]!.playerId;
  expect(roomCode).toMatch(/^[A-Z0-9]{6}$/);
  expect(created!.room.config.showPingHistory).toBe(true);

  // --- Join + lobby ---
  const guest = await context.newPage();
  await guest.goto('/join');
  await guest.getByLabel(/Room code/i).fill(roomCode);
  await guest.getByLabel(/Your display name/i).fill('Brutal Guest');
  await guest.getByLabel(/18 or older/i).check();
  await guest.getByRole('button', { name: /Join lobby/i }).click();
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await guest.getByRole('button', { name: /I.m ready/i }).click();
  await setPlayer(page, hostId);
  // Three more real guests first: the game needs 3+ players and every
  // player ready before "Ready to start" appears (no demo seats).
  await addRealPlayers(context, roomCode, ['Guest Two', 'Guest Three', 'Guest Four']);
  await expect(page.getByText(/Players \(5\/30\)/)).toBeVisible();
  await expect(page.getByText(/✓ Ready to start/)).toBeVisible();
  await expect(page.getByText(/5 of 5 ready\./)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Players' }).getByText('✓ Ready', { exact: true })).toHaveCount(5);
  // Minimal lobby (2026-11-19) on phone width: the readiness
  // checklist, role preview, safety strip, lobby radio, host
  // check-in and event log are all gone from the lobby. (Safety and
  // radio still live on the play screen — SOS below, channels in
  // live-hud.spec.ts.)
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
  await expect(page.getByRole('heading', { name: 'Your role is decided when the game starts' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Safety — always here' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /SOS/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Safety pause/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Tell everyone/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Lobby radio' })).toHaveCount(0);
  await expect(page.getByText(/Everyone in this lobby can read these messages/)).toHaveCount(0);
  await expect(page.getByText(/Let.s go!/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Host check-in: lobby' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Host check-ins' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What has happened' })).toHaveCount(0);
  await expectNoOverflow(page, 'lobby @390px');
  await assertNoOverlap(page, 'lobby @390px');
  await assertTapTargets(page, 'lobby @390px');

  // Host-picked Hunters so the host is the Hunter (deterministic).
  await page.getByRole('button', { name: /Switch to host-picked Hunters/i }).click();
  const before = await roomState(page);
  const others = before!.players.filter((p) => p.playerId !== hostId);
  for (const id of [hostId, others[0]!.playerId]) {
    const name = before!.players.find((p) => p.playerId === id)!.displayName;
    // Scope to the checkbox (see outside-zone.spec.ts): the roster
    // name button and the Remove button carry the same name.
    await page.getByRole('checkbox', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).check();
  }
  await page.getByRole('button', { name: /Save Hunters/i }).click();
  await expect(page.getByText(/Saved Hunters:/)).toBeVisible();

  // --- Start: host is the Hunter (host-picked above, deterministic) ---
  await expect(page.getByRole('button', { name: /Start game/i })).toBeEnabled();
  await page.getByRole('button', { name: /Start game/i }).click();
  await expect(page).toHaveURL(`/room/${roomId}/play`);
  await guest.close();

  // --- Play: head start flips to ACTIVE after the configured head
  // start (30 s — stepped down from the 3 min default above). ---
  await expect(page.getByRole('heading', { name: 'Head start — what to do now' })).toBeVisible();
  const simLocation = page.getByRole('button', { name: /Use simulated location/i });
  if (await simLocation.isVisible()) await simLocation.click();
  const hud = page.getByRole('region', { name: 'Match status' });
  await expect(hud).toContainText('Active — hunt on', { timeout: 60_000 });
  await page.getByRole('button', { name: /Tap to find out your role/i }).click();
  const state = await roomState(page);
  expect(state).not.toBeNull();
  const hunter = state!.players.find((p) => p.matchRole === 'hunter');
  const runners = state!.players.filter((p) => p.matchRole === 'runner');
  expect(hunter!.playerId).toBe(hostId);
  await expect(page.getByText(/You are:/)).toContainText(/Hunter/i);
  expect(runners.length).toBeGreaterThanOrEqual(3);
  await expect(hud).toContainText(`${runners.length} of ${runners.length} Runners`);
  await expectNoOverflow(page, 'play @390px');
  await assertNoOverlap(page, 'play @390px');
  await assertTapTargets(page, 'play @390px');

  // --- Ping (Hunter tool): two simulated pings; with Show ping
  // history ON (toggled above) the areas stay rendered with ages.
  // The ping-area caption renders inside the map view, so it only
  // exists with a key — without one the play map shows the
  // missing-key banner instead and the pings still land (the Radar
  // tab proves it below is map-independent). ---
  await page.getByRole('tab', { name: 'Radar' }).click();
  await page.getByRole('button', { name: /Simulate a scheduled ping/i }).click();
  await page.getByRole('button', { name: /Simulate a scheduled ping/i }).click();
  await page.getByRole('tab', { name: 'Map' }).click();
  if (OLA_KEY_PRESENT) {
    await expect(page.getByText(/Shaded blue areas: Nearest ping area \(/)).toBeVisible();
  } else {
    await expect(page.getByText(/Map key not set — add NEXT_PUBLIC_OLA_MAPS_API_KEY in Vercel \(Production \+ Preview\) and redeploy\. The game still works without the map picture\./)).toBeVisible();
    await expect(page.getByText(/Shaded blue areas:/)).toHaveCount(0);
  }

  // --- SOS asks for confirmation, then tells the host. ---
  page.once('dialog', (d) => d.accept());
  await hud.getByRole('button', { name: /shares your position with the host/ }).click();
  await expect(page.getByText(/SOS sent to your host\./)).toBeVisible();

  // --- Outside zone: the 30-second countdown appears when the fix
  // moves outside, and clears when the player comes back inside.
  // (The full ejection at 0 is covered by outside-zone.spec.ts; this
  // test proves the countdown itself without ejecting the host.) ---
  await context.setGeolocation({ latitude: 23.5, longitude: 85.5, accuracy: 5 });
  await expect(page.locator('div[aria-label$="seconds left to get back inside"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/If the countdown reaches 0 you are ejected/i)).toBeVisible();
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33, accuracy: 5 });
  await expect(page.locator('div[aria-label$="seconds left to get back inside"]')).toHaveCount(0, { timeout: 30_000 });

  // --- Catch: in-person tag → Hunter requests → Runner taps "Got
  // tagged" (QR opens) → manual-confirm fallback (no camera in
  // headless Chromium). No one-time code anywhere. Repeat until every
  // Runner is caught; the last confirm completes the match. ---
  const catchPage = await context.newPage();
  await catchPage.goto('/');
  for (const runner of runners) {
    await setPlayer(catchPage, hunter!.playerId);
    await catchPage.goto(`/room/${roomId}/catch?runner=${runner.playerId}`);
    await expect(catchPage.getByRole('heading', { name: `Catch — ${runner.displayName}` })).toBeVisible();
    await catchPage.getByRole('button', { name: /Request a catch/i }).click();
    await expect(catchPage.getByText(/Claim state:/)).toContainText('Awaiting confirmation');

    await setPlayer(catchPage, runner.playerId);
    await catchPage.goto(`/room/${roomId}/catch?runner=${runner.playerId}`);
    await expect(catchPage.getByRole('heading', { name: /You are the Runner/ })).toBeVisible();
    await catchPage.getByRole('button', { name: /Got tagged — show my QR/i }).click();
    await expect(catchPage.getByRole('heading', { name: /Show this to the Hunter/i })).toBeVisible();
    await catchPage.getByRole('button', { name: /Confirm manually — camera unavailable/i }).click();
    await catchPage.getByRole('button', { name: /Yes, I was tagged/i }).click();
    await expect(catchPage.getByRole('heading', { name: /Catch confirmed/i })).toBeVisible();
    await expect(catchPage.getByText(/Confirmed — catch counts/).first()).toBeVisible();
  }
  await catchPage.close();

  const finished = await roomState(page);
  expect(finished!.room.phase).toBe('COMPLETED');

  // --- Results ---
  await page.goto(`/room/${roomId}/results`);
  await expect(page.getByRole('heading', { name: /Hunters win/ })).toBeVisible();
  await expect(page.getByText(new RegExp(`Caught Runners: ${runners.length}`)).first()).toBeVisible();
  await expect(page.getByText(new RegExp(`Confirmed catches: ${runners.length}`)).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Play again — start a fresh game/ })).toBeVisible();
  await expectNoOverflow(page, 'results @390px');
  await assertNoOverlap(page, 'results @390px');
  await assertTapTargets(page, 'results @390px');

  // No console errors and no page errors across the whole game.
  expect(bucket.consoleErrors, `console errors: ${bucket.consoleErrors.join(' | ')}`).toEqual([]);
  expect(bucket.pageErrors, `page errors: ${bucket.pageErrors.join(' | ')}`).toEqual([]);
});
