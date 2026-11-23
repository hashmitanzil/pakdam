import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const store = await import('../src/lib/demo-store.ts');
const { createRoom, recordPlayerSuspension, resumePlayer, tickDemoRoom } = store;
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
 * v28-lobby-suspension.test.mjs — H1 (v28 fix round): the lobby page
 * never suspended on tab-hide.
 *
 * The lobby never mounted useRoomState, so its visibilitychange handler
 * (useRoomState.ts:722-740) never ran there: hideTab() in the lobby
 * suspended nothing — no 'suspended' state, no 30 s host grace
 * (hostGraceEndsAtMs stayed null), no waiting line, no crown move.
 * The fix (room/[roomId]/page.tsx) adds the same handler to the lobby,
 * demo-only: on hide it calls recordPlayerSuspension(room, playerId,
 * 'tab-hidden'), on return resumePlayer(room, playerId), then refreshes
 * the roster from getRoom (which ticks the demo alarm, so grace expiry
 * lands within ~1 s on any polling tab). Live needs no page handler —
 * the PakdamSocket reports `player.suspended` ('tab-hidden') on hide
 * itself (websocket.ts:658-681); the DO maps a client-supplied
 * 'network-lost' / 'heartbeat-timeout' to 'unknown' and never starts
 * a grace from it (room-do.ts, `player.suspended` case), so a hidden
 * tab can never force host succession.
 *
 * The React handler itself cannot mount under node --test, so these
 * tests pin the behaviour of the exact two calls it makes, on a demo
 * lobby room, in the exact order the handler makes them — suspend on
 * hide, resume on return, grace starts for a hidden host, expiry
 * transfers to the earliest joiner, and the F5 hostless re-trigger.
 * The static wiring (the lobby page really listens for
 * visibilitychange and really calls recordPlayerSuspension) is pinned
 * by the H1 test in v28-repro-ci-e2e.test.mjs.
 *
 * Timer hygiene: recordPlayerSuspension schedules one 30 s wake-up
 * timer per room (demo-store). Every test below ends with the timer
 * cleared — a host resume clears it, and the F5 transfer branch
 * clears it — so no test leaves a pending timer behind to hold the
 * runner open.
 */

/** A demo lobby room with host Teo + Ana (joined first) + Ben. */
function threePlayerLobby() {
  const demo = createRoom('Teo', TEST_CONFIG);
  const host = demo.players[0];
  // joinRoom reads localStorage, which is empty under node --test, so
  // guest seats are clones of the host seat (same Player shape) with
  // later joinedAt values, so Ana is the earliest-joined joiner.
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

test('lobby hide: a hidden host suspends and starts the 30 s grace, and keeps the crown', () => {
  const { demo, host, ana } = threePlayerLobby();
  const before = Date.now();

  // The lobby handler on hide: recordPlayerSuspension(room, host, 'tab-hidden').
  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');

  assert.equal(host.connectionState, 'suspended');
  assert.equal(host.suspensionCount, 1);
  assert.ok(
    demo.hostGraceEndsAtMs !== null &&
      demo.hostGraceEndsAtMs >= before + 29_000 &&
      demo.hostGraceEndsAtMs <= Date.now() + 30_000,
    `grace must start ~30 s out, got ${demo.hostGraceEndsAtMs}`,
  );
  // No transfer yet: the crown stays with the suspended host.
  assert.equal(demo.room.hostPlayerId, host.playerId);
  assert.equal(ana.isHost, false);

  // The lobby handler on return: resumePlayer(room, host).
  assert.equal(resumePlayer(demo, host.playerId), true);
  assert.equal(host.connectionState, 'connected');
  assert.equal(demo.hostGraceEndsAtMs, null);
  assert.equal(demo.room.hostPlayerId, host.playerId);
});

test('lobby hide: a hidden joiner suspends with no grace', () => {
  const { demo, host, ana } = threePlayerLobby();

  recordPlayerSuspension(demo, ana.playerId, 'tab-hidden');
  assert.equal(ana.connectionState, 'suspended');
  assert.equal(demo.hostGraceEndsAtMs, null);
  assert.equal(demo.room.hostPlayerId, host.playerId);

  assert.equal(resumePlayer(demo, ana.playerId), true);
  assert.equal(ana.connectionState, 'connected');
  // Resuming a seat that was never suspended is a no-op.
  assert.equal(resumePlayer(demo, ana.playerId), false);
});

test('lobby hide: grace expiry transfers to the earliest-joined connected guest', () => {
  const { demo, host, ana, ben } = threePlayerLobby();

  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');
  assert.ok(demo.hostGraceEndsAtMs !== null);

  // The 1 s poll (getRoom → tickDemoRoom) past the deadline expires it.
  demo.hostGraceEndsAtMs = Date.now() - 1000;
  tickDemoRoom(demo, Date.now());

  assert.equal(demo.hostGraceEndsAtMs, null);
  assert.equal(demo.room.hostPlayerId, ana.playerId);
  assert.equal(ana.isHost, true);
  assert.equal(host.isHost, false);
  assert.equal(ben.isHost, false);

  // Timer hygiene: the new host suspends + resumes, which clears the
  // wake-up timer the host's suspension scheduled.
  recordPlayerSuspension(demo, ana.playerId, 'tab-hidden');
  assert.equal(resumePlayer(demo, ana.playerId), true);
});

test('lobby hide: grace expires with no successor — the first seat to resume takes the crown (F5)', () => {
  const { demo, host, ana, ben } = threePlayerLobby();

  // Both joiners background first, then the host — nobody connected.
  recordPlayerSuspension(demo, ana.playerId, 'tab-hidden');
  recordPlayerSuspension(demo, ben.playerId, 'tab-hidden');
  recordPlayerSuspension(demo, host.playerId, 'tab-hidden');
  assert.ok(demo.hostGraceEndsAtMs !== null);

  demo.hostGraceEndsAtMs = Date.now() - 1000;
  tickDemoRoom(demo, Date.now());

  // No successor at expiry: the suspended host keeps the crown.
  assert.equal(demo.room.hostPlayerId, host.playerId);
  assert.equal(demo.hostGraceEndsAtMs, null);
  assert.equal(ana.isHost, false);

  // Ana comes back: her tab-visible resume re-triggers succession and
  // she — earliest-joined connected seat — takes the crown. The F5
  // transfer branch clears the host's wake-up timer.
  assert.equal(resumePlayer(demo, ana.playerId), true);
  assert.equal(demo.room.hostPlayerId, ana.playerId);
  assert.equal(ana.isHost, true);
  assert.equal(host.isHost, false);
});
