/**
 * welcome-screen.spec.ts — the launch / loading screen on the home page.
 *
 * Founder reference (ShadowHunt): the loader shows on EVERY reload and
 * lasts ~1 s. Pakdam's version is richer (the lockup split into three
 * staged crops — pin, wordmark, tagline — plus a single "Loading game"
 * line) but follows the same two rules: it appears on every home
 * mount / reload, and the normal path is ~1 s (2.5 s hard cap, never
 * blocks). There is no loading bar and no per-step lines: the
 * background work (map prefetch, GPS warm-up, connection check) still
 * runs and still gates the fade, it is just not shown any more.
 *
 * Text-only: DOM text, roles and element state, no screenshots.
 * Runs in demo AND live mode — it only touches the home page, and the
 * connection check resolves immediately in demo mode (no Worker URL).
 * Timing: the fade starts at max(all background work settled, the
 * ~1 s staging gate) and the screen is gone by ~1.4 s on the normal path.
 */
import { test, expect } from '@playwright/test';
import { collectPageErrors, dismissOnboardingIfShown, expectNoHorizontalOverflow, expectNoPageErrors } from './helpers';

const WELCOME = '[data-testid="welcome-screen"]';
const PIN_ALT = 'Pakdam pin art — a red location pin with a boy hiding behind a tree';
const WORDMARK_ALT = 'Pakdam wordmark';
const TAGLINE_ALT = 'Hide. Seek. Catch.';

test.describe('welcome screen', () => {
  test('appears on home load with the splash art, wordmark, tagline and loading text', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator(WELCOME)).toBeVisible();
    // Staged lockup: three separate crops of the one lockup image —
    // pin art, wordmark, tagline — each asserted by its own alt text.
    await expect(page.getByAltText(PIN_ALT)).toBeVisible();
    await expect(page.locator(WELCOME).getByAltText(WORDMARK_ALT)).toBeVisible();
    await expect(page.getByAltText(TAGLINE_ALT)).toBeVisible();
    // The brand art must actually load, not just occupy an <img> tag:
    // a missing asset would leave naturalWidth at 0 (and a broken
    // glyph). Poll, because toBeVisible does not wait for the decode.
    for (const alt of [PIN_ALT, WORDMARK_ALT, TAGLINE_ALT]) {
      await expect
        .poll(() =>
          page
            .getByAltText(alt)
            .evaluate((el) => (el as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
    }
    // A single "Loading game" line replaces the old loading bar and
    // the three step lines: the background work still runs, it is
    // just not shown any more.
    await expect(page.getByTestId('welcome-loading-text')).toBeVisible();
    await expect(page.getByTestId('welcome-loading-text')).toHaveText('Loading game');
    // The old UI is gone: no step lines and no step testids anywhere
    // on the page.
    await expect(page.getByText('Preparing the map')).toHaveCount(0);
    await expect(page.getByText('Warming up GPS')).toHaveCount(0);
    await expect(page.getByText('Checking connection')).toHaveCount(0);
    await expect(page.locator('[data-testid^="welcome-step-"]')).toHaveCount(0);
  });

  test('fades and unmounts quickly, and the home buttons become reachable', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');
    await expect(page.locator(WELCOME)).toBeVisible();
    // Wall-clock bound starts AFTER goto resolves, so navigation +
    // hydration are not charged against it: the bound covers the
    // ~1 s staging gate + 400 ms fade only. (It used to start before
    // goto, leaving ~2.1 s margin on cold CI.)
    const started = Date.now();
    // The background work (map prefetch, GPS warm-up, connection
    // check) still gates the fade — the fade starts at max(all
    // settled, the ~1 s staging gate) — but nothing about it is shown
    // on screen any more: no step lines to watch flip to done.
    // Normal path is ~1 s (staging gate, 400 ms fade); the 2.5 s cap
    // is the ceiling. 5 s here is a generous CI bound, not the target.
    await expect(page.locator(WELCOME)).toBeHidden({ timeout: 10000 });
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(5000);
    // Home header carries the same lockup wordmark as its logo — and
    // it must have loaded too, not just rendered an <img> tag.
    await expect(page.getByAltText('Pakdam')).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByAltText('Pakdam')
          .evaluate((el) => (el as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /JOIN A GAME/ })).toBeVisible();
    // Scope C item 1: the onboarding cards auto-show once the welcome
    // screen is gone — Skip them before the home button is clickable.
    await dismissOnboardingIfShown(page);
    await page.getByRole('button', { name: /JOIN A GAME/ }).click();
    await expect(page.getByRole('heading', { name: 'Join a game' })).toBeVisible();
    expectNoPageErrors(errors);
  });

  test('appears again on a page reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator(WELCOME)).toBeHidden({ timeout: 10000 });
    await page.reload();
    await expect(page.locator(WELCOME)).toBeVisible();
    await expect(page.locator(WELCOME)).toBeHidden({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
  });

  test('appears again when navigating back to home from inside the app', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator(WELCOME)).toBeHidden({ timeout: 10000 });
    await dismissOnboardingIfShown(page);
    await page.getByRole('button', { name: /JOIN A GAME/ }).click();
    await expect(page.getByRole('heading', { name: 'Join a game' })).toBeVisible();
    await page.goBack();
    await expect(page.locator(WELCOME)).toBeVisible();
    await expect(page.locator(WELCOME)).toBeHidden({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
  });

  test('wordmark stays on one line at 320px — welcome + header, no overflow', async ({
    page,
  }) => {
    // Narrowest phone width: the wordmark is a single image, so "one
    // line" means its whole box sits inside the viewport with no
    // horizontal overflow — measured, not eyeballed.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    const wordmark = page.locator(WELCOME).getByAltText(WORDMARK_ALT);
    await expect(wordmark).toBeVisible();
    const box = await wordmark.boundingBox();
    expect(box, 'welcome wordmark should have a box').not.toBeNull();
    expect(box!.x, 'wordmark left edge inside viewport').toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, 'wordmark right edge inside 320px viewport').toBeLessThanOrEqual(320);
    // The right-edge check alone would still pass for an unconstrained
    // 280 px wordmark centred in 320 px, so also pin the 72vw cap:
    // at 320 px the box must be <= ~72vw (230.4 px, 232 allows rounding).
    expect(box!.width, 'welcome wordmark width within 72vw at 320px').toBeLessThanOrEqual(232);
    // The "Loading game" line is short centred text: pin its box
    // directly, not just via the page-level overflow check — it must
    // sit inside the 320 px viewport and stay a single short line
    // (~100 px at 15 px type; 160 allows font-rendering slack).
    const loadingText = page.getByTestId('welcome-loading-text');
    await expect(loadingText).toBeVisible();
    const loadingBox = await loadingText.boundingBox();
    expect(loadingBox, '"Loading game" should have a box').not.toBeNull();
    expect(loadingBox!.x, '"Loading game" left edge inside viewport').toBeGreaterThanOrEqual(0);
    expect(
      loadingBox!.x + loadingBox!.width,
      '"Loading game" right edge inside 320px viewport',
    ).toBeLessThanOrEqual(320);
    expect(loadingBox!.width, '"Loading game" width sane at 320px').toBeLessThanOrEqual(160);
    await expectNoHorizontalOverflow(page);
    await expect(page.locator(WELCOME)).toBeHidden({ timeout: 10000 });
    // Header logo: same wordmark crop, same one-line requirement.
    const header = page.getByAltText('Pakdam');
    await expect(header).toBeVisible();
    const headerBox = await header.boundingBox();
    expect(headerBox, 'header wordmark should have a box').not.toBeNull();
    expect(headerBox!.x, 'header logo left edge inside viewport').toBeGreaterThanOrEqual(0);
    expect(
      headerBox!.x + headerBox!.width,
      'header logo right edge inside 320px viewport',
    ).toBeLessThanOrEqual(320);
    await expectNoHorizontalOverflow(page);
  });

  test('under reduced motion the logo is static and home still becomes reachable', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator(WELCOME)).toBeVisible();
    await expect(page.getByAltText(PIN_ALT)).toBeVisible();
    // "Static logo" is asserted, not just claimed: no drop/rise
    // animation classes on any of the three staged images, and the
    // ping-ring spans are not rendered at all under reduced motion.
    await expect(page.getByAltText(PIN_ALT)).not.toHaveClass(/pakdam-welcome-drop/);
    await expect(page.locator(WELCOME).getByAltText(WORDMARK_ALT)).not.toHaveClass(
      /pakdam-welcome-rise/,
    );
    await expect(page.getByAltText(TAGLINE_ALT)).not.toHaveClass(/pakdam-welcome-rise/);
    await expect(page.locator(WELCOME).locator('.pakdam-anim-ring')).toHaveCount(0);
    // The "Loading game" line pulses via `motion-safe:animate-pulse`,
    // so under reduced motion the pulse must be off. A class check
    // would not prove that — Tailwind gates the utility behind the
    // media query — so assert the computed style directly: the
    // animation-name must be `none`.
    const loadingText = page.getByTestId('welcome-loading-text');
    await expect(loadingText).toBeVisible();
    const animationName = await loadingText.evaluate(
      (el) => getComputedStyle(el).animationName,
    );
    expect(animationName, '"Loading game" must not pulse under reduced motion').toBe('none');
    await expect(page.locator(WELCOME)).toBeHidden({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /HOST A GAME/ })).toBeVisible();
  });
});
