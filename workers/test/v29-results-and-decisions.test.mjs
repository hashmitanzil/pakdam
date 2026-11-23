import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG, canAutoCentreZone, ZONE_AUTO_CENTRE_MAX_ACCURACY_M } = await import('@pakdam/shared');

// v29 (G + I) — P1-6 flipped-Runner free time, and the six v18
// fix-round decisions verified server-side as recorded (not re-decided).
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

function player(playerId, displayName, isHost = false) {
  return {
    playerId, roomId: 'room-1', kind: 'guest', displayName, isHost,
    matchRole: null, team: null, reconnectTokenHash: `reconnect-hash-${playerId}`,
    joinedAt: new Date(T0 - 1000).toISOString(), leftAt: null, ejectedAt: null,
    connectionState: 'connected', lastFixAt: null, locationQuality: null,
    isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
  };
}

function makeStore({
  hunters = ['hu1'], runners = ['r1'], mode = 'classic',
  headStartSeconds = 0, durationSeconds = 3600, shrink = false,
} = {}) {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    mode, headStartSeconds, pingIntervalSeconds: 0, durationSeconds,
    zoneShrinkEnabled: shrink, zoneShrinkIntervalSeconds: 60, playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected', selectedHunterIds: [...hunters],
    hunterCount: hunters.length, balanceHunters: false, randomDraw: false,
  };
  const players = [
    player('h1', 'Host', true),
    ...hunters.map((id, i) => player(id, `Hunter ${i + 1}`)),
    ...runners.map((id, i) => player(id, `Runner ${i + 1}`)),
  ];
  const state = {
    room: {
      roomId: 'room-1', roomCode: 'ABCDEF', hostPlayerId: 'h1', phase: 'LOBBY',
      version: 1, config, createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: null, endsAt: null, pausedAt: null, result: null,
    },
    players, catches: [], hostTokens: { h1: 'host-hash' }, serverSeq: 0,
    gameEventLog: [], lastPingAtMs: {}, paused: false, pausedBy: null, pausedFrom: null,
    eventLog: [], shrinkIndexApplied: 0, tickets: [], idempotency: [],
    idempotentReplies: [], pendingPings: [], pendingPingRecipients: {}, runnerQrTokens: [],
  };
  return new RoomStore(state, emptyMemory());
}

function start(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `startMatch must succeed: ${r.ok ? '' : r.error}`);
  return r;
}

async function sendFix(store, playerId, atMs, point = INSIDE, accuracyMeters = 10) {
  const r = await store.handleWsMessage(
    { playerId, sessionId: 's1' },
    {
      type: 'location.update',
      commandId: `fix-${playerId}-${atMs}`,
      payload: { fix: { ...point, accuracyMeters, timestampMs: atMs } },
    },
    atMs,
  );
  assert.equal(r.events.some((e) => e.type === 'error'), false, `fix for ${playerId} at ${atMs} must be accepted`);
  return r;
}

async function sendWs(store, playerId, type, payload, commandId, atMs) {
  return store.handleWsMessage({ playerId, sessionId: 's1' }, { type, commandId, payload }, atMs);
}

function errorOf(result) {
  return result.events.find((e) => e.type === 'error');
}

// ---------------------------------------------------------------------------
// G — P1-6: a flipped Runner's free time stops at the flip.
// ---------------------------------------------------------------------------

test('G flipped Runner: free time stops at the flip (200 s), not at the end (400 s)', async () => {
  const store = makeStore({ runners: ['r1', 'r2'], mode: 'infection', durationSeconds: 400 });
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  // Keep everyone fix-fresh every 20 s so (4a) never fires.
  for (let s = 2; s <= 400; s += 20) {
    const atMs = T0 + s * 1000;
    await sendFix(store, 'h1', atMs);
    await sendFix(store, 'hu1', atMs);
    await sendFix(store, 'r1', atMs);
    await sendFix(store, 'r2', atMs);
    if (s % 60 === 0) store.alarmTick(atMs);
  }
  // r1 is tagged at T0+200 s: fresh fixes 1 s before, then self-confirm.
  await sendFix(store, 'hu1', T0 + 199_000);
  await sendFix(store, 'r1', T0 + 199_000);
  const confirmed = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-flip', T0 + 200_000);
  assert.ok(confirmed.events.some((e) => e.type === 'catch.confirmed'), 'the tag must confirm');
  assert.equal(store.player('r1').matchRole, 'hunter', 'Infection flips the caught Runner to Hunter');
  // Finish the match: r2 survives to endsAt (T0+400 s).
  for (let s = 220; s <= 400; s += 20) {
    const atMs = T0 + s * 1000;
    await sendFix(store, 'h1', atMs);
    await sendFix(store, 'hu1', atMs);
    await sendFix(store, 'r1', atMs);
    await sendFix(store, 'r2', atMs);
  }
  store.alarmTick(T0 + 401_000);
  assert.equal(store.room.phase, 'COMPLETED', 'the match must complete at endsAt');
  const res = store.resultsFor({ playerId: 'h1', reconnectTokenHash: 'reconnect-hash-h1', nowMs: T0 + 401_000 });
  assert.equal(res.ok, true, `resultsFor must succeed: ${res.ok ? '' : res.error}`);
  // r1 was free for 200 s = 1 x 180 s block = 1 point (SCORING_RUNNER_PER_3_MIN_FREE).
  // Free-to-the-end would be 400 s = 2 blocks; no wasRunner at all would be 0.
  assert.equal(res.value.scores['r1'], 1, 'the flipped Runner scores exactly one free block (200 s), not two (400 s) and not zero');
  assert.ok(res.value.scores['r2'] >= 2, 'the surviving Runner scores its full free time');
});

// ---------------------------------------------------------------------------
// I — the six v18 fix-round decisions, verified server-side.
// ---------------------------------------------------------------------------

test('I-1 suspended seats are exempt from the 30 s missing-fix ejection', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  store.suspendSeat('r1', 'tab-hidden', T0 + 5000);
  await sendFix(store, 'h1', T0 + 40_000);
  await sendFix(store, 'hu1', T0 + 40_000);
  store.alarmTick(T0 + 40_000);
  assert.equal(store.player('r1').ejectedAt, null, 'a suspended seat is never (4a)-ejected, however silent');
});

test('I-2 ejection is ACTIVE-only, never during HEAD_START', async () => {
  const store = makeStore({ headStartSeconds: 120 });
  start(store);
  assert.equal(store.room.phase, 'HEAD_START');
  store.alarmTick(T0 + 31_000);
  assert.equal(store.room.phase, 'HEAD_START');
  for (const p of store.state.players) assert.equal(p.ejectedAt, null, 'no ejection during head start');
  store.alarmTick(T0 + 120_000); // ACTIVE begins
  assert.equal(store.room.phase, 'ACTIVE');
  store.alarmTick(T0 + 150_000);
  assert.notEqual(store.player('r1').ejectedAt, null, '30 s into ACTIVE the silent seat ejects');
});

test('I-3 Self Confirm is Runner-only', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const attempt = await sendWs(store, 'hu1', 'catch.self-confirm', { hunterId: 'r1' }, 'sc-hunter', T0 + 3000);
  const err = errorOf(attempt);
  assert.ok(err, 'a Hunter self-confirming must error');
  assert.match(err.payload.message, /Only a Runner can self-confirm a tag/);
  assert.equal(store.state.catches.length, 0, 'no claim is created');
  // And a Runner CAN self-confirm (control: the same call from r1 tags).
  await sendFix(store, 'hu1', T0 + 4000);
  await sendFix(store, 'r1', T0 + 4000);
  const good = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-runner', T0 + 5000);
  assert.ok(good.events.some((e) => e.type === 'catch.confirmed'), 'a Runner self-confirm tags');
});

test('I-4 replay restores the ORIGINAL zone boundary', async () => {
  const store = makeStore({ shrink: true, durationSeconds: 65 });
  start(store);
  assert.deepEqual(store.state.originalZoneBoundary, TRIANGLE);
  const fixAll = async (atMs) => {
    await sendFix(store, 'h1', atMs);
    await sendFix(store, 'hu1', atMs);
    await sendFix(store, 'r1', atMs);
  };
  for (const atMs of [T0 + 1000, T0 + 21_000, T0 + 41_000, T0 + 59_000]) {
    await fixAll(atMs);
    store.alarmTick(atMs);
  }
  store.alarmTick(T0 + 61_000);
  assert.equal(store.state.shrinkIndexApplied, 1, 'exactly one shrink must have applied');
  assert.notDeepEqual(store.room.config.zone.boundary, TRIANGLE, 'the shrink must have moved the boundary');
  store.alarmTick(T0 + 66_000);
  assert.equal(store.room.phase, 'COMPLETED', 'the match must complete naturally at endsAt');
  const replayed = store.replayMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 67_000 });
  assert.equal(replayed.ok, true, `replay must succeed: ${replayed.ok ? '' : replayed.error}`);
  assert.deepEqual(store.room.config.zone.boundary, TRIANGLE, 'replay restores the ORIGINAL boundary');
});

test('I-5 a ≤1000 m fix counts for liveness; the server keeps ±50 m for usability', async () => {
  const store = makeStore({ runners: ['r1', 'r2'] });
  start(store);
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  // r1: poor (±500 m) fix — inside ±1000 m validity, outside ±50 m usability.
  await sendFix(store, 'r1', T0 + 2000, INSIDE, 500);
  assert.equal(store.player('r1').locationQuality, 'poor');
  assert.notEqual(store.player('r1').lastFixAt, null, 'a poor fix still stamps lastFixAt (liveness)');
  await sendFix(store, 'r1', T0 + 29_000, INSIDE, 500);
  store.alarmTick(T0 + 30_000);
  assert.equal(store.player('r1').ejectedAt, null, 'a present poor fix must not eject');
  assert.equal(store.player('r2').ejectedAt !== null, true, 'a truly silent seat still ejects');
  // Usability: the poor fix never builds a ping.
  const store2 = makeStore({ runners: ['r1'], pingIntervalSeconds: 60 });
  start(store2);
  store2.alarmTick(T0 + 1000);
  for (const atMs of [T0 + 2000, T0 + 22_000, T0 + 42_000, T0 + 61_000]) {
    await sendFix(store2, 'h1', atMs);
    await sendFix(store2, 'hu1', atMs);
    await sendFix(store2, 'r1', atMs, INSIDE, 500);
  }
  const tick = store2.alarmTick(T0 + 62_000);
  assert.equal(
    tick.events.some((e) => e.type === 'ping' && e.payload['ping'].subjectPlayerId === 'r1'),
    false,
    'a poor-fix Runner must not be pinged (unusable position)',
  );
});

test('I-6 lobby pre-start fixes sit behind the ≤50 m gate (shared helper; the server never moves the zone from a fix)', async () => {
  assert.equal(ZONE_AUTO_CENTRE_MAX_ACCURACY_M, 50, 'the gate is 50 m');
  assert.equal(canAutoCentreZone({ lat: 23.35, lng: 85.33, accuracyMeters: 50, timestampMs: T0 }), true);
  assert.equal(canAutoCentreZone({ lat: 23.35, lng: 85.33, accuracyMeters: 51, timestampMs: T0 }), false);
  assert.equal(canAutoCentreZone({ lat: 23.35, lng: 85.33, accuracyMeters: 500, timestampMs: T0 }), false);
  // Server side: a poor lobby fix is accepted for liveness (validateFix
  // ±1000 m) but changes nothing about the zone — the boundary is
  // config-only on the server (only replay-restore and shrink write it).
  const store = makeStore();
  assert.equal(store.room.phase, 'LOBBY');
  await sendFix(store, 'h1', T0 + 1000, INSIDE, 500);
  assert.notEqual(store.player('h1').lastFixAt, null, 'the lobby fix is accepted (liveness)');
  assert.deepEqual(store.room.config.zone.boundary, TRIANGLE, 'no fix ever moves the server-side boundary');
  await sendFix(store, 'h1', T0 + 2000, INSIDE, 10);
  assert.deepEqual(store.room.config.zone.boundary, TRIANGLE, 'not even a ±10 m fix moves it (auto-centre is a client display decision)');
});
