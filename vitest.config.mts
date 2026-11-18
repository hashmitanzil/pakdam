import { defineConfig } from 'vitest/config';

/**
 * Vitest — unit/integration tests (installed 2026-11-17, vitest@5.1.0,
 * root devDependency). This does NOT replace the existing `node --test`
 * suites: `packages/engine/test/*.test.ts` and `workers/test/*.test.ts`
 * still compile to `dist/test/*.test.js` and still run with
 * `node --test` (root `npm test`). Vitest tests live ONLY in `vitest/`
 * at the repo root — deliberately outside every `tsconfig.json`
 * `include` (engine/workers include `src` + `test` only), so `tsc`
 * never emits them into `dist/test/` and `node --test` never sees a
 * `vitest` import it cannot load.
 *
 * Run: `npm run test:vitest` (root). Both suites:
 *   `npm test`          — node --test (engine + workers, dist builds)
 *   `npm run test:vitest` — vitest (vitest/ only, TS source directly).
 *   The web lib tests (`apps/web/src/lib/__tests__/`, `node:test`
 *   style) are NOT run by Vitest: Vitest 5.1.0 does not collect
 *   `node:test` files — proven 2026-11-17 with a minimal probe file,
 *   with and without this config, default and named imports
 *   ("No test suite found in file", "Tests: no tests"), and no
 *   node:test shim exists in the installed vitest dist. Adding the
 *   glob to `test.include` was tried and reverted the same day: it
 *   turned `test:vitest` red (3 failed suites) without executing a
 *   single test. The web suites run instead under plain `node --test`
 *   via `npm run test:web` (scripts/test-web-lib.sh — tsc to scratch,
 *   see the test files' own header).
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@pakdam/shared', replacement: new URL('./packages/shared/src/index.ts', import.meta.url).pathname },
      { find: '@pakdam/engine', replacement: new URL('./packages/engine/src/index.ts', import.meta.url).pathname },
    ],
  },
  test: {
    environment: 'node',
    include: ['vitest/**/*.test.ts'],
  },
});
