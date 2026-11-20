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
import { expect, type BrowserContext, type Page } from '@playwright/test';

export const DEMO_ROOMS_KEY = 'pakdam.demo.rooms.v1';
export const SESSION_STORAGE_KEY = 'pakdam.session.v1';

/** True when the suite is running against a live Worker (env at test time). */
export const LIVE = Boolean(process.env.NEXT_PUBLIC_WORKER_URL);
/** True when an Ola Maps key is configured (env at test time). */
export const OLA_KEY_SET = Boolean(process.env.NEXT_PUBLIC_OLA_MAPS_API_KEY);

export const HOST_NAME = 'Teo';
export const GUEST_NAMES = ['Ana', 'Ben'] as const;

/** Minimal shape of a demo room as stored in localStorage. */
export interface DemoPlayer {
  playerId: string;
  displayName: string;
  matchRole: string | null;
  team: string | null;
  isReady: boolean;
  leftAt: string | null;
  ejectedAt: string | null;
}

export interface DemoRoomData {
  room: {
    roomId: string;
    roomCode: string;
    phase: string;
    endsAt: string | null;
    startedAt: string | null;
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

/** Guest flow: Home → code + JOIN → codename + JOIN → lobby. New page, same context. */
export async function joinRoomAsGuest(
  context: BrowserContext,
  code: string,
  name: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Room code').fill(code);
  await page.getByRole('button', { name: 'JOIN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Join a game' })).toBeVisible();
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
