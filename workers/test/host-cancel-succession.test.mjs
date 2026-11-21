import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory, STATE_KEY } = await import('../src/room-do.ts');
const { RoomDO } = await import('../src/room-do-class.ts');
const sharedNs = await import('@pakdam/shared');
const {
  DEFAULT_ROOM_CONFIG,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSED_LIMIT,
} = sharedNs;

// v23 host/lobby rules — GAP-ONLY tests (Kabir, server, 2026-11-21).
// Arjun owns the contract tests in v23-host-rules.test.mjs (store) and
// v23-host-rules-do.test.mjs (DO class); this file covers ONLY what
// those two do not:
//
//   1. Store: the WS `player.suspended` handler path never transfers
//      host (tab-hidden / screen-locked arriving as a client message).
//      Arjun pins the bare `suspendSeat` call; this pins the actual
//      `handleWsMessage` entry point the client hits.
//   2. Store: `verifyHost` returns null after deletion (pinned in
//      prose in Arjun's header; no test calls it directly).
//   3. Store: rejoin by code refuses after deletion (`addPlayerAsync`
//      answers 404 ROOM_NOT_FOUND on a deleted room).
//   4. Class: the Supabase cancel record is persisted BEFORE the DO
//      storage wipe (fetch order vs `deleteAll`, with a real fetch
//      stub — Arjun's env has no Supabase configured, so persist
//      no-ops there).
//   5. Class: heartbeat-timeout succession via the real `alarm()`
//      tick (Arjun's DO file drives succession only via
//      `webSocketClose`; the alarm path is a separate trigger).
//
// Settled contract (third version, 2026-11-21): `cancelMatch` IS the
// store-level deleter — phase CANCELLED, result built,
// `state.deleted = true`, exactly ONE event, a literal
// `'room.deleted'` with `{ result }`, NO `match.cancelled` from the
// store; later ops refuse 404 ROOM_NOT_FOUND. The DO class translates
// the signal into the delivered stream (`match.cancelled` synthesised
// FIRST, then `room.deleted`, then the `room.state` notice with reason
// `'room-deleted'` LAST), persists the cancel record, unregisters the
// invite code, closes every socket and wipes DO storage. Succession
// lives in `suspendSeat`, gated on the reason ('network-lost' /
// 'heartbeat-timeout' transfer; 'tab-hidden' / 'screen-locked' /
// 'unknown' never do).
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];

function seat(playerId, displayName, opts = {}) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost: opts.isHost ?? false,
    matchRole: opts.matchRole ?? null,
    team: opts.team ?? null,
    reconnectTokenHash: `rt-hash-${playerId}`,
    joinedAt: new Date(opts.joinedAtMs ?? T0).toISOString(),
    leftAt: opts.leftAt ?? null,
    ejectedAt: null,
    connectionState: opts.connectionState ?? 'connected',
    lastFixAt: null,
    locationQuality: null,
    isReady: true,
    briefingConfirmed: true,
    ageGatePassed: true,
    suspensionCount: 0,
  };
}

/**
 * Store with a fixed join order: h1 (host) T0, p2 T0+1s, p3 T0+2s,
 * p4 T0+3s. `players` overrides the roster; `phase` defaults to
 * LOBBY.
 */
function makeStore({ phase = 'LOBBY', players, startedAtMs = null } = {}) {
  const list =
    players ??
    [
      seat('h1', 'Host', { isHost: true, joinedAtMs: T0 }),
      seat('p2', 'P2', { joinedAtMs: T0 + 1000 }),
      seat('p3', 'P3', { joinedAtMs: T0 + 2000 }),
      seat('p4', 'P4', { joinedAtMs: T0 + 3000 }),
    ];
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
    selectedHunterIds: ['p3'],
    hunterCount: 1,
    balanceHunters: false,
    randomDraw: false,
  };
  const state = {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase,
      version: 1,
      config,
      createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
      endsAt: null,
      pausedAt: null,
      result: null,
    },
    players: list,
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

/** Host-cancel the store's room (lifecycle end, host-only). */
function hostCancel(store, nowMs) {
  return store.lifecycleOp({
    action: 'end',
    playerId: 'h1',
    hostTokenHash: 'host-hash',
    nowMs,
  });
}

// ---------------------------------------------------------------------------
// Gap 1 — the WS `player.suspended` handler path never transfers host
// ---------------------------------------------------------------------------

test('v23 (gap) WS player.suspended tab-hidden / screen-locked never transfers host', async () => {
  const store = makeStore();
  for (const reason of ['tab-hidden', 'screen-locked']) {
    const r = await store.handleWsMessage(
      { playerId: 'h1', sessionId: 'tab-h1' },
      { type: 'player.suspended', payload: { reason } },
      T0 + 1000,
    );
    assert.equal(
      r.events.some((e) => e.type === 'host.transferred'),
      false,
      `a ${reason} message must never emit host.transferred`,
    );
    assert.equal(
      store.room.hostPlayerId,
      'h1',
      `the host keeps host after a ${reason} message`,
    );
    assert.equal(
      store.player('h1').connectionState,
      'suspended',
      'the seat is still marked suspended (the message was honoured)',
    );
  }
  // And the seat is still the host in the snapshot the client reads.
  const snap = store.getStateOp({
    playerId: 'h1',
    reconnectTokenHash: 'rt-hash-h1',
    nowMs: T0 + 2000,
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.value.room.hostPlayerId, 'h1');
});

// ---------------------------------------------------------------------------
// Gap 2 — a deleted room refuses host-token checks and rejoins
// ---------------------------------------------------------------------------

test('v23 (gap) verifyHost returns null after host cancel deletes the room', () => {
  const store = makeStore();
  assert.notEqual(store.verifyHost('h1', 'host-hash'), null, 'host verifies before cancel');
  const r = hostCancel(store, T0 + 1000);
  assert.equal(r.ok, true, `host cancel must succeed: ${r.ok ? '' : r.error}`);
  assert.equal(store.verifyHost('h1', 'host-hash'), null, 'no host-token check passes on a deleted room');
});

test('v23 (gap) rejoin by code refuses after host cancel deletes the room', async () => {
  const store = makeStore();
  const r = hostCancel(store, T0 + 1000);
  assert.equal(r.ok, true, `host cancel must succeed: ${r.ok ? '' : r.error}`);
  const joined = await store.addPlayerAsync({
    displayName: 'Late',
    roomCode: 'ABCDEF',
    reconnectTokenHash: null,
    nowMs: T0 + 2000,
  });
  assert.equal(joined.ok, false, 'rejoin after deletion must fail');
  assert.equal(joined.code, 'ROOM_NOT_FOUND');
  assert.equal(joined.status, 404);
});

// ---------------------------------------------------------------------------
// Class harness (mirrors v23-host-rules-do.test.mjs; fake DO state / env)
// ---------------------------------------------------------------------------

class FakeSocket {
  sent = [];
  closed = [];
  send(text) {
    this.sent.push(text);
  }
  close(code, reason) {
    this.closed.push({ code, reason });
  }
}

class FakeStorage {
  map = new Map();
  alarmsDeleted = 0;
  alarmsSet = [];
  async get(key) {
    return this.map.get(key);
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
  async deleteAll() {
    this.map.clear();
  }
  async deleteAlarm() {
    this.alarmsDeleted += 1;
  }
  async setAlarm(atMs) {
    this.alarmsSet.push(atMs);
  }
  async list({ prefix } = {}) {
    const out = new Map();
    for (const key of [...this.map.keys()].sort()) {
      if (prefix === undefined || key.startsWith(prefix)) out.set(key, this.map.get(key));
    }
    return out;
  }
}

function makeCtx() {
  const storage = new FakeStorage();
  const sockets = new Map();
  const pending = [];
  const ctx = {
    storage,
    blockConcurrencyWhile: async (fn) => fn(),
    getWebSockets: (tag) => sockets.get(tag) ?? [],
    waitUntil: (p) => {
      pending.push(p);
      p.catch(() => undefined);
    },
  };
  return {
    ctx,
    storage,
    sockets,
    addSocket(tag) {
      const s = new FakeSocket();
      if (!sockets.has(tag)) sockets.set(tag, []);
      sockets.get(tag).push(s);
      return s;
    },
    async flush() {
      await Promise.allSettled(pending);
      pending.length = 0;
    },
  };
}

function makeEnv(extra = {}) {
  const registryCalls = [];
  return {
    registryCalls,
    env: {
      CODE_REGISTRY_DO: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (_url, init) => {
            registryCalls.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        }),
      },
      ...extra,
    },
  };
}

// UUIDs chosen so session-key order is under test control (keys sort by
// playerId). Join order is fixed by joinedAt: h1, then r1, r2, hu1.
const IDS = {
  h1: 'aaaaaaaa-1111-4111-8111-111111111111',
  r1: 'bbbbbbbb-2222-4222-8222-222222222222',
  r2: 'cccccccc-3333-4333-8333-333333333333',
  hu1: 'dddddddd-4444-4444-8444-444444444444',
};

function classPlayer(id, displayName, isHost, joinedAtMs, matchRole = null) {
  return {
    playerId: id,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole,
    team: null,
    reconnectTokenHash: `reconnect-hash-${id}`,
    joinedAt: new Date(joinedAtMs).toISOString(),
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

function stateFor(ids, phase = 'LOBBY') {
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
    selectedHunterIds: [ids.hu1],
    hunterCount: 1,
    balanceHunters: false,
    randomDraw: false,
  };
  const live = phase !== 'LOBBY';
  return {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: ids.h1,
      phase,
      version: 1,
      config,
      createdAt: new Date(T0 - 5000).toISOString(),
      startedAt: live ? new Date(T0).toISOString() : null,
      endsAt: live ? new Date(T0 + 3600_000).toISOString() : null,
      pausedAt: null,
      result: null,
    },
    players: [
      classPlayer(ids.h1, 'Host', true, T0 - 5000, live ? 'runner' : null),
      classPlayer(ids.r1, 'Runner 1', false, T0 - 4000, live ? 'runner' : null),
      classPlayer(ids.r2, 'Runner 2', false, T0 - 3000, live ? 'runner' : null),
      classPlayer(ids.hu1, 'Hunter 1', false, T0 - 2000, live ? 'hunter' : null),
    ],
    catches: [],
    hostTokens: { [ids.h1]: 'host-hash' },
    serverSeq: 0,
    deleted: false,
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
}

function sessionFor(playerId, tab, lastHeartbeatAtMs) {
  return {
    sessionId: tab,
    playerId,
    ticketId: `ticket-${playerId}`,
    ticketExpiresAtMs: T0 + 3_600_000,
    renewalWarned: false,
    lastHeartbeatAtMs,
    missedHeartbeats: 0,
    helloDone: true,
  };
}

async function seedRoom(fake, ids, phase = 'LOBBY', heartbeatAtMs = {}) {
  await fake.storage.put(STATE_KEY, stateFor(ids, phase));
  for (const id of Object.values(ids)) {
    await fake.storage.put(
      `session:${id}:tab-${id}`,
      sessionFor(id, `tab-${id}`, heartbeatAtMs[id] ?? T0 + 2000),
    );
  }
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

function sentEvents(socket) {
  return socket.sent.map((text) => JSON.parse(text));
}

// ---------------------------------------------------------------------------
// Gap 4 — the Supabase cancel record lands BEFORE the storage wipe
// ---------------------------------------------------------------------------

test('v23 (gap) host cancel persists the cancel record before wiping DO storage', async () => {
  const fake = makeCtx();
  const { env } = makeEnv({
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  });
  const ids = IDS;
  await seedRoom(fake, ids, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, env);
  for (const id of Object.values(ids)) fake.addSocket(id);

  // Order log shared by the fetch stub and the storage wipe: the
  // match-result PATCH must appear before the state-key delete.
  // (v23 fix round 1, S9: the wipe deletes the state key + session
  // keys explicitly — there is no `deleteAll()` anymore — so the
  // wipe signal here is the `STATE_KEY` delete.)
  const order = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let body = null;
    try {
      body = JSON.parse(init?.body ?? 'null');
    } catch {
      body = null;
    }
    order.push({ kind: 'fetch', url: String(url), method: init?.method, body });
    return { ok: true };
  };
  const realDelete = fake.storage.delete.bind(fake.storage);
  fake.storage.delete = async (key) => {
    order.push({ kind: 'delete', key });
    await realDelete(key);
  };
  try {
    const r = await op(doInstance, {
      op: 'lifecycle',
      action: 'end',
      playerId: ids.h1,
      hostTokenHash: 'host-hash',
    });
    assert.equal(r.status, 200, `lifecycle end must succeed: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    await fake.flush();
  } finally {
    globalThis.fetch = realFetch;
    fake.storage.delete = realDelete;
  }

  const patchIdx = order.findIndex(
    (e) =>
      e.kind === 'fetch' &&
      e.method === 'PATCH' &&
      e.url.includes('/rest/v1/rooms?room_id=eq.room-1') &&
      e.body?.phase === 'CANCELLED',
  );
  assert.notEqual(patchIdx, -1, `the cancel record PATCH must be issued: ${JSON.stringify(order)}`);
  const wipeIdx = order.findIndex((e) => e.kind === 'delete' && e.key === STATE_KEY);
  assert.notEqual(wipeIdx, -1, 'the storage wipe must run');
  assert.ok(
    patchIdx < wipeIdx,
    `the cancel record (idx ${patchIdx}) must land BEFORE the wipe (idx ${wipeIdx})`,
  );
  assert.equal(
    order[patchIdx].body.result?.outcome,
    'cancelled',
    'the persisted record carries the cancelled result',
  );
});

// ---------------------------------------------------------------------------
// Gap 5 — heartbeat-timeout succession via the real alarm() tick
// ---------------------------------------------------------------------------

test('v24 (gap) alarm heartbeat-timeout starts a grace; the expiry transfers host to the earliest-joined remaining player', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  // Host heartbeat is stale by more than the missed limit; everyone
  // else heartbeated just now. (Interval 30 s x limit 3 = 90 s stale.)
  const staleAt = T0 + 2000 - (HEARTBEAT_MISSED_LIMIT + 1) * HEARTBEAT_INTERVAL_MS;
  await seedRoom(fake, ids, 'ACTIVE', { [ids.h1]: staleAt });
  const doInstance = new RoomDO(fake.ctx, env);
  // Sockets for everyone EXCEPT the host: a live socket for the host
  // would earn it the first-tick-after-wake grace and spare it.
  const liveSockets = {};
  for (const id of [ids.r1, ids.r2, ids.hu1]) {
    liveSockets[id] = fake.addSocket(id);
  }

  const realNow = Date.now;
  Date.now = () => T0 + 2000;
  try {
    await doInstance.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();

  // v24: the first tick suspends the host and starts the grace — it
  // must NOT transfer yet.
  let events = sentEvents(liveSockets[ids.r1]);
  assert.equal(
    events.some((e) => e.type === 'host.transferred'),
    false,
    'the heartbeat-timeout tick must start the grace, not transfer',
  );
  const afterFirst = await fake.storage.get(STATE_KEY);
  assert.equal(
    afterFirst.hostGrace?.endsAtMs,
    T0 + 32000,
    'the persisted grace deadline is 30 s after the timeout tick',
  );
  assert.equal(
    afterFirst.players.find((p) => p.playerId === ids.h1).connectionState,
    'suspended',
    'the timed-out host is suspended, not removed',
  );

  // The expiry tick (at the deadline) transfers. NOTE: the room has
  // been silent for 32 s by then, so the same tick also ejects the
  // silent seats via the missing-fix rule (4a) AFTER the transfer —
  // that is the pre-existing (4a) behaviour, not this test's subject.
  Date.now = () => T0 + 32000;
  try {
    await doInstance.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();

  events = sentEvents(liveSockets[ids.r1]);
  const transfer = events.find((e) => e.type === 'host.transferred');
  assert.ok(transfer, `r1 must receive host.transferred: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(events.filter((e) => e.type === 'host.transferred').length, 1, 'exactly one transfer across both ticks');
  assert.equal(transfer.payload.newHostPlayerId, ids.r1, 'the earliest-joined remaining player becomes host');
  assert.equal(transfer.payload.previousHostPlayerId, ids.h1);
  const persisted = await fake.storage.get(STATE_KEY);
  assert.equal(persisted.room.hostPlayerId, ids.r1, 'the persisted snapshot carries the new host');
  assert.equal(
    persisted.players.find((p) => p.playerId === ids.h1).connectionState,
    'suspended',
    'the timed-out host is suspended, not removed',
  );
});

// ---------------------------------------------------------------------------
// v23 fix round 1 (Kabir) — S13
// ---------------------------------------------------------------------------

test('v23 fix (S13) WS player.suspended with a client-supplied network-lost / heartbeat-timeout never transfers host', async () => {
  const store = makeStore();
  for (const reason of ['network-lost', 'heartbeat-timeout']) {
    const r = await store.handleWsMessage(
      { playerId: 'h1', sessionId: 'tab-h1' },
      { type: 'player.suspended', payload: { reason } },
      T0 + 1000,
    );
    assert.equal(
      r.events.some((e) => e.type === 'host.transferred'),
      false,
      `a client-sent ${reason} must never emit host.transferred — only the server-side sweep/alarm assert "actually gone"`,
    );
    assert.equal(
      store.room.hostPlayerId,
      'h1',
      `the host keeps host after a client-sent ${reason} message`,
    );
    assert.equal(
      store.player('h1').connectionState,
      'suspended',
      'the seat is still marked suspended (the message was honoured, just without succession)',
    );
    // Reset for the next reason: the host resumes so the second
    // iteration starts from a connected host again.
    const back = store.resumeOnHello('h1', T0 + 2000);
    assert.equal(back.resumed, true);
  }
  // And the real server-side path still transfers — at grace expiry:
  // a socket close (suspendSeat with 'network-lost', as the class
  // sweep calls it) starts the grace, and the tick at the deadline
  // transfers.
  const dropped = store.suspendSeat('h1', 'network-lost', T0 + 3000);
  assert.equal(
    dropped.events.some((e) => e.type === 'host.transferred'),
    false,
    'v24: the server-side socket-close path must start the grace, not transfer immediately',
  );
  assert.equal(store.room.hostPlayerId, 'h1', 'the host keeps host during the grace');
  const tick = store.alarmTick(T0 + 33000);
  assert.equal(
    tick.events.some((e) => e.type === 'host.transferred'),
    true,
    'the grace expiry must transfer host',
  );
  assert.equal(store.room.hostPlayerId, 'p2');
});
