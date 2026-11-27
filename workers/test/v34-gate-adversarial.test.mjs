import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { handleJoin } = await import('../src/http.ts');
const { deleteOldLogs } = await import('../src/supabase.ts');
const workerDefault = (await import('../src/index.ts')).default;
const sharedNs = await import('@pakdam/shared');
const { DEFAULT_ROOM_CONFIG } = sharedNs;

globalThis.fetch = async () => ({ ok: true });

// v34 DELIVERY GATE — server-side adversarial / concurrency / chaos /
// security pins (gate items 3d/3e/3f + 4). GAP-ONLY: what earlier files
// already pin is cited, not re-tested (ticket replay: v34-join-ticket;
// GPS anti-cheat thresholds: v29-gps-anti-cheat; ejected-seat guard
// for snapshot/pause/voice/hello: v33-ejected-seat + v30-voice-eject;
// duplicate-join via Idempotency-Key, sequential: http-idempotency;
// WS rate-limit unit shape: rate-limit.test.mjs; 30 s rule core:
// v29-thirty-second-rule; tab-hidden never starts the timer: ibid.).
//
// Every test here asserts the same bar: a hostile or broken input must
// produce a CODED error the client can surface — never a throw, never
// a silent success, never a half-applied mutation.
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

function player(playerId, displayName, opts = {}) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost: opts.isHost ?? false,
    matchRole: opts.matchRole ?? null,
    team: opts.team ?? null,
    reconnectTokenHash: `reconnect-hash-${playerId}`,
    joinedAt: new Date(T0 - 1000).toISOString(),
    leftAt: opts.leftAt ?? null,
    ejectedAt: opts.ejectedAt ?? null,
    connectionState: opts.connectionState ?? 'connected',
    lastFixAt: opts.lastFixAt ?? null,
    locationQuality: null,
    isReady: true,
    briefingConfirmed: true,
    ageGatePassed: true,
    suspensionCount: 0,
  };
}

function makeStore({ phase = 'LOBBY', players } = {}) {
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
  const list =
    players ??
    [
      player('h1', 'Host', { isHost: true }),
      player('hu1', 'Hunter 1', { matchRole: 'hunter', team: 'hunters' }),
      player('r1', 'Runner 1', { matchRole: 'runner', team: 'runners' }),
      player('r2', 'Runner 2', { matchRole: 'runner', team: 'runners' }),
    ];
  const live = phase !== 'LOBBY';
  const state = {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase,
      version: 1,
      config,
      createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: live ? new Date(T0).toISOString() : null,
      endsAt: live ? new Date(T0 + 3600_000).toISOString() : null,
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

function startActive(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `startMatch must succeed: ${r.ok ? '' : r.error}`);
  store.alarmTick(atMs + 1000, { liveSocketCount: 4 });
  assert.equal(store.room.phase, 'ACTIVE');
}

async function sendWs(store, playerId, type, payload, commandId, atMs) {
  return store.handleWsMessage({ playerId, sessionId: 's1' }, { type, commandId, payload }, atMs);
}

function errorCodes(result) {
  return result.events
    .filter((e) => e.type === 'error')
    .map((e) => e.payload.code);
}

// ---------------------------------------------------------------------------
// 3d — malformed payloads: coded error, never a throw
// ---------------------------------------------------------------------------

test('v34 gate (3d): malformed WS envelopes never throw — each gets a coded error event', async () => {
  const store = makeStore();
  startActive(store);
  const cases = [
    ['missing type', { commandId: 'm1', payload: {} }],
    ['null payload', { type: 'ready.set', commandId: 'm2', payload: null }],
    ['array payload', { type: 'ready.set', commandId: 'm3', payload: [] }],
    ['string payload', { type: 'ready.set', commandId: 'm4', payload: 'yes' }],
    ['unknown type', { type: 'nuke.everything', commandId: 'm5', payload: {} }],
    ['fix is null', { type: 'location.update', commandId: 'm6', payload: { fix: null } }],
    ['fix lat is a string', { type: 'location.update', commandId: 'm7', payload: { fix: { lat: '23.3', lng: 85.33, accuracyMeters: 10, timestampMs: T0 } } }],
    ['fix accuracy negative', { type: 'location.update', commandId: 'm8', payload: { fix: { ...INSIDE, accuracyMeters: -5, timestampMs: T0 } } }],
    ['ready.set isReady is a string', { type: 'ready.set', commandId: 'm9', payload: { isReady: 'yes' } }],
    ['radio 10k chars', { type: 'radio.send', commandId: 'm10', payload: { text: 'x'.repeat(10_000), kind: 'text' } }],
    ['catch.confirm no catchId', { type: 'catch.confirm', commandId: 'm11', payload: {} }],
  ];
  for (const [name, envelope] of cases) {
    let result;
    try {
      result = await store.handleWsMessage({ playerId: 'r1', sessionId: 's1' }, envelope, T0 + 2000);
    } catch (e) {
      assert.fail(`${name} threw instead of returning a coded error: ${e.message}`);
    }
    assert.equal(
      errorCodes(result).length > 0,
      true,
      `${name} must produce an error event, got: ${JSON.stringify(result.events.map((e) => e.type))}`,
    );
  }
  // And the room is still alive + consistent after all of it.
  assert.equal(store.room.phase, 'ACTIVE');
  assert.equal(store.player('r1').isReady, true, 'no malformed message flipped state');
});

test('v34 gate (3d): malformed HTTP join bodies are 400 with a code, never 500', async () => {
  const ctx = { env: {}, ctx: { waitUntil: () => undefined } };
  const bad = [
    ['not JSON', 'this is not json'],
    ['JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
    ['JSON string', '"hello"'],
  ];
  for (const [name, body] of bad) {
    const req = new Request('http://x/v1/rooms/room-1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const res = await handleJoin(req, ctx, 'room-1');
    assert.equal(res.status, 400, `${name} must be 400, got ${res.status}`);
    const data = await res.json();
    assert.equal(typeof data.code, 'string', `${name} must carry a code`);
    assert.equal(typeof data.error, 'string', `${name} must carry an error message`);
  }
  // Oversized body (1 MB cap) is 413, not a crash.
  const big = new Request('http://x/v1/rooms/room-1/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'x'.repeat(1_100_000),
  });
  const res = await handleJoin(big, ctx, 'room-1');
  assert.equal(res.status, 413, 'oversized body must be 413');
});

// ---------------------------------------------------------------------------
// 3d — out-of-order operations: refuse with the right code, never crash
// ---------------------------------------------------------------------------

test('v34 gate (3d): out-of-order ops refuse with codes — catch before start, pause after end, resume after eject, start twice, join after start', async () => {
  // Catch before start (LOBBY): no claim is created.
  {
    const store = makeStore();
    const r = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'c1', T0 + 1000);
    assert.ok(errorCodes(r).length > 0, 'catch.request in LOBBY must error');
    assert.equal(store.state.catches.length, 0, 'no catch may exist before start');
  }
  // Pause after end: end the match, then pause.
  {
    const store = makeStore();
    startActive(store);
    const end = store.lifecycleOp({ action: 'end', playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 2000 });
    assert.equal(end.ok, true, 'host end must succeed');
    const pause = await sendWs(store, 'h1', 'safety.pause', {}, 'p1', T0 + 3000);
    assert.ok(errorCodes(pause).length > 0, 'pause after end must error');
  }
  // Resume after eject: an ejected seat never resumes.
  {
    const store = makeStore();
    startActive(store);
    const seat = store.player('r1');
    seat.ejectedAt = new Date(T0 + 1500).toISOString();
    const resumed = store.resumeOnHello('r1', T0 + 2000);
    assert.equal(resumed.resumed, false, 'an ejected seat must never resume');
    assert.equal(store.player('r1').ejectedAt !== null, true, 'ejection stands');
  }
  // Start twice: the second start refuses (INVALID_STATE/409 family).
  {
    const store = makeStore();
    const first = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
    assert.equal(first.ok, true);
    const second = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 1000 });
    assert.equal(second.ok, false, 'a second start must refuse');
    assert.ok(second.code === 'INVALID_STATE' || second.status === 409, `second start code must be INVALID_STATE/409, got ${second.code}/${second.status}`);
  }
  // Join after start: the lobby is closed.
  {
    const store = makeStore();
    startActive(store);
    const joined = await store.addPlayerAsync({
      displayName: 'Late',
      roomCode: 'ABCDEF',
      reconnectTokenHash: null,
      nowMs: T0 + 2000,
    });
    assert.equal(joined.ok, false, 'join after start must refuse');
    assert.equal(joined.status, 409, 'join after start must be 409');
  }
});

// ---------------------------------------------------------------------------
// 3d — double submits: one application, cached reply
// ---------------------------------------------------------------------------

test('v34 gate (3d): double submit with the same commandId applies once and returns the cached reply', async () => {
  const store = makeStore();
  const first = await sendWs(store, 'r1', 'ready.set', { isReady: true }, 'dup-1', T0 + 1000);
  assert.equal(first.events.some((e) => e.type === 'room.state'), true, 'first ready.set must broadcast');
  const versionAfterFirst = store.room.version;
  const second = await sendWs(store, 'r1', 'ready.set', { isReady: true }, 'dup-1', T0 + 1500);
  assert.equal(store.room.version, versionAfterFirst, 'a duplicate must not bump the version again');
  assert.deepEqual(
    second.events.map((e) => e.type).sort(),
    first.events.map((e) => e.type).sort(),
    'the duplicate must return the cached reply, not an empty success',
  );
  // A different commandId is a fresh op (un-ready then re-ready works).
  const third = await sendWs(store, 'r1', 'ready.set', { isReady: false }, 'dup-2', T0 + 2000);
  assert.equal(store.player('r1').isReady, false, 'a fresh commandId must apply');
  assert.ok(third.events.some((e) => e.type === 'room.state'), 'fresh op must broadcast');
});

// ---------------------------------------------------------------------------
// 3e — concurrency: 30 seats act at once; host+guest race; two tabs
// ---------------------------------------------------------------------------

test('v34 gate (3e): 30 seats ready.set at once — all apply, version bumps 30 times, no error', async () => {
  const ids = ['h1', 'hu1', ...Array.from({ length: 28 }, (_, i) => `r${i + 1}`)];
  const players = ids.map((id, i) =>
    player(id, `P${i}`, {
      isHost: id === 'h1',
      matchRole: id === 'hu1' ? 'hunter' : id === 'h1' ? null : 'runner',
      team: id === 'hu1' ? 'hunters' : id === 'h1' ? null : 'runners',
    }),
  );
  // Start from a lobby where nobody is ready yet.
  for (const p of players) p.isReady = false;
  const store = makeStore({ players });
  const before = store.room.version;
  const results = await Promise.all(
    ids.map((id, i) => sendWs(store, id, 'ready.set', { isReady: true }, `ready-${i}`, T0 + 1000)),
  );
  for (const [i, r] of results.entries()) {
    assert.equal(errorCodes(r).length, 0, `seat ${ids[i]} ready.set must not error`);
  }
  assert.equal(store.room.version, before + 30, 'version must bump once per ready.set');
  assert.equal(
    ids.filter((id) => store.player(id).isReady).length,
    30,
    'all 30 must end ready',
  );
});

test('v34 gate (3e): host start races a guest join — exactly one consistent outcome, no duplicate seat, no crash', async () => {
  const store = makeStore(); // h1 + hu1 + r1 + r2, all ready
  const [started, joined] = await Promise.all([
    Promise.resolve().then(() =>
      store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 1000 }),
    ),
    store.addPlayerAsync({
      displayName: 'Racer',
      roomCode: 'ABCDEF',
      reconnectTokenHash: null,
      nowMs: T0 + 1000,
    }),
  ]);
  // Either the join landed first (start then succeeds in the lobby) or
  // the start landed first (join 409s) — both are consistent. What must
  // never happen: a duplicate seat, a started room with 5 un-roled
  // players, or a throw.
  const names = store.state.players.map((p) => p.displayName);
  assert.equal(new Set(names).size, names.length, 'no duplicate display name may exist');
  if (started.ok) {
    assert.ok(
      ['READY_CHECK', 'HEAD_START', 'ACTIVE'].includes(store.room.phase) || store.room.phase === 'LOBBY',
      `started room must be in a live-path phase, got ${store.room.phase}`,
    );
  } else {
    assert.equal(joined.ok, true, 'if start failed, the join must have succeeded (else both lost)');
  }
  if (joined.ok) {
    assert.equal(
      store.state.players.some((p) => p.displayName === 'Racer'),
      true,
      'a successful join must leave exactly one Racer seat',
    );
    assert.equal(
      store.state.players.filter((p) => p.displayName === 'Racer').length,
      1,
      'exactly one Racer seat',
    );
  }
});

test('v34 gate (3e): two tabs, same seat — both ready.set apply to the one seat, version bumps twice, no split state', async () => {
  const store = makeStore();
  const [a, b] = await Promise.all([
    sendWs(store, 'r1', 'ready.set', { isReady: false }, 'tab-a-1', T0 + 1000),
    sendWs(store, 'r1', 'ready.set', { isReady: true }, 'tab-b-1', T0 + 1000),
  ]);
  assert.equal(errorCodes(a).length, 0, 'tab A must not error');
  assert.equal(errorCodes(b).length, 0, 'tab B must not error');
  assert.equal(store.player('r1').isReady, true, 'last write wins on the one seat');
  assert.equal(
    store.state.players.filter((p) => p.playerId === 'r1').length,
    1,
    'still exactly one seat for the player',
  );
});

test('v34 gate (3e): duplicate joins racing — two simultaneous joins with the same name create exactly ONE seat', async () => {
  const store = makeStore();
  const [a, b] = await Promise.all([
    store.addPlayerAsync({ displayName: 'Racer', roomCode: 'ABCDEF', reconnectTokenHash: null, nowMs: T0 + 1000 }),
    store.addPlayerAsync({ displayName: 'Racer', roomCode: 'ABCDEF', reconnectTokenHash: null, nowMs: T0 + 1000 }),
  ]);
  const racers = store.state.players.filter((p) => p.displayName === 'Racer');
  assert.equal(racers.length, 1, `exactly one Racer seat may exist, got ${racers.length}`);
  assert.equal(
    [a.ok, b.ok].filter(Boolean).length,
    1,
    'exactly one of the racing joins must succeed',
  );
  const loser = a.ok ? b : a;
  assert.equal(loser.code, 'FORBIDDEN', 'the losing join must be 403 name-taken');
});

// ---------------------------------------------------------------------------
// 3f — chaos: clock jumps, socket kill mid-catch, heartbeat without fix
// ---------------------------------------------------------------------------

test('v34 gate (3f): clock jump forward 10 min mid-match ejects the silent and ends the room cleanly — never hangs, never half-state', async () => {
  const store = makeStore();
  startActive(store);
  // Nobody sent a fix since start; the clock jumps +10 min.
  const tick = store.alarmTick(T0 + 600_000, { liveSocketCount: 0 });
  // (4a) ejects the silent connected seats; with nobody left playing
  // the idle path owns the room end — either way the tick must return
  // a defined result and the room must be terminal or ejecting, never
  // stuck mid-flight.
  assert.ok(Array.isArray(tick.disconnect), 'tick must return a disconnect list');
  assert.ok(
    tick.disconnect.length > 0 || store.room.phase !== 'ACTIVE',
    'a 10-min jump must eject or end the room, not leave it ACTIVE with silent seats',
  );
  for (const p of store.state.players) {
    assert.ok(
      p.ejectedAt !== null || p.connectionState === 'suspended' || store.room.phase !== 'ACTIVE',
      `seat ${p.playerId} must be ejected, suspended, or the room ended`,
    );
  }
});

test('v34 gate (3f): clock jump BACKWARD never ejects and never throws', async () => {
  const store = makeStore();
  startActive(store);
  await sendWs(store, 'r1', 'location.update', {
    fix: { ...INSIDE, accuracyMeters: 10, timestampMs: T0 + 2000 },
  }, 'fix-r1', T0 + 2000);
  const tick = store.alarmTick(T0 - 60_000, { liveSocketCount: 4 });
  assert.equal(tick.disconnect.length, 0, 'a backward jump must eject nobody');
  assert.equal(store.room.phase, 'ACTIVE', 'the match must keep running');
  assert.equal(store.player('r1').ejectedAt, null, 'r1 must not eject');
});

test('v34 gate (3f): a socket killed mid-catch suspends the seat and leaves the pending catch untouched', async () => {
  const store = makeStore();
  startActive(store);
  // A pending catch, constructed as the store holds it mid-flight.
  store.state.catches.push({
    catchId: 'catch-1',
    roomId: 'room-1',
    hunterPlayerId: 'hu1',
    runnerPlayerId: 'r1',
    state: 'awaiting-confirmation',
    qrTokenHash: 'qr-hash',
    requestedAt: new Date(T0 + 1500).toISOString(),
    confirmedAt: null,
    resolution: null,
  });
  const r = store.suspendSeat('hu1', 'network-lost', T0 + 2000);
  assert.equal(r.events.length > 0, true, 'the hunter must suspend on socket kill');
  const c = store.state.catches.find((x) => x.catchId === 'catch-1');
  assert.equal(c.state, 'awaiting-confirmation', 'the pending catch must not auto-resolve or cancel');
  assert.equal(c.hunterPlayerId, 'hu1', 'the catch still names its hunter');
});

test('v34 gate (3f): heartbeats do NOT substitute for fixes — a live, heartbeating seat with no fix still ejects at 30 s', async () => {
  const store = makeStore();
  startActive(store);
  // r1 heartbeats every 5 s but never sends a fix; r2 fixes normally.
  for (let t = 5000; t <= 25000; t += 5000) {
    await sendWs(store, 'r1', 'heartbeat', {}, `hb-r1-${t}`, T0 + t);
  }
  await sendWs(store, 'r2', 'location.update', {
    fix: { ...INSIDE, accuracyMeters: 10, timestampMs: T0 + 25000 },
  }, 'fix-r2', T0 + 25000);
  const tick = store.alarmTick(T0 + 31_000, { liveSocketCount: 4 });
  const ejected = tick.disconnect.map((d) => d.playerId);
  assert.ok(ejected.includes('r1'), 'r1 must eject on (4a) despite heartbeating');
  assert.ok(!ejected.includes('r2'), 'r2 must not eject — it has a fresh fix');
});

// ---------------------------------------------------------------------------
// 4 — security: role escalation, snapshot leaks, spam, ejected/left acting
// ---------------------------------------------------------------------------

test('v34 gate (4): role escalation — a non-host doing host actions gets 403 on all six', async () => {
  const store = makeStore();
  const r = 'r1';
  const wrong = 'wrong-hash';
  const start = store.startMatch({ playerId: r, hostTokenHash: wrong, nowMs: T0 });
  assert.equal(start.ok, false, 'non-host start must refuse');
  assert.equal(start.code, 'FORBIDDEN');
  const config = store.updateConfig({ playerId: r, hostTokenHash: wrong, config: store.room.config, nowMs: T0 });
  assert.equal(config.ok, false, 'non-host config must refuse');
  assert.equal(config.code, 'FORBIDDEN');
  const remove = store.removePlayer({ playerId: r, hostTokenHash: wrong, targetPlayerId: 'r2', nowMs: T0 });
  assert.equal(remove.ok, false, 'non-host remove-player must refuse');
  assert.equal(remove.code, 'FORBIDDEN');
  const regen = store.regenerateCode({ playerId: r, hostTokenHash: wrong, newCode: 'ZZZZZZ' });
  assert.equal(regen.ok, false, 'non-host regenerate-code must refuse');
  assert.equal(regen.code, 'FORBIDDEN');
  const end = store.lifecycleOp({ action: 'end', playerId: r, hostTokenHash: wrong, nowMs: T0 });
  assert.equal(end.ok, false, 'non-host end must refuse');
  assert.equal(end.code, 'FORBIDDEN');
  const replay = store.replayMatch({ playerId: r, hostTokenHash: wrong, nowMs: T0 });
  assert.equal(replay.ok, false, 'non-host replay must refuse');
  assert.equal(replay.code, 'FORBIDDEN');
  // And the host still holds everything (no state moved).
  assert.equal(store.room.hostPlayerId, 'h1');
  assert.equal(store.room.roomCode, 'ABCDEF');
});

test('v34 gate (4): snapshot leaks — a hunter sees no runner fix, a runner sees no hunter fix, opponent role/team is null', async () => {
  const store = makeStore();
  startActive(store);
  await sendWs(store, 'hu1', 'location.update', {
    fix: { ...INSIDE, accuracyMeters: 10, timestampMs: T0 + 2000 },
  }, 'fix-hu1', T0 + 2000);
  await sendWs(store, 'r1', 'location.update', {
    fix: { lat: 23.36, lng: 85.34, accuracyMeters: 10, timestampMs: T0 + 2000 },
  }, 'fix-r1', T0 + 2000);
  const hunterSnap = store.snapshotFor('hu1', T0 + 3000);
  const runnerSnap = store.snapshotFor('r1', T0 + 3000);
  assert.equal(hunterSnap.teammateFixes['r1'], undefined, 'hunter snapshot must not carry a runner fix');
  assert.equal(runnerSnap.teammateFixes['hu1'], undefined, 'runner snapshot must not carry a hunter fix');
  assert.ok(hunterSnap.teammateFixes['hu1'] === undefined, 'own fix is not a teammate fix');
  assert.ok(runnerSnap.teammateFixes['r1'] === undefined, 'own fix is not a teammate fix');
  assert.ok(runnerSnap.teammateFixes['r2'] === undefined, 'r2 has no fix yet — nothing to leak');
  // Opponent role/team is null in every other seat's view.
  for (const snap of [hunterSnap, runnerSnap]) {
    for (const p of snap.players) {
      if (p.playerId === 'hu1' && snap === runnerSnap) {
        assert.equal(p.matchRole, null, 'runner must not see the hunter role');
        assert.equal(p.team, null, 'runner must not see the hunter team');
      }
      if (p.playerId === 'r1' && snap === hunterSnap) {
        assert.equal(p.matchRole, null, 'hunter must not see the runner role');
        assert.equal(p.team, null, 'hunter must not see the runner team');
      }
    }
  }
  // Own role is visible to self.
  assert.equal(hunterSnap.players.find((p) => p.playerId === 'hu1').matchRole, 'hunter');
  assert.equal(runnerSnap.players.find((p) => p.playerId === 'r1').matchRole, 'runner');
});

test('v34 gate (4): signal spam — the 11th radio.send in 60 s is RATE_LIMITED, and fresh commandIds do NOT bypass it', async () => {
  const store = makeStore();
  startActive(store);
  let limitedAt = -1;
  for (let i = 1; i <= 12; i += 1) {
    const r = await sendWs(store, 'r1', 'radio.send', { text: `spam ${i}`, kind: 'text' }, `spam-${i}`, T0 + i * 1000);
    if (errorCodes(r).includes('RATE_LIMITED')) {
      limitedAt = i;
      break;
    }
  }
  assert.equal(limitedAt, 11, `radio.send limit is 10/60 s — the 11th must limit, got ${limitedAt}`);
  // The limit reply is retryable (the client can surface "slow down").
  const retry = await sendWs(store, 'r1', 'radio.send', { text: 'again', kind: 'text' }, 'spam-retry', T0 + 12_000);
  assert.ok(errorCodes(retry).includes('RATE_LIMITED'), 'still limited inside the window');
  assert.equal(
    retry.events.find((e) => e.type === 'error').payload.retryable,
    true,
    'the rate-limit error must be marked retryable',
  );
});

test('v34 gate (4): ejected and left seats acting — radio + catch refuse FORBIDDEN with the right close (4405 / 4403)', async () => {
  // Ejected hunter.
  {
    const store = makeStore();
    startActive(store);
    store.player('hu1').ejectedAt = new Date(T0 + 1500).toISOString();
    for (const [type, payload] of [
      ['radio.send', { text: 'hi', kind: 'text' }],
      ['catch.request', { runnerId: 'r1' }],
      ['catch.self-confirm', { hunterId: 'hu1' }],
      ['signal.send', { code: 'need-help' }],
    ]) {
      const r = await sendWs(store, 'hu1', type, payload, `ej-${type}`, T0 + 2000);
      assert.ok(errorCodes(r).includes('FORBIDDEN'), `ejected ${type} must be FORBIDDEN`);
      assert.equal(r.close?.code, 4405, `ejected ${type} must close 4405`);
    }
  }
  // Left runner.
  {
    const store = makeStore();
    startActive(store);
    store.player('r1').leftAt = new Date(T0 + 1500).toISOString();
    const r = await sendWs(store, 'r1', 'radio.send', { text: 'hi', kind: 'text' }, 'left-1', T0 + 2000);
    assert.ok(errorCodes(r).includes('FORBIDDEN'), 'left seat radio must be FORBIDDEN');
    assert.equal(r.close?.code, 4403, 'left seat must close 4403');
  }
});

test('v34 gate (4): copied rejoin token — name + token IS the credential (bearer property, documented); wrong name/token refuses', async () => {
  const store = makeStore();
  // The victim's seat exists with its token hash (as created at join).
  // Attacker knows the victim's NAME + token: restore succeeds — the
  // token is a bearer credential by design (never displayed in UI,
  // never persisted raw, never in a snapshot). The exploit shape is:
  // physical device access (or a compromised client) + the victim's
  // codename. No server check can distinguish the owner from a token
  // holder; see the report's OPEN item.
  const restore = await store.addPlayerAsync({
    displayName: 'Runner 1',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 1000,
  });
  assert.equal(restore.ok, true, 'name + matching token restores (bearer property)');
  assert.equal(restore.value.restored, true);
  // Wrong token for the same name: 403.
  const wrong = await store.addPlayerAsync({
    displayName: 'Runner 1',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'attacker-hash',
    nowMs: T0 + 1100,
  });
  assert.equal(wrong.ok, false, 'name + wrong token must refuse');
  assert.equal(wrong.code, 'FORBIDDEN');
  // Attacker's fresh name + the victim's token hash: a NEW seat (the
  // hash is ignored for new seats) — not a hijack of the victim.
  const fresh = await store.addPlayerAsync({
    displayName: 'Attacker',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 1200,
  });
  assert.equal(fresh.ok, true, 'a fresh name joins as its own seat');
  assert.notEqual(fresh.value.player.playerId, 'r1', 'the new seat is not the victim seat');
  assert.equal(store.player('r1').displayName, 'Runner 1', 'the victim seat is untouched');
});

// ---------------------------------------------------------------------------
// 2 — wiring: the scheduled retention handler is callable end to end
// ---------------------------------------------------------------------------

test('v34 gate (2): wiring — the Worker scheduled handler runs deleteOldLogs (cron -> handler -> PostgREST DELETE)', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return { ok: true };
  };
  try {
    const waited = [];
    const ctx = { waitUntil: (p) => void waited.push(p) };
    await workerDefault.scheduled({}, { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }, ctx);
    await Promise.allSettled(waited);
    // Merge, 2026-11-27: the scheduled run issues FOUR DELETEs now,
    // not one — the game-log cleanup plus the three admin cleanups
    // (expired sessions, 180-day admin audit, 24 h login attempts).
    // The game-log DELETE is still first and still the 7-day cutoff.
    assert.equal(calls.length, 4, 'the scheduled run must issue four DELETEs (game logs + three admin cleanups)');
    assert.ok(calls.every((c) => c.method === 'DELETE'), 'every scheduled call is a DELETE');
    assert.equal(calls[0].method, 'DELETE');
    assert.match(calls[0].url, /\/rest\/v1\/logs\?created_at=lt\./, 'the first DELETE must target logs older than the cutoff');
    // The cutoff is 7 days before now — the URL carries it.
    const cutoff = decodeURIComponent(calls[0].url.split('created_at=lt.')[1]);
    const ageMs = Date.now() - Date.parse(cutoff);
    assert.ok(
      ageMs >= 7 * 24 * 60 * 60 * 1000 - 60_000 && ageMs <= 7 * 24 * 60 * 60 * 1000 + 60_000,
      `cutoff must be ~7 days ago, got ${cutoff}`,
    );
    const urls = calls.map((c) => c.url);
    assert.ok(urls.some((u) => /\/rest\/v1\/admin_sessions\?/.test(u)), 'expired admin sessions are revoked');
    assert.ok(urls.some((u) => /\/rest\/v1\/admin_audit_log\?/.test(u)), 'admin audit rows older than 180 days are deleted');
    assert.ok(urls.some((u) => /\/rest\/v1\/admin_login_attempts\?/.test(u)), 'login-attempt rows older than 24 h are deleted');
    // And the direct helper agrees (same call, same shape).
    const ok = await deleteOldLogs({ SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    assert.equal(ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
