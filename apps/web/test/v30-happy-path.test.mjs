import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const store = await import('../src/lib/demo-store.ts');
const {
  createRoom,
  demoRoomChangeKey,
  ejectPlayer,
  recordPlayerSuspension,
  resumePlayer,
  startDemoMatch,
  tickDemoRoom,
  toggleReady,
} = store;
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');
const { shouldEjectForMissingFix } = await import(
  '../src/components/hud/play-map-logic.ts'
);

// v30 QA (Arjun) — client-side pins for the v30 gate + the v29 CI
// triage. Harness mirrors v28-lobby-suspension.test.mjs (demo store
// direct, no DOM, no network). Timer hygiene: a host suspension
// schedules one 30 s wake-up timer, so every test that suspends the
// host ends with a resume (which clears it).
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

function startMatch(demo) {
  for (const p of demo.players) {
    p.isReady = true;
    p.briefingConfirmed = true;
  }
  startDemoMatch(demo);
  const startedAtMs = Date.parse(demo.room.startedAt);
  tickDemoRoom(demo, startedAtMs + 1000);
  assert.equal(demo.room.phase, 'ACTIVE', 'headStart 0 must reach ACTIVE on the first tick');
  return startedAtMs;
}

test('resume stamps lastFixAt: after a suspend+resume the seat can never read "Location never reported" again', () => {
  const { demo, ana } = threePlayerLobby();
  // Fresh seat: no fix ever arrived.
  assert.equal(ana.lastFixAt, null);
  // Ana backgrounds her tab, then comes back — no fix was ever sent.
  recordPlayerSuspension(demo, ana.playerId, 'tab-hidden');
  assert.equal(ana.connectionState, 'suspended');
  assert.equal(resumePlayer(demo, ana.playerId), true);
  assert.equal(ana.connectionState, 'connected');
  // PIN (live-hud.spec.ts:54 mechanism): resumePlayer stamps
  // lastFixAt = now (demo-store.ts), so the YOU dot's label
  // (play/page.tsx — 'Location never reported' iff lastFixAt is
  // null) flips to an age label after ANY suspend+resume cycle,
  // even though no GPS fix ever arrived. The status-strip test's
  // H5 fix (bringToFront + wait for connected) and its
  // 'Location never reported' assertion are mutually exclusive
  // once the seat was suspended: fix the test (assert the age
  // label), or stop stamping a fix timestamp on resume (a
  // product call — the stamp also feeds the (4a) clock).
  assert.notEqual(
    ana.lastFixAt,
    null,
    'resume stamps lastFixAt — see the comment above before asserting "Location never reported" after a resume',
  );
});

test('(4a) ejection completes the match: ejecting the last free runner ends it as Hunters Win', () => {
  const { demo } = threePlayerLobby();
  startMatch(demo);
  const runners = demo.players.filter((p) => p.matchRole === 'runner');
  assert.ok(runners.length >= 1, 'the match must have a free runner to eject');
  // Eject every runner but one: the game goes on.
  for (const r of runners.slice(0, -1)) {
    ejectPlayer(demo, r.playerId);
    assert.equal(demo.room.phase, 'ACTIVE', 'a free runner is left — the game goes on');
  }
  // Eject the last free runner: the match completes at once.
  // PIN (catch-results.spec.ts:136 mechanism): ejectPlayer calls
  // maybeCompleteOnWin, and with no free runner left completeMatch
  // records 'hunters-win'. In headless CI no seat ever reports a
  // fix, so the (4a) 30 s clock ejects the last free runner by
  // itself — a test that then forces the match end and expects
  // 'Runners Win!' fails, however correct the replay code is. Any
  // no-GPS demo test whose ACTIVE span crosses 30 s must grant
  // geolocation (host-cancel pattern) or end the match first.
  const last = runners[runners.length - 1];
  ejectPlayer(demo, last.playerId);
  assert.equal(demo.room.phase, 'COMPLETED');
  assert.equal(demo.room.result?.outcome, 'hunters-win');
  assert.deepEqual(demo.room.result?.survivingRunnerIds, []);
});

test('demo change key sees every lobby mutation the e2e suite depends on (R1 cheap-key guard)', () => {
  const { demo, host, ana } = threePlayerLobby();
  const key0 = demoRoomChangeKey(demo);
  // Ready flip: the roster pill moves.
  toggleReady(demo, ana.playerId);
  const keyReady = demoRoomChangeKey(demo);
  assert.notEqual(keyReady, key0, 'a ready flip must change the key or the lobby poll skips it');
  toggleReady(demo, ana.playerId);
  assert.equal(demoRoomChangeKey(demo), key0, 'flipping back restores the key');
  // Host suspend: connectionState + grace + announcement all move.
  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');
  const keySuspended = demoRoomChangeKey(demo);
  assert.notEqual(keySuspended, key0, 'a host suspend must change the key (waiting line + Suspended row)');
  assert.notEqual(
    demo.hostGraceEndsAtMs,
    null,
    'the suspend must start the grace the waiting line reads',
  );
  // Host resume: the key moves again (and clears the wake-up timer).
  assert.equal(resumePlayer(demo, host.playerId), true);
  const keyResumed = demoRoomChangeKey(demo);
  assert.notEqual(keyResumed, keySuspended, 'a host resume must change the key');
  assert.equal(demo.hostGraceEndsAtMs, null, 'the resume cancels the grace');
  // Config-adjacent team fields are in the key too (Balance/Random):
  // the default is 'random', so flip to a real 'selected' pick.
  demo.room.config = {
    ...demo.room.config,
    teamAssignment: 'selected',
    selectedHunterIds: [ana.playerId],
  };
  assert.notEqual(
    demoRoomChangeKey(demo),
    keyResumed,
    'a team-assignment change must change the key',
  );
});

test('missing-fix ejection: a fix 5 s ago holds the clock at ACTIVE+40 s; no fix at all ejects at ACTIVE+30 s', () => {
  const activeAtMs = 1_780_000_000_000;
  const base = {
    mode: 'demo',
    phase: 'ACTIVE',
    activeAtMs,
    connectionState: 'connected',
    alreadyEjected: false,
  };
  // Fixes flowing: last seen 5 s ago, 40 s into ACTIVE — no eject.
  // This is the "Waiting for GPS cannot strand a game when fixes
  // are flowing" pin at the decision-function level.
  assert.equal(
    shouldEjectForMissingFix({ ...base, lastSeenMs: activeAtMs + 35_000, effectiveNowMs: activeAtMs + 40_000 }),
    false,
    'a fresh fix holds the (4a) clock',
  );
  // Nothing ever seen: 31 s into ACTIVE — eject.
  assert.equal(
    shouldEjectForMissingFix({
      ...base,
      lastSeenMs: Number.NEGATIVE_INFINITY,
      effectiveNowMs: activeAtMs + 31_000,
    }),
    true,
    'no fix at all for 30 s into ACTIVE ejects',
  );
  // Suspended seats never eject (gps-denied / tab-hidden hold).
  assert.equal(
    shouldEjectForMissingFix({
      ...base,
      connectionState: 'suspended',
      lastSeenMs: Number.NEGATIVE_INFINITY,
      effectiveNowMs: activeAtMs + 60_000,
    }),
    false,
    'a suspended seat is held, not lost',
  );
  // Never during HEAD_START — a cold GPS lock gets the head start.
  assert.equal(
    shouldEjectForMissingFix({
      ...base,
      phase: 'HEAD_START',
      lastSeenMs: Number.NEGATIVE_INFINITY,
      effectiveNowMs: activeAtMs + 60_000,
    }),
    false,
    'HEAD_START never ejects for a missing fix',
  );
});
