// Shared helpers for the Pakdam e2e suite — TEXT/DOM assertions only,
// no screenshots (gateway rule). Demo mode: rooms persist to
// localStorage, so host + guest use two pages in ONE browser context
// (shared localStorage for the origin). Imported by the *.spec.ts files;
// this file itself holds no tests.
import { expect, type BrowserContext, type Page } from '@playwright/test';

export const ROOM_KEY = 'pakdam.demo.rooms.v1';
export const PLAYER_KEY = 'pakdam.playerId';

export interface RoomState {
  room: {
    roomId: string;
    roomCode: string;
    phase: string;
    config: {
      mode: string;
      pingIntervalSeconds: number;
      playZoneEnabled?: boolean;
      maxPlayers: number;
      hunterCount: number;
      durationSeconds: number;
      headStartSeconds: number;
      showPingHistory?: boolean;
    };
  };
  players: {
    playerId: string;
    displayName: string;
    matchRole: string | null;
    isReady: boolean;
    isHost: boolean;
    ejectedAt: string | null;
  }[];
  catches: { state: string; runnerPlayerId: string; hunterPlayerId: string }[];
  events: { at: string; text: string }[];
}

export async function roomState(page: Page): Promise<RoomState | null> {
  return page.evaluate((key) => {
    const all = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, RoomState>;
    return Object.values(all)[0] ?? null;
  }, ROOM_KEY);
}

export async function setPlayer(page: Page, playerId: string): Promise<void> {
  // Per-tab identity (sessionStorage, not localStorage): the host tab
  // and the guest tab each hold their own player id, so joining as a
  // second player cannot steal the first tab's identity.
  await page.evaluate((value) => sessionStorage.setItem('pakdam.playerId', value), playerId);
}

/** Create a lobby through the real host-setup UI. Defaults: Standard
 *  preset, codename "Test Host", GPS centre 23.36, 85.33 (mocked).
 *  Returns the room ids + the host page (already on the lobby). */
export async function createLobby(
  page: Page,
  context: BrowserContext,
  opts: {
    codename?: string;
    preset?: 'Quick' | 'Standard' | 'Big Park';
    /** Extra host-setup changes (toggles/steppers) before creating. */
    configureDraft?: (page: Page) => Promise<void>;
  } = {},
): Promise<{ roomId: string; roomCode: string; hostId: string }> {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 23.36, longitude: 85.33 });
  await page.goto('/create');
  if (opts.preset) {
    // The preset radio is a controlled input whose onChange re-renders
    // the whole draft; a click can race that re-render ("clicking the
    // checkbox did not change its state"). Skip the click when the
    // preset is already applied, else retry once via the label.
    const radio = page.getByLabel(new RegExp(opts.preset));
    if (!(await radio.isChecked())) {
      await radio.check().catch(async () => {
        await page.waitForTimeout(500);
        await page.locator('label', { hasText: new RegExp(opts.preset) }).first().click();
        await expect(radio).toBeChecked({ timeout: 5_000 });
      });
    }
  }
  // Head start is the CONFIGURED value (3 min in every preset) — the
  // play page honours it exactly, so the suite uses a short 30 s head
  // start here (180 -> 90 -> 30) instead of waiting out 3 minutes per
  // match. The head-start tutorial still shows for the full 30 s.
  await page.getByRole('button', { name: /Decrease Head start/ }).click();
  await page.getByRole('button', { name: /Decrease Head start/ }).click();
  await expect(page.getByRole('group', { name: 'Head start' }).locator('output')).toHaveText('30s');
  await page.getByLabel(/codename/i).fill(opts.codename ?? 'Test Host');
  if (opts.configureDraft) await opts.configureDraft(page);
  await page.getByRole('button', { name: /Use my location/ }).click();
  await expect(page.getByText(/Zone centre: set/)).toBeVisible();
  await page.getByLabel(/I have checked the venue/i).check();
  await page.getByLabel(/I will be on site/i).check();
  await page.getByRole('button', { name: /CREATE LOBBY/ }).click();
  await expect(page).toHaveURL(/\/room\/[0-9a-f-]+$/);
  await expect(page.getByText(/Room code/i)).toBeVisible();
  const created = await roomState(page);
  expect(created).not.toBeNull();
  expect(created!.room.roomCode).toMatch(/^[A-Z0-9]{6}$/);
  return { roomId: created!.room.roomId, roomCode: created!.room.roomCode, hostId: created!.players[0]!.playerId };
}

/** Guest join through /join: 6-char code boxes + display name, 18+,
 *  no account. Returns the guest page (already on the lobby). */
export async function joinAsGuest(
  context: BrowserContext,
  roomCode: string,
  displayName: string,
): Promise<Page> {
  const guest = await context.newPage();
  await guest.goto('/join');
  await guest.getByLabel(/Room code/i).fill(roomCode);
  await guest.getByLabel(/Your display name/i).fill(displayName);
  await guest.getByLabel(/18 or older/i).check();
  await guest.getByRole('button', { name: /Join lobby/i }).click();
  return guest;
}

export interface StartedMatch {
  roomId: string;
  roomCode: string;
  hostId: string;
  hunterId: string;
  runners: RoomState['players'];
}

/** Join extra REAL guests through the real /join flow (each taps
 *  "I'm ready"). This replaces the removed "Add 3 demo players"
 *  button — no demo seats exist any more, so a match that needs more
 *  than the host + first guest must join real players. Returns their
 *  pages; the caller closes them when done (closing a tab does not
 *  remove the player from the room). */
export async function addRealPlayers(
  context: BrowserContext,
  roomCode: string,
  names: string[],
): Promise<Page[]> {
  const pages: Page[] = [];
  for (const name of names) {
    const g = await joinAsGuest(context, roomCode, name);
    await expect(g).toHaveURL(/\/room\/[0-9a-f-]+$/);
    await g.getByRole('button', { name: /I.m ready/i }).click();
    pages.push(g);
  }
  return pages;
}

/** Full pre-match flow: create -> 4 real guests join + ready ->
 *  (optionally) host-picked Hunters -> Start game.
 *  `pickHunters: 'host'` makes the host a Hunter (deterministic);
 *  `pickHunters: 'others'` makes the host a Runner (the first two
 *  extra guests are the Hunters). Default (no pick) leaves the
 *  Random draw. The guest pages are closed once the match starts.
 *  Returns the store state read just after ACTIVE begins. */
export async function startMatch(
  page: Page,
  context: BrowserContext,
  opts: {
    pickHunters?: 'host' | 'others';
    preset?: 'Quick' | 'Standard' | 'Big Park';
    configureDraft?: (page: Page) => Promise<void>;
    /** False = return as soon as the play page loads (HEAD_START),
     *  so the caller can assert the head-start tutorial itself. */
    waitActive?: boolean;
  } = {},
): Promise<StartedMatch> {
  const { roomId, roomCode, hostId } = await createLobby(page, context, {
    preset: opts.preset ?? 'Standard',
    configureDraft: opts.configureDraft,
  });
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await expect(guest.getByRole('heading', { name: 'Lobby', exact: true })).toBeVisible();
  await guest.getByRole('button', { name: /I.m ready/i }).click();

  await setPlayer(page, hostId);
  await expect(page.getByRole('heading', { name: /Host controls/ })).toBeVisible();
  // Three more real guests (host + Guest Runner + 3 = 5 of 6).
  // The "Add 3 demo players" button is gone — no demo seats exist.
  const extras = await addRealPlayers(context, roomCode, ['Guest Two', 'Guest Three', 'Guest Four']);
  await expect(page.getByText(/Players \(5\/6\)/)).toBeVisible();

  if (opts.pickHunters) {
    // Switch Random -> host-picked, pick exactly hunterCount Hunters
    // (Standard = 2), save, then start. Deterministic roles: no
    // Random-draw flakiness in the specs that depend on who is who.
    await page.getByRole('button', { name: /Switch to host-picked Hunters/i }).click();
    const before = await roomState(page);
    const others = before!.players.filter((p) => p.playerId !== hostId);
    const picked =
      opts.pickHunters === 'host'
        ? [hostId, others[0]!.playerId]
        : [others[0]!.playerId, others[1]!.playerId];
    for (const id of picked) {
      const name = before!.players.find((p) => p.playerId === id)!.displayName;
      // Scope to the checkbox: the roster row also has Report/block
      // and Remove buttons whose aria-labels contain the same name.
      await page.getByRole('checkbox', { name: new RegExp(escapeRegExp(name)) }).check();
    }
    await page.getByRole('button', { name: /Save Hunters/i }).click();
    await expect(page.getByText(/Saved Hunters:/)).toBeVisible();
  }

  await expect(page.getByRole('button', { name: /Start game/i })).toBeEnabled();
  await page.getByRole('button', { name: /Start game/i }).click();
  await expect(page).toHaveURL(`/room/${roomId}/play`);
  await guest.close();
  for (const g of extras) await g.close();

  if (opts.waitActive === false) {
    const early = await roomState(page);
    expect(early).not.toBeNull();
    const earlyHunter = early!.players.find((p) => p.matchRole === 'hunter');
    expect(earlyHunter).toBeDefined();
    return {
      roomId,
      roomCode,
      hostId,
      hunterId: earlyHunter!.playerId,
      runners: early!.players.filter((p) => p.matchRole === 'runner'),
    };
  }

  const hud = page.getByRole('region', { name: 'Match status' });
  await expect(hud).toContainText('Active — hunt on', { timeout: 60_000 });
  const state = await roomState(page);
  expect(state).not.toBeNull();
  const hunter = state!.players.find((p) => p.matchRole === 'hunter');
  expect(hunter).toBeDefined();
  return {
    roomId,
    roomCode,
    hostId,
    hunterId: hunter!.playerId,
    runners: state!.players.filter((p) => p.matchRole === 'runner'),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Horizontal-overflow probe: returns the document width vs the
 *  viewport width plus the worst offending elements (tag, class,
 *  text snippet) so a failure names the culprit. */
export async function overflowProbe(page: Page): Promise<{
  scrollWidth: number;
  innerWidth: number;
  overflowing: boolean;
  offenders: string[];
}> {
  return page.evaluate(() => {
    const innerWidth = window.innerWidth;
    const offenders: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width > 0 && r.right > innerWidth + 1) {
        const t = (el as HTMLElement).innerText?.trim().slice(0, 40) ?? '';
        offenders.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(' ')[0] ?? ''} right=${Math.round(r.right)} "${t}"`);
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      overflowing: document.documentElement.scrollWidth > innerWidth + 1,
      offenders: offenders.slice(0, 8),
    };
  });
}

/** Assert no horizontal overflow on the current page, naming the
 *  offending elements when it fails. */
export async function expectNoOverflow(page: Page, where: string): Promise<void> {
  const probe = await overflowProbe(page);
  expect(
    probe.overflowing,
    `${where}: horizontal overflow — doc ${probe.scrollWidth}px vs viewport ${probe.innerWidth}px; offenders: ${probe.offenders.join(' | ') || 'none identified'}`,
  ).toBe(false);
}

/** Bounding-box height/width of the first matching locator (0 when
 *  the element is not visible). */
export async function boxSize(
  page: Page,
  selector: string,
): Promise<{ width: number; height: number } | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }, selector);
}
