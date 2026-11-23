import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  OPERATION_NON_MUTATING_TYPES,
  operationPrologue,
  operationEpilogue,
  operationCacheEarlyReply,
} = await import('../src/operation-wrapper.ts');
const { RoomStore, emptyMemory } = await import('../src/room-do.ts');

// v29 (Gap 2) — operation wrapper: the extracted idempotency +
// rate-limit + cached-reply prologue/epilogue. The wrapper never
// decides durability and never returns an error for a duplicate — a
// duplicate key returns the CACHED result.
const T0 = 1_780_000_000_000;

function makeMem() {
  const store = new RoomStore(
    {
      room: {
        roomId: 'room-1',
        roomCode: 'ABCDEF',
        hostPlayerId: 'h1',
        phase: 'LOBBY',
        version: 1,
        config: {},
        createdAt: new Date(T0).toISOString(),
        startedAt: null,
        endsAt: null,
        pausedAt: null,
        result: null,
      },
      players: [],
      catches: [],
      hostTokens: {},
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
    },
    emptyMemory(),
  );
  return store.mem;
}

function fakeEvent(type, recipients, payload = {}) {
  return { type, payload, recipients, serverSeq: 1, serverTs: new Date(T0).toISOString() };
}

test('non-mutating types skip the prologue entirely (no command recorded)', () => {
  for (const type of [...OPERATION_NON_MUTATING_TYPES]) {
    const mem = makeMem();
    const r = operationPrologue(mem, 'p1', type, 'cmd-1', T0);
    assert.equal(r.duplicate, false, `${type} must pass through`);
    assert.equal(mem.idempotency.size, 0, `${type} must record nothing`);
  }
});

test('first sight records the command; a retry returns the cached reply, never an error', () => {
  const mem = makeMem();
  const first = operationPrologue(mem, 'p1', 'catch.confirm', 'cmd-1', T0);
  assert.equal(first.duplicate, false);
  const reply = [fakeEvent('catch.confirmed', ['p1']), fakeEvent('room.state', ['p1', 'p2'])];
  operationEpilogue(mem, 'p1', 'catch.confirm', 'cmd-1', reply);
  const retry = operationPrologue(mem, 'p1', 'catch.confirm', 'cmd-1', T0 + 1000);
  assert.equal(retry.duplicate, true, 'same commandId must be a duplicate');
  assert.equal(retry.cached.length, 2, 'the cached reply is returned whole');
  assert.deepEqual(retry.cached[1].recipients, ['p1'], 'broadcast is narrowed to the replier only');
  assert.equal(retry.cached[0].type, 'catch.confirmed');
});

test('a different commandId is a fresh op, not a duplicate', () => {
  const mem = makeMem();
  operationPrologue(mem, 'p1', 'catch.confirm', 'cmd-1', T0);
  const second = operationPrologue(mem, 'p1', 'catch.confirm', 'cmd-2', T0 + 1000);
  assert.equal(second.duplicate, false);
});

test('a different seat with the same commandId is a fresh op', () => {
  const mem = makeMem();
  operationPrologue(mem, 'p1', 'ready.set', 'cmd-1', T0);
  const other = operationPrologue(mem, 'p2', 'ready.set', 'cmd-1', T0 + 1000);
  assert.equal(other.duplicate, false);
});

test('per-viewer events for OTHER seats are never cached', () => {
  const mem = makeMem();
  operationPrologue(mem, 'p1', 'catch.confirm', 'cmd-1', T0);
  const reply = [fakeEvent('snapshot', ['p2'])];
  operationEpilogue(mem, 'p1', 'catch.confirm', 'cmd-1', reply);
  const retry = operationPrologue(mem, 'p1', 'catch.confirm', 'cmd-1', T0 + 1000);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.cached.length, 0, 'an event addressed only to p2 must not replay to p1');
});

test('messages without a commandId pass through with nothing recorded', () => {
  const mem = makeMem();
  const r = operationPrologue(mem, 'p1', 'catch.confirm', undefined, T0);
  assert.equal(r.duplicate, false);
  assert.equal(mem.idempotency.size, 0);
  operationEpilogue(mem, 'p1', 'catch.confirm', undefined, [fakeEvent('x', ['p1'])]);
  assert.equal(mem.idempotentReplies.size, 0);
});

test('operationCacheEarlyReply records the command AND caches the error reply', () => {
  const mem = makeMem();
  const error = [fakeEvent('error', ['p1'], { code: 'RATE_LIMITED' })];
  operationCacheEarlyReply(mem, 'p1', 'ready.set', 'cmd-9', error, T0);
  const retry = operationPrologue(mem, 'p1', 'ready.set', 'cmd-9', T0 + 1000);
  assert.equal(retry.duplicate, true, 'the early error must be replayed, not an empty []');
  assert.equal(retry.cached.length, 1);
  assert.equal(retry.cached[0].payload.code, 'RATE_LIMITED');
});

test('the six named Gap 2 ops all run the prologue (mutating set)', () => {
  for (const type of [
    'catch.request',
    'catch.confirm',
    'catch.self-confirm',
    'catch.runner-token',
    'ready.set',
    'safety.pause',
    'safety.resume',
  ]) {
    assert.equal(OPERATION_NON_MUTATING_TYPES.has(type), false, `${type} must be mutating`);
    const mem = makeMem();
    const r = operationPrologue(mem, 'p1', type, 'cmd-x', T0);
    assert.equal(r.duplicate, false);
    assert.equal(mem.idempotency.size, 1, `${type} must record its command`);
  }
});
