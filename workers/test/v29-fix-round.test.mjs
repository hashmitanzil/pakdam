import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomDO } = await import('../src/room-do-class.ts');
const { RoomStore, STATE_KEY, emptyMemory, durableSnapshot } = await import('../src/room-do.ts');
const { redactPayload, stripCoordinatesDeep } = await import('../src/supabase.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// v29 fix round — F2 (ticket.renewed expiresAtMs), F5 (tab-hidden
// guard after eviction), F6 (teammate.fix broadcast), F9 (deep
// strip for log/event paths). F1 (epoch) is covered in
// v29-performance.test.mjs; F3 in v29-gps-anti-cheat.test.mjs; F4 in
// v29-thirty-second-rule.test.mjs.
const T0 = 1_780_000_000_000;
globalThis.fetch = async () => ({ ok: true });

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

class FakeSocket {
  sent = [];
  closed = [];
  send(text) { this.sent.push(text); }
  close(code, reason) { this.closed.push({ code, reason }); }
}

class FakeStorage {
  constructor() { this.map = new Map(); this.alarmsSet = []; this.alarmsDeleted = 0; }
  async get(k) { return this.map.get(k); }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
  async deleteAll() { this.map.clear(); }
  async deleteAlarm() { this.alarmsDeleted += 1; }
  async setAlarm(ms) { this.alarmsSet.push(ms); }
  async list({ prefix } = {}) {
    const out = new Map();
    for (const k of [...this.map.keys()].sort()) {
      if (prefix === undefined || k.startsWith(prefix)) out.set(k, this.map.get(k));
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
    waitUntil: (p) => { pending.push(p); p.catch(() => undefined); },
  };
  return {
    ctx, storage, sockets,
    addSocket(tag) {
      const s = new FakeSocket();
      if (!sockets.has(tag)) sockets.set(tag, []);
      sockets.get(tag).push(s);
      return s;
    },
    tagSocket(ws, tags) { wsTags.set(ws, tags); },
    async flush() { await Promise.allSettled(pending); pending.length = 0; },
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
            status: 200, headers: { 'Content-Type': 'application/json' },
          }),
        }),
      },
    },
  };
}

async function withNow(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

function player(playerId, displayName, isHost = false) {
  return {
    playerId, roomId: 'room-1', kind: 'guest', displayName, isHost,
    matchRole: null, team: null, reconnectTokenHash: `reconnect-hash-${playerId}`,
    joinedAt: new Date(T0 - 1000).toISOString(), leftAt: null, ejectedAt: null,
    connectionState: 'connected', lastFixAt: null, locationQuality: null,
    isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
  };
}

function makeStore({ hunters = ['hu1'], runners = ['r1'], headStartSeconds = 0, durationSeconds = 3600 } = {}) {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds, pingIntervalSeconds: 0, durationSeconds,
    zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 60, playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected', selectedHunterIds: [...hunters],
    hunterCount: hunters.length, balanceHunters: false, randomDraw: false,
  };
  const players = [
    player('h1', 'Host', true),
    ...hunters.map((id, i) => player(id, `Hunter ${i + 1}`)),
    ...runners.map((id, i) => player(id, `Runner ${i + 1}`)),
  ];
  const state = {
    room: {
      roomId: 'room-1', roomCode: 'ABCDEF', hostPlayerId: 'h1', phase: 'LOBBY',
      version: 1, config, createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: null, endsAt: null, pausedAt: null, result: null,
    },
    players, catches: [], hostTokens: { h1: 'host-hash' }, serverSeq: 0,
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

async function sendFix(store, playerId, atMs, point = INSIDE) {
  const r = await store.handleWsMessage(
    { playerId, sessionId: 's1' },
    {
      type: 'location.update',
      commandId: `fix-${playerId}-${atMs}`,
      payload: { fix: { ...point, accuracyMeters: 10, timestampMs: atMs } },
    },
    atMs,
  );
  assert.equal(r.events.some((e) => e.type === 'error'), false, `fix for ${playerId} at ${atMs} must be accepted`);
  return r;
}

// ---------------------------------------------------------------------------
// F2 — ticket.renewed carries expiresAtMs (60 s TTL, never 10 min)
// ---------------------------------------------------------------------------

test('F2 ticket.renewed carries expiresAtMs with the 60 s TTL', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const store = makeStore();
  start(store);
  const state = durableSnapshot(store.state);
  await fake.storage.put(STATE_KEY, state);
  const nowMs = T0 + 5000;
  await fake.storage.put(`session:h1:tab-h1`, {
    sessionId: 'tab-h1', playerId: 'h1', ticketId: 'ticket-h1',
    ticketExpiresAtMs: nowMs + 20_000, renewalWarned: false,
    lastHeartbeatAtMs: nowMs, missedHeartbeats: 0, helloDone: true,
  });
  const hostSocket = fake.addSocket('h1');
  fake.addSocket('tab:tab-h1');
  const doInstance = new RoomDO(fake.ctx, env);
  await withNow(nowMs, () => doInstance.alarm());
  await fake.flush();
  const sent = hostSocket.sent.map((t) => JSON.parse(t));
  const renewed = sent.find((e) => e.type === 'ticket.renewed');
  assert.ok(renewed, 'the socket must receive ticket.renewed');
  assert.equal(renewed.payload.expiresAtMs, nowMs + 60_000, 'expiresAtMs is mint + the 60 s TTL');
  assert.ok(renewed.payload.expiresAtMs - nowMs <= 60_000, 'the TTL is 60 s, never 10 min');
});

// ---------------------------------------------------------------------------
// F5 — simulated eviction + hidden tab + 90 s of missed heartbeats:
// no 1011 close, no 30 s window.
// ---------------------------------------------------------------------------

test('F5 after an eviction, a hidden tab with a live socket is never closed 1011 and never starts a window', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  store.suspendSeat('r1', 'tab-hidden', T0 + 5000);
  assert.equal(store.player('r1').connectionState, 'suspended');
  assert.equal(store.reconnectEndsAtMs('r1'), null, 'tab-hidden starts no window');
  // Keep the other seats fix-fresh in durable state so the (4a)
  // missing-fix ejection cannot touch them on the later ticks.
  store.player('h1').lastFixAt = new Date(T0 + 97_000).toISOString();
  store.player('hu1').lastFixAt = new Date(T0 + 97_000).toISOString();
  await fake.storage.put(STATE_KEY, durableSnapshot(store.state));
  // The session's last heartbeat is T0+5000 — 90+ s stale by the
  // second tick. The ticket lives far past both ticks.
  await fake.storage.put(`session:r1:tab-r1`, {
    sessionId: 'tab-r1', playerId: 'r1', ticketId: 'ticket-r1',
    ticketExpiresAtMs: T0 + 600_000, renewalWarned: false,
    lastHeartbeatAtMs: T0 + 5000, missedHeartbeats: 0, helloDone: true,
  });
  // The socket is still attached (hibernatable socket re-attached
  // on wake) — but the fresh instance's memory-only
  // `lastSuspensionReason` map is EMPTY: this is the eviction.
  const runnerSocket = fake.addSocket('r1');
  fake.addSocket('tab:tab-r1');
  const doInstance = new RoomDO(fake.ctx, env);
  // First tick after the wake: the first-tick grace resets the clock.
  await withNow(T0 + 8000, () => doInstance.alarm());
  await fake.flush();
  assert.equal(runnerSocket.closed.length, 0, 'no close on the wake tick');
  // Second tick, 90 s later: 3 missed heartbeats — the old
  // reason-gated guard would close 1011 here (reason map is empty
  // after the eviction) and start a 30 s window.
  await withNow(T0 + 98_000, () => doInstance.alarm());
  await fake.flush();
  assert.equal(runnerSocket.closed.length, 0, 'a suspended seat with a live socket is never closed 1011');
  const sent = runnerSocket.sent.map((t) => JSON.parse(t));
  assert.equal(sent.some((e) => e.type === 'player.suspended'), false, 'no suspend is emitted for the hidden tab');
  assert.equal(doInstance.store.state.disconnectDeadlineMs?.['r1'], undefined, 'no 30 s window starts');
  assert.equal(doInstance.store.player('r1').ejectedAt, null, 'the seat is not ejected');
  const session = await fake.storage.get('session:r1:tab-r1');
  assert.ok(session, 'the session survives — it is not deleted as dead');
});

// ---------------------------------------------------------------------------
// F6 — teammate.fix broadcast: teammates only, same predicate as the snapshot
// ---------------------------------------------------------------------------

test('F6 a fix broadcasts teammate.fix to teammates only, with the exact contract payload', async () => {
  const store = makeStore({ hunters: ['hu1', 'hu2'], runners: ['r1', 'r2'] });
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  const r = await sendFix(store, 'r1', T0 + 2000, { lat: 23.35, lng: 85.33 });
  const fixes = r.events.filter((e) => e.type === 'teammate.fix');
  assert.equal(fixes.length, 1, 'exactly one teammate.fix per accepted fix');
  // The host (h1) is a Runner teammate after the role draw (selected
  // Hunters are hu1/hu2, everyone else runs), so they receive it too.
  assert.deepEqual(fixes[0].recipients, ['h1', 'r2'], 'only Runner teammates receive it — never Hunters');
  assert.deepEqual(
    { playerId: fixes[0].payload.playerId, lat: fixes[0].payload.lat, lng: fixes[0].payload.lng, accuracyMeters: fixes[0].payload.accuracyMeters, timestampMs: fixes[0].payload.timestampMs },
    { playerId: 'r1', lat: 23.35, lng: 85.33, accuracyMeters: 10, timestampMs: T0 + 2000 },
    'the payload is exactly { playerId, lat, lng, accuracyMeters, timestampMs }',
  );
  const h = await sendFix(store, 'hu1', T0 + 3000);
  assert.deepEqual(
    h.events.filter((e) => e.type === 'teammate.fix').map((e) => e.recipients),
    [['hu2']],
    'a Hunter fix goes to the other Hunter only',
  );
});

test('F6 no teammate.fix in the lobby (no teams yet)', async () => {
  const store = makeStore({ hunters: ['hu1', 'hu2'], runners: ['r1', 'r2'] });
  const r = await sendFix(store, 'r1', T0 + 2000);
  assert.equal(r.events.filter((e) => e.type === 'teammate.fix').length, 0, 'no teams in the lobby means no broadcast');
});

test('F6 broadcast and snapshot agree for a caught Runner: they receive nothing, but their fix still reaches live teammates', async () => {
  const store = makeStore({ hunters: ['hu1', 'hu2'], runners: ['r1', 'r2'] });
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  // Confirmed catch against r1 (harness-injected: the predicate under
  // test is teammateViewFor/isCaughtSpectator, not the catch flow).
  store.state.catches.push({
    catchId: 'c1', roomId: 'room-1', hunterPlayerId: 'hu1', runnerPlayerId: 'r1',
    state: 'confirmed', qrTokenHash: null, requestedAt: new Date(T0).toISOString(),
    confirmedAt: new Date(T0).toISOString(), disputedAt: null,
    resolution: 'confirmed', gpsEvidence: 'present',
  });
  // The caught Runner's own snapshot view is empty.
  assert.deepEqual(store.snapshotFor('r1', T0 + 2000).teammateFixes, {}, 'a caught Runner sees no teammate fixes');
  // The caught Runner's fix IS still broadcast to live teammates
  // (their snapshot view still contains it).
  const caught = await sendFix(store, 'r1', T0 + 2000);
  assert.deepEqual(
    caught.events.filter((e) => e.type === 'teammate.fix').map((e) => e.recipients),
    [['h1', 'r2']],
    'the caught Runner fix still reaches the live teammates',
  );
  assert.notEqual(store.snapshotFor('r2', T0 + 2000).teammateFixes['r1'], undefined, 'sanity: the snapshot shows the caught Runner fix to a live teammate');
  // ...but a live teammate's fix is NOT broadcast to the caught Runner.
  // (It still reaches the OTHER live Runner teammate — the host, who
  // runs after the selected-Hunter draw — so assert on recipients,
  // not on the event count.)
  const live = await sendFix(store, 'r2', T0 + 3000);
  const liveFixes = live.events.filter((e) => e.type === 'teammate.fix');
  assert.deepEqual(liveFixes.map((e) => e.recipients), [['h1']], 'the live fix reaches the other live teammate only');
  assert.equal(liveFixes.flatMap((e) => e.recipients).includes('r1'), false, 'no teammate.fix reaches a caught Runner');
});

// ---------------------------------------------------------------------------
// F9 — deep strip for log/event paths
// ---------------------------------------------------------------------------

test('F9 redactPayload and stripCoordinatesDeep strip coordinate keys at any depth', () => {
  const payload = {
    playerId: 'r1',
    note: 'keep me',
    fix: { lat: 23.35, lng: 85.33 },
    meta: {
      centre: { lat: 1, lng: 2 },
      center: { lat: 1, lng: 2 },
      coordinates: [23.35, 85.33],
      position: { lat: 1, lng: 2 },
      lngLat: [85.33, 23.35],
      nested: [{ latitude: 1, longitude: 2, label: 'kept' }],
    },
  };
  const clean = redactPayload(payload);
  assert.equal(JSON.stringify(clean).includes('23.35'), false, 'no coordinate value survives');
  assert.equal(clean.note, 'keep me');
  assert.equal(clean.meta.nested[0].label, 'kept', 'non-coordinate keys survive at depth');
  assert.equal('fix' in clean, false);
  assert.equal('centre' in clean.meta, false);
  assert.equal('center' in clean.meta, false);
  assert.equal('coordinates' in clean.meta, false);
  assert.equal('position' in clean.meta, false);
  assert.equal('lngLat' in clean.meta, false);
  assert.equal('latitude' in clean.meta.nested[0], false);
  assert.equal(stripCoordinatesDeep([[{ fix: { lat: 1 } }]]).length, 1);
  assert.deepEqual(stripCoordinatesDeep([[{ fix: { lat: 1 } }]]), [[{}]], 'arrays are stripped too');
});

test('F9 RoomStore.logGameEvent deep-strips nested coordinate payloads', () => {
  const store = makeStore();
  const intent = store.logGameEvent('PLAYER_JOINED', 'r1', {
    playerId: 'r1',
    meta: { coordinates: { lat: 23.35, lng: 85.33 }, note: 'x' },
  }, T0);
  assert.equal(intent.kind, 'room-event');
  assert.equal(JSON.stringify(intent.payload).includes('23.35'), false);
  assert.equal(intent.payload.meta.note, 'x');
});
