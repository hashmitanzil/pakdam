import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// v34 (R2-14 seam 2) — Kabir (server): error envelopes echo the
// request's `commandId` as `requestId`, so the client can match an
// error to the request that caused it instead of matching by receipt
// time. Before this, Meera's self-confirm error matching was
// time-only: a `location.update` STALE_LOCATION error arriving within
// 15 s of an OK tap surfaced as the confirm's failure. The field is
// additive (`WsErrorPayload.requestId` already existed in
// @pakdam/shared — the server just never set it) and omitted when
// the client sent no commandId, so old clients see no change.
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

function storePlayer(playerId, displayName, isHost = false) {
  return {
    playerId, roomId: 'room-1', kind: 'guest', displayName, isHost,
    matchRole: null, team: null, reconnectTokenHash: '',
    joinedAt: new Date(T0 - 1000).toISOString(), leftAt: null, ejectedAt: null,
    connectionState: 'connected', lastFixAt: null, locationQuality: null,
    isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
  };
}

function makeStore() {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 0, pingIntervalSeconds: 0, durationSeconds: 3600,
    zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 60, playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected', selectedHunterIds: ['hu1'], hunterCount: 1,
    balanceHunters: false, randomDraw: false,
  };
  const state = {
    room: {
      roomId: 'room-1', roomCode: 'ABCDEF', hostPlayerId: 'h1', phase: 'LOBBY',
      version: 1, config, createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: null, endsAt: null, pausedAt: null, result: null,
    },
    players: [storePlayer('h1', 'Host', true), storePlayer('hu1', 'Hunter 1'), storePlayer('r1', 'Runner 1')],
    catches: [], hostTokens: { h1: 'host-hash' }, serverSeq: 0,
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
  assert.equal(
    r.events.some((e) => e.type === 'error'),
    false,
    `fix for ${playerId} at ${atMs} must be accepted`,
  );
  return r;
}

async function sendWs(store, playerId, type, payload, commandId, atMs) {
  return store.handleWsMessage(
    { playerId, sessionId: 's1' },
    { type, commandId, payload },
    atMs,
  );
}

function errorOf(result) {
  return result.events.find((e) => e.type === 'error');
}

test('v34 R2-14: a failed self-confirm echoes its own commandId as requestId', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  // The Runner's last fix is from the play page (T0+2000); by the OK
  // tap at T0+65000 it is 63 s old. The Hunter's fix is fresh.
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 64000);
  const r = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-req-1', T0 + 65000);
  const err = errorOf(r);
  assert.ok(err, 'a stale-fix self-confirm must answer with an error envelope');
  assert.equal(err.payload['code'], 'STALE_LOCATION');
  assert.equal(err.payload['message'], 'Waiting for GPS — move closer and try again.');
  assert.equal(err.payload['retryable'], false);
  assert.equal(err.payload['requestId'], 'sc-req-1', 'the error must carry the self-confirm request id');
  assert.deepEqual(err.recipients, ['r1'], 'the rejection goes to the Runner only');
  assert.equal(store.state.catches.length, 0, 'a rejected self-confirm must create no claim');
});

test('v34 R2-14: a location.update STALE_LOCATION error does NOT carry the self-confirm requestId (mismatch must not match)', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 64000);
  // The Runner's phone sends a fix stamped T0+2000 at T0+65000 — 63 s
  // old on arrival, so location.update itself is rejected STALE_LOCATION.
  const loc = await sendWs(
    store, 'r1', 'location.update',
    { fix: { ...INSIDE, accuracyMeters: 10, timestampMs: T0 + 2000 } },
    'loc-req-9', T0 + 65000,
  );
  const locErr = errorOf(loc);
  assert.ok(locErr, 'a stale fix must be rejected');
  assert.equal(locErr.payload['code'], 'STALE_LOCATION');
  assert.equal(locErr.payload['requestId'], 'loc-req-9', 'the location error carries the location request id');
  // The self-confirm OK tap, same second, same code — but its own id.
  const sc = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-req-2', T0 + 65000);
  const scErr = errorOf(sc);
  assert.ok(scErr, 'the stale-fix self-confirm must answer with an error envelope');
  assert.equal(scErr.payload['code'], 'STALE_LOCATION');
  assert.equal(scErr.payload['requestId'], 'sc-req-2', 'the confirm error carries the confirm request id');
  // The seam, pinned: same code, same second, different ids — a client
  // matching on requestId can tell them apart; matching on time cannot.
  assert.notEqual(
    locErr.payload['requestId'],
    scErr.payload['requestId'],
    'the two errors must not share a requestId',
  );
  assert.notEqual(locErr.payload['requestId'], 'sc-req-2');
  assert.notEqual(scErr.payload['requestId'], 'loc-req-9');
});

test('v34 R2-14: a request with no commandId gets an error with no requestId field (old clients see no change)', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE (roles assigned: r1 is a Runner)
  const r = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'nobody' }, undefined, T0 + 2000);
  const err = errorOf(r);
  assert.ok(err, 'an unknown-Hunter self-confirm must answer with an error envelope');
  assert.equal(err.payload['code'], 'VALIDATION_FAILED');
  assert.equal(err.payload['message'], 'That Hunter is not in the room.');
  assert.equal('requestId' in (err.payload ?? {}), false, 'no commandId in means no requestId out — never an empty value');
});

test('v34 R2-14: the echo is not catch-only — a ready.set validation error carries its requestId too', async () => {
  const store = makeStore();
  const r = await sendWs(store, 'r1', 'ready.set', { isReady: 'yes' }, 'ready-req-1', T0 + 1000);
  const err = errorOf(r);
  assert.ok(err, 'a malformed ready.set must answer with an error envelope');
  assert.equal(err.payload['code'], 'VALIDATION_FAILED');
  assert.equal(err.payload['requestId'], 'ready-req-1');
});

test('v34 R2-14: a same-commandId retry replays the cached error with the same requestId', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 64000);
  const first = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-req-1', T0 + 65000);
  assert.equal(errorOf(first)?.payload['requestId'], 'sc-req-1');
  // Retry with the SAME commandId: the cached reply, not a re-apply and
  // not an empty success — and the echo still names this request.
  const retry = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-req-1', T0 + 66000);
  const retryErr = errorOf(retry);
  assert.ok(retryErr, 'the retry must replay the cached error, not an empty reply');
  assert.equal(retryErr.payload['code'], 'STALE_LOCATION');
  assert.equal(retryErr.payload['requestId'], 'sc-req-1');
  assert.equal(store.state.catches.length, 0, 'a retried rejection must still create no claim');
});
