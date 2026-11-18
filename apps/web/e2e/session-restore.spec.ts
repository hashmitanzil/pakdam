// Session restore e2e — TEXT/DOM assertions only, no screenshots.
// Founder bugs (2026-11-17): (b) rooms are persisted (localStorage)
// so a reload restores the room and the player's role; (c) joining
// with an existing display name restores that seat instead of
// creating a duplicate; (d) per-tab identity (sessionStorage) keeps
// the host's Start button when a second player joins, and the lobby
// has Leave room / Switch player controls.
//
// RECONSTRUCTED 2026-11-17: this file was truncated to 0 bytes by the
// VM's EPERM write flapping. The original test titles survive in the
// run-2 Playwright error-context dirs; the tests below are faithful
// reconstructions of those titles against the current helpers
// (createLobby / joinAsGuest / roomState) and the current lobby UI
// (Leave room / Switch player buttons). They were NOT run in this
// session — Chromium cannot start on this VM (see docs/DECISIONS.md).
import { test, expect } from '@playwright/test';
import { createLobby, joinAsGuest, roomState, setPlayer } from './helpers';

test('(a) Create with no zone centre explains instead of silently doing nothing, and a map tap places the zone', async ({ page }) => {
  test.setTimeout(120_000);
  // No geolocation grant: no fix can arrive, so the zone stays
  // un-centred and Create must explain instead of doing nothing.
  await page.goto('/create');
  await page.getByLabel(/codename/i).fill('Test Host');
  await page.getByRole('button', { name: /CREATE LOBBY/ }).click();
  await expect(page.getByText(/Set the zone centre first/i)).toBeVisible({ timeout: 10_000 });
  await expect(page).not.toHaveURL(/\/room\//);
  // Manual fallback: tap the map to place the zone by hand, then
  // Create succeeds. Wait for the map canvas first (hydration gate —
  // a tap before MapLibre mounts lands on an empty container and
  // places nothing).
  await expect(page.locator('.mapbox .maplibregl-canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('.mapbox').click({ position: { x: 180, y: 160 } });
  // Tapping the map places the centre by hand (no GPS fix here) —
  // the old "Zone centre: set" line was removed in §5c; the
  // hand-placed evidence is the "Placed by hand on the map" line.
  await expect(page.getByText(/Placed by hand on the map/)).toBeVisible();
  await page.getByLabel(/I have checked the venue/i).check();
  await page.getByLabel(/I will be on site/i).check();
  await page.getByRole('button', { name: /CREATE LOBBY/ }).click();
  await expect(page).toHaveURL(/\/room\/[0-9a-f-]+$/);
  await expect(page.getByText(/Room code/i)).toBeVisible();
});

test('(b) reload restores the room, the host seat and the guest seat', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context);
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);

  // Reload the host tab: the room and the host seat come back.
  await page.reload();
  await expect(page).toHaveURL(`/room/${roomId}`);
  await expect(page.getByText(/Room code/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Host controls/ })).toBeVisible();
  const afterHostReload = await roomState(page);
  expect(afterHostReload).not.toBeNull();
  expect(afterHostReload!.players.some((p) => p.playerId === hostId && p.isHost)).toBe(true);

  // Reload the guest tab: the room and the guest seat come back.
  await guest.reload();
  await expect(guest).toHaveURL(`/room/${roomId}`);
  await expect(guest.getByText(/Guest Runner/)).toBeVisible();
  const afterGuestReload = await roomState(guest);
  expect(afterGuestReload).not.toBeNull();
  expect(afterGuestReload!.players.some((p) => p.displayName === 'Guest Runner')).toBe(true);
  await guest.close();
});

test('(c) rejoining with the host name restores the host seat — no duplicate', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context);
  // A second tab joins with the HOST's display name: it must restore
  // the host seat (same playerId, host powers), not create a duplicate.
  const rejoined = await joinAsGuest(context, roomCode, 'Test Host');
  await expect(rejoined).toHaveURL(`/room/${roomId}`);
  const state = await roomState(rejoined);
  expect(state).not.toBeNull();
  const hosts = state!.players.filter((p) => p.displayName === 'Test Host');
  expect(hosts, 'joining with the host name must not duplicate the host seat').toHaveLength(1);
  expect(hosts[0]!.playerId).toBe(hostId);
  expect(hosts[0]!.isHost).toBe(true);
  // The rejoined tab holds the host seat, so it sees host controls.
  await setPlayer(rejoined, hostId);
  await expect(rejoined.getByRole('heading', { name: /Host controls/ })).toBeVisible();
  await rejoined.close();
});

test('(d) a second player joining in another tab cannot steal the host Start button; Leave and Switch work', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { roomId, roomCode, hostId } = await createLobby(page, context);
  const guest = await joinAsGuest(context, roomCode, 'Guest Runner');
  await expect(guest).toHaveURL(`/room/${roomId}`);

  // The host tab keeps its Start button after the guest joins (the
  // guest joining in another tab must not steal host identity).
  await setPlayer(page, hostId);
  await expect(page.getByRole('heading', { name: /Host controls/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Start game/i })).toBeVisible();
  // The guest tab does not get host controls.
  await expect(guest.getByRole('heading', { name: /Host controls/ })).toHaveCount(0);

  // Leave room: the guest leaves and lands on the home page. Both
  // buttons confirm with window.confirm — Playwright auto-dismisses
  // dialogs, which would cancel the leave, so accept them first.
  guest.once('dialog', (d) => d.accept());
  await guest.getByRole('button', { name: /Leave room/i }).click();
  await expect(guest).toHaveURL('/');

  // Switch player: the host leaves the seat and lands on the join
  // page for this room, where they can rejoin by name.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: /Switch player/i }).click();
  await expect(page).toHaveURL(`/join/${roomCode}`);
  await guest.close();
});
