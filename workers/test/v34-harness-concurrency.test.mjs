import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { RoomDO } = await import('../src/room-do-class.ts');
const { STATE_KEY } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

globalThis.fetch = async () => ({ ok: true });

// v34 HARNESS (Arjun, QA) — approach (e): concurrency.
//
// 30 seats acting at once, reconnect storms, host + guest racing the
// same action, two tabs on the same seat. The DO serialises through
// blockConcurrencyWhile in production; these tests pin the outcomes
// that serialisation must produce — exactly one seat per join, exactly
// one match per start, no lost restores, no split-brain host.

const T0 = 1_780_000_000_000;
const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

class FakeStorage {
  constructor() { this.map = new Map(); }
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
  async setAlarm() {}
  async deleteAlarm() {}
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
    async flush() { await Promise.allSettled(pending); pending.length = 0; },
  };
}

function player(id, displayName, isHost = false) {
  return {
    playerId: id, roomId: 'room-1', kind: 'guest', displayName, isHost,
    matchRole: null, team: null, reconnectTokenHash: `reconnect-hash-${id}`,
    joinedAt: new Date(T0 - 1000).toISOString(), leftAt: null, ejectedAt: null,
    connectionState: 'connected', lastFixAt: null, locationQuality: null,
    isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
  };
}

function makeStore(playerCount = 3) {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 0, pingIntervalSeconds: 0, durationSeconds: 3600,
    zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 60, playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected', selectedHunterIds: ['hu1'], hunterCount: 1,
    balanceHunters: false, randomDraw: false, maxPlayers: 30,
  };
  // Exactly `playerCount` seats: host, then hu1, then r1, r2, ...
  const players = [player('h1', 'Host', true)];
  if (playerCount >= 2) players.push(player('hu1', 'Hunter 1'));
  for (let i = 1; players.length < playerCount; i += 1) {
    players.push(player(`r${i}`, `Runner ${i}`));
  }
  const state = {
    room: {
      roomId: 'room-1', roomCode: 'ABCDEF', hostPlayerId: 'h1', phase: 'LOBBY',
      version: 1, config, createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: null, endsAt: null, pausedAt: null, result: null,
    },
    players,
    catches: [], hostTokens: { h1: 'host-hash' }, serverSeq: 0,
    gameEventLog: [], lastPingAtMs: {}, paused: false, pausedBy: null, pausedFrom: null,
    eventLog: [], shrinkIndexApplied: 0, tickets: [], idempotency: [],
    idempotentReplies: [], pendingPings: [], pendingPingRecipients: {}, runnerQrTokens: [],
  };
  return new RoomStore(state, emptyMemory());
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

async function seedLobbyRoom(fake, seats = 3) {
  const store = makeStore(seats);
  await fake.storage.put(STATE_KEY, store.state);
}

async function sendWs(store, playerId, type, payload, commandId, atMs, sessionId = 's1') {
  return store.handleWsMessage({ playerId, sessionId }, { type, commandId, payload }, atMs);
}

test('v34 harness concurrency: 30 simultaneous joins yield exactly 30 seats, distinct ids and tokens', async () => {
  const fake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  await seedLobbyRoom(fake, 1); // host only; 29 guests join at once
  const doInstance = new RoomDO(fake.ctx, env);
  const joins = await Promise.all(
    Array.from({ length: 29 }, (_, i) => op(doInstance, {
      op: 'add-player', displayName: `Guest ${i + 1}`, roomCode: 'ABCDEF',
      reconnectTokenHash: null, idempotencyKey: `storm-join-${i + 1}`,
    })),
  );
  for (const [i, j] of joins.entries()) {
    assert.equal(j.status, 200, `join ${i + 1} must succeed: ${JSON.stringify(j.body)}`);
    assert.equal(j.body.ok, true);
  }
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.players.length, 30, '29 guests + host = 30 seats');
  const ids = new Set(stored.players.map((p) => p.playerId));
  assert.equal(ids.size, 30, 'every seat has a distinct playerId');
  const tokens = new Set(joins.map((j) => j.body.reconnectToken));
  assert.equal(tokens.size, 29, 'every guest has a distinct reconnect token');
  const tickets = new Set(joins.map((j) => j.body.wsTicket?.ticket).filter(Boolean));
  assert.equal(tickets.size, 29, 'every guest gets a distinct join-time WS ticket');
});

test('v34 harness concurrency: the 31st simultaneous join is CONFLICT — the room never exceeds 30', async () => {
  const fake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  await seedLobbyRoom(fake, 1);
  const doInstance = new RoomDO(fake.ctx, env);
  const joins = await Promise.all(
    Array.from({ length: 30 }, (_, i) => op(doInstance, {
      op: 'add-player', displayName: `Guest ${i + 1}`, roomCode: 'ABCDEF',
      reconnectTokenHash: null, idempotencyKey: `full-join-${i + 1}`,
    })),
  );
  const ok = joins.filter((j) => j.status === 200);
  const full = joins.filter((j) => j.status === 409);
  assert.equal(ok.length, 29, '29 guests fill the room to 30 with the host');
  assert.equal(full.length, 1, 'exactly one join is refused as full');
  assert.equal(full[0].body.code, 'CONFLICT');
  assert.match(full[0].body.error, /full/);
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.players.length, 30);
});

test('v34 harness concurrency: a reconnect storm restores 10 suspended seats with no duplicates and no lost roles', async () => {
  const store = makeStore(12);
  // Start the match, then suspend 10 seats at once (network-lost).
  const started = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  assert.equal(started.ok, true, JSON.stringify(started));
  store.alarmTick(T0 + 1000);
  assert.equal(store.room.phase, 'ACTIVE');
  const rolesBefore = new Map(store.state.players.map((p) => [p.playerId, p.matchRole]));
  const suspended = store.state.players.slice(1, 11);
  for (const p of suspended) store.suspendSeat(p.playerId, 'network-lost', T0 + 2000);
  assert.equal(suspended.filter((p) => p.connectionState === 'suspended').length, 10);
  // All 10 restore at once via the join path (name + reconnect token).
  const restores = await Promise.all(
    suspended.map((p) => store.addPlayerAsync({
      displayName: p.displayName, roomCode: 'ABCDEF',
      reconnectTokenHash: p.reconnectTokenHash, nowMs: T0 + 5000,
    })),
  );
  for (const r of restores) assert.equal(r.ok, true, `restore must succeed: ${r.ok ? '' : r.error}`);
  assert.equal(store.state.players.length, 12, 'a storm restore must not mint duplicate seats');
  for (const p of suspended) {
    assert.equal(p.connectionState, 'connected', `${p.displayName} must be connected again`);
    assert.equal(p.matchRole, rolesBefore.get(p.playerId), `${p.displayName} keeps their role`);
    assert.equal(store.reconnectEndsAtMs(p.playerId), null, 'the return window clears on restore');
  }
});

test('v34 harness concurrency: host and guest racing start — the guest is FORBIDDEN, the host starts exactly once', async () => {
  const fake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  await seedLobbyRoom(fake, 3);
  const doInstance = new RoomDO(fake.ctx, env);
  const [guest, host] = await Promise.all([
    op(doInstance, { op: 'start', playerId: 'r1', hostTokenHash: null, idempotencyKey: 'race-start-guest' }),
    op(doInstance, { op: 'start', playerId: 'h1', hostTokenHash: 'host-hash', idempotencyKey: 'race-start-host' }),
  ]);
  assert.equal(guest.status, 403, 'a guest start must be FORBIDDEN');
  assert.equal(guest.body.code, 'FORBIDDEN');
  assert.equal(host.status, 200, `the host start must succeed: ${JSON.stringify(host.body)}`);
  // A second host start (new key) refuses: the match is already running.
  const again = await op(doInstance, { op: 'start', playerId: 'h1', hostTokenHash: 'host-hash', idempotencyKey: 'race-start-host-2' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'INVALID_STATE');
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.phase, 'HEAD_START');
  assert.equal(stored.room.startedAt !== null, true, 'exactly one start stamped startedAt');
});

test('v34 harness concurrency: two tabs on the same seat both send fixes — the seat stays one seat, fixes stay fresh', async () => {
  const store = makeStore();
  store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  store.alarmTick(T0 + 1000);
  // Tab A and tab B (different sessionIds) stream fixes for r1.
  const a = await sendWs(store, 'r1', 'location.update', {
    fix: { ...INSIDE, accuracyMeters: 10, timestampMs: T0 + 2000 },
  }, 'fix-tab-a', T0 + 2000, 'tab-A');
  assert.equal(a.events.some((e) => e.type === 'error'), false);
  const b = await sendWs(store, 'r1', 'location.update', {
    fix: { lat: 23.35001, lng: 85.33001, accuracyMeters: 10, timestampMs: T0 + 3000 },
  }, 'fix-tab-b', T0 + 3000, 'tab-B');
  assert.equal(b.events.some((e) => e.type === 'error'), false);
  assert.equal(store.state.players.filter((p) => p.playerId === 'r1').length, 1,
    'two tabs must never duplicate the seat');
  assert.equal(store.mem.latestFix['r1'].timestampMs, T0 + 3000, 'the newest fix wins');
  // Both tabs requesting a snapshot see the same version.
  const snapA = await sendWs(store, 'r1', 'snapshot.request', { lastServerSeq: 0 }, 'snap-a', T0 + 3100, 'tab-A');
  const snapB = await sendWs(store, 'r1', 'snapshot.request', { lastServerSeq: 0 }, 'snap-b', T0 + 3100, 'tab-B');
  const verA = snapA.events.find((e) => e.type === 'snapshot').payload.version;
  const verB = snapB.events.find((e) => e.type === 'snapshot').payload.version;
  assert.equal(verA, verB, 'both tabs read the same room version');
});

test('v34 harness concurrency: 30 seats send fixes in the same second — all accepted, none lost to the throttle', async () => {
  const store = makeStore(30);
  store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  store.alarmTick(T0 + 1000);
  const results = await Promise.all(
    store.state.players.map((p, i) => sendWs(store, p.playerId, 'location.update', {
      fix: { lat: 23.35 + i * 0.0001, lng: 85.33, accuracyMeters: 10, timestampMs: T0 + 2000 },
    }, `fix-30-${p.playerId}`, T0 + 2000)),
  );
  const errors = results.filter((r) => r.events.some((e) => e.type === 'error'));
  assert.equal(errors.length, 0, `${errors.length} of 30 simultaneous fixes errored`);
  assert.equal(Object.keys(store.mem.latestFix).length, 30, 'all 30 fixes land in memory');
});

test('v34 harness concurrency: two Hunters racing the same Runner — sequential control (passes) + concurrent race (R2)', async () => {
  // Sequential control: the second request after the first claim opens
  // is CONFLICT. The logic is right when serialised.
  const sequential = makeStore();
  sequential.state.players.push(player('hu2', 'Hunter 2'));
  sequential.state.room.config.selectedHunterIds = ['hu1', 'hu2'];
  sequential.state.room.config.hunterCount = 2;
  sequential.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  sequential.alarmTick(T0 + 1000);
  for (const [pid, at] of [['hu1', T0 + 2000], ['hu2', T0 + 2000], ['r1', T0 + 2000]]) {
    await sendWs(sequential, pid, 'location.update', {
      fix: { ...INSIDE, accuracyMeters: 10, timestampMs: at },
    }, `fix-seq-${pid}`, at);
  }
  const seqFirst = await sendWs(sequential, 'hu1', 'catch.request', { runnerId: 'r1' }, 'seq-claim-1', T0 + 3000);
  assert.equal(seqFirst.events.some((e) => e.type === 'catch.requested'), true);
  const seqSecond = await sendWs(sequential, 'hu2', 'catch.request', { runnerId: 'r1' }, 'seq-claim-2', T0 + 3100);
  assert.equal(seqSecond.events.find((e) => e.type === 'error')?.payload.code, 'CONFLICT');
  assert.equal(sequential.state.catches.length, 1);

  // R2 — CONCURRENT RACE (fixed in v34, builder): two catch.requests
  // fired at once used to both pass the open-claim check before either
  // claim was pushed (the `await issueCatchToken` between the check and
  // the push was the interleave point), so ONE Runner ended up with TWO
  // claims. The fix re-checks `openCatchForRunner` after the token mint
  // and before the push, rolling the held token back on a race. The DO
  // class still does not serialise webSocketMessage (only load() and the
  // host-cancel delete run inside blockConcurrencyWhile) — full
  // serialisation remains an open hardening item.
  const store = makeStore();
  store.state.players.push(player('hu2', 'Hunter 2'));
  store.state.room.config.selectedHunterIds = ['hu1', 'hu2'];
  store.state.room.config.hunterCount = 2;
  store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  store.alarmTick(T0 + 1000);
  for (const [pid, at] of [['hu1', T0 + 2000], ['hu2', T0 + 2000], ['r1', T0 + 2000]]) {
    const r = await sendWs(store, pid, 'location.update', {
      fix: { ...INSIDE, accuracyMeters: 10, timestampMs: at },
    }, `fix-race-${pid}`, at);
    assert.equal(r.events.some((e) => e.type === 'error'), false);
  }
  const [first, second] = await Promise.all([
    sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'race-claim-1', T0 + 3000),
    sendWs(store, 'hu2', 'catch.request', { runnerId: 'r1' }, 'race-claim-2', T0 + 3000),
  ]);
  const opened = [first, second].filter((r) => r.events.some((e) => e.type === 'catch.requested'));
  const refused = [first, second].filter((r) => r.events.some((e) => e.type === 'error'));
  assert.equal(opened.length, 1, 'R2: exactly one Hunter opens the claim');
  assert.equal(refused.length, 1, 'R2: exactly one Hunter is refused');
  assert.equal(refused[0].events.find((e) => e.type === 'error').payload.code, 'CONFLICT');
  assert.equal(store.state.catches.length, 1, 'R2: one Runner, one claim — never two');
});

test('v34 harness concurrency: simultaneous double-submit of start with the SAME idempotency key — sequential control (passes) + concurrent race (R1)', async () => {
  // Sequential control: a retried start with the same key replays the
  // ORIGINAL reply. The cache logic is right when serialised.
  const seqFake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  await seedLobbyRoom(seqFake, 3);
  const seqDo = new RoomDO(seqFake.ctx, env);
  const seqA = await op(seqDo, { op: 'start', playerId: 'h1', hostTokenHash: 'host-hash', idempotencyKey: 'seq-double-start' });
  assert.equal(seqA.status, 200, JSON.stringify(seqA.body));
  const seqB = await op(seqDo, { op: 'start', playerId: 'h1', hostTokenHash: 'host-hash', idempotencyKey: 'seq-double-start' });
  assert.equal(seqB.status, 200, JSON.stringify(seqB.body));
  assert.equal(seqA.body.startedAt, seqB.body.startedAt, 'the retry replays the ORIGINAL start');

  // R1 — CONCURRENT RACE (fixed in v34, builder): two starts with the
  // SAME key fired at once used to both miss the HTTP idempotency cache
  // (the reply was cached only AFTER afterMutation), so the second
  // re-executed startMatch and got 409 INVALID_STATE instead of the
  // cached 200. The fix writes the cache BEFORE afterMutation and
  // re-checks it on failure branches (see `httpIdempotentReplay` in
  // room-do-class.ts), so a concurrent duplicate-key call replays the
  // original 200. Full /op-dispatch serialisation remains an open
  // hardening item.
  const fake = makeCtx();
  await seedLobbyRoom(fake, 3);
  const doInstance = new RoomDO(fake.ctx, env);
  const [a, b] = await Promise.all([
    op(doInstance, { op: 'start', playerId: 'h1', hostTokenHash: 'host-hash', idempotencyKey: 'double-start-1' }),
    op(doInstance, { op: 'start', playerId: 'h1', hostTokenHash: 'host-hash', idempotencyKey: 'double-start-1' }),
  ]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, `R1: the concurrent retry must replay the cached 200, got ${JSON.stringify(b.body)}`);
  assert.equal(a.body.startedAt, b.body.startedAt, 'R1: the retry replays the ORIGINAL start, not a second match');
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.phase, 'HEAD_START');
});
