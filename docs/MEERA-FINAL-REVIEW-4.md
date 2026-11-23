# Meera — Final Re-Review #4 (independent)

**Reviewer:** Meera (independent reviewer)
**Date:** 2026-11-18 ~02:00–02:20 IST (2026-11-17 20:30–20:50 UTC)
**Brief (only authoritative source):** `pakdam-final-checklist-2026-11-17.md`
**App:** `~/workspace/goals/hide-and-seek-combo-game/files/pakdam-app/` (Next.js 15.5.29)
**Previous verdict:** NEEDS FIXES (`docs/MEERA-FINAL-REVIEW-3.md`, exactly one blocker)
**Method:** read, run, report only. No app source was modified by this review.
Every number below is from my own runs or source reads in this session;
nothing is taken from any fix summary on trust. Where a claim could not
be re-run here, that is stated plainly instead of claimed as tested.

## Verdict: PASS

The single blocker from review #3 is genuinely fixed, verified from
files and my own runs, and nothing regressed: the web-lib runner
passes 71/71 with exit 0 as shipped, all four workspaces typecheck,
lint is clean, and the production build is intact and serves (8/8
spot-checked routes 200, 52/52 chunks 200, tile 200, BUILD_ID
unchanged). No new defect was found in the scope of this review.

## 1. The blocker — `scripts/test-web-lib.sh` paths: FIXED

**File evidence (read, not trusted):**

- The seven `node --test` arguments now point at
  `$SCRATCH/lib/__tests__/` — `scripts/test-web-lib.sh:92-98`:
  `websocket-reconnect.test.js` (:92), `session-credentials.test.js`
  (:93), `live-client.test.js` (:94), `demo-store-roles.test.js`
  (:95), `demo-store-parity.test.js` (:96), `voice-radio.test.js`
  (:97), `map-location.test.js` (:98). All seven suites, none
  dropped — the same seven are in the `tsc` inputs (:48-54).
- The comment explains why — `scripts/test-web-lib.sh:87-90`:
  the `tsc` inputs all live under `apps/web/src` (lib/ +
  components/), so `tsc`'s common root is `apps/web/src` and the
  tests land in `$SCRATCH/lib/__tests__/` — NOT
  `$SCRATCH/__tests__/`. It cites Meera #3 by name and date.
- No remaining `$SCRATCH/__tests__/` path exists in the script
  (grep: zero occurrences outside the comment's explicit NOT).
- The D-M12 guard is still present: `tsc` failure aborts before
  `node --test`, so stale scratch output can never be reported as
  passing.

**Own run:** `bash scripts/test-web-lib.sh` → **exit 0**,
**71 tests: 71 pass, 0 fail, 0 skipped** (summary lines:
`tests 71 / pass 71 / fail 0 / skipped 0`). The scratch dir
`apps/web/.scratch-web-test` was cleaned afterwards (trap worked —
directory absent after the run).

**CI entry point:** `package.json:18` confirms `pnpm run test:web`
is exactly `bash scripts/test-web-lib.sh`. One honest caveat:
`pnpm` is not installed in this VM (no binary, no corepack), so
`pnpm run test:web` could not be invoked literally here — but the
command it runs is the script I ran directly, exit 0, 71/71. CI's
"Web lib tests" step will run that same script; there is no longer
any path reason for it to fail.

## 2. Regression check — typecheck, lint: NO REGRESSION

Own runs, direct binaries:

| Workspace | Command | Result |
|---|---|---|
| `packages/shared` | `tsc -p packages/shared/tsconfig.json --noEmit` | PASS, exit 0, 0 errors |
| `packages/engine` | `tsc -p packages/engine/tsconfig.json --noEmit` | PASS, exit 0, 0 errors |
| `workers` | `tsc -p workers/tsconfig.json --noEmit` | PASS, exit 0, 0 errors |
| `apps/web` | `tsc -p apps/web/tsconfig.json --noEmit --incremental false` | PASS, exit 0, 0 errors |

Lint: `./node_modules/.bin/eslint .` → **exit 0, 0 errors,
0 warnings**.

## 3. Regression check — production build: NO REGRESSION

**Dist integrity, checked before any run and again after all runs —
identical both times** (so no vacuous 0-byte-dist pass is possible
here): shared + engine + workers dist = **176 files, 0 zero-byte**.
`.next`: **463 files, 0 zero-byte**, **BUILD_ID
`pbbo8jgnRqQr7uMkZ7iep`** — unchanged from review #3.

**Serves** (`next start -p 3106` from `apps/web`, with
`PAKDAM_ALLOW_PLACEHOLDER_URL=1`; "Ready in 8.4s", Next.js 15.5.29):

- Routes, my own spot-check: **8/8 → 200** — `/`, `/join/ABCDEF`,
  `/room/TEST/play`, `/room/TEST/catch`, `/room/TEST/results`,
  `/robots.txt`, `/sitemap.xml`, tile
  `/offline-map/tiles/16/48301/28392.jpg`.
- Home HTML contains `pbbo8jgnRqQr7uMkZ7iep`.
- Chunks: **52/52 → 200** (full sweep over every
  `.next/static/chunks/*.js`, requested as `/_next/static/chunks/…`).
  Note for the record: five page chunks whose paths contain
  `[code]` / `[roomId]` first appeared to fail with an empty status
  — that was curl globbing on unencoded brackets, not the server:
  re-requested with `%5B`/`%5D` encoding they are all 200.
- Server stopped cleanly afterwards (killed by PID, port down, no
  leftover processes).

**Two self-inflicted incidents, not app defects:** my first serve
attempt backgrounded the `cd` along with the server (so `next`
was not found and the foreground shell stayed in the wrong
directory), and the `pkill -f` in that same attempt matched my own
exec session's command line and killed it — the same class of
mistake review #3 owned. Both were re-run cleanly afterwards with
the server started from `apps/web` and stopped by PID.

## 4. What was NOT re-verified in this review (narrow scope)

This review was deliberately narrow: the one blocker plus
regression checks. I did **not** re-run the engine/worker unit
suites, vitest, the 53-check playthrough, or the wrangler probes
from review #3 — those passed then and nothing in this fix touches
their code (the only change in scope is the seven paths and one
comment in `test-web-lib.sh`), but "unchanged since review #3" is
not the same as "re-run in review #4", and I do not claim it as
such. I also did not re-check the D-M3/D-M6 source fixes or the
Playwright spec counts from review #3; they were verified then and
are outside this review's remit.

## 5. What still cannot be proven in this VM

Unchanged from review #3, stated plainly:

- **Green full-matrix Playwright/CI run** — Playwright has still
  never executed anywhere; only the founder's GitHub push and a CI
  run with a JSON reporter prove the 63-definition / 173-execution
  matrix (170 passed + 3 skipped). The runner fix removes the
  known CI failure, but it is not itself a green CI run.
- **Live deployment** — no deployment exists from this review.
- **Real-phone GPS** — no outdoor field test, no real GPS fix.
- **Real QR-camera scan** — no camera, no physical scan.
- **Real two-phone WebRTC call** — voice radio is unit-tested
  only; no live two-peer call was made.
- No link was shared, no zip was produced, and no deployment or
  credential was invented by this review.

## 6. Residuals (non-blocking, carried from review #3)

- `offline-map/mode.ts:64` dead label still names Ranchi and
  `pmtiles-loader.ts:186` still names Doranda & Hinoo — unreachable
  from any UI (dead `decideMapMode` path). Hygiene only.
- Root `package.json` scripts still call `npm run … --workspace=…`
  (cosmetic; CI uses `pnpm` directly).
- `pnpm` is absent from this VM — noted in §1, not an app defect.

## Own runs — summary (all from this session)

| Check | Command / method | Result |
|---|---|---|
| Web lib tests | `bash scripts/test-web-lib.sh` | **71/71 pass, 0 fail, 0 skipped, exit 0** |
| Typecheck shared | `tsc -p packages/shared/tsconfig.json --noEmit` | PASS, exit 0 |
| Typecheck engine | `tsc -p packages/engine/tsconfig.json --noEmit` | PASS, exit 0 |
| Typecheck workers | `tsc -p workers/tsconfig.json --noEmit` | PASS, exit 0 |
| Typecheck web | `tsc -p apps/web/tsconfig.json --noEmit --incremental false` | PASS, exit 0 |
| Lint | `./node_modules/.bin/eslint .` | PASS, exit 0, 0 errors, 0 warnings |
| Dist integrity | `find …/dist -type f` (+ zero-byte count), before and after | **176 files, 0 zero-byte, identical** |
| Production serve | `next start -p 3106` + curl sweep | **8/8 routes 200, 52/52 chunks 200, tile 200, BUILD_ID `pbbo8jgnRqQr7uMkZ7iep`** |
| `pnpm run test:web` | literal invocation | **Not runnable here — pnpm not installed in this VM**; `package.json:18` shows it is exactly the script run above (exit 0, 71/71) |
