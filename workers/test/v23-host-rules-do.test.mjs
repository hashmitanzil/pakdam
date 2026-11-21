import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomDO } = await import('../src/room-do-class.ts');
const { STATE_KEY } = await import('../src/room-do.ts');
const sharedNs = await import('@pakdam/shared');
const { DEFAULT_ROOM_CONFIG, HEARTBEAT_INTERVAL_MS, HEARTBEAT_MISSED_LIMIT } = sharedNs;

// v23 fix round 1 (S7): the host-cancel delete aborts when the cancel
// persist fails — so these DO tests run with a Supabase that answers
// OK. `globalThis.fetch` is the PostgREST transport (the registry uses
// its own fake stub, never global fetch); individual tests swap it to
// a failing stub to cover the abort path, and restore it after.
globalThis.fetch = async () => ({ ok: true });

// v23 host/lobby rules — DO-CLASS half (founder decisions, 2026-11-21).
// The store half lives in v23-host-rules.test.mjs. These tests drive a
// REAL `RoomDO` through its `/op` fetch + `webSocketClose` with a fake
// DurableObjectState / env — no network, no Supabase, no registry.
//
// FAKE FIDELITY NOTES (read before "fixing" a failure here):
// - `storage.list()` returns keys in LEXICOGRAPHIC order, exactly like
//   real DO storage. Session keys are `session:<playerId>:<tab>`, so
//   the close sweep processes seats in PLAYER-ID order, NOT join
//   order. Tests 5/6 pin both orders on purpose.
// - `waitUntil` only records promises; tests `await flush()` them.
// - No Supabase env: persist intents no-op (best-effort, swallowed).
// - No DO_OP_SECRET: the internal-op secret check is skipped (dev).
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];

// UUIDs chosen so SESSION-KEY order is under test control (keys sort
// by playerId). Join order is fixed by joinedAt: h1, then r1, r2, hu1.
const IDS_HOST_FIRST = {
  h1: 'aaaaaaaa-1111-4111-8111-111111111111',
  r1: 'bbbbbbbb-2222-4222-8222-222222222222',
  r2: 'cccccccc-3333-4333-8333-333333333333',
  hu1: 'dddddddd-4444-4444-8444-444444444444',
};
const IDS_RUNNER_FIRST = {
  h1: 'bbbbbbbb-2222-4222-8222-222222222222',
  r1: 'aaaaaaaa-1111-4111-8111-111111111111',
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
    // Real DO list() is lexicographic by key.
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
  const registryCalls = [];
  return {
    registryCalls,
    env: {
      // S7: the cancel persist must be able to land, or the delete
      // aborts — so the fake env carries Supabase bindings and the
      // module-level fetch stub answers OK for PostgREST.
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SERVICE_ROLE_KEY: 'test-key',
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
    },
  };
}

function player(id, displayName, isHost, joinedAtMs, matchRole = null) {
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
      // v24: createdAt is REAL-now based, not T0-based — the v24
      // expiry tests mock Date.now forward to the (real) grace
      // deadline and call alarm(), and a T0-based createdAt would make
      // the lobby look months old, so the 24 h lobby expiry would fire
      // in the same tick as the transfer. Join order still comes from
      // the T0-staggered joinedAt below, which is untouched.
      createdAt: new Date(Date.now() - 5000).toISOString(),
      startedAt: live ? new Date(T0).toISOString() : null,
      endsAt: live ? new Date(T0 + 3600_000).toISOString() : null,
      pausedAt: null,
      result: null,
    },
    players: [
      player(ids.h1, 'Host', true, T0 - 5000, live ? 'runner' : null),
      player(ids.r1, 'Runner 1', false, T0 - 4000, live ? 'runner' : null),
      player(ids.r2, 'Runner 2', false, T0 - 3000, live ? 'runner' : null),
      player(ids.hu1, 'Hunter 1', false, T0 - 2000, live ? 'hunter' : null),
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
    // One distinct tab per seat: the sweep checks `tab:<sessionId>`,
    // so shared tab ids would make every seat look alive/dead together.
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
// R1 — host cancel deletes the room (class composition)
// ---------------------------------------------------------------------------

test('v23 (R1-DO) host lifecycle end deletes the room: deleted:true, notice delivered, storage wiped, later ops 404, code freed', async () => {
  const fake = makeCtx();
  const { env, registryCalls } = makeEnv();
  const ids = IDS_HOST_FIRST;
  await seedRoom(fake, ids, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, env);
  // Every seat has a live socket before the cancel.
  const liveSockets = {};
  for (const id of Object.values(ids)) {
    liveSockets[id] = fake.addSocket(id);
  }
  const r = await op(doInstance, {
    op: 'lifecycle',
    action: 'end',
    playerId: ids.h1,
    hostTokenHash: 'host-hash',
  });
  assert.equal(r.status, 200, `lifecycle end must succeed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.deleted, true, 'the response must report the deletion');
  await fake.flush();
  // Delivery order: match.cancelled (synthesised by the class) first,
  // the literal room.deleted signal second, the room.state notice last.
  const hostSent = sentEvents(liveSockets[ids.h1]);
  assert.equal(hostSent.length, 3, 'the delivered stream must be exactly 3 events');
  assert.equal(hostSent[0].type, 'match.cancelled', 'match.cancelled (with the result) goes first');
  assert.equal(hostSent[1].type, 'room.deleted', 'the literal room.deleted signal goes second');
  assert.deepEqual(
    hostSent[1].payload['result'],
    hostSent[0].payload['result'],
    'both carry the same cancel result',
  );
  const last = hostSent[2];
  assert.equal(last.type, 'room.state');
  assert.equal(last.payload.reason, 'room-deleted', 'the deletion notice is room.state reason room-deleted');
  // Every live socket is closed (1000, 'room deleted') — no reconnect.
  for (const id of Object.values(ids)) {
    assert.deepEqual(
      liveSockets[id].closed,
      [{ code: 1000, reason: 'room deleted' }],
      `socket for ${id} must be closed with 1000 'room deleted'`,
    );
  }
  // The invite code is freed (registry unregister).
  assert.ok(
    registryCalls.some((c) => c.op === 'unregister' && c.code === 'ABCDEF' && c.roomId === 'room-1'),
    `the code must be unregistered: ${JSON.stringify(registryCalls)}`,
  );
  // DO storage is wiped: no room state left.
  assert.equal(await fake.storage.get(STATE_KEY), undefined, 'the room state must be wiped');
  // Later ops answer ROOM_NOT_FOUND: snapshot fetch fails…
  const after = await op(doInstance, {
    op: 'get-state',
    playerId: ids.r1,
    reconnectTokenHash: `reconnect-hash-${ids.r1}`,
  });
  assert.equal(after.status, 404);
  assert.equal(after.body.code, 'ROOM_NOT_FOUND');
  // …and the room no longer exists.
  const exists = await op(doInstance, { op: 'room-exists' });
  assert.equal(exists.status, 200);
  assert.equal(exists.body.exists, false);
});

test('v23 (R1-DO) host cancel from the LOBBY deletes the lobby too', async () => {
  const fake = makeCtx();
  const { env, registryCalls } = makeEnv();
  const ids = IDS_HOST_FIRST;
  await seedRoom(fake, ids, 'LOBBY');
  const doInstance = new RoomDO(fake.ctx, env);
  const sock = fake.addSocket(ids.r1);
  const r = await op(doInstance, {
    op: 'lifecycle',
    action: 'end',
    playerId: ids.h1,
    hostTokenHash: 'host-hash',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, true);
  await fake.flush();
  const events = sentEvents(sock);
  assert.ok(events.some((e) => e.type === 'match.cancelled'), 'lobby cancel still emits match.cancelled');
  assert.ok(events.some((e) => e.type === 'room.deleted'), 'lobby cancel still emits the room.deleted signal');
  assert.ok(
    events.some((e) => e.type === 'room.state' && e.payload.reason === 'room-deleted'),
    'lobby cancel still emits the room-deleted notice',
  );
  assert.ok(
    registryCalls.some((c) => c.op === 'unregister' && c.code === 'ABCDEF'),
    'the lobby code must be freed too',
  );
  assert.equal(await fake.storage.get(STATE_KEY), undefined);
  const after = await op(doInstance, {
    op: 'get-state',
    playerId: ids.r1,
    reconnectTokenHash: `reconnect-hash-${ids.r1}`,
  });
  assert.equal(after.status, 404);
});

test('v23 (R1-DO) non-host lifecycle end is 403 and the room survives', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS_HOST_FIRST;
  await seedRoom(fake, ids, 'LOBBY');
  const doInstance = new RoomDO(fake.ctx, env);
  const r = await op(doInstance, {
    op: 'lifecycle',
    action: 'end',
    playerId: ids.r1,
    hostTokenHash: null,
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'FORBIDDEN');
  await fake.flush();
  // The room is untouched: snapshot still answers.
  const snap = await op(doInstance, {
    op: 'get-state',
    playerId: ids.r1,
    reconnectTokenHash: `reconnect-hash-${ids.r1}`,
  });
  assert.equal(snap.status, 200, 'the room must survive a non-host cancel');
  assert.equal(snap.body.room.phase, 'LOBBY');
  assert.equal(await fake.storage.get(STATE_KEY) !== undefined, true);
});

// ---------------------------------------------------------------------------
// R2 — automatic host succession on host disconnect (class sweep)
// ---------------------------------------------------------------------------

test('v24 (R2-DO) host socket close starts a grace (one-shot alarm armed at the deadline); the expiry transfers host to the earliest-joined remaining player', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS_HOST_FIRST;
  await seedRoom(fake, ids, 'LOBBY');
  const doInstance = new RoomDO(fake.ctx, env);
  // Only the host is dead: r1, r2, hu1 keep live sockets (tab + seat).
  for (const id of [ids.r1, ids.r2, ids.hu1]) {
    fake.addSocket(`tab:tab-${id}`);
    fake.addSocket(id);
  }
  const witness = fake.addSocket(ids.r2);
  await doInstance.webSocketClose({}, 1006, '', false);
  await fake.flush();
  // v24: the close starts the grace — no transfer yet.
  let transfers = sentEvents(witness).filter((e) => e.type === 'host.transferred');
  assert.equal(transfers.length, 0, 'the close must start the grace, not transfer');
  const stored = await fake.storage.get(STATE_KEY);
  const endsAt = stored.hostGrace?.endsAtMs;
  assert.ok(typeof endsAt === 'number', 'the persisted grace deadline must exist');
  assert.equal(stored.room.hostPlayerId, ids.h1, 'the host keeps host during the grace');
  // v24: the lobby one-shot — the class arms ONE alarm at the grace
  // deadline itself (not the regular 30 s tick), so the transfer lands
  // at ~30 s instead of up to ~60 s.
  assert.ok(
    fake.storage.alarmsSet.includes(endsAt),
    `a one-shot alarm must be armed at the grace deadline ${endsAt}: ${JSON.stringify(fake.storage.alarmsSet)}`,
  );
  // Fire the alarm AT the deadline: the expiry transfers.
  const realNow = Date.now;
  Date.now = () => endsAt;
  try {
    await doInstance.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  transfers = sentEvents(witness).filter((e) => e.type === 'host.transferred');
  assert.equal(transfers.length, 1, 'exactly one host.transferred must be delivered at expiry');
  assert.equal(transfers[0].payload.previousHostPlayerId, ids.h1);
  assert.equal(transfers[0].payload.newHostPlayerId, ids.r1);
  // The new host is visible in snapshots at once.
  const snap = await op(doInstance, {
    op: 'get-state',
    playerId: ids.r1,
    reconnectTokenHash: `reconnect-hash-${ids.r1}`,
  });
  assert.equal(snap.status, 200);
  assert.equal(snap.body.room.hostPlayerId, ids.r1);
  assert.equal(snap.body.hostGraceEndsAtMs, null, 'the snapshot carries no grace after the transfer');
  // And the successor can mint a host token (host controls immediately).
  const minted = await op(doInstance, {
    op: 'issue-host-token',
    playerId: ids.r1,
    reconnectTokenHash: `reconnect-hash-${ids.r1}`,
  });
  assert.equal(minted.status, 200, `the successor must mint a host token: ${JSON.stringify(minted.body)}`);
  assert.equal(typeof minted.body.hostToken, 'string');
});

test('v24 (R2-DO) two players disconnecting at once, host session first: no transfer at close time, exactly one succession at grace expiry', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS_HOST_FIRST; // h1's session key sorts before r1's.
  await seedRoom(fake, ids, 'LOBBY');
  const doInstance = new RoomDO(fake.ctx, env);
  // h1 + r1 dead; r2, hu1 alive.
  for (const id of [ids.r2, ids.hu1]) {
    fake.addSocket(`tab:tab-${id}`);
    fake.addSocket(id);
  }
  const witness = fake.addSocket(ids.r2);
  await doInstance.webSocketClose({}, 1006, '', false);
  await fake.flush();
  // v24: the sweep starts ONE grace for the host and transfers nothing.
  let transfers = sentEvents(witness).filter((e) => e.type === 'host.transferred');
  assert.equal(transfers.length, 0, 'the sweep must transfer nothing yet — the grace runs first');
  const stored = await fake.storage.get(STATE_KEY);
  const endsAt = stored.hostGrace?.endsAtMs;
  assert.ok(typeof endsAt === 'number', 'the persisted grace deadline must exist');
  const realNow = Date.now;
  Date.now = () => endsAt;
  try {
    await doInstance.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  transfers = sentEvents(witness).filter((e) => e.type === 'host.transferred');
  assert.equal(
    transfers.length,
    1,
    `one simultaneous disconnect must produce exactly one succession, at expiry, got ${transfers.length}`,
  );
  assert.equal(transfers[0].payload.previousHostPlayerId, ids.h1);
  assert.equal(transfers[0].payload.newHostPlayerId, ids.r2, 'the transfer must name the final host (the suspended earliest joiner is skipped)');
  const snap = await op(doInstance, {
    op: 'get-state',
    playerId: ids.r2,
    reconnectTokenHash: `reconnect-hash-${ids.r2}`,
  });
  assert.equal(snap.status, 200);
  assert.equal(
    snap.body.room.hostPlayerId,
    ids.r2,
    'the next-earliest remaining player must end up host',
  );
});

test('v24 (R2-DO) two players disconnecting at once, earliest-joiner session first: the successor must still be a live player', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS_RUNNER_FIRST; // r1's session key sorts BEFORE h1's.
  await seedRoom(fake, ids, 'LOBBY');
  const doInstance = new RoomDO(fake.ctx, env);
  // h1 + r1 dead; r2, hu1 alive.
  for (const id of [ids.r2, ids.hu1]) {
    fake.addSocket(`tab:tab-${id}`);
    fake.addSocket(id);
  }
  const witness = fake.addSocket(ids.r2);
  await doInstance.webSocketClose({}, 1006, '', false);
  await fake.flush();
  // v24: no transfer at close time — the grace runs first, whatever
  // order the sweep processed the sessions in.
  let transfers = sentEvents(witness).filter((e) => e.type === 'host.transferred');
  assert.equal(transfers.length, 0, 'the sweep must transfer nothing yet');
  const stored = await fake.storage.get(STATE_KEY);
  const endsAt = stored.hostGrace?.endsAtMs;
  assert.ok(typeof endsAt === 'number', 'the persisted grace deadline must exist');
  const realNow = Date.now;
  Date.now = () => endsAt;
  try {
    await doInstance.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  transfers = sentEvents(witness).filter((e) => e.type === 'host.transferred');
  assert.equal(
    transfers.length,
    1,
    `one simultaneous disconnect must produce exactly one succession, at expiry, got ${transfers.length}`,
  );
  assert.equal(transfers[0].payload.newHostPlayerId, ids.r2, 'the transfer must name a LIVE player as the final host');
  const snap = await op(doInstance, {
    op: 'get-state',
    playerId: ids.r2,
    reconnectTokenHash: `reconnect-hash-${ids.r2}`,
  });
  assert.equal(snap.status, 200);
  assert.equal(
    snap.body.room.hostPlayerId,
    ids.r2,
    'the successor must be a LIVE player — never the also-disconnected earliest joiner',
  );
});

// ---------------------------------------------------------------------------
// v23 fix round 1 (Kabir) — S1 / S2 / S3 / S4 / S7 / S10
// ---------------------------------------------------------------------------

test('v23 fix (S1-DO) replay re-registers the invite code so the resurrected lobby is joinable', async () => {
  const fake = makeCtx();
  const { env, registryCalls } = makeEnv();
  const ids = IDS_HOST_FIRST;
  await seedRoom(fake, ids, 'COMPLETED');
  const doInstance = new RoomDO(fake.ctx, env);
  const r = await op(doInstance, {
    op: 'replay',
    playerId: ids.h1,
    hostTokenHash: 'host-hash',
  });
  assert.equal(r.status, 200, `replay must succeed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.phase, 'LOBBY');
  assert.ok(
    registryCalls.some((c) => c.op === 'register' && c.code === 'ABCDEF' && c.roomId === 'room-1'),
    `the invite code must be re-registered on replay: ${JSON.stringify(registryCalls)}`,
  );
  // The lobby is live again: it exists and serves snapshots.
  const exists = await op(doInstance, { op: 'room-exists' });
  assert.equal(exists.body.exists, true);
  const state = await op(doInstance, {
    op: 'get-state',
    playerId: ids.r1,
    reconnectTokenHash: `reconnect-hash-${ids.r1}`,
  });
  assert.equal(state.status, 200);
  assert.equal(state.body.room.phase, 'LOBBY');
});

test('v24 fix (S2-DO) alarm: two simultaneous heartbeat timeouts start ONE grace; the expiry delivers exactly one transfer naming the final host', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS_HOST_FIRST;
  await seedRoom(fake, ids, 'LOBBY');
  // Host + earliest joiner both time out in the same tick; the other
  // two heartbeated just now. (Interval 30 s x limit 3 = 90 s stale.)
  // Date.now is mocked to T0 + 2000 for the tick itself — the real
  // clock is months past T0, so an unmocked tick would expire the
  // 24 h lobby before the session loop ever ran.
  const nowMs = T0 + 2000;
  const staleAt = nowMs - (HEARTBEAT_MISSED_LIMIT + 1) * HEARTBEAT_INTERVAL_MS;
  for (const id of [ids.h1, ids.r1]) {
    await fake.storage.put(`session:${id}:tab-${id}`, {
      ...sessionFor(id, `tab-${id}`),
      lastHeartbeatAtMs: staleAt,
    });
  }
  const doInstance = new RoomDO(fake.ctx, env);
  // Sockets for the live seats only: a live socket for a dead seat
  // would earn it the first-tick-after-wake grace and spare it.
  const liveSockets = {};
  for (const id of [ids.r2, ids.hu1]) {
    liveSockets[id] = fake.addSocket(id);
  }
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    await doInstance.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  // v24: the timeout tick suspends both seats and starts ONE grace
  // for the host — it must NOT transfer yet, and it must arm the
  // lobby one-shot at the grace deadline.
  let events = sentEvents(liveSockets[ids.r2]);
  assert.equal(
    events.filter((e) => e.type === 'host.transferred').length,
    0,
    'the timeout tick must start the grace, not transfer',
  );
  assert.equal(
    events.filter((e) => e.type === 'player.suspended').length,
    2,
    'both seats still suspend',
  );
  assert.ok(
    fake.storage.alarmsSet.includes(nowMs + 30_000),
    `the timeout tick must arm a one-shot alarm at the grace deadline: ${JSON.stringify(fake.storage.alarmsSet)}`,
  );
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.hostGrace?.endsAtMs, nowMs + 30_000, 'the persisted grace deadline is 30 s after the timeout tick');
  // The expiry tick (at the deadline) transfers — exactly once,
  // naming the FINAL host (the suspended earliest joiner is skipped).
  // The transfer is fresh (no batchId), so it can never amend a
  // delivered event; there is no delivered transfer to amend here.
  Date.now = () => nowMs + 30_000;
  try {
    await doInstance.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  events = sentEvents(liveSockets[ids.r2]);
  const moved = events.filter((e) => e.type === 'host.transferred');
  assert.equal(
    moved.length,
    1,
    `one simultaneous disconnect must deliver exactly one transfer, at expiry: ${JSON.stringify(events.map((e) => e.type))}`,
  );
  assert.equal(moved[0].payload.previousHostPlayerId, ids.h1, 'the single transfer still names the original host');
  assert.equal(
    moved[0].payload.newHostPlayerId,
    ids.r2,
    'the single transfer must name the FINAL host',
  );
  assert.equal(
    events.filter((e) => e.type === 'player.suspended').length,
    2,
    'both seats still suspend',
  );
  const persisted = await fake.storage.get(STATE_KEY);
  assert.equal(persisted.room.hostPlayerId, ids.r2, 'the persisted snapshot carries the final host');
});

test('v23 fix (S7/S3-DO) a failed cancel persist aborts the wipe; the next wake finishes it once the record lands', async () => {
  const fake = makeCtx();
  const { env, registryCalls } = makeEnv();
  const ids = IDS_HOST_FIRST;
  await seedRoom(fake, ids, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, env);
  const liveSockets = {};
  for (const id of Object.values(ids)) {
    liveSockets[id] = fake.addSocket(id);
  }
  // Supabase is down: every PostgREST call fails.
  const okFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  let r;
  try {
    r = await op(doInstance, {
      op: 'lifecycle',
      action: 'end',
      playerId: ids.h1,
      hostTokenHash: 'host-hash',
    });
  } finally {
    globalThis.fetch = okFetch;
  }
  assert.equal(r.status, 200, `lifecycle end must still answer: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.deleted, false, 'the response must report that the delete did NOT complete');
  await fake.flush();
  // The deletion stream was still delivered, but the wipe aborted:
  // the room survives in DO storage as CANCELLED + deleted, the code
  // stays registered, and no socket was closed.
  const stored = await fake.storage.get(STATE_KEY);
  assert.notEqual(stored, undefined, 'the room must survive in storage when the record did not land');
  assert.equal(stored.room.phase, 'CANCELLED');
  assert.equal(stored.deleted, true);
  assert.equal(
    registryCalls.some((c) => c.op === 'unregister' && c.code === 'ABCDEF'),
    false,
    'the code must NOT be freed while the wipe is aborted',
  );
  for (const id of Object.values(ids)) {
    assert.deepEqual(liveSockets[id].closed, [], `socket for ${id} must stay open on an aborted wipe`);
  }
  // S10: a deleted room does not exist and has no members, even while
  // it is still sitting in storage.
  const exists = await op(doInstance, { op: 'room-exists' });
  assert.equal(exists.body.exists, false);
  const member = await op(doInstance, { op: 'check-member', playerId: ids.r1 });
  assert.equal(member.body.member, false);
  // S4: no ticket minting and no socket upgrade on the deleted room.
  const ticket = await op(doInstance, {
    op: 'register-ticket',
    playerId: ids.r1,
    reconnectTokenHash: `reconnect-hash-${ids.r1}`,
    ticketId: 'ticket-1',
    ticketHash: 'hash-1',
    purpose: 'connect',
    expiresAtMs: Date.now() + 60_000,
  });
  assert.equal(ticket.status, 404);
  assert.equal(ticket.body.code, 'ROOM_NOT_FOUND');
  const upgrade = await doInstance.fetch(
    new Request('http://do.test/ws', {
      headers: { Upgrade: 'websocket', 'x-pakdam-ticket-hash': 'hash-1' },
    }),
  );
  assert.equal(upgrade.status, 404);
  assert.equal((await upgrade.json()).code, 'ROOM_NOT_FOUND');
  // The next wake (a fresh instance on the same storage) retries the
  // persist — Supabase is back — and finishes the wipe instead of
  // serving the deleted room.
  const woken = new RoomDO(fake.ctx, env);
  const after = await op(woken, {
    op: 'get-state',
    playerId: ids.r1,
    reconnectTokenHash: `reconnect-hash-${ids.r1}`,
  });
  assert.equal(after.status, 404);
  assert.equal(after.body.code, 'ROOM_NOT_FOUND');
  assert.equal(await fake.storage.get(STATE_KEY), undefined, 'the wake must finish the wipe');
  assert.equal(fake.storage.map.size, 0, 'no session keys may survive the wipe either');
  assert.ok(
    registryCalls.some((c) => c.op === 'unregister' && c.code === 'ABCDEF' && c.roomId === 'room-1'),
    'the wake must free the code',
  );
});
