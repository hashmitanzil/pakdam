import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const sharedNs = await import('@pakdam/shared');
const { DEFAULT_ROOM_CONFIG } = sharedNs;

// v24 — host reconnect grace (founder decision D1, 2026-11-21):
//   "Host stays host until they've really left. If the disconnected
//   host comes back within 30 s they stay host, otherwise the
//   earliest joiner becomes host. Voluntary leave counts as really
//   left → immediate succession."
//
// Contract pinned here (store half; the DO half — eviction/wake and
// the lobby one-shot alarm — lives in v24-host-grace-do.test.mjs):
//   - An actually-gone host suspend ('network-lost' /
//     'heartbeat-timeout') starts ONE grace, deadline = suspendMs +
//     30_000, durable in `state.hostGrace`. No transfer at suspend
//     time. Tab-hidden / screen-locked / unknown never start one.
//   - A second actually-gone reason while suspended never restarts
//     or extends the grace.
//   - Return inside the window (hello resume OR join-path restore):
//     grace cancelled, host keeps host AND host token, no transfer.
//   - Expiry (an `alarmTick` at/after the deadline): transfer to the
//     earliest-joined CONNECTED player (v23 rule, unchanged), with NO
//     batchId — a fresh transfer that can never amend a delivered
//     event. A late return is a regular player.
//   - F3 (v24 fix round) — expiry with NO successor: the lapsed
//     grace record STANDS (no transfer, no clearing notice). Clearing
//     it used to strand the room hostless forever (the re-trigger
//     may only transfer on an expired grace recorded for this host).
//     The record is the marker: a later resume / fresh join
//     re-triggers the transfer as soon as a successor appears, and
//     the record is cleared then (by the transfer), by a resume, a
//     leave, or a terminal phase. The snapshot keeps reporting the
//     past deadline while the host is still the suspended host —
//     acceptable, the room IS still hostless.
//   - Expiry of a STALE grace (host no longer the suspended host) or
//     in a terminal room still clears with the `host-grace-expired`
//     notice (persisted + visible), so the client's grace line does
//     not linger there.
//   - v24 follow-up (snapshot gate): a grace started from an
//     ALREADY-suspended host emits a `room.state`
//     'host-grace-started' (the only re-fetch trigger, since
//     `suspendSeat` emits nothing there) and bumps the room version
//     (so the re-fetched snapshot is never identical-skipped by the
//     client's `(version, serverSeq)` gate). The grace start also
//     returns a room-upsert persist, so the class actually saves it.
//   - Voluntary leave: immediate succession, no grace — and no grace
//     survives a leave. Terminal phases: no grace starts, no
//     transfer; a grace is cleared (visibly + persistently) when the
//     room goes terminal.
//   - The snapshot carries `hostGraceEndsAtMs` (epoch ms, null when
//     no grace is running) for every viewer.
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];

function player(playerId, displayName, isHost, joinedAtMs) {
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
 * Roster in JOIN ORDER (host first); `joinedAt` staggered 1 s apart
 * from T0 - 5000. `phase` defaults to LOBBY; pass 'ACTIVE' (with
 * `headStartSeconds` 0 in the config) for live-phase tests.
 * `grace` lets a test hand-build a recorded grace in durable state.
 */
function makeStore({ phase = 'LOBBY', grace = null, durationSeconds = 3600 } = {}) {
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
    selectedHunterIds: ['hu1'],
    hunterCount: 1,
    balanceHunters: false,
    randomDraw: false,
  };
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
    players: [
      player('h1', 'Host', true, T0 - 5000),
      player('r1', 'Runner 1', false, T0 - 4000),
      player('r2', 'Runner 2', false, T0 - 3000),
      player('hu1', 'Hunter 1', false, T0 - 2000),
    ],
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
    hostGrace: grace,
  };
  return new RoomStore(state, emptyMemory());
}

function snapshotKey(store, playerId, atMs) {
  const snap = store.snapshotFor(playerId, atMs);
  return `${snap.version}:${snap.serverSeq}`;
}

function transferredEvents(events) {
  return events.filter((e) => e.type === 'host.transferred');
}

function roomStateEvents(events, reason) {
  return events.filter(
    (e) => e.type === 'room.state' && e.payload['reason'] === reason,
  );
}

function disconnectSeat(store, playerId, reason, nowMs, batchId) {
  return store.suspendSeat(playerId, reason, nowMs, batchId);
}

async function sendFix(store, playerId, atMs, point = { lat: 23.35, lng: 85.33 }) {
  const r = await store.handleWsMessage(
    { playerId, sessionId: 's1' },
    {
      type: 'location.update',
      commandId: `fix-${playerId}-${atMs}`,
      payload: { fix: { ...point, accuracyMeters: 10, timestampMs: atMs } },
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

// ---------------------------------------------------------------------------
// The window: return inside vs outside it
// ---------------------------------------------------------------------------

test('v24 host returns at ~29 s: stays host, NO transfer, grace cleared, host token intact', () => {
  const store = makeStore();
  const dropped = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(transferredEvents(dropped.events).length, 0, 'the suspend must not transfer');
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, T0 + 31000);
  assert.notEqual(store.verifyHost('h1', 'host-hash'), null, 'the host token must survive the grace');
  // 29 s after the drop — inside the window.
  const back = store.resumeOnHello('h1', T0 + 30000);
  assert.equal(back.resumed, true, 'the host must still be able to resume its seat');
  assert.equal(transferredEvents(back.events).length, 0, 'the return must not emit a transfer');
  assert.equal(store.room.hostPlayerId, 'h1', 'the host keeps host');
  assert.equal(store.player('h1').isHost, true);
  assert.equal(store.snapshotFor('r1', T0 + 30000).hostGraceEndsAtMs, null, 'the grace is cancelled on return');
  assert.notEqual(store.verifyHost('h1', 'host-hash'), null, 'the restored host still verifies with its token');
  // A later tick must not transfer either — there is no grace left.
  const tick = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(tick.events).length, 0, 'no transfer after a cancelled grace');
  assert.equal(store.room.hostPlayerId, 'h1');
});

test('v24 host returns at ~31 s: transfer already happened; returns as a regular player', () => {
  const store = makeStore();
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  const moved = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(moved.events).length, 1, 'the expiry must transfer');
  assert.equal(store.room.hostPlayerId, 'r1');
  // 31 s after the drop — outside the window.
  const back = store.resumeOnHello('h1', T0 + 32000);
  assert.equal(back.resumed, true, 'the old host must still be able to resume its seat');
  assert.equal(transferredEvents(back.events).length, 0, 'the late return must not emit another transfer');
  assert.equal(store.room.hostPlayerId, 'r1', 'the successor stays host — no flip-flop');
  assert.equal(store.player('h1').isHost, false, 'the late host returns as a regular player');
  assert.equal(store.verifyHost('h1', 'host-hash'), null, 'the old host token died with the transfer');
});

test('v24 host returns inside the window via join-path restore (name + reconnect token): keeps host, grace cancelled', async () => {
  const store = makeStore();
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, T0 + 31000);
  // The host rejoins by name with its reconnect token (the join-path
  // restore, not a hello resume).
  const restored = await store.addPlayerAsync({
    displayName: 'Host',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-h1',
    nowMs: T0 + 20000,
  });
  assert.equal(restored.ok, true, `restore must succeed: ${restored.ok ? '' : restored.error}`);
  assert.equal(restored.value.restored, true);
  assert.equal(transferredEvents(restored.events).length, 0, 'the restore must not transfer');
  assert.equal(store.room.hostPlayerId, 'h1', 'the restored host keeps host');
  assert.equal(store.snapshotFor('r1', T0 + 20000).hostGraceEndsAtMs, null, 'the grace is cancelled on restore');
  assert.notEqual(store.verifyHost('h1', 'host-hash'), null, 'the restored host still verifies');
  const tick = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(tick.events).length, 0, 'no transfer after a cancelled grace');
});

// ---------------------------------------------------------------------------
// The snapshot gate (v24 follow-up): grace start from an
// already-suspended host must move the snapshot key + be visible
// ---------------------------------------------------------------------------

test('v24 follow-up: grace started from an already-suspended host moves the snapshot key and emits host-grace-started', () => {
  const store = makeStore();
  store.suspendSeat('h1', 'tab-hidden', T0 + 1000);
  const keyBefore = snapshotKey(store, 'r1', T0 + 1000);
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, null, 'tab-hidden starts no grace');
  // Network drops while already suspended: suspendSeat emits no
  // player.suspended here — the grace start must still be visible.
  const closed = disconnectSeat(store, 'h1', 'network-lost', T0 + 2000);
  assert.equal(
    closed.events.filter((e) => e.type === 'player.suspended').length,
    0,
    'the suspension itself must not emit twice',
  );
  const started = roomStateEvents(closed.events, 'host-grace-started');
  assert.equal(started.length, 1, 'the grace start must emit a room.state so clients re-fetch the snapshot');
  assert.ok(
    closed.persist.some((p) => p.kind === 'room-upsert'),
    'the grace start must return a room-upsert persist, or the class would never save it',
  );
  const keyAfter = snapshotKey(store, 'r1', T0 + 2000);
  assert.notEqual(keyAfter, keyBefore, 'the snapshot key (version:serverSeq) must move, or the client identical-skips the new snapshot');
  assert.equal(store.snapshotFor('r1', T0 + 2000).hostGraceEndsAtMs, T0 + 32000);
  // A second actually-gone reason while suspended must NOT extend it
  // — and must not move the key again (no new grace started).
  const again = disconnectSeat(store, 'h1', 'heartbeat-timeout', T0 + 5000);
  assert.equal(again.events.length, 0, 'a second actually-gone reason emits nothing');
  assert.equal(again.persist.length, 0, 'and persists nothing');
  assert.equal(store.snapshotFor('r1', T0 + 5000).hostGraceEndsAtMs, T0 + 32000, 'the deadline never moves');
  assert.equal(snapshotKey(store, 'r1', T0 + 5000), keyAfter, 'the key must not move again');
});

test('v24 follow-up: fresh grace start also moves the snapshot key (player.suspended re-fetch is never identical-skipped)', () => {
  const store = makeStore();
  const keyBefore = snapshotKey(store, 'r1', T0 + 1000);
  const dropped = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(
    dropped.events.filter((e) => e.type === 'player.suspended').length,
    1,
    'the fresh suspend still emits player.suspended (the re-fetch trigger)',
  );
  assert.ok(
    dropped.persist.some((p) => p.kind === 'room-upsert'),
    'the grace start must return a room-upsert persist',
  );
  assert.notEqual(snapshotKey(store, 'r1', T0 + 1000), keyBefore, 'the snapshot key must move on grace start');
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, T0 + 31000);
});

// ---------------------------------------------------------------------------
// Lobby and live: the same rule both places
// ---------------------------------------------------------------------------

test('v24 grace expiry transfers in the LOBBY (tick at the deadline)', () => {
  const store = makeStore({ phase: 'LOBBY' });
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  // A tick inside the window transfers nothing…
  const early = store.alarmTick(T0 + 30000);
  assert.equal(transferredEvents(early.events).length, 0);
  assert.equal(store.room.hostPlayerId, 'h1');
  // …and the tick AT the deadline transfers.
  const moved = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(moved.events).length, 1);
  assert.equal(store.room.hostPlayerId, 'r1');
});

test('v24 grace expiry transfers in a live match (ACTIVE, tick at the deadline)', async () => {
  const store = makeStore({ phase: 'ACTIVE' });
  disconnectSeat(store, 'h1', 'network-lost', T0 + 2000);
  assert.equal(store.snapshotFor('r1', T0 + 2000).hostGraceEndsAtMs, T0 + 32000);
  // Fresh fixes just before the expiry tick: without them the
  // missing-fix ejection (4a) would eject the silent seats in the
  // same tick as the transfer, which is not what this test is about.
  await sendFix(store, 'r1', T0 + 31000);
  await sendFix(store, 'r2', T0 + 31000);
  await sendFix(store, 'hu1', T0 + 31000);
  const moved = store.alarmTick(T0 + 32000);
  assert.equal(transferredEvents(moved.events).length, 1, 'the live expiry must transfer exactly once');
  assert.equal(store.room.hostPlayerId, 'r1');
});

// ---------------------------------------------------------------------------
// Two players at once + never amending a delivered event
// ---------------------------------------------------------------------------

test('v24 two players disconnecting at once: one grace, one transfer at expiry naming the final host', () => {
  const store = makeStore();
  const first = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000, 'batch-1');
  const second = disconnectSeat(store, 'r1', 'network-lost', T0 + 1000, 'batch-1');
  assert.equal(
    transferredEvents([...first.events, ...second.events]).length,
    0,
    'simultaneous suspends transfer nothing yet',
  );
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, T0 + 31000, 'one grace for the host');
  const moved = store.alarmTick(T0 + 31000);
  const transfers = transferredEvents(moved.events);
  assert.equal(transfers.length, 1, 'exactly one transfer at expiry');
  assert.equal(transfers[0].payload['previousHostPlayerId'], 'h1');
  assert.equal(transfers[0].payload['newHostPlayerId'], 'r2', 'the suspended earliest joiner is skipped');
  assert.equal(store.room.hostPlayerId, 'r2');
});

test('v24 grace expiry never rewrites an already-delivered transfer', () => {
  const store = makeStore();
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  const first = store.alarmTick(T0 + 31000);
  const delivered = transferredEvents(first.events);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload['newHostPlayerId'], 'r1');
  // The new host drops later: its own grace, its own expiry, its own
  // FRESH transfer — the delivered one must be untouched.
  disconnectSeat(store, 'r1', 'network-lost', T0 + 32000);
  const second = store.alarmTick(T0 + 62000);
  const transfers2 = transferredEvents(second.events);
  assert.equal(transfers2.length, 1, 'the later drop emits its own transfer');
  assert.equal(transfers2[0].payload['previousHostPlayerId'], 'r1');
  assert.equal(transfers2[0].payload['newHostPlayerId'], 'r2');
  assert.equal(delivered[0].payload['newHostPlayerId'], 'r1', 'the delivered transfer still names r1 — never amended');
  assert.equal(store.room.hostPlayerId, 'r2');
});

// ---------------------------------------------------------------------------
// No successor / stale grace: the clearing is persisted + visible
// ---------------------------------------------------------------------------

test('F3 expiry with no successor keeps the lapsed grace record (no transfer, no clearing notice) — recovery stays possible', () => {
  const store = makeStore();
  // Everyone except the host is suspended, so nobody can take host.
  store.suspendSeat('r1', 'tab-hidden', T0 + 500);
  store.suspendSeat('r2', 'tab-hidden', T0 + 600);
  store.suspendSeat('hu1', 'tab-hidden', T0 + 700);
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, T0 + 31000);
  const tick = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(tick.events).length, 0, 'no successor, so no transfer');
  assert.equal(store.room.hostPlayerId, 'h1', 'the dead host keeps host — there is nobody to transfer to');
  // F3: the lapsed record STANDS — it is the marker the re-trigger
  // needs. Clearing it here used to strand the room hostless forever.
  assert.deepEqual(
    store.state.hostGrace,
    { hostPlayerId: 'h1', endsAtMs: T0 + 31000 },
    'the lapsed grace record must still be present after a no-successor expiry',
  );
  assert.equal(
    store.snapshotFor('r1', T0 + 31000).hostGraceEndsAtMs,
    T0 + 31000,
    'the snapshot keeps reporting the past deadline while the host is still the suspended host — the "Waiting for the host…" line stays up, and the room IS still hostless',
  );
  assert.equal(
    roomStateEvents(tick.events, 'host-grace-expired').length,
    0,
    'no clearing notice on a no-successor expiry — nothing was cleared',
  );
  assert.equal(tick.persist.length, 0, 'nothing changed, so nothing is persisted');
  // And a still-later tick stays quiet — no repeat notice, no transfer.
  const later = store.alarmTick(T0 + 32000);
  assert.equal(transferredEvents(later.events).length, 0, 'the later tick must not transfer either');
  assert.equal(roomStateEvents(later.events, 'host-grace-expired').length, 0, 'the clearing must not repeat every tick');
  assert.deepEqual(
    store.state.hostGrace,
    { hostPlayerId: 'h1', endsAtMs: T0 + 31000 },
    'the lapsed record still stands after the later tick',
  );
});

test('v24 follow-up: a grace recorded in a terminal room is cleared visibly + persistently by the tick (no transfer)', () => {
  // Hand-built terminal state with a grace still recorded (e.g. a
  // durable write from before the room completed).
  const store = makeStore({ phase: 'COMPLETED', grace: { hostPlayerId: 'h1', endsAtMs: T0 + 31000 } });
  store.player('h1').connectionState = 'suspended';
  const keyBefore = snapshotKey(store, 'r1', T0 + 1000);
  const tick = store.alarmTick(T0 + 1000);
  assert.equal(transferredEvents(tick.events).length, 0, 'terminal: no transfer');
  const expired = roomStateEvents(tick.events, 'host-grace-expired');
  assert.equal(expired.length, 1, 'the terminal clearing must emit a room.state');
  assert.ok(
    tick.persist.some((p) => p.kind === 'room-upsert'),
    'the terminal clearing must return a room-upsert persist',
  );
  assert.notEqual(snapshotKey(store, 'r1', T0 + 1000), keyBefore, 'the snapshot key must move');
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, null, 'the grace is gone');
});

// ---------------------------------------------------------------------------
// Terminal phases + voluntary leave
// ---------------------------------------------------------------------------

test('v24 no grace starts in a terminal phase, and no transfer happens there', () => {
  const store = makeStore({ phase: 'ACTIVE', durationSeconds: 10 });
  store.alarmTick(T0 + 11000); // endsAt reached -> COMPLETED
  assert.equal(store.room.phase, 'COMPLETED');
  const dropped = disconnectSeat(store, 'h1', 'network-lost', T0 + 12000);
  assert.equal(transferredEvents(dropped.events).length, 0);
  assert.equal(store.snapshotFor('r1', T0 + 12000).hostGraceEndsAtMs, null, 'no grace starts in a terminal phase');
  assert.equal(store.state.hostGrace, null);
  const r = store.succeedHostAfterDisconnect('h1', T0 + 12000);
  assert.equal(r.transferred, false);
  assert.equal(store.room.hostPlayerId, 'h1');
});

test('v24 match completing during a grace clears the grace (no transfer, host keeps host)', async () => {
  const store = makeStore({ phase: 'ACTIVE', durationSeconds: 10 });
  disconnectSeat(store, 'h1', 'network-lost', T0 + 2000);
  assert.equal(store.snapshotFor('r1', T0 + 2000).hostGraceEndsAtMs, T0 + 32000);
  // The match ends (endsAt T0+10000) while the grace is still running.
  // completeMatch clears the grace with its own events — no transfer.
  const tick = store.alarmTick(T0 + 11000);
  assert.equal(store.room.phase, 'COMPLETED');
  assert.equal(transferredEvents(tick.events).length, 0, 'completing the match must not transfer host');
  assert.equal(store.room.hostPlayerId, 'h1');
  assert.equal(store.snapshotFor('r1', T0 + 11000).hostGraceEndsAtMs, null, 'the grace is gone with the match');
});

test('v24 voluntary host leave during a grace is immediate (no grace survives a leave)', () => {
  const store = makeStore();
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, T0 + 31000);
  // The host comes back, then leaves voluntarily: immediate succession.
  store.resumeOnHello('h1', T0 + 5000);
  assert.equal(store.snapshotFor('r1', T0 + 5000).hostGraceEndsAtMs, null, 'the return cancelled the grace');
  const left = store.leaveSeat('h1', null, T0 + 6000);
  const moved = transferredEvents(left.events);
  assert.equal(moved.length, 1, 'voluntary leave transfers immediately');
  assert.equal(moved[0].payload['newHostPlayerId'], 'r1');
  assert.equal(store.room.hostPlayerId, 'r1');
  assert.equal(store.state.hostGrace, null, 'no grace survives a leave');
});

test('v24 no grace survives a leave even when one is somehow recorded for the leaver', () => {
  // Defensive: a grace recorded for the host at leave time (a state
  // that should not normally arise) must die with the leave.
  const store = makeStore({ grace: { hostPlayerId: 'h1', endsAtMs: T0 + 31000 } });
  store.player('h1').connectionState = 'suspended';
  const left = store.leaveSeat('h1', null, T0 + 1000);
  assert.equal(transferredEvents(left.events).length, 1, 'the leave still transfers immediately');
  assert.equal(store.room.hostPlayerId, 'r1');
  assert.equal(store.state.hostGrace, null, 'no grace survives a leave');
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, null);
});

test('v24 room emptying during a grace ends terminal with no transfer and no grace', () => {
  const store = makeStore();
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, T0 + 31000);
  store.leaveSeat('r1', null, T0 + 2000);
  store.leaveSeat('r2', null, T0 + 3000);
  store.leaveSeat('hu1', null, T0 + 4000);
  // The host leaves last: the room empties to EXPIRED, terminal.
  const last = store.leaveSeat('h1', null, T0 + 5000);
  assert.equal(store.room.phase, 'EXPIRED');
  assert.equal(store.state.hostGrace, null, 'no grace survives the room ending');
  assert.equal(transferredEvents(last.events).length, 0, 'with nobody left there is no one to transfer to');
});

// ---------------------------------------------------------------------------
// F1 (v24 fix round) — a tab-hidden host NEVER transfers from the
// suspended-host re-trigger: `succeedHostIfSuspended` may transfer
// only on an EXPIRED grace recorded for this host. Tab-hidden /
// screen-locked / unknown never start a grace, so without one the
// re-trigger (alarm tick or another seat's resume) must be a no-op.
// ---------------------------------------------------------------------------

test('F1 tab-hidden host + alarm tick: host KEEPS host, no transfer — even long past 30 s', () => {
  const store = makeStore();
  const hid = store.suspendSeat('h1', 'tab-hidden', T0 + 1000);
  assert.equal(transferredEvents(hid.events).length, 0, 'the tab-hidden suspend itself must not transfer');
  assert.equal(store.state.hostGrace, null, 'tab-hidden starts no grace');
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, null);
  assert.notEqual(store.verifyHost('h1', 'host-hash'), null, 'the host token survives the tab-hidden suspend');
  // A tick 1 s later (the live cadence) transfers nothing…
  const tick1 = store.alarmTick(T0 + 2000);
  assert.equal(transferredEvents(tick1.events).length, 0, 'the tick must not transfer a tab-hidden host');
  assert.equal(store.room.hostPlayerId, 'h1');
  // …and neither does a tick past 30 s, or 60 s: with no grace
  // recorded there is no deadline that can ever expire into a
  // transfer. (Before F1, the first tick transferred here.)
  const tick30 = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(tick30.events).length, 0, 'no grace, no expiry, no transfer — even at 30 s');
  const tick60 = store.alarmTick(T0 + 61000);
  assert.equal(transferredEvents(tick60.events).length, 0, 'still no transfer at 60 s');
  assert.equal(store.room.hostPlayerId, 'h1', 'the tab-hidden host keeps host');
  assert.equal(store.player('h1').isHost, true);
  assert.equal(store.state.hostGrace, null, 'no grace ever appeared');
  assert.notEqual(store.verifyHost('h1', 'host-hash'), null, 'the host token is intact');
});

test('F1 tab-hidden host + another seat resumes (resumeOnHello re-trigger): host KEEPS host, no transfer', () => {
  const store = makeStore();
  store.suspendSeat('h1', 'tab-hidden', T0 + 1000);
  // A second seat is suspended too, so its resume is the re-trigger:
  // before F1, `resumeOnHello` transferred host to it on the spot.
  store.suspendSeat('r1', 'tab-hidden', T0 + 1500);
  const back = store.resumeOnHello('r1', T0 + 2000);
  assert.equal(back.resumed, true, 'the resuming seat must still resume');
  assert.equal(transferredEvents(back.events).length, 0, 'the resume must not transfer the tab-hidden host');
  assert.equal(store.room.hostPlayerId, 'h1', 'the tab-hidden host keeps host');
  assert.equal(store.player('r1').connectionState, 'connected');
  // A hello from a seat that was never suspended also re-triggers —
  // and must also transfer nothing.
  const hello = store.resumeOnHello('r2', T0 + 2500);
  assert.equal(hello.resumed, false, 'a connected seat has nothing to resume');
  assert.equal(transferredEvents(hello.events).length, 0, 'a plain hello must not transfer the tab-hidden host');
  assert.equal(store.room.hostPlayerId, 'h1');
  // And a later tick stays quiet too.
  const tick = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(tick.events).length, 0);
  assert.equal(store.room.hostPlayerId, 'h1');
});

test('F1 tab-hidden host who THEN loses the network still transfers at grace expiry (no-grace no-op must not swallow a later actually-gone suspend)', () => {
  const store = makeStore();
  store.suspendSeat('h1', 'tab-hidden', T0 + 1000);
  const tick1 = store.alarmTick(T0 + 2000);
  assert.equal(transferredEvents(tick1.events).length, 0, 'tab-hidden alone transfers nothing');
  // The socket now really drops while already suspended: the grace
  // starts (the v24 follow-up case), and the host keeps host until
  // it expires.
  const dropped = disconnectSeat(store, 'h1', 'network-lost', T0 + 3000);
  assert.equal(transferredEvents(dropped.events).length, 0, 'the grace start transfers nothing');
  assert.equal(store.snapshotFor('r1', T0 + 3000).hostGraceEndsAtMs, T0 + 33000);
  const early = store.alarmTick(T0 + 32000);
  assert.equal(transferredEvents(early.events).length, 0, 'inside the grace, no transfer');
  assert.equal(store.room.hostPlayerId, 'h1');
  // At the deadline the expired-grace branch transfers — via the
  // re-trigger in this same tick, before the expiry step runs.
  const moved = store.alarmTick(T0 + 33000);
  assert.equal(transferredEvents(moved.events).length, 1, 'the expired grace must still transfer');
  assert.equal(moved.events.filter((e) => e.type === 'host.transferred')[0].payload['newHostPlayerId'], 'r1');
  assert.equal(store.room.hostPlayerId, 'r1');
});

// ---------------------------------------------------------------------------
// v24 fix round — F3 (S8 recovery), F2 (READY_CHECK), F4 (fix resume),
// Finding 5 (manual transfer), F7 (join-restore after a transfer)
// ---------------------------------------------------------------------------

test('F3 (S8 recovery) grace expires with no successor, then a suspended seat resumes: host transfers to it exactly once', () => {
  const store = makeStore();
  store.suspendSeat('r1', 'tab-hidden', T0 + 500);
  store.suspendSeat('r2', 'tab-hidden', T0 + 600);
  store.suspendSeat('hu1', 'tab-hidden', T0 + 700);
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  const tick = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(tick.events).length, 0, 'no successor at expiry, so no transfer');
  assert.deepEqual(
    store.state.hostGrace,
    { hostPlayerId: 'h1', endsAtMs: T0 + 31000 },
    'the lapsed record must stand after the no-successor expiry',
  );
  // A seat resumes later: the re-trigger must transfer to it — the
  // room recovers instead of staying hostless forever.
  const back = store.resumeOnHello('r1', T0 + 40000);
  assert.equal(back.resumed, true, 'the resuming seat must still resume');
  const transfers = transferredEvents(back.events);
  assert.equal(transfers.length, 1, 'the resume re-trigger must transfer exactly once');
  assert.equal(transfers[0].payload['previousHostPlayerId'], 'h1');
  assert.equal(transfers[0].payload['newHostPlayerId'], 'r1');
  assert.equal(store.room.hostPlayerId, 'r1', 'the resumed seat becomes host');
  assert.equal(store.state.hostGrace, null, 'the completed transfer clears the lapsed record');
  // And a later tick stays quiet — one transfer, never two.
  const later = store.alarmTick(T0 + 41000);
  assert.equal(transferredEvents(later.events).length, 0, 'no second transfer after the recovery');
  assert.equal(store.room.hostPlayerId, 'r1');
});

test('F3 (S8 recovery) a fresh joiner arriving in the lapsed state gets host on the next tick', async () => {
  const store = makeStore();
  store.suspendSeat('r1', 'tab-hidden', T0 + 500);
  store.suspendSeat('r2', 'tab-hidden', T0 + 600);
  store.suspendSeat('hu1', 'tab-hidden', T0 + 700);
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  const tick = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(tick.events).length, 0, 'no successor at expiry, so no transfer');
  assert.deepEqual(
    store.state.hostGrace,
    { hostPlayerId: 'h1', endsAtMs: T0 + 31000 },
    'the lapsed record must stand after the no-successor expiry',
  );
  // A fresh joiner arrives while the room is hostless-but-lapsed.
  const joined = await store.addPlayerAsync({
    displayName: 'Newcomer',
    roomCode: 'ABCDEF',
    reconnectTokenHash: null,
    nowMs: T0 + 35000,
  });
  assert.equal(joined.ok, true, `the fresh join must succeed: ${joined.ok ? '' : joined.error}`);
  assert.equal(joined.value.restored, false, 'this is a new seat, not a restore');
  assert.equal(transferredEvents(joined.events).length, 0, 'the join itself transfers nothing');
  const newcomerId = joined.value.player.playerId;
  assert.equal(store.room.hostPlayerId, 'h1', 'host is still the dead host until the next tick');
  // The next tick re-triggers on the standing lapsed record and
  // crowns the only connected seat — the fresh joiner.
  const moved = store.alarmTick(T0 + 36000);
  const transfers = transferredEvents(moved.events);
  assert.equal(transfers.length, 1, 'the next tick must transfer exactly once');
  assert.equal(transfers[0].payload['newHostPlayerId'], newcomerId, 'the fresh joiner becomes host');
  assert.equal(store.room.hostPlayerId, newcomerId);
  assert.equal(store.state.hostGrace, null, 'the completed transfer clears the lapsed record');
});

test('F2 host disconnects during READY_CHECK: grace expiry transfers on the tick at the deadline', () => {
  const store = makeStore({ phase: 'READY_CHECK' });
  assert.equal(store.room.phase, 'READY_CHECK');
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, T0 + 31000);
  // A tick inside the window transfers nothing…
  const early = store.alarmTick(T0 + 30000);
  assert.equal(transferredEvents(early.events).length, 0, 'inside the grace, no transfer');
  assert.equal(store.room.hostPlayerId, 'h1');
  // …and the tick AT the deadline transfers (READY_CHECK is in the
  // expiry allow-list, like LOBBY and the live phases).
  const moved = store.alarmTick(T0 + 31000);
  const transfers = transferredEvents(moved.events);
  assert.equal(transfers.length, 1, 'the READY_CHECK expiry must transfer exactly once');
  assert.equal(transfers[0].payload['newHostPlayerId'], 'r1');
  assert.equal(store.room.hostPlayerId, 'r1');
  assert.equal(store.state.hostGrace, null, 'the completed transfer clears the grace');
});

test('F4 a suspended host who resumes on a location.update cancels the grace (defence-in-depth)', async () => {
  const store = makeStore();
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, T0 + 31000);
  // The host's client sends a fix while suspended: the seat resumes
  // (the fix handler) and the grace must be cancelled with it,
  // exactly like `resumeOnHello` and the join-path restore do.
  const fix = await sendFix(store, 'h1', T0 + 20000);
  assert.equal(
    fix.events.some((e) => e.type === 'player.resumed'),
    true,
    'the fix must resume the suspended host',
  );
  assert.equal(transferredEvents(fix.events).length, 0, 'the fix resume must not transfer');
  assert.equal(store.room.hostPlayerId, 'h1', 'the resumed host keeps host');
  assert.equal(store.player('h1').isHost, true);
  assert.equal(store.state.hostGrace, null, 'the grace is cancelled on the fix resume');
  assert.equal(store.snapshotFor('r1', T0 + 20000).hostGraceEndsAtMs, null);
  // A later tick must not transfer either — there is no grace left.
  const tick = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(tick.events).length, 0, 'no transfer after a cancelled grace');
  assert.equal(store.room.hostPlayerId, 'h1');
});

test('Finding 5 manual transferHost clears a running grace', () => {
  const store = makeStore();
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, T0 + 31000);
  // The (suspended) host manually hands host to r1 with its token —
  // `verifyHost` does not check connection state, so this succeeds.
  const moved = store.transferHost({
    playerId: 'h1',
    hostTokenHash: 'host-hash',
    newHostPlayerId: 'r1',
    nowMs: T0 + 5000,
  });
  assert.equal(moved.ok, true, `the manual transfer must succeed: ${moved.ok ? '' : moved.error}`);
  assert.equal(transferredEvents(moved.events).length, 1, 'the manual transfer emits its transfer');
  assert.equal(store.room.hostPlayerId, 'r1', 'r1 is host now');
  assert.equal(store.state.hostGrace, null, 'no grace survives a manual transfer');
  assert.equal(store.snapshotFor('r1', T0 + 5000).hostGraceEndsAtMs, null);
  // A later tick stays quiet — no stale deadline can transfer
  // anything away from the new host.
  const tick = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(tick.events).length, 0);
  assert.equal(store.room.hostPlayerId, 'r1');
});

test('F7 host transfers at grace expiry, then the old host returns via join-path restore: regular player, no flip-back, same seat', async () => {
  const store = makeStore();
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  const moved = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(moved.events).length, 1, 'the expiry must transfer');
  assert.equal(store.room.hostPlayerId, 'r1');
  assert.equal(store.player('h1').isHost, false, 'the old host is a regular player after the transfer');
  const seatsBefore = store.state.players.length;
  // The old host returns by name + reconnect token — the join-path
  // restore, NOT `resumeOnHello`.
  const restored = await store.addPlayerAsync({
    displayName: 'Host',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-h1',
    nowMs: T0 + 40000,
  });
  assert.equal(restored.ok, true, `the restore must succeed: ${restored.ok ? '' : restored.error}`);
  assert.equal(restored.value.restored, true, 'the old host restores its own seat');
  assert.equal(transferredEvents(restored.events).length, 0, 'the restore must not emit a transfer');
  assert.equal(store.room.hostPlayerId, 'r1', 'the successor stays host — no flip-back');
  assert.equal(restored.value.player.isHost, false, 'the restored old host is a regular player');
  assert.equal(store.player('h1').isHost, false);
  assert.equal(store.player('h1').connectionState, 'connected', 'the restored seat is connected again');
  assert.equal(store.state.players.length, seatsBefore, 'the restore reuses the seat — no duplicate is created');
  assert.equal(
    store.state.players.filter((p) => p.playerId === 'h1').length,
    1,
    'exactly one h1 seat exists',
  );
  assert.equal(store.verifyHost('h1', 'host-hash'), null, 'the old host token died with the transfer');
  // A later tick stays quiet — nothing flips back.
  const tick = store.alarmTick(T0 + 41000);
  assert.equal(transferredEvents(tick.events).length, 0);
  assert.equal(store.room.hostPlayerId, 'r1');
});

test('F4 RESOLVING waits out the resolve: no transfer from the re-trigger or the expiry step', () => {
  // Hand-built RESOLVING state with an expired grace still recorded
  // (completeMatch transitions synchronously, so this state is only
  // reachable as a defensive case — the guard must agree with
  // `expireHostGrace`, which already refuses RESOLVING).
  // v28: a tick on a RESTING RESOLVING room now finishes it
  // (RESOLVING → COMPLETED, the backstop) instead of leaving it
  // ticking at 30 s forever — but the finish is still not a
  // transfer: no `host.transferred` is emitted, the host stays h1,
  // and the grace is cleared because the match is over (exactly as
  // `completeMatch` clears it), not transferred. The two expiry
  // paths below still agree: neither transfers during the resolve.
  const store = makeStore({ phase: 'RESOLVING', grace: { hostPlayerId: 'h1', endsAtMs: T0 + 31000 } });
  store.player('h1').connectionState = 'suspended';
  const tick = store.alarmTick(T0 + 31000);
  assert.equal(transferredEvents(tick.events).length, 0, 'RESOLVING must not transfer on the tick');
  assert.equal(store.room.phase, 'COMPLETED', 'the resting RESOLVING room must complete on the tick');
  assert.equal(store.room.hostPlayerId, 'h1', 'the host keeps host through the resolve — completion is not a transfer');
  assert.equal(
    store.state.hostGrace,
    null,
    'the grace is cleared because the match is over (as in completeMatch), not transferred',
  );
  // The resume re-trigger agrees: still no transfer while RESOLVING.
  // (The room is terminal now, so the re-trigger is a no-op either way.)
  store.suspendSeat('r1', 'tab-hidden', T0 + 31500);
  const back = store.resumeOnHello('r1', T0 + 32000);
  assert.equal(back.resumed, true, 'the resuming seat must still resume');
  assert.equal(
    transferredEvents(back.events).length,
    0,
    'the resume re-trigger must not transfer during RESOLVING',
  );
  assert.equal(store.room.hostPlayerId, 'h1');
});
