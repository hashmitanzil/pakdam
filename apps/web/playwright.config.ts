// Playwright — TEXT/DOM assertions only, no screenshots (gateway rule).
// Runs against the production build (`npm run build` first, then
// `npm run test:e2e`). The webServer starts `next start` on port 3105
// and reuses an already-running server if one exists.
//
// Projects (responsive matrix — the same specs run at every width):
// - desktop: 1280x720, the full suite.
// - tablet: 768x1024 — layout specs only (responsive, no-Forge,
//   mobile-layout, host-setup); the heavy game loops run on desktop
//   and phone-portrait instead, to keep the suite fast.
// - phone-360-portrait: 360x800, touch, isMobile — the full suite.
// - phone-360-landscape: 800x360, touch, isMobile — layout specs
//   (responsive, no-Forge, host-setup).
// - mobile-zoom130: 277px layout viewport, the 130%-zoom equivalent
//   for a 360px phone (360 / 1.3 = 277 CSS px). Playwright has no
//   text-zoom emulation, so the zoom check is the layout width a
//   130%-zoomed 360px phone actually lays out at. Layout specs only.
// - brutal-phone: 390x844, touch, isMobile — the brutal end-to-end
//   phone test (brutal-phone.spec.ts) plus the map-tiles spec
//   (map-tiles.spec.ts: tile painting, YOU marker, denied state,
//   numbered-marker absence, phone-width clipping).
import { defineConfig } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3105';

const LAYOUT_SPECS = ['**/responsive.spec.ts', '**/no-forge-office.spec.ts', '**/host-setup.spec.ts'];
const LAYOUT_SPECS_WITH_PLAY = [...LAYOUT_SPECS, '**/mobile-layout.spec.ts'];
// The brutal spec is 390px-specific; it must not run on desktop or
// 360px (its own contexts already cover the desktop comparison).
const NOT_BRUTAL = ['**/brutal-phone.spec.ts'];

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  workers: 2,
  projects: [
    {
      name: 'desktop',
      testIgnore: NOT_BRUTAL,
      use: { baseURL, viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'tablet',
      testMatch: LAYOUT_SPECS_WITH_PLAY,
      use: { baseURL, viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'phone-360-portrait',
      testIgnore: NOT_BRUTAL,
      use: {
        baseURL,
        viewport: { width: 360, height: 800 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'phone-360-landscape',
      testMatch: LAYOUT_SPECS,
      use: {
        baseURL,
        viewport: { width: 800, height: 360 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'brutal-phone',
      testMatch: ['**/brutal-phone.spec.ts', '**/map-tiles.spec.ts'],
      use: {
        baseURL,
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'mobile-zoom130',
      testMatch: LAYOUT_SPECS_WITH_PLAY,
      use: {
        baseURL,
        viewport: { width: 277, height: 640 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: {
    command: 'npm run start -- -p 3105',
    port: 3105,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
