import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { RoomDO } = await import('../src/room-do-class.ts');
const { STATE_KEY } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

globalThis.fetch = async () => ({ ok: true });

// v33 — ejected seats are OUT (Zara F2a/F2b/F2c/F3b, Diya-confirmed):
// no live-state reads, no fresh sockets, no mid-match restore, and the
// socket closes 4405 (ejected — never 4403) AFTER a snapshot carrying
// `ejectedAt` is delivered. `get-results` stays open (playerIds only),
// `replayMatch` still clears the ejection, and an ejected host can
// still replay the finished room (verifyHost gate is live-phase only).
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };
const OUTSIDE = { lat: 23.5, lng: 85.33 };
const FAR = { lat: 23.356, lng: 85.33 };

function player(playerId, displayName, isHost = false) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole: null,
    team: null,
    reconnectTokenHash: `reconnect-hash-${playerId}`,
    joinedAt: new Date(T0 - 1000).toISOString(),
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

function makeStore({ hunters = ['hu1'], runners = ['r1', 'r2'], headStartSeconds = 0, durationSeconds = 3600, gpsAntiCheat } = {}) {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds,
    pingIntervalSeconds: 0,
    durationSeconds,
    zoneShrinkEnabled: false,
    zoneShrinkIntervalSeconds: 60,
    playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected',
    selectedHunterIds: [...hunters],
    hunterCount: hunters.length,
    balanceHunters: false,
    randomDraw: false,
    ...(gpsAntiCheat ? { gpsAntiCheat } : {}),
  };
  const players = [
    player('h1', 'Host', true),
    ...hunters.map((id, i) => player(id, `Hunter ${i + 1}`)),
    ...runners.map((id, i) => player(id, `Runner ${i + 1}`)),
  ];
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
    players,
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

function start(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `startMatch must succeed: ${r.ok ? '' : r.error}`);
  // HEAD_START (0 s) -> ACTIVE.
  store.alarmTick(T0 + 1000);
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

function disconnectFor(tickOrResult, playerId) {
  return (tickOrResult.disconnect ?? []).filter((d) => d.playerId === playerId);
}

function snapshotFor(tickOrResult, playerId) {
  return (tickOrResult.events ?? []).find(
    (e) => e.type === 'snapshot' && e.recipients.includes(playerId),
  );
}

// ---------------------------------------------------------------------------
// F2b — ejection closes the socket (4405), after a snapshot.
// ---------------------------------------------------------------------------

test('v33 F2b (4a): a missing-fix ejection carries a 4405 disconnect + a snapshot naming the ejected seat', async () => {
  const store = makeStore();
  start(store);
  const tick = await ejectR1ByMissingFix(store);
  assert.deepEqual(disconnectFor(tick, 'r1'), [
    { playerId: 'r1', code: 4405, reason: 'You were ejected from the game.' },
  ]);
  assert.equal(disconnectFor(tick, 'h1').length, 0, 'no other seat disconnects');
  assert.equal(disconnectFor(tick, 'hu1').length, 0, 'no other seat disconnects');
  const snap = snapshotFor(tick, 'r1');
  assert.ok(snap, 'the ejected seat must get a snapshot before the close');
  const ejectedView = snap.payload['players'].find((p) => p.playerId === 'r1');
  assert.notEqual(ejectedView.ejectedAt, null, 'the snapshot must carry ejectedAt');
  assert.ok(
    tick.events.some((e) => e.type === 'room.state' && e.payload['reason'] === 'player-ejected'),
    'the player-ejected room.state event is still emitted',
  );
});

test('v33 F2b (4b): a return-window ejection carries a 4405 disconnect', async () => {
  const store = makeStore();
  start(store);
  await sendFix(store, 'h1', T0 + 34000);
  await sendFix(store, 'hu1', T0 + 34000);
  await sendFix(store, 'r2', T0 + 34000);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  const tick = store.alarmTick(T0 + 36000);
  assert.notEqual(store.player('r1').ejectedAt, null, 'r1 must be ejected by (4b)');
  assert.deepEqual(disconnectFor(tick, 'r1'), [
    { playerId: 'r1', code: 4405, reason: 'You were ejected from the game.' },
  ]);
  assert.ok(snapshotFor(tick, 'r1'), 'the ejected seat must get a snapshot before the close');
});

test('v33 F2b (4): a tick-side outside-zone ejection carries a 4405 disconnect + snapshot', async () => {
  const store = makeStore();
  start(store);
  await sendFix(store, 'r1', T0 + 2000, OUTSIDE);
  await sendFix(store, 'r1', T0 + 21000, OUTSIDE);
  await sendFix(store, 'h1', T0 + 30000);
  await sendFix(store, 'hu1', T0 + 30000);
  await sendFix(store, 'r2', T0 + 30000);
  const tick = store.alarmTick(T0 + 32000);
  assert.notEqual(store.player('r1').ejectedAt, null, 'r1 must be ejected by (4)');
  assert.deepEqual(disconnectFor(tick, 'r1'), [
    { playerId: 'r1', code: 4405, reason: 'You were ejected from the game.' },
  ]);
  assert.ok(snapshotFor(tick, 'r1'), 'the ejected seat must get a snapshot before the close');
});

test('v33 F2b (WS): an outside-zone ejection inside location.update returns a 4405 disconnect + snapshot', async () => {
  const store = makeStore();
  start(store);
  await sendFix(store, 'r1', T0 + 2000, OUTSIDE);
  const r = await sendFix(store, 'r1', T0 + 32000, OUTSIDE);
  assert.notEqual(store.player('r1').ejectedAt, null, 'r1 must be ejected by the fix');
  assert.deepEqual(disconnectFor(r, 'r1'), [
    { playerId: 'r1', code: 4405, reason: 'You were ejected from the game.' },
  ]);
  assert.ok(snapshotFor(r, 'r1'), 'the ejected seat must get a snapshot before the close');
});

test('v33 F2b (GPS): a GPS-violation ejection (action: eject) returns a 4405 disconnect', async () => {
  const store = makeStore({ gpsAntiCheat: { action: 'eject' } });
  start(store);
  await sendFix(store, 'r1', T0 + 2000, INSIDE);
  await sendFix(store, 'r1', T0 + 4000, FAR);
  await sendFix(store, 'r1', T0 + 6000, INSIDE);
  const r = await sendFix(store, 'r1', T0 + 8000, FAR);
  assert.notEqual(store.player('r1').ejectedAt, null, 'r1 must be ejected on the 3rd violation');
  assert.deepEqual(disconnectFor(r, 'r1'), [
    { playerId: 'r1', code: 4405, reason: 'You were ejected from the game.' },
  ]);
  assert.ok(snapshotFor(r, 'r1'), 'the ejected seat must get a snapshot before the close');
});

// ---------------------------------------------------------------------------
// F2a — ejected seats read no live state; get-results stays open.
// ---------------------------------------------------------------------------

test('v33 F2a: getStateOp refuses an ejected seat while live (403 SEAT_REMOVED) and allows it once the match is over', async () => {
  const store = makeStore();
  start(store);
  await ejectR1ByMissingFix(store);
  const refused = store.getStateOp({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 33000,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'SEAT_REMOVED');
  assert.equal(refused.status, 403);
  const hostOk = store.getStateOp({
    playerId: 'h1',
    reconnectTokenHash: 'reconnect-hash-h1',
    nowMs: T0 + 33000,
  });
  assert.equal(hostOk.ok, true, 'a live seat still reads state');
  // Finish the match: nobody reports again, the next tick ejects the
  // remaining runners and completes it.
  store.alarmTick(T0 + 62000);
  assert.equal(store.room.phase, 'COMPLETED');
  const terminalOk = store.getStateOp({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 63000,
  });
  assert.equal(terminalOk.ok, true, 'in a terminal phase the snapshot is history, not live state');
});

test('v33 F2a: get-results stays open for an ejected seat and carries playerIds only, never names', async () => {
  const store = makeStore({ durationSeconds: 65 });
  start(store);
  await ejectR1ByMissingFix(store);
  store.alarmTick(T0 + 66000);
  assert.equal(store.room.phase, 'COMPLETED');
  const results = store.resultsFor({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 67000,
  });
  assert.equal(results.ok, true, 'an ejected seat can still read its result');
  assert.deepEqual(Object.keys(results.value.scores).sort(), ['h1', 'hu1', 'r1', 'r2']);
  assert.equal(
    JSON.stringify(results.value).includes('Runner 1'),
    false,
    'the results payload must not widen to names',
  );
  assert.equal(
    JSON.stringify(results.value).includes('Host'),
    false,
    'the results payload must not widen to names',
  );
});

// ---------------------------------------------------------------------------
// F2c — ejected seats mint/renew no sockets.
// ---------------------------------------------------------------------------

test('v33 F2c: registerTicket, redeemTicketForConnect, redeemTicketForRenew and mintRenewalTicket refuse an ejected seat', async () => {
  const store = makeStore();
  start(store);
  const registered = store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    ticketId: 'ticket-r1-connect',
    ticketHash: 'hash-r1-connect',
    purpose: 'connect',
    expiresAtMs: T0 + 92000,
    nowMs: T0 + 2000,
  });
  assert.equal(registered.ok, true, 'a live seat registers a ticket');
  store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    ticketId: 'ticket-r1-renew',
    ticketHash: 'hash-r1-renew',
    purpose: 'renew',
    expiresAtMs: T0 + 92000,
    nowMs: T0 + 2000,
  });
  await ejectR1ByMissingFix(store);
  const register = store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    ticketId: 'ticket-r1-again',
    ticketHash: 'hash-r1-again',
    purpose: 'connect',
    expiresAtMs: T0 + 92000,
    nowMs: T0 + 33000,
  });
  assert.equal(register.ok, false);
  assert.equal(register.code, 'FORBIDDEN');
  assert.equal(register.status, 403);
  const connect = store.redeemTicketForConnect('hash-r1-connect', T0 + 33000);
  assert.equal(connect.ok, false);
  assert.equal(connect.status, 4403);
  const renew = store.redeemTicketForRenew('hash-r1-renew', 'r1', T0 + 33000);
  assert.equal(renew.ok, false);
  assert.equal(renew.status, 4403);
  const minted = await store.mintRenewalTicket('r1', T0 + 33000);
  assert.equal(minted.ok, false);
  assert.equal(minted.status, 403);
  // Controls: a live seat still mints/renews.
  const hostMinted = await store.mintRenewalTicket('h1', T0 + 33000);
  assert.equal(hostMinted.ok, true, 'a live seat still mints a renewal ticket');
});

// ---------------------------------------------------------------------------
// F3b/F3c — restore refuses ejected (live) and left (mid-match) seats.
// ---------------------------------------------------------------------------

test('v33 F3b/F3c: restore 403s an ejected seat mid-match, 409s a left seat mid-match, and restores a left seat in the lobby', async () => {
  const store = makeStore();
  start(store);
  await ejectR1ByMissingFix(store);
  const ejected = await store.addPlayerAsync({
    displayName: 'Runner 1',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 33000,
  });
  assert.equal(ejected.ok, false);
  assert.equal(ejected.code, 'FORBIDDEN');
  assert.equal(ejected.status, 403);
  store.leaveSeat('r2', null, T0 + 33000);
  const leftMidMatch = await store.addPlayerAsync({
    displayName: 'Runner 2',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-r2',
    nowMs: T0 + 34000,
  });
  assert.equal(leftMidMatch.ok, false);
  assert.equal(leftMidMatch.code, 'CONFLICT');
  assert.equal(leftMidMatch.status, 409);
  // Lobby: a left seat restores normally.
  const lobby = makeStore();
  lobby.leaveSeat('r1', null, T0 + 1000);
  const restored = await lobby.addPlayerAsync({
    displayName: 'Runner 1',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 2000,
  });
  assert.equal(restored.ok, true, 'a left seat restores in the lobby');
  assert.equal(restored.value.restored, true);
  assert.equal(lobby.player('r1').leftAt, null);
});

// ---------------------------------------------------------------------------
// verifyHost gate (Diya) + replayMatch clearing (task 4, pinned).
// ---------------------------------------------------------------------------

test('v33 verifyHost: an ejected host cannot end the match mid-match, but can still replay it once finished', async () => {
  const store = makeStore();
  start(store);
  // Eject only the host: everyone else reports.
  await sendFix(store, 'hu1', T0 + 5000);
  await sendFix(store, 'r1', T0 + 5000);
  await sendFix(store, 'r2', T0 + 5000);
  store.alarmTick(T0 + 32000);
  assert.notEqual(store.player('h1').ejectedAt, null, 'the host must be ejected');
  assert.equal(store.room.phase, 'ACTIVE');
  const end = store.lifecycleOp({
    action: 'end',
    playerId: 'h1',
    hostTokenHash: 'host-hash',
    nowMs: T0 + 33000,
  });
  assert.equal(end.ok, false);
  assert.equal(end.code, 'FORBIDDEN');
  assert.equal(end.status, 403);
  // Finish the match, then the same host token replays it: the gate
  // is live-phase only, so the room is never stranded unreplayable.
  store.alarmTick(T0 + 62000);
  assert.equal(store.room.phase, 'COMPLETED');
  const replayed = store.replayMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 63000 });
  assert.equal(replayed.ok, true, 'an ejected host replays the finished room');
  assert.equal(store.room.phase, 'LOBBY');
  assert.equal(store.player('h1').ejectedAt, null, 'replayMatch clears the ejection (task 4 design)');
  assert.equal(store.player('r1').ejectedAt, null);
});

// ---------------------------------------------------------------------------
// Class level — alarm() closes the ejected seat's socket 4405, after
// delivering its snapshot; other seats are untouched.
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

test('v33 F2b (class): alarm() delivers the ejection snapshot, then closes only the ejected seat — 4405, never 4403', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const realNow = Date.now;
  Date.now = () => T0 + 1000;
  try {
    const seeded = stateFor();
    // h1 + hu1 reported recently; r1 never reported → (4a) ejects r1.
    seeded.players.find((p) => p.playerId === 'h1').lastFixAt = new Date(T0 + 31000).toISOString();
    seeded.players.find((p) => p.playerId === 'hu1').lastFixAt = new Date(T0 + 31000).toISOString();
    await fake.storage.put(STATE_KEY, seeded);
    for (const id of ['h1', 'r1', 'hu1']) {
      await fake.storage.put(`session:${id}:tab-${id}`, sessionFor(id, `tab-${id}`));
    }
  } finally {
    Date.now = realNow;
  }
  const r1Socket = fake.addSocket('r1');
  const hu1Socket = fake.addSocket('hu1');
  const doInstance = new RoomDO(fake.ctx, env);
  const realNow2 = Date.now;
  try {
    // First tick clears the first-tick-after-wake grace ((4a) skips once).
    Date.now = () => T0 + 2000;
    await doInstance.alarm();
    await fake.flush();
    assert.deepEqual(r1Socket.closed, [], 'no close before the ejection tick');
    // Ejection tick: r1 has never reported a fix.
    Date.now = () => T0 + 32000;
    await doInstance.alarm();
    await fake.flush();
  } finally {
    Date.now = realNow2;
  }
  const sent = r1Socket.sent.map((text) => JSON.parse(text));
  assert.ok(
    sent.some((e) => e.type === 'room.state' && e.payload['reason'] === 'player-ejected'),
    'the ejected seat must receive the player-ejected event',
  );
  const snap = sent.find((e) => e.type === 'snapshot');
  assert.ok(snap, 'the ejected seat must receive its snapshot before the close');
  assert.notEqual(
    snap.payload['players'].find((p) => p.playerId === 'r1').ejectedAt,
    null,
    'the delivered snapshot must carry ejectedAt',
  );
  assert.deepEqual(r1Socket.closed, [
    { code: 4405, reason: 'You were ejected from the game.' },
  ]);
  assert.deepEqual(hu1Socket.closed, [], 'a live seat keeps its socket');
  assert.equal(
    await fake.storage.get('session:r1:tab-r1'),
    undefined,
    'the ejected seat sessions are deleted',
  );
});

// ---------------------------------------------------------------------------
// v33 fix round (Zara final review) — the three blocking/required items
// plus the two recommended items, each pinned here.
// ---------------------------------------------------------------------------

test('v33 fix round (Zara BLOCKING): lifecycleOp pause 403s an ejected seat while live, and still pauses for a live seat', async () => {
  const store = makeStore();
  start(store);
  await ejectR1ByMissingFix(store);
  const refused = store.lifecycleOp({
    action: 'pause',
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 33000,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'SEAT_REMOVED');
  assert.equal(refused.status, 403);
  assert.equal(store.room.phase, 'ACTIVE', 'the refused pause must not pause the match');
  const ok = store.lifecycleOp({
    action: 'pause',
    playerId: 'r2',
    reconnectTokenHash: 'reconnect-hash-r2',
    nowMs: T0 + 34000,
  });
  assert.equal(ok.ok, true, 'a live seat still pauses');
  assert.equal(store.room.phase, 'SAFETY_PAUSED');
});

test('v33 fix round (Zara REQUIRED): handleWsMessage refuses snapshot.request from an ejected seat while live (4405), and serves a live seat', async () => {
  const store = makeStore();
  start(store);
  await ejectR1ByMissingFix(store);
  const refused = await store.handleWsMessage(
    { playerId: 'r1', sessionId: 's1' },
    { type: 'snapshot.request', commandId: 'snap-r1', payload: {} },
    T0 + 33000,
  );
  assert.deepEqual(refused.close, { code: 4405, reason: 'You were ejected from the game.' });
  assert.equal(
    refused.events.some((e) => e.type === 'error'),
    true,
    'an error event is delivered before the close',
  );
  assert.equal(
    refused.events.some((e) => e.type === 'snapshot'),
    false,
    'no snapshot is served to the ejected seat',
  );
  const live = await store.handleWsMessage(
    { playerId: 'r2', sessionId: 's1' },
    { type: 'snapshot.request', commandId: 'snap-r2', payload: {} },
    T0 + 33000,
  );
  assert.equal(live.close, undefined, 'a live seat keeps its socket');
  assert.equal(
    live.events.some((e) => e.type === 'snapshot'),
    true,
    'a live seat still gets its snapshot',
  );
});

test('v33 fix round (Zara REQUIRED): issueHostToken refuses an ejected host while live, and still mints for a live host', async () => {
  const store = makeStore();
  start(store);
  // Eject only the host: everyone else reports.
  await sendFix(store, 'hu1', T0 + 5000);
  await sendFix(store, 'r1', T0 + 5000);
  await sendFix(store, 'r2', T0 + 5000);
  store.alarmTick(T0 + 32000);
  assert.notEqual(store.player('h1').ejectedAt, null, 'the host must be ejected');
  assert.equal(store.room.phase, 'ACTIVE');
  const refused = await store.issueHostToken({
    playerId: 'h1',
    reconnectTokenHash: 'reconnect-hash-h1',
    nowMs: T0 + 33000,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'FORBIDDEN');
  assert.equal(refused.status, 403);
  // Control: a live host still mints.
  const live = makeStore();
  start(live);
  const minted = await live.issueHostToken({
    playerId: 'h1',
    reconnectTokenHash: 'reconnect-hash-h1',
    nowMs: T0 + 5000,
  });
  assert.equal(minted.ok, true, 'a live host still mints a host token');
});

test('v33 fix round (Zara RECOMMENDED): suspendSeat is a no-op for an ejected or left seat, and still suspends a live seat', async () => {
  const store = makeStore();
  start(store);
  await ejectR1ByMissingFix(store);
  const ejected = store.suspendSeat('r1', 'network-lost', T0 + 33000);
  assert.deepEqual(ejected, { events: [], persist: [], needsHostCheckin: false });
  assert.equal(
    store.mem.lastSuspensionReason['r1'],
    undefined,
    'no suspension reason is stamped for an ejected seat',
  );
  assert.equal(store.player('r1').connectionState, 'connected', 'an ejected seat is not suspended');
  store.leaveSeat('r2', null, T0 + 33000);
  const left = store.suspendSeat('r2', 'network-lost', T0 + 34000);
  assert.deepEqual(left, { events: [], persist: [], needsHostCheckin: false });
  assert.equal(
    store.mem.lastSuspensionReason['r2'],
    undefined,
    'no suspension reason is stamped for a left seat',
  );
  // Control: a live seat still suspends.
  const live = store.suspendSeat('hu1', 'tab-hidden', T0 + 34000);
  assert.equal(
    live.events.some((e) => e.type === 'player.suspended'),
    true,
    'a live seat still suspends',
  );
  assert.equal(store.player('hu1').connectionState, 'suspended');
});

test('v33 fix round (Zara REQUIRED, class): hello from an ejected seat closes 4405 with no welcome + snapshot — first hello and repeat hello', async () => {
  for (const helloDone of [false, true]) {
    const fake = makeCtx();
    const { env } = makeEnv();
    const realNow = Date.now;
    Date.now = () => T0 + 1000;
    try {
      const seeded = stateFor();
      seeded.players.find((p) => p.playerId === 'r1').ejectedAt = new Date(T0 + 500).toISOString();
      await fake.storage.put(STATE_KEY, seeded);
      const session = sessionFor('r1', 'tab-r1');
      session.helloDone = helloDone;
      await fake.storage.put('session:r1:tab-r1', session);
    } finally {
      Date.now = realNow;
    }
    const ws = fake.addSocket('r1');
    fake.addSocket('tab:tab-r1');
    fake.tagSocket(ws, ['r1', 'tab:tab-r1']);
    const doInstance = new RoomDO(fake.ctx, env);
    const realNow2 = Date.now;
    try {
      Date.now = () => T0 + 5000;
      await doInstance.webSocketMessage(
        ws,
        JSON.stringify({ playerId: 'r1', type: 'hello', payload: { v: 1 } }),
      );
      await fake.flush();
    } finally {
      Date.now = realNow2;
    }
    const sent = ws.sent.map((t) => JSON.parse(t));
    assert.equal(
      sent.some((e) => e.type === 'welcome'),
      false,
      `no welcome for an ejected seat (helloDone=${helloDone})`,
    );
    assert.equal(
      sent.some((e) => e.type === 'snapshot'),
      false,
      `no snapshot for an ejected seat (helloDone=${helloDone})`,
    );
    assert.deepEqual(ws.closed, [{ code: 4405, reason: 'You were ejected from the game.' }]);
    // The ejected seat's session is untouched by the hello refusal
    // itself (the ejection already deleted sessions at ejection
    // time); the refusal must not resume the seat either.
    assert.equal(doInstance.store.player('r1').connectionState, 'connected');
  }
});
