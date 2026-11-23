import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const { MAX_FIX_ACCURACY_METERS, LOCATION_FRESHNESS_SECONDS } = await import(
  '@pakdam/shared'
);
const logic = await import('../src/components/hud/play-map-logic.ts');
const { shouldWatchLocation } = logic;

/**
 * v28-repro-fixstop.test.mjs — RED reproduction tests for the client
 * fix-stop half of the DO cap (Arjun, QA) + F14 demo hidden-tab
 * ejection (Diya follow-up).
 *
 * LANDED STATE (re-checked during the verification run):
 *  - HELPER LANDED (Meera): `shouldWatchLocation(phase, hidden)`
 *    in play-map-logic.ts — the gate itself is correct and tested
 *    in her v28-fix-stop.test.mjs. The tests below drive it
 *    directly (green).
 *  - WIRING STILL MISSING: the play page never calls it (its watch
 *    effect still sends whenever accuracy <= 1000 and mode==='live'),
 *    the socket heartbeat is not paused while hidden
 *    (websocket.ts unchanged), and the demo (4a) does not freeze
 *    hidden time (F14, no helper landed for it). Those three are
 *    the remaining red tests in this file.
 *    UPDATE — all three LANDED during the verification run:
 *    the page gates the watcher via shouldWatchLocation (:465),
 *    websocket.ts pauses the heartbeat on hide (visibilityHandler
 *    :661-681 → stopHeartbeat :574), and (4a) excludes hidden time
 *    via hiddenGapTotalMsRef + the suspended guard. This file is
 *    now GREEN (15 tests); the pre-fix mirrors are kept as
 *    MECHANISM records of the old shape.
 *
 * FOUNDER SYMPTOM (2026-11-22): a phone left on the play screen
 * sends ~1 GPS fix/s (~86,400 DO requests/day) — and keeps sending
 * after the match ends and while the tab is hidden.
 *
 * DEFECT (c): the play page's location-watch callback
 * (play/page.tsx:369-400) sends whenever the fix is within
 * ±1000 m (`MAX_FIX_ACCURACY_METERS`) and `mode === 'live'` — it
 * never checks the phase and never checks `document.hidden`. Its
 * effect deps are `[roomId, myPlayerId, mode]`, so a terminal phase
 * does not even re-run it. `watchLocation` itself
 * (lib/geolocation.ts) has NO visibility handling either, despite
 * its header claiming "Location stops when the tab hides". The
 * socket's heartbeat (`lib/websocket.ts` `startHeartbeat`) likewise
 * sends every interval while the socket is OPEN, hidden or not.
 *
 * WHAT IS REAL vs MIRROR here:
 *  - `MAX_FIX_ACCURACY_METERS` / `LOCATION_FRESHNESS_SECONDS`
 *    are the REAL shared constants.
 *  - The SEND GATE and the DEMO (4a) DECISION below are VERBATIM
 *    mirrors of the production code (play/page.tsx), driven with
 *    fake sockets / explicit `nowMs` ticks — no real timers, no
 *    React, no DOM. When Meera lands the fix, these mirrors MUST
 *    be re-pointed at the real exported helper (a send gate in
 *    lib, and the fixed (4a) decision) — the mirrors exist to prove
 *    the bugs, not to become a second implementation.
 *  - The heartbeat test is a SOURCE pin (the timer is private to
 *    `PakdamSocket`; only the socket itself can pause it, so any
 *    correct fix must touch `startHeartbeat` or the visibility
 *    handler in `websocket.ts`).
 *
 * F14 — DEMO HIDDEN-TAB EJECTION (Diya follow-up):
 *  demo (4a) (play/page.tsx:452-469) uses wall-clock
 *  `now - lastSeenMs >= 30 s` and runs BEFORE the stale-fix freeze
 *  (:500). The 1 s clock (:296-299, `setInterval(setNowMs)`) is
 *  throttled while the tab is hidden, so it fires on return with
 *  `now` jumped — the first tick after a >30 s hide ejects
 *  immediately. The LIVE side is already safe (server (4a) exempts
 *  suspended seats — pinned in v28-repro-alarm.test.mjs); the DEMO
 *  side has no such exemption. Also note the founder's 2-minute
 *  seat hold (MEMORY.md 2026-11-22, v29): while away the seat is
 *  frozen, not shielded — and gets NO GPS ejection. F14 is the
 *  demo-side equivalent of that rule.
 *
 * Labels follow play-map-v27.test.mjs:
 *  - REPRODUCTION — fails pre-fix, passes after the fix.
 *  - MECHANISM — passes pre-fix, pins why the break happens.
 *  - PIN — passes pre-fix, behaviour the fix must NOT break.
 */

const T0 = 1_780_000_000_000;
const FIX = { lat: 25.5941, lng: 85.1376, accuracyMeters: 10, timestampMs: T0 };

class FakeSocket {
  sent = [];
  sendLocationUpdate(fix) {
    this.sent.push(fix);
    return true;
  }
}

// ---------------------------------------------------------------------------
// (c) The fix-send gate — VERBATIM mirror of play/page.tsx:369-400.
// The callback sends whenever accuracy <= MAX and mode === 'live'.
// It takes NO phase and NO hidden flag: those parameters are accepted
// here (and ignored, exactly like production) so the tests can show
// the sends that must not happen.
// ---------------------------------------------------------------------------

function currentSendGate({ fix, mode, phase, hidden, socket }) {
  void phase;
  void hidden;
  if (fix.accuracyMeters <= MAX_FIX_ACCURACY_METERS) {
    if (mode === 'live') {
      socket.sendLocationUpdate(fix);
    }
  }
}

function sendFix({ fix = FIX, mode = 'live', phase = 'ACTIVE', hidden = false } = {}) {
  const socket = new FakeSocket();
  currentSendGate({ fix, mode, phase, hidden, socket });
  return socket.sent.length;
}

// ---------------------------------------------------------------------------
// (c) Fix sends after a terminal phase / while hidden.
// ---------------------------------------------------------------------------

test('v28: no fixes after a TERMINAL phase (landed helper — shouldWatchLocation)', () => {
  for (const phase of ['COMPLETED', 'CANCELLED', 'ABANDONED', 'EXPIRED']) {
    assert.equal(
      shouldWatchLocation(phase, false),
      false,
      `the watcher must not run after ${phase}`,
    );
  }
  assert.equal(shouldWatchLocation('RESOLVING', false), false);
  assert.equal(shouldWatchLocation('LOBBY', false), false);
});

test('v28: no fixes while document.hidden (landed helper — shouldWatchLocation)', () => {
  for (const phase of ['ACTIVE', 'HEAD_START', 'SAFETY_PAUSED']) {
    assert.equal(
      shouldWatchLocation(phase, true),
      false,
      `a hidden tab must not watch in ${phase}`,
    );
  }
});

test('v28: ACTIVE + visible still watches (landed helper — shouldWatchLocation)', () => {
  assert.equal(shouldWatchLocation('ACTIVE', false), true);
  assert.equal(shouldWatchLocation('HEAD_START', false), true);
  assert.equal(shouldWatchLocation('SAFETY_PAUSED', false), true);
});

test('v28 MECHANISM (passes — pins the PRE-FIX page behaviour, mirror only): the old callback sent after a terminal phase / while hidden — it never checked phase or hidden', () => {
  // The mirror below is the page's OLD callback VERBATIM
  // (play/page.tsx watch effect, deps [roomId, myPlayerId, mode]
  // — no phase, no hidden). It still sends in both cases — that is
  // the pre-fix shape, kept as a record. The LIVE page is now
  // gated by `shouldWatchLocation` (see the landed test below):
  // `shouldWatchLocation(phase, document.hidden)` at play/page.tsx
  // :465, and the effect re-runs on `phase`.
  assert.equal(sendFix({ phase: 'COMPLETED' }), 1, 'the pre-fix mirror still sends after COMPLETED');
  assert.equal(sendFix({ phase: 'ACTIVE', hidden: true }), 1, 'the pre-fix mirror still sends while hidden');
  assert.equal(sendFix({ phase: 'COMPLETED', hidden: true }), 1);
});

test('v28: the play-page watcher is gated by shouldWatchLocation (landed wiring — phase + hidden)', () => {
  const src = readFileSync(
    new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(
    src.includes('shouldWatchLocation'),
    'play/page.tsx must consult shouldWatchLocation (phase + hidden) before starting / keeping the GPS watcher',
  );
  assert.ok(
    src.includes("if (!shouldWatchLocation(phase, document.hidden)) return;"),
    'the gate must be applied inside the watcher (phase + hidden)',
  );
});

test('v28 PIN (passes pre-fix — must keep passing): ACTIVE + visible still sends (the live game must keep working)', () => {
  assert.equal(sendFix({ phase: 'ACTIVE', hidden: false }), 1);
  assert.equal(sendFix({ phase: 'HEAD_START', hidden: false }), 1);
  assert.equal(sendFix({ phase: 'SAFETY_PAUSED', hidden: false }), 1);
});

test('v28 PIN (passes pre-fix — must keep passing): a fix worse than ±1000 m is never sent, whatever the phase', () => {
  const rough = { ...FIX, accuracyMeters: 1500 };
  assert.equal(sendFix({ fix: rough, phase: 'ACTIVE', hidden: false }), 0);
  assert.equal(sendFix({ fix: rough, phase: 'COMPLETED', hidden: false }), 0);
});

test('v28 PIN (passes pre-fix — must keep passing): demo mode never sends to the live socket', () => {
  assert.equal(sendFix({ mode: 'demo', phase: 'ACTIVE', hidden: false }), 0);
});

// ---------------------------------------------------------------------------
// Heartbeat while hidden — source pin (the timer is private to PakdamSocket).
// ---------------------------------------------------------------------------

function methodBody(src, startMarker) {
  const at = src.indexOf(startMarker);
  if (at < 0) return null;
  const next = src.indexOf('\n  private ', at + startMarker.length);
  return next < 0 ? src.slice(at) : src.slice(at, next);
}

test('v28 (landed — heartbeat pauses while hidden): the socket heartbeat must pause while document.hidden', () => {
  const src = readFileSync(
    new URL('../src/lib/websocket.ts', import.meta.url),
    'utf8',
  );
  const heartbeat = methodBody(src, 'private startHeartbeat');
  assert.ok(heartbeat !== null, 'websocket.ts must still have startHeartbeat');
  const visibility = methodBody(src, 'private attachVisibility');
  assert.ok(visibility !== null, 'websocket.ts must still have attachVisibility');
  const heartbeatPauses =
    /document\.hidden/.test(heartbeat) || /stopHeartbeat/.test(visibility);
  assert.ok(
    heartbeatPauses,
    'startHeartbeat must check document.hidden, or the visibility handler must stopHeartbeat() on hide — currently the interval sends heartbeat while the socket is OPEN, hidden or not',
  );
});

test('v28 MECHANISM (passes — records the LANDED layering, Diya F13): watchLocation itself has NO visibility handling — the pause lives with the caller', () => {
  // The header used to claim "Location stops when the tab hides"
  // while nothing implemented it (the original gap this test
  // pinned). v28 (Diya F13) corrected the header AND landed the
  // pause in the CALLER (play/page.tsx — shouldWatchLocation gate
  // + visibilitychange listener that stops/restarts the watch).
  // This helper stays a plain watch by design.
  const src = readFileSync(
    new URL('../src/lib/geolocation.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    src.includes('The pause lives with the') && src.includes('CALLER'),
    'geolocation.ts header must state the pause lives with the caller (Diya F13)',
  );
  assert.ok(
    !src.includes("addEventListener('visibilitychange'") &&
      !src.includes('addEventListener("visibilitychange"'),
    'watchLocation itself must register no visibility listener — the pause is the caller’s job, not a second implementation here',
  );
  assert.ok(
    src.indexOf('document.hidden') < src.indexOf('import {'),
    'document.hidden must appear only in the header comment (the layering note), never in watchLocation’s code',
  );
});

// ---------------------------------------------------------------------------
// F14 — demo (4a) hidden-tab ejection.
// MIRROR of play/page.tsx (the outside-zone effect's demo (4a)
// block + its non-ACTIVE early return), updated to the LANDED
// v28 shape: `effectiveNow = now - hiddenGapTotalMs` (hidden time
// excluded, Diya F14) and no ejection while the seat is suspended
// (F16). The effect runs on the 1 s clock's nowMs; while the tab
// is hidden the clock is throttled, so NO ticks fire during the
// hide — the first tick after return carries the jumped `now`.
// `hiddenGapTotalMs` is accumulated by the page's visibilitychange
// listener (hiddenSinceRef → hiddenGapTotalMsRef) between ticks.
// ---------------------------------------------------------------------------

function makeDemoState({ startedAtMs = T0, fixTimestampMs = T0, lastFixAtMs = null } = {}) {
  return {
    phase: 'ACTIVE',
    mode: 'demo',
    startedAtMs,
    myFixTimestampMs: fixTimestampMs,
    lastFixAtMs,
    missingFixEjected: false,
    outsideSinceMs: null,
    hiddenGapTotalMs: 0,
    connectionState: 'connected',
  };
}

/** One tick of the mirrored effect. Returns { ejected } for this tick. */
function demoEffectTick(state, nowMs) {
  if (state.phase !== 'ACTIVE' && state.phase !== 'HEAD_START') {
    // play/page.tsx — a non-live phase freezes the spell AND
    // resets the (4a) once-flag.
    if (state.outsideSinceMs !== null) state.outsideSinceMs = nowMs;
    state.missingFixEjected = false;
    return { ejected: false };
  }
  if (state.mode === 'demo') {
    if (state.startedAtMs !== null && !state.missingFixEjected) {
      const lastSeenMs = Math.max(
        state.myFixTimestampMs ?? Number.NEGATIVE_INFINITY,
        state.lastFixAtMs ?? Number.NEGATIVE_INFINITY,
        state.startedAtMs,
      );
      // v28 (Diya F14): hidden time does not count toward the 30 s
      // no-fix ejection — the clock runs on `effectiveNow`, the
      // wall clock minus all hidden time since mount. A suspended
      // seat (hidden tab, or GPS denied — F16) never ejects either.
      const effectiveNow = nowMs - state.hiddenGapTotalMs;
      if (
        effectiveNow - lastSeenMs >= LOCATION_FRESHNESS_SECONDS * 1000 &&
        state.connectionState !== 'suspended'
      ) {
        state.missingFixEjected = true;
        return { ejected: true };
      }
    }
  }
  return { ejected: false };
}

test('v28 F14 (landed): hiding the tab for 35 s must NOT eject on the first tick after return', () => {
  const state = makeDemoState({ startedAtMs: T0, fixTimestampMs: T0 });
  // Visible: ticks every 1 s, fix seen at T0. 10 s in, no ejection.
  for (let s = 0; s <= 10; s++) {
    assert.equal(
      demoEffectTick(state, T0 + s * 1000).ejected,
      false,
      `visible tick at +${s}s must not eject (last fix 0s–10s ago)`,
    );
  }
  // HIDDEN 10 s → 45 s: the 1 s clock is throttled — NO ticks fire.
  // The watcher is frozen by the browser, not "no location". On
  // return the page's visibilitychange listener has accumulated
  // the 35 s hidden span into hiddenGapTotalMs (T0+10s → T0+45s).
  state.hiddenGapTotalMs = 35_000;
  state.connectionState = 'connected';
  const onReturn = demoEffectTick(state, T0 + 45_000);
  assert.equal(
    onReturn.ejected,
    false,
    'the first tick after a 35 s hide must NOT eject — the hidden time is frozen browser time, not 35 s without GPS (cf. the live rule: suspended seats are exempt from (4a); cf. the 2-min seat hold)',
  );
});

test('v28 F14 (landed): a suspended seat never ejects, even after 60 s with no fix (F16 guard)', () => {
  const state = makeDemoState({ startedAtMs: T0, fixTimestampMs: T0 });
  state.connectionState = 'suspended';
  assert.equal(
    demoEffectTick(state, T0 + 60_000).ejected,
    false,
    'a suspended seat (hidden tab, or GPS denied) is held, not lost — the (4a) ejection must not take it',
  );
});

test('v28 F14 PIN (passes pre-fix — must keep passing): a genuinely silent demo seat still ejects at 30 s when the tab stays VISIBLE', () => {
  const state = makeDemoState({ startedAtMs: T0, fixTimestampMs: T0 });
  // Visible the whole time, fixes stop at T0: ticks every 1 s.
  let ejectedAt = null;
  for (let s = 0; s <= 45; s++) {
    if (demoEffectTick(state, T0 + s * 1000).ejected && ejectedAt === null) {
      ejectedAt = s;
    }
  }
  assert.equal(
    ejectedAt,
    30,
    `a visible seat with no fix for 30 s must still eject at +30 s (the fix must not remove genuine missing-fix ejection) — got ${ejectedAt}`,
  );
});

test('v28 F14 PIN (passes pre-fix — must keep passing): a short hide (return inside 30 s) never ejects', () => {
  const state = makeDemoState({ startedAtMs: T0, fixTimestampMs: T0 });
  for (let s = 0; s <= 10; s++) {
    assert.equal(demoEffectTick(state, T0 + s * 1000).ejected, false);
  }
  // Hidden 10 s → 25 s, return tick at +25 s: 25 s < 30 s.
  assert.equal(demoEffectTick(state, T0 + 25_000).ejected, false);
  // And the seat survives the next visible ticks too (still < 30 s).
  assert.equal(demoEffectTick(state, T0 + 26_000).ejected, false);
});

test('v28 F14 PIN (passes pre-fix — must keep passing): a non-live phase resets the (4a) once-flag instead of ejecting', () => {
  const state = makeDemoState({ startedAtMs: T0, fixTimestampMs: T0 });
  state.phase = 'SAFETY_PAUSED';
  assert.equal(demoEffectTick(state, T0 + 60_000).ejected, false);
  assert.equal(state.missingFixEjected, false, 'the pause clears the once-flag');
});
