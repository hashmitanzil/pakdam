/**
 * error-boundary.spec.ts — Reliability Gap 3 (v29): the ErrorBoundary
 * fallbacks + the one bug report.
 *
 * Demo-only. Text-only: DOM text and roles, no screenshots.
 *
 * The play page renders a test-only throwing component inside the map
 * boundary when `?errorBoundaryTest=map` is set (see
 * `src/components/ErrorBoundaryThrowTest.tsx` — never rendered in
 * normal use). The boundary must show the plain-words fallback, keep
 * the rest of the HUD alive, and report ONCE to POST /v1/support/bugs
 * with a description and NO location (no lat/lng keys anywhere).
 *
 * In demo mode there is no Worker URL, so the boundary would skip
 * reporting entirely — the spec sets the test-only override
 * `window.__pakdamTestWorkerUrl` via `addInitScript` (see
 * `src/components/ErrorBoundary.tsx`) so the mocked POST can be
 * observed. The override never exists in production.
 *
 * The override MUST be same-origin (`window.location.origin`): the
 * app's CSP `connect-src` allow-lists only 'self', the real Worker
 * origin and the Ola origins (next.config.ts), so a report to a
 * non-allowlisted origin is blocked by CSP in the browser and the
 * mocked route never sees it — that was the v31 failure
 * (`reportArrived` timed out while the fallback itself rendered
 * fine). Same-origin stays inside `connect-src 'self'`, so the
 * report flows through the real reporting code under the real
 * CSP, and the Playwright route still intercepts it before it
 * reaches the Next.js server.
 *
 * Do NOT run `playwright test` in the sandbox VM (Chromium cannot
 * launch there); CI is the verdict.
 */
import { test, expect } from '@playwright/test';
import {
  LIVE,
  startDemoMatch,
} from './helpers';

test.describe('error boundary (demo)', () => {
  test.skip(LIVE, 'demo-only spec — run without NEXT_PUBLIC_WORKER_URL');

  test('a map crash shows the plain-words fallback, keeps the HUD alive, and reports once with no location', async ({
    context,
  }) => {
    const { hostPage, roomId } = await startDemoMatch(context, { roundShort: false });
    const page = hostPage;
    await page.bringToFront();

    // The mocked bug-report endpoint + the test-only Worker URL
    // override, both BEFORE the navigation that triggers the throw.
    const reported: Array<Record<string, unknown>> = [];
    await page.route('**/v1/support/bugs', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      reported.push(body);
      await route.fulfill({ status: 200, body: '{}' });
    });
    await page.addInitScript(() => {
      // Same-origin on purpose: the app's CSP connect-src allow-lists
      // only 'self' + the real Worker / Ola origins, so a report to
      // any other origin is CSP-blocked and this route never fires.
      (window as unknown as { __pakdamTestWorkerUrl?: string }).__pakdamTestWorkerUrl =
        window.location.origin;
    });

    const reportArrived = page.waitForRequest('**/v1/support/bugs', { timeout: 10000 });
    await page.goto(`/room/${roomId}/play?errorBoundaryTest=map`);
    // The reveal is once-per-role per sessionStorage, so the reload
    // does not show it again — but dismiss it fast if it ever does
    // (a role flip re-shows it), so it never covers the fallback.
    const letsGo = page.getByRole('button', { name: "Let's go", exact: true });
    if ((await letsGo.count()) > 0) {
      await letsGo.click({ timeout: 5000 }).catch(() => undefined);
    }

    // The fallback: plain words, a Retry, and a Reload game button —
    // and NO raw stack trace anywhere on the screen.
    await expect(page.getByText('The map failed to load.')).toBeVisible();
    await expect(page.getByText('The game is still running — only the map crashed.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload game', exact: true })).toBeVisible();
    await expect(page.getByText('ErrorBoundary')).toHaveCount(0);

    // The rest of the HUD survived the crash: the status strip (outside
    // the boundary) still shows the countdown.
    await expect(page.getByText('Time left')).toBeVisible();

    // The one bug report: description present, no location anywhere.
    await reportArrived;
    await expect
      .poll(() => reported.length, { timeout: 5000 })
      .toBe(1);
    const body = reported[0] as Record<string, unknown>;
    const description = body['description'];
    expect(typeof description === 'string' && description.length > 0).toBe(true);
    expect(description as string).toContain('ErrorBoundary[map]');
    expect(body).not.toHaveProperty('lat');
    expect(body).not.toHaveProperty('lng');
    expect(body).not.toHaveProperty('latitude');
    expect(body).not.toHaveProperty('longitude');
    expect(body).not.toHaveProperty('coordinates');
    expect(JSON.stringify(body)).not.toContain('"lat"');
    expect(JSON.stringify(body)).not.toContain('"lng"');
    expect(body['roomId']).toBe(roomId);
  });
});
