import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory, LOBBY_EXPIRY_MS, ABANDONED_IDLE_MS, SEAT_RECONNECT_WINDOW_MS } = await import('../src/room-do.ts');
const { handleJoinByCode, handleJoin } = await import('../src/http.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

globalThis.fetch = async () => ({ ok: true });

// v34 — Diya AppSec round-2 items, server pins (coordinator-routed).
// R2-4 (gate-only fix retention), R2-5 (fixReseedNeeded), R2-8 (claims
// die with an ejected seat), R2-10 (join-leg timings), §6 (the two
// state-machine transitions Diya could not verify from code).
// R2-6's CLOCK_SKEW code is pinned in v34-harness-adversarial.test.mjs;
// R2-9's distinct gate reasons are pinned in packages/engine/test/catch.test.mjs.
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
    joinedAt: new Date(opts.joinedAtMs ?? T0 - 1000).toISOString(),
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

function makeStore({ phase = 'LOBBY', players, catches = [], createdAtMs = T0 - 1000 } = {}) {
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
      player('h1', 'Host', { isHost: true, joinedAtMs: T0 - 4000 }),
      player('hu1', 'Hunter 1', { matchRole: 'hunter', team: 'hunters', joinedAtMs: T0 - 3000 }),
      player('r1', 'Runner 1', { matchRole: 'runner', team: 'runners', joinedAtMs: T0 - 2000 }),
      player('r2', 'Runner 2', { matchRole: 'runner', team: 'runners', joinedAtMs: T0 - 1000 }),
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
      createdAt: new Date(createdAtMs).toISOString(),
      startedAt: live ? new Date(T0).toISOString() : null,
      endsAt: live ? new Date(T0 + 3600_000).toISOString() : null,
      pausedAt: null,
      result: null,
    },
    players: list,
    catches,
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

async function sendFix(store, playerId, atMs, point = INSIDE, accuracy = 10, timestampMs = atMs) {
  return sendWs(
    store,
    playerId,
    'location.update',
    { fix: { ...point, accuracyMeters: accuracy, timestampMs } },
    `fix-${playerId}-${atMs}-${timestampMs}`,
    atMs,
  );
}

function errorOf(result) {
  return result.events.find((e) => e.type === 'error');
}

// ---------------------------------------------------------------------------
// R2-4 — the gate's 60 s window is real for a stationary pair (gate-only map)
// ---------------------------------------------------------------------------

test('v34 Diya R2-4: a stationary pair at 45 s still tags — the gate map survives the 30 s purge, the live map does not', async () => {
  const store = makeStore();
  startActive(store);
  // Both phones report at T0+40 s, but the fixes they carry are stamped
  // T0 (a cached / re-sent fix: receipt is fresh, the device timestamp
  // is 40 s old). lastFixAt stays fresh, so (4a) never fires.
  await sendFix(store, 'hu1', T0 + 40000, INSIDE, 10, T0);
  await sendFix(store, 'r1', T0 + 40000, INSIDE, 10, T0);
  // The tick at T0+45 s purges the 30 s live map (both fixes 45 s old)
  // but keeps the 60 s gate map.
  store.alarmTick(T0 + 45000, { liveSocketCount: 4 });
  assert.equal(store.mem.latestFix['hu1'], undefined, 'the 30 s live map must have purged the fix');
  assert.equal(store.mem.latestFix['r1'], undefined, 'the 30 s live map must have purged the fix');
  assert.ok(store.mem.latestFixForCatch['hu1'], 'the 60 s gate map must still hold the Hunter fix');
  assert.ok(store.mem.latestFixForCatch['r1'], 'the 60 s gate map must still hold the Runner fix');
  // The live readers still see "unknown" at 45 s — the map, the pings
  // and liveness are unchanged by the gate map.
  assert.equal(store.locationStatus(T0 + 45000)['r1'], 'unknown', 'liveness still reads unknown past 30 s');
  assert.deepEqual(
    store.snapshotFor('r2', T0 + 45000).teammateFixes,
    {},
    'teammateFixes must not carry a 45 s-old fix',
  );
  // And the OK tap at 45 s now succeeds — the founder's repro, fixed.
  const r = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-45s', T0 + 45000);
  assert.equal(errorOf(r), undefined, `45 s self-confirm must not error: ${JSON.stringify(r.events)}`);
  assert.ok(r.events.some((e) => e.type === 'catch.confirmed'), 'the tag must confirm at 45 s');
});

test('v34 Diya R2-4: past 60 s the gate still refuses — the 60 s window is a bound, not a removal', async () => {
  const store = makeStore();
  startActive(store);
  // Fixes stamped T0+20 s, received at T0+80 s (60 s old on arrival —
  // accepted, exactly at the STALE_FIX_MS boundary).
  await sendFix(store, 'hu1', T0 + 80000, INSIDE, 10, T0 + 20000);
  await sendFix(store, 'r1', T0 + 80000, INSIDE, 10, T0 + 20000);
  // At T0+85 s the fixes are 65 s old: the gate map purges them.
  store.alarmTick(T0 + 85000, { liveSocketCount: 4 });
  assert.equal(store.mem.latestFixForCatch['hu1'], undefined, 'the gate map must purge past 60 s');
  const r = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-85s', T0 + 85000);
  const err = errorOf(r);
  assert.ok(err, 'an 85 s self-confirm must answer with an error envelope');
  assert.equal(err.payload['code'], 'STALE_LOCATION');
  assert.equal(store.state.catches.length, 0, 'a refused self-confirm must create no claim');
});

test('v34 Diya R2-4: the gate map does not weaken (4a) — a truly silent seat still ejects at 30 s', async () => {
  const store = makeStore();
  startActive(store);
  // Everyone except r1 reports at T0+30 s; r1 never reports at all.
  await sendFix(store, 'h1', T0 + 30000);
  await sendFix(store, 'hu1', T0 + 30000);
  await sendFix(store, 'r2', T0 + 30000);
  const tick = store.alarmTick(T0 + 31000, { liveSocketCount: 4 });
  assert.notEqual(store.player('r1').ejectedAt, null, 'a seat silent for 30 s must eject');
  assert.equal(store.player('hu1').ejectedAt, null, 'a reporting seat must not eject');
  assert.equal(store.player('r2').ejectedAt, null, 'a reporting seat must not eject');
  assert.ok(tick.disconnect.some((d) => d.playerId === 'r1' && d.code === 4405), 'the ejection closes 4405');
});

// ---------------------------------------------------------------------------
// R2-5 — fixReseedNeeded: the server names the post-eviction hole
// ---------------------------------------------------------------------------

test('v34 Diya R2-5: fixReseedNeeded is true after a simulated DO wake (durable lastFixAt, empty memory), false otherwise', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'r1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  // Simulate the wake: memory rebuilds empty, durable lastFixAt stays.
  store.mem.latestFix = {};
  store.mem.latestFixForCatch = {};
  assert.equal(store.player('r1').lastFixAt !== null, true, 'lastFixAt must survive the simulated wake');
  assert.equal(store.snapshotFor('r1', T0 + 3000).fixReseedNeeded, true, 'the hole must be signalled');
  assert.equal(store.snapshotFor('hu1', T0 + 3000).fixReseedNeeded, true, 'the hole is per-seat');
  // A re-sent fix clears it — the server honours the client re-send.
  await sendFix(store, 'r1', T0 + 4000);
  assert.equal(store.snapshotFor('r1', T0 + 4000).fixReseedNeeded, false, 'a re-sent fix must clear the flag');
});

test('v34 Diya R2-5: fixReseedNeeded is false when the seat never reported, and false in the lobby', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  // r1 never reported: nothing to re-send.
  assert.equal(store.snapshotFor('r1', T0 + 3000).fixReseedNeeded, false, 'a seat that never reported needs no re-seed');
  // In the lobby the flag never fires (the client streams fixes there).
  const lobby = makeStore();
  lobby.player('r1').lastFixAt = new Date(T0).toISOString();
  assert.equal(lobby.snapshotFor('r1', T0 + 3000).fixReseedNeeded, false, 'the lobby never signals a re-seed');
});

// ---------------------------------------------------------------------------
// R2-8 — a suspended Hunter's open claim dies with their ejection
// ---------------------------------------------------------------------------

test('v34 Diya R2-8: a suspended Hunter + open claim — the tap names the wait, and the claim expires when the Hunter is ejected (not at 120 s)', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  // Way 1: the Hunter claims the Runner.
  const claim = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'claim-1', T0 + 3000);
  assert.equal(errorOf(claim), undefined, `the claim must open: ${JSON.stringify(claim.events)}`);
  assert.equal(store.state.catches.length, 1, 'one claim must be open');
  assert.equal(store.state.catches[0].state, 'awaiting-confirmation');
  // The Hunter's phone locks.
  store.suspendSeat('hu1', 'network-lost', T0 + 5000);
  assert.equal(store.player('hu1').connectionState, 'suspended');
  // The Runner taps OK: the rejection names the wait and the claim's end.
  const tap = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-susp', T0 + 6000);
  const err = errorOf(tap);
  assert.ok(err, 'the tap must answer with an error envelope');
  assert.equal(err.payload['code'], 'CONFLICT');
  assert.match(err.payload['message'], /wait for them to come back/);
  assert.match(err.payload['message'], /claim ends when they are ejected/);
  assert.equal(store.state.catches[0].state, 'awaiting-confirmation', 'the claim stays open while the Hunter may return');
  // The Runner keeps reporting, so the tick cannot eject them — and the
  // host + second Runner report too, so (4a) ejects nobody but the
  // suspended Hunter below.
  await sendFix(store, 'h1', T0 + 34000);
  await sendFix(store, 'r1', T0 + 34000);
  await sendFix(store, 'r2', T0 + 34000);
  // Past the Hunter's 30 s return window: the tick ejects them, and the
  // claim expires WITH them — 31 s after the suspend, not 120 s after
  // the claim.
  const tick = store.alarmTick(T0 + 36000, { liveSocketCount: 1 });
  assert.notEqual(store.player('hu1').ejectedAt, null, 'the Hunter must eject past the 30 s window');
  assert.equal(store.state.catches[0].state, 'expired', 'the claim must expire with the Hunter');
  assert.ok(tick.events.some((e) => e.type === 'catch.expired'), 'the expiry must be announced as catch.expired');
  // The Runner is free again: a fresh tap does not hit the dead claim —
  // selfConfirmCatch refuses the ejected Hunter outright (CONFLICT).
  const again = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-after', T0 + 37000);
  const err2 = errorOf(again);
  assert.ok(err2, 'the tap must still answer');
  assert.equal(err2.payload['code'], 'CONFLICT');
  assert.match(err2.payload['message'], /no longer in play/);
  assert.equal(store.state.catches.length, 1, 'no new claim may be created for an ejected Hunter');
  assert.equal(store.state.catches[0].state, 'expired', 'the only claim is the expired one');
});

// ---------------------------------------------------------------------------
// §6 — the two state-machine transitions Diya could not verify from code
// ---------------------------------------------------------------------------

test('v34 Diya §6: LOBBY→EXPIRED — a lobby older than 24 h expires on the alarm tick; a 23 h lobby does not', () => {
  assert.equal(LOBBY_EXPIRY_MS, 24 * 60 * 60 * 1000, 'the lobby expiry window is 24 h');
  const old = makeStore({ createdAtMs: T0 - LOBBY_EXPIRY_MS - 1000 });
  const tick = old.alarmTick(T0, { liveSocketCount: 0 });
  assert.equal(old.room.phase, 'EXPIRED', 'a 24 h-old lobby must expire');
  assert.ok(tick.events.some((e) => e.type === 'room.state'), 'the expiry must be announced');
  assert.ok(tick.persist.some((p) => p.kind === 'room-upsert'), 'the expiry must persist');
  const young = makeStore({ createdAtMs: T0 - LOBBY_EXPIRY_MS + 3_600_000 });
  young.alarmTick(T0, { liveSocketCount: 0 });
  assert.equal(young.room.phase, 'LOBBY', 'a 23 h-old lobby must stay a lobby');
});

test('v34 Diya §6: SAFETY_PAUSED→ABANDONED — a paused room with every seat suspended and no live socket for 10 min abandons; a live socket holds it', async () => {
  assert.equal(ABANDONED_IDLE_MS, 10 * 60 * 1000, 'the idle-abandon window is 10 min');
  assert.equal(SEAT_RECONNECT_WINDOW_MS, 30_000, 'the seat return window is 30 s');
  const store = makeStore();
  startActive(store);
  const paused = await sendWs(store, 'r1', 'safety.pause', { reason: 'test' }, 'pause-1', T0 + 2000);
  assert.equal(errorOf(paused), undefined, 'the pause must succeed');
  assert.equal(store.room.phase, 'SAFETY_PAUSED');
  // Every seat suspends at T0+5000 (the host's grace lapses long before
  // the 10 min window, so it cannot hold the room).
  for (const id of ['h1', 'hu1', 'r1', 'r2']) {
    store.suspendSeat(id, 'network-lost', T0 + 5000);
  }
  // 9 min in: still paused.
  store.alarmTick(T0 + 5000 + 9 * 60_000, { liveSocketCount: 0 });
  assert.equal(store.room.phase, 'SAFETY_PAUSED', '9 min idle must not abandon');
  // 11 min in, no live socket: abandoned.
  const tick = store.alarmTick(T0 + 5000 + 11 * 60_000, { liveSocketCount: 0 });
  assert.equal(store.room.phase, 'ABANDONED', '11 min idle with no socket must abandon');
  assert.equal(store.room.result?.outcome, 'abandoned');
  assert.ok(tick.events.some((e) => e.type === 'match.cancelled'), 'the abandon must be announced');
  // The same room with a live socket attached holds.
  const held = makeStore();
  startActive(held);
  await sendWs(held, 'r1', 'safety.pause', { reason: 'test' }, 'pause-1', T0 + 2000);
  for (const id of ['h1', 'hu1', 'r1', 'r2']) {
    held.suspendSeat(id, 'network-lost', T0 + 5000);
  }
  held.alarmTick(T0 + 5000 + 11 * 60_000, { liveSocketCount: 1 });
  assert.equal(held.room.phase, 'SAFETY_PAUSED', 'a live socket must hold a paused room');
});

// ---------------------------------------------------------------------------
// R2-10 — join-leg timings: the response names each server leg
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeJoinEnv() {
  let registryCalls = 0;
  let doCalls = 0;
  const env = {
    ROOM_DO: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (_url, init) => {
          doCalls += 1;
          const body = JSON.parse(init.body);
          assert.equal(body.op, 'add-player', 'the join leg calls add-player once');
          return jsonResponse({
            ok: true,
            player: { playerId: '22222222-3333-4444-8555-666666666666', displayName: 'Guest', isHost: false },
            reconnectToken: 'reconnect-token',
            restored: false,
            wsTicket: { ticket: 'a'.repeat(32), ticketId: 't1', expiresAtMs: Date.now() + 60_000 },
          });
        },
      }),
    },
    CODE_REGISTRY_DO: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (_url, init) => {
          registryCalls += 1;
          const body = JSON.parse(init.body);
          assert.equal(body.op, 'lookup', 'the join-by-code leg looks the code up once');
          return jsonResponse({ ok: true, roomId: 'room-1' });
        },
      }),
    },
  };
  return { env, counts: () => ({ registryCalls, doCalls }) };
}

test('v34 Diya R2-10: join-by-code returns per-leg server timings and makes exactly one registry + one DO call', async () => {
  const { env, counts } = makeJoinEnv();
  const ctx = { env, ctx: { waitUntil: () => undefined } };
  const req = new Request('http://x/v1/rooms/join-by-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Guest', kind: 'guest', roomCode: 'ABCDEF' }),
  });
  const res = await handleJoinByCode(req, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.roomId, 'room-1');
  const timings = body.serverTimings;
  assert.ok(timings, 'the response must carry serverTimings');
  for (const leg of ['registryMs', 'doMs', 'totalMs']) {
    assert.equal(typeof timings[leg], 'number', `${leg} must be a number`);
    assert.ok(timings[leg] >= 0, `${leg} must be non-negative`);
  }
  assert.ok(timings.totalMs >= timings.doMs, 'total must cover the DO leg');
  assert.ok(timings.totalMs >= timings.registryMs, 'total must cover the registry leg');
  assert.deepEqual(counts(), { registryCalls: 1, doCalls: 1 }, 'the join path is exactly two server legs');
});

test('v34 Diya R2-10: direct join carries doMs + totalMs and no registry leg', async () => {
  const { env, counts } = makeJoinEnv();
  const ctx = { env, ctx: { waitUntil: () => undefined } };
  const req = new Request('http://x/v1/rooms/room-1/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Guest', kind: 'guest', roomCode: 'ABCDEF' }),
  });
  const res = await handleJoin(req, ctx, 'room-1');
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  const timings = body.serverTimings;
  assert.ok(timings, 'the response must carry serverTimings');
  assert.equal(typeof timings.doMs, 'number');
  assert.equal(typeof timings.totalMs, 'number');
  assert.equal('registryMs' in timings, false, 'a direct join runs no registry leg');
  assert.deepEqual(counts(), { registryCalls: 0, doCalls: 1 }, 'a direct join is one DO leg');
});
