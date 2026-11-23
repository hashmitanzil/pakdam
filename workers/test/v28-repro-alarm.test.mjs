import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomDO } = await import('../src/room-do-class.ts');
const { RoomStore, emptyMemory, STATE_KEY, ABANDONED_IDLE_MS } = await import('../src/room-do.ts');
const sharedNs = await import('@pakdam/shared');
const { DEFAULT_ROOM_CONFIG } = sharedNs;

// The DO tests run with a Supabase that answers OK (copied from
// v23-host-rules-do.test.mjs: persist intents no-op best-effort).
globalThis.fetch = async () => ({ ok: true });

/**
 * v28-repro-alarm.test.mjs — RED reproduction tests for the Cloudflare
 * Durable Objects cap (Arjun, QA).
 *
 * FOUNDER SYMPTOM (2026-11-22): the 90% email — 90,000 of the
 * 100,000/day free DO requests used, though nobody played that day.
 *
 * TWO defects, pinned here against the REAL production code
 * (`RoomStore.alarmTick` + `RoomDO.alarm` / `armAlarm`):
 *
 *  (1) A LIVE room ticks at 1 s even when NOBODY is connected.
 *      `alarmDelayMs` (room-do-class.ts) returns 1000 for
 *      HEAD_START / ACTIVE / SAFETY_PAUSED on phase alone — it never
 *      looks at whether any socket is attached. One live room =
 *      86,400 alarm invocations/day, plus a phone left on the play
 *      screen sending ~1 GPS fix/s. At 100% the DO errors until the
 *      00:00 UTC reset.
 *  (2) An ABANDONED live room never reaches a terminal phase.
 *      `alarmTick` step (4a) EXEMPTS suspended seats from the
 *      missing-fix ejection, and step (3) never completes a match
 *      while SAFETY_PAUSED — so a room whose players all disconnected
 *      (suspended, not left) sits live forever: in SAFETY_PAUSED it
 *      can never complete even after `endsAt` passes, and in ACTIVE
 *      it stays live until `endsAt` with nobody watching. There is
 *      no abandonment edge for "zero connected seats for a long
 *      time".
 *
 * LANDED STATE (re-checked during the verification run — all 6
 * tests in this file now pass):
 *  - (1) LANDED (Kabir): `alarmDelayMs` is attendance-based —
 *    live + running host grace → 1 s; live + ≥1 live socket → 1 s;
 *    live + no socket + no grace → 30 s. The class stamps the
 *    durable `noSocketsSinceMs` idle clock on the first no-socket
 *    tick; a running grace DEFERS the clock (F10).
 *  - (2) LANDED (Kabir, built IN RESPONSE TO this repro — the
 *    store rule at room-do.ts:3653-3656 cites "Arjun repro, Diya
 *    F8 / F11"): the store ALSO ends a room whose seats are all
 *    suspended, even without socket knowledge — every non-left seat
 *    suspended for at least `ABANDONED_IDLE_MS` (10 min), measured
 *    from the MOST RECENT disconnect (`mem.lastDisconnectAtMs`,
 *    stamped by `suspendSeat`). The class's durable idle clock is
 *    the primary trigger in production; the store rule is the
 *    backstop for a room whose seats are all suspended in memory.
 *    A seat with no recorded disconnect time cannot prove the
 *    bound — the rule skips and the class clock decides.
 *  - BOUND (landed): `ABANDONED_IDLE_MS` = 10 min. It MUST exceed
 *    the founder's 2-minute seat hold (MEMORY.md 2026-11-22: a tab
 *    switch / phone call holds the seat for 2 min; after 2 min the
 *    seat counts as left) — 10 min clears that by 5×. The ACTIVE
 *    test below pins the bound precisely (still ACTIVE at
 *    9m59s, ABANDONED at 10m00s). If the founder wants a shorter /
 *    longer bound, this number is the thing to change, not the
 *    shape of the test.
 *
 * Harness mirrors v18-server.test.mjs (store direct, no DO ctx) and
 * v23-host-rules-do.test.mjs (real RoomDO + fake storage/ctx).
 * `Date.now` is mocked around the class-level `alarm()` calls
 * exactly like the v24 gap test in host-cancel-succession.test.mjs.
 */

const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

// ---------------------------------------------------------------------------
// Store harness (mirrors v18-server.test.mjs makeStore).
// ---------------------------------------------------------------------------

function storePlayer(playerId, displayName, isHost = false) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole: null,
    team: null,
    reconnectTokenHash: '',
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

function makeStore({ hunters = ['hu1'], runners = ['r1'], durationSeconds = 3600 } = {}) {
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
  const players = [
    storePlayer('h1', 'Host', true),
    ...hunters.map((id, i) => storePlayer(id, `Hunter ${i + 1}`)),
    ...runners.map((id, i) => storePlayer(id, `Runner ${i + 1}`)),
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
  };
  return new RoomStore(state, emptyMemory());
}

function start(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `startMatch must succeed: ${r.ok ? '' : r.error}`);
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

function suspendAll(store, reason, nowMs) {
  for (const p of ['h1', 'hu1', 'r1']) {
    store.suspendSeat(p, reason, nowMs);
  }
}

// ---------------------------------------------------------------------------
// DO-class harness (mirrors v23-host-rules-do.test.mjs).
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

function stateFor(phase = 'ACTIVE') {
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
  const live = phase !== 'LOBBY';
  return {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase,
      version: 1,
      config,
      createdAt: new Date(Date.now() - 5000).toISOString(),
      startedAt: live ? new Date(T0).toISOString() : null,
      endsAt: live ? new Date(T0 + 3600_000).toISOString() : null,
      pausedAt: null,
      result: null,
    },
    players: [
      doPlayer('h1', 'Host', true, T0 - 5000, live ? 'runner' : null),
      doPlayer('r1', 'Runner 1', false, T0 - 4000, live ? 'runner' : null),
      doPlayer('hu1', 'Hunter 1', false, T0 - 2000, live ? 'hunter' : null),
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

async function seedRoom(fake, phase = 'ACTIVE') {
  await fake.storage.put(STATE_KEY, stateFor(phase));
  for (const id of ['h1', 'r1', 'hu1']) {
    await fake.storage.put(`session:${id}:tab-${id}`, sessionFor(id, `tab-${id}`));
  }
}

// ---------------------------------------------------------------------------
// (1) A live room with no sockets attached still ticks at 1 s.
// ---------------------------------------------------------------------------

test('v28 (landed — attendance-based cadence): a live room with NO sockets attached must NOT re-arm its alarm at 1 s', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  await seedRoom(fake, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, env);
  // NO sockets attached for any seat — nobody is connected, nobody
  // is watching, yet the room is live. (Sessions exist in storage
  // from the seed, but getWebSockets() returns [] for every tag.)
  const realNow = Date.now;
  const tickAt = T0 + 5000;
  Date.now = () => tickAt;
  try {
    await doInstance.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  assert.ok(
    fake.storage.alarmsSet.length > 0 || fake.storage.alarmsDeleted > 0,
    'the tick must re-arm or delete the alarm (one of the two must happen)',
  );
  if (fake.storage.alarmsSet.length > 0) {
    const lastSet = fake.storage.alarmsSet[fake.storage.alarmsSet.length - 1];
    const delayMs = lastSet - tickAt;
    assert.ok(
      delayMs > 1000,
      `with zero sockets attached the live alarm must slow down (or be deleted), not re-arm at 1 s — re-armed at +${delayMs} ms (86,400/day at 1 s is the DO-cap burn)`,
    );
  }
});

test('v28 (landed — attendance-based cadence): the 1 s tick slows down on its own — three socket-less ticks all re-arm at 30 s (or delete)', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  await seedRoom(fake, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, env);
  const realNow = Date.now;
  const delays = [];
  try {
    for (let i = 0; i < 3; i++) {
      const tickAt = T0 + 5000 + i * 1000;
      Date.now = () => tickAt;
      fake.storage.alarmsSet.length = 0;
      fake.storage.alarmsDeleted = 0;
      await doInstance.alarm();
      await fake.flush();
      if (fake.storage.alarmsSet.length > 0) {
        delays.push(fake.storage.alarmsSet[fake.storage.alarmsSet.length - 1] - tickAt);
      } else {
        delays.push(null); // alarm deleted — the fixed behaviour
      }
    }
  } finally {
    Date.now = realNow;
  }
  assert.ok(
    delays.every((d) => d === null || d > 1000),
    `three socket-less live ticks must all slow down or delete the alarm — got delays ${JSON.stringify(delays)} ms`,
  );
});

// ---------------------------------------------------------------------------
// (2) An abandoned live room never reaches a terminal phase.
// ---------------------------------------------------------------------------

test('v28 (landed — store abandon rule): a SAFETY_PAUSED room with NOBODY connected reaches a terminal phase, even after endsAt passes', async () => {
  const store = makeStore({ durationSeconds: 3600 });
  start(store, T0);
  // Everyone is sending fixes, then the host pauses for safety.
  await sendFix(store, 'h1', T0 + 1000);
  await sendFix(store, 'hu1', T0 + 1000);
  await sendFix(store, 'r1', T0 + 1000);
  const paused = await store.handleWsMessage(
    { playerId: 'h1', sessionId: 's1' },
    { type: 'safety.pause', commandId: 'pause-1', payload: {} },
    T0 + 2000,
  );
  assert.equal(
    paused.events.some((e) => e.type === 'error'),
    false,
    'the safety pause must succeed',
  );
  assert.equal(store.room.phase, 'SAFETY_PAUSED');
  // Then EVERYONE disconnects (network lost — not a leave) and never
  // comes back. endsAt is T0 + 3600 s; tick an hour past it.
  suspendAll(store, 'network-lost', T0 + 5000);
  const tick = store.alarmTick(T0 + 3600_000 + 60_000, { liveSocketCount: 0 });
  assert.equal(
    tick.events.some((e) => e.type === 'error'),
    false,
    'the abandoned tick must not error',
  );
  assert.ok(
    ['COMPLETED', 'ABANDONED', 'CANCELLED', 'EXPIRED'].includes(store.room.phase),
    `a paused match with zero connected seats, 60 s past endsAt, must reach a terminal phase — still ${store.room.phase} (step (3) never completes while paused, and nobody can resume it)`,
  );
});

test('v28 (landed — store abandon rule, bound pinned): an ACTIVE room with NOBODY connected abandons at exactly ABANDONED_IDLE_MS (10 min) after the last disconnect — still ACTIVE at 9m59s', () => {
  const store = makeStore({ durationSeconds: 3600 });
  start(store, T0);
  // Everyone disconnects 5 s in and never returns; no fixes at all
  // after that. endsAt is T0 + 3600 s (60 min) — the room must NOT
  // burn 1 s ticks for the whole hour with nobody in it.
  suspendAll(store, 'network-lost', T0 + 5000);
  // 1 s before the bound: the rule must NOT fire yet — the room
  // is still live (a seat that comes back at 9m59s is still a
  // player, not an abandoned room).
  const early = store.alarmTick(T0 + 5000 + ABANDONED_IDLE_MS - 1000, { liveSocketCount: 0 });
  assert.equal(
    early.events.some((e) => e.type === 'error'),
    false,
    'the pre-bound tick must not error',
  );
  assert.equal(
    store.room.phase,
    'ACTIVE',
    `at ABANDONED_IDLE_MS - 1 s the room must still be ACTIVE — got ${store.room.phase}`,
  );
  // Exactly at the bound: the store rule fires (every seat
  // suspended for the full window, measured from the most recent
  // disconnect at T0 + 5000).
  const tick = store.alarmTick(T0 + 5000 + ABANDONED_IDLE_MS, { liveSocketCount: 0 });
  assert.equal(
    tick.events.some((e) => e.type === 'error'),
    false,
    'the abandoned tick must not error',
  );
  assert.equal(
    store.room.phase,
    'ABANDONED',
    `an ACTIVE room with zero connected seats for ABANDONED_IDLE_MS must abandon — still ${store.room.phase} (suspended seats are exempt from the (4a) missing-fix ejection, so nothing else ends it before endsAt)`,
  );
});

// ---------------------------------------------------------------------------
// v28 fix round (Zara R1) — the store abandon rule must agree with the
// class rule's invariant ("Only a room with NO live socket at all
// accrues idle time"): it fires only when the class reports zero live
// sockets, never while a socket is attached, never on unknown
// attendance.
// ---------------------------------------------------------------------------

test('v28 fix round (Zara R1 — store): all-suspended seats WITH a live socket attached are NOT abandoned past the window; zero sockets abandons; unknown attendance fails closed', () => {
  const store = makeStore({ durationSeconds: 3600 });
  start(store, T0);
  // Everyone hides the tab 5 s in (sockets stay open — a hidden /
  // GPS-denied suspension keeps the transport alive) and stays away.
  suspendAll(store, 'tab-hidden', T0 + 5000);
  // Past the window WITH a live socket attached: the room must NOT
  // abandon under attached players.
  const withSocket = store.alarmTick(T0 + 5000 + ABANDONED_IDLE_MS, { liveSocketCount: 1 });
  assert.equal(
    withSocket.events.some((e) => e.type === 'error'),
    false,
    'the with-socket tick must not error',
  );
  assert.equal(
    store.room.phase,
    'ACTIVE',
    `all seats suspended for the full window but WITH a live socket attached must stay ACTIVE — got ${store.room.phase} (the store rule must agree with the class rule: only a room with NO live socket at all accrues idle time)`,
  );
  // No socket observation at all (a direct store caller that cannot
  // see sockets): fail closed — the rule must not fire on unknown
  // attendance. The class's durable clock still ends a genuinely
  // empty room.
  const unknown = store.alarmTick(T0 + 5000 + ABANDONED_IDLE_MS + 1000);
  assert.equal(
    unknown.events.some((e) => e.type === 'error'),
    false,
    'the unknown-attendance tick must not error',
  );
  assert.equal(
    store.room.phase,
    'ACTIVE',
    `with no live-socket observation the rule must fail closed — got ${store.room.phase}`,
  );
  // The same tick with zero live sockets abandons, as before.
  const none = store.alarmTick(T0 + 5000 + ABANDONED_IDLE_MS + 2000, { liveSocketCount: 0 });
  assert.equal(
    none.events.some((e) => e.type === 'error'),
    false,
    'the zero-socket tick must not error',
  );
  assert.equal(
    store.room.phase,
    'ABANDONED',
    `the same room with zero live sockets must abandon — still ${store.room.phase}`,
  );
});

// ---------------------------------------------------------------------------
// PINs (pass pre-fix — behaviour the v28 fix must NOT break).
// ---------------------------------------------------------------------------

test('v28 PIN (passes pre-fix — must keep passing): a hidden tab is NOT ejected for silence — suspension exempts a seat from the (4a) missing-fix ejection', async () => {
  const store = makeStore({ durationSeconds: 3600 });
  start(store, T0);
  // The hunter and host keep sending fixes; the runner hides the tab
  // (suspended 'tab-hidden') 2 s in and stays silent.
  await sendFix(store, 'h1', T0 + 1000);
  await sendFix(store, 'hu1', T0 + 1000);
  store.suspendSeat('r1', 'tab-hidden', T0 + 2000);
  // 60 s of silence from the hidden runner, with the others live.
  await sendFix(store, 'h1', T0 + 30_000);
  await sendFix(store, 'hu1', T0 + 30_000);
  await sendFix(store, 'h1', T0 + 60_000);
  await sendFix(store, 'hu1', T0 + 60_000);
  store.alarmTick(T0 + 62_000);
  const runner = store.room.phase === 'ACTIVE' ? store.player('r1') : null;
  assert.ok(runner, 'the room must still be ACTIVE (nobody completed it)');
  assert.equal(runner.ejectedAt, null, 'a tab-hidden seat must not be ejected for silence');
  assert.equal(
    runner.connectionState,
    'suspended',
    'the hidden seat stays suspended, not removed',
  );
  assert.equal(store.player('h1').ejectedAt, null, 'a live seat with fresh fixes is not ejected');
});

test('v28 PIN (passes pre-fix — must keep passing): a terminal phase deletes the alarm', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  await seedRoom(fake, 'COMPLETED');
  const doInstance = new RoomDO(fake.ctx, env);
  const realNow = Date.now;
  Date.now = () => T0 + 5000;
  try {
    await doInstance.alarm();
  } finally {
    Date.now = realNow;
  }
  await fake.flush();
  assert.equal(
    fake.storage.alarmsSet.length,
    0,
    'a terminal room must not set a new alarm',
  );
  assert.ok(
    fake.storage.alarmsDeleted >= 1,
    'a terminal room must delete the pending alarm',
  );
});
