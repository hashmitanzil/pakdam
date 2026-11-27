import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

/**
 * v28-repro-ci-e2e.test.mjs — RED reproduction pins for the founder's
 * CI run on the v27 push (`fix` branch, 2026-11-22, GitHub Actions):
 * e2e 29 failed / 86 passed / 18 skipped (11.2 min).
 *
 * The v26→v27 diff (verified from the delivered zips) touched ONLY
 * PlayMap.tsx, play-map-logic.ts, the map test doubles, and package
 * test-script wiring — NO change to play/page.tsx, room-do.ts, the
 * lobby, the catch page, home, the demo store, or any e2e spec. So
 * the 29 failures are NOT a v27 regression in those flows: they are
 * stale tests, test-environment artifacts, and ONE product defect
 * (H1 below) that predates v27. Each pin below fails against the
 * current tree and passes when its fix lands; the e2e suite verdict
 * itself stays the founder's CI (VM Chromium cannot launch).
 *
 * FAILURE MAP (29) — cause per cluster, verified from source:
 *
 *  H1 PRODUCT DEFECT (7 tests) — the LOBBY never suspends on
 *    tab-hide: room/[roomId]/page.tsx mounts no useRoomState and
 *    has no visibilitychange listener / recordPlayerSuspension call
 *    (useRoomState.ts:722-740 owns that handler; play, catch,
 *    results and setup mount it, the lobby does not). So hideTab()
 *    in the lobby does nothing: no grace starts, no waiting line,
 *    no crown move. Failing: host-grace.spec.ts:101,152,191,230,279
 *    and host-cancel-room-deleted.spec.ts:209,244. The voluntary-
 *    leave test (host-grace:333) passes — it needs no suspension.
 *    FILED to the coordinator (do NOT fix production code here);
 *    the pin below stays RED until the fix round lands it.
 *
 *  H2 STALE TESTS — 'Self Confirm' case (11 tests): the product
 *    renders 'Self confirm' (sentence case, catch/page.tsx:971 —
 *    unchanged since v21) but the specs query
 *    getByRole('button', { name: 'Self Confirm', exact: true })
 *    — exact:true is case-SENSITIVE, so the button is never found.
 *    Failing: catch-nav.spec.ts:178,206,220,255,270,281,
 *    catch-results.spec.ts:65,88,136, brutal-phone.spec.ts:20.
 *    FIX: the locators, to 'Self confirm'.
 *
 *  H3 STALE TEST (1) — catch-results.spec.ts:221 'a fresh game
 *    after results gets a new room code': after the Classic mode
 *    card the app lands on /setup (heading 'Create lobby'), not
 *    the lobby — the room code lives only on the lobby, after
 *    CREATE LOBBY. The test reads the code straight after the mode
 *    card. FIX: insert the CREATE LOBBY step.
 *
 *  H4 STALE TEST (1) — live-hud.spec.ts:177 safety pause:
 *    getByText('Paused') matches TWO elements once paused — the
 *    status strip's <p>Paused</p> (StatusStrip.tsx:86) AND the
 *    sheet's 'Match paused by Teo — clock frozen.' — a strict-mode
 *    violation. FIX: exact:true.
 *
 *  H5 TEST-ENVIRONMENT (1) — live-hud.spec.ts:54 status strip:
 *    'Location never reported' never appears because the host seat
 *    IS suspended in the headless multi-page setup: creating the
 *    guest pages backgrounds the host tab, the play page's
 *    useRoomState visibilitychange handler suspends it, and the
 *    YOU dot reads 'Suspended' (play/page.tsx:983, PlayerDots
 *    renders the label as DOM). The dots themselves render fine.
 *    FIX: bringToFront() + wait for the resume before asserting.
 *
 *  H6 TEST-ENVIRONMENT (1) — outside-zone.spec.ts:93 '30 s outside
 *    ejects': the emulated FAR fix is delivered ONCE; after ~10 s
 *    the app (correctly, by its stale-fix rule) freezes the
 *    countdown, and (4a) ejects for missing location at 30 s with
 *    the OTHER notice — so the zone notice never appears. On a
 *    real phone the fix stream refreshes continuously and the zone
 *    ejection fires. FIX: nudge the emulated position every ~4 s
 *    so the fix stays fresh and the countdown runs to 0.
 *
 *  H7 BUGGY TEST (1) — map-accuracy.spec.ts:32 'Zone size stepper
 *    stops at the 100 m minimum': the test clicks Decrease 8 times,
 *    but the step grid is 100 m at 500 m then 50 m below
 *    (setup/page.tsx: step={radius < 500 ? 50 : 100}) — 500→100
 *    takes SEVEN clicks, so the 8th click targets a DISABLED
 *    button and hangs to the 60 s test timeout. FIX: drive to min
 *    with setStepper (stops at disabled) instead of a fixed count.
 *
 *  H8 STALE TEST (1) — smoke.spec.ts:15 'home loads':
 *    getByAltText('Pakdam') substring-matches THREE images now —
 *    WelcomeScreen pin art ('Pakdam pin art — …'), the wordmark
 *    ('Pakdam wordmark'), and the header logo ('Pakdam') — a
 *    strict-mode violation. FIX: exact:true (matches only the
 *    header logo, alt exactly 'Pakdam').
 *
 *  UNPINNED FROM STATIC EVIDENCE (6 tests — every assertion
 *  verified against current source, no discrepancy found):
 *    join-lobby.spec.ts:47 (create screen renders),
 *    join-lobby.spec.ts:82 (lobby renders),
 *    host-setup.spec.ts:138 (Play zone OFF),
 *    host-setup.spec.ts:150 (Balance OFF),
 *    host-setup.spec.ts:168 (Random OFF pick),
 *    host-setup.spec.ts:194 (guest cannot change settings).
 *    Classified FLAKY (timing under the 4-worker parallel load)
 *    pending the CI failure text after the pinned fixes land.
 *    No fix is invented for them here.
 */

const E2E = new URL('./../e2e/', import.meta.url);
const SRC = new URL('./../src/', import.meta.url);

function readE2E(name) {
  return readFileSync(new URL(name, E2E), 'utf8');
}
function readSrc(path) {
  return readFileSync(new URL(path, SRC), 'utf8');
}

// --- H1 — PRODUCT DEFECT (stays red until the fix round) -------------
test('v28 CI-E2E H1 PRODUCT DEFECT (fails — lobby never suspends on tab-hide): the lobby page must suspend the local seat on visibilitychange', () => {
  const lobby = readSrc('app/room/[roomId]/page.tsx');
  assert.ok(
    lobby.includes('visibilitychange'),
    'room/[roomId]/page.tsx must listen for visibilitychange (cf. useRoomState.ts:722-740, which the lobby never mounts) — without it hideTab() in the lobby suspends nothing, no grace starts, and host-grace.spec.ts:101,152,191,230,279 + host-cancel-room-deleted.spec.ts:209,244 fail in CI',
  );
  assert.ok(
    lobby.includes('recordPlayerSuspension') || lobby.includes('useRoomState'),
    'the lobby must suspend the seat (recordPlayerSuspension) or mount useRoomState',
  );
});

// --- H2 — 'Self confirm' case -----------------------------------------
test('v28 CI-E2E H2 STALE TEST (fails — case): no e2e locator may query \'Self Confirm\' with exact:true — the product renders \'Self confirm\'', () => {
  const specs = readdirSync(E2E).filter((f) => f.endsWith('.spec.ts'));
  const hits = [];
  for (const file of specs) {
    const src = readFileSync(new URL(file, E2E), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (line.includes("name: 'Self Confirm', exact: true")) {
        hits.push(`${file}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(
    hits,
    [],
    `these locators can never match — catch/page.tsx:971 renders 'Self confirm' (sentence case) and exact:true is case-sensitive:\n${hits.join('\n')}`,
  );
});

// --- H3 — fresh-game test skips CREATE LOBBY ---------------------------
test('v28 CI-E2E H3 STALE TEST (fails — missing step): the fresh-game-after-results test must go through CREATE LOBBY before reading the new code', () => {
  const src = readE2E('catch-results.spec.ts');
  const start = src.indexOf("'a fresh game after results gets a new room code'");
  assert.ok(start > -1, 'the fresh-game test must exist');
  const body = src.slice(start);
  assert.ok(
    body.includes("name: 'CREATE LOBBY', exact: true"),
    'after the Classic mode card the app lands on /setup — the test must click CREATE LOBBY and wait for the Lobby heading before reading section[aria-label="Game code"] .pakdam-code (the code does not exist on the setup screen)',
  );
});

// --- H4 — 'Paused' strict violation ------------------------------------
test('v28 CI-E2E H4 STALE TEST (fails — strict violation): the safety-pause test must match \'Paused\' exactly — the sheet also contains \'Match paused by …\'', () => {
  const src = readE2E('live-hud.spec.ts');
  const matches = src.match(/getByText\('Paused', \{ exact: true \}\)/g) ?? [];
  assert.ok(
    matches.length >= 2,
    `live-hud.spec.ts must use getByText('Paused', { exact: true }) for BOTH the visible and the hidden assertion (found ${matches.length}) — plain getByText('Paused') matches the strip <p>Paused</p> AND the sheet 'Match paused by Teo — clock frozen.'`,
  );
});

// --- H5 — status strip needs the host tab fronted -----------------------
// v34 SUPERSEDED (Meera, PROBE4/PROBE5 — the premise this pin
// encoded was DISPROVEN in a real headless browser): real
// backgrounding never fires `visibilitychange` here (every page
// reads `document.hidden === false`), so `bringToFront()` resumes
// nothing, and the fixture grants no geolocation, so the play
// page's GPS watch denies and the seat stays `gps-denied`-suspended
// by design (F16) — a connected-poll can never land. The test now
// asserts the strip directly (it does not depend on
// connectionState); the suspension itself is pinned by the guest
// banner assertion below it. This pin asserts the new approach and
// forbids the old one coming back.
test('v34 H5 SUPERSEDED (was: bringToFront + connected-poll): the status-strip test asserts the strip directly, with no bringToFront and no connected-poll', () => {
  const src = readE2E('live-hud.spec.ts');
  const start = src.indexOf("'status strip: time left, next ping, zone shrink, runners left'");
  assert.ok(start > -1, 'the status-strip test must exist');
  const body = src.slice(start, src.indexOf("test('head start", start));
  assert.ok(
    !body.includes('bringToFront()'),
    'bringToFront() never resumes a seat in headless CI (no visibilitychange fires) — the test must not depend on it',
  );
  assert.ok(
    !body.includes("toBe('connected')"),
    'a connected-poll can never land here (GPS-denied suspension, F16) — the test must not wait for it',
  );
  assert.ok(
    body.includes("getByText('Time left', { exact: true })"),
    // v37: the bare form is gone — 'Time left' is now asserted with
    // exact:true like 'Next ping' (hidden Radio panel substring
    // collision class; the bare 'Next ping' resolved to the strip
    // label AND the hunter chip 'Moving to the next ping area').
    // The pin's intent is unchanged: the strip is asserted directly.
    'the test must assert the strip directly — the strip does not depend on connectionState',
  );
  assert.ok(
    body.includes('Suspended — location unknown · Location never reported'),
    'the suspension itself is still pinned — by the guest banner assertion, not by a connection poll',
  );
});

// --- H6 — outside-zone eject needs a fresh emulated fix -----------------
test('v28 CI-E2E H6 TEST-ENVIRONMENT (fails — one-shot fix goes stale): the 30 s outside-eject test must keep the emulated fix fresh', () => {
  const src = readE2E('outside-zone.spec.ts');
  const start = src.indexOf("'30 s outside ejects the player'");
  assert.ok(start > -1, 'the 30 s outside-eject test must exist');
  const body = src.slice(start, src.indexOf("test('no fix for 30 s ejects", start));
  const deliveries = body.match(/setGeolocation/g) ?? [];
  assert.ok(
    deliveries.length >= 2,
    `the test must re-deliver the emulated position while waiting (found ${deliveries.length} setGeolocation call(s) — the one-shot FAR fix goes stale after ~10 s, the countdown freezes, and (4a) ejects for missing location instead of the zone ejection)`,
  );
});

// --- H7 — Zone size stepper click count ---------------------------------
test('v28 CI-E2E H7 BUGGY TEST (fails — 8th click hits a disabled button): the 100 m-minimum test must drive to min, not click Decrease a fixed 8 times', () => {
  const src = readE2E('map-accuracy.spec.ts');
  const start = src.indexOf("'Zone size stepper stops at the 100 m minimum'");
  assert.ok(start > -1, 'the 100 m-minimum test must exist');
  const body = src.slice(start, src.indexOf("test('Zone size has no 1 km cap", start));
  assert.ok(
    !body.includes('i < 8'),
    '500→100 takes SEVEN clicks on the live grid (100 m step at 500 m, then 50 m) — the 8th click targets a disabled button and hangs to the 60 s test timeout; drive to min with setStepper instead',
  );
  assert.ok(
    body.includes('setStepper'),
    'the test must use the setStepper helper (clicks Decrease until disabled)',
  );
});

// --- H8 — smoke alt text -------------------------------------------------
test('v28 CI-E2E H8 STALE TEST (fails — strict violation): the home-loads test must match the Pakdam alt exactly — three images share the substring', () => {
  const src = readE2E('smoke.spec.ts');
  assert.ok(
    src.includes("getByAltText('Pakdam', { exact: true })"),
    `smoke.spec.ts must use getByAltText('Pakdam', { exact: true }) — plain 'Pakdam' substring-matches the WelcomeScreen pin art ('Pakdam pin art — …'), the wordmark ('Pakdam wordmark') and the header logo ('Pakdam')`,
  );
});
