import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// Phase 4 fix-round regression tests (Diya's adversarial review):
// (i) accepted GPS fix advances serverSeq (snapshot key moves),
// (q) early returns cache their error reply (no empty-[] false success),
// (r) radio.send content dedupe drops a same-content double-delivery.
// (s) heartbeat first-tick-after-wake grace lives in RoomDO.alarm()
// (room-do-class.ts, needs a DO ctx) — verified by inspection +
// typecheck, not unit-testable with the RoomStore harness.
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];

function player(playerId, displayName, isHost = false) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole: null,
    team: null,
    reconnectTokenHash: '',
    joinedAt: new Date(T0 - 1000).toISOString(),
    leftAt: null,
    ejectedAt: null,
    connectionState: 'connected',
    lastFixAt: null,
    locationQuality: null,
    isReady: false,
    briefingConfirmed: false,
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
      phase: 'LOBBY',
      version: 1,
      config,
      createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: null,
      endsAt: null,
      pausedAt: null,
      result: null,
    },
    players: [player('h1', 'Host', true), player('r1', 'Runner 1')],
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
  return new RoomStore(state, emptyMemory());
}

const fix = (nowMs, lat) => ({ lat, lng: 85.33, accuracyMeters: 10, timestampMs: nowMs });

test('(i) an accepted GPS fix advances serverSeq without a per-fix save', async () => {
  const store = makeStore();
  const before = store.snapshotFor('r1', T0).serverSeq;
  const first = await store.handleWsMessage(
    { playerId: 'r1', sessionId: 's1' },
    { type: 'location.update', commandId: 'fix-1', payload: { fix: fix(T0, 23.35) } },
    T0,
  );
  assert.ok(first.events.length >= 0);
  const mid = store.snapshotFor('r1', T0).serverSeq;
  assert.ok(mid > before, `serverSeq must move on an accepted fix (${before} -> ${mid})`);
  // Second fix 1.5 s later: past the 1/s throttle, same quality, no
  // persist due (30 s) — so durable:false and no persist intent, but
  // the snapshot key must move again, or an HTTP re-fetch would be
  // skipped as identical while the fix aged.
  const second = await store.handleWsMessage(
    { playerId: 'r1', sessionId: 's1' },
    { type: 'location.update', commandId: 'fix-2', payload: { fix: fix(T0 + 1500, 23.3501) } },
    T0 + 1500,
  );
  assert.equal(second.durable, false, 'a quiet fix must not force a save');
  assert.deepEqual(second.persist, [], 'a quiet fix must not emit a persist intent');
  const after = store.snapshotFor('r1', T0 + 1500).serverSeq;
  assert.ok(after > mid, `serverSeq must move on every accepted fix (${mid} -> ${after})`);
});

test('(q) a rate-limited retry gets the cached error, not an empty []', async () => {
  const store = makeStore();
  // ready.set allows 10/min/seat: burn the budget with distinct ids.
  for (let i = 0; i < 10; i += 1) {
    const r = await store.handleWsMessage(
      { playerId: 'r1', sessionId: 's1' },
      { type: 'ready.set', commandId: `ready-${i}`, payload: { isReady: true } },
      T0 + i,
    );
    assert.equal(r.events.some((e) => e.type === 'error'), false, `ready-${i} must not error`);
  }
  const limited = await store.handleWsMessage(
    { playerId: 'r1', sessionId: 's1' },
    { type: 'ready.set', commandId: 'ready-limited', payload: { isReady: true } },
    T0 + 11,
  );
  assert.equal(limited.events.length, 1, 'rate limit must return exactly one error event');
  assert.equal(limited.events[0].type, 'error');
  assert.equal(limited.events[0].payload['code'], 'RATE_LIMITED');
  // Same commandId again: the cached error, not [] (the false success).
  const retry = await store.handleWsMessage(
    { playerId: 'r1', sessionId: 's1' },
    { type: 'ready.set', commandId: 'ready-limited', payload: { isReady: true } },
    T0 + 12,
  );
  assert.equal(retry.events.length, 1, 'retry must replay the cached error, not []');
  assert.equal(retry.events[0].type, 'error');
  assert.equal(retry.events[0].payload['code'], 'RATE_LIMITED');
});

test('(q) a leave retry gets an error, not an empty []', async () => {
  const store = makeStore();
  const left = await store.handleWsMessage(
    { playerId: 'r1', sessionId: 's1' },
    { type: 'leave', commandId: 'leave-1', payload: {} },
    T0,
  );
  assert.equal(left.close?.code, 1000, 'leave must close the socket');
  assert.ok(left.events.length > 0, 'leave must return its reply events');
  const retry = await store.handleWsMessage(
    { playerId: 'r1', sessionId: 's1' },
    { type: 'leave', commandId: 'leave-1', payload: {} },
    T0 + 1000,
  );
  assert.ok(retry.events.length > 0, 'leave retry must not return an empty []');
  assert.equal(retry.events[0].type, 'error', 'leave retry must surface an error');
});

test('(r) radio.send drops an identical message inside the dedupe window', async () => {
  const store = makeStore();
  const send = (commandId, text, atMs) =>
    store.handleWsMessage(
      { playerId: 'r1', sessionId: 's1' },
      { type: 'radio.send', commandId, payload: { text, kind: 'text' } },
      atMs,
    );
  const first = await send('radio-1', 'Hello team', T0);
  assert.equal(first.events.filter((e) => e.type === 'radio').length, 1, 'first send goes through');
  const dup = await send('radio-2', 'Hello team', T0 + 1000);
  assert.deepEqual(dup.events, [], 'identical text inside 5 s is dropped as a duplicate');
  const other = await send('radio-3', 'Hello again', T0 + 2000);
  assert.equal(other.events.filter((e) => e.type === 'radio').length, 1, 'different text goes through');
  const afterWindow = await send('radio-4', 'Hello team', T0 + 6000);
  assert.equal(
    afterWindow.events.filter((e) => e.type === 'radio').length,
    1,
    'the same text goes through again once the window has passed',
  );
  // Same-commandId retry of the original send still gets the original
  // radio event (commandId idempotency is untouched by the dedupe).
  const replay = await send('radio-1', 'Hello team', T0 + 7000);
  assert.equal(replay.events.filter((e) => e.type === 'radio').length, 1, 'replay returns the original radio event');
});
