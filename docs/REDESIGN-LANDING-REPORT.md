# Pakdam landing redesign — report (2026-11-17)

Worker: design-system + landing. Founder feedback: the UI did not meet
expectations. This redesign rebuilds the public face of Pakdam — landing,
sub-pages, top bar, footer, and the design system underneath — from the
competitor deep dive (`pakdam-competitor-deep-dive-2026-11-17.md`), writing
all copy and design ourselves. Nothing was copied from ShadowHunt or SCRAM:
no code, text, images, copy, or brand. Reference only.

## Files changed (my area only)

| File | What changed |
|---|---|
| `apps/web/src/styles/tokens.css` | New landing design system appended (~330 lines). All pre-existing game-screen classes (`.hud`, `.safety`, `.mapbox`, `.team-marker`, …) untouched. |
| `apps/web/src/app/layout.tsx` | New dark 4-column footer (Play / Trust & safety / About + brand column), `.a11y-bar` class for the accessibility strip, `themeColor` `#7F1D1D`. All previous footer links kept. |
| `apps/web/src/components/ui/TopBar.tsx` | Sticky ember-deep bar, `P` brand mark, nav (How it works, Game modes, Safety, FAQ, Help), `Play free` CTA. |
| `apps/web/src/app/page.tsx` | Full landing rebuild (see below). |
| `apps/web/src/app/how-it-works/page.tsx` | Restyled with numbered journey cards; venue wording removed. |
| `apps/web/src/app/game-modes/page.tsx` | Restyled; content unchanged. |
| `apps/web/src/app/about/page.tsx` | Restyled; venue wording removed. |
| `apps/web/src/app/faq/page.tsx` | Restyled as an accessible `<details>` accordion; JSON-LD kept; all 10 Q&As unchanged. |
| `apps/web/src/app/safety/page.tsx` | Restyled with a 2×2 rule-card grid; venue wording removed; `SOS_COPY` still imported from `@pakdam/engine`. |
| `apps/web/src/components/landing/DemoMap.tsx` | NEW — animated live demo map + ticking clock (client component). |
| `apps/web/src/components/landing/PickASide.tsx` | NEW — Hunter / Runner pick-a-side cards. |
| `apps/web/src/components/landing/HowItPlays.tsx` | NEW — 4-step how-it-plays. |
| `apps/web/src/components/landing/TrustStrip.tsx` | NEW — 6-item trust strip. |
| `apps/web/src/components/landing/PageHero.tsx` | NEW — shared dark header band for sub-pages. |

No other files touched. No game logic, safety/privacy rules, or engine code changed.

## Design system (`tokens.css`, appended section)

- **Type scale (fluid):** display `clamp(2.5rem, 8vw, 4.25rem)`, H1/H2/H3, lede — all original sizing, no external fonts.
- **Spacing scale** `--space-1`–`--space-10`, **radii** (8/12/20/28/999px), **shadows** (`sm/md/lg` + ember glow).
- **Dark hero palette:** `--night #1A0B0D`, `--night-2 #2A1216`, `--ember-light #FCA5A5`, `--ember-bright #F87171` on top of the existing ember red family.
- **Buttons:** 48px minimum height, 56px for `.btn-lg`; hover lift, focus ring unchanged (`--focus #1D4ED8`, 3px). Ghost-on-dark and light variants for the hero/CTA band.
- **Colour-blind safe:** Hunters stay blue ◆ `H` solid, Runners stay orange ▲ `R` — shape + letter + words, never colour alone. Existing `--ok` semantic rule preserved.
- **Contrast (calculated from hex values, to be confirmed by measurement in M00):** white on `#B91C1C` 6.5:1 · white on `#7F1D1D` 10.6:1 · `#7A1212` on `#FFF7F5` 9.4:1 · `#6B4A4A` on `#FFF7F5` 5.9:1 · `#FCA5A5` on `#1A0B0D` 7.3:1 · `#1D4ED8` on white 5.6:1 · `#9A3412` on white 5.5:1. All pass WCAG AA for normal text.
- **Motion:** demo animations are pure CSS keyframes; the existing `prefers-reduced-motion` rule disables them.
- **Canvas:** `main:has(> .landing)` widens to 1120px, `main:has(> .subpage)` to 880px; game screens keep the 720px column.

## Per-screen changes

### Landing (`/`)
- Dark hero: eyebrow, original headline "Hide in the real world. Run from real Hunters." (not the competitor's line), lede, one clear CTA "Create a game — free" + secondary "Join with a code", microcopy strip (Free · No download · 3–16 players · 18+ · Private invite-only).
- **Live demo map** (`DemoMap`): stylised animated map — shrinking dashed zone ring, Hunter dot (◆ H) sweeping a path, three Runner dots (▲ R) drifting, pulsing ping ring, live HUD chips (TIME LEFT ticking down from 30:00, NEXT PING cycling 3:00, RUNNERS 4 of 4, ZONE SHRINKING), badge "LIVE DEMO · SIMULATED". Caption states plainly it is a demo with illustrative numbers, no real players/locations, and that ping timing and zone sizes are still being calibrated (OPEN).
- **Pick a side:** Hunter card (track pings, in-person tag, GPS never counts) / Runner card (head start, coarse area only, catch needs your confirmation), each with its own CTA.
- **How it plays, 4 steps:** Start where you stand (location-first, zone sizes to player count, slider-adjustable) → Invite your people → Scatter, then hunt → Caught, in person.
- **Trust strip (6):** Free to join · Adults only · No exact locations · Safety always in reach · Foreground-only PWA (honest limit, not buried) · Host on site.
- Foreground-only honesty callout kept verbatim in meaning; Classic Manhunt + Safety teaser cards; ember CTA band ("Your street. Your friends. One clock."); demo-mode footnote kept.

### How it works (`/how-it-works`)
- Host journey, player journey, and full-round steps rebuilt as numbered journey cards. Copy preserved except: "known, bounded venue" → "known, bounded play area"; "(venue-only pilot)" → "(host-on-site pilot)"; create step now says "start from your location on the map… play zone sizes itself to the player count and can be adjusted with a slider". "What Pakdam can't do (yet)" callout kept.

### Game modes (`/game-modes`)
- Same facts, new presentation: Classic Manhunt in an ember-bordered card with CTAs; "More modes — coming later" in a muted card with the "no Play now button for a mode that does not exist yet" line kept. Free-hosting-to-16 footnote kept.

### About (`/about`)
- Same sections (Why it exists / India-first / Built from scratch / Who makes Pakdam / honest-limits callout). "At a venue your host has chosen" → "in a bounded play area your host has set on the map". Provisional-name / trademark-not-cleared wording kept.

### FAQ (`/faq`)
- All 10 Q&As byte-identical in wording; now an accessible `<details>`/`<summary>` accordion (56px min-height summaries, `+`/`−` indicator). FAQPage JSON-LD kept.

### Safety (`/safety`)
- Same rules, SOS copy (still imported from engine, not duplicated), pause, leave, privacy, not-an-emergency-service, reporting. "Venue-only pilot" rule → "Host-on-site pilot: games run only in a known, bounded play area with the host on site." SOS / pause / leave / not-emergency now a 2×2 card grid.

### Top bar + footer (all pages)
- Top bar: sticky, ember-deep, brand mark, 5 nav links + Play free CTA (44px+ touch targets).
- Footer: dark, 4 columns (brand + Play / Trust & safety / About), every previous link retained (Create, Join, How it works, Game modes, Install, Safety, FAQ, Help, Grievance, Accessibility, About, Contact, Legal, Profile, Admin), plus the honesty lines (working name provisional, English only, 18+, private invite-only, foreground-only PWA, not an emergency service, pilot).

## Area-name / venue-name removal
- Grep over all my files after the rewrite: zero occurrences of "venue", "area name", or "area-name" in user-facing copy or code (one dev comment was reworded to avoid the phrase entirely).
- Location-first wording is used instead: "start where you stand", "bounded play area", "host on site".

## What was NOT invented
- No stats, counters, prices, contacts, domains, or player numbers. The demo clock/zone values are labelled simulated and illustrative.
- No ping interval, match length, head start, or zone size is published as a Pakdam fact — calibration stays OPEN and is labelled so in the demo caption.
- No competitor copy, names, or claims reused; all headlines and body copy are original Pakdam wording.

## Verification (real output)

- **Full-repo typecheck** (`npm run typecheck`, apps/web): PASSED with zero errors at 06:45 UTC — before a concurrent worker's edit landed (see below).
- **Scoped typecheck** of my 13 files + their imports (`tsc -p tsconfig.verify.json`, temp file, deleted after): **0 errors**.
- **Production build** (`PAKDAM_ALLOW_PLACEHOLDER_URL=1 npm run build`): SWC compile **succeeded in 7.1s** for all routes, then the type-check phase failed on a file outside my area — `src/components/lobby/LobbySafety.tsx:103` (`onPauseChange(null)` not assignable to `LobbyPause`), edited by another concurrent worker at 06:46:29 UTC (after my clean typecheck). I did not touch it; it is not mine to fix.
  - Note: a plain `npm run build` also refuses first on the pre-existing `NEXT_PUBLIC_SITE_URL` placeholder guard in `next.config.ts` (trademark gate) — expected; the dev/CI escape `PAKDAM_ALLOW_PLACEHOLDER_URL=1` was used for verification only, never for a deploy.
- **Render verification** (fresh `next dev`, torn `.next` removed first): all 6 routes **HTTP 200** — `/` 68,690 chars, `/how-it-works` 46,912, `/game-modes` 34,625, `/about` 34,588, `/faq` 49,565, `/safety` 39,306. Content markers confirmed in served HTML: `demo-map` + `LIVE DEMO` on `/`; `host-on-site pilot` ×2 on `/how-it-works`; `NOT an emergency service` ×2 on `/safety`; `faq-item` ×20 (10 questions) on `/faq`. Dev log shows 16× HTTP 200. (One intermediate dev-server run returned 500s from a torn `.next/routes-manifest.json` after the first server was killed mid-write; resolved by removing `.next` and restarting — an environment race, not a page bug.)
- Text-only output throughout: no screenshots taken or needed.

## Still open
1. **Full `npm run build` is blocked by `LobbySafety.tsx:103`** — another worker's concurrent type error. Needs that worker's fix; my pages compile and render (see above). Re-run the full build once it lands.
2. **Contrast ratios are calculated, not tool-measured** — confirm with a measurement pass in M00 as the tokens require.
3. **Calibration OPEN** — ping timing, zone sizes, match length, head start: no final numbers published anywhere on my pages; the demo caption says so. Needs the calibration decision before any of these can be stated as fact.
4. **Placeholder site URL** — production build refuses until `NEXT_PUBLIC_SITE_URL` is set to the real domain (trademark gate, not mine).
5. **Visual check on a real phone** — text-only verification done; the founder / owner run still needs to see the hero, demo map, and pick-a-side cards on a real device, including 130%-zoom and wall-display-style checks carried over from the ResOS run.
6. **No live stats** — the landing deliberately has no counters (nothing invented). If the founder wants SCRAM-style live counters later, they need a real data source first.
