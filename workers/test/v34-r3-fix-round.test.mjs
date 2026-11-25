import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory, STATE_KEY } = await import('../src/room-do.ts');
const { RoomDO } = await import('../src/room-do-class.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

globalThis.fetch = async () => ({ ok: true });

// v34 fix round (Diya round 3): R3-N2 (eject-then-leave double banner)
// + R3-N3 (identity-mismatch requestId echo). R3-N1 (pre-auth bucket
// exhaustion) is pinned at its route sites: start in
// v34-zara-round1.test.mjs (Zara 10b re-pin), replay in
// v18-fix-round.test.mjs (F5 re-pin), lifecycle end in
// v23-fix-round-1-gaps-http.test.mjs (T6 re-pin).
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

// ---------------------------------------------------------------------------
// Store-level harness (mirrors v33-ejected-seat.test.mjs)
// ---------------------------------------------------------------------------

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
    players: [storePlayer('h1', 'Host', true), storePlayer('hu1', 'Hunter 1'), storePlayer('r1', 'Runner 1'), storePlayer('r2', 'Runner 2')],
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
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  assert.equal(store.room.phase, 'ACTIVE');
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

/** Eject r1 via (4a) (never reports) while the match stays live. */
async function ejectR1ByMissingFix(store) {
  await sendFix(store, 'h1', T0 + 5000);
  await sendFix(store, 'hu1', T0 + 5000);
  await sendFix(store, 'r2', T0 + 5000);
  const tick = store.alarmTick(T0 + 32000);
  assert.notEqual(store.player('r1').ejectedAt, null, 'r1 must be ejected by (4a)');
  assert.equal(store.room.phase, 'ACTIVE', 'the match must stay live (h1 + r2 still free)');
  return tick;
}

// ---------------------------------------------------------------------------
// R3-N2 — leaveSeat refuses an ejected seat
// ---------------------------------------------------------------------------

test('v34 R3-N2: eject then leave leaves the seat ejected — no leftAt, no events, snapshot still carries the ejection', async () => {
  const store = makeStore();
  start(store);
  await ejectR1ByMissingFix(store);
  assert.equal(store.player('r1').leftAt, null, 'the ejected seat must not already be left');
  // The second-tab leave: must be a no-op, not a removal.
  const r = store.leaveSeat('r1', null, T0 + 33000);
  assert.deepEqual(r, { events: [], persist: [] }, 'leave on an ejected seat must change nothing');
  const after = store.player('r1');
  assert.notEqual(after.ejectedAt, null, 'ejectedAt must survive the leave');
  assert.equal(after.leftAt, null, 'leave must not stamp leftAt over an ejection');
  // The snapshot is what the play / catch pages render: it must still
  // carry the ejection (and no removal), so only the ejected banner
  // can render — never the ejected + removed pair.
  const snap = store.snapshotFor('r1', T0 + 33000);
  const view = snap.players.find((p) => p.playerId === 'r1');
  assert.ok(view, 'the snapshot must still list the ejected seat');
  assert.notEqual(view.ejectedAt, null, 'the snapshot must still carry ejectedAt');
  assert.equal(view.leftAt, null, 'the snapshot must not carry a leftAt for the ejected seat');
  // Control: a live seat still leaves, with events + persist.
  const live = store.leaveSeat('r2', null, T0 + 33000);
  assert.notEqual(live.events.length, 0, 'a live seat must still leave');
  assert.notEqual(live.persist.length, 0, 'a live leave must still persist');
  assert.notEqual(store.player('r2').leftAt, null, 'the live seat must be stamped left');
});

// ---------------------------------------------------------------------------
// Class-level harness (mirrors v33-ejected-seat.test.mjs)
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
  const wsTags = new Map();
  const pending = [];
  const ctx = {
    storage,
    blockConcurrencyWhile: async (fn) => fn(),
    getWebSockets: (tag) => sockets.get(tag) ?? [],
    getTags: (ws) => wsTags.get(ws) ?? [],
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
    tagSocket(ws, tags) {
      wsTags.set(ws, tags);
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

function doPlayer(id, displayName, isHost, joinedAtMs, matchRole = null) {
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

function stateFor() {
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
    selectedHunterIds: ['hu1'],
    hunterCount: 1,
    balanceHunters: false,
    randomDraw: false,
  };
  return {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase: 'ACTIVE',
      version: 1,
      config,
      createdAt: new Date(T0 - 5000).toISOString(),
      startedAt: new Date(T0).toISOString(),
      endsAt: new Date(T0 + 3600_000).toISOString(),
      pausedAt: null,
      result: null,
    },
    players: [
      doPlayer('h1', 'Host', true, T0 - 5000, 'runner'),
      doPlayer('r1', 'Runner 1', false, T0 - 4000, 'runner'),
      doPlayer('hu1', 'Hunter 1', false, T0 - 2000, 'hunter'),
    ],
    catches: [],
    hostTokens: { h1: 'host-hash' },
    hostGrace: null,
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

// ---------------------------------------------------------------------------
// R3-N3 — identity-mismatch error echoes the request commandId
// ---------------------------------------------------------------------------

test('v34 R3-N3: a socket-identity mismatch error echoes the request commandId as requestId', async () => {
  // Diya round 3 refuted the "untestable through the harness"
  // rationale: the DO harness already instantiates RoomDO with a fake
  // ctx + getTags and drives webSocketMessage directly. Tag the
  // socket ['h1', 'tab:s1'] (h1's socket), send a message claiming
  // playerId 'r1' with commandId 'mm-1': the error envelope must
  // carry payload.requestId === 'mm-1' and the socket must close
  // 4403. The mismatch check runs before any session lookup, so no
  // session fixture is needed.
  const fake = makeCtx();
  const { env } = makeEnv();
  await fake.storage.put(STATE_KEY, stateFor());
  const ws = fake.addSocket('h1');
  fake.addSocket('tab:tab-h1');
  fake.tagSocket(ws, ['h1', 'tab:tab-h1']);
  const doInstance = new RoomDO(fake.ctx, env);
  await doInstance.webSocketMessage(
    ws,
    JSON.stringify({ playerId: 'r1', type: 'ready.set', commandId: 'mm-1', payload: {} }),
  );
  await fake.flush();
  const sent = ws.sent.map((t) => JSON.parse(t));
  assert.equal(sent.length, 1, `a mismatch must send exactly one error envelope, got ${JSON.stringify(sent)}`);
  assert.equal(sent[0].type, 'error', 'the envelope must be an error');
  assert.equal(sent[0].payload['code'], 'FORBIDDEN');
  assert.equal(
    sent[0].payload['requestId'],
    'mm-1',
    'the mismatch error must echo the request commandId as requestId',
  );
  assert.deepEqual(
    ws.closed,
    [{ code: 4403, reason: 'Socket identity does not match the message playerId.' }],
    'the mismatched socket must close 4403',
  );
});

test('v34 R3-N3 (control): a matching identity with a commandId gets no mismatch error and no 4403 close', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  await fake.storage.put(STATE_KEY, stateFor());
  await fake.storage.put('session:h1:tab-h1', sessionFor('h1', 'tab-h1'));
  const ws = fake.addSocket('h1');
  fake.addSocket('tab:tab-h1');
  fake.tagSocket(ws, ['h1', 'tab:tab-h1']);
  const doInstance = new RoomDO(fake.ctx, env);
  await doInstance.webSocketMessage(
    ws,
    JSON.stringify({ playerId: 'h1', type: 'hello', commandId: 'ok-1', payload: { v: 1 } }),
  );
  await fake.flush();
  const sent = ws.sent.map((t) => JSON.parse(t));
  assert.equal(
    sent.some((e) => e.type === 'error' && e.payload?.['requestId'] === 'ok-1'),
    false,
    'a matching identity must not answer with a mismatch error',
  );
  assert.equal(
    ws.closed.some((c) => c.code === 4403),
    false,
    'a matching identity must not close 4403',
  );
  assert.ok(
    sent.some((e) => e.type === 'welcome'),
    'a matching hello must still be welcomed',
  );
});
