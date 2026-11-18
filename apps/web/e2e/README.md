# Pakdam Playwright suite

TEXT/DOM assertions only, no screenshots (gateway rule: the dev
gateway rejects images). Geolocation is mocked by Playwright
contexts — no real GPS is involved here; real outdoor GPS is a
founder phone check, not a CI check.

## Suite size

63 test definitions in 13 spec files under `apps/web/e2e/`, 173
executions across 6 projects (desktop 59, tablet 16,
phone-360-portrait 59, phone-360-landscape 11, brutal-phone 12,
mobile-zoom130 16). The zoom130 test in `mobile-layout.spec.ts` is
skipped on the three non-277px projects that run it, so a green run
is 170 passed + 3 skipped. Counted from the spec files 2026-11-18:
63 `test('…')` definitions — a naive `grep -c "test("` returns 74
because 11 regex `.test(` calls are not test definitions.

Projects are defined in `apps/web/playwright.config.ts`. The suite
runs against the production build on `http://localhost:3105`.

## How to run

From the repo root, build once first (the placeholder-URL escape is
dev/CI-only — never set it in a real deploy):

```sh
PAKDAM_ALLOW_PLACEHOLDER_URL=1 pnpm run build
```

Then run the full matrix, sequentially, with a JSON report:

```sh
cd apps/web
PAKDAM_ALLOW_PLACEHOLDER_URL=1 PLAYWRIGHT_BASE_URL=http://localhost:3105 \
  pnpm exec playwright test --workers=1 --reporter=json > playwright-report.json
```

Or the plain default (list reporter, config workers): `pnpm --filter
pakdam-web run test:e2e`.

## Sequential runbook (CI)

Do NOT run a second `next build` while the suite runs — a concurrent
build corrupting `.next` mid-run once failed 15 unrelated tests at
once (every chunk HTTP 400). The authoritative order, pre-flight
gates (port-3105 kill, readiness loop, BUILD_ID stability check,
chunk-200 gate, tile spot-check) and post-run checks live in
`.github/workflows/ci.yml` (e2e step) and are described in
`docs/CI.md` ("The e2e step runs sequentially, with pre-flight
gates") and Meera re-review #2 `docs/MEERA-FINAL-REVIEW-2.md` §3.3.
CI is the only green-run evidence that counts.
