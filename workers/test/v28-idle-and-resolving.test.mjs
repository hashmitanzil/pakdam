import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomDO } = await import('../src/room-do-class.ts');
const { RoomStore, STATE_KEY, emptyMemory, ABANDONED_IDLE_MS } = await import('../src/room-do.ts');
const sharedNs = await import('@pakdam/shared');
const { DEFAULT_ROOM_CONFIG } = sharedNs;

// v28 — Durable Object request cap: the 1 s tick must not run forever
// on a room nobody is in, and an abandoned live room must end itself.
//
//   F7 — `alarmDelayMs` used to return 1000 ms for HEAD_START / ACTIVE
//   / SAFETY_PAUSED with no session or socket input at all: a live
//   room with zero connected sockets alarmed 86,400×/day until a
//   terminal phase. Now the cadence takes attendance: 1 s only with a
//   live socket attached (or a host grace running); 30 s with nobody
//   attached.
//   F8 — empty-room termination existed only in `leaveSeat`. A room
//   whose phones all died (seats suspend, no `leave` ever arrives)
//   never reached terminal. Now the idle clock
//   (`state.noSocketsSinceMs`, durable so it survives eviction)
//   ends it after ABANDONED_IDLE_MS (10 min — see the constant: it
//   must exceed the v29 2-min seat hold plus margin).
//   F10 — precedence: a running host grace DEFERS the idle end (the
//   clock is left untouched, never reset), and a returning host
//   revives the room cleanly.
//   F11 — SAFETY_PAUSED is the stuck shape: no timeout, no
//   auto-resume, ticked at 1 s. The idle window ends a paused room
//   whose seats are suspended-but-not-left.
//   F12 — a socket that connects but never hellos used to hold a
//   redeemed ticket and count as a live socket forever. The alarm
//   now closes it once its (60 s) ticket is dead.
//   RESOLVING — `completeMatch` moves RESOLVING → COMPLETED
//   synchronously, so no durable RESOLVING state should exist; the
//   tick now finishes one anyway instead of ticking 30 s forever.
//   A3 (Zara) — the "60 s disconnect grace" comment is now 30 s
//   (comment-only, pinned by inspection, not by a test).
//
// FAKE FIDELITY NOTES (mirroring v24-host-grace-do.test.mjs):
// - `storage.list()` returns keys in LEXICOGRAPHIC order, exactly like
//   real DO storage.
// - `waitUntil` only records promises; tests `await flush()` them.
// - No Supabase env: persist intents no-op (best-effort, swallowed).
// - No DO_OP_SECRET: the internal-op secret check is skipped (dev).
// - `globalThis.fetch` is the PostgREST transport; it answers OK.
const T0 = Date.now();

globalThis.fetch = async () => ({ ok: true });

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];

const IDS = { h1: 'h1', r1: 'r1', r2: 'r2', hu1: 'hu1' };

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

function player(id, displayName, isHost, joinedAtMs, extra = {}) {
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
    // Fresh fix receipt: without it a second ACTIVE tick 30 s+ after
    // the seed would eject the seat for silence (step (4a)). The
    // first tick after a wake skips (4a), but later ticks do not.
    lastFixAt: new Date(T0).toISOString(),
    locationQuality: null,
    isReady: true,
    briefingConfirmed: true,
    ageGatePassed: true,
    suspensionCount: 0,
    ...extra,
  };
}

function stateFor(ids, phase = 'LOBBY', opts = {}) {
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
      startedAt: live ? new Date(T0 - 60_000).toISOString() : null,
      endsAt: live ? new Date(T0 + 3_600_000).toISOString() : null,
      pausedAt: phase === 'SAFETY_PAUSED' ? new Date(T0).toISOString() : null,
      result: null,
    },
    players: [
      player(ids.h1, 'Host', true, T0 - 5000, opts.hostExtra ?? {}),
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
    paused: phase === 'SAFETY_PAUSED',
    pausedBy: phase === 'SAFETY_PAUSED' ? ids.h1 : null,
    pausedFrom: phase === 'SAFETY_PAUSED' ? 'ACTIVE' : null,
    eventLog: [],
    shrinkIndexApplied: 0,
    tickets: [],
    idempotency: [],
    idempotentReplies: [],
    pendingPings: [],
    pendingPingRecipients: {},
    runnerQrTokens: [],
    hostGrace: opts.hostGrace ?? null,
    noSocketsSinceMs: opts.noSocketsSinceMs ?? null,
  };
}

function sessionFor(playerId, tab, extra = {}) {
  return {
    sessionId: tab,
    playerId,
    ticketId: `ticket-${playerId}`,
    ticketExpiresAtMs: T0 + 60_000,
    renewalWarned: false,
    lastHeartbeatAtMs: T0,
    missedHeartbeats: 0,
    helloDone: true,
    ...extra,
  };
}

async function seedRoom(fake, ids, phase = 'LOBBY', opts = {}) {
  await fake.storage.put(STATE_KEY, stateFor(ids, phase, opts));
  for (const id of Object.values(ids)) {
    await fake.storage.put(`session:${id}:tab-${id}`, sessionFor(id, `tab-${id}`));
  }
}

/** Run `fn` with Date.now() mocked to `ms`; always restores. */
async function withNow(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

// ---------------------------------------------------------------------------
// F7 — cadence takes attendance
// ---------------------------------------------------------------------------

test('v28 (DO) live room WITH a socket attached keeps the 1 s tick', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, env);
  fake.addSocket(ids.r1);
  fake.addSocket(`tab:tab-${ids.r1}`);
  await withNow(T0 + 1000, () => doInstance.alarm());
  await fake.flush();
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.phase, 'ACTIVE', 'the tick must not end an attended live room');
  assert.equal(
    fake.storage.alarmsSet.at(-1),
    T0 + 1000 + 1000,
    `a live room with a socket must re-arm at +1 s: ${JSON.stringify(fake.storage.alarmsSet)}`,
  );
  assert.equal(stored.noSocketsSinceMs, null, 'the idle clock must stay null while a socket is attached');
});

test('v28 (DO) live room with NO socket attached drops to the 30 s cadence and starts the idle clock', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, env);
  await withNow(T0 + 1000, () => doInstance.alarm());
  await fake.flush();
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.phase, 'ACTIVE', 'dropping the cadence must not end the room by itself');
  assert.equal(
    fake.storage.alarmsSet.at(-1),
    T0 + 1000 + 30_000,
    `a live room with nobody attached must re-arm at +30 s, not +1 s: ${JSON.stringify(fake.storage.alarmsSet)}`,
  );
  assert.equal(
    stored.noSocketsSinceMs,
    T0 + 1000,
    'the first no-socket tick must stamp the idle clock',
  );
});

// ---------------------------------------------------------------------------
// F8 / F10 — abandoned live room ends; grace defers, never resets
// ---------------------------------------------------------------------------

test('v28 (DO) idle clock survives eviction; a grace on the deadline tick DEFERS the end, and the room abandons once the grace lapses', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'ACTIVE');
  const first = new RoomDO(fake.ctx, env);
  // Tick 1 (no sockets): cadence drops, clock stamps.
  await withNow(T0 + 1000, () => first.alarm());
  await fake.flush();
  let stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.noSocketsSinceMs, T0 + 1000, 'tick 1 must stamp the clock');

  // EVICTION: a fresh RoomDO on the same storage, woken by the tick
  // at the far end of the window.
  const woken = new RoomDO(fake.ctx, env);
  const deadlineTick = T0 + 1000 + ABANDONED_IDLE_MS + 1000;
  await withNow(deadlineTick, () => woken.alarm());
  await fake.flush();
  stored = await fake.storage.get(STATE_KEY);
  // The heartbeat loop suspends every seat at this tick (silent for
  // 10 min = 20 missed heartbeats), and the host's suspend starts
  // the 30 s grace — which DEFERS the idle end (F10): the room must
  // NOT abandon underneath the running grace, and the clock must be
  // left exactly as it was, not reset.
  assert.equal(stored.room.phase, 'ACTIVE', 'the deadline tick must not abandon under a running grace');
  assert.equal(
    stored.hostGrace?.endsAtMs,
    deadlineTick + 30_000,
    'the heartbeat-timeout suspend of the host must start the 30 s grace',
  );
  assert.equal(
    stored.noSocketsSinceMs,
    T0 + 1000,
    'a running grace must leave the idle clock untouched (defer, not reset)',
  );

  // Tick 3, just after the grace lapses: nobody returned, the clock
  // is past the window — the room ends.
  await withNow(deadlineTick + 31_000, () => woken.alarm());
  await fake.flush();
  stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.phase, 'ABANDONED', 'the room must abandon on the first tick after the grace lapses');
  assert.equal(stored.room.result?.outcome, 'abandoned');
  assert.equal(stored.noSocketsSinceMs, null, 'abandonment clears the clock');
  assert.ok(fake.storage.alarmsDeleted >= 1, 'a terminal phase must delete the alarm');
});

test('v28 (DO) abandoned live room with the clock already past the window abandons on the next tick and deletes the alarm', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'ACTIVE', { noSocketsSinceMs: T0 - ABANDONED_IDLE_MS - 5000 });
  const doInstance = new RoomDO(fake.ctx, env);
  await withNow(T0 + 1000, () => doInstance.alarm());
  await fake.flush();
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.phase, 'ABANDONED');
  assert.equal(stored.room.result?.outcome, 'abandoned');
  assert.ok(fake.storage.alarmsDeleted >= 1, 'a terminal phase must delete the alarm');
});

// ---------------------------------------------------------------------------
// F10 — grace still expires on time with no sockets attached
// ---------------------------------------------------------------------------

test('v28 (DO) host grace expires on time with NO sockets attached, and the idle clock starts (not the abandon) on that tick', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  const endsAt = T0 + 30_000;
  await seedRoom(fake, ids, 'ACTIVE', {
    hostGrace: { hostPlayerId: ids.h1, endsAtMs: endsAt },
    hostExtra: { connectionState: 'suspended' },
  });
  const doInstance = new RoomDO(fake.ctx, env);
  // No sockets at all — the grace must still transfer at its
  // deadline, and the tick that fires it must NOT abandon the room
  // (the window has not elapsed).
  await withNow(endsAt, () => doInstance.alarm());
  await fake.flush();
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.hostPlayerId, ids.r1, 'the deadline tick must transfer host even with no sockets');
  assert.equal(stored.hostGrace, null, 'the grace is gone after the transfer');
  assert.equal(stored.room.phase, 'ACTIVE', 'the transfer tick must not abandon the room');
  assert.equal(
    stored.noSocketsSinceMs,
    endsAt,
    'the transfer tick is the first no-socket observation: the clock starts here',
  );
  assert.equal(
    fake.storage.alarmsSet.at(-1),
    endsAt + 30_000,
    'with no sockets and no grace left, the cadence drops to 30 s',
  );
});

// ---------------------------------------------------------------------------
// F11 — the paused room is the stuck shape
// ---------------------------------------------------------------------------

test('v28 (DO) paused room with nobody attached drops to 30 s and abandons at the window', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'SAFETY_PAUSED');
  const doInstance = new RoomDO(fake.ctx, env);
  await withNow(T0 + 1000, () => doInstance.alarm());
  await fake.flush();
  let stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.phase, 'SAFETY_PAUSED', 'dropping the cadence must not resume or end a paused room');
  assert.equal(
    fake.storage.alarmsSet.at(-1),
    T0 + 1000 + 30_000,
    `a paused room with nobody attached must re-arm at +30 s: ${JSON.stringify(fake.storage.alarmsSet)}`,
  );
  assert.equal(stored.noSocketsSinceMs, T0 + 1000, 'the idle clock must run for a paused room too');

  // Fast-forward the clock past the window (direct storage edit, as
  // the production clock would have stamped it 10 min earlier) and
  // wake a FRESH instance on it — an already-loaded instance would
  // never re-read the edited storage.
  stored = await fake.storage.get(STATE_KEY);
  stored.noSocketsSinceMs = T0 + 1000 - ABANDONED_IDLE_MS - 1000;
  await fake.storage.put(STATE_KEY, stored);
  const woken = new RoomDO(fake.ctx, env);
  await withNow(T0 + 2000, () => woken.alarm());
  await fake.flush();
  stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.phase, 'ABANDONED', 'a paused room with nobody attached must end as ABANDONED');
  assert.equal(stored.room.result?.outcome, 'abandoned');
  assert.ok(fake.storage.alarmsDeleted >= 1, 'a terminal phase must delete the alarm');
});

// ---------------------------------------------------------------------------
// F12 — never-hello sockets
// ---------------------------------------------------------------------------

test('v28 (DO) a socket that never hellos is closed once its ticket is dead, and stops holding the 1 s tick', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'LOBBY');
  // r1's session never hello'd; its ticket dies at T0 + 60 s.
  const sessionKey = `session:${ids.r1}:tab-${ids.r1}`;
  const rec = await fake.storage.get(sessionKey);
  rec.helloDone = false;
  await fake.storage.put(sessionKey, rec);
  const doInstance = new RoomDO(fake.ctx, env);
  const socket = fake.addSocket(`tab:tab-${ids.r1}`);
  fake.addSocket(ids.r1);
  // Tick before the ticket dies: the socket is still live, nothing closes.
  await withNow(T0 + 1000, () => doInstance.alarm());
  await fake.flush();
  assert.equal(socket.closed.length, 0, 'a never-hello socket must not be closed while its ticket is alive');
  // Tick after the ticket dies: closed 4401 (fresh ticket, reconnect
  // once) and the session is gone, so the next re-arm no longer sees
  // a live socket for the room.
  await withNow(T0 + 61_000, () => doInstance.alarm());
  await fake.flush();
  assert.equal(socket.closed.length, 1, 'the dead-ticket never-hello socket must be closed exactly once');
  assert.equal(socket.closed[0].code, 4401, 'the close must be 4401 (ticket expired — reconnect with a fresh ticket)');
  assert.equal(
    await fake.storage.get(sessionKey),
    undefined,
    'the never-hello session record must be deleted',
  );
});

// ---------------------------------------------------------------------------
// Lobby: 30 s cadence and 24 h expiry are untouched
// ---------------------------------------------------------------------------

test('v28 (DO) lobby still ticks 30 s with nobody attached and still expires at 24 h', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'LOBBY');
  const doInstance = new RoomDO(fake.ctx, env);
  await withNow(T0 + 1000, () => doInstance.alarm());
  await fake.flush();
  let stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.phase, 'LOBBY');
  assert.equal(
    fake.storage.alarmsSet.at(-1),
    T0 + 1000 + 30_000,
    'the lobby cadence is unchanged at 30 s',
  );
  assert.equal(stored.noSocketsSinceMs, null, 'the idle clock must not run for a lobby (its 24 h expiry owns it)');
  // Age the lobby past 24 h: the existing expiry ends it.
  stored = await fake.storage.get(STATE_KEY);
  stored.room.createdAt = new Date(T0 - 25 * 60 * 60 * 1000).toISOString();
  await fake.storage.put(STATE_KEY, stored);
  await withNow(T0 + 2000, () => doInstance.alarm());
  await fake.flush();
  stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.phase, 'EXPIRED', 'the 24 h lobby expiry must still fire');
  assert.ok(fake.storage.alarmsDeleted >= 1, 'a terminal phase must delete the alarm');
});

// ---------------------------------------------------------------------------
// Store half — RESOLVING, clock end, empty room, abandonForIdle
// ---------------------------------------------------------------------------

function storePlayer(playerId, displayName, isHost, joinedAtMs) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole: null,
    team: null,
    reconnectTokenHash: `reconnect-hash-${playerId}`,
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

/**
 * Store harness mirroring v23-host-rules.test.mjs (RoomStore direct,
 * no DO ctx, no network). Default roster: host h1, runners r1, r2,
 * hunter hu1; `phase` starts LOBBY unless overridden.
 */
function makeStore({ roster, hunters = ['hu1'], durationSeconds = 3600, phase = 'LOBBY' } = {}) {
  const seats = roster ?? [
    { id: 'h1', name: 'Host', host: true },
    { id: 'r1', name: 'Runner 1' },
    { id: 'r2', name: 'Runner 2' },
    { id: 'hu1', name: 'Hunter 1' },
  ];
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 0,
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
  };
  const players = seats.map((seat, i) =>
    storePlayer(seat.id, seat.name, seat.host === true, T0 - 5000 + i * 1000),
  );
  const live = phase !== 'LOBBY';
  const state = {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase,
      version: 1,
      config,
      createdAt: new Date(T0 - 5000).toISOString(),
      startedAt: live ? new Date(T0).toISOString() : null,
      endsAt: live ? new Date(T0 + durationSeconds * 1000).toISOString() : null,
      pausedAt: null,
      result: null,
    },
    players,
    catches: [],
    hostTokens: { h1: 'host-hash' },
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
  return new RoomStore(state, emptyMemory());
}

function start(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `startMatch must succeed: ${r.ok ? '' : r.error}`);
  return r;
}

function leaveAll(store, atMs) {
  for (const id of ['h1', 'r1', 'r2', 'hu1']) {
    store.leaveSeat(id, null, atMs);
  }
}

test('v28 (store) clock end completes the match (ACTIVE → COMPLETED, never stranded)', async () => {
  const store = makeStore();
  start(store);
  assert.equal(store.room.phase, 'HEAD_START');
  // Head start is 0 s, so the first tick moves to ACTIVE; the clock
  // end is then hit on the tick after the end.
  store.room.endsAt = new Date(T0 + 1000).toISOString();
  const tick1 = store.alarmTick(T0 + 500);
  assert.equal(store.room.phase, 'ACTIVE', 'the head start must elapse first');
  void tick1;
  const tick2 = store.alarmTick(T0 + 1500);
  assert.equal(store.room.phase, 'COMPLETED', 'the clock-end tick must complete the match');
  assert.ok(tick2.events.some((e) => e.type === 'match.completed'), 'match.completed must be emitted');
  assert.ok(store.room.result !== null, 'the result must be recorded');
});

test('v28 (store) a room stuck in RESOLVING completes on the next tick instead of ticking forever', async () => {
  const store = makeStore();
  start(store);
  // Simulate a stranded durable row: RESOLVING with no result yet.
  // (No current writer produces this — completeMatch transitions
  // synchronously — but if one ever does, the tick must finish it.)
  store.room.phase = 'RESOLVING';
  assert.equal(store.canCompleteMatch(), false, 'precondition: completeMatch refuses from RESOLVING');
  const tick = store.alarmTick(T0 + 1000);
  assert.equal(store.room.phase, 'COMPLETED', 'the RESOLVING backstop must complete the room');
  assert.ok(store.room.result !== null, 'the backstop must record a result');
  assert.ok(tick.events.some((e) => e.type === 'match.completed'), 'match.completed must be emitted');
  // And a tick on the terminal room is a no-op, not a re-complete.
  const tick2 = store.alarmTick(T0 + 2000);
  assert.equal(store.room.phase, 'COMPLETED');
  assert.equal(tick2.events.filter((e) => e.type === 'match.completed').length, 0);
});

test('v28 (store) empty room in RESOLVING cancels instead of stranding', async () => {
  const store = makeStore();
  start(store);
  store.room.phase = 'RESOLVING';
  leaveAll(store, T0 + 1000);
  assert.equal(
    store.room.phase,
    'CANCELLED',
    'the last player leaving a RESOLVING room must cancel it (the abandon fallback)',
  );
  assert.ok(store.room.result !== null);
});

test('v28 (store) empty live room abandons; empty HEAD_START cancels (leaveSeat, unchanged)', async () => {
  const live = makeStore();
  start(live);
  live.alarmTick(T0 + 500);
  assert.equal(live.room.phase, 'ACTIVE');
  leaveAll(live, T0 + 1000);
  assert.equal(live.room.phase, 'ABANDONED', 'the last player leaving a live room must abandon it');

  const headStart = makeStore();
  start(headStart);
  assert.equal(headStart.room.phase, 'HEAD_START');
  leaveAll(headStart, T0 + 1000);
  assert.equal(
    headStart.room.phase,
    'CANCELLED',
    'HEAD_START has no ABANDONED edge, so the empty-room fallback cancels it',
  );
});

test('v28 (store) abandonForIdle: ACTIVE/SAFETY_PAUSED → ABANDONED, READY_CHECK/COUNTDOWN → CANCELLED, LOBBY/terminal refuse', async () => {
  const active = makeStore();
  start(active);
  active.alarmTick(T0 + 500);
  const r1 = active.abandonForIdle(T0 + 1000);
  assert.equal(r1.abandoned, true);
  assert.equal(active.room.phase, 'ABANDONED');
  assert.equal(active.room.result?.outcome, 'abandoned');
  assert.ok(r1.events.some((e) => e.type === 'match.cancelled'), 'the idle end must broadcast match.cancelled');

  const paused = makeStore();
  start(paused);
  const pause = paused.lifecycleOp({
    action: 'pause',
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 500,
  });
  assert.equal(pause.ok, true, `pause must succeed: ${pause.ok ? '' : pause.error}`);
  assert.equal(paused.room.phase, 'SAFETY_PAUSED');
  const r2 = paused.abandonForIdle(T0 + 1000);
  assert.equal(r2.abandoned, true);
  assert.equal(paused.room.phase, 'ABANDONED', 'a paused room must end as ABANDONED, not stay paused forever');

  for (const phase of ['READY_CHECK', 'COUNTDOWN']) {
    const s = makeStore({ phase });
    const r = s.abandonForIdle(T0 + 1000);
    assert.equal(r.abandoned, true, `${phase} must end`);
    assert.equal(s.room.phase, 'CANCELLED', `${phase} has no ABANDONED edge, so it cancels`);
    assert.equal(s.room.result?.outcome, 'cancelled');
  }

  const lobby = makeStore();
  const r3 = lobby.abandonForIdle(T0 + 1000);
  assert.equal(r3.abandoned, false, 'a LOBBY must never be idle-abandoned (its 24 h expiry owns it)');
  assert.equal(lobby.room.phase, 'LOBBY');

  const done = makeStore();
  start(done);
  done.room.endsAt = new Date(T0 + 1000).toISOString();
  done.alarmTick(T0 + 500);
  done.alarmTick(T0 + 1500);
  assert.equal(done.room.phase, 'COMPLETED');
  const r4 = done.abandonForIdle(T0 + 2000);
  assert.equal(r4.abandoned, false, 'a terminal room must refuse the idle end');
  assert.equal(done.room.phase, 'COMPLETED');
});

// ---------------------------------------------------------------------------
// v28 fix round
// ---------------------------------------------------------------------------

test('v28 fix round (Zara R1 — DO): all-suspended seats WITH live sockets attached are NOT abandoned past the window; once the sockets go, the room abandons', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, env);
  // Every seat has a live socket (player tag + tab tag) — the
  // GPS-denied / tab-hidden shape: suspended seats, open transport.
  const hostTabSocket = fake.addSocket(`tab:tab-${ids.h1}`);
  const hostSocket = fake.addSocket(ids.h1);
  for (const id of [ids.r1, ids.r2, ids.hu1]) {
    fake.addSocket(`tab:tab-${id}`);
    fake.addSocket(id);
  }
  await withNow(T0, () => doInstance.alarm());
  await fake.flush();
  // Everyone hides the tab 5 s in and stays away — sockets stay open.
  for (const id of Object.values(ids)) {
    doInstance.store.suspendSeat(id, 'tab-hidden', T0);
  }
  assert.equal(doInstance.store.state.hostGrace, null, 'a tab-hidden host starts no grace');
  // 11 min later, sockets still attached: the room must NOT abandon.
  await withNow(T0 + 11 * 60_000, () => doInstance.alarm());
  await fake.flush();
  assert.equal(
    doInstance.store.room.phase,
    'ACTIVE',
    'all seats suspended for 11 min WITH live sockets attached must stay ACTIVE',
  );
  assert.equal(hostTabSocket.closed.length, 0, 'the hidden host socket must not be closed 1011');
  assert.equal(hostSocket.closed.length, 0, 'the hidden host socket must not be closed 1011');
  assert.equal(doInstance.store.state.hostGrace, null, 'no grace may start while the host is merely hidden');
  assert.equal(doInstance.store.room.hostPlayerId, ids.h1, 'the hidden host must keep the crown');
  // The sockets go: the same tick must now abandon the room (the
  // store rule fires on the single tick past the window once the
  // class reports zero live sockets).
  for (const id of Object.values(ids)) {
    fake.sockets.delete(id);
    fake.sockets.delete(`tab:tab-${id}`);
  }
  await withNow(T0 + 11 * 60_000 + 1000, () => doInstance.alarm());
  await fake.flush();
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(
    stored.room.phase,
    'ABANDONED',
    'once every socket is gone the same all-suspended room must abandon',
  );
});

test('v28 fix round (Zara R2 — DO): a SAFETY_PAUSED room with a socket attached ticks 1 s for 5 min, then demotes to 30 s; resume after demotion restores the 1 s tick', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'SAFETY_PAUSED');
  const doInstance = new RoomDO(fake.ctx, env);
  fake.addSocket(ids.r1);
  fake.addSocket(`tab:tab-${ids.r1}`);
  // Keep every seat's heartbeat fresh at the mocked time, so the
  // heartbeat loop never suspends anyone mid-test — the only thing
  // under test is the tick cadence.
  const refreshHeartbeats = (nowMs) => {
    for (const s of doInstance.sessions.values()) {
      s.lastHeartbeatAtMs = nowMs;
      s.missedHeartbeats = 0;
    }
  };
  // First tick at T0 loads the room (pausedAt is T0 in the seed).
  await withNow(T0, () => doInstance.alarm());
  await fake.flush();
  assert.equal(
    fake.storage.alarmsSet.at(-1),
    T0 + 1000,
    'a freshly paused room with a socket attached must re-arm at +1 s',
  );
  // 4 min into the pause (inside the 5-min fast-tick window): 1 s.
  await withNow(T0 + 4 * 60_000, async () => {
    refreshHeartbeats(T0 + 4 * 60_000);
    await doInstance.alarm();
  });
  await fake.flush();
  assert.equal(
    fake.storage.alarmsSet.at(-1),
    T0 + 4 * 60_000 + 1000,
    `4 min into the pause the tick must still be 1 s: ${JSON.stringify(fake.storage.alarmsSet)}`,
  );
  // 6 min in (past the 5-min window): demoted to 30 s.
  await withNow(T0 + 6 * 60_000, async () => {
    refreshHeartbeats(T0 + 6 * 60_000);
    await doInstance.alarm();
  });
  await fake.flush();
  assert.equal(
    fake.storage.alarmsSet.at(-1),
    T0 + 6 * 60_000 + 30_000,
    `6 min into the pause the tick must demote to 30 s: ${JSON.stringify(fake.storage.alarmsSet)}`,
  );
  // Resume after demotion still works — and the fast tick comes back.
  const resumed = await withNow(T0 + 6 * 60_000 + 1000, () =>
    doInstance.store.lifecycleOp({
      action: 'resume',
      playerId: ids.h1,
      hostTokenHash: 'host-hash',
      nowMs: T0 + 6 * 60_000 + 1000,
    }),
  );
  assert.equal(resumed.ok, true, `resume after demotion must succeed: ${resumed.ok ? '' : resumed.error}`);
  assert.equal(doInstance.store.room.phase, 'ACTIVE', 'resume must return the room to ACTIVE');
  await withNow(T0 + 6 * 60_000 + 2000, async () => {
    refreshHeartbeats(T0 + 6 * 60_000 + 2000);
    // The room is ACTIVE again, so the (4a) missing-fix ejection is
    // live: stamp fresh fixes or the stale T0 roster would eject.
    for (const id of Object.values(ids)) {
      doInstance.store.player(id).lastFixAt = new Date(T0 + 6 * 60_000 + 2000).toISOString();
    }
    await doInstance.alarm();
  });
  await fake.flush();
  assert.equal(
    fake.storage.alarmsSet.at(-1),
    T0 + 6 * 60_000 + 2000 + 1000,
    'the 1 s tick must return once the room resumes',
  );
});

test('v28 fix round (Diya R1 — DO): a tab-hidden host whose heartbeat goes silent for >90 s with the socket open gets NO grace and keeps host; a later socket close (network-lost) starts the grace and transfers', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, env);
  // Every seat has a live socket (player tag + tab tag).
  const hostTabSocket = fake.addSocket(`tab:tab-${ids.h1}`);
  const hostSocket = fake.addSocket(ids.h1);
  for (const id of [ids.r1, ids.r2, ids.hu1]) {
    fake.addSocket(`tab:tab-${id}`);
    fake.addSocket(id);
  }
  const witness = fake.addSocket(ids.r2);
  // The other seats keep playing: fresh heartbeats + fresh fixes at
  // the mocked time, so the heartbeat loop and the (4a) missing-fix
  // ejection never touch them — only the hidden host goes silent.
  const refreshLive = (nowMs) => {
    for (const s of doInstance.sessions.values()) {
      if (s.playerId === ids.h1) continue;
      s.lastHeartbeatAtMs = nowMs;
      s.missedHeartbeats = 0;
    }
    for (const id of [ids.r1, ids.r2, ids.hu1]) {
      doInstance.store.player(id).lastFixAt = new Date(nowMs).toISOString();
    }
  };
  const sentEvents = (socket) => socket.sent.map((text) => JSON.parse(text));
  await withNow(T0, () => doInstance.alarm());
  await fake.flush();
  // The host hides the tab at T0: seat suspended, socket stays open,
  // heartbeats stop. No grace — tab-hidden never starts one.
  doInstance.store.suspendSeat(ids.h1, 'tab-hidden', T0);
  assert.equal(doInstance.store.state.hostGrace, null, 'a tab-hidden host starts no grace');
  // 95 s of heartbeat silence with the socket open: the heartbeat
  // loop must SKIP the seat (its pause is expected), not close 1011
  // + suspend 'heartbeat-timeout' and start a grace.
  await withNow(T0 + 95_000, async () => {
    refreshLive(T0 + 95_000);
    await doInstance.alarm();
  });
  await fake.flush();
  assert.equal(hostTabSocket.closed.length, 0, 'the hidden host socket must not be closed 1011');
  assert.equal(hostSocket.closed.length, 0, 'the hidden host socket must not be closed 1011');
  assert.equal(doInstance.store.state.hostGrace, null, 'no grace may start while the host is merely hidden');
  assert.equal(doInstance.store.room.hostPlayerId, ids.h1, 'the hidden host must keep the crown at 95 s');
  assert.equal(
    doInstance.store.player(ids.h1).connectionState,
    'suspended',
    'the hidden host stays suspended, not removed',
  );
  assert.equal(
    doInstance.sessions.get(`${ids.h1}:tab-${ids.h1}`).lastHeartbeatAtMs,
    T0 + 95_000,
    'the skip must reset the hidden seat heartbeat clock instead of timing it out',
  );
  // Another 105 s of silence (200 s hidden in total — past the old
  // ~91-120 s transfer point): still no grace, still host.
  await withNow(T0 + 200_000, async () => {
    refreshLive(T0 + 200_000);
    await doInstance.alarm();
  });
  await fake.flush();
  assert.equal(hostTabSocket.closed.length, 0, 'the hidden host socket must still not be closed 1011');
  assert.equal(doInstance.store.state.hostGrace, null, 'no grace may start after 200 s hidden either');
  assert.equal(doInstance.store.room.hostPlayerId, ids.h1, 'the hidden host must keep the crown at 200 s');
  // THEN the host's network really dies: the socket closes. That is
  // 'network-lost', which MUST still start the grace (v24 F1) and
  // transfer at expiry — the fix preserves this path.
  let endsAt;
  await withNow(T0 + 200_000, async () => {
    fake.sockets.delete(ids.h1);
    fake.sockets.delete(`tab:tab-${ids.h1}`);
    await doInstance.webSocketClose({}, 1006, '', false);
  });
  await fake.flush();
  endsAt = doInstance.store.state.hostGrace?.endsAtMs;
  assert.ok(typeof endsAt === 'number', 'the network loss must start a host grace');
  assert.equal(endsAt, T0 + 200_000 + 30_000, 'the grace deadline must be 30 s after the socket close');
  assert.equal(doInstance.store.room.hostPlayerId, ids.h1, 'the grace must not transfer before its deadline');
  // The deadline tick transfers to the earliest-joined connected
  // successor (r1).
  await withNow(endsAt, async () => {
    refreshLive(endsAt);
    await doInstance.alarm();
  });
  await fake.flush();
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.hostPlayerId, ids.r1, 'the grace expiry must transfer host to r1');
  assert.equal(stored.hostGrace, null, 'the grace is gone after the transfer');
  const transfers = sentEvents(witness).filter((e) => e.type === 'host.transferred');
  assert.equal(transfers.length, 1, 'exactly one host.transferred must be delivered');
  assert.equal(transfers[0].payload.newHostPlayerId, ids.r1);
});
