/**
 * Shared helpers for the Pakdam Playwright suite (fresh rebuild, pakdam-fresh).
 *
 * Text-only assertions throughout: every check below is DOM text, roles or
 * element state — no screenshots, no visual assertions.
 *
 * Modes: the app is demo or live depending on NEXT_PUBLIC_WORKER_URL at the
 * time the dev server started. Demo specs skip when that variable is set;
 * live specs skip when it is not (see LIVE below). Demo rooms live in
 * localStorage (`pakdam.demo.rooms.v1`), so multi-player demo tests use
 * several pages in ONE browser context (localStorage is shared across pages
 * in a context; each page keeps its own seat in sessionStorage).
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const DEMO_ROOMS_KEY = 'pakdam.demo.rooms.v1';
export const SESSION_STORAGE_KEY = 'pakdam.session.v1';

/** True when the suite is running against a live Worker (env at test time). */
export const LIVE = Boolean(process.env.NEXT_PUBLIC_WORKER_URL);
/** True when an Ola Maps key is configured (env at test time). */
export const OLA_KEY_SET = Boolean(process.env.NEXT_PUBLIC_OLA_MAPS_API_KEY);

export const HOST_NAME = 'Teo';
export const GUEST_NAMES = ['Ana', 'Ben'] as const;

/**
 * v32 (catch cluster): emulated GPS at the Ranchi zone centre
 * (23.36, 85.33) — the same CENTRE the outside-zone and
 * host-cancel-room-deleted specs use. The demo zone is a 500 m circle
 * on exactly this point (create/mode page), so a fix here is inside
 * the zone: no outside-zone countdown.
 *
 * What this does NOT do (v32 fix round, Diya A1 — the old comment
 * claimed otherwise): a centred context delivers exactly ONE emulated
 * fix to the visible tab's watch. A static position never fires again,
 * so nothing re-stamps `lastFixAt` and the front seat WOULD be ejected
 * by the demo (4a) 30 s missing-fix clock at ~ACTIVE+30 s. The (4a)
 * clock is held off only by `startCentreFixKeepFresh` below (a 4 s
 * nudge loop, same pattern as outside-zone.spec.ts), for the front
 * seat — backgrounded seats are suspended and therefore exempt
 * (`shouldEjectForMissingFix` returns false for a suspended seat),
 * and harboured seats sit on the catch page, where no (4a) check
 * exists at all (the check lives on the play page only).
 */
export const CENTRE_GPS = { latitude: 23.36, longitude: 85.33, accuracy: 10 };

/** CENTRE nudged ~1 m — a NEW position, so Chromium delivers a fresh fix to every running watch. */
export const CENTRE_NUDGED = { latitude: 23.36001, longitude: 85.33001, accuracy: 10 };

/**
 * v32 fix round (Diya A1): keep the visible tab's fix fresh for the
 * whole test by re-emulating the centre position every 4 s,
 * alternating CENTRE / CENTRE_NUDGED (same pattern as
 * outside-zone.spec.ts's keep-fresh loop and host-cancel's
 * CENTRE_NUDGED). Each nudge is a new position, so Chromium delivers
 * a fresh fix to the front tab's watch, re-stamping `lastFixAt`.
 *
 * Why this closes the (4a) hole — the proof, from the code:
 * the (4a) check lives only on the play page (play/page.tsx demo
 * tick → `shouldEjectForMissingFix`, play-map-logic.ts) and fires
 * only when the seat is connected, the phase is ACTIVE, and
 * effectiveNow − baseline ≥ 30 s. Every seat in a catch spec is in
 * exactly one of three states: (a) harboured on the catch page — no
 * play-page (4a) check mounts for it; (b) backgrounded on the play
 * page — suspended, so the check returns false; (c) the one front
 * tab on the play page — connected with a live watch, and this loop
 * re-stamps its `lastFixAt` at most ~4–6 s apart, so the 30 s gap
 * can never accumulate. The loop starts right after `startDemoMatch`
 * (ACTIVE began seconds earlier) and runs until `stop()` is called —
 * call it just before `context.close()`.
 */
export function startCentreFixKeepFresh(context: BrowserContext): () => void {
  let stopped = false;
  void (async () => {
    try {
      let i = 0;
      while (!stopped) {
        await new Promise<void>((resolve) => setTimeout(resolve, 4000));
        if (stopped) break;
        await context.setGeolocation(i % 2 === 0 ? CENTRE_NUDGED : CENTRE_GPS);
        i++;
      }
    } catch {
      // Test ended (pass or fail) — the context is closed.
    }
  })();
  return () => {
    stopped = true;
  };
}

/** A demo context with emulated GPS at the zone centre (see CENTRE_GPS). */
export async function newCentredDemoContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ geolocation: CENTRE_GPS, permissions: ['geolocation'] });
}

/**
 * v32 (catch cluster): resume a demo seat by mounting the catch page
 * (P0-1, `resumePlayerOnCatchPageArrival`).
 *
 * Why the catch page, not bringToFront: in the headless multi-page
 * setup only one tab is visible — creating the guest pages
 * backgrounds the earlier tabs, and `useRoomState` suspends each
 * backgrounded seat ('tab-hidden'); the one visible tab suspends
 * itself on GPS denial (no permission granted). A catch claim
 * (`demo-store requestCatch`) rejects a suspended Hunter AND a
 * suspended Runner, so a claim/confirm across two seats can never
 * land while both seats are suspended — that is the v31 CI failure
 * of every catch test (catch-nav 178/220/270/281, catch-results
 * 65/88/136, brutal-phone 20). The catch page is the suspension-safe
 * harbour: mounting it resumes the seat (P0-1) and it runs NO GPS
 * watcher, so there is no gps-denied error and no (4a) clock — the
 * (4a) check lives on the play page only. BUT the harbour is
 * conditional, not absolute: the catch page still mounts
 * `useRoomState` (catch/page.tsx), whose visibility handler suspends
 * the seat on tab-hide (useRoomState.ts) — so if another tab is
 * brought to the front AFTER a seat is harboured, that harboured
 * seat IS re-suspended. The harbour holds in these specs only
 * because no spec fronts another tab after harbouring; callers
 * re-harbour before every claim/confirm, so a re-suspension can
 * never survive into a claim. `page.goto` does not change tab
 * frontness, so mounting the catch page on one seat never suspends
 * the other. Skips the
 * navigation when the seat is already on the catch page (a reload
 * would wipe that tab's in-memory raw catch tokens). Waits for the
 * resume to land in the store before returning, so the caller can
 * claim/confirm at once.
 */
export async function resumeSeatViaCatchPage(
  page: Page,
  roomId: string,
  displayName: string,
): Promise<void> {
  if (!page.url().includes(`/room/${roomId}/catch`)) {
    await page.goto(`/room/${roomId}/catch`);
  }
  await expect
    .poll(
      async () =>
        (await getDemoRoom(page, roomId))?.players.find(
          (p) => p.displayName === displayName,
        )?.connectionState,
      { timeout: 10000 },
    )
    .toBe('connected');
}

/** Minimal shape of a demo room as stored in localStorage. */
export interface DemoPlayer {
  playerId: string;
  displayName: string;
  matchRole: string | null;
  team: string | null;
  isReady: boolean;
  isHost: boolean;
  connectionState: 'connected' | 'suspended' | 'disconnected';
  leftAt: string | null;
  ejectedAt: string | null;
}

export interface DemoRoomData {
  room: {
    roomId: string;
    roomCode: string;
    hostPlayerId: string;
    phase: string;
    endsAt: string | null;
    startedAt: string | null;
    config: { mode: string; zone: { boundary: Array<{ lat: number; lng: number }> } };
  };
  players: DemoPlayer[];
  catches: unknown[];
}

/** Collect page errors + console errors; assert on them at the end of a test. */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  return errors;
}

export function expectNoPageErrors(errors: string[]): void {
  expect(errors, 'expected no page/console errors').toEqual([]);
}

/** Fail fast with a plain message if the app is not in demo mode. */
export async function expectDemoMode(page: Page): Promise<void> {
  const isDemo = await page.evaluate((key) => {
    return window.localStorage.getItem(key) !== null;
  }, DEMO_ROOMS_KEY);
  expect(
    isDemo,
    'expected demo mode (a demo room in localStorage) — is NEXT_PUBLIC_WORKER_URL set on the dev server?',
  ).toBe(true);
}

/**
 * Host flow up to the create screen (setup): Home → HOST A GAME →
 * codename → mode card → /room/[id]/setup. The code is NOT visible here
 * — it appears only on the lobby screen, after CREATE LOBBY. Returns
 * the room id (from the URL).
 */
export async function createHostSetupRoom(
  page: Page,
  hostName: string = HOST_NAME,
  mode: 'Classic' | 'Infection' = 'Classic',
): Promise<{ roomId: string }> {
  await page.goto('/');
  await page.getByRole('button', { name: /HOST A GAME/ }).click();
  await expect(page.getByRole('heading', { name: 'Pick a mode' })).toBeVisible();
  await page.getByLabel('Your codename').fill(hostName);
  // The host must confirm they are at the play location — the mode card
  // does nothing until the on-site checkbox is ticked.
  await page.getByRole('checkbox', { name: /I'm at the play location/ }).click();
  await page.getByRole('button', { name: mode }).click();
  await page.waitForURL(/\/room\/[^/]+\/setup/);
  await expect(page.getByRole('heading', { name: 'Create lobby' })).toBeVisible();
  const roomId = page.url().split('/room/')[1]?.split('/setup')[0] ?? '';
  expect(roomId).not.toBe('');
  return { roomId };
}

/**
 * Host flow: Home → HOST A GAME → codename → mode card → create screen
 * → CREATE LOBBY → lobby. Returns the room id and the 6-letter code
 * (read from the lobby's code card).
 */
export async function createHostRoom(
  page: Page,
  hostName: string = HOST_NAME,
  mode: 'Classic' | 'Infection' = 'Classic',
): Promise<{ roomId: string; code: string }> {
  const { roomId } = await createHostSetupRoom(page, hostName, mode);
  await page.getByRole('button', { name: 'CREATE LOBBY', exact: true }).click();
  await page.waitForURL(/\/room\/[^/]+$/);
  await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
  const code = (await page.locator('section[aria-label="Game code"] .pakdam-code').innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  return { roomId, code };
}

/**
 * Guest flow: /join → code + codename + JOIN → lobby. New page, same
 * context. The code lives ONLY on the /join screen — Home has no code
 * input (it only routes to /join), so filling a code on Home was stale.
 */
export async function joinRoomAsGuest(
  context: BrowserContext,
  code: string,
  name: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/join');
  await expect(page.getByRole('heading', { name: 'Join a game' })).toBeVisible();
  await page.getByLabel('Room code').fill(code);
  await page.getByLabel('Your codename').fill(name);
  await page.getByRole('button', { name: 'JOIN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
  return page;
}

export interface LobbySetup {
  hostPage: Page;
  guestPages: Page[];
  code: string;
  roomId: string;
}

/**
 * A 3-player lobby: host + 2 guests. Optionally shortens the round
 * (10 min) and the head start (None) on the host's sliders so the match
 * reaches ACTIVE quickly after start.
 */
export async function setupThreePlayerLobby(
  context: BrowserContext,
  opts: { mode?: 'Classic' | 'Infection'; headStartNone?: boolean; roundShort?: boolean } = {},
): Promise<LobbySetup> {
  const hostPage = await context.newPage();
  // Steppers live on the create screen — set them there, then CREATE LOBBY.
  const { roomId } = await createHostSetupRoom(hostPage, HOST_NAME, opts.mode ?? 'Classic');
  if (opts.roundShort !== false) {
    await setStepper(hostPage, 'Round length', 0); // index 0 = 10 min
  }
  if (opts.headStartNone !== false) {
    await setStepper(hostPage, 'Head start', 0); // index 0 = None
  }
  await hostPage.getByRole('button', { name: 'CREATE LOBBY', exact: true }).click();
  await hostPage.waitForURL(/\/room\/[^/]+$/);
  await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
  const code = (await hostPage.locator('section[aria-label="Game code"] .pakdam-code').innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  const guestPages = [
    await joinRoomAsGuest(context, code, GUEST_NAMES[0]),
    await joinRoomAsGuest(context, code, GUEST_NAMES[1]),
  ];
  return { hostPage, guestPages, code, roomId };
}

/** Set a discrete stepper (− / +) by grid index: drive down to the first grid entry (Decrease disables at index 0), then step up `index` times. */
export async function setStepper(page: Page, label: string, index: number): Promise<void> {
  const decrease = page.getByRole('button', { name: `Decrease ${label}`, exact: true });
  const increase = page.getByRole('button', { name: `Increase ${label}`, exact: true });
  for (let i = 0; i < 10; i++) {
    if (await decrease.isDisabled()) break;
    await decrease.click();
  }
  for (let i = 0; i < index; i++) {
    await increase.click();
  }
}

/**
 * Tap "I'm ready" on each page that is not ready yet, and wait for the
 * flipped ready state. The HOST is created ready (live DO create + demo
 * createRoom both set isReady + briefingConfirmed at creation — the host
 * obviously wants to play their own game), so the host's page already
 * shows "I'm ready — tap to change" and is skipped, not clicked.
 */
export async function readyAll(pages: Page[]): Promise<void> {
  for (const page of pages) {
    const readyBtn = page.getByRole('button', { name: "I'm ready", exact: true });
    const readyState = page.getByRole('button', { name: /I'm ready — tap to change/ });
    await expect(readyBtn.or(readyState)).toBeVisible();
    if ((await readyState.count()) > 0) continue; // already ready (host)
    await readyBtn.click();
    await expect(readyState).toBeVisible();
  }
}

/** Host taps START GAME and lands on /play; guests follow via the F2 auto-navigate. */
export async function startMatchAsHost(hostPage: Page): Promise<void> {
  await expect(hostPage.getByRole('button', { name: 'START GAME', exact: true })).toBeVisible();
  await hostPage.getByRole('button', { name: 'START GAME', exact: true }).click();
  await hostPage.waitForURL(/\/room\/[^/]+\/play/);
}

export async function waitForPlay(page: Page): Promise<void> {
  await page.waitForURL(/\/room\/[^/]+\/play/, { timeout: 20000 });
}

/** Dismiss the role-reveal overlay ("Let's go") if it is showing. */
export async function dismissRoleReveal(page: Page): Promise<void> {
  const letsGo = page.getByRole('button', { name: "Let's go", exact: true });
  // The reveal renders once roles load; wait briefly for it, then dismiss.
  await letsGo.waitFor({ state: 'attached', timeout: 8000 }).catch(() => undefined);
  if ((await letsGo.count()) > 0) {
    await letsGo.click({ timeout: 5000 }).catch(() => undefined);
  }
}

/**
 * Full demo setup: 3-player lobby, everyone ready, host starts, everyone
 * lands on /play with the reveal dismissed. Returns the pages plus each
 * player's role as recorded in the demo store (demo has no role secrecy).
 */
export async function startDemoMatch(
  context: BrowserContext,
  opts: { mode?: 'Classic' | 'Infection'; roundShort?: boolean } = {},
): Promise<LobbySetup & { roles: Map<string, string | null> }> {
  const setup = await setupThreePlayerLobby(context, opts);
  const allPages = [setup.hostPage, ...setup.guestPages];
  await readyAll(allPages);
  await startMatchAsHost(setup.hostPage);
  for (const guest of setup.guestPages) await waitForPlay(guest);
  for (const page of allPages) await dismissRoleReveal(page);
  const roles = new Map<string, string | null>();
  for (const page of allPages) {
    const room = await getDemoRoom(page, setup.roomId);
    for (const p of room?.players ?? []) roles.set(p.displayName, p.matchRole);
  }
  return { ...setup, roles };
}

/** Read the demo room (localStorage) from a page in the same context. */
export async function getDemoRoom(page: Page, roomId: string): Promise<DemoRoomData | null> {
  return page.evaluate(
    ({ key, roomId: id }) => {
      const rooms = JSON.parse(window.localStorage.getItem(key) ?? '[]') as DemoRoomData[];
      return rooms.find((r) => r.room.roomId === id) ?? null;
    },
    { key: DEMO_ROOMS_KEY, roomId },
  );
}

export async function roleOf(
  page: Page,
  roomId: string,
  displayName: string,
): Promise<string | null> {
  const room = await getDemoRoom(page, roomId);
  return room?.players.find((p) => p.displayName === displayName)?.matchRole ?? null;
}

export async function playerIdOf(
  page: Page,
  roomId: string,
  displayName: string,
): Promise<string | null> {
  const room = await getDemoRoom(page, roomId);
  return room?.players.find((p) => p.displayName === displayName)?.playerId ?? null;
}

/**
 * White-box demo helper: move the match end into the past so the demo
 * tick completes the match on the next 1 s poll (the play page then
 * redirects to /results). Demo-only; localStorage is the demo store.
 */
export async function forceDemoMatchEnd(page: Page, roomId: string): Promise<void> {
  await page.evaluate(
    ({ key, roomId: id }) => {
      const rooms = JSON.parse(window.localStorage.getItem(key) ?? '[]') as DemoRoomData[];
      const found = rooms.find((r) => r.room.roomId === id);
      if (!found) throw new Error(`demo room ${id} not found in localStorage`);
      found.room.endsAt = new Date(Date.now() - 1000).toISOString();
      window.localStorage.setItem(key, JSON.stringify(rooms));
    },
    { key: DEMO_ROOMS_KEY, roomId },
  );
}

/**
 * White-box demo helper: force one zone shrink on the next 1 s demo
 * tick by moving `startedAt` back past one shrink interval. The 10-min
 * demo round shrinks every 180 s (shrinkIntervalForDurationSeconds), so
 * 181 s back fires exactly one shrink; `endsAt` is untouched, so the
 * match stays live. Only valid for the default 10-min demo round — a
 * longer round has a longer shrink interval. Demo-only; localStorage
 * is the demo store.
 */
export async function forceDemoShrink(page: Page, roomId: string): Promise<void> {
  await page.evaluate(
    ({ key, roomId: id }) => {
      const rooms = JSON.parse(window.localStorage.getItem(key) ?? '[]') as DemoRoomData[];
      const found = rooms.find((r) => r.room.roomId === id);
      if (!found) throw new Error(`demo room ${id} not found in localStorage`);
      if (!found.room.startedAt) throw new Error(`demo room ${id} has not started`);
      found.room.startedAt = new Date(Date.parse(found.room.startedAt) - 181_000).toISOString();
      window.localStorage.setItem(key, JSON.stringify(rooms));
    },
    { key: DEMO_ROOMS_KEY, roomId },
  );
}

/**
 * White-box demo helper: move the host crown to another player — the
 * demo mirror of the server's earliest-joiner succession when the host
 * disconnects (`host.transferred`). Flips `room.hostPlayerId` and the
 * players' `isHost` flags in localStorage; every open room page picks
 * it up on its next 1 s poll, with NO reload. Demo-only; localStorage
 * is the demo store.
 */
export async function transferDemoHost(
  page: Page,
  roomId: string,
  displayName: string,
): Promise<void> {
  await page.evaluate(
    ({ key, roomId: id, displayName: name }) => {
      const rooms = JSON.parse(window.localStorage.getItem(key) ?? '[]') as DemoRoomData[];
      const found = rooms.find((r) => r.room.roomId === id);
      if (!found) throw new Error(`demo room ${id} not found in localStorage`);
      const next = found.players.find((p) => p.displayName === name);
      if (!next) throw new Error(`player ${name} not found in demo room ${id}`);
      for (const p of found.players) p.isHost = p.playerId === next.playerId;
      found.room.hostPlayerId = next.playerId;
      window.localStorage.setItem(key, JSON.stringify(rooms));
    },
    { key: DEMO_ROOMS_KEY, roomId, displayName },
  );
}

/**
 * White-box demo helper: delete the demo room from localStorage — the
 * demo mirror of the server deleting a live room after a host cancel.
 * Open room pages see a null poll on the next 1 s tick; a reload after
 * the delete hits the first-paint missing-room path. Demo-only.
 */
export async function deleteDemoRoomFromStore(page: Page, roomId: string): Promise<void> {
  await page.evaluate(
    ({ key, roomId: id }) => {
      const rooms = JSON.parse(window.localStorage.getItem(key) ?? '[]') as DemoRoomData[];
      window.localStorage.setItem(
        key,
        JSON.stringify(rooms.filter((r) => r.room.roomId !== id)),
      );
    },
    { key: DEMO_ROOMS_KEY, roomId },
  );
}

/** No horizontal overflow at the current viewport. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflowing = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflowing, 'page must not scroll horizontally').toBeLessThanOrEqual(1);
}

/** A named button must be a real thumb target (≥ 48 px tall). */
export async function expectButtonHeight(
  page: Page,
  name: string | RegExp,
  minHeight = 48,
): Promise<void> {
  const box = await page.getByRole('button', { name }).first().boundingBox();
  expect(box, `button ${String(name)} should be visible`).not.toBeNull();
  expect(box!.height, `button ${String(name)} height`).toBeGreaterThanOrEqual(minHeight);
}

/** The PWA must contain no Forge-office references anywhere in its visible text. */
export async function expectNoForgeOfficeText(page: Page): Promise<void> {
  const text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  for (const word of ['forge', 'hermes', 'digital office', 'openclaw', 'mission control']) {
    expect(text, `visible text must not mention "${word}"`).not.toContain(word);
  }
}
