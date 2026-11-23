/**
 * catch-results.spec.ts — catch → confirm → results (red hero, one-line
 * stats, max-6 timeline, START A FRESH GAME) and Replay — back to the
 * lobby (v18). Demo-only. Text-only.
 *
 * Tags here go through Way 2 (Self Confirm → Hunter list → OK) or Way 1
 * via the manual fallback (camera + column → Tag); see catch-nav.spec.ts
 * for the full catch-flow coverage.
 *
 * The match is ended by moving the demo room's endsAt into the past in
 * localStorage (the demo tick completes it on the next 1 s poll); the
 * stats duration is real elapsed time, so it is asserted by pattern, not
 * by an exact value.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  GUEST_NAMES,
  HOST_NAME,
  forceDemoMatchEnd,
  forceDemoShrink,
  getDemoRoom,
  startDemoMatch,
} from './helpers';
import type { Page } from '@playwright/test';

test.describe('catch → results (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  async function setupMatch(context: import('@playwright/test').BrowserContext) {
    const { hostPage, guestPages, roomId, code, roles } = await startDemoMatch(context);
    const names = [HOST_NAME, ...GUEST_NAMES];
    const pages = [hostPage, ...guestPages];
    const hunterIdx = names.findIndex((n) => roles.get(n) === 'hunter');
    const runnerIdxs = names.map((n, i) => (roles.get(n) === 'runner' ? i : -1)).filter((i) => i >= 0);
    const hunterPage = pages[hunterIdx]!;
    const runnerPages = runnerIdxs.map((i) => pages[i]!);
    const runnerNames = runnerIdxs.map((i) => names[i]!);
    const hunterName = names[hunterIdx]!;
    return { hostPage, guestPages, roomId, code, hunterPage, runnerPages, runnerNames, hunterName };
  }

  /**
   * Way 2 (v18): the Runner self-confirms — "Self Confirm" → Hunter list
   * → tap the Hunter → OK. The Hunter does nothing; the tag completes.
   */
  async function catchRunner(hunterPage: Page, runnerPage: Page, roomId: string, runnerName: string, hunterName: string) {
    await runnerPage.goto(`/room/${roomId}/catch`);
    await runnerPage.getByRole('button', { name: 'Self confirm', exact: true }).click();
    await runnerPage.getByRole('button', { name: hunterName, exact: true }).click();
    await runnerPage.getByRole('button', { name: 'OK', exact: true }).click();
    // Classic: the tagged Runner is out — after-tagged screen.
    await expect(runnerPage.getByText('You were tagged')).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Spectate match' })).toBeVisible();
    await hunterPage.goto(`/room/${roomId}/catch`);
    await expect(hunterPage.getByText('✓ Catch confirmed')).toBeVisible({ timeout: 15000 });
    await expect(hunterPage.getByText(`${runnerName} was tagged by ${hunterName}.`)).toBeVisible();
  }

  async function goToResults(page: Page, roomId: string) {
    await page.goto(`/room/${roomId}/results`);
    await expect(page.getByText('MATCH OVER')).toBeVisible();
  }

  test('one tag then time up: Runners Win, one-line stats, timeline, fresh game', async ({
    context,
  }) => {
    const { hostPage, roomId, hunterPage, runnerPages, runnerNames, hunterName } =
      await setupMatch(context);
    await catchRunner(hunterPage, runnerPages[0]!, roomId, runnerNames[0]!, hunterName);
    await forceDemoMatchEnd(hostPage, roomId);
    await goToResults(hostPage, roomId);
    await expect(hostPage.getByText('Runners Win!', { exact: true })).toBeVisible();
    await expect(hostPage.getByText(/Classic Mode · Room [A-Z0-9]{6}/)).toBeVisible();
    // One-line stats: "<elapsed> · 1 tag · 1 runner never caught".
    await expect(hostPage.getByText(/· 1 tag · 1 runner never caught/)).toBeVisible();
    await expect(hostPage.getByRole('heading', { name: 'What happened' })).toBeVisible();
    await expect(hostPage.getByText('Match started — 3 players')).toBeVisible();
    await expect(hostPage.getByText(`${hunterName} tagged ${runnerNames[0]}`)).toBeVisible();
    await expect(hostPage.getByText('Time up — runners win')).toBeVisible();
    // Max 6 timeline entries.
    await expect(hostPage.locator('.border-l-2')).toHaveCount(3);
    await hostPage.getByRole('button', { name: 'START A FRESH GAME' }).click();
    await expect(hostPage).toHaveURL(/\/$/);
    await expect(hostPage.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
  });

  test('all runners caught: Hunters Win, Last runner caught, no never-caught line', async ({
    context,
  }) => {
    const { hostPage, roomId, hunterPage, runnerPages, runnerNames, hunterName } = await setupMatch(context);
    await catchRunner(hunterPage, runnerPages[0]!, roomId, runnerNames[0]!, hunterName);
    // Tag someone else: the hunter's done card offers the next claim.
    // Way 1 via the manual fallback — camera view → pick the runner by
    // name → the runner lands in the column with a Tag button (disabled
    // until a scan) → the runner confirms on their own phone (Self
    // Confirm). A Hunter Tag with no scan cannot confirm (Runner
    // confirmation is always required, BEHAVIOUR.md).
    await hunterPage.getByRole('button', { name: 'Tag someone else' }).click();
    await expect(hunterPage.getByText("Point at the runner's QR")).toBeVisible();
    await hunterPage.getByRole('button', { name: "Runner can't show a QR?" }).click();
    await hunterPage.getByRole('button', { name: runnerNames[1]! }).click();
    const taggedBtn = hunterPage.getByRole('button', {
      name: `I TAGGED ${runnerNames[1]!.toUpperCase()}`,
    });
    if ((await taggedBtn.count()) > 0) await taggedBtn.click();
    await expect(hunterPage.getByText(`Claim open — ${runnerNames[1]}`)).toBeVisible();
    const tagBtn = hunterPage.getByRole('button', { name: 'Scan their QR first' });
    await expect(tagBtn).toBeDisabled();
    await runnerPages[1]!.goto(`/room/${roomId}/catch`);
    await runnerPages[1]!.getByRole('button', { name: 'Self confirm', exact: true }).click();
    await runnerPages[1]!.getByRole('button', { name: hunterName, exact: true }).click();
    await runnerPages[1]!.getByRole('button', { name: 'OK', exact: true }).click();
    // Catching the last free runner completes the match at once, so the
    // hunter's tab goes straight to the match-over card — the done card
    // can never appear there (confirm + complete land in one write).
    // Either card proves the confirm landed.
    await expect(
      hunterPage.getByText(/✓ Catch confirmed|Match over — see the results page/),
    ).toBeVisible({ timeout: 15000 });
    // Catching the last free runner completes the match at once, so the
    // catch page may show the done card or the match-over card — either
    // proves the confirm landed.
    await expect(
      runnerPages[1]!.getByText(/You were tagged|Match over — see the results page/),
    ).toBeVisible();
    // Catching the last free runner completes the match at once.
    await goToResults(hostPage, roomId);
    await expect(hostPage.getByText('Hunters Win!', { exact: true })).toBeVisible();
    await expect(hostPage.getByText(/· 2 tags/)).toBeVisible();
    await expect(hostPage.getByText(/never caught/)).toBeHidden();
    await expect(hostPage.getByText('Last runner caught')).toBeVisible();
    await expect(hostPage.locator('.border-l-2')).toHaveCount(4);
  });

  test('Replay — back to the lobby: same room and code, players and config kept, everyone un-ready', async ({
    context,
  }) => {
    // v18 Item 3: when the match ends, the results screen has a host-only
    // "Replay — back to the lobby" button. The host taps it → the room
    // resets to LOBBY → the client returns to the lobby with the SAME
    // room and SAME room code (players + config kept, match state
    // cleared, everyone un-ready). Scores / tag list / winners stay on
    // the results screen until Replay is tapped.
    const { hostPage, guestPages, roomId, code, hunterPage, runnerPages, runnerNames, hunterName } =
      await setupMatch(context);
    await catchRunner(hunterPage, runnerPages[0]!, roomId, runnerNames[0]!, hunterName);
    // B2: the replayed game must start on the ORIGINAL configured zone,
    // not the shrunk one — so shrink the zone once first, then replay.
    const roomBefore = await getDemoRoom(hostPage, roomId);
    const originalBoundary = roomBefore?.room.config.zone.boundary ?? [];
    expect(originalBoundary.length).toBeGreaterThanOrEqual(3);
    await forceDemoShrink(hostPage, roomId);
    // The shrink lands on the next 1 s demo tick — assert it fired, or
    // the replay assertion below would pass vacuously.
    await expect
      .poll(
        async () => {
          const r = await getDemoRoom(hostPage, roomId);
          return JSON.stringify(r?.room.config.zone.boundary ?? null);
        },
        { timeout: 15000 },
      )
      .not.toBe(JSON.stringify(originalBoundary));
    await forceDemoMatchEnd(hostPage, roomId);
    await goToResults(hostPage, roomId);
    await expect(hostPage.getByText('Runners Win!', { exact: true })).toBeVisible();
    await expect(hostPage.getByText(`${hunterName} tagged ${runnerNames[0]}`)).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'Replay — back to the lobby', exact: true })).toBeVisible();

    // Non-host: no working Replay button (absent, or present but disabled).
    const guestPage = guestPages[0]!;
    await guestPage.goto(`/room/${roomId}/results`);
    await expect(guestPage.getByText('MATCH OVER')).toBeVisible();
    const guestReplay = guestPage.getByRole('button', { name: 'Replay — back to the lobby', exact: true });
    if ((await guestReplay.count()) > 0) await expect(guestReplay).toBeDisabled();

    // Host taps Replay → the client returns to the lobby, same room + code.
    await hostPage.getByRole('button', { name: 'Replay — back to the lobby', exact: true }).click();
    await expect(hostPage).toHaveURL(new RegExp(`/room/${roomId}$`));
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    const codeAfter = (await hostPage.locator('section[aria-label="Game code"] .pakdam-code').innerText()).trim();
    expect(codeAfter).toBe(code);

    // White-box (demo store): phase LOBBY, match state cleared, config kept.
    const roomAfter = await getDemoRoom(hostPage, roomId);
    expect(roomAfter?.room.phase).toBe('LOBBY');
    expect(roomAfter?.room.config.mode).toBe('classic');
    // B2: Replay restores the ORIGINAL configured zone — the shrink
    // forced above must not survive the replay.
    expect(roomAfter?.room.config.zone.boundary).toEqual(originalBoundary);
    expect(roomAfter?.catches).toHaveLength(0);
    expect(roomAfter?.players).toHaveLength(3);
    for (const p of roomAfter?.players ?? []) {
      expect(p.isReady, `${p.displayName} should be un-ready after Replay`).toBe(false);
      expect(p.matchRole, `${p.displayName} should have no match role after Replay`).toBeNull();
    }

    // Every seat back on the lobby shows "I'm ready" (not the ready state),
    // and the host can start again from the same lobby. Guests are taken
    // to the lobby directly — the results screen has no phase redirect.
    for (const page of [hostPage, ...guestPages]) {
      await page.goto(`/room/${roomId}`);
      await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
      await expect(page.getByRole('button', { name: "I'm ready", exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /I'm ready — tap to change/ })).toBeHidden();
    }
    await expect(hostPage.getByRole('button', { name: 'START GAME', exact: true })).toBeVisible();
  });

  test('results before the match finishes says so and links back to the match', async ({
    context,
  }) => {
    const { hostPage, roomId } = await setupMatch(context);
    await hostPage.goto(`/room/${roomId}/results`);
    await expect(hostPage.getByText('Match hasn’t finished yet.')).toBeVisible();
    await hostPage.getByRole('button', { name: 'Back to the match' }).click();
    await expect(hostPage).toHaveURL(/\/room\/[^/]+\/play/);
  });

  test('a fresh game after results gets a new room code', async ({ context }) => {
    const { hostPage, roomId } = await setupMatch(context);
    await forceDemoMatchEnd(hostPage, roomId);
    await goToResults(hostPage, roomId);
    const oldCode = (await hostPage.getByText(/Classic Mode · Room [A-Z0-9]{6}/).innerText()).slice(-6);
    await hostPage.getByRole('button', { name: 'START A FRESH GAME' }).click();
    await hostPage.getByRole('button', { name: /HOST A GAME/ }).click();
    await hostPage.getByLabel('Your codename').fill('Teo');
    // The mode card does nothing until the on-site box is ticked.
    await hostPage.getByRole('checkbox', { name: /I'm at the play location/ }).click();
    await hostPage.getByRole('button', { name: /Classic/ }).click();
    // The mode card lands on /setup ('Create lobby' heading) — the room
    // code exists only on the lobby, after CREATE LOBBY.
    await expect(hostPage.getByRole('heading', { name: 'Create lobby' })).toBeVisible();
    await hostPage.getByRole('button', { name: 'CREATE LOBBY', exact: true }).click();
    await expect(hostPage.getByRole('heading', { name: 'Lobby' })).toBeVisible();
    const newCode = (await hostPage.locator('section[aria-label="Game code"] .pakdam-code').innerText()).trim();
    expect(newCode).not.toBe(oldCode);
  });
});
