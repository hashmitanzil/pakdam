import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const store = await import('../src/lib/demo-store.ts');
const {
  createRoom,
  ejectPlayer,
  leaveRoom,
  recordPlayerFix,
  recordPlayerSuspension,
  resumePlayer,
  startDemoMatch,
  tickDemoRoom,
} = store;
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// createRoom validates the config: the default has an empty zone
// boundary, so the test room gets a 3-point triangle (Ranchi).
// Head start None + 10-min round = the setupThreePlayerLobby defaults
// (helpers.ts:156-191: Round length index 0, Head start index 0).
const TEST_CONFIG = {
  ...DEFAULT_ROOM_CONFIG,
  hostOnSiteConfirmed: true,
  headStartSeconds: 0,
  durationSeconds: 600,
  zone: {
    boundary: [
      { lat: 23.3441, lng: 85.3096 },
      { lat: 23.3441, lng: 85.3196 },
      { lat: 23.3541, lng: 85.3146 },
    ],
    shrinkPhases: [],
  },
};

/**
 * v28-host-cancel-209-244.test.mjs — Arjun QA follow-up: why did
 * host-cancel-room-deleted.spec.ts:209 ('demo host backgrounds the
 * tab: the crown moves to the earliest-joined connected guest') and
 * :244 ('demo host leaves while the earliest joiner is suspended')
 * fail in the founder's CI run on the v27 push?
 *
 * VERDICT: NOT explained by H1. The lobby fix (room/[roomId]/page.tsx
 * visibilitychange handler) is irrelevant here — both tests call
 * startDemoMatch (helpers.ts:238), so the hiding seat is on the PLAY
 * page, whose useRoomState handler (useRoomState.ts:722-740) already
 * suspended on tab-hide. The coordinator's flag is confirmed.
 *
 * ROOT CAUSE (CI tree = v27; verified against pakdam-fresh-v26.zip —
 * the v26→v27 diff touched ONLY PlayMap, play-map-logic, map test
 * doubles and test wiring, so v26's play/page.tsx, demo-store.ts,
 * useRoomState.ts, spec and helpers ARE the CI tree):
 *
 * The spec grants NO geolocation and NO geolocation permission (the
 * `context` fixture; cf. outside-zone.spec.ts:40-45, which builds its
 * own context with geolocation + permissions). In headless CI Chromium
 * the watch therefore never delivers a fix — and in the v27 tree the
 * permission-denied error only set a notice (v26 play/page.tsx:403-408:
 * `setFixNotice('Location is off …')`, NO suspension). So every seat
 * is fix-less from match start T0, and the demo (4a) rule fires on
 * each play page's 1 s clock (v26 play/page.tsx:296, :440-470):
 * `now - max(lastFixAt, startedAt) >= 30_000` → the page ejects its
 * OWN seat. No suspended-guard and no hidden-time exclusion existed
 * in v27, so ALL THREE seats eject at T0+30 s — including the host.
 * ejectPlayer calls maybeCompleteOnWin (demo-store.ts:1604), and with
 * 1 hunter + 2 runners (BALANCED_HUNTER_TABLE, 2–4 players → 1 hunter)
 * all runners are gone → completeMatch → phase COMPLETED
 * (demo-store.ts:1158-1187). Once terminal, tickDemoRoom returns
 * early (demo-store.ts:319) and expireHostGrace NEVER runs again —
 * the host grace (deadline hide+30 s, always AFTER T0+30 s because
 * hideTab runs after the match starts) is frozen forever:
 * hostPlayerId stays Teo, hostGraceEndsAtMs stays set.
 *
 * :209 fails DETERMINISTICALLY at the crown poll (:230-235,
 * hostPlayerId → Ana within 45 s): the poll can never match. (The
 * waiting-line assertion at :227-229 passes — the grace IS running —
 * which is why the failure looks like a grace failure.) A second,
 * independent break: the 60 s test timeout (playwright.config.ts:27)
 * cannot hold setup + a real 30 s grace + a 45 s poll unless setup
 * takes ≤ 15 s.
 *
 * :244 fails on the SAME (4a) boundary, but RACIALLY: the transfer
 * itself works (host leaves → Ben, Ana suspended), and the test only
 * breaks if its tail (leave clicks → Ben poll → 2× expectEndRound)
 * crosses T0+30 s — then the match completes, every play page
 * redirects to /results (play/page.tsx terminal effect), and
 * expectEndRound(Ben) finds no More navigation. In loaded CI the
 * post-start stretch crosses 30 s; when it doesn't, :244 passes.
 *
 * CURRENT TREE (v28) — the gate is STILL blocked on both, via a
 * second mechanism layered on the first (v28 F16: play/page.tsx
 * permission-denied now SUSPENDS the seat — demo
 * recordPlayerSuspension 'gps-denied'). In headless CI without a
 * permission grant, all three seats suspend at watch start (~T0+1 s):
 * the host's grace starts then and expires at ~T0+31 s with NO
 * connected successor (Ana+Ben also suspended) → the crown never
 * moves (:209 poll fails; :244's leave finds no successor, so the Ben
 * poll fails). If the permission error never fires, the v27 (4a)
 * mechanism still kills :209 (F14's suspended-guard only protects the
 * suspended host; the two runners still eject at T0+30 s and complete
 * the match). Either branch fails — see pins 2–3 and 5.
 *
 * v28 FIX ROUND (store only): the demo store now gates the grace on
 * reason (GRACE_START_REASONS in demo-store.ts) — 'gps-denied' no
 * longer starts one, mirroring live. Pin 2 (branch A) now pins the
 * FIXED behaviour; pin 8 (the FILED DEFECT) is green. The e2e gate
 * still needs the spec fix above (granted geolocation), because a
 * suspended Ana still cannot take a crown that was never put up for
 * transfer.
 *
 * FIX (test issue — spec fix, this task): grant geolocation +
 * permission at the top of both tests (fixes flow → no F16 suspension,
 * lastFixAt stamped → no (4a) ejection), nudge the emulated position
 * after hideTab to reset the (4a) clock for the tail, and fast-forward
 * the grace in :209 (the established host-grace.spec.ts pattern)
 * instead of waiting out the real 30 s. Pins 6–7 prove the fixed
 * flows at store level; the e2e verdict stays the founder's CI.
 *
 * FILED PRODUCT DEFECT (pin 8, RED — do NOT fix production code
 * here): demo recordPlayerSuspension starts the 30 s host grace for
 * ANY reason, including 'gps-denied' — while live explicitly never
 * starts a grace from GPS denial (play/page.tsx:447-452:
 * reportSuspended('unknown') "(never transfers host, never starts a
 * grace)"). A demo host with GPS denied loses the crown after 30 s
 * while sitting in the app; a live host does not. The store must gate
 * the grace on the reason, mirroring live.
 *
 * Timer hygiene: recordPlayerSuspension schedules one 30 s wake-up
 * timer per room. Every pin below ends with the timer cleared — a
 * host resume clears it, a host leave clears it, and a transfer is
 * followed by a suspend+resume of the new host (which replaces then
 * clears the timer).
 */

/** A started 3-player demo match: Teo (host) + Ana + Ben, ACTIVE. */
function threePlayerMatch() {
  const demo = createRoom('Teo', TEST_CONFIG);
  const host = demo.players[0];
  const joined = (offsetMs) =>
    new Date(Date.parse(host.joinedAt) + offsetMs).toISOString();
  const ana = {
    ...host,
    playerId: 'ana-player-id',
    displayName: 'Ana',
    isHost: false,
    isReady: true,
    briefingConfirmed: true,
    joinedAt: joined(1000),
  };
  const ben = {
    ...host,
    playerId: 'ben-player-id',
    displayName: 'Ben',
    isHost: false,
    isReady: true,
    briefingConfirmed: true,
    joinedAt: joined(2000),
  };
  demo.players.push(ana, ben);
  // The store's own start path (LOBBY → READY_CHECK → COUNTDOWN →
  // HEAD_START, which assigns roles and stamps startedAt = T0).
  startDemoMatch(demo);
  const startedAtMs = Date.parse(demo.room.startedAt);
  tickDemoRoom(demo, startedAtMs + 1000); // head start 0 → ACTIVE
  assert.equal(demo.room.phase, 'ACTIVE');
  return { demo, host, ana, ben, startedAtMs };
}

/** Fix the random role draw after assignRoles (test-only). */
function fixRoles(demo, hunterName) {
  for (const p of demo.players) {
    const isHunter = p.displayName === hunterName;
    p.matchRole = isHunter ? 'hunter' : 'runner';
    p.team = isHunter ? 'hunters' : 'runners';
  }
}

/**
 * Faithful transcription of the play page's demo (4a) missing-fix
 * ejection (v26/v27 tree: play/page.tsx:440-470; current tree:
 * play/page.tsx:524-566, which adds `skipSuspended` — F14 — and the
 * hidden-time exclusion). Each play page runs this on its own 1 s
 * clock against its OWN seat only; the loop below runs it for every
 * seat at the same simulated nowMs. `myFixRef` is null in CI (no fix
 * ever arrives), so lastSeen = max(lastFixAt, startedAt).
 */
function pageNoFixEjection(demo, nowMs, { skipSuspended }) {
  for (const p of demo.players) {
    const lastFixMs = p.lastFixAt ? Date.parse(p.lastFixAt) : null;
    const lastSeenMs = Math.max(
      lastFixMs ?? Number.NEGATIVE_INFINITY,
      Date.parse(demo.room.startedAt),
    );
    if (skipSuspended && p.connectionState === 'suspended') continue;
    if (nowMs - lastSeenMs >= 30_000) ejectPlayer(demo, p.playerId);
  }
}

/** Clear the room's wake-up timer: suspend+resume the current host. */
function clearGraceTimer(demo, hostPlayer) {
  recordPlayerSuspension(demo, hostPlayer.playerId, 'tab-hidden');
  assert.equal(resumePlayer(demo, hostPlayer.playerId), true);
}

function currentHost(demo) {
  return demo.players.find((p) => p.playerId === demo.room.hostPlayerId);
}

// --- :209, v27 CI mechanism (GREEN pin: proves the failure) --------
test(':209 v27: no-fix ejection completes the match at T0+30 s and freezes the host grace forever', () => {
  const { demo, host, ana, startedAtMs } = threePlayerMatch();
  fixRoles(demo, 'Teo'); // 1 hunter (Teo) + 2 runners, the balanced draw

  // hideTab(host) at ~T0+15 s: the play-page handler suspends the host
  // and starts the 30 s grace (deadline ~T0+45 s).
  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');
  assert.equal(host.connectionState, 'suspended');
  assert.ok(demo.hostGraceEndsAtMs !== null);
  const graceEndsAtMs = demo.hostGraceEndsAtMs;

  // T0+31 s: every fix-less seat's own page ejects it (v27 rule: no
  // suspended-guard, no hidden exclusion — the host ejects too).
  pageNoFixEjection(demo, startedAtMs + 31_000, { skipSuspended: false });
  assert.equal(demo.room.phase, 'COMPLETED');
  assert.equal(
    demo.players.filter((p) => p.matchRole === 'runner' && p.ejectedAt === null).length,
    0,
    'no free runner survives T0+30 s',
  );

  // Past the grace deadline the demo alarm ticks — but the room is
  // terminal, so tickDemoRoom returns early and expireHostGrace never
  // runs: the crown is frozen with the suspended host.
  tickDemoRoom(demo, graceEndsAtMs + 1000);
  assert.equal(demo.room.hostPlayerId, host.playerId);
  assert.notEqual(demo.room.hostPlayerId, ana.playerId);
  assert.ok(demo.hostGraceEndsAtMs !== null, 'grace deadline frozen, never cleared');

  // Timer hygiene: the suspended host still holds the crown.
  assert.equal(resumePlayer(demo, host.playerId), true);
});

// --- :209, current tree, branch A: F16 gps-denied fires -------------
// v28 FIX ROUND: the store now gates the grace on reason
// (demo-store.ts GRACE_START_REASONS), so gps-denied suspends the
// seats but starts NO grace — this test pins the FIXED behaviour
// (it used to pin the failure mechanism: the grace started at watch
// start and expired with no successor). The e2e :209 still needs the
// spec fix (granted geolocation) for the poll to pass, because a
// suspended Ana cannot take a crown that was never put up for
// transfer — but no spurious grace runs any more.
test(':209 v28 branch A (FIXED): gps-denied suspends every seat at watch start but starts NO grace, so the crown never moves', () => {
  const { demo, host, ana, ben, startedAtMs } = threePlayerMatch();
  fixRoles(demo, 'Teo');

  // F16 (current play/page.tsx onError): permission-denied suspends
  // the seat — all three suspend at ~T0+1 s, before hideTab runs.
  // The host's suspension must NOT start a grace (live parity:
  // gps-denied maps to reportSuspended('unknown')).
  for (const p of demo.players) recordPlayerSuspension(demo, p.playerId, 'gps-denied');
  assert.equal(host.connectionState, 'suspended');
  assert.equal(demo.hostGraceEndsAtMs, null, 'gps-denied must not start a host grace');

  // hideTab(host) later is a no-op: already suspended (early return),
  // so no fresh grace ever starts.
  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');
  assert.equal(demo.hostGraceEndsAtMs, null);

  // Past the would-be deadline the alarm ticks — but no grace ever
  // ran, so nothing expires and the crown never moves: the host is
  // sitting in the app with GPS denied, exactly like live.
  tickDemoRoom(demo, startedAtMs + 61_000);
  assert.equal(demo.hostGraceEndsAtMs, null);
  assert.equal(demo.room.hostPlayerId, host.playerId);
  assert.notEqual(demo.room.hostPlayerId, ana.playerId);
  assert.equal(demo.room.phase, 'ACTIVE');

  // Timer hygiene: no grace ever started, so no wake-up timer exists.
  assert.equal(resumePlayer(demo, host.playerId), true);
  assert.equal(resumePlayer(demo, ana.playerId), true);
  assert.equal(resumePlayer(demo, ben.playerId), true);
});

// --- :209, current tree, branch B: F16 silent ------------------------
test(':209 v28 branch B: without gps-denied, the runners still eject at T0+30 s (F14 only protects the suspended host)', () => {
  const { demo, host, ana, startedAtMs } = threePlayerMatch();
  fixRoles(demo, 'Teo');

  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');
  const graceEndsAtMs = demo.hostGraceEndsAtMs;
  assert.ok(graceEndsAtMs !== null);

  // v28 (4a) rule skips suspended seats — the host is protected, but
  // Ana and Ben are connected and fix-less, so they eject at T0+31 s
  // and the match completes under the running grace.
  pageNoFixEjection(demo, startedAtMs + 31_000, { skipSuspended: true });
  assert.equal(demo.room.phase, 'COMPLETED');

  tickDemoRoom(demo, graceEndsAtMs + 1000);
  assert.equal(demo.room.hostPlayerId, host.playerId);
  assert.notEqual(demo.room.hostPlayerId, ana.playerId);

  assert.equal(resumePlayer(demo, host.playerId), true);
});

// --- :244, v27 CI mechanism (GREEN pin: transfer works, tail dies) ---
test(':244 v27: the leave transfer works, but the match still completes at T0+30 s under the test tail', () => {
  const { demo, host, ana, ben, startedAtMs } = threePlayerMatch();
  fixRoles(demo, 'Teo');

  // hideTab(Ana) at ~T0+15 s, then the host leaves at ~T0+20 s: the
  // crown skips suspended Ana and goes to Ben — the transfer itself.
  recordPlayerSuspension(demo, ana.playerId, 'tab-hidden');
  assert.equal(ana.connectionState, 'suspended');
  leaveRoom(demo, host.playerId);
  assert.equal(demo.room.hostPlayerId, ben.playerId);

  // T0+31 s: every fix-less seat ejects (v27 rule) and the match
  // completes — after the transfer, so the poll passes, but the
  // expectEndRound tail runs on a COMPLETED room whose play pages
  // have redirected to /results. Racy: fails iff the tail crosses
  // T0+30 s, which loaded CI does.
  pageNoFixEjection(demo, startedAtMs + 31_000, { skipSuspended: false });
  assert.equal(demo.room.phase, 'COMPLETED');
  assert.equal(demo.room.hostPlayerId, ben.playerId);

  clearGraceTimer(demo, currentHost(demo));
});

// --- :244, current tree, branch A: F16 gps-denied fires -------------
test(':244 v28 branch A: gps-denied suspends Ben too, so the host leave finds no connected successor', () => {
  const { demo, host, ana, ben } = threePlayerMatch();
  fixRoles(demo, 'Teo');

  for (const p of demo.players) recordPlayerSuspension(demo, p.playerId, 'gps-denied');
  assert.equal(ben.connectionState, 'suspended');

  // hideTab(Ana) is a no-op (already suspended); the host leaves —
  // leaveRoom transfers only to a CONNECTED seat, and none exists.
  recordPlayerSuspension(demo, ana.playerId, 'tab-hidden');
  leaveRoom(demo, host.playerId);
  assert.equal(demo.room.hostPlayerId, host.playerId);
  assert.notEqual(demo.room.hostPlayerId, ben.playerId);

  // Timer hygiene: the host leave already cleared the wake-up timer.
});

// --- :209 FIXED flow (GREEN pin: proves the spec fix) ----------------
test(':209 FIXED: granted geolocation + fast-forwarded grace transfers to Ana with the match still live', () => {
  const { demo, host, ana, ben, startedAtMs } = threePlayerMatch();
  fixRoles(demo, 'Teo');

  // Granted geolocation: the emulated watch delivers fixes ~1/s, so
  // every seat stamps lastFixAt and the (4a) clock never reaches 30 s.
  // (One fix at T0+5 s + a fresh fix at the transfer tick models the
  // continuous stream; recordPlayerFix is the page's onFix send.)
  const fix = (atMs) => ({
    lat: 23.36,
    lng: 85.33,
    accuracyMeters: 10,
    timestampMs: atMs,
  });
  for (const p of demo.players) recordPlayerFix(demo, p.playerId, fix(startedAtMs + 5000));

  // hideTab(host): fresh suspension, fresh 30 s grace.
  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');
  assert.ok(demo.hostGraceEndsAtMs !== null);

  // Spec fast-forward (host-grace.spec.ts pattern): move the deadline
  // into the past instead of waiting out the real 30 s — the test
  // then ends well before the (4a) boundary, inside the 60 s budget.
  // (Only the still-visible seats keep receiving fixes — the hidden
  // host's watcher stops on hide, so no fix is recorded for him after
  // this point; recording one would wrongly resume him.)
  recordPlayerFix(demo, ana.playerId, fix(Date.now()));
  recordPlayerFix(demo, ben.playerId, fix(Date.now()));
  demo.hostGraceEndsAtMs = Date.now() - 1000;
  tickDemoRoom(demo, Date.now());
  assert.equal(demo.hostGraceEndsAtMs, null);
  assert.equal(demo.room.hostPlayerId, ana.playerId);
  assert.equal(ana.isHost, true);
  assert.equal(demo.room.phase, 'ACTIVE');

  clearGraceTimer(demo, currentHost(demo));
});

// --- :244 FIXED flow (GREEN pin: proves the spec fix) ----------------
test(':244 FIXED: granted geolocation keeps Ben connected, so the host leave transfers to Ben', () => {
  const { demo, host, ana, ben, startedAtMs } = threePlayerMatch();
  fixRoles(demo, 'Teo');

  const fix = (atMs) => ({
    lat: 23.36,
    lng: 85.33,
    accuracyMeters: 10,
    timestampMs: atMs,
  });
  for (const p of demo.players) recordPlayerFix(demo, p.playerId, fix(startedAtMs + 5000));

  // hideTab(Ana): Ana suspends; Ben stays connected on fresh fixes.
  // (Only the VISIBLE seats keep receiving fixes — Ana's watcher
  // stops on hide, so no fix is recorded for her after this point;
  // recording one would wrongly resume her: recordPlayerFix marks
  // the seat connected again.)
  recordPlayerSuspension(demo, ana.playerId, 'tab-hidden');
  assert.equal(ana.connectionState, 'suspended');
  assert.equal(ben.connectionState, 'connected');
  recordPlayerFix(demo, host.playerId, fix(Date.now()));
  recordPlayerFix(demo, ben.playerId, fix(Date.now()));

  leaveRoom(demo, host.playerId);
  assert.equal(demo.room.hostPlayerId, ben.playerId);
  assert.equal(ben.isHost, true);
  assert.equal(demo.room.phase, 'ACTIVE');

  clearGraceTimer(demo, currentHost(demo));
});

// --- FILED PRODUCT DEFECT (GREEN pin — fixed in the v28 fix round) ---
// The store now gates the grace on reason (demo-store.ts
// GRACE_START_REASONS): 'gps-denied' suspends the seat without a
// grace, mirroring live (play/page.tsx:447-452:
// reportSuspended('unknown') "(never transfers host, never starts a
// grace)").
test('FILED DEFECT: a gps-denied host suspension must NOT start the host grace (live parity)', () => {
  const { demo, host } = threePlayerMatch();

  // Live: reportSuspended('unknown') never transfers host, never
  // starts a grace (play/page.tsx:447-452). Demo: recordPlayerSuspension
  // does not gate on the reason (demo-store.ts:1502-1516), so a host
  // whose GPS is denied — tab open, present in the app — starts the
  // 30 s succession countdown and loses the crown, which live never
  // does. Desired: no grace from 'gps-denied' (tab-hidden keeps its
  // grace — control below).
  recordPlayerSuspension(demo, host.playerId, 'gps-denied');
  const graceAfterGpsDenied = demo.hostGraceEndsAtMs;
  // Timer hygiene first (the resume clears any wake-up timer + the
  // grace) — no timer exists for a gps-denied suspension, since no
  // grace started, but the resume keeps the runner clean either way.
  assert.equal(resumePlayer(demo, host.playerId), true);
  assert.equal(
    graceAfterGpsDenied,
    null,
    `gps-denied must not start a host grace, got deadline ${graceAfterGpsDenied} — demo-store.ts recordPlayerSuspension gates on isHost only, not on reason`,
  );

  // Control: the same call with 'tab-hidden' DOES start the grace.
  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');
  assert.ok(demo.hostGraceEndsAtMs !== null, 'tab-hidden must still start the grace');
  assert.equal(resumePlayer(demo, host.playerId), true);
});
