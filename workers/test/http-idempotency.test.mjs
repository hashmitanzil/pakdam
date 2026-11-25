import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomDO } = await import('../src/room-do-class.ts');
const { STATE_KEY } = await import('../src/room-do.ts');
const { err, idempotencyKeyFromRequest, handleJoin, handleStart } = await import('../src/http.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// v29 (Gap 4) — HTTP idempotency: the `Idempotency-Key` header is
// read on POST routes and forwarded into the DO op; the DO caches
// the result keyed by (seat, key) in memory (10-min TTL) and a
// duplicate call returns the cached response body with the original
// status — for join, including the ORIGINAL reconnectToken. The
// error envelope carries a `code` field alongside `error`.
const T0 = 1_780_000_000_000;
globalThis.fetch = async () => ({ ok: true });

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const IDS = {
  h1: 'aaaaaaaa-1111-4111-8111-111111111111',
  r1: 'bbbbbbbb-2222-4222-8222-222222222222',
  hu1: 'dddddddd-4444-4444-8444-444444444444',
};

class FakeStorage {
  constructor() { this.map = new Map(); this.alarmsSet = []; this.alarmsDeleted = 0; }
  async get(k) { return this.map.get(k); }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
  async list({ start, end } = {}) {
    const out = new Map();
    for (const k of [...this.map.keys()].sort()) {
      if (start !== undefined && k < start) continue;
      if (end !== undefined && k >= end) continue;
      out.set(k, this.map.get(k));
    }
    return out;
  }
  async setAlarm(ms) { this.alarmsSet.push(ms); }
  async deleteAlarm() { this.alarmsDeleted += 1; }
}

function makeCtx() {
  const storage = new FakeStorage();
  const sockets = new Map();
  const pending = [];
  return {
    ctx: {
      storage,
      blockConcurrencyWhile: async (fn) => fn(),
      getWebSockets: (tag) => sockets.get(tag) ?? [],
      waitUntil: (p) => { pending.push(p); p.catch(() => undefined); },
    },
    storage,
    sockets,
    async flush() { await Promise.allSettled(pending); pending.length = 0; },
  };
}

function player(id, displayName, isHost, joinedAtMs) {
  return {
    playerId: id, roomId: 'room-1', kind: 'guest', displayName, isHost,
    matchRole: null, team: null, reconnectTokenHash: `reconnect-hash-${id}`,
    joinedAt: new Date(joinedAtMs).toISOString(), leftAt: null, ejectedAt: null,
    connectionState: 'connected', lastFixAt: null, locationQuality: null,
    isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
  };
}

async function seedRoom(fake) {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 0, pingIntervalSeconds: 0, durationSeconds: 3600,
    zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 60, playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected', selectedHunterIds: [IDS.hu1], hunterCount: 1,
    balanceHunters: false, randomDraw: false,
  };
  await fake.storage.put(STATE_KEY, {
    room: {
      roomId: 'room-1', roomCode: 'ABCDEF', hostPlayerId: IDS.h1, phase: 'LOBBY',
      version: 1, config, createdAt: new Date(Date.now() - 5000).toISOString(),
      startedAt: null, endsAt: null, pausedAt: null, result: null,
    },
    players: [
      player(IDS.h1, 'Host', true, T0 - 5000),
      player(IDS.r1, 'Runner 1', false, T0 - 4000),
      player(IDS.hu1, 'Hunter 1', false, T0 - 2000),
    ],
    catches: [], hostTokens: { [IDS.h1]: 'host-hash' }, serverSeq: 0, deleted: false,
    gameEventLog: [], lastPingAtMs: {}, paused: false, pausedBy: null, pausedFrom: null,
    eventLog: [], shrinkIndexApplied: 0, tickets: [], idempotency: [],
    idempotentReplies: [], pendingPings: [], pendingPingRecipients: {}, runnerQrTokens: [],
  });
}

async function op(doInstance, body) {
  const res = await doInstance.fetch(
    new Request('http://do.test/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

test('idempotencyKeyFromRequest: present key, absent, empty, over-long, whitespace', () => {
  assert.equal(idempotencyKeyFromRequest(new Request('http://x/', { headers: { 'Idempotency-Key': 'abc-123' } })), 'abc-123');
  assert.equal(idempotencyKeyFromRequest(new Request('http://x/')), null);
  assert.equal(idempotencyKeyFromRequest(new Request('http://x/', { headers: { 'Idempotency-Key': '   ' } })), null);
  assert.equal(idempotencyKeyFromRequest(new Request('http://x/', { headers: { 'Idempotency-Key': 'x'.repeat(65) } })), null);
  assert.equal(idempotencyKeyFromRequest(new Request('http://x/', { headers: { 'Idempotency-Key': '  padded  ' } })), 'padded');
});

test('err() carries the code field alongside error (additive envelope)', async () => {
  const res = err('Only the host can start.', 403, undefined, 'FORBIDDEN');
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'Only the host can start.', code: 'FORBIDDEN' });
  // v34 delivery gate (zero-break bar): a codeless error is a silent
  // failure the client cannot surface, so err() now DEFAULTS the code
  // from the status (VALIDATION_FAILED for 400 here) when no explicit
  // code is given. An explicit code still overrides the default.
  const plain = err('Plain.', 400);
  assert.deepEqual(await plain.json(), { error: 'Plain.', code: 'VALIDATION_FAILED' });
  const server = err('Boom.', 500);
  assert.deepEqual(await server.json(), { error: 'Boom.', code: 'SERVER_ERROR' });
});

test('DO add-player with the same key returns the cached reply with the ORIGINAL reconnectToken', async () => {
  const fake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  await seedRoom(fake);
  const doInstance = new RoomDO(fake.ctx, env);
  const first = await op(doInstance, {
    op: 'add-player', displayName: 'Newbie', roomCode: 'ABCDEF',
    reconnectTokenHash: null, idempotencyKey: 'join-key-1',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(typeof first.body.reconnectToken, 'string');
  assert.ok(first.body.reconnectToken.length > 0);
  const token = first.body.reconnectToken;
  const playerId = first.body.player.playerId;
  const again = await op(doInstance, {
    op: 'add-player', displayName: 'Newbie', roomCode: 'ABCDEF',
    reconnectTokenHash: null, idempotencyKey: 'join-key-1',
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.reconnectToken, token, 'the retry must return the ORIGINAL token, not a new seat');
  assert.equal(again.body.player.playerId, playerId);
  // A different key is a different action: a new displayName joins fresh.
  const other = await op(doInstance, {
    op: 'add-player', displayName: 'Second', roomCode: 'ABCDEF',
    reconnectTokenHash: null, idempotencyKey: 'join-key-2',
  });
  assert.equal(other.status, 200);
  assert.notEqual(other.body.player.playerId, playerId);
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.players.length, 5, 'one cached retry must not mint a second seat');
});

test('DO start with the same key returns the cached ok; a new key re-executes (409)', async () => {
  const fake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  await seedRoom(fake);
  const doInstance = new RoomDO(fake.ctx, env);
  const first = await op(doInstance, {
    op: 'start', playerId: IDS.h1, hostTokenHash: 'host-hash', idempotencyKey: 'start-key-1',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  const again = await op(doInstance, {
    op: 'start', playerId: IDS.h1, hostTokenHash: 'host-hash', idempotencyKey: 'start-key-1',
  });
  assert.equal(again.status, 200, 'the cached start must return ok, not a 409 re-execution');
  assert.equal(again.body.ok, true);
  const fresh = await op(doInstance, {
    op: 'start', playerId: IDS.h1, hostTokenHash: 'host-hash', idempotencyKey: 'start-key-2',
  });
  assert.equal(fresh.status, 409, 'a NEW key must re-execute and fail (already started)');
  assert.equal(fresh.body.ok, false);
});

test('HTTP handleJoin forwards the header key: a retried join returns the original token', async () => {
  const fake = makeCtx();
  const doInstance = new RoomDO(fake.ctx, { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  await seedRoom(fake);
  const env = {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    ROOM_DO: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (url, init) => doInstance.fetch(new Request(url, init)),
      }),
    },
  };
  const ctx = { env, ctx: { waitUntil: (p) => { p.catch(() => undefined); } } };
  const joinReq = () =>
    new Request('http://worker.test/v1/rooms/room-1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-join-1' },
      body: JSON.stringify({ displayName: 'HttpJoin', kind: 'guest', roomCode: 'ABCDEF' }),
    });
  const first = await handleJoin(joinReq(), ctx, 'room-1');
  assert.equal(first.status, 200, await first.clone().text());
  const firstBody = await first.json();
  assert.equal(typeof firstBody.reconnectToken, 'string');
  const again = await handleJoin(joinReq(), ctx, 'room-1');
  const againBody = await again.json();
  assert.equal(again.status, 200);
  assert.equal(againBody.reconnectToken, firstBody.reconnectToken, 'HTTP retry must return the original token');
  assert.equal(againBody.player.playerId, firstBody.player.playerId);
});

test('HTTP handleStart failure envelope carries the DO code through (doError passthrough)', async () => {
  const fake = makeCtx();
  const doInstance = new RoomDO(fake.ctx, { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  await seedRoom(fake);
  const env = {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    ROOM_DO: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (url, init) => doInstance.fetch(new Request(url, init)),
      }),
    },
  };
  const ctx = { env, ctx: { waitUntil: (p) => { p.catch(() => undefined); } } };
  const res = await handleStart(
    new Request('http://worker.test/v1/rooms/room-1/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: IDS.h1, hostToken: 'wrong-token' }),
    }),
    ctx,
    'room-1',
  );
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, 'FORBIDDEN', 'the DO code must reach the HTTP envelope, not be dropped');
  assert.equal(typeof body.error, 'string');
});
