# Pakdam CI — what runs, what it proves, what it does not prove

Workflow: `.github/workflows/ci.yml` — runs on every push and every
pull request, on a clean GitHub-hosted `ubuntu-latest` runner.

## What the founder has to do

Nothing, once the code is on GitHub. The workflow runs automatically
on every push. Open the repo on GitHub → **Actions** tab → the latest
`ci` run → green check or red cross, per step. No account, key, or
secret is needed for CI: the build uses the placeholder site URL
escape (`PAKDAM_ALLOW_PLACEHOLDER_URL=1`, dev/CI-only) and no live
services.

## What the workflow runs, in order

| Step | Command | What it checks |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | Dependencies install exactly from `pnpm-lock.yaml`. Fails fast if the lockfile is out of sync with any `package.json` — fix locally with `pnpm install` and commit the regenerated lockfile. |
| Lint | `pnpm run lint` | ESLint over the whole repo (root `eslint.config.mjs`). |
| Typecheck | `pnpm run typecheck` | `tsc --noEmit` in all 4 workspaces: `packages/shared`, `packages/engine`, `workers`, `apps/web`. |
| Unit tests | `pnpm test` | Builds `shared`/`engine`/`workers`, then runs engine + workers unit tests (`node --test` on their `dist/test` suites). |
| Vitest tests | `pnpm run test:vitest` | Engine smoke + worker validation suites under `vitest/` (TS source, run by Vitest). |
| Web lib tests | `pnpm run test:web` | Web lib suites under `apps/web/src/lib/__tests__/` via `scripts/test-web-lib.sh` (tsc to scratch, then `node --test`). |
| Production build | `pnpm run build` | Builds all 4 workspaces including `next build` for the web app. This is the step the dev VM cannot do (EPERM on child-process writes) — a green run here is the only "production build passes" evidence that counts. |
| Playwright browsers | `pnpm --filter pakdam-web exec playwright install --with-deps chromium` | Installs headless Chromium + OS deps in `apps/web`. Only Chromium is used by the config. |
| E2E suite | `pnpm --filter pakdam-web exec playwright test --workers=1 --reporter=json` (from `apps/web/`, see below) | 63 test definitions in 13 spec files under `apps/web/e2e/`, 173 executions across 6 projects (desktop 59, tablet 16, phone-360-portrait 59, phone-360-landscape 11, brutal-phone 12, mobile-zoom130 16; the zoom130 test in `mobile-layout.spec.ts` is skipped on the three non-277px projects that run it, so a green run is 170 passed + 3 skipped). Counted from the spec files 2026-11-18: 63 `test('…')` definitions — a naive `grep -c "test("` returns 74 because 11 regex `.test(` calls are not test definitions. Against the production build on `http://localhost:3105`. TEXT/DOM assertions only, no screenshots. Geolocation is mocked by Playwright contexts. On failure, `apps/web/test-results` and `apps/web/playwright-report.json` are uploaded as artefacts (7 days). |

## The e2e step runs sequentially, with pre-flight gates

The e2e step in `.github/workflows/ci.yml` follows the sequential
runbook from Meera re-review #2 §3.3 — it exists because a concurrent
`next build` corrupting `.next` mid-run once failed 15 unrelated
tests at once (every chunk HTTP 400, zero client JS):

- **One production build, once.** The build step records
  `BUILD_ID_BEFORE`. No other build runs after it. The workflow's
  `concurrency` group (`ci-${{ github.ref }}`, cancel-in-progress)
  is what stops a second run building over this one.
- **G-1: the e2e step sets `PAKDAM_ALLOW_PLACEHOLDER_URL=1`.** The
  build step's env does not carry to later steps; without it
  `next start` refuses to boot (`next.config.ts` placeholder guard)
  and the whole e2e run would be 0/x.
- **Pre-flight gates (fail the job before the suite):** kill
  anything on port 3105; start the server explicitly (`next start
  -p 3105`) so a boot failure is visible; readiness loop on
  `http://localhost:3105/` (120 s); `BUILD_ID` stability check
  against `BUILD_ID_BEFORE`; chunk-200 gate (every
  `.next/static/chunks/*.js` must return HTTP 200 as
  `/_next/static/chunks/<name>`); one offline-tile spot-check
  (`/offline-map/tiles/16/48301/28392.jpg` → 200).
- **One invocation, full matrix:** `playwright test --workers=1
  --reporter=json` from `apps/web/`, all 6 projects in config order.
  Do NOT split per-project and do NOT use `--project` subsets for
  the green run. Step `timeout-minutes: 45` (budget ~25–35 min).
- **After the run (always):** `BUILD_ID` is re-checked (a change
  invalidates the run — re-run from the build step), the server is
  stopped, and port 3105 is confirmed down.

## What a green run proves

- The repo installs cleanly from its lockfile on a fresh machine.
- TypeScript compiles with no errors in every workspace.
- Lint is clean.
- Engine + workers unit tests pass.
- The production build succeeds (including the Serwist service-worker build).
- The full Playwright suite passes against that production build:
  lobby, host setup, live HUD, catch/results, outside-zone, session
  restore, responsive layout, 130%-zoom layout, and the offline-map
  tile/denied-state checks.

## What a green run does NOT prove

- **Real GPS accuracy.** CI geolocation is mocked. Real outdoor GPS
  on a phone is a founder field check, not a CI check.
- **Live multiplayer across devices.** CI plays the demo loop on one
  machine (`NEXT_PUBLIC_WORKER_URL` is unset in CI). The live
  Worker/DO path needs a real deployment + a two-phone field test.
- **The real deploy.** CI uses the placeholder site URL. Vercel needs
  the real `NEXT_PUBLIC_SITE_URL`, Supabase keys, and the deployed
  Worker URL — see `docs/DEPLOYMENT-RUNBOOK.md`.
- **Calibration.** Catch distance, ping schedule, Quick duration and
  the rest are still `CALIBRATION_OPEN` — CI cannot measure them.

## Installer note (pnpm, not npm — corrected 2026-11-17)

This repo's installer is **pnpm 10.34.9** (the `packageManager` field
in the root `package.json`); the lockfile is **`pnpm-lock.yaml`**.
There is **no `package-lock.json`** in the repo, and `npm ci` is not
a step anywhere — the earlier version of this file had it backwards.
The workflow (`.github/workflows/ci.yml`) installs with
`pnpm install --frozen-lockfile` (via `pnpm/action-setup@v4` +
`actions/setup-node` with `cache: pnpm`), and Vercel uses the same
install command (`vercel.json`). Do NOT invent a `package-lock.json`
or run `npm install` to "fix" the lockfile: the fix is
`pnpm install`, which regenerates `pnpm-lock.yaml`.

One quirk, documented in the workflow header rather than hidden:
the root `package.json` scripts still call
`npm run ... --workspace=...` internally. Those keep working under
the pnpm-managed tree (the `workspaces` field is still present, and
CI's `pnpm run build` / `pnpm run typecheck` / `pnpm test` steps run
them), so only the CI/Vercel entry points use `pnpm run` /
`pnpm --filter` directly. If the root scripts are ever migrated to
`pnpm --filter`, migrate them all at once — never one without the
other.

## Fixes made alongside this workflow (2026-11-17)

1. **Workflow rewritten** (`.github/workflows/ci.yml`): the old file
   ran lint / unit tests / typecheck / build but never installed
   Playwright browsers and never ran the e2e suite at all — the
   "full Playwright suite" was unexecuted in CI.
2. **Stale e2e assertion fixed** (`apps/web/e2e/live-hud.spec.ts`,
   offline-map test): it asserted the text
   `/Offline map — Doranda \+ Hinoo/`, which no longer exists in the
   UI — the live map renders `OFFLINE_MAP_AREA_MESSAGE`
   (`'Offline map: downloaded area only'`,
   `apps/web/src/components/map/maplibre.ts:68`, rendered at
   `apps/web/src/components/map/MapLibreMapView.tsx:238`). That test
   would have failed on every CI run. It now asserts the text that is
   actually rendered.
3. **Stale spec comment fixed** (`apps/web/e2e/map-tiles.spec.ts`
   header): it claimed the denied-state banner lacked Android/iOS
   steps "until the rebuild lands". The rebuild has landed —
   `LOCATION_DENIED_HELP` (`apps/web/src/lib/geolocation.ts:48-49`)
   carries both steps and is rendered by the `role="alert"` banner in
   `apps/web/src/components/host-setup/PlayAreaMap.tsx:591-593` — so
   the comment was corrected; the assertions themselves already
   matched current source and were left unchanged.

## What could still go red on the first CI run (known risks)

- `pnpm install --frozen-lockfile` failing if `pnpm-lock.yaml` has drifted from a
  `package.json` (see Install row above). This cannot be checked on
  the dev VM (child-process writes are blocked there).
- Any Playwright test that depends on the old build's behaviour and
  was only ever run against a stale `.next` (the repo carries a
  200 MB pre-existing `.next` build). CI builds fresh, so a stale
  failure surfaces here first — that is the point of CI.
- Flaky timing in the 20 s geolocation-denied tests on a loaded
  runner (the specs already allow up to 30 s for the banner).
