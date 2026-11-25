import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const store = await import('../src/lib/demo-store.ts');
const {
  createRoom,
  leaveRoom,
  recordPlayerSuspension,
  resumePlayer,
  tickDemoRoom,
} = store;
const { shouldEjectForMissingFix } = await import(
  '../src/components/hud/play-map-logic.ts'
);
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// createRoom validates the config: the default has an empty zone
// boundary, so the test room gets a 3-point triangle (Ranchi).
const TEST_CONFIG = {
  ...DEFAULT_ROOM_CONFIG,
  hostOnSiteConfirmed: true,
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
 * v32-suspension-cluster.test.mjs — Kabir, v32 CI-fix build.
 *
 * The v31 push failed 7 suspension tests (host-grace.spec.ts:101, 152,
 * 191, 230; host-cancel-room-deleted.spec.ts:254, 303;
 * outside-zone.spec.ts:123) with ONE shared mechanism, plus one
 * adjudication:
 *
 * SHARED MECHANISM (lobby + play): the headless multi-page setup
 * backgrounds a page when the next page is created, so the H1 lobby
 * handler / useRoomState play handler already suspended the host —
 * and started the 30 s grace — at SETUP time, before the test's own
 * hideTab. hideTab is then a no-op on an already-suspended seat
 * (recordPlayerSuspension early-returns) and the test races a stale
 * grace: expiry mid-test hands the crown to Ben (the only connected
 * seat), or clears the grace the test then tries to fast-forward.
 * The product is CORRECT for real phones (one tab per device — a
 * backgrounded tab IS a disconnect, and the grace must start then),
 * so there is no demo-store change for the clock itself: the fix is
 * spec-side (front the acting page before hideTab, so hideTab starts
 * a fresh suspension + fresh grace — the live-hud:54 H5 pattern).
 * Pin 1 below proves WHY no store change can help: a re-suspend
 * must NOT refresh the deadline, or a host who never returns would
 * keep the crown forever.
 *
 * :303 MECHANISM (pinned here for the first time): leaveRoom skips
 * suspended seats — the crown goes to the earliest-joined CONNECTED
 * seat, and with nobody connected it stays with the leaver until the
 * first seat resumes (F5).
 *
 * :123 ADJUDICATION (Arjun vs Diya — Diya right that bringToFront
 * ALONE does not fix it): with no geolocation grant the watch errors
 * permission-denied and F16 suspends the seat instead of ejecting it,
 * and shouldEjectForMissingFix never ejects a suspended seat — so
 * ejectedAt could never fire. bringToFront alone cannot hold the seat
 * connected either: the play page mounts hidden, so no watch exists
 * yet, and the return creates a FRESH watch that errors denied again
 * and re-suspends within a second. The fix needs the grant too
 * (permission, no position: the provider fails with
 * position-unavailable / timeout, neither of which suspends), so the
 * watch is alive but silent and the (4a) clock runs. Pins 5–8 prove
 * the (4a) decision itself; pin 8 proves only permission-denied
 * suspends.
 *
 * Timer hygiene: recordPlayerSuspension schedules one 30 s wake-up
 * timer per room. Every pin below ends with the timer cleared — a
 * host resume clears it, a host leave clears it, and a transfer is
 * followed by a suspend+resume of the new host.
 */

/** A demo lobby room with host Teo + Ana (joined first) + Ben. */
function threePlayerLobby() {
  const demo = createRoom('Teo', TEST_CONFIG);
  const host = demo.players[0];
  const joined = (offsetMs) =>
    new Date(Date.parse(host.joinedAt) + offsetMs).toISOString();
  const ana = {
    ...host,
    playerId: 'ana-player-id',
    displayName: 'Ana',
    isHost: false,
    isReady: false,
    briefingConfirmed: false,
    joinedAt: joined(1000),
  };
  const ben = {
    ...host,
    playerId: 'ben-player-id',
    displayName: 'Ben',
    isHost: false,
    isReady: false,
    briefingConfirmed: false,
    joinedAt: joined(2000),
  };
  demo.players.push(ana, ben);
  return { demo, host, ana, ben };
}

/** Clear the room's wake-up timer: suspend+resume the current host. */
function clearGraceTimer(demo, hostPlayer) {
  recordPlayerSuspension(demo, hostPlayer.playerId, 'tab-hidden');
  assert.equal(resumePlayer(demo, hostPlayer.playerId), true);
}

function currentHost(demo) {
  return demo.players.find((p) => p.playerId === demo.room.hostPlayerId);
}

// --- Pin 1: the stale grace (shared mechanism) ------------------------
test('v32 stale grace: re-suspending an already-suspended host does NOT refresh the grace deadline', () => {
  const { demo, host } = threePlayerLobby();

  // First hide (setup-time backgrounding): suspends + starts the grace.
  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');
  const firstDeadline = demo.hostGraceEndsAtMs;
  assert.ok(firstDeadline !== null);
  assert.equal(host.suspensionCount, 1);

  // Second hide (the test's own hideTab): a no-op — the deadline is
  // the ORIGINAL one, and the suspension is not counted twice.
  // Refreshing it here would let a host who never returns keep the
  // crown forever (every re-fired hide would extend the grace), so
  // the store must NOT refresh — and that is exactly why the specs
  // must front the host first (reset) instead of relying on hideTab.
  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');
  assert.equal(demo.hostGraceEndsAtMs, firstDeadline);
  assert.equal(host.suspensionCount, 1);
  assert.equal(demo.room.hostPlayerId, host.playerId);

  assert.equal(resumePlayer(demo, host.playerId), true);
});

// --- Pin 2: expiry successor rule (:191 / :254) ------------------------
test('v32 expiry: grace expiry skips a suspended earliest joiner and transfers to the earliest CONNECTED seat', () => {
  const { demo, host, ana, ben } = threePlayerLobby();

  // Ana suspended from setup (backgrounded when Ben's page was
  // created); Ben connected. The host then hides.
  recordPlayerSuspension(demo, ana.playerId, 'tab-hidden');
  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');
  assert.ok(demo.hostGraceEndsAtMs !== null);

  demo.hostGraceEndsAtMs = Date.now() - 1000;
  tickDemoRoom(demo, Date.now());

  // NOT Ana (suspended) — Ben, the earliest-joined CONNECTED seat.
  assert.equal(demo.room.hostPlayerId, ben.playerId);
  assert.equal(ben.isHost, true);
  assert.equal(ana.isHost, false);
  assert.equal(demo.hostGraceEndsAtMs, null);

  clearGraceTimer(demo, currentHost(demo));
});

// --- Pin 3: :303 mechanism — leave skips suspended ----------------------
test('v32 :303 mechanism: host leave skips a suspended earliest joiner and transfers to the earliest CONNECTED seat', () => {
  const { demo, host, ana, ben } = threePlayerLobby();

  // Ana suspended (by the test's own hideTab, after being observably
  // connected — see the spec); Ben connected.
  recordPlayerSuspension(demo, ana.playerId, 'tab-hidden');
  assert.equal(ana.connectionState, 'suspended');
  assert.equal(ben.connectionState, 'connected');

  leaveRoom(demo, host.playerId);

  assert.equal(demo.room.hostPlayerId, ben.playerId);
  assert.equal(ben.isHost, true);
  assert.equal(ana.isHost, false);
  assert.equal(host.leftAt !== null, true);
  // Timer hygiene: the host leave already cleared the wake-up timer.
});

// --- Pin 4: :303 / :279 no-successor leave ------------------------------
test('v32 :303 no-successor: host leave with every other seat suspended leaves the crown with the leaver', () => {
  const { demo, host, ana, ben } = threePlayerLobby();

  recordPlayerSuspension(demo, ana.playerId, 'tab-hidden');
  recordPlayerSuspension(demo, ben.playerId, 'tab-hidden');
  leaveRoom(demo, host.playerId);

  assert.equal(demo.room.hostPlayerId, host.playerId);
  assert.equal(ana.isHost, false);
  assert.equal(ben.isHost, false);

  // The first seat to resume takes it (F5) — Ana, earliest-joined.
  assert.equal(resumePlayer(demo, ana.playerId), true);
  assert.equal(demo.room.hostPlayerId, ana.playerId);
  assert.equal(ana.isHost, true);

  clearGraceTimer(demo, currentHost(demo));
});

// --- Pins 5–7: :123 (4a) decision ---------------------------------------
function missingFixInput(overrides = {}) {
  const activeAtMs = Date.now() - 60_000;
  return {
    mode: 'demo',
    phase: 'ACTIVE',
    activeAtMs,
    lastSeenMs: Number.NEGATIVE_INFINITY,
    effectiveNowMs: activeAtMs + 30_000,
    connectionState: 'connected',
    alreadyEjected: false,
    ...overrides,
  };
}

test('v32 :123 (4a): a suspended seat never ejects for a missing fix', () => {
  // The F16 seat (gps-denied or tab-hidden): held, not lost — even
  // 60 s into ACTIVE with no fix at all.
  assert.equal(
    shouldEjectForMissingFix(
      missingFixInput({ connectionState: 'suspended', effectiveNowMs: Date.now() }),
    ),
    false,
  );
});

test('v32 :123 (4a): a connected seat with no fix ejects 30 s into ACTIVE, not before', () => {
  const activeAtMs = Date.now() - 60_000;
  assert.equal(
    shouldEjectForMissingFix(
      missingFixInput({ activeAtMs, effectiveNowMs: activeAtMs + 30_000 }),
    ),
    true,
  );
  assert.equal(
    shouldEjectForMissingFix(
      missingFixInput({ activeAtMs, effectiveNowMs: activeAtMs + 29_999 }),
    ),
    false,
  );
  // A poor-but-present fix counts as liveness: baseline is the fix,
  // so 30 s after ACTIVE with a fix 5 s ago does not eject.
  assert.equal(
    shouldEjectForMissingFix(
      missingFixInput({
        activeAtMs,
        lastSeenMs: activeAtMs + 25_000,
        effectiveNowMs: activeAtMs + 30_000,
      }),
    ),
    false,
  );
});

test('v32 :123 (4a): no ejection during HEAD_START even with no fix (v29 H2)', () => {
  assert.equal(
    shouldEjectForMissingFix(missingFixInput({ phase: 'HEAD_START' })),
    false,
  );
  assert.equal(
    shouldEjectForMissingFix(missingFixInput({ mode: 'live' })),
    false,
    'live never ejects here — the server enforces it',
  );
  assert.equal(
    shouldEjectForMissingFix(missingFixInput({ alreadyEjected: true })),
    false,
  );
  assert.equal(
    shouldEjectForMissingFix(missingFixInput({ activeAtMs: null })),
    false,
  );
});

// --- Pin 8: only permission-denied suspends -----------------------------
test('v32 :123 source pin: the play page suspends ONLY on permission-denied — position-unavailable / timeout never suspend', () => {
  const src = readFileSync(
    new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
    'utf8',
  );
  const deniedIdx = src.indexOf("err.kind === 'permission-denied'");
  const suspendIdx = src.indexOf(
    "recordPlayerSuspension(current, myPlayerId, 'gps-denied')",
  );
  const unavailableIdx = src.indexOf("err.kind === 'position-unavailable'");
  const timeoutIdx = src.indexOf("err.kind === 'timeout'");
  assert.ok(deniedIdx > -1, 'the permission-denied branch must exist');
  assert.ok(suspendIdx > -1, 'the gps-denied suspension must exist');
  assert.ok(unavailableIdx > -1, 'the position-unavailable branch must exist');
  assert.ok(timeoutIdx > -1, 'the timeout branch must exist');
  assert.ok(
    deniedIdx < suspendIdx && suspendIdx < unavailableIdx,
    'the gps-denied suspension must sit inside the permission-denied branch, before the position-unavailable branch (which must not suspend)',
  );
  assert.ok(
    suspendIdx < timeoutIdx,
    'the gps-denied suspension must come before the timeout branch (which must not suspend)',
  );
  // Exactly one demo suspension call in the whole page: no other
  // error path suspends.
  const calls = src.match(/recordPlayerSuspension\(current, myPlayerId, 'gps-denied'\)/g) ?? [];
  assert.equal(calls.length, 1);
});

// --- Pin 9: the spec-side resets exist ----------------------------------
test('v32 spec pins: the suspension specs reset the room before hideTab (no stale setup-time grace)', () => {
  const grace = readFileSync(new URL('../e2e/host-grace.spec.ts', import.meta.url), 'utf8');
  assert.ok(
    grace.includes('resetHostBeforeHide(hostPage)'),
    'host-grace.spec.ts must front the host before hideTab',
  );
  assert.ok(
    grace.indexOf('resetHostBeforeHide(hostPage)') < grace.indexOf('await hideTab(hostPage)'),
    'the reset must come before the first hideTab',
  );
  assert.ok(
    grace.includes('await anaPage.bringToFront()'),
    'host-grace:191 must front Ana so she is the connected successor at expiry',
  );

  const cancel = readFileSync(
    new URL('../e2e/host-cancel-room-deleted.spec.ts', import.meta.url),
    'utf8',
  );
  const cancel254 = cancel.slice(
    cancel.indexOf('the crown moves to the earliest-joined connected guest'),
    cancel.indexOf('the crown skips the suspended seat'),
  );
  assert.ok(
    cancel254.includes('await hostPage.bringToFront()'),
    'host-cancel:254 must front the host before hideTab',
  );
  assert.ok(
    cancel254.includes('await firstGuest.bringToFront()'),
    'host-cancel:254 must front Ana before the grace expires',
  );
  const cancel303 = cancel.slice(
    cancel.indexOf('the crown skips the suspended seat'),
    cancel.indexOf('joining a deleted lobby code'),
  );
  assert.ok(
    cancel303.includes('await hostPage.bringToFront()'),
    'host-cancel:303 must front the host before the leave',
  );
  assert.ok(
    cancel303.includes('await firstGuest.bringToFront()'),
    'host-cancel:303 must front Ana (connected) before hiding her — the pinned mechanism',
  );
  assert.ok(
    cancel303.includes('await secondGuest.bringToFront()'),
    'host-cancel:303 must front Ben last so he is connected at the leave',
  );

  const outside = readFileSync(new URL('../e2e/outside-zone.spec.ts', import.meta.url), 'utf8');
  const missing = outside.slice(outside.indexOf('no fix for 30 s ejects'));
  assert.ok(
    missing.includes("await context.grantPermissions(['geolocation'])"),
    'outside-zone:123 must grant geolocation permission (no position) so the watch is alive but silent instead of denied-and-suspended',
  );
  assert.ok(
    !missing.includes('await context.setGeolocation('),
    'outside-zone:123 must NOT set a position — a fix would defeat the missing-fix rule',
  );
  assert.ok(
    missing.includes('await hostPage.bringToFront()'),
    'outside-zone:123 must front the host so the tab-hidden suspension resumes',
  );
});
