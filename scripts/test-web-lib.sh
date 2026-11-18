#!/usr/bin/env bash
# Repo runner for the web lib suites (apps/web/src/lib/__tests__/):
# websocket-reconnect (17), session-credentials (6), live-client (15),
# demo-store-roles (2), demo-store-parity (10), voice-radio (D-M1, 13),
# map-location (8) — 7 suites, 71 tests. All 7 are in BOTH lists below
# (the tsc inputs and the node --test invocation): map-location and
# demo-store-parity must never be dropped from either — Meera
# re-review #2 found 18 tests never ran when they were missing.
#
# Why this script exists (2026-11-17, tooling worker): these suites use
# `node:test` imports. Vitest 5.1.0 does NOT execute `node:test` files —
# proven with a minimal probe (default and named imports, with and
# without vitest.config.mts): "No test suite found in file", and no
# node:test shim exists in the installed vitest dist. Adding the glob to
# vitest.config.mts was tried and reverted the same day (it turned
# `test:vitest` red without executing one test). And plain
# `node --test` on the .ts sources fails: Node 24 type-strips .ts files
# but does NOT map `.js` specifiers to `.ts` files, so the sources'
# extensionless relative imports (`./demo-store`, `./websocket`, …)
# cannot resolve. So the documented flow from the test files' own
# header is the runner: tsc to scratch inside the repo (so
# '@pakdam/shared' / '@pakdam/engine' resolve via the workspace
# node_modules), fix up the emitted extensionless imports, run
# node --test, delete scratch.
# The scratch dir lives under apps/web/ (NOT the repo root): under
# pnpm's strict layout the workspace links `@pakdam/*` exist ONLY in
# apps/web/node_modules, so a repo-root scratch dir cannot resolve
# them (ERR_MODULE_NOT_FOUND for @pakdam/engine — found by the
# final verification, 2026-11-17; the npm flat tree used to hide
# this). apps/web/.scratch-web-test is eslint-ignored and gitignored
# (do NOT commit).
set -u
cd "$(dirname "$0")/.." || exit 1

SCRATCH=apps/web/.scratch-web-test
rm -rf "$SCRATCH"
trap 'rm -rf "$SCRATCH"' EXIT

./node_modules/.bin/tsc \
  apps/web/src/lib/websocket.ts \
  apps/web/src/lib/session-credentials.ts \
  apps/web/src/lib/demo-store.ts \
  apps/web/src/lib/live-client.ts \
  apps/web/src/lib/live-room-client.ts \
  apps/web/src/lib/voice-radio.ts \
  apps/web/src/lib/geolocation.ts \
  apps/web/src/components/match/freshness.ts \
  apps/web/src/lib/__tests__/websocket-reconnect.test.ts \
  apps/web/src/lib/__tests__/session-credentials.test.ts \
  apps/web/src/lib/__tests__/live-client.test.ts \
  apps/web/src/lib/__tests__/demo-store-roles.test.ts \
  apps/web/src/lib/__tests__/demo-store-parity.test.ts \
  apps/web/src/lib/__tests__/voice-radio.test.ts \
  apps/web/src/lib/__tests__/map-location.test.ts \
  --outDir "$SCRATCH" --module esnext \
  --moduleResolution bundler --target es2022 \
  --lib es2022,dom --strict --skipLibCheck --esModuleInterop \
  --types node --jsx react-jsx
TSC_EXIT=$?
if [ "$TSC_EXIT" -ne 0 ]; then
  # D-M12 (2026-11-17): NEVER run node --test on the scratch dir after
  # a failed emit — the scratch then holds whatever stale files
  # survived from an earlier run, and the per-suite ✔ lines would
  # report those stale suites as passing. Abort here: a tsc failure
  # fails the run, with no test results claimed at all.
  echo "test-web-lib: tsc exited $TSC_EXIT — aborting before node --test so stale scratch output is never reported as passing." >&2
  exit 1
fi

# tsc emits extensionless relative imports (bundler style); node ESM
# needs .js — fix up the scratch output only, never source.
find "$SCRATCH" -name '*.js' -exec sed -i \
  -e "s|from './demo-store'|from './demo-store.js'|g" \
  -e 's|from "./demo-store"|from "./demo-store.js"|g' \
  -e "s|from './session-credentials'|from './session-credentials.js'|g" \
  -e 's|from "./session-credentials"|from "./session-credentials.js"|g' \
  -e "s|from './websocket'|from './websocket.js'|g" \
  -e 's|from "./websocket"|from "./websocket.js"|g' \
  -e "s|from './live-client'|from './live-client.js'|g" \
  -e 's|from "./live-client"|from "./live-client.js"|g' \
  -e "s|from './live-room-client'|from './live-room-client.js'|g" \
  -e 's|from "./live-room-client"|from "./live-room-client.js"|g' \
  -e "s|from './voice-radio'|from './voice-radio.js'|g" \
  -e 's|from "./voice-radio"|from "./voice-radio.js"|g' \
  {} +

# The tsc inputs all live under apps/web/src (lib/ + components/), so
# tsc's common root is apps/web/src and the tests land in
# $SCRATCH/lib/__tests__/ — NOT $SCRATCH/__tests__/. (Meera #3,
# 2026-11-18: the old paths made `pnpm run test:web` fail as shipped.)
node --test \
  "$SCRATCH/lib/__tests__/websocket-reconnect.test.js" \
  "$SCRATCH/lib/__tests__/session-credentials.test.js" \
  "$SCRATCH/lib/__tests__/live-client.test.js" \
  "$SCRATCH/lib/__tests__/demo-store-roles.test.js" \
  "$SCRATCH/lib/__tests__/demo-store-parity.test.js" \
  "$SCRATCH/lib/__tests__/voice-radio.test.js" \
  "$SCRATCH/lib/__tests__/map-location.test.js"
TEST_EXIT=$?

if [ "$TEST_EXIT" -ne 0 ]; then
  exit 1
fi
exit 0
