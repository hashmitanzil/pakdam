import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// v30 QA (Arjun) — the live-game happy path, end to end, at RoomStore
// level: join → lobby → start → play → catch → results → replay → lobby
// → start again. No dead ends: the start gate never strands a game
// when fixes are flowing, a gps-denied suspension can resume with
// role/score intact, and a merely-hidden seat with a live socket is
// never ejected at game start. Harness mirrors
// v29-thirty-second-rule.test.mjs.
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

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

// Host Teo + 1 hunter (Ana) + 2 runners (Ben, Cid). Selected teams so
// roles are deterministic: Ana hunts, Ben and Cid run.
function makeStore() {
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
  const players = [
    player('h1', 'Teo', true),
    player('hu1', 'Ana'),
    player('r1', 'Ben'),
    player('r2', 'Cid'),
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
  return r;
}

function startActive(store, atMs = T0) {
  start(store, atMs);
  store.alarmTick(atMs + 1000);
  assert.equal(store.room.phase, 'ACTIVE', 'headStart 0 must reach ACTIVE on the first tick');
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

async function sendWs(store, playerId, type, payload, commandId, atMs) {
  return store.handleWsMessage(
    { playerId, sessionId: 's1' },
    { type, commandId, payload },
    atMs,
  );
}

function errorOf(result) {
  return result.events.find((e) => e.type === 'error');
}

function eventOf(result, type) {
  return result.events.find((e) => e.type === type);
}

async function mint(store, runnerId, commandId, atMs) {
  const result = await sendWs(store, runnerId, 'catch.runner-token', {}, commandId, atMs);
  const issued = eventOf(result, 'catch.runner-token');
  assert.ok(issued, `mint for ${runnerId} must issue a token`);
  return issued.payload['token'];
}

/** Hunter scans the runner's QR, then taps Tag to confirm it. */
async function catchRunner(store, runnerId, atMs) {
  const token = await mint(store, runnerId, `mint-${runnerId}-${atMs}`, atMs);
  const claim = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, `req-${runnerId}-${atMs}`, atMs + 1000);
  assert.equal(errorOf(claim), undefined, `claim for ${runnerId} must succeed`);
  const requested = eventOf(claim, 'catch.requested');
  assert.ok(requested, 'scan must emit catch.requested');
  const catchId = requested.payload['catch'].catchId;
  const confirm = await sendWs(
    store,
    'hu1',
    'catch.confirm',
    { catchId, qrToken: token },
    `conf-${runnerId}-${atMs}`,
    atMs + 2000,
  );
  assert.ok(eventOf(confirm, 'catch.confirmed'), `confirm for ${runnerId} must confirm`);
  assert.equal(store.state.catches.find((c) => c.catchId === catchId)?.state, 'confirmed');
}

async function fixAll(store, atMs) {
  for (const id of ['h1', 'hu1', 'r1', 'r2']) await sendFix(store, id, atMs);
}

test('happy path: join → lobby → start → play → catch → results → replay → lobby → start again', async () => {
  const store = makeStore();
  // Lobby: 4 seats, same room and code, nobody ejected or left.
  assert.equal(store.room.phase, 'LOBBY');
  assert.equal(store.room.roomCode, 'ABCDEF');
  assert.equal(store.state.players.length, 4);
  assert.ok(store.state.players.every((p) => p.ejectedAt === null && p.leftAt === null));

  // Start with fixes flowing: the "Waiting for GPS" gate must never
  // strand a game whose seats are reporting.
  await fixAll(store, T0 + 500);
  startActive(store);
  assert.equal(store.player('hu1').matchRole, 'hunter', 'Ana hunts (selected)');
  assert.equal(store.player('r1').matchRole, 'runner');
  assert.equal(store.player('r2').matchRole, 'runner');
  assert.equal(store.player('h1').matchRole, 'runner', 'the host plays as a runner here');
  assert.equal(store.room.startedAt, new Date(T0).toISOString());
  assert.equal(store.room.endsAt, new Date(T0 + 3600_000).toISOString());

  // Play: fixes keep flowing, nobody ejects, nobody strands.
  await fixAll(store, T0 + 12_000);
  store.alarmTick(T0 + 13_000);
  assert.equal(store.room.phase, 'ACTIVE');
  assert.ok(store.state.players.every((p) => p.ejectedAt === null));

  // Catch: Ben, then Cid, then the host themself (Teo plays as a
  // runner here) — the LAST free runner completes the match.
  await catchRunner(store, 'r1', T0 + 14_000);
  assert.equal(store.room.phase, 'ACTIVE', 'free runners left — the game goes on');
  assert.deepEqual(store.caughtRunnerIds(), ['r1']);
  // Only the still-free seats report now (a caught runner sends no fixes).
  for (const id of ['h1', 'hu1', 'r2']) await sendFix(store, id, T0 + 20_000);
  await catchRunner(store, 'r2', T0 + 20_000);
  assert.equal(store.room.phase, 'ACTIVE', 'Teo is still a free runner — the game goes on');
  assert.deepEqual(store.caughtRunnerIds(), ['r1', 'r2']);
  for (const id of ['h1', 'hu1']) await sendFix(store, id, T0 + 26_000);
  await catchRunner(store, 'h1', T0 + 26_000);
  assert.equal(store.room.phase, 'COMPLETED', 'the last free runner caught completes the match');
  assert.equal(store.room.result?.outcome, 'hunters-win');
  assert.deepEqual(store.room.result?.caughtRunnerIds, ['r1', 'r2', 'h1']);
  assert.deepEqual(store.room.result?.survivingRunnerIds, []);
  assert.equal(store.room.result?.tags.length, 3, 'all three tags are on the results timeline');

  // Replay: same room and code, players and config kept, everyone
  // un-ready with no role — and the lobby can start again.
  const replay = store.replayMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 21_000 });
  assert.equal(replay.ok, true, `replay must succeed: ${replay.ok ? '' : replay.error}`);
  assert.equal(replay.value.phase, 'LOBBY');
  assert.equal(replay.value.roomCode, 'ABCDEF', 'replay keeps the room code');
  assert.equal(replay.value.playerCount, 4);
  assert.equal(store.state.catches.length, 0, 'match state is cleared');
  assert.equal(store.room.result, null);
  for (const p of store.state.players) {
    assert.equal(p.isReady, false, `${p.displayName} is un-ready after replay`);
    assert.equal(p.matchRole, null, `${p.displayName} has no role after replay`);
    assert.equal(p.connectionState, 'connected');
    assert.equal(p.ejectedAt, null);
    assert.equal(p.lastFixAt, null, 'no stale fix carries into the new game');
  }
  assert.deepEqual(store.room.config.zone.boundary, TRIANGLE, 'the configured zone survives the replay');
  // Everyone re-readies (replay un-readied them — that is the point:
  // the lobby opens on "I'm ready", not on a stale ready state) and
  // the replayed lobby starts again — no dead end.
  for (const p of store.state.players) {
    p.isReady = true;
    p.briefingConfirmed = true;
  }
  start(store, T0 + 22_000);
  assert.equal(store.room.phase, 'HEAD_START', 'the replayed lobby starts again — no dead end');
});

test('start gate: the match starts with NO fix ever reported (v18 — no GPS-freshness refusal)', () => {
  const store = makeStore();
  // Nobody has reported anything: lastFixAt is null on every seat.
  assert.ok(store.state.players.every((p) => p.lastFixAt === null));
  startActive(store);
  assert.equal(store.room.phase, 'ACTIVE');
});

test('start gate: the match starts when fixes are flowing (no "Waiting for GPS" strand)', async () => {
  const store = makeStore();
  await fixAll(store, T0 + 500);
  startActive(store);
  // Fixes keep flowing after the start; the (4a) clock never fires.
  await fixAll(store, T0 + 25_000);
  store.alarmTick(T0 + 26_000);
  assert.equal(store.room.phase, 'ACTIVE');
  assert.ok(store.state.players.every((p) => p.ejectedAt === null));
});

test('gps-denied suspension can resume: unknown starts no window, no grace, no ejection; role/score intact', async () => {
  const store = makeStore();
  startActive(store);
  await fixAll(store, T0 + 2000);
  // Live maps a client-side gps-denied to reportSuspended('unknown')
  // (play/page.tsx) — 'unknown' is the server-side reason here: it
  // suspends the seat WITHOUT a return window and WITHOUT a grace.
  store.suspendSeat('r1', 'unknown', T0 + 5000);
  assert.equal(store.player('r1').connectionState, 'suspended');
  assert.equal(store.reconnectEndsAtMs('r1'), null, 'gps-denied starts no 30 s return window');
  assert.equal(store.state.hostGrace, null, 'gps-denied starts no host grace');
  // The other seats keep their fixes fresh; ticks far past 30 s must
  // never eject the suspended seat (suspended seats are exempt from
  // the (4a) missing-fix ejection).
  await sendFix(store, 'h1', T0 + 40_000);
  await sendFix(store, 'hu1', T0 + 40_000);
  await sendFix(store, 'r2', T0 + 40_000);
  store.alarmTick(T0 + 40_000);
  assert.equal(store.player('r1').ejectedAt, null, 'a gps-denied seat is held, not lost');
  // The player re-enables location: the first fix after resume proves
  // liveness, and the seat plays on with its role intact.
  const resumed = store.resumeOnHello('r1', T0 + 45_000);
  assert.equal(resumed.resumed, true, 'the seat resumes with role/score intact');
  assert.equal(store.player('r1').matchRole, 'runner', 'the role survives the suspension');
  assert.equal(store.player('r1').connectionState, 'connected');
  await sendFix(store, 'r1', T0 + 46_000);
  await sendFix(store, 'h1', T0 + 70_000);
  await sendFix(store, 'hu1', T0 + 70_000);
  await sendFix(store, 'r2', T0 + 70_000);
  store.alarmTick(T0 + 70_000);
  assert.equal(store.player('r1').ejectedAt, null, 'a resumed seat that reports fixes stays in');
  assert.equal(store.room.phase, 'ACTIVE');
});

test('30 s rule at start: a CONNECTED seat (live socket, never suspended) gets no window and never ejects', async () => {
  const store = makeStore();
  // Ben's tab is hidden but his socket is alive — the server never
  // heard a suspension, so he is simply connected at start: no
  // deadline, no ejection, however long the game runs with fixes
  // flowing. (A call on speaker while staying on the page counts as
  // present.)
  start(store);
  assert.equal(store.reconnectEndsAtMs('r1'), null, 'a connected seat gets no return window at start');
  store.alarmTick(T0 + 1000); // ACTIVE
  await fixAll(store, T0 + 2000);
  await fixAll(store, T0 + 40_000);
  store.alarmTick(T0 + 40_000);
  await fixAll(store, T0 + 70_000);
  store.alarmTick(T0 + 70_000);
  assert.equal(store.player('r1').ejectedAt, null, 'a merely-hidden seat with a live socket is never ejected');
  assert.equal(store.room.phase, 'ACTIVE');
});

test('30 s rule at start (CURRENT BEHAVIOUR pin): a seat suspended tab-hidden BEFORE start gets the start window — resume inside clears it', async () => {
  const store = makeStore();
  // NOTE (open founder confirmation, 2026-11-23): whether a
  // merely-hidden player with a live socket should get the 30 s
  // window at game start is still awaiting the founder's call. The
  // code today gives EVERY suspended seat the window at start
  // (room-do.ts startMatch) — this test pins that behaviour so a
  // change either way is a deliberate decision, not a silent drift.
  store.suspendSeat('r1', 'tab-hidden', T0 - 5000);
  start(store);
  assert.equal(store.reconnectEndsAtMs('r1'), T0 + 30_000, 'deadline is start + 30 s');
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r2', T0 + 2000);
  store.alarmTick(T0 + 1000); // ACTIVE
  // Ben comes back onto the page inside the window: resume clears it.
  const resumed = store.resumeOnHello('r1', T0 + 20_000);
  assert.equal(resumed.resumed, true);
  assert.equal(store.reconnectEndsAtMs('r1'), null, 'resuming inside the window clears it');
  assert.equal(store.player('r1').matchRole, 'runner', 'role/score intact after the return');
  await sendFix(store, 'r1', T0 + 21_000);
  await fixAll(store, T0 + 40_000);
  store.alarmTick(T0 + 40_000);
  assert.equal(store.player('r1').ejectedAt, null, 'a seat that came back is never ejected for the earlier absence');
});
