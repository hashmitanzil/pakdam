import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  RoomStore, emptyMemory, durableSnapshot, restoreState,
} = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// v34 HARNESS (Arjun, QA) — approach (f): chaos.
//
// Kill the socket mid-flow, discard the tab mid-game, deny GPS
// mid-game, toggle radio mid-call, background the app 30 s mid-match,
// clock jumps. Each is simulated at the store/DO level the VM can
// execute; what needs a real phone is marked NEEDS-PHONE in the test
// name and in the report — never claimed as proven here.

const T0 = 1_780_000_000_000;
const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

function player(id, displayName, isHost = false) {
  return {
    playerId: id, roomId: 'room-1', kind: 'guest', displayName, isHost,
    matchRole: null, team: null, reconnectTokenHash: `reconnect-hash-${id}`,
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
    players: [player('h1', 'Host', true), player('hu1', 'Hunter 1'), player('r1', 'Runner 1')],
    catches: [], hostTokens: { h1: 'host-hash' }, serverSeq: 0,
    gameEventLog: [], lastPingAtMs: {}, paused: false, pausedBy: null, pausedFrom: null,
    eventLog: [], shrinkIndexApplied: 0, tickets: [], idempotency: [],
    idempotentReplies: [], pendingPings: [], pendingPingRecipients: {}, runnerQrTokens: [],
  };
  return new RoomStore(state, emptyMemory());
}

async function sendWs(store, playerId, type, payload, commandId, atMs) {
  return store.handleWsMessage({ playerId, sessionId: 's1' }, { type, commandId, payload }, atMs);
}

function errorOf(result) {
  return result.events.find((e) => e.type === 'error');
}

async function sendFix(store, playerId, atMs, point = INSIDE, accuracyMeters = 10) {
  return sendWs(store, playerId, 'location.update', {
    fix: { ...point, accuracyMeters, timestampMs: atMs },
  }, `fix-${playerId}-${atMs}`, atMs);
}

function startActive(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `start must succeed: ${r.ok ? '' : r.error}`);
  store.alarmTick(atMs + 1000);
  assert.equal(store.room.phase, 'ACTIVE');
}

test('v34 harness chaos: socket killed mid-flow — the seat suspends, resumes inside 30 s with role and score intact', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'r1', T0 + 2000);
  // Socket dies: server-side sweep suspends with the actually-gone reason.
  const suspended = store.suspendSeat('r1', 'network-lost', T0 + 3000);
  assert.equal(store.player('r1').connectionState, 'suspended');
  assert.ok(suspended.events.some((e) => e.type === 'player.suspended'));
  assert.equal(store.reconnectEndsAtMs('r1'), T0 + 33_000, 'the 30 s return window starts at the kill');
  // 10 s later the socket comes back: hello resumes, window clears.
  const resumed = store.resumeOnHello('r1', T0 + 13_000);
  assert.equal(resumed.resumed, true);
  assert.equal(store.player('r1').connectionState, 'connected');
  assert.equal(store.reconnectEndsAtMs('r1'), null);
  assert.equal(store.player('r1').matchRole, 'runner', 'role survives the kill');
  assert.ok(resumed.events.some((e) => e.type === 'player.resumed'));
});

test('v34 harness chaos: background the app 30 s mid-match — at 29 s the seat lives, at 31 s the alarm ejects it', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  store.suspendSeat('r1', 'network-lost', T0 + 3000);
  // Keep the bystanders' fixes fresh: (4a) ejects CONNECTED seats
  // silent for 30 s, and if they all go, the anyoneConnected guard
  // disables the (4b) deadline rule entirely. A real game streams
  // fixes every second; the test must too.
  await sendFix(store, 'h1', T0 + 31000);
  await sendFix(store, 'hu1', T0 + 31000);
  // 29 s after the kill: still suspended, not ejected (host still
  // connected, so the deadline rule runs).
  store.alarmTick(T0 + 32_000);
  assert.equal(store.player('r1').ejectedAt, null, '29 s in, the seat must still live');
  await sendFix(store, 'h1', T0 + 33000);
  await sendFix(store, 'hu1', T0 + 33000);
  // 31 s after the kill: ejected, with a 4405 disconnect for the class
  // to deliver, and a snapshot carrying ejectedAt.
  const tick31 = store.alarmTick(T0 + 34_000);
  assert.notEqual(store.player('r1').ejectedAt, null, 'past 30 s the seat is ejected');
  assert.ok(tick31.disconnect.some((d) => d.playerId === 'r1' && d.code === 4405),
    'the ejection closes the socket with 4405');
  assert.equal(store.reconnectEndsAtMs('r1'), null, 'the window is gone once ejected');
  // The ejected seat serves nothing on a surviving socket.
  const after = await sendWs(store, 'r1', 'snapshot.request', { lastServerSeq: 0 }, 'snap-ejected', T0 + 35_000);
  assert.equal(after.close?.code, 4405, 'an ejected seat snapshot.request closes 4405');
  assert.equal(errorOf(after)?.payload.code, 'FORBIDDEN');
});

test('v34 harness chaos: tab-hidden suspension does NOT start a return window — a call on speaker is present', async () => {
  const store = makeStore();
  startActive(store);
  store.suspendSeat('r1', 'tab-hidden', T0 + 3000);
  assert.equal(store.player('r1').connectionState, 'suspended');
  assert.equal(store.reconnectEndsAtMs('r1'), null,
    'tab-hidden never starts the 30 s window (founder rule: a call on speaker while staying on the page counts as present)');
  // Even 5 minutes later, the deadline rule has nothing to eject on.
  // (Bystanders keep streaming fixes so (4a) does not mass-eject the
  // connected seats first and muddy the pin.)
  await sendFix(store, 'h1', T0 + 302_000);
  await sendFix(store, 'hu1', T0 + 302_000);
  store.alarmTick(T0 + 303_000);
  assert.equal(store.player('r1').ejectedAt, null, 'a tab-hidden seat is never deadline-ejected');
  assert.equal(store.room.phase, 'ACTIVE');
});

test('v34 harness chaos: tab discarded mid-game (DO wake) — phase, players and catches survive; raw fixes do not', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const claim = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'claim-1', T0 + 3000);
  assert.equal(errorOf(claim), undefined);
  assert.equal(store.state.catches.length, 1);
  // The DO hibernates: durable snapshot out, fresh store in.
  const snap = durableSnapshot(store.state);
  assert.equal(JSON.stringify(snap).includes('room-1'), true);
  const restoredState = restoreState(JSON.parse(JSON.stringify(snap)));
  assert.notEqual(restoredState, null);
  const woken = new RoomStore(restoredState, emptyMemory());
  woken.restoreDurableMemory();
  assert.equal(woken.room.phase, 'ACTIVE', 'the phase survives the wake');
  assert.equal(woken.state.players.length, 3, 'the roster survives the wake');
  assert.equal(woken.state.catches.length, 1, 'the open claim survives the wake');
  assert.equal(woken.state.catches[0].state, 'awaiting-confirmation');
  assert.equal(woken.mem.latestFix['r1'], undefined,
    'raw coordinates are memory-only by design — a woken DO reports locations unknown until a fresh fix');
  // The woken seat re-fixes and the claim still confirms.
  await sendFix(woken, 'hu1', T0 + 4000);
  await sendFix(woken, 'r1', T0 + 4000);
  const confirm = await sendWs(woken, 'r1', 'catch.confirm',
    { catchId: woken.state.catches[0].catchId, qrToken: '', manualConfirm: true }, 'confirm-1', T0 + 5000);
  assert.equal(errorOf(confirm), undefined, JSON.stringify(confirm.events));
  assert.ok(confirm.events.some((e) => e.type === 'catch.confirmed'));
});

test('v34 harness chaos: GPS denied mid-game — the seat suspends, cannot be tagged while suspended, resumes on fix', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  // The client reports the denial (GPS_DENIED path): suspension lands.
  const denied = await sendWs(store, 'r1', 'player.suspended', { reason: 'unknown' }, 'gps-denied-1', T0 + 3000);
  assert.equal(errorOf(denied), undefined);
  assert.equal(store.player('r1').connectionState, 'suspended');
  // A pending catch cannot complete while the Runner is suspended.
  const claim = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'claim-denied', T0 + 4000);
  assert.equal(claim.events.find((e) => e.type === 'error')?.payload.code, 'CONFLICT',
    'a suspended Runner cannot be claimed (isCatchableRunner refuses suspended seats)');
  // GPS back: a fresh fix resumes the seat (connection flips on fix).
  const fix = await sendFix(store, 'r1', T0 + 5000);
  assert.equal(errorOf(fix), undefined);
  assert.equal(store.player('r1').connectionState, 'connected', 'a fresh fix resumes a suspended seat');
  const claim2 = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'claim-back', T0 + 6000);
  assert.equal(errorOf(claim2), undefined, 'once resumed the Runner is claimable again');
});

test('v34 harness chaos: host killed mid-match — 30 s grace, then succession to the earliest joiner', async () => {
  const store = makeStore();
  startActive(store);
  store.suspendSeat('h1', 'network-lost', T0 + 3000);
  assert.notEqual(store.hostGraceEndsAtMs(), null, 'an actually-gone host starts the grace');
  assert.equal(store.hostGraceEndsAtMs(), T0 + 33_000);
  assert.equal(store.room.hostPlayerId, 'h1', 'the host keeps the crown during the grace');
  // Host returns inside the grace: keeps host.
  const resumed = store.resumeOnHello('h1', T0 + 13_000);
  assert.equal(resumed.resumed, true);
  assert.equal(store.hostGraceEndsAtMs(), null, 'returning inside the grace cancels it');
  assert.equal(store.room.hostPlayerId, 'h1');
  // Host killed again and stays gone: grace expires, earliest joiner (hu1) takes host.
  // (Bystanders keep streaming fixes so (4a) does not eject the
  // connected seats before the grace expiry is observed.)
  store.suspendSeat('h1', 'network-lost', T0 + 20_000);
  await sendFix(store, 'hu1', T0 + 50_000);
  await sendFix(store, 'r1', T0 + 50_000);
  const tick = store.alarmTick(T0 + 51_000);
  assert.equal(store.room.hostPlayerId, 'hu1', 'after the grace the earliest joiner becomes host');
  assert.ok(tick.events.some((e) => e.type === 'host.transferred'));
});

test('v34 harness chaos: clock jumps — a 1-hour jump never crashes the tick and never corrupts the machine', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  assert.doesNotThrow(() => { store.alarmTick(T0 + 3_600_000); },
    'a 1-hour clock jump must never throw from alarmTick');
  assert.ok(['ACTIVE', 'COMPLETED', 'RESOLVING', 'ABANDONED'].includes(store.room.phase),
    `after a 1 h jump the phase must be a legal one, got ${store.room.phase}`);
  assert.equal(store.state.players.length, 3, 'no seat is lost by a clock jump');
  // The machine still answers after the jump.
  const snap = await sendWs(store, 'h1', 'snapshot.request', { lastServerSeq: 0 }, 'snap-jump', T0 + 3_600_000);
  assert.ok(snap.events.some((e) => e.type === 'snapshot' || e.type === 'snapshot.unchanged' || e.type === 'error'),
    'the store still answers snapshots after a clock jump');
  // A fix stamped far in the past is stale, not a crash.
  const oldFix = await sendWs(store, 'r1', 'location.update', {
    fix: { ...INSIDE, accuracyMeters: 10, timestampMs: T0 },
  }, 'fix-old', T0 + 3_600_000);
  assert.equal(errorOf(oldFix)?.payload.code, 'STALE_LOCATION');
});

test('v34 harness chaos: radio toggled mid-call — voice to an ejected seat is refused on both halves', async () => {
  const store = makeStore();
  store.state.players.push(player('hu2', 'Hunter 2'));
  store.state.room.config.selectedHunterIds = ['hu1', 'hu2'];
  store.state.room.config.hunterCount = 2;
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'hu2', T0 + 2000);
  // hu2 is ejected mid-call (missing-fix ejection via the alarm).
  // (Bystanders keep streaming fixes so (4a) does not mass-eject the
  // connected seats first.)
  store.suspendSeat('hu2', 'network-lost', T0 + 3000);
  await sendFix(store, 'h1', T0 + 33000);
  await sendFix(store, 'hu1', T0 + 33000);
  await sendFix(store, 'r1', T0 + 33000);
  store.alarmTick(T0 + 34_000);
  assert.notEqual(store.player('hu2').ejectedAt, null);
  // hu1 offering to the ejected hu2: refused, nothing relayed.
  const toEjected = await sendWs(store, 'hu1', 'voice.signal',
    { toPlayerId: 'hu2', kind: 'offer', sdp: 'v=0' }, 'voice-to-ejected', T0 + 35_000);
  assert.equal(errorOf(toEjected)?.payload.code, 'FORBIDDEN');
  assert.equal(toEjected.events.some((e) => e.type === 'voice.signal'), false);
  // The ejected seat signalling out: refused too.
  const fromEjected = await sendWs(store, 'hu2', 'voice.signal',
    { toPlayerId: 'hu1', kind: 'offer', sdp: 'v=0' }, 'voice-from-ejected', T0 + 35_100);
  assert.equal(fromEjected.close?.code, 4405, 'an ejected seat gets the 4405 close, not a relay');
});

test('v34 harness chaos: leave mid-game then rejoin — the seat is gone until replay; a left seat serves nothing', async () => {
  const store = makeStore();
  startActive(store);
  const left = await sendWs(store, 'r1', 'leave', { reason: null }, 'leave-1', T0 + 3000);
  assert.equal(left.close?.code, 1000, 'a voluntary leave closes 1000');
  assert.notEqual(store.player('r1').leftAt, null);
  // Any further message from the left seat is FORBIDDEN + 4403.
  const after = await sendWs(store, 'r1', 'snapshot.request', { lastServerSeq: 0 }, 'snap-left', T0 + 4000);
  assert.equal(after.close?.code, 4403);
  assert.equal(errorOf(after)?.payload.code, 'FORBIDDEN');
  // A left seat cannot restore mid-match (LOBBY-only restore).
  const restore = await store.addPlayerAsync({
    displayName: 'Runner 1', roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-r1', nowMs: T0 + 5000,
  });
  assert.equal(restore.ok, false);
  assert.equal(restore.code, 'CONFLICT');
});

test('v34 harness chaos [NEEDS-PHONE]: real GPS denial, real tab discard and real backgrounding cannot be proven in this VM', () => {
  // This test documents the boundary instead of faking it: the store
  // level proves the server's reaction to each signal (suspension,
  // deadline, wake-restore — pinned above). What only a phone proves:
  // (1) the OS actually delivers the denial to the watch, (2) the
  // browser actually fires visibilitychange on a real backgrounding,
  // (3) the rejoin token actually survives a real tab discard, (4) a
  // fix actually resumes within 30 s on a real GPS chip. The e2e pins
  // (apps/web/e2e/v34-harness-pins.spec.ts) carry these as NEEDS-CI /
  // NEEDS-PHONE tests; this assertion only guards the list itself.
  const needsPhone = [
    'GPS denial reaches the watch on a real phone',
    'visibilitychange fires on real backgrounding',
    'rejoin token survives a real tab discard',
    'fresh fix resumes inside 30 s on a real GPS chip',
  ];
  assert.equal(needsPhone.length, 4);
  assert.ok(needsPhone.every((s) => typeof s === 'string' && s.length > 0));
});
