/**
 * brutal-phone.spec.ts — phone-viewport end-to-end (demo): create → join →
 * lobby → ready → start → play → catch → results, at 390×844 with touch.
 * Text-only, no screenshots.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  GUEST_NAMES,
  HOST_NAME,
  forceDemoMatchEnd,
  newCentredDemoContext,
  resumeSeatViaCatchPage,
  startCentreFixKeepFresh,
  startDemoMatch,
} from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.describe('brutal phone end-to-end (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('create → join → ready → start → play → catch → confirm → results → fresh game', async ({
    browser,
  }) => {
    test.setTimeout(180000);
    const context = await newCentredDemoContext(browser);
    const { hostPage, guestPages, roomId, roles } = await startDemoMatch(context);
    // v32 fix round (Diya A1): the untouched Runner is never harboured
    // in this flow, so if it is the front tab its one centred fix goes
    // stale at ACTIVE+30 s and the (4a) clock ejects it mid-test. The
    // 4 s nudge loop re-stamps the front seat's `lastFixAt` for the
    // whole ACTIVE span (see `startCentreFixKeepFresh`); stop it just
    // before the context closes.
    const stopKeepFresh = startCentreFixKeepFresh(context);
    const names = [HOST_NAME, ...GUEST_NAMES];
    const pages = [hostPage, ...guestPages];
    const hunterIdx = names.findIndex((n) => roles.get(n) === 'hunter');
    const runnerIdx = names.findIndex((n) => roles.get(n) === 'runner');
    const hunterPage = pages[hunterIdx]!;
    const runnerPage = pages[runnerIdx]!;
    const hunterName = names[hunterIdx]!;
    const runnerName = names[runnerIdx]!;

    // Play HUD on the phone: status strip + per-role catch button.
    // (The Hunter's button is "Tag a runner" — v18 renamed it from
    // "CATCH BY QR". The runner's button is "Got Tagged" — there is no
    // "SHOW MY QR" button on the play screen; the QR itself is shown
    // automatically on /catch.)
    await expect(hunterPage.getByText('Time left')).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: 'Tag a runner', exact: true })).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Got Tagged' })).toBeVisible();

    // Catch, Way 1 (v18): the hunter taps "Tag a runner" on the play HUD
    // — camera on top, column below. Headless has no camera, so the tag
    // goes through the manual fallback: pick the runner's name, then the
    // runner confirms on their own phone (Self Confirm) — a Hunter Tag
    // with no scan cannot confirm (Runner confirmation is always
    // required, BEHAVIOUR.md).
    // v32: the Runner's seat is suspended in the headless multi-page
    // setup (backgrounded tab) and the Hunter's claim rejects a
    // suspended Runner — mount the Runner on the catch page first
    // (P0-1 resume), so the claim below lands. The Hunter mounts the
    // catch page by tapping "Tag a runner", which resumes them the
    // same way.
    await resumeSeatViaCatchPage(runnerPage, roomId, runnerName);
    await hunterPage.getByRole('button', { name: 'Tag a runner', exact: true }).click();
    await expect(hunterPage.getByText("Point at the runner's QR")).toBeVisible();
    await hunterPage.getByRole('button', { name: "Runner can't show a QR?" }).click();
    await hunterPage.getByRole('button', { name: runnerName }).click();
    const taggedBtn = hunterPage.getByRole('button', {
      name: `I TAGGED ${runnerName.toUpperCase()}`,
    });
    if ((await taggedBtn.count()) > 0) await taggedBtn.click();
    // The picked Runner lands in the column with a Tag button that stays
    // disabled until their QR is scanned — the fallback has no scan, so
    // the Runner confirms on their phone instead.
    await expect(hunterPage.getByText(`Claim open — ${runnerName}`)).toBeVisible();
    const tagBtn = hunterPage.getByRole('button', { name: 'Scan their QR first' });
    await expect(tagBtn).toBeDisabled();
    await runnerPage.goto(`/room/${roomId}/catch`);
    await runnerPage.getByRole('button', { name: 'Self confirm', exact: true }).click();
    await runnerPage.getByRole('button', { name: hunterName, exact: true }).click();
    await runnerPage.getByRole('button', { name: 'OK', exact: true }).click();
    await expect(hunterPage.getByText('✓ Catch confirmed')).toBeVisible({ timeout: 15000 });

    // Classic: the tagged Runner is out — after-tagged screen.
    await runnerPage.goto(`/room/${roomId}/catch`);
    await expect(runnerPage.getByText('You were tagged', { exact: true })).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Spectate match' })).toBeVisible();

    // Back to the map, end the match, results, fresh game.
    // exact:true — the catch page has TWO "Back to the map"
    // buttons (the header '‹ Back to the map' link AND the done
    // card's primary CTA); both route to /play, and the CTA is the
    // flow's target after a confirmed catch.
    await hunterPage.getByRole('button', { name: 'Back to the map', exact: true }).click();
    await expect(hunterPage).toHaveURL(/\/room\/[^/]+\/play/);
    await forceDemoMatchEnd(hostPage, roomId);
    await hostPage.goto(`/room/${roomId}/results`);
    await expect(hostPage.getByText('MATCH OVER')).toBeVisible();
    await expect(hostPage.getByText('Runners Win!', { exact: true })).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'START A FRESH GAME' })).toBeVisible();
    await hostPage.getByRole('button', { name: 'START A FRESH GAME' }).click();
    await expect(hostPage).toHaveURL(/\/$/);
    await expect(hostPage.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
    stopKeepFresh();
    await context.close();
  });

  test('phone HUD basics: reveal, tabs, More sheet', async ({ context }) => {
    const { hostPage } = await startDemoMatch(context);
    // The reveal was dismissed by startDemoMatch; the HUD is underneath.
    await expect(hostPage.getByText('Time left')).toBeVisible();
    const nav = hostPage.getByRole('navigation', { name: 'Game' });
    await nav.getByRole('button', { name: 'Radio' }).click();
    await expect(hostPage.getByRole('heading', { name: 'Radio' })).toBeVisible();
    await nav.getByRole('button', { name: '···' }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'More' });
    await expect(sheet.getByText('Safety pause')).toBeVisible();
  });
});
