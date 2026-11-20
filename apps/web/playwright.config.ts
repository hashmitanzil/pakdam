import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the Pakdam PWA (pakdam-fresh).
 *
 * The suite is text-only: no screenshots, no video, no trace (see
 * e2e/README.md).
 *
 * The suite runs against the PRODUCTION build (`next start`), NOT the dev
 * server. Next.js dev mode uses eval() for source maps / fast refresh,
 * which violates this app's CSP (`script-src 'self' 'unsafe-inline'`, no
 * 'unsafe-eval') and floods every page with page errors — that was the
 * smoke.spec.ts:86/:90 failure, a dev-mode artifact, not an app bug.
 * Production Next.js never evals, so the violation disappears with NO CSP
 * weakening (the production CSP is untouched).
 *
 * The server command builds first only when no `.next` exists yet, so a
 * clean checkout still runs with one command; CI builds explicitly before
 * the test leg (see .github/workflows/ci.yml) and the existing build is
 * reused. NEXT_PUBLIC_* values are baked at BUILD time, so demo/live mode
 * and the Ola key are decided by the build's environment, not the test
 * process's — keep them in sync (see e2e/README.md).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: 'sh -c \'test -d .next || pnpm run build; exec pnpm run start\'',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 180000,
  },
});
