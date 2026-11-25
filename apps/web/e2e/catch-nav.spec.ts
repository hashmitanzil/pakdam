/**
 * catch-nav.spec.ts — the v18 catch flow: camera + column (Way 1) and
 * Self Confirm with a Hunter list + OK (Way 2). Demo-only. Text-only,
 * no screenshots.
 *
 * Grounded in the specified v18 flow (founder) + the built catch page
 * (apps/web/src/app/room/[roomId]/catch):
 * - Play HUD: the Hunter's button is "Tag a runner" (was "CATCH BY QR");
 *   the Runner's button stays "Got Tagged". There is no "SHOW MY QR"
 *   button anywhere — the Runner's QR shows automatically on /catch.
 * - Way 1 (QR scan): "Tag a runner" opens the Hunter's catch screen
 *   with the CAMERA on top and a small column below it. A scanned
 *   Runner appears in the column (their name) with a Tag button; the
 *   Hunter taps Tag and the tag completes ("✓ Catch confirmed").
 *   Headless CI has no camera, so the scan step itself is covered
 *   structurally (camera + column + camera error) and the manual
 *   fallback is covered through the name claim + the Runner's Self
 *   Confirm — a Hunter Tag with no scan cannot confirm (Runner
 *   confirmation is always required, BEHAVIOUR.md).
 * - Way 2 (Self Confirm): on the Runner's catch screen, BELOW the QR,
 *   a "Self Confirm" button. The Runner taps it, sees the list of
 *   Hunters in that game, taps the Hunter who tagged them, then taps OK
 *   — the tag completes with NO Hunter confirmation needed.
 * - The manual fallback (Hunter picks a Runner from a name list) stays:
 *   the picker is already in the column on arrival (no open claim), and
 *   "Runner can't show a QR?" on the camera view brings it back while a
 *   claim is open.
 * - NO catch code anywhere: the token lives only inside the QR.
 * - NO dispute button: the Runner confirms with Self confirm; there is
 *   no "NO — DISPUTE" action (founder decision 2026-11-19).
 * - A Classic tagged Runner is out and gets the after-tagged screen
 *   ("You were tagged" + Spectate match / Back to home); the Hunter
 *   keeps the "✓ Catch confirmed" card.
 *
 * The name picker ("Who did you tag?") is NOT gone: it stays in the
 * column below the camera whenever there is no open claim, so it shows
 * on Hunter arrival — it is the manual fallback. Once a claim opens
 * it is replaced by the "Claim open — …" card (catch/page.tsx:973 —
 * `{manualMode || !openClaim ? picker : claim card}`); tapping
 * "Runner can't show a QR?" while a claim is open brings it back.
 *
 * Removed with the old flow (no longer asserted): the separate
 * "SHOW MY QR" tap; the ?runner= auto-select; the "Scan their QR" /
 * Cancel round-trip off the claim card.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  GUEST_NAMES,
  HOST_NAME,
  createHostRoom,
  dismissRoleReveal,
  newCentredDemoContext,
  resumeSeatViaCatchPage,
  startDemoMatch,
} from './helpers';
import type { Page } from '@playwright/test';

test.describe('catch flow (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  /** Start a match and return the hunter page, a runner page, and their names. */
  async function setupCatch(context: import('@playwright/test').BrowserContext) {
    const { hostPage, guestPages, roomId, roles } = await startDemoMatch(context);
    const names = [HOST_NAME, ...GUEST_NAMES];
    const pages = [hostPage, ...guestPages];
    const hunterIdx = names.findIndex((n) => roles.get(n) === 'hunter');
    const runnerIdx = names.findIndex((n) => roles.get(n) === 'runner');
    const hunterPage = pages[hunterIdx]!;
    const runnerPage = pages[runnerIdx]!;
    const hunterName = names[hunterIdx]!;
    const runnerName = names[runnerIdx]!;
    const otherRunnerName = names.find((n) => n !== hunterName && n !== runnerName)!;
    return { hostPage, guestPages, roomId, roles, hunterPage, runnerPage, hunterName, runnerName, otherRunnerName };
  }

  /**
   * Way 1 entry: the Hunter taps "Tag a runner" on the play HUD and lands
   * on the catch screen — camera on top, column below. The name picker
   * ("Who did you tag?") IS in that column on arrival: with no open
   * claim it is the manual fallback, shown below the camera. Once a
   * claim opens it is replaced by the claim card (see
   * tagRunnerViaFallback).
   */
  async function openHunterCatch(hunterPage: Page, roomId: string) {
    await expect(hunterPage.getByRole('button', { name: 'CATCH BY QR' })).toBeHidden();
    await hunterPage.getByRole('button', { name: 'Tag a runner', exact: true }).click();
    await expect(hunterPage).toHaveURL(new RegExp(`/room/${roomId}/catch`));
    await expect(hunterPage.getByRole('heading', { name: 'Catch' })).toBeVisible();
    // Camera at the top, column (manual fallback picker) below it.
    const video = hunterPage.locator('video[aria-label="QR scanner camera"]');
    await expect(video).toBeVisible();
    await expect(hunterPage.getByText("Point at the runner's QR")).toBeVisible();
    await expect(hunterPage.getByText('Who did you tag?')).toBeVisible();
    const fallback = hunterPage.getByRole('button', { name: "Runner can't show a QR?" });
    await expect(fallback).toBeVisible();
    const videoBox = await video.boundingBox();
    const fallbackBox = await fallback.boundingBox();
    expect(videoBox, 'camera should render').not.toBeNull();
    expect(fallbackBox, 'column should render').not.toBeNull();
    expect(
      videoBox!.y + videoBox!.height,
      'camera sits above the column below it',
    ).toBeLessThanOrEqual(fallbackBox!.y);
  }

  /**
   * Way 1 via the manual fallback (headless has no camera to scan with):
   * camera view → "Runner can't show a QR?" → pick the Runner by name →
   * the Runner lands in the column below the camera with a Tag button
   * that stays disabled until their QR is scanned. The fallback has no
   * scan, so the tag completes when the Runner confirms on their own
   * phone (Self Confirm) — a Hunter Tag with no scan cannot confirm:
   * Runner confirmation is always required and a tag never counts at
   * once (BEHAVIOUR.md; the server rejects a Hunter confirm with no
   * valid QR token, and the demo mirrors it).
   */
  async function tagRunnerViaFallback(
    hunterPage: Page,
    runnerPage: Page,
    roomId: string,
    runnerName: string,
    hunterName: string,
  ) {
    // v32: the Runner's seat is suspended in the headless multi-page
    // setup (backgrounded tab) and the Hunter's claim rejects a
    // suspended Runner — mount the Runner on the catch page first
    // (P0-1 resume), so the claim below lands.
    await resumeSeatViaCatchPage(runnerPage, roomId, runnerName);
    await openHunterCatch(hunterPage, roomId);
    await hunterPage.getByRole('button', { name: "Runner can't show a QR?" }).click();
    await expect(hunterPage.getByText('Who did you tag?')).toBeVisible();
    await hunterPage.getByRole('button', { name: runnerName }).click();
    // The fallback picker confirms the pick with "I TAGGED <NAME>" when
    // it renders one; the Runner then lands in the column below the camera.
    const taggedBtn = hunterPage.getByRole('button', {
      name: `I TAGGED ${runnerName.toUpperCase()}`,
    });
    if ((await taggedBtn.count()) > 0) await taggedBtn.click();
    // The picked Runner in the column, with a Tag button that stays
    // disabled until their QR is scanned — the fallback has no scan, so
    // the Runner confirms on their phone instead.
    await expect(hunterPage.getByText(runnerName).first()).toBeVisible();
    await expect(hunterPage.getByText(`Claim open — ${runnerName}`)).toBeVisible();
    // The claim replaces the picker in the column (the claim clears
    // manualMode — catch/page.tsx:973): "Who did you tag?" is gone
    // while the claim is open.
    await expect(hunterPage.getByText('Who did you tag?')).toBeHidden();
    await expect(
      hunterPage.getByText('The Runner confirms on their phone — no QR needed.'),
    ).toBeVisible();
    const tagBtn = hunterPage.getByRole('button', { name: 'Scan their QR first' });
    await expect(tagBtn).toBeVisible();
    await expect(tagBtn).toBeDisabled();
    // The Runner confirms on their phone (Self Confirm) — the tag
    // completes with no Hunter scan and no QR at all.
    await selfConfirmAsRunner(runnerPage, roomId, hunterName, hunterPage, runnerName);
    await expect(hunterPage.getByText('✓ Catch confirmed')).toBeVisible({ timeout: 15000 });
  }

  /**
   * Way 2 (Self Confirm): the Runner taps "Self confirm" below their QR,
   * picks the Hunter who tagged them from the Hunter list, taps OK — the
   * tag completes with no Hunter confirmation needed.
   *
   * v32: the Hunter's seat is suspended in the headless multi-page
   * setup (backgrounded tab) and the self-confirm creates its claim
   * through `requestCatch`, which rejects a suspended Hunter — so the
   * Hunter mounts the catch page first (P0-1 resume). That is
   * navigation only, not a catch action: the Hunter still never
   * claims, scans, or confirms anything. The Runner mounts (or is
   * already on) the catch page the same way, which resumes them.
   */
  async function selfConfirmAsRunner(
    runnerPage: Page,
    roomId: string,
    hunterName: string,
    hunterPage: Page,
    runnerName: string,
  ) {
    await resumeSeatViaCatchPage(hunterPage, roomId, hunterName);
    await resumeSeatViaCatchPage(runnerPage, roomId, runnerName);
    await runnerPage.getByRole('button', { name: 'Self confirm', exact: true }).click();
    await expect(runnerPage.getByRole('button', { name: hunterName, exact: true })).toBeVisible();
    await runnerPage.getByRole('button', { name: hunterName, exact: true }).click();
    await runnerPage.getByRole('button', { name: 'OK', exact: true }).click();
    // Classic: the tagged Runner is out — after-tagged screen.
    await expect(runnerPage.getByText('You were tagged')).toBeVisible();
    await expect(runnerPage.getByText(`You were tagged by ${hunterName}.`)).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Spectate match' })).toBeVisible();
  }

  test('hunter catch screen: camera on top, name picker in the column below (no open claim)', async ({
    context,
  }) => {
    const { hunterPage, roomId } = await setupCatch(context);
    await openHunterCatch(hunterPage, roomId);
  });

  test('Way 1: manual fallback → name claim → Runner confirms on their phone → Catch confirmed', async ({
    browser,
  }) => {
    const context = await newCentredDemoContext(browser);
    const { hunterPage, runnerPage, roomId, hunterName, runnerName } = await setupCatch(context);
    await tagRunnerViaFallback(hunterPage, runnerPage, roomId, runnerName, hunterName);
    await expect(hunterPage.getByText(`${runnerName} was tagged by ${hunterName}.`)).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: 'Tag someone else' })).toBeVisible();
    // The tagged Runner sees the after-tagged screen on their own phone.
    await runnerPage.goto(`/room/${roomId}/catch`);
    await expect(runnerPage.getByText('You were tagged')).toBeVisible();
    await expect(runnerPage.getByText(`You were tagged by ${hunterName}.`)).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Spectate match' })).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Back to home' })).toBeVisible();
    await context.close();
  });

  test('scanner view in headless: camera error, hint, manual-fallback link', async ({
    context,
  }) => {
    const { hunterPage, roomId } = await setupCatch(context);
    await openHunterCatch(hunterPage, roomId);
    // Headless Chromium has no camera, so the scanner reports it plainly.
    await expect(
      hunterPage.getByText('Camera unavailable — use the manual fallback below.'),
    ).toBeVisible();
    await expect(hunterPage.getByText("Point at the runner's QR")).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: "Runner can't show a QR?" })).toBeVisible();
  });

  test("runner Got Tagged opens the QR automatically — no SHOW MY QR tap", async ({
    context,
  }) => {
    // v18 Way 1: "Got Tagged" opens the catch screen with the Runner's
    // QR ALREADY SHOWING — there is no separate "SHOW MY QR" tap.
    const { runnerPage, roomId, runnerName } = await setupCatch(context);
    await runnerPage.getByRole('button', { name: 'Got Tagged', exact: true }).click();
    await expect(runnerPage).toHaveURL(new RegExp(`/room/${roomId}/catch`));
    await expect(runnerPage.locator(`img[alt="QR code for ${runnerName}"]`)).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'SHOW MY QR' })).toBeHidden();
    // Self Confirm sits below the QR on the same screen.
    await expect(runnerPage.getByRole('button', { name: 'Self confirm', exact: true })).toBeVisible();
  });

  test('Way 2: Self Confirm → Hunter list → OK completes the tag with no hunter action', async ({
    browser,
  }) => {
    const context = await newCentredDemoContext(browser);
    const { hunterPage, runnerPage, roomId, hunterName, runnerName, otherRunnerName } =
      await setupCatch(context);
    // The Hunter does nothing at all — the Runner drives the whole tag.
    // (v32: the Hunter still mounts the catch page first — navigation
    // only, so their suspended seat resumes via P0-1; they never
    // claim, scan, or confirm anything.)
    await resumeSeatViaCatchPage(hunterPage, roomId, hunterName);
    await resumeSeatViaCatchPage(runnerPage, roomId, runnerName);
    await runnerPage.getByRole('button', { name: 'Self confirm', exact: true }).click();
    // The list holds the Hunters in this game only — not the other Runner.
    await expect(runnerPage.getByRole('button', { name: hunterName, exact: true })).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: otherRunnerName, exact: true })).toBeHidden();
    await runnerPage.getByRole('button', { name: hunterName, exact: true }).click();
    await runnerPage.getByRole('button', { name: 'OK', exact: true }).click();
    await expect(runnerPage.getByText('You were tagged')).toBeVisible();
    await expect(runnerPage.getByText(`You were tagged by ${hunterName}.`)).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Spectate match' })).toBeVisible();
    // The Hunter's catch screen shows the confirmed tag without the
    // Hunter ever having claimed, scanned, or confirmed anything.
    await hunterPage.goto(`/room/${roomId}/catch`);
    await expect(hunterPage.getByText('✓ Catch confirmed')).toBeVisible({ timeout: 15000 });
    await expect(hunterPage.getByText(`${runnerName} was tagged by ${hunterName}.`)).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: 'Tag someone else' })).toBeVisible();
    await context.close();
  });

  test('no catch code anywhere in the catch UI', async ({ context }) => {
    const { hunterPage, roomId, runnerPage } = await setupCatch(context);
    for (const page of [hunterPage, runnerPage]) {
      await page.goto(`/room/${roomId}/catch`);
      const text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
      expect(text).not.toContain('catch code');
      expect(text).not.toContain('enter the code');
      await expect(page.getByText(/catch code/i)).toBeHidden();
    }
  });

  test('P1-17: no dispute button — the runner only ever sees Self Confirm', async ({
    context,
  }) => {
    // Founder decision (2026-11-19): NO dispute. The runner confirms with
    // Self Confirm; there is no 'NO — DISPUTE' button anywhere on the
    // catch screen, and the host sees no Disputes section unless a catch
    // is already disputed server-side (this client can never create one).
    const { hostPage, runnerPage, roomId } = await setupCatch(context);
    await runnerPage.goto(`/room/${roomId}/catch`);
    await expect(runnerPage.getByRole('button', { name: 'NO — DISPUTE' })).toBeHidden();
    await expect(runnerPage.getByRole('button', { name: 'Self confirm', exact: true })).toBeVisible();
    await hostPage.goto(`/room/${roomId}/catch`);
    await expect(hostPage.getByText('Disputes')).toBeHidden();
  });

  test('P1-17: runner confirms instead of disputing — after-tagged screen, no Disputes section', async ({
    browser,
  }) => {
    const context = await newCentredDemoContext(browser);
    const { hostPage, hunterPage, runnerPage, roomId, hunterName, runnerName } =
      await setupCatch(context);
    await runnerPage.goto(`/room/${roomId}/catch`);
    await expect(runnerPage.getByRole('button', { name: 'NO — DISPUTE' })).toBeHidden();
    await selfConfirmAsRunner(runnerPage, roomId, hunterName, hunterPage, runnerName);
    await hostPage.goto(`/room/${roomId}/catch`);
    await expect(hostPage.getByText('Disputes')).toBeHidden();
    await context.close();
  });

  test('P0-1: a suspended runner is resumed on catch-page arrival and can confirm', async ({
    browser,
  }) => {
    const context = await newCentredDemoContext(browser);
    const { hunterPage, runnerPage, roomId, hunterName } = await setupCatch(context);
    // Suspend the runner on the play screen (tab-hide).
    await runnerPage.goto(`/room/${roomId}/play`);
    await dismissRoleReveal(runnerPage);
    await runnerPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(runnerPage.getByText(/Suspended — location unknown/)).toBeVisible();
    // Arriving at the catch page resumes them (demo P0-1 rule).
    await runnerPage.goto(`/room/${roomId}/catch`);
    await expect(runnerPage.getByText(/Suspended — location unknown/)).toBeHidden({
      timeout: 10000,
    });
    await expect(runnerPage.getByText("You're suspended — reconnect to confirm.")).toBeHidden();
    await expect(runnerPage.getByRole('button', { name: 'Self confirm', exact: true })).toBeEnabled();
    // v32: the Hunter's seat is suspended too (backgrounded tab) and
    // the self-confirm creates its claim through `requestCatch`,
    // which rejects a suspended Hunter — mount the Hunter on the
    // catch page first (P0-1 resume; navigation only).
    await resumeSeatViaCatchPage(hunterPage, roomId, hunterName);
    // Way 2: pick the Hunter, OK — the tag completes.
    await runnerPage.getByRole('button', { name: 'Self confirm', exact: true }).click();
    await runnerPage.getByRole('button', { name: hunterName, exact: true }).click();
    await runnerPage.getByRole('button', { name: 'OK', exact: true }).click();
    // Classic: the tagged Runner is out — after-tagged screen, not the
    // hunter's "Catch confirmed" card.
    await expect(runnerPage.getByText('You were tagged')).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Spectate match' })).toBeVisible();
    await context.close();
  });

  test('catch page in the lobby redirects back to the lobby (v18 A9)', async ({
    context,
  }) => {
    const page = await context.newPage();
    const { roomId } = await createHostRoom(page);
    await page.goto(`/room/${roomId}/catch`);
    // The catch page redirects to the lobby while the phase is LOBBY, so the
    // "Catches count once the match is live." card is never shown there.
    await expect(page).toHaveURL(new RegExp(`/room/${roomId}$`));
    await expect(page.getByRole('button', { name: /I'm ready/ })).toBeVisible();
  });
});
