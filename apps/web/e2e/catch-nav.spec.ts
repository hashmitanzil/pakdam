/**
 * catch-nav.spec.ts — the catch flow: auto-select, name-only picker, QR
 * show/scan, manual fallback, runner confirm/dispute, host resolve, and
 * the no-catch-code rule. Demo-only. Text-only, no screenshots.
 *
 * Grounded in the built catch page (apps/web/src/app/room/[roomId]/catch):
 * - Hunter with no claim sees "Who did you tag?" + name buttons + the
 *   "I TAGGED <NAME>" action; there is no "No Runner selected" dead end.
 * - The runner confirms with "Self confirm" (no dispute — paused for now).
 * - A Classic tagged Runner is out and gets the after-tagged screen
 *   ("You were tagged" + Spectate match / Return to lobby); the Hunter
 *   keeps the "✓ Catch confirmed" card.
 * - No catch code anywhere: the token lives only inside the QR.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  GUEST_NAMES,
  HOST_NAME,
  createHostRoom,
  dismissRoleReveal,
  playerIdOf,
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

  async function claimRunner(hunterPage: Page, roomId: string, runnerName: string) {
    await hunterPage.goto(`/room/${roomId}/catch`);
    await expect(hunterPage.getByText('Who did you tag?')).toBeVisible();
    await hunterPage.getByRole('button', { name: runnerName }).click();
    await hunterPage
      .getByRole('button', { name: `I TAGGED ${runnerName.toUpperCase()}` })
      .click();
    // Claiming opens the QR scanner first (claim → scan is the built flow:
    // handleScan needs an open claim). Cancel the scanner to land on the
    // claim-open card — the manual-confirm hub the rest of this spec uses.
    await expect(hunterPage.getByText(`${runnerName} · Tag them?`)).toBeVisible();
    await hunterPage.getByRole('button', { name: 'Cancel' }).click();
    await expect(hunterPage.getByText(`Claim open — ${runnerName}`)).toBeVisible();
  }

  test('hunter with no claim gets the name-only picker, never a dead end', async ({
    context,
  }) => {
    const { hunterPage, roomId, hunterName, runnerName, otherRunnerName } = await setupCatch(context);
    await hunterPage.goto(`/room/${roomId}/catch`);
    await expect(hunterPage.getByRole('heading', { name: 'Catch' })).toBeVisible();
    await expect(hunterPage.getByText('Who did you tag?')).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: runnerName })).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: otherRunnerName })).toBeVisible();
    // The hunter never appears in their own picker.
    await expect(hunterPage.getByRole('button', { name: hunterName, exact: true })).toBeHidden();
    await expect(hunterPage.getByText('No Runner selected')).toBeHidden();
    await expect(hunterPage.getByRole('button', { name: 'Pick a name first' })).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: 'Pick a name first' })).toBeDisabled();
  });

  test('pick a name → I TAGGED → claim-open card, no QR needed', async ({ context }) => {
    const { hunterPage, roomId, runnerName } = await setupCatch(context);
    await claimRunner(hunterPage, roomId, runnerName);
    await expect(
      hunterPage.getByText('The Runner confirms on their phone — no QR needed.'),
    ).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: 'Scan their QR' })).toBeVisible();
  });

  test('scanner view: tag line, hint, manual-fallback link, camera error in headless', async ({
    context,
  }) => {
    const { hunterPage, roomId, runnerName } = await setupCatch(context);
    await claimRunner(hunterPage, roomId, runnerName);
    await hunterPage.getByRole('button', { name: 'Scan their QR' }).click();
    await expect(hunterPage.getByText(`${runnerName} · Tag them?`)).toBeVisible();
    await expect(hunterPage.getByText("Point at the runner's QR")).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: "Runner can't show a QR?" })).toBeVisible();
    // Headless Chromium has no camera, so the scanner reports it plainly.
    await expect(
      hunterPage.getByText('Camera unavailable — use the manual fallback below.'),
    ).toBeVisible();
    await hunterPage.getByRole('button', { name: 'Cancel' }).click();
    await expect(hunterPage.getByText(`Claim open — ${runnerName}`)).toBeVisible();
  });

  test("manual fallback returns to the claim card — the runner confirms on their phone", async ({
    context,
  }) => {
    const { hunterPage, roomId, runnerName } = await setupCatch(context);
    await claimRunner(hunterPage, roomId, runnerName);
    await hunterPage.getByRole('button', { name: 'Scan their QR' }).click();
    await hunterPage.getByRole('button', { name: "Runner can't show a QR?" }).click();
    await expect(hunterPage.getByText(`Claim open — ${runnerName}`)).toBeVisible();
    await expect(
      hunterPage.getByText('The Runner confirms on their phone — no QR needed.'),
    ).toBeVisible();
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

  test('?runner= auto-selects that runner in the picker', async ({ context }) => {
    const { hunterPage, roomId, runnerName } = await setupCatch(context);
    const runnerId = await playerIdOf(hunterPage, roomId, runnerName);
    expect(runnerId).not.toBeNull();
    await hunterPage.goto(`/room/${roomId}/catch?runner=${runnerId}`);
    await expect(hunterPage.getByText('Who did you tag?')).toBeVisible();
    await expect(
      hunterPage.getByRole('button', { name: `I TAGGED ${runnerName.toUpperCase()}` }),
    ).toBeEnabled();
  });

  test('?scan=1 with no open claim shows the name picker, not a dead end', async ({
    context,
  }) => {
    // Fixed: /catch?scan=1 with no claim open renders the picker, so the
    // hunter can pick a name → claim → scan from this entry point.
    const { hunterPage, roomId, runnerName } = await setupCatch(context);
    await hunterPage.goto(`/room/${roomId}/catch?scan=1`);
    await expect(hunterPage.getByText('Waiting for the claim…')).toBeHidden();
    await expect(hunterPage.getByText('Who did you tag?')).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: runnerName })).toBeVisible();
  });

  test('runner with no claim sees the empty state, not a confirm screen', async ({
    context,
  }) => {
    const { runnerPage, roomId } = await setupCatch(context);
    await runnerPage.goto(`/room/${roomId}/catch`);
    await expect(runnerPage.getByText('No one has claimed a tag on you yet.')).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Self confirm' })).toBeHidden();
  });

  test('runner confirms a claim: Self confirm → after-tagged screen on the runner, Catch confirmed on the hunter', async ({ context }) => {
    const { hunterPage, runnerPage, roomId, hunterName, runnerName } = await setupCatch(context);
    await claimRunner(hunterPage, roomId, runnerName);
    await runnerPage.goto(`/room/${roomId}/catch`);
    await expect(runnerPage.getByText(`You were tagged by ${hunterName}?`)).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Self confirm' })).toBeVisible();
    await runnerPage.getByRole('button', { name: 'Self confirm' }).click();
    // Classic: the tagged Runner is out — they get the after-tagged screen,
    // not the hunter's "Catch confirmed" card.
    await expect(runnerPage.getByText('You were tagged')).toBeVisible();
    await expect(runnerPage.getByText(`You were tagged by ${hunterName}.`)).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Spectate match' })).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Return to lobby' })).toBeVisible();
    await expect(runnerPage.getByText('✓ Catch confirmed')).toBeHidden();
    await expect(hunterPage.getByText('✓ Catch confirmed')).toBeVisible({ timeout: 15000 });
    await expect(hunterPage.getByText(`${runnerName} was tagged by ${hunterName}.`)).toBeVisible();
    await expect(hunterPage.getByRole('button', { name: 'Tag someone else' })).toBeVisible();
  });

  test('runner disputes: host sees the dispute and ALLOW TAG resolves it', async ({
    context,
  }) => {
    const { hostPage, hunterPage, runnerPage, roomId, hunterName, runnerName } =
      await setupCatch(context);
    await claimRunner(hunterPage, roomId, runnerName);
    await runnerPage.goto(`/room/${roomId}/catch`);
    await runnerPage.getByRole('button', { name: 'NO — DISPUTE' }).click();
    await expect(runnerPage.getByText('Dispute sent — the host reviews it in person.')).toBeVisible();
    await hostPage.goto(`/room/${roomId}/catch`);
    await expect(hostPage.getByText('Disputes')).toBeVisible();
    await expect(
      hostPage.getByText(`Dispute: ${hunterName} says they tagged ${runnerName}`),
    ).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'ALLOW TAG' })).toBeVisible();
    // Demo has REJECT too (demo-store `rejectCatch`, parity with live resolve).
    await expect(hostPage.getByRole('button', { name: 'REJECT TAG' })).toBeVisible();
    await hostPage.getByRole('button', { name: 'ALLOW TAG' }).click();
    await expect(hostPage.getByText('Tag allowed.')).toBeVisible();
  });

  test('runner disputes: host REJECT TAG voids the tag (demo)', async ({ context }) => {
    const { hostPage, hunterPage, runnerPage, roomId, hunterName, runnerName } =
      await setupCatch(context);
    await claimRunner(hunterPage, roomId, runnerName);
    await runnerPage.goto(`/room/${roomId}/catch`);
    await runnerPage.getByRole('button', { name: 'NO — DISPUTE' }).click();
    await expect(runnerPage.getByText('Dispute sent — the host reviews it in person.')).toBeVisible();
    await hostPage.goto(`/room/${roomId}/catch`);
    await expect(
      hostPage.getByText(`Dispute: ${hunterName} says they tagged ${runnerName}`),
    ).toBeVisible();
    await hostPage.getByRole('button', { name: 'REJECT TAG' }).click();
    await expect(hostPage.getByText('Tag rejected by the host.')).toBeVisible();
    await expect(hostPage.getByText('Disputes')).toBeHidden();
    // The runner stays free: no open claim, no confirmed tag.
    await runnerPage.goto(`/room/${roomId}/catch`);
    await expect(runnerPage.getByText('No one has claimed a tag on you yet.')).toBeVisible();
    await expect(runnerPage.getByText('✓ Catch confirmed')).toBeHidden();
  });

  test('P0-1: a suspended runner is resumed on catch-page arrival and can confirm', async ({
    context,
  }) => {
    const { hunterPage, runnerPage, roomId, runnerName } = await setupCatch(context);
    await claimRunner(hunterPage, roomId, runnerName);
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
    await expect(runnerPage.getByRole('button', { name: 'Self confirm' })).toBeEnabled();
    await runnerPage.getByRole('button', { name: 'Self confirm' }).click();
    // Classic: the tagged Runner is out — after-tagged screen, not the
    // hunter's "Catch confirmed" card.
    await expect(runnerPage.getByText('You were tagged')).toBeVisible();
    await expect(runnerPage.getByRole('button', { name: 'Spectate match' })).toBeVisible();
  });

  test('catch page before the match is live says catches count once live', async ({
    context,
  }) => {
    const page = await context.newPage();
    const { roomId } = await createHostRoom(page);
    await page.goto(`/room/${roomId}/catch`);
    await expect(page.getByText('Catches count once the match is live.')).toBeVisible();
  });
});
