import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomDO } = await import('../src/room-do-class.ts');
const { STATE_KEY } = await import('../src/room-do.ts');
const sharedNs = await import('@pakdam/shared');
const { DEFAULT_ROOM_CONFIG } = sharedNs;

// v24 — host reconnect grace, DO-CLASS half (founder decision D1,
// 2026-11-21). The store half lives in v24-host-grace.test.mjs.
// These tests drive a REAL `RoomDO` through its `/op` fetch +
// `webSocketClose` + `alarm()` with a fake DurableObjectState / env —
// no network, no Supabase, no registry. They pin the two things only
// the class can prove:
//
//   1. DO EVICTION / WAKE DURING A GRACE: the grace lives in durable
//      DO state (`state.hostGrace`), so a fresh `RoomDO` instance on
//      the same storage (an eviction + wake) still sees the deadline.
//      - A wake alone never transfers: loading the room does not
//        move host, and a tick BEFORE the deadline transfers nothing.
//      - A tick AFTER the deadline (even the first tick after a wake
//        whose deadline passed while the DO was down) fires the
//        already-expired grace — no lost grace, no immediate transfer
//        on wake itself.
//   2. THE LOBBY ONE-SHOT ALARM: the lobby ticks every 30 s, so a
//      tick-only grace check could transfer up to ~60 s after
//      disconnect. While a grace runs in the lobby the class arms ONE
//      alarm at the grace deadline itself (`armAlarm`), so the tick
//      that expires the grace fires at ~30 s. Pinned here by reading
//      the fake storage's recorded alarms, and by firing `alarm()` at
//      the deadline.
//
// FAKE FIDELITY NOTES (mirroring v23-host-rules-do.test.mjs):
// - `storage.list()` returns keys in LEXICOGRAPHIC order, exactly like
//   real DO storage.
// - `waitUntil` only records promises; tests `await flush()` them.
// - No Supabase env: persist intents no-op (best-effort, swallowed).
// - No DO_OP_SECRET: the internal-op secret check is skipped (dev).
// - `globalThis.fetch` is the PostgREST transport; it answers OK.
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
  r2: 'cccccccc-3333-4333-8333-333333333333',
  hu1: 'dddddddd-4444-4444-8444-444444444444',
};

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

function makeEnv() {
  return {
    env: {
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SERVICE_ROLE_KEY: 'test-key',
      CODE_REGISTRY_DO: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async () => new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        }),
      },
    },
  };
}

function player(id, displayName, isHost, joinedAtMs) {
  return {
    playerId: id,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole: null,
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
      // v24: createdAt is REAL-now based, not T0-based — the wake
      // tests mock Date.now forward to the (real) grace deadline and
      // call alarm(), and a T0-based createdAt would make the lobby
      // look months old, so the 24 h lobby expiry would fire in the
      // same tick as the transfer. Join order still comes from the
      // T0-staggered joinedAt below.
      createdAt: new Date(Date.now() - 5000).toISOString(),
      startedAt: live ? new Date(T0).toISOString() : null,
      endsAt: live ? new Date(T0 + 3600_000).toISOString() : null,
      pausedAt: null,
      result: null,
    },
    players: [
      player(ids.h1, 'Host', true, T0 - 5000),
      player(ids.r1, 'Runner 1', false, T0 - 4000),
      player(ids.r2, 'Runner 2', false, T0 - 3000),
      player(ids.hu1, 'Hunter 1', false, T0 - 2000),
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

function sessionFor(playerId, tab) {
  return {
    sessionId: tab,
    playerId,
    ticketId: `ticket-${playerId}`,
    ticketExpiresAtMs: Date.now() + 60_000,
    renewalWarned: false,
    lastHeartbeatAtMs: Date.now(),
    missedHeartbeats: 0,
    helloDone: true,
  };
}

async function seedRoom(fake, ids, phase = 'LOBBY') {
  await fake.storage.put(STATE_KEY, stateFor(ids, phase));
  for (const id of Object.values(ids)) {
    await fake.storage.put(`session:${id}:tab-${id}`, sessionFor(id, `tab-${id}`));
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
// Eviction / wake during a grace
// ---------------------------------------------------------------------------

test('v24 (DO) eviction + wake BEFORE the deadline: the grace survives, no transfer on wake, no transfer before the deadline', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'LOBBY');
  const first = new RoomDO(fake.ctx, env);
  for (const id of [ids.r1, ids.r2, ids.hu1]) {
    fake.addSocket(`tab:tab-${id}`);
    fake.addSocket(id);
  }
  const witness = fake.addSocket(ids.r2);
  await first.webSocketClose({}, 1006, '', false);
  await fake.flush();
  const stored = await fake.storage.get(STATE_KEY);
  const endsAt = stored.hostGrace?.endsAtMs;
  assert.ok(typeof endsAt === 'number', 'the grace deadline must be persisted before the eviction');
  assert.ok(
    fake.storage.alarmsSet.includes(endsAt),
    `the one-shot must be armed at the deadline before the eviction: ${JSON.stringify(fake.storage.alarmsSet)}`,
  );

  // EVICTION: a fresh RoomDO instance on the same storage.
  const woken = new RoomDO(fake.ctx, env);
  // A wake alone never transfers: merely loading the room leaves the
  // host and the grace exactly as they were.
  const snap = await op(woken, {
    op: 'get-state',
    playerId: ids.r1,
    reconnectTokenHash: `reconnect-hash-${ids.r1}`,
  });
  assert.equal(snap.status, 200);
  assert.equal(snap.body.room.hostPlayerId, ids.h1, 'the wake itself must not transfer host');
  assert.equal(snap.body.hostGraceEndsAtMs, endsAt, 'the deadline survives the wake');
  // A tick BEFORE the deadline transfers nothing — the grace is still
  // waiting, not lost and not fired early.
  const realNow = Date.now;
  Date.now = () => endsAt - 5000;
  try {
    await woken.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  assert.equal(
    sentEvents(witness).filter((e) => e.type === 'host.transferred').length,
    0,
    'a tick before the deadline must not transfer, even after a wake',
  );
  const still = await fake.storage.get(STATE_KEY);
  assert.equal(still.hostGrace?.endsAtMs, endsAt, 'the grace is still recorded after the early tick');
  assert.equal(still.room.hostPlayerId, ids.h1);
  // …and the tick AT the deadline (after the wake) transfers.
  Date.now = () => endsAt;
  try {
    await woken.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  const transfers = sentEvents(witness).filter((e) => e.type === 'host.transferred');
  assert.equal(transfers.length, 1, 'the deadline tick after the wake must transfer exactly once');
  assert.equal(transfers[0].payload.newHostPlayerId, ids.r1);
  const after = await fake.storage.get(STATE_KEY);
  assert.equal(after.room.hostPlayerId, ids.r1);
  assert.equal(after.hostGrace, null, 'the grace is gone after the transfer');
});

test('v24 (DO) eviction + wake AFTER the deadline: no transfer on wake itself, the first tick fires the already-expired grace', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'LOBBY');
  const first = new RoomDO(fake.ctx, env);
  for (const id of [ids.r1, ids.r2, ids.hu1]) {
    fake.addSocket(`tab:tab-${id}`);
    fake.addSocket(id);
  }
  const witness = fake.addSocket(ids.r2);
  await first.webSocketClose({}, 1006, '', false);
  await fake.flush();
  const stored = await fake.storage.get(STATE_KEY);
  const endsAt = stored.hostGrace?.endsAtMs;
  assert.ok(typeof endsAt === 'number', 'the grace deadline must be persisted before the eviction');

  // EVICTION, and the deadline passes while the DO is down.
  const woken = new RoomDO(fake.ctx, env);
  const snap = await op(woken, {
    op: 'get-state',
    playerId: ids.r1,
    reconnectTokenHash: `reconnect-hash-${ids.r1}`,
  });
  assert.equal(snap.status, 200);
  assert.equal(snap.body.room.hostPlayerId, ids.h1, 'loading the woken room must not transfer host by itself');
  assert.equal(snap.body.hostGraceEndsAtMs, endsAt, 'the expired deadline is still recorded after the wake');
  assert.equal(
    sentEvents(witness).filter((e) => e.type === 'host.transferred').length,
    0,
    'nothing is delivered on wake itself',
  );
  // The first tick after the wake fires the already-expired grace.
  const realNow = Date.now;
  Date.now = () => endsAt + 5000;
  try {
    await woken.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  const transfers = sentEvents(witness).filter((e) => e.type === 'host.transferred');
  assert.equal(transfers.length, 1, 'the first tick after the wake must fire the expired grace exactly once');
  assert.equal(transfers[0].payload.previousHostPlayerId, ids.h1);
  assert.equal(transfers[0].payload.newHostPlayerId, ids.r1);
  const after = await fake.storage.get(STATE_KEY);
  assert.equal(after.room.hostPlayerId, ids.r1);
  assert.equal(after.hostGrace, null);
});

// ---------------------------------------------------------------------------
// The lobby one-shot alarm: re-armed after a wake, cancelled on return
// ---------------------------------------------------------------------------

test('v24 (DO) one-shot re-arms after a wake: a post-wake op still lands the transfer at the deadline', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'LOBBY');
  const first = new RoomDO(fake.ctx, env);
  for (const id of [ids.r1, ids.r2, ids.hu1]) {
    fake.addSocket(`tab:tab-${id}`);
    fake.addSocket(id);
  }
  const witness = fake.addSocket(ids.r2);
  await first.webSocketClose({}, 1006, '', false);
  await fake.flush();
  const endsAt = (await fake.storage.get(STATE_KEY)).hostGrace?.endsAtMs;
  assert.ok(typeof endsAt === 'number');

  // Wake, then run an op that re-arms the alarm (a hello would do the
  // same in production — here a get-state + an alarm before the
  // deadline proves the one-shot is re-armed at the SAME deadline,
  // not at now + 30 s, which would overshoot it).
  const woken = new RoomDO(fake.ctx, env);
  const realNow = Date.now;
  Date.now = () => endsAt - 10000;
  try {
    await woken.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  assert.ok(
    fake.storage.alarmsSet.includes(endsAt),
    `the post-wake tick must re-arm the one-shot at the same deadline ${endsAt}: ${JSON.stringify(fake.storage.alarmsSet)}`,
  );
  assert.equal(
    sentEvents(witness).filter((e) => e.type === 'host.transferred').length,
    0,
    'the early post-wake tick must not transfer',
  );
});

test('v24 (DO) host returns inside the grace: the one-shot is superseded and no transfer ever fires', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'LOBBY');
  const doInstance = new RoomDO(fake.ctx, env);
  for (const id of [ids.r1, ids.r2, ids.hu1]) {
    fake.addSocket(`tab:tab-${id}`);
    fake.addSocket(id);
  }
  const witness = fake.addSocket(ids.r2);
  await doInstance.webSocketClose({}, 1006, '', false);
  await fake.flush();
  const endsAt = (await fake.storage.get(STATE_KEY)).hostGrace?.endsAtMs;
  assert.ok(typeof endsAt === 'number', 'the grace must be recorded');
  assert.ok(fake.storage.alarmsSet.includes(endsAt), 'the one-shot must be armed at the deadline');
  // The host returns (hello resume) inside the window: the grace is
  // cancelled. (The store call mutates in-memory state only — the
  // class hello path does the save — so assert in-memory here; the
  // get-state below confirms the served snapshot too.) The stale
  // one-shot still fires once at the deadline — a harmless tick — and
  // the regular cadence is restored after it.
  const back = doInstance.store.resumeOnHello(ids.h1, Date.now());
  assert.equal(back.resumed, true);
  assert.equal(doInstance.store.state.hostGrace, null, 'the grace is cancelled on return');
  const realNow = Date.now;
  Date.now = () => endsAt;
  try {
    await doInstance.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  assert.equal(
    sentEvents(witness).filter((e) => e.type === 'host.transferred').length,
    0,
    'the stale one-shot must not transfer after the host returned',
  );
  const snap = await op(doInstance, {
    op: 'get-state',
    playerId: ids.r1,
    reconnectTokenHash: `reconnect-hash-${ids.r1}`,
  });
  assert.equal(snap.body.room.hostPlayerId, ids.h1, 'the returned host keeps host');
  assert.equal(snap.body.hostGraceEndsAtMs, null);
});

// ---------------------------------------------------------------------------
// F2 (v24 fix round) — READY_CHECK gets the same ~30 s promise as the
// lobby: the one-shot alarm is armed at the grace deadline, and the
// tick at the deadline transfers (not 30–60 s later via the 30 s
// tick cadence).
// ---------------------------------------------------------------------------

test('F2 (DO) host disconnects during READY_CHECK: the one-shot is armed at the deadline and the deadline tick transfers', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'READY_CHECK');
  const doInstance = new RoomDO(fake.ctx, env);
  for (const id of [ids.r1, ids.r2, ids.hu1]) {
    fake.addSocket(`tab:tab-${id}`);
    fake.addSocket(id);
  }
  const witness = fake.addSocket(ids.r2);
  await doInstance.webSocketClose({}, 1006, '', false);
  await fake.flush();
  const endsAt = (await fake.storage.get(STATE_KEY)).hostGrace?.endsAtMs;
  assert.ok(typeof endsAt === 'number', 'the grace deadline must be recorded');
  assert.ok(
    fake.storage.alarmsSet.includes(endsAt),
    `the one-shot must be armed at the deadline in READY_CHECK: ${JSON.stringify(fake.storage.alarmsSet)}`,
  );
  // The tick AT the deadline transfers — the one-shot fires on time,
  // not up to 30 s late on the next 30 s tick.
  const realNow = Date.now;
  Date.now = () => endsAt;
  try {
    await doInstance.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  const transfers = sentEvents(witness).filter((e) => e.type === 'host.transferred');
  assert.equal(transfers.length, 1, 'the deadline tick in READY_CHECK must transfer exactly once');
  assert.equal(transfers[0].payload.previousHostPlayerId, ids.h1);
  assert.equal(transfers[0].payload.newHostPlayerId, ids.r1);
  const after = await fake.storage.get(STATE_KEY);
  assert.equal(after.room.hostPlayerId, ids.r1);
  assert.equal(after.hostGrace, null, 'the grace is gone after the transfer');
});
