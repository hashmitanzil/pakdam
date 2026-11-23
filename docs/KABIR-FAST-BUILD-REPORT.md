# Kabir fast build — Pakdam v2.1 Slice 1 (2026-11-16)

Founder instruction: complete development fast, never at the cost of a skipped check or a weakened assertion. Built in 3 parallel workstreams (front-end, realtime, public website + admin), then full verification by Kabir. Two real failures were found and fixed during verification — neither was skipped.

## What was built

### 1. v2.1 front-end top 10 (apps/web)
- Next-zone preview + way-back guide (NextZonePanel; zone drawn solid, next zone dashed; "No zone shrink scheduled" stated plainly when none configured).
- Approximate-area feedback: shaded ping areas, hot/cold readout, Map ⇄ Compass-radar toggle. Hunters never see exact pins.
- Fresh-vs-stale language everywhere ("Last reported X min ago"; fresh solid, stale hollow/greyed; suspended = "Suspended — location unknown").
- Floating top HUD (timer, phase, players still free, next-ping countdown, zone state) + bottom thumb zone with ONE primary action per role (Catch for Hunters, "I'm safe" for Runners); safety bar separate and always visible.
- Two-step catch with visible claim state (requested / awaiting-confirmation / confirmed / disputed / expired) + wrong-code cooldown (3 attempts → 30 s, calibration OPEN).
- Always-visible SOS + silence alarm (own location stopped → "Location stopped — check your phone", explicitly not an accusation) + post-game all-safe check ("I'm safe" / "I need help — tell the host", 140 chars max).
- Pre-game readiness checklist in lobby (location permission, GPS quality, Wake Lock, network, briefing, verbatim pre-match warning with required acknowledgement, recorded in the event log).
- Host setup mode in /create: 3-step wizard, zone editor (keyboard-operable: arrows move centre, +/- radius, U undo), no-go areas, area-check code, save-as-preset in localStorage, required venue-safety tick.
- Results recap: timeline of non-sensitive events, awards computed from data, end-of-round reveal (says plainly "No hiding positions were recorded in this demo" instead of inventing positions), all-safe check. No rematch button (HNT-031 is P1).
- Role-split toolbars + colour-blind theme (persisted, `cb-theme` on `<html>`, shape+letter team markers) + map style toggle (Standard/Satellite/Dark/High-contrast, real MapLibre raster switch).

### 2. Realtime — v2.1 frozen contract wired (code only, no deployment)
- Shared WS envelopes rewritten to 17 §3.3: credential-free `hello`, `auth.refresh` the only ticket-bearing message, full client/server unions, PlayerView/CatchView (no hashes), close-code action map, `helloHasCredential()`, `WS_OPEN_CALIBRATION` (all null = OPEN). Stale v2 hello-with-ticket shape deleted.
- PakdamSocket rewritten: ticket only in `?ticket=` handshake, ticketProvider() over HTTPS, auth.refresh on ticket.renewal-required, exponential backoff + jitter (no reconnect on 1000/4403/4409; 4401 fetches a fresh ticket and reconnects once), snapshot.request/resync.request with lastServerSeq, stale events (serverSeq <= last applied) dropped, idempotencyKey on every command, heartbeat with missed-heartbeat counter, visibilitychange suspension notice + fresh snapshot on visible.
- Workers/DO: WsTicketStore (hash-only, single-use, TICKET_REUSED/INVALID/EXPIRED, new issue invalidates earlier unredeemed tickets), validateHello (credential-bearing hello → VALIDATION_FAILED), buildWsSnapshot (recipient-filtered, no coordinates/pings/token hashes), close-code mapping, renewal-required/auth-refreshed, missed-heartbeat counter. Telemetry counts-only.
- New tests: workers 9 new (12 total), engine ws-protocol 5 new (mock WebSocket, no network).

### 3. Public website + admin, P0 only (apps/web)
- New routes: /how-it-works, /game-modes (Classic only, later modes unnamed/undated), /about, /contact (validated form, on-device storage, ref CT-XXXX, no invented contact), /faq (10 Q&As + JSON-LD), /grievance (Rule 20, GRV-XXXX reference, status lookup), /accessibility (WCAG 2.2 AA statement + working persisted toggles), /profile (guest stats from local rooms, no account in P0).
- SEO: sitemap.ts (12 public routes), robots.ts, per-page metadata/canonicals (server pages; client pages cannot carry metadata — see gaps).
- Admin P0 expanded: safety/incident events, grievance queue with status controls, bug-report queue, read-only service-status card (honest: Worker not deployed, Supabase not connected, no fake green lights). Super-admin notice: separate staff surface, MFA, server-enforced permissions — NOT this page. No live location in admin.

## Verification (real output, run by Kabir after all workers finished)
- Engine tests: 15 pass, 0 fail, 3 skipped (Phase 1 native, by design). `npm test` — 18 tests total in engine (15 pass + 3 skip).
- Workers tests: 12 pass, 0 fail (after rebuilding shared + workers; the first run showed only 3 because dist/ was stale — rebuilt, then all 12 ran).
- Typecheck (`npm run typecheck`, all 4 workspaces): clean — after fixing 1 real error found by it: help/page.tsx grievance record type was too narrow (ref/status only, object had 9 fields).
- Production build (`npm run build`): succeeds, 22 static pages (was 12).
- Smoke test (`next start`, port 3102): 20/20 routes HTTP 200 — /, /create, /join, /host, /help, /safety, /legal, /install, /admin, /how-it-works, /game-modes, /about, /contact, /faq, /grievance, /accessibility, /profile, /manifest.webmanifest, /sitemap.xml, /robots.txt. Landing HTML contains the foreground-only warning.
- Failures found and fixed during verification (not skipped): (1) ws-protocol test resolved the client source to `packages/apps/web/...` (one `../` short — fixed to `../../../../apps/...`); (2) ws-protocol backoff test asserted `received.length === 0` after a stale event, but onMessage had legitimately received 3 earlier messages — assertion corrected to "count unchanged"; (3) help/page.tsx type error above.

## What is still NOT done — exactly what blocks it
- Live multi-device realtime: NO deployment. Needs Cloudflare account + API token (Workers/DO permissions), Supabase project URL + anon/service keys, tile provider key. None invented, none present. Supabase Auth method still OPEN; migrations not applied to a live DB.
- DO handler answers VALIDATION_FAILED for unimplemented game-command types — catch/safety/location commands are protocol-layer only so far, not yet applied by the DO.
- No live ping feed in demo mode: hot/cold + radar only have data after the labelled demo-simulation button; nearest-Hunter banner is a placeholder statement; production needs a coarse server ping feed.
- Host resolution of disputed catches has no store function (confirm/dispute only) — UI states host reviews in person; no automatic tag on inconclusive evidence.
- Calibration all OPEN placeholders: silence interval (60 s), hot/cold thresholds, wrong-code cooldown (30 s), zone grace, wsTicketTtlSeconds, heartbeat interval, missed-heartbeat limit, reconnect attempts/backoff — field measurement required (M00).
- Per-page metadata missing on the 4 client pages (Contact, Grievance, Accessibility, Profile) — App Router forbids metadata in 'use client' files; needs server-page + client-component split.
- Accessibility settings apply on the Accessibility page only (site-wide needs a layout-level provider).
- Canonical/sitemap base URL is a placeholder (`https://pakdam.example`, overridable via NEXT_PUBLIC_SITE_URL) — real domain undefined; do not publish until set + trademark gate clears.
- Legal pages are DRAFT — lawyer review, DPDP review, grievance-officer contact, response timelines, separate /legal/terms|privacy|community pages still missing.
- No server persistence, no staff auth, no CMS/approval workflow — grievances/contact/bugs live in localStorage on one device; admin has no auth (demo queue view).
- Not verified in a browser: Playwright e2e is a skeleton, not run; Wake Lock on iOS, colour-blind greyscale check, and visual checks still to be done by the verifier (Meera).

## How to run
```
cd pakdam-app
npm install
npm test        # engine (15 pass) + workers (12 pass)
npm run dev     # http://localhost:3000 — demo mode, playable end-to-end
```
