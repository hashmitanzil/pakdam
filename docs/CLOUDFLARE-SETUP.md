# Cloudflare — Workers + Durable Object setup (Pakdam)

> **RECONSTRUCTED 2026-11-17 — read this first.** The previous version
> of this file was accidentally truncated to 0 bytes during a doc edit
> in the sandbox (a `python open(..., 'w')` call truncated the file,
> then the write itself failed with `EPERM: operation not permitted`
> — the sandbox's child-process write wave). No git repo, zip, or other
> copy of the file existed to restore from. This version was rebuilt
> the same day from (a) the surviving verbatim fragments of the
> original, quoted in the session that truncated it, and (b)
> `docs/DEPLOYMENT-RUNBOOK.md` §1/§6/§7/§10, which the original
> itself cites as its source for the deploy flow, plus
> `workers/wrangler.toml` and `workers/src/room-do.ts` for the config
> and hibernation facts. Sections marked **[verbatim]** reproduce the
> original's wording as read in that session; sections marked
> **[rebuilt]** restate the same facts from those sources and may
> differ in wording. Two details the rebuild could not recover exactly
> are marked **[TO VERIFY]** — the tail of the §5 token-storage
> sentence and the full §10 two-phone procedure. A founder re-read
> against a real `wrangler login` / deploy run is still the check that
> closes those. The **pnpm corrections** in this rebuild are
> deliberate (2026-11-17): the repo installs with pnpm, not npm —
> see `docs/CI.md`.
>
> Status of the thing itself (unchanged by the rebuild): the Worker +
> Durable Object design is the **leading candidate — ADR-001, NOT
> approved. Deploy ONLY after the founder approves the M00 report +
> architecture.** Deploying before that approval is a founder
> decision, not a step in this file.

## 1. What this deploys

One Cloudflare Worker (`pakdam`, `workers/src/index.ts`) plus one
Durable Object class per room (`RoomDurableObject`,
`workers/src/room-do-class.ts`, migration tag `v1`,
`new_sqlite_classes`). The DO is the sole authority for active
gameplay: presence, match state, timers, teams, ping distribution,
catch confirmation, zone transitions, completion. Location fixes live
only in Durable Object active-room state and are purged at match end
/ TTL — no table stores raw coordinates, ever (HNT-068).

**Location rule (founder decision, 2026-11-17).** Location sharing is
DEFAULT: it runs while a round is running (foreground, while using
the app); pings go out on the host's ping schedule; own team sees
each other live; the other team only via pings; Runners never see
Hunters. The phone checks the zone locally — only an outside-zone
crossing sends one alert, which starts the 30-second return countdown
(first-seen-outside, the DO records it from the alert). A delivered
ping stays on the hunter's map until the next ping replaces it.
Cost is usage-based on the Cloudflare free tier — the founder manages
cost/errors himself; no custom cost maths is claimed in this file.

## 2. Prerequisites **[verbatim, pnpm-corrected]**

- A Cloudflare account (free tier — §3). No account exists yet; the
  founder creates it.
- Node `>= 20` (the repo's `engines` field) and `pnpm` (10.34.9 — the
  `packageManager` field in the root `package.json`).
- This repo checked out (`pakdam-app/`), with `pnpm install
  --frozen-lockfile` run at the repo root.
- The pre-flight checks in `docs/DEPLOYMENT-RUNBOOK.md` §4 green
  (typecheck, tests, build, lint). **Do not deploy if any of those
  fails.**

## 3. Create the Cloudflare account (free) **[verbatim]**

1. Go to <https://dash.cloudflare.com/sign-up> and create an account
   (email + password). The free tier needs no card.
2. No domain is needed. Workers run on a `*.workers.dev` subdomain
   that Cloudflare assigns at the first deploy — that subdomain is
   **UNKNOWN until the first deploy**; do not invent it in advance.
3. After signing in, open **Workers & Pages** in the left menu. That
   is where the deployed Worker will appear. Nothing to create there
   yet — `wrangler deploy` (§8) creates it.

## 4. Install Wrangler **[verbatim, pnpm-corrected]**

Wrangler is the Cloudflare CLI. It is already a devDependency of the
`workers/` package in this repo (installed 2026-11-17, version
**4.163.0** — verify with the command below; if the installed version
has moved on, record the new version here and re-check §8 still
applies).

```bash
cd pakdam-app
pnpm install --frozen-lockfile   # installs wrangler (a workers devDependency) via the workspace
cd workers
pnpm exec wrangler --version # must print a version, e.g. 4.163.0
```

If `pnpm exec wrangler --version` fails, stop — the CLI is not installed and
nothing below will work. Do not proceed to `wrangler login` with a
different machine's CLI.

## 5. Log in **[verbatim, except the token-storage tail — TO VERIFY]**

```bash
cd pakdam-app/workers
pnpm exec wrangler login
```

This opens a browser window for interactive OAuth. Log in with the
Cloudflare account from §3. The token is stored by Wrangler on your
**[TO VERIFY — the original sentence ended here in the surviving
fragment; standard Wrangler behaviour stores the OAuth token in the
local Wrangler config on that machine. Confirm the exact path from
`wrangler login --help` on the deploy machine and record it here.
Never paste a token into a file, chat, or the repo.]**

Alternative credential: a Cloudflare API token via the
`CLOUDFLARE_API_TOKEN` env var (standard Wrangler behaviour — the
token needs Workers / Durable Objects permissions). Confirm against
the installed Wrangler's help before relying on it. Check the login
with `pnpm exec wrangler whoami`; if login did not complete, re-run
`pnpm exec wrangler login`.

## 6. Configure the Worker (vars) **[rebuilt from workers/wrangler.toml]**

No secrets live in `workers/wrangler.toml`. The plain vars there are:

- `ENVIRONMENT = "dev"` (`[vars]`). To run production, change it by
  editing the file (reviewed, committed) — and add a named
  `[env.production]` only as a reviewed repo change, never as an
  unrecorded deploy-time override.
- `SUPABASE_URL = ""` — the Supabase project URL, a plain var (the
  same public value as the web app's `NEXT_PUBLIC_SUPABASE_URL`).
  Set the real URL here at deploy time; empty means "run without
  Supabase persistence" (the DO stays the authority, nothing fails).
  The service-role key is a SECRET and must never appear in this
  file — see §9.
- The per-IP rate-limit vars (`PAKDAM_JOIN_PER_MINUTE` /
  `PAKDAM_CREATE_PER_MINUTE` / `PAKDAM_LOOKUP_PER_MINUTE`) are NEVER
  set here — the deployed default is 5/min/IP. They are set ONLY for
  a local load run (e.g. `pnpm exec wrangler dev --var
  PAKDAM_JOIN_PER_MINUTE:100` for the 16-player k6 run, where all VUs
  share 127.0.0.1). See `workers/src/rate-limit.ts`.

## 7. Check it locally first (no account needed) **[verbatim, pnpm-corrected]**

```bash
cd pakdam-app/workers
pnpm run build   # tsc -p tsconfig.json — must pass; output in workers/dist/
pnpm test        # node --test dist/test/*.test.js — Worker unit tests, must pass
pnpm run dev     # wrangler dev — local Worker + Durable Object
```

**VERIFIED 2026-11-17 (wrangler 4.163.0):** `wrangler dev` starts,
lists the bindings (`env.ROOM_DO (RoomDurableObject) Durable Object
local`, `env.ENVIRONMENT ("dev")`), prints `Ready on
http://localhost:8787`. Two real gaps were found and fixed during this
verification: the `RoomDurableObject` class did not exist at all (only
a string constant), and the entrypoint exported that string, which
workerd rejects ("Incorrect type for map entry 'ROOM_DO_CLASS'"). The
class now lives in `workers/src/room-do-class.ts` and is re-exported
from `workers/src/index.ts`; the pure HTTP helpers moved to
`workers/src/http.ts` so the unit tests still run under plain Node
(`cloudflare:workers` cannot be loaded by Node). **Correction
2026-11-17:** the Worker entrypoint has since been implemented — it
is NO LONGER a 501 skeleton (`workers/src/index.ts` header: "Routes
(implemented — this file used to be a 501 skeleton)"). The routes
answer for real; the WS session lifecycle still needs the API
mission's wiring (web → Worker), not a live game server yet. With
`wrangler dev` running, an unknown path returns **404** and a routed
path its real status — see the checks below.

```bash
curl -i http://localhost:8787/no-such-path
# Expect: HTTP 404, body {"error":"not found"}
curl -i http://localhost:8787/v1/rooms/abc
# Expect: HTTP 400, body {"error":"playerId query parameter is required"}
```

**Step 5 — WebSocket.** The HTTP steps above prove the Worker; the
live socket itself needs a WS client (a browser, or the web app once
its pages call `createLivePakdamSocket()`). Handshake URL:
`ws://localhost:8787/v1/rooms/<roomId>/ws?ticket=<ticket>` — the
server replies `welcome`, then a recipient-filtered `snapshot`. Do
not try this step with `curl` — it cannot do a WebSocket handshake.
Until the two-phone check in §10 is done, the WS proof is the
two-phone check, not this section.

## 8. Deploy **[verbatim, pnpm-corrected]**

Prerequisites: §2 green, §5 login done, §7 local check passing.

```bash
cd pakdam-app/workers
pnpm run deploy   # wrangler deploy — deploys workers/wrangler.toml
```

What it does:

- Deploys Worker `pakdam` (`main = "src/index.ts"`).
- Creates/updates the Durable Object class `RoomDurableObject` under
  migration tag `v1` (`new_sqlite_classes`).
- Sets the plain var `ENVIRONMENT = "dev"` from `[vars]`. It does
  **not** set any secret. Secrets are separate (§9).
- Prints the deployed Worker URL (a `*.workers.dev` subdomain unless
  a custom domain/route is configured — none is configured in this
  repo). **Record that URL.** It becomes the value of
  `NEXT_PUBLIC_WORKER_URL` for the web app (Vercel env — see
  `docs/DEPLOYMENT-RUNBOOK.md` §8).

Expected result today: deploy succeeds, and the Worker answers with
its real statuses — unknown paths **404**, `GET /v1/rooms/abc`
**400** (`playerId` required), `POST /v1/rooms` with an empty body
**400** (`invalid request`). That proves the pipeline; it does not
prove the API is live end to end — the web app is not wired to the
Worker yet and the Worker never talks to Postgres. If you get a
Cloudflare error page instead of a JSON error, stop and check you
deployed this repo's Worker and not something else.

## 9. Secrets — set, never commit **[rebuilt from docs/DEPLOYMENT-RUNBOOK.md §7]**

Set each secret with the Wrangler CLI from the `workers/` directory.
Values are entered interactively by the operator; they never appear
in this file, in the repo, or in chat.

```bash
cd pakdam-app/workers
pnpm exec wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

- `SUPABASE_SERVICE_ROLE_KEY` is the only Worker secret this repo
  names. It is server-side only.
- Do **not** set `NEXT_PUBLIC_SUPABASE_ANON_KEY` or
  `NEXT_PUBLIC_SUPABASE_URL` as Worker secrets — they are public
  web-app values and belong in the web host's env, not in the Worker.
- Rotate a secret immediately if it is ever pasted, logged, committed,
  or shown on screen. There is no secret-rotation procedure in this
  repo beyond that rule.

## 10. Two-phone check **[TO VERIFY — procedure rebuilt, not run]**

The live Worker/DO path is proven by two phones, not by CI (CI plays
the demo loop on one machine with `NEXT_PUBLIC_WORKER_URL` unset).
**[TO VERIFY: the original §10 procedure did not survive the
truncation. The steps below are the minimal honest version — confirm
and expand them on the first real deploy.]**

1. Deploy (§8) and set `NEXT_PUBLIC_WORKER_URL` to the deployed
   Worker URL in the web app's Vercel env; rebuild/redeploy the web
   app so the value is baked in at build time.
2. Phone 1 (host): create a room over the live Worker, note the room
   code.
3. Phone 2: join with the room code, ready up; both phones connect
   over the live socket (`wss://<api-host>/v1/rooms/<roomId>/ws`).
4. Start the match on phone 1; confirm roles, head-start flip,
   pings and the zone arrive on both phones from the server, and a
   Team Radio text message sent on one phone appears on the other
   (same team only).
5. If any step fails, stop and record the exact error (no tokens) —
   do not improvise a config change to get past it.

## 11. Hibernation — what survives an idle room **[rebuilt from workers/src/room-do.ts]**

A Durable Object hibernates after idle. State is recovered from the
redacted snapshot in `ctx.storage` (no raw coordinates, no token
hashes). Coordinates and pending pings are NOT recovered — players
send a fresh fix and pings are re-computed; every player reads
"location unknown" until a fresh foreground fix arrives. The zone
shrink schedule is recomputed from the zone config after hibernation;
a shrink that fired while hibernating is emitted once on wake, with
the next zone drawn then by the DO (per-shrink draw, 2026-11-17).
If a mid-match idle room must survive untouched, that is a
realtime-mission design question, not a deploy fix.

## 12. Troubleshooting (common failures) **[verbatim, pnpm-corrected]**

| Symptom | Likely cause | Fix |
|---|---|---|
| `pnpm exec wrangler --version` fails / command not found | Wrangler not installed | Run `pnpm install --frozen-lockfile` at the repo root (§4). Do not use a globally installed wrangler from another project — versions drift. |
| `wrangler login` opens no browser / errors | No browser on the machine, or a proxy blocks it | Run `wrangler login` on a machine with a browser, or use an API token via `CLOUDFLARE_API_TOKEN` (§5). Never paste a token into a file. |
| `wrangler deploy` fails with an auth error | Not logged in, or the token lacks Workers / Durable Objects permissions | Re-run `wrangler login`; check the token's permissions in the Cloudflare dashboard (Account → API Tokens). |
| `wrangler deploy` fails with a DO migration error | Tag `v1` was edited after a deploy, or a second deploy changed the class list | DO migrations are append-only: add a NEW `[[migrations]]` tag for the change; never edit `v1` in place after a deploy. |
| Deployed Worker returns a Cloudflare error page (not a JSON error) | Wrong Worker deployed, or the route points elsewhere | Check the Worker name in the dashboard (Workers & Pages → `pakdam`); confirm the URL is the one `wrangler deploy` printed. |
| `POST /v1/rooms` returns 400 `invalid request` | Body failed validation | Expected for an empty/bad body. A real create needs a valid room config per `docs/API.md` and returns 201. |
| `wrangler dev` fails to start locally | Port in use, or the Worker code does not compile | Run `pnpm run build` in `workers/` first and fix the type error; check nothing else is on port 8787. |
| Room state disappears after idle | DO hibernation (§11) | Expected. Coordinates and pending pings are NOT recovered — players send a fresh fix and pings are re-computed. If a mid-match idle room must survive untouched, that is a realtime-mission design question, not a deploy fix. |
| `wrangler tail` shows nothing | No requests reaching the Worker, or the tail started after the request | Keep the tail running, then trigger a request; confirm the URL is the deployed Worker URL, not the local one. |

If a failure is not in this table, stop and record the exact error
message (without any token or secret in it) before trying another
fix. Do not improvise a config change to get past it.

## 13. How to roll back **[verbatim, pnpm-corrected]**

There is **no automated rollback tested in this repo**. The first real
deploy should rehearse the Worker rollback before any public pilot.

```bash
cd pakdam-app/workers
pnpm exec wrangler deployments list   # find the previous good deployment id
pnpm exec wrangler rollback           # rolls back to the previous deployment
```

Confirm the exact flags in the installed CLI's help (`pnpm exec wrangler
rollback --help`) — the commands above are standard Wrangler, but
were not run to completion while writing this file. If rollback is
unavailable or fails, redeploy the previous known-good commit: check
out that commit, run the §2 pre-flight, then `pnpm run deploy`. Keep
the deployed commit hash recorded with every deploy (see
`docs/DEPLOYMENT-RUNBOOK.md` §11) so "previous good" is a fact, not a
guess.

**Durable Object caveat:** the `v1` migration tag creates the
`RoomDurableObject` class; rolling back the Worker does **not** undo a
DO class migration, and in-flight room state in a DO is not restored
by a Worker rollback. Active rooms at rollback time should be treated
as lost — end them cleanly and have players re-create rooms.
