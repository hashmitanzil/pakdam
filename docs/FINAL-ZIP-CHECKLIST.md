# Pakdam — Final Zip Packing Checklist

**Purpose:** exactly what goes into the final zip handed to the founder,
so the zip is complete, deployable, and contains no secrets or build junk.
**Do NOT create the zip until Meera passes** (founder rule). This file is
the packing list only. Measured 2026-11-18.

## 1. What the zip IS

- One zip file containing the single folder `pakdam-app/` as its root.
- Measured size of the packable tree (excluding everything in §3):
  **~20 MB, 1,640 files** (measured 2026-11-18 with
  `du --exclude=node_modules --exclude=.next --exclude=dist
  --exclude=.npm-cache --exclude=.vendor --exclude=test-results
  --exclude=coverage --exclude=.scratch-web-test --exclude=.wrangler`).
- The bulk is the offline map: `apps/web/public/offline-map/` is ~17 MB
  (808 raster tiles ~13 MB + `ranchi.pmtiles` spare 2.2 MB + vendored
  MapLibre JS/CSS).

## 2. INCLUDE — every file/folder below, exactly as it stands

| Path | Why it must be in the zip | Verified |
|---|---|---|
| `README.md` | Founder-facing status, quick start, deploy vars, Supabase order (corrected 2026-11-18) | Yes — status block, map section, `NEXT_PUBLIC_WORKER_URL`, 0001+0003+0004 |
| `.env.example` | Var names only, all commented, no values | Yes — `MAP_TILE_URL` removed 2026-11-18 |
| `.gitignore` | Excludes `node_modules/`, `.next/`, `dist/`, `.env*` (keeps `.env.example`) | Yes |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `vercel.json` | Install/build/lint config; `vercel.json` = pnpm install, `pnpm run build`, output `apps/web/.next` | Yes — `vercel.json` buildCommand is `pnpm run build` |
| `.github/workflows/ci.yml` | CI: lint → typecheck → unit → vitest → web lib → production build → Playwright (63 tests) | Yes — pnpm, `PAKDAM_ALLOW_PLACEHOLDER_URL=1` dev/CI-only |
| `apps/` | The whole Next.js PWA (`apps/web/` incl. `public/offline-map/`, `scripts/download-offline-map.mjs`, `e2e/`, `playwright.config.ts`) | Yes |
| `apps/web/public/offline-map/` | **808 raster tiles, zooms 12–17, bbox 23.325–23.38 N / 85.285–85.355 E, ~13 MB** + `style.json` + `manifest.json` + vendored `vendor/maplibre-gl.js/.css` + spare `ranchi.pmtiles` (2.2 MB, documented spare, nothing loads it) | Yes — 808 tile files counted, 815 files total in the folder |
| `packages/` | `packages/shared`, `packages/engine` (source + `tsconfig`) | Yes |
| `workers/` | Worker + DO source, `wrangler.toml` (`pakdam`, `RoomDurableObject`, migration tag `v1`, `ENVIRONMENT = "dev"`), `package.json` (deploy script = `wrangler deploy`) | Yes |
| `supabase/migrations/` | **Deploy set ONLY: `0001_init.sql`, `0003_indexes.sql`, `0004_postgis.sql`** (in that order). 0004 written, never applied/syntax-checked against a live Postgres — verify on first apply | Yes |
| `supabase/migrations-deferred/` | `0002_rls.sql` (HELD, OD-022) + README explaining the hold and the re-apply order | Yes — kept in the zip ON PURPOSE so the founder can see it is held, not hidden |
| `supabase/config.toml` | Local DB port only (54322); no ref, region, or credentials | Yes |
| `docs/` | All docs, incl. corrected `STATUS.md`, `DEPLOYMENT-RUNBOOK.md`, `CLOUDFLARE-SETUP.md`, `CI.md`, `SENTRY-SETUP.md`, `OFFLINE-MAP.md`, `MEERA-FINAL-CHECKLIST-REVIEW.md`, `FINAL-ZIP-CHECKLIST.md` (this file) | Yes — see §5 for corrections made 2026-11-18 |
| `scripts/`, `vitest/`, `vitest.config.mts` | Test helpers + Vitest suites | Yes |

## 3. EXCLUDE — never in the zip (check each one before packing)

| Path | Size on disk | Why excluded |
|---|---|---|
| `node_modules/` | **868 MB** | Rebuilt by `pnpm install --frozen-lockfile` on the founder's PC / CI / Vercel |
| `apps/web/.next/` | **684 MB** | Stale pre-existing build (pre-dates current source). Rebuilt by `pnpm run build` / Vercel. Shipping it would serve stale code |
| `packages/*/dist/`, `workers/dist/` | ~1.4 MB | Build output, gitignored. Rebuilt by `pnpm run build` / `pnpm test` |
| `.vendor/zod-4.6.7.tgz` | **0 bytes** | Empty leftover file. Real Zod comes from pnpm. Exclude the whole `.vendor/` dir |
| `.npm-cache/` | 8 KB | Local npm cache, useless in the zip |
| `test-results/`, `coverage/`, `.scratch-web-test/`, `.wrangler/`, `dist-verify/` | various | Test/build scratch, gitignored |
| Any `.env`, `.env.local`, `.env.*` with values | — | **None exist in the repo** (only `.env.example`, verified 2026-11-18). If one appears before packing, STOP and remove it |

**Pack command (founder's PC, from the parent of `pakdam-app/`):**
zip the folder, not the contents loose — the zip must open to a single
`pakdam-app/` folder. Verify after packing: unzip to a fresh folder and
confirm `pnpm install --frozen-lockfile` starts cleanly and no `.env`
file is inside.

## 4. Pre-packing gates (all must be true before the zip is made)

- [ ] Meera re-review PASSES against the final checklist (founder rule —
      currently NEEDS FIXES, D-M1–D-M7 open)
- [ ] CI green on a clean runner (the only "production build passes"
      evidence — never a local run from the EPERM VM)
- [ ] Typecheck 0 errors, lint 0, unit tests green (numbers in §6)
- [ ] No `.env` file with values anywhere in the tree (`find . -name ".env*"`
      returns only `.env.example`)
- [ ] Offline map pack verified: 808 tiles present
      (`find apps/web/public/offline-map/tiles -type f | wc -l` = 808)
- [ ] `supabase/migrations/` contains ONLY 0001, 0003, 0004
- [ ] `NEXT_PUBLIC_SITE_URL` is still the placeholder in code
      (`https://pakdam.example`) — the founder sets the real URL in
      Vercel; the zip must NOT contain a guessed domain
- [ ] No invented keys, accounts, or credentials anywhere in the tree

## 5. Corrections made in this pass (2026-11-18, with evidence)

1. **README.md status block** — said "live backend is NOT wired yet".
   FALSE since the wiring mission: lobby/play/catch/results call
   `createLivePakdamSocket()` and `workers/src/supabase.ts` exists.
   Corrected to "live transport WIRED".
2. **README.md map section** — said "OpenFreeMap vector tiles z10–z14,
   41 files, 2.6 MB". FALSE: bundled Esri raster, 808 tiles, zooms
   12–17, ~13 MB. Corrected (verified by tile count).
3. **README.md deploy vars** — listed dead `WORKERS_API_URL` and
   `MAP_TILE_URL`, and claimed "nothing in the code reads the Worker
   name". Corrected to `NEXT_PUBLIC_WORKER_URL` (the name the code
   actually reads — `apps/web/src/lib/websocket.ts:510`); dead names
   named as dead.
4. **README.md Supabase section** — said "0001 then 0003" only and
   warned a blind `db push` would apply 0002. Corrected: deploy set is
   0001 + 0003 + 0004; 0002 lives in `migrations-deferred/`, so a plain
   push cannot apply it (still verify the push lists only 0001/0003/0004).
5. **`.env.example`** — removed `MAP_TILE_URL` (dead name, nothing reads
   it); added a note that `MAP_TILE_URL` / `WORKERS_API_URL` are dead.
6. **`docs/STATUS.md`** — full rewrite: old file said live was "NOT
   wired", demo loop, "tile provider key" blocker, Playwright "skeleton".
   Now states wiring done, deploy set, CI in place, and the real
   remaining gaps (no deployment, no green build, no field test).
7. **`docs/DEPLOYMENT-RUNBOOK.md`** — 8 stale passages corrected:
   §1 header (wiring exists), §2 intro + env table (`NEXT_PUBLIC_WORKER_URL`
   read by pages; `MAP_TILE_URL` dead), blocker D5 (wiring CLOSED,
   deployment still missing), §4 `.env.example` block, §8 `vercel.json`
   block (`buildCommand` was `npm run build`, actual file is
   `pnpm run build`), §8 step 3 (pages wired; dead names not to set),
   §1 API list (added by-code/config/remove-player/regenerate-code/
   catch-token/lifecycle/host token/transfer/resolve/results/reports/
   support routes; only `/catches*` except resolve, `/safety/sos`,
   `/leave` remain WS-only), API smoke intro.
8. **`docs/CLOUDFLARE-SETUP.md`** — §7 Step 5 said "until the pages are
   wired"; corrected (pages are wired; the two-phone check is the WS
   proof). §8 `pnpm run deploy` from `workers/` verified correct.
   (Meera's stale-doc note on `CLOUDFLARE-SETUP.md:67,94,422` was
   re-checked: those lines are the pre-flight / account / deploy
   sections and are current; no change needed.)
9. **`docs/CI.md`** — Meera flagged it stale (`npm ci` +
   nonexistent `package-lock.json`); re-checked 2026-11-18 and it was
   ALREADY corrected (pnpm, `pnpm-lock.yaml`, no `npm ci`). No change.
10. **`docs/SENTRY-SETUP.md`** — re-checked; current (wired, DSN missing,
    founder creates it). No change. `vercel.json` buildCommand verified
    as `pnpm run build` (matches the actual file, not the runbook's old
    quote).

## 6. Hosting guide re-verification (against the final tree)

Guide: `~/workspace/your_files/pakdam-hosting-guide/pakdam-hosting-guide.pdf`
(11 pages). Checked step by step against the repo on 2026-11-18:

| Guide step | Verdict | Detail |
|---|---|---|
| Step 1 — unzip, `pakdam-app/` folder, "three places matter" | ✅ correct, except migrations count | Folder layout matches. But it says "you will use two of them" for migrations — the deploy set is now THREE files (0001, 0003, **0004 PostGIS**). The guide never mentions 0004. |
| Step 2 — GitHub, private repo `pakdam`, GitHub Desktop | ✅ correct | Matches repo (`.gitignore` excludes `node_modules/`, `.next/`, `dist/`, `.env*`). |
| Step 3 — Supabase Mumbai, run 0001 then 0003, skip 0002 | ⚠️ **WRONG — incomplete** | The guide runs only 0001 + 0003 and never mentions **0004_postgis.sql**. The deploy set is 0001 + 0003 + 0004. The game runs without 0004 (the DO is the authority; PostGIS is the spatial safety layer — restricted areas, zone-polygon checks, the no-coordinates trigger), but a founder following the guide exactly would deploy WITHOUT PostGIS and never know. **The guide must be corrected to run 0001 → 0003 → 0004, in that order.** Its 0002 warning ("do not run unless the README says it is safe") is still correct. |
| Step 3 — copy Project URL / anon key / service role key | ✅ correct | Names match `.env.example` and the runbook. Service-role-only-into-Cloudflare rule is right. |
| Step 4 — Cloudflare: `npm install`, `npx wrangler login`, `npx wrangler secret put`, `npm run deploy` | ⚠️ **Commands work but use the wrong installer** | The repo is pnpm (`packageManager: pnpm@10.34.9`); `workers/package.json` has a `deploy` script (`wrangler deploy`), so `npm run deploy` inside `workers/` does run — but `npm install` inside `workers/` would create an npm install on top of a pnpm workspace (no `package-lock.json` exists) and can drift the lockfile. Correct commands: `pnpm install --frozen-lockfile` at repo root, then `cd workers && pnpm exec wrangler login` / `pnpm exec wrangler secret put SUPABASE_SERVICE_ROLE_KEY` / `pnpm run deploy`. The guide should be corrected to pnpm. |
| Step 4 — label the Worker address `WORKERS_API_URL` | ❌ **WRONG — this breaks live mode** | The guide tells the founder to save the Cloudflare address as `WORKERS_API_URL` and to set `WORKERS_API_URL` in Vercel (Step 5, three-variables table, troubleshooting, final checklist). **No code reads `WORKERS_API_URL`.** The code reads `NEXT_PUBLIC_WORKER_URL` (`apps/web/src/lib/websocket.ts:510`). If the founder follows the guide exactly, Vercel gets a variable the app ignores and the game stays on the demo loop with no error message. **This is the most serious guide error: the name must be `NEXT_PUBLIC_WORKER_URL` everywhere in the guide.** |
| Step 5 — Vercel import, "three variables before deploy" | ❌ **Wrong name (see above)** | The three names must be `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_WORKER_URL` — not `WORKERS_API_URL`. The rest (leave build settings alone, Root Directory default) is correct and matches `vercel.json`. |
| Step 5 — add `NEXT_PUBLIC_SITE_URL` after first deploy, redeploy | ✅ correct | Matches the placeholder guard in `apps/web/next.config.ts`. |
| Step 6 — two-phone check, Ranchi map, foreground-only note | ✅ correct | Matches the offline map (Doranda + Hinoo bundled) and the Phase 0 foreground limitation. |
| Troubleshooting table | ⚠️ **One wrong entry** | "Website opens, but the game cannot connect — check WORKERS_API_URL" must say `NEXT_PUBLIC_WORKER_URL`. All other rows are correct. |
| Final checklist | ⚠️ **One wrong entry** | "Its address saved as WORKERS_API_URL" must be `NEXT_PUBLIC_WORKER_URL`; also add "0004 run" to the Supabase line. |

**Guide verdict: 3 corrections required before the founder uses it —**
**(1) `WORKERS_API_URL` → `NEXT_PUBLIC_WORKER_URL` everywhere (critical:
following the guide as written leaves the game on the demo loop);**
**(2) add migration `0004_postgis.sql` after 0003;**
**(3) use pnpm commands in Step 4, not npm.**
The guide PDF itself was NOT edited in this pass (it is a built
artifact); the parent agent should regenerate it with these three
fixes. Until then, the README inside the zip wins where they differ —
and the README is now correct on all three points.

## 7. What still blocks the final handover

1. **Meera has NOT passed yet** — verdict NEEDS FIXES (D-M1–D-M7 open:
   voice radio, regenerate room code, Precise/Approximate display,
   lobby settings change, host remove, Tell-everyone live channel,
   Team Radio live delivery). A separate fix mission is running.
2. **No green CI run anywhere** — production build + Playwright never
   proven. First green run happens on the founder's push to GitHub.
3. **No live deployment / credentials / domain** — Cloudflare account,
   Supabase project, Vercel project, real `NEXT_PUBLIC_SITE_URL`
   (trademark gate) are all founder-side, none invented.
4. **0004_postgis.sql never applied or syntax-checked** against a live
   Postgres — verify on first apply.
5. **No live game played** — wrangler-dev smoke 14/14 and harness games
   only; two-phone field test + real-phone GPS check still owed.
6. **Calibration all OPEN** — catch distance, ping schedule, Quick
   duration, rate limits are placeholders to be measured, never invented.
7. **Hosting guide needs the 3 corrections in §6** before the founder
   follows it (critical: the `WORKERS_API_URL` name error).

## 8. Test snapshot at this pass (2026-11-18, read with the caveat below)

- **shared typecheck (direct `tsc --noEmit --incremental false`): exit 0.**
- **engine / web typecheck in the same run: NOT reliable.** Engine
  failed only on `@pakdam/shared` resolution because the `--noEmit`
  run emitted no shared `dist` (a method artifact, not a code error).
  Web failed on 3 files that sibling fix missions were deleting
  mid-run (`OfflineMapNotice.tsx`, `useLiveRoom.ts`,
  `offline-map/index.ts` — the orphaned files flagged for wire-or-delete).
- **Unit tests from on-disk `dist`: engine 7/7 files pass; workers
  3 test files failed to load on the first run, then passed on rerun.**
  Cause found: `workers/dist/src/` is full of **0-byte files dated
  2026-11-17 18:54** — another EPERM truncation during a sibling
  mission's build. `dist/` is excluded from the zip (§3) and rebuilt
  by CI, so this does not block handover — but it means **no test
  number taken from this VM right now is trustworthy**: the tree is
  being edited concurrently by the Meera-fix, Kabir-push and
  continuous-QA missions.
- **Last verified numbers from earlier missions (on quieter trees):**
  typecheck 0 errors all workspaces, lint 0, unit tests 219 passed /
  0 failed (UI-polish sweep); workers 127 pass / 0 fail / 6 skipped,
  engine 49 pass / 0 fail / 3 skipped, web lib 32/32 (wiring
  verification); wrangler-dev smoke 14/14. Those are the numbers to
  trust until CI runs green — re-verify on a quiet tree before
  packing, per §4.

