import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the Pakdam PWA (pakdam-fresh).
 *
 * The suite is text-only: no screenshots, no video, no trace (see
 * e2e/README.md). The dev server is started automatically unless one is
 * already running on port 3000; it inherits the shell environment, so
 * NEXT_PUBLIC_WORKER_URL / NEXT_PUBLIC_OLA_MAPS_API_KEY must be set
 * before the server starts for the live / with-key specs.
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
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120000,
  },
});
