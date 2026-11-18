// ESLint flat config — Pakdam monorepo (fix round, MEDIUM-3).
// Real gate: `npm run lint` runs this; CI runs it on every push/PR.
// Rules are deliberately narrow: no-unused-vars (underscore-prefixed
// intentional discards are allowed — the codebase uses them for hash
// stripping), no-explicit-any, no non-null assertion in new code is
// NOT enforced (existing code uses `!` in tests and engine code).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      // Wrangler dev/build output (generated bundles — never linted).
      'workers/.wrangler/**',
      'apps/web/public/sw.js',
      'apps/web/public/workbox-*.js',
      'apps/web/next-env.d.ts',
      // Third-party libraries vendored into public/ — never linted.
      // (MapLibre GL JS + PMTiles + basemaps, bundled with the offline
      // map in apps/web/public/offline-map/vendor/.)
      'apps/web/public/offline-map/vendor/**',
      // Scratch probe script (apps/web/probe-gps.mjs) — kept for the
      // live GPS-mock retry, not part of the app.
      'apps/web/probe-gps.mjs',
      // Regenerable tsc scratch output from the websocket-reconnect
      // test (see apps/web/src/lib/__tests__/websocket-reconnect.test.ts
      // header: "rm -rf .scratch-web-test", "Do NOT commit").
      // It regenerates wherever tsc is run from, so both locations
      // are ignored.
      '.scratch-web-test/**',
      'apps/web/.scratch-web-test/**',
    ],
  },
  {
    // k6 load scripts run in k6's JS runtime, not Node or a browser:
    // __ENV and __VU are k6 globals, and console exists there.
    files: ['workers/load/**/*.js'],
    languageOptions: {
      globals: { __ENV: 'readonly', __VU: 'readonly', console: 'readonly' },
    },
  },
  {
    // .ts files use hooks too (useLiveRoom.ts, websocket.ts both end
    // useEffect calls with an exhaustive-deps disable). Registering the
    // plugin only for tsx/jsx left those disables as build-blocking
    // "Definition for rule 'react-hooks/exhaustive-deps' was not found"
    // errors in .ts files (recovery report, 2026-11-17).
    files: ['**/*.ts', '**/*.tsx', '**/*.jsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
