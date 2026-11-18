# Sentry — error monitoring (free allowance)

Status: **WIRED 2026-11-17 (tooling worker).** `@sentry/nextjs`
**10.78.0** is installed (`apps/web/package.json`), the three
`sentry.*.config.ts` files exist in `apps/web/` (pasted exactly from
§3 below), and `apps/web/next.config.ts` is wrapped with
`withSentryConfig` OUTSIDE the Serwist wrap. The DSN guard means the
wiring is inert until `NEXT_PUBLIC_SENTRY_DSN` is set — with no DSN,
Sentry never initialises and errors stay local. What is still missing:
the DSN itself (the founder creates it, §1) and the §6 verification
(test error in Sentry, no PII in the event). No source-map upload
(no auth token — a later decision).

## 1. Founder: create the Sentry project (no key is invented here)

1. Go to [sentry.io](https://sentry.io) and create a free account
   (the free allowance is what the founder approved — no paid plan).
2. Create a project: platform **Next.js**.
3. Copy the **DSN** from the project settings (it looks like
   `https://<public-key>@o<org>.ingest.sentry.io/<project-id>`).
   The DSN is a public identifier, not a secret — but it is still
   never committed to the repo. It goes in Vercel env (below) and in
   `.env.local` for local runs (never committed).
4. Paste the DSN as the Vercel env var `NEXT_PUBLIC_SENTRY_DSN`
   (build-time, public). Do NOT set it anywhere else in the repo.

## 2. Install the package — DONE 2026-11-17 (do not re-run)

```bash
cd pakdam-app
pnpm --filter pakdam-web add @sentry/nextjs
```

`@sentry/nextjs` **10.78.0** is installed (`apps/web/package.json`);
the §2 install step is done. The command above is kept for the
record only — it updates `pnpm-lock.yaml` (commit it in the same
step if it is ever re-run; there is no `package-lock.json` in this
repo). Do NOT pin a version by hand: install whatever is compatible
with the repo's Next.js 15.5 and record the installed version here
once it lands.

Preferred alternative: `pnpm dlx @sentry/wizard@latest -i nextjs` — the
wizard installs the package, writes the three config files, and
wraps `next.config.ts` for you. If you use the wizard, check its
diff against the manual files below before committing: the wizard
must NOT enable performance tracing (see §4) and must NOT add any
custom context.

## 3. Config files (paste exactly — only after step 2)

### `apps/web/sentry.client.config.ts`

```ts
// Sentry — browser errors only. The DSN guard means the file is
// inert until NEXT_PUBLIC_SENTRY_DSN is set; with no DSN, Sentry
// never initialises and errors stay local.
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    // Error monitoring only: no performance tracing, so the free
    // allowance is spent on errors, not on transaction volume.
    tracesSampleRate: 0,
    // Never send personally identifiable information by default.
    sendDefaultPii: false,
  });
}
```

### `apps/web/sentry.server.config.ts`

```ts
// Sentry — server errors only. Same DSN guard and same rules as the
// client config: error monitoring only, no PII.
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}
```

### `apps/web/sentry.edge.config.ts`

```ts
// Sentry — edge runtime (middleware) errors only. Same DSN guard
// and same rules as the client config.
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}
```

## 4. Wrap `next.config.ts` (only after step 2)

`apps/web/next.config.ts` already wraps the config with Serwist
(`withSerwistConfig`). Sentry goes OUTSIDE that wrap — do not
replace the Serwist wrap:

```ts
// @sentry/nextjs/config — the '@sentry/nextjs' entrypoint for
// withSentryConfig is DEPRECATED in Sentry 10 and stops working in
// v11 (build warning, 2026-11-17). Always import from the /config
// entrypoint.
import { withSentryConfig } from '@sentry/nextjs/config';
// ... existing imports and nextConfig unchanged ...

export default withSentryConfig(withSerwistConfig(nextConfig), {
  // For all available options, see the @sentry/nextjs docs.
  // No source-map upload is configured here: the build does not
  // upload source maps to Sentry (no auth token exists), so stack
  // traces arrive minified. Uploading source maps is a separate,
  // later decision — it needs a Sentry auth token, which is a
  // credential and must never be committed.
  silent: true,
});
```

Build warnings recorded 2026-11-17 (advisory, build still passes):
Sentry 10 also warns that `sentry.server.config.ts` /
`sentry.edge.config.ts` should move into an `instrumentation.ts`
`register()` function, and that no `global-error.js` exists. Those
are NOT acted on here: this document prescribes the three config
files, the build passes with them (26 pages), and migrating server /
edge init to `instrumentation.ts` is a separate later decision for
the founder — it changes the wiring this document defines.

## 5. Privacy rules (hard — do not relax without a founder decision)

- **Never attach coordinates, player display names, room codes,
  room IDs, or reconnect tokens to a Sentry event.** The DSN guard
  and `sendDefaultPii: false` are the defaults; no `Sentry.setUser`,
  `setContext`, or `setTag` call in the app may carry any of those
  values. A stack trace + route + error message is enough to debug.
- **No performance tracing** (`tracesSampleRate: 0`) — error
  monitoring only, inside the free allowance.
- The Worker (Cloudflare) is NOT covered by this setup. Sentry for
  the Worker/DO is a separate decision (the `@sentry/cloudflare`
  package) and is NOT part of this document.

## 6. Verify (after steps 1–4)

1. `pnpm --filter pakdam-web run build` — must pass with the DSN
   set and with it unset.
2. Trigger a test error in a local dev run and confirm it appears
   in the Sentry dashboard for the project created in §1 — and that
   the event carries no player name, room code, or coordinates.
3. Confirm the production build on Vercel reports errors to the
   same project (Vercel env var set in §1, step 4).

## What is NOT done yet

- Package installed (`@sentry/nextjs` 10.78.0, `apps/web/package.json`)
  — the §2 install step is done; do not re-run it.
- Config files are in the repo (`apps/web/sentry.client.config.ts`,
  `sentry.server.config.ts`, `sentry.edge.config.ts`).
- `next.config.ts` IS wrapped (`withSentryConfig` outside the Serwist
  wrap, `apps/web/next.config.ts`).
- No DSN exists (the founder creates it in §1).
- No source-map upload (needs an auth token — a later decision).
