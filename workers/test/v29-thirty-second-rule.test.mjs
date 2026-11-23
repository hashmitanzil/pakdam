import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory, durableSnapshot, restoreState } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// v29 (A) — the 30-second rule (founder decision 2026-11-22, "what I
// meant", as in ShadowHunt/SCRAM): ONE timer, 30 s, everywhere.
// Lobby seats stay; absent seats at start get 30 s; an actually-gone
// mid-game suspension gets 30 s; tab-hidden WITH a live socket never
// starts the timer. Harness mirrors v18-fix-round.test.mjs.
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

function makeStore({ hunters = ['hu1'], runners = ['r1'], headStartSeconds = 0 } = {}) {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds,
    pingIntervalSeconds: 0,
    durationSeconds: 3600,
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

function view(store, viewerId, playerId, atMs) {
  const snap = store.snapshotFor(viewerId, atMs);
  return snap.players.find((p) => p.playerId === playerId);
}

test('lobby: a seat with no socket is never removed — it stays in the roster, marked away at most', () => {
  const store = makeStore();
  store.suspendSeat('r1', 'network-lost', T0);
  store.suspendSeat('hu1', 'tab-hidden', T0);
  store.alarmTick(T0 + 1000);
  store.alarmTick(T0 + 60_000);
  store.alarmTick(T0 + 600_000);
  assert.equal(store.player('r1').ejectedAt, null, 'a lobby seat is never ejected for absence');
  assert.equal(store.player('hu1').ejectedAt, null);
  assert.equal(store.player('r1').leftAt, null, 'a lobby seat never leaves the roster');
  assert.equal(store.state.players.length, 3, 'the roster keeps all three seats');
  assert.equal(store.reconnectEndsAtMs('r1'), null, 'no return window is ever set in the lobby');
  assert.equal(view(store, 'h1', 'r1', T0 + 600_000).presence, 'away');
  assert.equal(view(store, 'h1', 'hu1', T0 + 600_000).presence, 'away');
});

test('game start: a seat not present at start gets 30 s (deadline = startMs + 30 s), then ejects', async () => {
  const store = makeStore();
  store.suspendSeat('r1', 'tab-hidden', T0 - 5000);
  start(store);
  assert.equal(store.reconnectEndsAtMs('r1'), T0 + 30_000, 'deadline is start + 30 s');
  const v = view(store, 'h1', 'r1', T0);
  assert.equal(v.presence, 'away', 'a suspended seat reads away');
  assert.equal(v.reconnectEndsAtMs, T0 + 30_000);
  assert.equal(view(store, 'h1', 'h1', T0).presence, 'present');
  assert.equal(view(store, 'h1', 'h1', T0).reconnectEndsAtMs, null);
  // Keep the live seats fix-fresh so (4a) cannot touch them.
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'h1', T0 + 29_000);
  await sendFix(store, 'hu1', T0 + 29_000);
  store.alarmTick(T0 + 29_000);
  assert.equal(store.player('r1').ejectedAt, null, '29 s in, the window is still open');
  store.alarmTick(T0 + 31_000);
  assert.notEqual(store.player('r1').ejectedAt, null, 'past the deadline the seat ejects');
  const inPlay = store.state.players.filter((p) => p.leftAt === null && p.ejectedAt === null);
  assert.equal(inPlay.length, 2, 'the in-play member count drops');
  assert.equal(store.reconnectEndsAtMs('r1'), null, 'the deadline clears on ejection');
});

test('mid-game network-lost: 30 s timer, then eject; resuming inside the window clears it', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  assert.equal(store.reconnectEndsAtMs('r1'), T0 + 35_000, 'deadline is suspend + 30 s');
  // r1 comes back at T0+20000 (inside the window) and reports a fix.
  const resumed = store.resumeOnHello('r1', T0 + 20_000);
  assert.equal(resumed.resumed, true, 'the seat resumes with role/score intact');
  assert.equal(store.reconnectEndsAtMs('r1'), null, 'resuming clears the window');
  await sendFix(store, 'r1', T0 + 21_000);
  await sendFix(store, 'h1', T0 + 34_000);
  await sendFix(store, 'hu1', T0 + 34_000);
  store.alarmTick(T0 + 36_000);
  assert.equal(store.player('r1').ejectedAt, null, 'a seat that came back is never ejected for the earlier absence');
});

test('mid-game network-lost with no return: the seat ejects at the deadline', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  await sendFix(store, 'h1', T0 + 34_000);
  await sendFix(store, 'hu1', T0 + 34_000);
  store.alarmTick(T0 + 34_000);
  assert.equal(store.player('r1').ejectedAt, null, '1 s before the deadline the seat is still in');
  store.alarmTick(T0 + 36_000);
  assert.notEqual(store.player('r1').ejectedAt, null, 'past the deadline the seat ejects');
});

test('tab-hidden WITH a live socket never starts the timer (a call on speaker counts as present)', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  store.suspendSeat('r1', 'tab-hidden', T0 + 5000);
  assert.equal(store.reconnectEndsAtMs('r1'), null, 'tab-hidden starts no return window');
  assert.equal(store.state.hostGrace, null, 'tab-hidden starts no host grace either');
  // Keep the live seats fresh; tick far past 30 s.
  await sendFix(store, 'h1', T0 + 40_000);
  await sendFix(store, 'hu1', T0 + 40_000);
  store.alarmTick(T0 + 40_000);
  await sendFix(store, 'h1', T0 + 70_000);
  await sendFix(store, 'hu1', T0 + 70_000);
  store.alarmTick(T0 + 70_000);
  assert.equal(store.player('r1').ejectedAt, null, 'a tab-hidden seat is never ejected for silence');
  // Its snapshot still reads away (not on the page) with no window.
  assert.equal(view(store, 'h1', 'r1', T0 + 70_000).presence, 'away');
  assert.equal(view(store, 'h1', 'r1', T0 + 70_000).reconnectEndsAtMs, null);
});

test('a running window is never restarted or extended by a second suspension', () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  assert.equal(store.reconnectEndsAtMs('r1'), T0 + 35_000);
  store.suspendSeat('r1', 'heartbeat-timeout', T0 + 20_000);
  assert.equal(store.reconnectEndsAtMs('r1'), T0 + 35_000, 'the deadline stays at the first suspension');
});

test('F4: a deadline set before a pause is extended by the paused duration — no ejection on the first ACTIVE tick after resume', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  assert.equal(store.reconnectEndsAtMs('r1'), T0 + 35_000, 'deadline is suspend + 30 s');
  const paused = store.lifecycleOp({
    action: 'pause', playerId: 'h1', reconnectTokenHash: 'reconnect-hash-h1', nowMs: T0 + 10_000,
  });
  assert.equal(paused.ok, true, `pause must succeed: ${paused.ok ? '' : paused.error}`);
  assert.equal(store.room.phase, 'SAFETY_PAUSED');
  store.alarmTick(T0 + 40_000);
  assert.equal(store.player('r1').ejectedAt, null, 'the pause freezes the ejection clock');
  const resumed = store.lifecycleOp({
    action: 'resume', playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 40_000,
  });
  assert.equal(resumed.ok, true, `resume must succeed: ${resumed.ok ? '' : resumed.error}`);
  // Paused 30 s (T0+10_000 → T0+40_000): the deadline moves by the
  // same 30 s, T0+35_000 → T0+65_000. The player had zero chance to
  // return while paused, so the first ACTIVE tick after resume must
  // NOT eject them.
  assert.equal(store.reconnectEndsAtMs('r1'), T0 + 65_000, 'the deadline is extended by the paused duration');
  await sendFix(store, 'h1', T0 + 40_500);
  await sendFix(store, 'hu1', T0 + 40_500);
  store.alarmTick(T0 + 41_000);
  assert.equal(store.player('r1').ejectedAt, null, 'the first ACTIVE tick after resume must not eject the extended seat');
  // The extended deadline still enforces: past T0+65_000 the seat ejects.
  await sendFix(store, 'h1', T0 + 64_000);
  await sendFix(store, 'hu1', T0 + 64_000);
  store.alarmTick(T0 + 64_000);
  assert.equal(store.player('r1').ejectedAt, null, '1 s before the extended deadline the seat is still in');
  await sendFix(store, 'h1', T0 + 66_000);
  await sendFix(store, 'hu1', T0 + 66_000);
  store.alarmTick(T0 + 66_000);
  assert.notEqual(store.player('r1').ejectedAt, null, 'past the extended deadline the seat ejects');
});

test('when NOBODY is still playing, the 30 s rule does not complete the room — the idle path owns it', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  // Everyone disconnects; every seat gets a deadline, nobody is connected.
  store.suspendSeat('h1', 'network-lost', T0 + 5000);
  store.suspendSeat('hu1', 'network-lost', T0 + 5000);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  store.alarmTick(T0 + 40_000, { liveSocketCount: 0 });
  assert.equal(store.player('r1').ejectedAt, null, 'no ejection when nobody is playing');
  assert.equal(store.player('hu1').ejectedAt, null);
  assert.equal(store.room.phase, 'ACTIVE', 'the room stays ACTIVE for the idle-abandon path, not COMPLETED');
});

test('the first tick after a wake never ejects on a return window (same staleness rule as (4a))', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  // The wake tick lands after the deadline — it must not eject.
  store.alarmTick(T0 + 40_000, { firstTickAfterWake: true });
  assert.equal(store.player('r1').ejectedAt, null, 'the wake tick skips the ejection once');
  // The very next tick (no grace) ejects the still-absent seat.
  await sendFix(store, 'h1', T0 + 40_500);
  await sendFix(store, 'hu1', T0 + 40_500);
  store.alarmTick(T0 + 41_000);
  assert.notEqual(store.player('r1').ejectedAt, null, 'silence after the wake grace still ejects');
});

test('deadlines survive a durable round-trip; older writes without them default to none', () => {
  const store = makeStore();
  start(store);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  const snap = durableSnapshot(store.state);
  assert.equal(snap.disconnectDeadlineMs?.['r1'], T0 + 35_000, 'the deadline is in the durable snapshot');
  const restored = restoreState(snap);
  assert.equal(restored.disconnectDeadlineMs?.['r1'], T0 + 35_000);
  const legacy = restoreState({ ...snap, disconnectDeadlineMs: undefined });
  assert.deepEqual(legacy.disconnectDeadlineMs, {}, 'an older write without deadlines reads as none running');
});
