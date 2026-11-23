import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// v29 (Gap 1) — GPS anti-cheat, store half (spec §2). The movement
// check runs AFTER validateFix passes and AFTER the 1/s throttle,
// BEFORE the fix is stored. Thresholds: 50 m/s sustained, 80 m/s
// burst within 3 s, teleport >500 m with dt <10 s, flag after 3
// violations in 5 min. Warn-only by default; the fix is still
// accepted; the snapshot never exposes the flag. 1° latitude ≈
// 111,320 m; the walk stays inside the zone triangle.
const T0 = 1_780_000_000_000;
const METERS_PER_DEG_LAT = 111_320;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

function north(meters) {
  return { lat: INSIDE.lat + meters / METERS_PER_DEG_LAT, lng: INSIDE.lng };
}

function player(playerId, displayName, isHost = false) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole: null,
    team: null,
    reconnectTokenHash: `reconnect-hash-${playerId}`,
    joinedAt: new Date(T0 - 1000).toISOString(),
    leftAt: null,
    ejectedAt: null,
    connectionState: 'connected',
    lastFixAt: null,
    locationQuality: null,
    isReady: true,
    briefingConfirmed: true,
    ageGatePassed: true,
    suspensionCount: 0,
  };
}

function makeStore({ gpsAntiCheat } = {}) {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 0,
    pingIntervalSeconds: 0,
    durationSeconds: 3600,
    zoneShrinkEnabled: false,
    zoneShrinkIntervalSeconds: 60,
    playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected',
    selectedHunterIds: ['hu1'],
    hunterCount: 1,
    balanceHunters: false,
    randomDraw: false,
    ...(gpsAntiCheat ? { gpsAntiCheat } : {}),
  };
  const state = {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase: 'LOBBY',
      version: 1,
      config,
      createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: null,
      endsAt: null,
      pausedAt: null,
      result: null,
    },
    players: [player('h1', 'Host', true), player('hu1', 'Hunter 1'), player('r1', 'Runner 1')],
    catches: [],
    hostTokens: { h1: 'host-hash' },
    serverSeq: 0,
    gameEventLog: [],
    lastPingAtMs: {},
    paused: false,
    pausedBy: null,
    pausedFrom: null,
    eventLog: [],
    shrinkIndexApplied: 0,
    tickets: [],
    idempotency: [],
    idempotentReplies: [],
    pendingPings: [],
    pendingPingRecipients: {},
    runnerQrTokens: [],
  };
  return new RoomStore(state, emptyMemory());
}

function start(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `startMatch must succeed: ${r.ok ? '' : r.error}`);
  return r;
}

async function sendFix(store, playerId, atMs, point, accuracyMeters = 10) {
  const r = await store.handleWsMessage(
    { playerId, sessionId: 's1' },
    {
      type: 'location.update',
      commandId: `fix-${playerId}-${atMs}`,
      payload: { fix: { ...point, accuracyMeters, timestampMs: atMs } },
    },
    atMs,
  );
  assert.equal(
    r.events.some((e) => e.type === 'error'),
    false,
    `fix for ${playerId} at ${atMs} must be accepted`,
  );
  return r;
}

function gpsViolationIntents(results) {
  return results.flatMap((r) =>
    r.persist.filter((p) => p.kind === 'room-event' && p.type === 'GPS_VIOLATION'),
  );
}

test('a 60 m/s stream flags at the 3rd violation — and the fix is still accepted', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  const results = [];
  // 60 m per 1 s fix = 60 m/s, sustained. Fix 1 has no previous fix
  // (no violation); fixes 2-4 are violations 1-3.
  for (let i = 0; i < 5; i++) {
    results.push(await sendFix(store, 'r1', T0 + 2000 + i * 1000, north(i * 60)));
  }
  const violations = gpsViolationIntents(results);
  assert.equal(violations.length, 1, 'exactly one GPS_VIOLATION event at the 3rd violation');
  assert.equal(violations[0].payload.kind, 'speed');
  assert.equal(violations[0].payload.count, 3);
  assert.equal(violations[0].payload.playerId, 'r1');
  assert.equal('lat' in violations[0].payload, false, 'the event carries NO coordinates');
  assert.equal('lng' in violations[0].payload, false);
  // The 5th fix (past the flag) is still accepted and stored.
  assert.notEqual(store.player('r1').lastFixAt, null, 'warn-only: the fix is still accepted');
  assert.equal(store.player('r1').ejectedAt, null, 'warn-only: no ejection');
  // The snapshot never exposes the flag.
  const snap = store.snapshotFor('h1', T0 + 7000);
  assert.equal('gpsViolations' in snap, false);
  assert.equal(JSON.stringify(snap).includes('GPS_VIOLATION'), false);
  // The structured log carries the violation too (no coordinates) —
  // flushed piggybacked into the same message's persist batch as a
  // log-batch intent (persist was non-empty: the GPS_VIOLATION
  // room-event), so assert on the intent, not the drained buffer.
  const logBatch = results[3].persist.find((p) => p.kind === 'log-batch');
  assert.ok(logBatch, 'the violation must flush as a log-batch intent');
  const log = logBatch.entries.find((e) => e.message === 'gps.violation');
  assert.ok(log, 'the violation is logged');
  assert.equal(log.metadata?.kind, 'speed');
});

test('a single 800 m jump counts at most 1 violation and raises no event', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  await sendFix(store, 'r1', T0 + 2000, north(0));
  const r = await sendFix(store, 'r1', T0 + 3000, north(800));
  assert.equal(gpsViolationIntents([r]).length, 0, '1 violation < 3: no event');
  assert.equal(store.mem.gpsViolations['r1']?.count, 1, 'the teleport counts once');
  assert.equal(store.player('r1').ejectedAt, null);
  assert.notEqual(store.player('r1').lastFixAt, null, 'the jumped fix is still accepted');
});

test('a walking stream (1.4 m/s) counts zero violations', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await sendFix(store, 'r1', T0 + 2000 + i * 1000, north(i * 1.4)));
  }
  assert.equal(gpsViolationIntents(results).length, 0);
  assert.equal(store.mem.gpsViolations['r1'], undefined, 'no violation slot is even created');
});

test('eject happens ONLY with an explicit config opt-in (action: eject)', async () => {
  const store = makeStore({ gpsAntiCheat: { action: 'eject' } });
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(await sendFix(store, 'r1', T0 + 2000 + i * 1000, north(i * 60)));
  }
  assert.equal(gpsViolationIntents(results).length, 1, 'the flag still logs first');
  assert.notEqual(store.player('r1').ejectedAt, null, 'opt-in eject ejects through the existing machinery');
});

test('violations age out: 2 in one window + 1 after 5 min is not a flag', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  const results = [];
  await sendFix(store, 'r1', T0 + 2000, north(0));
  results.push(await sendFix(store, 'r1', T0 + 3000, north(60)));
  results.push(await sendFix(store, 'r1', T0 + 4000, north(120)));
  assert.equal(store.mem.gpsViolations['r1']?.count, 2);
  // 5+ min later: a fresh baseline fix (no movement, no violation),
  // then a 60 m/s fix. The window resets, so this is count 1, not 3.
  await sendFix(store, 'r1', T0 + 4000 + 5 * 60_000 + 1000, north(120));
  results.push(await sendFix(store, 'r1', T0 + 4000 + 5 * 60_000 + 2000, north(180)));
  assert.equal(gpsViolationIntents(results).length, 0, 'no flag across windows');
  assert.equal(store.mem.gpsViolations['r1']?.count, 1, 'the new window starts at 1');
});

test('a forged-timestamp stream flags: device dt stretched to ~361 s, receipt dt 1 s (F3)', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  // Each fix is individually valid (device timestamp within
  // validateFix's bounds: at most 60 s stale, at most 5 min in the
  // future) — but the device timestamps alternate stale/future so
  // the DEVICE dt between consecutive fixes is ~361 s or negative,
  // while the SERVER receipt dt is 1 s. Under device-dt the 60 m
  // jumps read as ~0.17 m/s and never flag; under receipt-dt they
  // are 60 m/s, three violations in a row.
  async function sendForgedFix(atMs, deviceTsMs, point) {
    const r = await store.handleWsMessage(
      { playerId: 'r1', sessionId: 's1' },
      {
        type: 'location.update',
        commandId: `fix-r1-${atMs}`,
        payload: { fix: { ...point, accuracyMeters: 10, timestampMs: deviceTsMs } },
      },
      atMs,
    );
    assert.equal(r.events.some((e) => e.type === 'error'), false, `forged fix at ${atMs} must pass validateFix`);
    return r;
  }
  const results = [];
  results.push(await sendForgedFix(T0 + 2000, T0 + 2000 - 60_000, north(0))); // 60 s stale (bound)
  results.push(await sendForgedFix(T0 + 3000, T0 + 3000 + 300_000, north(60))); // 5 min future (bound)
  results.push(await sendForgedFix(T0 + 4000, T0 + 4000 - 60_000, north(120)));
  results.push(await sendForgedFix(T0 + 5000, T0 + 5000 + 300_000, north(180)));
  const violations = gpsViolationIntents(results);
  assert.equal(violations.length, 1, 'the receipt-time check must flag at the 3rd violation');
  assert.equal(violations[0].payload.kind, 'speed');
  assert.equal(violations[0].payload.count, 3);
});

test('the fix ring caps at 10 and the throttle still gates the check (a sub-second fix is coalesced, not checked)', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  for (let i = 0; i < 12; i++) {
    await sendFix(store, 'r1', T0 + 2000 + i * 1000, north(i * 1.4));
  }
  assert.equal(store.mem.fixHistory['r1']?.length, 10, 'the ring caps at 10');
  // A fix 500 ms after the last accepted one is coalesced by the 1/s
  // throttle — it never reaches the movement check.
  const before = store.mem.gpsViolations['r1'];
  await store.handleWsMessage(
    { playerId: 'r1', sessionId: 's1' },
    {
      type: 'location.update',
      commandId: 'fix-fast',
      payload: { fix: { ...north(900), accuracyMeters: 10, timestampMs: T0 + 13_500 } },
    },
    T0 + 13_500,
  );
  assert.equal(store.mem.gpsViolations['r1'], before, 'a coalesced fix counts nothing');
  assert.equal(store.mem.fixHistory['r1']?.length, 10, 'and is not stored in the ring');
});
