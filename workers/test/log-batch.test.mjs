import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  persistLogBatch,
  deleteOldLogs,
  executePersistIntent,
} = await import('../src/supabase.ts');
const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// v29 (Gap 5) — structured logging: buffer cap + drop policy,
// deep coordinate stripping, PostgREST batch write, 7-day retention.
const T0 = 1_780_000_000_000;
const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' };

let captured = [];
globalThis.fetch = async (url, opts) => {
  captured.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
  return { ok: true };
};

function makeStore() {
  const state = {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase: 'LOBBY',
      version: 1,
      config: DEFAULT_ROOM_CONFIG,
      createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: null,
      endsAt: null,
      pausedAt: null,
      result: null,
    },
    players: [
      {
        playerId: 'h1', roomId: 'room-1', kind: 'guest', displayName: 'Host', isHost: true,
        matchRole: null, team: null, reconnectTokenHash: '', joinedAt: new Date(T0 - 1000).toISOString(),
        leftAt: null, ejectedAt: null, connectionState: 'connected', lastFixAt: null,
        locationQuality: null, isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
      },
    ],
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

test('persistLogBatch posts rows to logs and returns true', async () => {
  captured = [];
  const ok = await persistLogBatch(ENV, [
    { level: 'warn', message: 'ws.error', roomId: 'room-1', playerId: 'h1', metadata: { code: 'FORBIDDEN' } },
    { level: 'info', message: 'catch.confirm.duration', roomId: 'room-1', playerId: 'h1', operation: 'catch.confirm', durationMs: 3 },
  ]);
  assert.equal(ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://example.supabase.co/rest/v1/logs');
  assert.equal(captured[0].method, 'POST');
  assert.equal(captured[0].body.length, 2);
  assert.equal(captured[0].body[0].level, 'warn');
  assert.equal(captured[0].body[0].room_id, 'room-1');
  assert.equal(captured[0].body[0].metadata.code, 'FORBIDDEN');
  assert.equal(captured[0].body[1].duration_ms, 3);
  assert.equal(captured[0].body[1].operation, 'catch.confirm');
});

test('persistLogBatch deep-strips coordinate keys — a log row never carries a fix', async () => {
  captured = [];
  const ok = await persistLogBatch(ENV, [
    {
      level: 'error', message: 'ws.error', roomId: 'room-1',
      metadata: {
        code: 'VALIDATION_FAILED',
        lat: 23.35, lng: 85.33, latitude: 1, longitude: 2,
        fix: { lat: 23.35, lng: 85.33 },
        centre: { lat: 1, lng: 2 },
        nested: { fix: [{ lat: 1 }], keep: 'yes' },
      },
    },
  ]);
  assert.equal(ok, true);
  const row = captured[0].body[0];
  const meta = row.metadata;
  for (const k of ['lat', 'lng', 'latitude', 'longitude', 'fix', 'centre']) {
    assert.equal(k in meta, false, `top-level ${k} must be stripped`);
  }
  assert.equal('fix' in meta.nested, false, 'nested fix must be stripped');
  assert.equal(meta.nested.keep, 'yes', 'non-coordinate keys survive');
  assert.equal(meta.code, 'VALIDATION_FAILED');
});

test('persistLogBatch: empty batch returns true without fetching; unconfigured env returns false; a throwing fetch returns false, never throws', async () => {
  captured = [];
  assert.equal(await persistLogBatch(ENV, []), true);
  assert.equal(captured.length, 0, 'empty batch must not fetch');
  assert.equal(await persistLogBatch({}, [{ level: 'info', message: 'x' }]), false);
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('down'); };
  try {
    assert.equal(await persistLogBatch(ENV, [{ level: 'info', message: 'x' }]), false);
  } finally {
    globalThis.fetch = prev;
  }
});

test('executePersistIntent routes log-batch to persistLogBatch', async () => {
  captured = [];
  const ok = await executePersistIntent(ENV, {
    kind: 'log-batch',
    entries: [{ level: 'info', message: 'do.wake', roomId: 'room-1' }],
  });
  assert.equal(ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body[0].message, 'do.wake');
});

test('deleteOldLogs deletes rows older than 7 days and returns true; false when unconfigured', async () => {
  captured = [];
  const ok = await deleteOldLogs(ENV);
  assert.equal(ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'DELETE');
  assert.match(captured[0].url, /\/rest\/v1\/logs\?created_at=lt\./);
  assert.equal(await deleteOldLogs({}), false);
});

test('queueLog caps at 100: a warn evicts the oldest info; an info is dropped when the buffer holds only warn/error', () => {
  const store = makeStore();
  for (let i = 0; i < 100; i++) {
    store.queueLog({ level: 'info', message: `info-${i}` });
  }
  assert.equal(store.mem.logBuffer.length, 100);
  store.queueLog({ level: 'warn', message: 'warn-new' });
  assert.equal(store.mem.logBuffer.length, 100, 'cap holds');
  assert.equal(store.mem.logBuffer.some((e) => e.message === 'info-0'), false, 'oldest info evicted first');
  assert.equal(store.mem.logBuffer.some((e) => e.message === 'warn-new'), true, 'the warn is admitted');
  // Now fill with warns only and try an info: the info must be dropped.
  const store2 = makeStore();
  for (let i = 0; i < 100; i++) store2.queueLog({ level: 'warn', message: `warn-${i}` });
  store2.queueLog({ level: 'info', message: 'info-dropped' });
  assert.equal(store2.mem.logBuffer.length, 100);
  assert.equal(store2.mem.logBuffer.some((e) => e.message === 'info-dropped'), false);
  // A warn into a full warn buffer evicts the oldest to admit it.
  store2.queueLog({ level: 'error', message: 'error-new' });
  assert.equal(store2.mem.logBuffer.some((e) => e.message === 'error-new'), true);
  assert.equal(store2.mem.logBuffer.some((e) => e.message === 'warn-0'), false);
});

test('takeLogBatchIntent drains the buffer as one intent; empty buffer returns null', () => {
  const store = makeStore();
  assert.equal(store.takeLogBatchIntent(), null);
  store.queueLog({ level: 'info', message: 'a' });
  store.queueLog({ level: 'warn', message: 'b' });
  const intent = store.takeLogBatchIntent();
  assert.equal(intent?.kind, 'log-batch');
  assert.equal(intent?.entries.length, 2);
  assert.equal(store.mem.logBuffer.length, 0, 'drained');
  assert.equal(store.takeLogBatchIntent(), null);
});

test('a WS error is logged by code (errorEvent funnels into the buffer)', async () => {
  const store = makeStore();
  await store.handleWsMessage(
    { playerId: 'h1', sessionId: 's1' },
    { type: 'nonsense.type', commandId: 'c1', payload: {} },
    T0,
  );
  const entry = store.mem.logBuffer.find((e) => e.message === 'ws.error');
  assert.ok(entry, 'an unknown-type error must be logged');
  assert.equal(entry.metadata?.code, 'VALIDATION_FAILED');
  assert.equal(entry.level, 'warn');
});

test('a rate-limit hit is logged by operation + code', async () => {
  const store = makeStore();
  // Default WS limit is 20/60 s: 21 heartbeats at the same ms trip it.
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    const r = await store.handleWsMessage(
      { playerId: 'h1', sessionId: 's1' },
      { type: 'heartbeat', commandId: `hb-${i}`, payload: {} },
      T0,
    );
    if (r.events.some((e) => e.type === 'error' && e.payload?.code === 'RATE_LIMITED')) limited += 1;
  }
  assert.ok(limited >= 1, 'the 21st heartbeat must be rate-limited');
  const entry = store.mem.logBuffer.find((e) => e.message === 'ws.rate_limited');
  assert.ok(entry, 'the rate-limit hit must be logged');
  assert.equal(entry.metadata?.operation, 'heartbeat');
  assert.equal(entry.metadata?.code, 'RATE_LIMITED');
});
