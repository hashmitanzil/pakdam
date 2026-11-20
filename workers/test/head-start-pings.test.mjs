import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// Head start 180 s, ping interval 60 s. Match starts (HEAD_START) at T0;
// ACTIVE starts at T0 + 180_000. Two intervals elapse during the head start,
// so the OLD startedAt-anchored schedule would already be due.
const T0 = 1_780_000_000_000;
const HEAD_START_MS = 180_000;
const PING_MS = 60_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];

function player(playerId, matchRole, displayName, isHost = false) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole,
    team: matchRole === 'hunter' ? 'hunters' : 'runners',
    reconnectTokenHash: '',
    joinedAt: new Date(T0 - 1000).toISOString(),
    leftAt: null,
    ejectedAt: null,
    connectionState: 'connected',
    lastFixAt: new Date(T0).toISOString(),
    locationQuality: 'good',
    isReady: true,
    briefingConfirmed: true,
    ageGatePassed: true,
    suspensionCount: 0,
  };
}

function makeStore() {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 180,
    pingIntervalSeconds: 60,
    durationSeconds: 3600,
    zoneShrinkEnabled: false,
    playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
  };
  const state = {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase: 'HEAD_START',
      version: 1,
      config,
      createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: new Date(T0).toISOString(),
      endsAt: new Date(T0 + 3600_000).toISOString(),
      pausedAt: null,
      result: null,
    },
    players: [player('h1', 'hunter', 'Hunter', true), player('r1', 'runner', 'Runner 1'), player('r2', 'runner', 'Runner 2')],
    catches: [],
    hostTokens: {},
    serverSeq: 0,
    gameEventLog: [],
    lastPingAtMs: {},
    paused: false,
    pausedBy: null,
    pausedFrom: null,
    sosActive: false,
    eventLog: [],
    shrinkIndexApplied: 0,
    tickets: [],
    idempotency: [],
    idempotentReplies: [],
    pendingPings: [],
    pendingPingRecipients: {},
    pendingShrink: null,
  };
  const store = new RoomStore(state, emptyMemory());
  return store;
}

/** Fresh fixes for every seat at `nowMs` (the tick purges fixes older than 30 s). */
function freshFixes(store, nowMs) {
  for (const p of store.state.players) {
    store.mem.latestFix[p.playerId] = {
      lat: 23.35,
      lng: 85.33,
      accuracyMeters: 10,
      timestampMs: nowMs,
    };
  }
}

const pingEvents = (tick) => tick.events.filter((e) => e.type === 'ping');

test('alarmTick: no ping during HEAD_START, even after intervals elapsed since match start', () => {
  const store = makeStore();
  freshFixes(store, T0 + 120_000);
  const tick = store.alarmTick(T0 + 120_000);
  assert.equal(store.room.phase, 'HEAD_START');
  assert.deepEqual(pingEvents(tick), []);
});

test('alarmTick: no ping the instant ACTIVE begins; first ping one interval after ACTIVE', () => {
  const store = makeStore();
  freshFixes(store, T0 + HEAD_START_MS);
  const atActive = store.alarmTick(T0 + HEAD_START_MS);
  assert.equal(store.room.phase, 'ACTIVE');
  assert.deepEqual(pingEvents(atActive), []);

  freshFixes(store, T0 + HEAD_START_MS + PING_MS);
  const oneIntervalIn = store.alarmTick(T0 + HEAD_START_MS + PING_MS);
  const pings = pingEvents(oneIntervalIn);
  assert.ok(pings.length >= 2, `expected Runner + Hunter pings, got ${pings.length}`);
  // Mutual: Runner pings go to Hunters, Hunter pings go to Runners.
  const roles = pings.map((e) => e.payload['ping'].recipientRole);
  assert.ok(roles.includes('hunters'), 'a Runner ping to Hunters is expected');
  assert.ok(roles.includes('runners'), 'a Hunter ping to Runners is expected');
  for (const e of pings) {
    assert.equal(e.payload['ping'].uncertainty.radiusMeters, 150);
  }
});

test('reveal.send: rejected during HEAD_START, accepted once ACTIVE', async () => {
  const store = makeStore();
  const fix = (nowMs, lat) => ({ lat, lng: 85.33, accuracyMeters: 10, timestampMs: nowMs });
  const headStart = await store.handleWsMessage(
    { playerId: 'r1', sessionId: 's1' },
    { type: 'reveal.send', payload: { fix: fix(T0 + 60_000, 23.35) } },
    T0 + 60_000,
  );
  assert.equal(headStart.events.some((e) => e.type === 'reveal'), false);
  const err = headStart.events.find((e) => e.type === 'error');
  assert.ok(err, 'expected an error event during HEAD_START');
  assert.equal(err.payload['code'], 'INVALID_STATE');
  assert.match(String(err.payload['message']), /head start/);

  freshFixes(store, T0 + HEAD_START_MS);
  store.alarmTick(T0 + HEAD_START_MS);
  assert.equal(store.room.phase, 'ACTIVE');
  const active = await store.handleWsMessage(
    { playerId: 'r1', sessionId: 's1' },
    { type: 'reveal.send', payload: { fix: fix(T0 + HEAD_START_MS, 23.351) } },
    T0 + HEAD_START_MS,
  );
  assert.equal(active.events.some((e) => e.type === 'reveal'), true);
});

test('pendingPingsFor: nothing is delivered during HEAD_START', () => {
  const store = makeStore();
  const ping = {
    pingId: 'ping-1',
    roomId: 'room-1',
    subjectPlayerId: 'r1',
    recipientRole: 'hunters',
    uncertainty: { centre: { lat: 23.35, lng: 85.33 }, radiusMeters: 150 },
    ageSeconds: 0,
    qualityAtPing: 'good',
    createdAt: new Date(T0 + 60_000).toISOString(),
    expiresAt: new Date(T0 + 360_000).toISOString(),
  };
  store.mem.pendingPings = [ping];
  store.mem.pendingPingRecipients = new Map([['ping-1', new Set(['h1'])]]);
  assert.deepEqual(store.pendingPingsFor('h1', T0 + 60_000), []);

  freshFixes(store, T0 + HEAD_START_MS);
  store.alarmTick(T0 + HEAD_START_MS);
  assert.equal(store.room.phase, 'ACTIVE');
  assert.deepEqual(
    store.pendingPingsFor('h1', T0 + HEAD_START_MS).map((p) => p.pingId),
    ['ping-1'],
  );
});
