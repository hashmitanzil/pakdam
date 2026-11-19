// Flat ESLint config for the Pakdam monorepo.
// The fresh project vendors nothing — no vendored-file ignores are needed.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

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
    // Generated, not source: `next build` writes next-env.d.ts, and the
    // Serwist build writes public/sw.js (the bundled service worker).
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/build/**",
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
