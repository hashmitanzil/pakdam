// Flat ESLint config for the Pakdam monorepo.
// The fresh project vendors nothing — no vendored-file ignores are needed.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Only the two classic hooks rules: the codebase's disable directives
  // reference exhaustive-deps, and the v7 `recommended-latest` bundle
  // adds new rules (set-state-in-effect, refs, immutability, …) this tree
  // was never written to satisfy — do not enable that bundle here.
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Next.js plugin — the build warns when it is not detected. Scoped
    // to the web app only (the Worker/engine/shared packages are not
    // Next apps). `recommended` + `core-web-vitals` rule sets, applied
    // as plain rules over the flat-config plugin object.
    files: ["apps/web/**/*.{js,jsx,ts,tsx}"],
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    // Node.js test hooks + unit tests are plain `.mjs` run by `node --test`.
    // They use Node globals (`URL` in the resolve hooks, `Request` in the
    // workers rate-limit test, `Response`/`process` in the start-error
    // tests) that the default recommended config does not declare —
    // declare them here so `no-undef` does not flag them.
    files: ["**/resolve-hooks.mjs", "**/test/**/*.mjs"],
    languageOptions: {
      globals: {
        URL: "readonly",
        Request: "readonly",
        Response: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        // Fix round 4 (lint): the admin tests legitimately capture
        // `console.error` to prove a failed audit insert is logged
        // loudly (workers/test/admin-rbac.test.mjs) — `no-undef`
        // flags the identifier regardless of method, so the test-file
        // globals must declare it. The v33 base passed lint without
        // this line only because no test there used `console` at all.
        console: "readonly",
      },
    },
  },
  {
    // Generated, not source: `next build` writes next-env.d.ts, and the
    // Serwist build writes public/sw.js (the bundled service worker).
    // `wrangler dev` writes bundled output under workers/.wrangler/tmp —
    // linting it fails on Worker globals and must not fail `pnpm lint`
    // while a dev server runs.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/build/**",
      "**/.wrangler/**",
      "**/next-env.d.ts",
      "**/public/sw.js",
    ],
  },
  {
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // The codebase marks intentionally-unused bindings with a leading
      // underscore (destructured-out hashes, unused callback params).
      // Those are deliberate; only a non-underscore unused binding errors.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
);
