import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { hashHostToken } = await import('../src/auth.ts');
const sharedNs = await import('@pakdam/shared');
const { DEFAULT_ROOM_CONFIG } = sharedNs;

// v23 host/lobby rules (founder decisions, 2026-11-21 ~12:36 IST):
//   R1 — if the host cancels the match, the lobby is deleted.
//   R2 — if the host gets disconnected, the player who joined the lobby
//        first after the host automatically becomes the host (next
//        earliest joiner if that player has also left).
//
// AS BUILT (Kabir, server, landed 2026-11-21 ~07:14 UTC; Meera, web,
// ~07:13–07:17 UTC) — this file tests the STORE half of that contract:
//   R1: `cancelMatch` is the deleter (store) — phase CANCELLED,
//       result built, `state.deleted = true`, and exactly ONE event:
//       a literal `'room.deleted'` with `{ result }` to every seat.
//       NO `match.cancelled` from the store. Every later op refuses
//       with 404 ROOM_NOT_FOUND ('This room has been deleted.') via
//       `isDeleted()` — snapshot, results, replay, lifecycle, and all
//       host-token checks (`verifyHost` returns null). The RoomDO class
//       (`deleteRoomAfterHostCancel`, only from `lifecycle` / `end`)
//       translates the signal into the delivered stream
//       (`match.cancelled` synthesised FIRST, then `room.deleted`,
//       then the `room.state` notice with reason `'room-deleted'`
//       LAST), persists the cancel record, unregisters the invite
//       code, closes every socket (1000, 'room deleted'), wipes DO
//       storage and drops the store — later ops answer ROOM_NOT_FOUND
//       at the class too. That composition is covered at class level
//       in v23-host-rules-do.test.mjs; the store half is here.
//   R2: succession lives in `suspendSeat`, gated on the REASON —
//       `'network-lost'` (socket close) and `'heartbeat-timeout'`
//       (alarm) are "actually gone" and transfer a suspended host;
//       `'tab-hidden'`, `'screen-locked'` and `'unknown'` NEVER
//       transfer (a host switching tabs or locking the screen keeps
//       host). A seat already suspended still succeeds when the socket
//       then closes (tab hidden first, socket closed after). Transfer
//       itself is `succeedHostAfterDisconnect`: remaining seats
//       (`leftAt === null`) that are NOT suspended, excluding the gone
//       host, by `joinedAt` ascending, first wins. Role / caught /
//       ejected are NOT consulted — a caught/spectating (connected)
//       earliest joiner still becomes host. The old host's token is
//       deleted; the successor mints a fresh token via
//       `issue-host-token`. One-way and sticky: `resumeOnHello` never
//       touches `isHost`, so a reconnected old host resumes as a
//       regular player. No-op when the seat is not host, is not
//       suspended, the phase is terminal, or nobody remains.
//       SAME-BATCH AMEND: two seats dropping in one batch share one
//       `nowMs`; when the seat that JUST received host drops in the
//       same batch, the succession AMENDS the one `host.transferred`
//       already emitted (new host rewritten) instead of emitting a
//       second — exactly one transfer per simultaneous disconnect,
//       naming the final host. A later drop with a DIFFERENT `nowMs`
//       is a separate batch and emits a fresh transfer.
//
// v24 AMENDMENT (founder decision D1, 2026-11-21) — the timing
// changed, the rule did not: an actually-gone host suspend NO LONGER
// transfers immediately. It starts a 30 s reconnect grace
// (`HOST_RECONNECT_GRACE_MS`); the transfer happens at grace expiry
// (an `alarmTick` at/after the deadline) if the host has not returned.
// Every R2/S6/S8 test below that used to assert a transfer on
// `suspendSeat` now drives the transfer via `expireGrace` (an
// `alarmTick` at the deadline) instead. The transfer rule itself is
// unchanged and still pinned here: earliest-joined connected player
// wins (join order only, suspended seats skipped), the old host's
// token is deleted, a late return never flips host back, and a
// voluntary leave still transfers immediately (no grace).
// The new grace behaviour itself (return inside/outside the window,
// one grace only, lobby + live, DO eviction, snapshot deadline) is
// covered in v24-host-grace.test.mjs.
//
// Harness mirrors v18-server.test.mjs (RoomStore direct, no DO ctx,
// no network) with staggered `joinedAt` so join order is explicit.
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

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
 * Roster is given in JOIN ORDER (host first); `joinedAt` is staggered
 * 1 s apart from T0 - 5000 so "earliest-joined" is unambiguous. Default
 * roster: host h1, runners r1, r2, hunter hu1 — r1 is the earliest
 * joiner after the host.
 */
function makeStore({
  roster = [
    { id: 'h1', name: 'Host', host: true },
    { id: 'r1', name: 'Runner 1' },
    { id: 'r2', name: 'Runner 2' },
    { id: 'hu1', name: 'Hunter 1' },
  ],
  hunters = ['hu1'],
  durationSeconds = 3600,
} = {}) {
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
  const players = roster.map((seat, i) =>
    player(seat.id, seat.name, seat.host === true, T0 - 5000 + i * 1000),
  );
  const state = {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase: 'LOBBY',
      version: 1,
      config,
      createdAt: new Date(T0 - 5000).toISOString(),
      startedAt: null,
      endsAt: null,
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

function snapshot(store, playerId, atMs) {
  return store.getStateOp({
    playerId,
    reconnectTokenHash: `reconnect-hash-${playerId}`,
    nowMs: atMs,
  });
}

function hostCancel(store, atMs) {
  return store.lifecycleOp({
    action: 'end',
    playerId: 'h1',
    hostTokenHash: 'host-hash',
    nowMs: atMs,
  });
}

function transferredEvents(events) {
  return events.filter((e) => e.type === 'host.transferred');
}

/**
 * Mirror the class's "actually gone" path for one seat: a single
 * `suspendSeat` with a disconnect reason. v24: NO succession runs
 * inside it anymore — an actually-gone HOST suspend starts the 30 s
 * reconnect grace instead (see `expireGrace` to drive the transfer).
 * `transferred` is derived from the emitted events, because
 * `suspendSeat` does not return the flag. `batchId` mirrors the class
 * sweep/alarm: drops that share one batch share one id; a lone drop
 * passes none (fresh id per call).
 */
function disconnectSeat(store, playerId, reason, nowMs, batchId) {
  const s = store.suspendSeat(playerId, reason, nowMs, batchId);
  return {
    events: s.events,
    transferred: s.events.some((e) => e.type === 'host.transferred'),
  };
}

/**
 * v24 — expire the host grace: run the tick AT the grace deadline.
 * The transfer (if any) is in the tick's events. In the lobby the
 * tick is 30 s, so the class arms a one-shot alarm at the deadline
 * (see the DO tests) — at store level the tick IS the expiry driver.
 */
function expireGrace(store, atMs) {
  const tick = store.alarmTick(atMs);
  return transferredEvents(tick.events);
}

// ---------------------------------------------------------------------------
// R1 — host cancel deletes the room (store half: cancel + notice)
// ---------------------------------------------------------------------------

test('v23 (R1) host cancel from a live match deletes the room: one room.deleted, snapshot + replay + results refuse', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  const r = hostCancel(store, T0 + 5000);
  assert.equal(r.ok, true, `host cancel must succeed: ${r.ok ? '' : r.error}`);
  assert.equal(store.room.phase, 'CANCELLED');
  assert.ok(store.room.result !== null, 'the cancel still records a result (audit)');
  assert.equal(store.room.result.outcome, 'cancelled');
  assert.equal(store.state.deleted, true, 'the room must be marked deleted');
  // Exactly one event, the room-deleted signal, to every seat — and
  // NO match.cancelled from the store (the class synthesises that one
  // when it translates the signal into the delivered stream).
  assert.equal(r.events.length, 1, 'cancel must emit exactly one event');
  assert.equal(r.events[0].type, 'room.deleted');
  assert.equal(r.events[0].payload['result'], store.room.result, 'the signal carries the result');
  assert.deepEqual(
    [...r.events[0].recipients].sort(),
    ['h1', 'hu1', 'r1', 'r2'].sort(),
    'room.deleted must reach every remaining player',
  );
  // The room is gone: snapshot, results and replay all refuse 404…
  const snap = snapshot(store, 'r1', T0 + 6000);
  assert.equal(snap.ok, false, 'snapshot fetch after deletion must fail');
  assert.equal(snap.code, 'ROOM_NOT_FOUND');
  assert.equal(snap.status, 404);
  const results = store.resultsFor({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 6000,
  });
  assert.equal(results.ok, false, 'results after deletion must fail');
  assert.equal(results.code, 'ROOM_NOT_FOUND');
  const replayed = store.replayMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 6000 });
  assert.equal(replayed.ok, false, 'replay after deletion must fail');
  assert.equal(replayed.code, 'ROOM_NOT_FOUND');
  // …and a second cancel refuses too (deleted, not "already cancelled").
  const again = hostCancel(store, T0 + 7000);
  assert.equal(again.ok, false, 'a second cancel after deletion must fail');
  assert.equal(again.code, 'ROOM_NOT_FOUND');
  assert.equal(again.status, 404);
});

test('v23 (R1) host cancel from the LOBBY before start deletes the lobby too', () => {
  const store = makeStore();
  const r = hostCancel(store, T0 + 1000);
  assert.equal(r.ok, true, `host cancel from the lobby must succeed: ${r.ok ? '' : r.error}`);
  assert.equal(store.room.phase, 'CANCELLED', 'LOBBY -> CANCELLED is a legal edge');
  assert.equal(store.state.deleted, true);
  assert.equal(r.events.length, 1, 'lobby cancel emits exactly the room.deleted signal');
  assert.equal(r.events[0].type, 'room.deleted');
  assert.deepEqual(
    [...r.events[0].recipients].sort(),
    ['h1', 'hu1', 'r1', 'r2'].sort(),
    'the deletion signal must reach every lobby seat',
  );
  const snap = snapshot(store, 'r1', T0 + 2000);
  assert.equal(snap.ok, false, 'snapshot fetch after lobby deletion must fail');
  assert.equal(snap.code, 'ROOM_NOT_FOUND');
  const replayed = store.replayMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 2000 });
  assert.equal(replayed.ok, false, 'replay after lobby deletion must fail');
});

test('v23 (R1) non-host cancel is still 403 and the room survives', () => {
  const store = makeStore();
  const r = store.lifecycleOp({
    action: 'end',
    playerId: 'r1',
    hostTokenHash: null,
    nowMs: T0 + 1000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FORBIDDEN');
  assert.equal(r.status, 403);
  assert.equal(store.room.phase, 'LOBBY', 'a denied cancel must change nothing');
  const snap = snapshot(store, 'r1', T0 + 2000);
  assert.equal(snap.ok, true, 'the room must survive a non-host cancel');
});

test('v23 (R1) the trailing deletion notice is a room.state broadcast (distinct from the room.deleted signal)', () => {
  const store = makeStore();
  const notice = store.roomDeletedNotice(T0 + 1000);
  assert.equal(notice.type, 'room.state');
  assert.equal(notice.payload['reason'], 'room-deleted');
  assert.equal(notice.payload['phase'], 'LOBBY');
  assert.equal(typeof notice.payload['version'], 'number');
  // The notice is NOT the signal: cancel emits room.deleted, and the
  // class appends this room.state notice last in the delivered stream.
  const r = hostCancel(store, T0 + 2000);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'room.deleted');
  assert.notEqual(r.events[0].type, notice.type);
  // Every seat gets the notice — including a suspended one, which
  // still needs to learn the room is gone.
  const store2 = makeStore();
  start(store2);
  store2.alarmTick(T0 + 1000);
  store2.suspendSeat('r2', 'network-lost', T0 + 2000);
  const notice2 = store2.roomDeletedNotice(T0 + 3000);
  assert.ok(
    notice2.recipients.includes('r2'),
    'the notice must also reach a suspended seat',
  );
});

// ---------------------------------------------------------------------------
// R2 — automatic host succession on host disconnect (store half)
// ---------------------------------------------------------------------------

test('v23 (R2) a bare suspend NEVER transfers host (tab-hidden / screen-locked / unknown keep host)', () => {
  for (const reason of ['tab-hidden', 'screen-locked', 'unknown']) {
    const s = makeStore();
    const r = s.suspendSeat('h1', reason, T0 + 1000);
    assert.equal(
      transferredEvents(r.events).length,
      0,
      `suspendSeat alone (${reason}) must not transfer host`,
    );
    assert.equal(s.room.hostPlayerId, 'h1', `host must stay h1 after a bare ${reason} suspend`);
    assert.equal(s.player('h1').isHost, true);
    // F6 (v24 fix round) — the name must hold past the suspend
    // itself: a later alarm tick and another seat's resume are the
    // re-triggers, and neither may transfer a merely-hidden host.
    // (Before F6 this test stopped at the suspend, so the name was
    // unproven past it; the v24 F1 tests cover the same behaviour,
    // this makes the v23 test's name true.)
    const tick = s.alarmTick(T0 + 31000);
    assert.equal(
      transferredEvents(tick.events).length,
      0,
      `a tick past 30 s must not transfer a ${reason} host`,
    );
    assert.equal(s.room.hostPlayerId, 'h1', `host must stay h1 after a tick past 30 s (${reason})`);
    assert.equal(s.player('h1').isHost, true);
    s.suspendSeat('r1', 'tab-hidden', T0 + 31500);
    const back = s.resumeOnHello('r1', T0 + 32000);
    assert.equal(back.resumed, true, 'the resuming seat must still resume');
    assert.equal(
      transferredEvents(back.events).length,
      0,
      `another seat resuming must not transfer a ${reason} host`,
    );
    assert.equal(s.room.hostPlayerId, 'h1', `host must stay h1 after another seat resumes (${reason})`);
    assert.equal(s.player('h1').isHost, true);
    assert.equal(s.state.hostGrace, null, `no grace ever appears for a ${reason} suspend`);
  }
});

test('v24 (R2) an already-suspended host starts ONE grace when the socket then closes (deadline from the network drop)', () => {
  const store = makeStore();
  const hidden = store.suspendSeat('h1', 'tab-hidden', T0 + 1000);
  assert.equal(transferredEvents(hidden.events).length, 0, 'tab-hidden keeps host');
  assert.equal(store.player('h1').connectionState, 'suspended');
  assert.equal(store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs, null, 'tab-hidden starts no grace');
  // v24: the later socket close starts the grace instead of
  // transferring — one grace, from the network-drop moment.
  const closed = store.suspendSeat('h1', 'network-lost', T0 + 2000);
  assert.equal(transferredEvents(closed.events).length, 0, 'the socket close must NOT transfer yet — the grace runs first');
  assert.equal(store.room.hostPlayerId, 'h1', 'the host keeps host during the grace');
  assert.equal(
    store.snapshotFor('r1', T0 + 2000).hostGraceEndsAtMs,
    T0 + 32000,
    'exactly one grace, deadline 30 s after the network drop (not the tab-hide)',
  );
  const moved = expireGrace(store, T0 + 32000);
  assert.equal(moved.length, 1, 'the grace expiry must transfer host exactly once');
  assert.equal(moved[0].payload['newHostPlayerId'], 'r1');
  assert.equal(store.room.hostPlayerId, 'r1');
  // The suspension itself emitted only once (on the tab-hidden call).
  const suspendedCount = [...hidden.events, ...closed.events].filter(
    (e) => e.type === 'player.suspended',
  ).length;
  assert.equal(suspendedCount, 1, 'player.suspended must not emit twice for one seat');
});

test('v24 (R2) host socket-close suspend starts a grace; the expiry transfers host to the earliest-joined remaining player', () => {
  const store = makeStore();
  const r = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(r.transferred, false, 'v24: the suspend must NOT transfer yet — the grace runs first');
  assert.equal(store.room.hostPlayerId, 'h1', 'the host keeps host during the grace');
  assert.equal(
    store.snapshotFor('r1', T0 + 1000).hostGraceEndsAtMs,
    T0 + 31000,
    'the snapshot carries the grace deadline (30 s after the drop)',
  );
  const moved = expireGrace(store, T0 + 31000);
  assert.equal(moved.length, 1, 'exactly one host.transferred must be emitted at expiry');
  assert.equal(moved[0].payload['previousHostPlayerId'], 'h1');
  assert.equal(moved[0].payload['newHostPlayerId'], 'r1', 'the earliest joiner after the host must become host');
  assert.deepEqual(
    [...moved[0].recipients].sort(),
    ['h1', 'hu1', 'r1', 'r2'].sort(),
    'host.transferred must reach every seat',
  );
  assert.equal(store.room.hostPlayerId, 'r1');
  assert.equal(store.player('r1').isHost, true);
  assert.equal(store.player('h1').isHost, false);
  assert.equal(
    store.snapshotFor('r1', T0 + 31000).hostGraceEndsAtMs,
    null,
    'the grace is gone after the transfer',
  );
  // The old host is suspended, not removed: still in the room, still
  // resumable — only the host flag moved. The old host token is dead.
  assert.equal(store.player('h1').leftAt, null);
  assert.equal(store.player('h1').connectionState, 'suspended');
  assert.equal(store.state.hostTokens['h1'], undefined, 'the old host token must be deleted');
});

test('v24 (R2) host heartbeat-timeout suspend also starts a grace; the expiry transfers host', () => {
  const store = makeStore();
  const r = disconnectSeat(store, 'h1', 'heartbeat-timeout', T0 + 1000);
  assert.equal(r.transferred, false, 'v24: the suspend must NOT transfer yet');
  const moved = expireGrace(store, T0 + 31000);
  assert.equal(moved.length, 1, 'the alarm heartbeat path must transfer host exactly like a socket close, at expiry');
  assert.equal(moved[0].payload['newHostPlayerId'], 'r1');
  assert.equal(store.room.hostPlayerId, 'r1');
});

test('v23 (R2) next-earliest joiner becomes host when the earliest joiner also left', () => {
  const store = makeStore();
  const left = store.leaveSeat('r1', null, T0 + 500);
  assert.equal(
    transferredEvents(left.events).length,
    0,
    'a non-host leaving must not transfer host',
  );
  const r = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(r.transferred, false, 'v24: the suspend starts the grace, it does not transfer');
  const moved = expireGrace(store, T0 + 31000);
  assert.equal(moved.length, 1);
  assert.equal(
    moved[0].payload['newHostPlayerId'],
    'r2',
    'with the earliest joiner gone, the next earliest joiner must become host',
  );
  assert.equal(store.room.hostPlayerId, 'r2');
});

test('v23 (R2) a caught/spectating earliest joiner still becomes host', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const tagged = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-1', T0 + 3000);
  assert.ok(tagged.events.some((e) => e.type === 'catch.confirmed'), 'r1 must be caught first');
  assert.ok(store.caughtRunnerIds().includes('r1'), 'r1 is a caught runner (spectating)');
  const r = disconnectSeat(store, 'h1', 'network-lost', T0 + 4000);
  assert.equal(r.transferred, false, 'v24: the suspend starts the grace, it does not transfer');
  // Fresh fixes just before the expiry tick: without them the
  // missing-fix ejection (4a) would eject the silent seats in the
  // same tick as the transfer, which is not what this test is about.
  await sendFix(store, 'r1', T0 + 33000);
  await sendFix(store, 'r2', T0 + 33000);
  await sendFix(store, 'hu1', T0 + 33000);
  const moved = expireGrace(store, T0 + 34000);
  assert.equal(moved.length, 1);
  assert.equal(
    moved[0].payload['newHostPlayerId'],
    'r1',
    'succession is by join order, not role/alive — a caught runner still becomes host',
  );
  assert.equal(store.room.hostPlayerId, 'r1');
  // And the caught new host can mint a host token.
  const minted = await store.issueHostToken({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 5000,
  });
  assert.equal(minted.ok, true, `the successor must be able to mint a host token: ${minted.ok ? '' : minted.error}`);
});

test('v23 (R2) host disconnect with only one other player left makes that player host', () => {
  const store = makeStore({
    roster: [
      { id: 'h1', name: 'Host', host: true },
      { id: 'r1', name: 'Runner 1' },
    ],
    hunters: [],
  });
  const r = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(r.transferred, false, 'v24: the suspend starts the grace, it does not transfer');
  const moved = expireGrace(store, T0 + 31000);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].payload['newHostPlayerId'], 'r1');
  assert.equal(store.room.hostPlayerId, 'r1');
  assert.equal(store.player('r1').isHost, true);
});

test('v24 (R2) two players disconnecting at once: no transfer at suspend time, exactly one succession at grace expiry, to the next-earliest remaining', () => {
  const store = makeStore();
  // Host + earliest joiner drop at the same instant (one batch, one
  // batchId). v24: the suspends start ONE grace for the host and
  // transfer nothing yet — there is no transfer to amend anymore. At
  // expiry the transfer goes straight to the final host (the
  // suspended earliest joiner is skipped as a candidate), so exactly
  // one succession names the next-earliest remaining player. See
  // v23-host-rules-do.test.mjs for the same check through the real
  // `webSocketClose` sweep (both session orders).
  const first = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000, 'batch-1');
  const second = disconnectSeat(store, 'r1', 'network-lost', T0 + 1000, 'batch-1');
  assert.equal(
    transferredEvents([...first.events, ...second.events]).length,
    0,
    'v24: simultaneous suspends must transfer nothing yet — the grace runs first',
  );
  assert.equal(store.room.hostPlayerId, 'h1');
  const moved = expireGrace(store, T0 + 31000);
  assert.equal(
    moved.length,
    1,
    'one simultaneous disconnect must produce exactly one succession, at expiry',
  );
  assert.equal(
    moved[0].payload['previousHostPlayerId'],
    'h1',
    'the single transfer still names the original host as previous',
  );
  assert.equal(
    moved[0].payload['newHostPlayerId'],
    'r2',
    'the single transfer must name the FINAL host (the suspended earliest joiner is skipped)',
  );
  assert.equal(store.room.hostPlayerId, 'r2', 'the next-earliest remaining player must end up host');
  assert.equal(store.player('r2').isHost, true);
});

test('v24 (R2) a later drop is a separate grace and emits its own fresh transfer at its own expiry', () => {
  const store = makeStore();
  const first = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(transferredEvents(first.events).length, 0, 'v24: the first suspend starts a grace, it does not transfer');
  const moved1 = expireGrace(store, T0 + 31000);
  assert.equal(moved1.length, 1);
  assert.equal(moved1[0].payload['newHostPlayerId'], 'r1');
  assert.equal(store.room.hostPlayerId, 'r1');
  // r1 drops a second later — a new grace for the new host, so its
  // own fresh transfer at its own expiry (never an amend of the
  // first, already-delivered transfer).
  const second = disconnectSeat(store, 'r1', 'network-lost', T0 + 32000);
  assert.equal(transferredEvents(second.events).length, 0, 'v24: the second suspend also starts a grace');
  const moved2 = expireGrace(store, T0 + 62000);
  assert.equal(moved2.length, 1, 'a later drop must emit its own transfer at its own expiry, not amend the old one');
  assert.equal(moved2[0].payload['previousHostPlayerId'], 'r1');
  assert.equal(moved2[0].payload['newHostPlayerId'], 'r2');
  assert.equal(store.room.hostPlayerId, 'r2');
});

test('v24 (R2) late drop + reconnect: the old host does NOT get host back (transfer already happened at expiry)', () => {
  const store = makeStore();
  const dropped = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(transferredEvents(dropped.events).length, 0, 'v24: the suspend starts the grace, it does not transfer');
  const moved = expireGrace(store, T0 + 31000);
  assert.equal(moved.length, 1, 'the grace expiry must transfer host');
  assert.equal(store.room.hostPlayerId, 'r1');
  const back = store.resumeOnHello('h1', T0 + 35000);
  assert.equal(back.resumed, true, 'the old host must still be able to resume its seat');
  assert.equal(store.room.hostPlayerId, 'r1', 'the successor must stay host — no flip-flop');
  assert.equal(store.player('h1').isHost, false);
  assert.equal(store.player('r1').isHost, true);
  assert.equal(
    transferredEvents(back.events).length,
    0,
    'the reconnect must not emit another host transfer',
  );
});

test('v24 (R2) the new host can mint and use a host token (after the grace expiry)', async () => {
  const store = makeStore();
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  const moved = expireGrace(store, T0 + 31000);
  assert.equal(moved.length, 1);
  assert.equal(store.room.hostPlayerId, 'r1');
  const minted = await store.issueHostToken({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 32000,
  });
  assert.equal(minted.ok, true, `mint must succeed: ${minted.ok ? '' : minted.error}`);
  assert.equal(typeof minted.value.hostToken, 'string');
  // The minted token authorises a host-only op: transfer host onwards.
  const used = store.transferHost({
    playerId: 'r1',
    hostTokenHash: await hashHostToken(minted.value.hostToken),
    newHostPlayerId: 'r2',
    nowMs: T0 + 33000,
  });
  assert.equal(used.ok, true, `the minted token must authorise host ops: ${used.ok ? '' : used.error}`);
  assert.equal(store.room.hostPlayerId, 'r2');
});

test('v23 (R2) succession is a no-op when the host is not suspended', () => {
  const store = makeStore();
  const r = store.succeedHostAfterDisconnect('h1', T0 + 1000);
  assert.equal(r.transferred, false, 'a connected host must never be succeeded');
  assert.equal(r.events.length, 0);
  assert.equal(store.room.hostPlayerId, 'h1');
});

test('v23 (R2) succession is a no-op for a non-host seat', () => {
  const store = makeStore();
  store.suspendSeat('r1', 'network-lost', T0 + 1000);
  const r = store.succeedHostAfterDisconnect('r1', T0 + 2000);
  assert.equal(r.transferred, false, 'succeeding a non-host must be a no-op');
  assert.equal(r.events.length, 0);
  assert.equal(store.room.hostPlayerId, 'h1');
});

test('v23 (R2) succession is a no-op in a terminal phase', () => {
  const store = makeStore({ durationSeconds: 10 });
  start(store);
  store.alarmTick(T0 + 11000); // endsAt reached -> COMPLETED
  assert.equal(store.room.phase, 'COMPLETED');
  store.suspendSeat('h1', 'network-lost', T0 + 12000);
  const r = store.succeedHostAfterDisconnect('h1', T0 + 12000);
  assert.equal(r.transferred, false, 'a finished room has no host to succeed');
  assert.equal(r.events.length, 0);
});

// ---------------------------------------------------------------------------
// R2 regressions — behaviour that must NOT change
// ---------------------------------------------------------------------------

test('v23 (R2) voluntary host leave still transfers host (leaveSeat, unchanged)', () => {
  const store = makeStore();
  const r = store.leaveSeat('h1', null, T0 + 1000);
  const moved = transferredEvents(r.events);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].payload['newHostPlayerId'], 'r1');
  assert.equal(store.room.hostPlayerId, 'r1');
  assert.equal(store.player('r1').isHost, true);
});

test('v23 (R2) the last player leaving still ends the room', () => {
  const store = makeStore();
  store.leaveSeat('r1', null, T0 + 1000);
  store.leaveSeat('r2', null, T0 + 2000);
  store.leaveSeat('hu1', null, T0 + 3000);
  const last = store.leaveSeat('h1', null, T0 + 4000);
  assert.equal(store.activePlayers().length, 0);
  // LOBBY empties to EXPIRED (leaveSeat comment, P1-8).
  assert.equal(store.room.phase, 'EXPIRED');
  assert.equal(
    transferredEvents(last.events).length,
    0,
    'with nobody left there is no one to transfer host to',
  );
});

test('v23 (R2) suspending a non-host never moves host', () => {
  const store = makeStore();
  const r = store.suspendSeat('r1', 'network-lost', T0 + 1000);
  assert.equal(transferredEvents(r.events).length, 0);
  assert.equal(store.room.hostPlayerId, 'h1');
  assert.equal(store.player('h1').isHost, true);
  // And a suspended non-host can still resume its own seat.
  const back = store.resumeOnHello('r1', T0 + 2000);
  assert.equal(back.resumed, true);
});

// ---------------------------------------------------------------------------
// v23 fix round 1 (Kabir) — S1 / S4 / S6 / S8 / S14
// ---------------------------------------------------------------------------

test('v24 fix (S6) two separate disconnects sharing one millisecond emit ONE transfer at expiry, never an amend of a delivered transfer', () => {
  const store = makeStore();
  // Same nowMs, but NO shared batchId (two separate close sweeps, each
  // minting its own id). v24: neither suspend transfers anything — the
  // host's grace is the only pending succession — so the expiry emits
  // exactly ONE transfer, straight to the final host (the suspended
  // earliest joiner is skipped as a candidate). There is no delivered
  // transfer for anything to amend.
  const first = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  const second = disconnectSeat(store, 'r1', 'network-lost', T0 + 1000);
  const all = [...first.events, ...second.events];
  assert.equal(
    transferredEvents(all).length,
    0,
    'v24: separate suspends transfer nothing yet — the grace runs first',
  );
  const moved = expireGrace(store, T0 + 31000);
  assert.equal(moved.length, 1, 'exactly one transfer at expiry, naming the final host');
  assert.equal(moved[0].payload['previousHostPlayerId'], 'h1');
  assert.equal(moved[0].payload['newHostPlayerId'], 'r2');
  assert.equal(store.room.hostPlayerId, 'r2');
});

test('v24 fix (S6) two drops in DIFFERENT batches with the same millisecond still emit one transfer at expiry; a later drop emits its own fresh transfer', () => {
  const store = makeStore();
  const first = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000, 'batch-a');
  const second = disconnectSeat(store, 'r1', 'network-lost', T0 + 1000, 'batch-b');
  assert.equal(
    transferredEvents([...first.events, ...second.events]).length,
    0,
    'v24: different batches no longer matter at suspend time — nothing transfers yet',
  );
  const moved = expireGrace(store, T0 + 31000);
  assert.equal(moved.length, 1, 'one transfer at the first expiry');
  assert.equal(moved[0].payload['newHostPlayerId'], 'r2');
  assert.equal(store.room.hostPlayerId, 'r2');
  // A LATER drop (the new host, after the first transfer was delivered)
  // is a separate grace with its own expiry — its transfer is fresh,
  // never an amend of the delivered one.
  const third = disconnectSeat(store, 'r2', 'network-lost', T0 + 32000);
  assert.equal(transferredEvents(third.events).length, 0);
  const moved2 = expireGrace(store, T0 + 62000);
  assert.equal(moved2.length, 1, 'the later drop must emit its own transfer at its own expiry');
  assert.equal(moved2[0].payload['previousHostPlayerId'], 'r2');
  assert.equal(moved2[0].payload['newHostPlayerId'], 'hu1');
  assert.equal(store.room.hostPlayerId, 'hu1');
});

test('v23 fix (S1) a left host cannot verify and cannot replay the room', () => {
  const store = makeStore({
    roster: [{ id: 'h1', name: 'Host', host: true }],
  });
  // Sole host leaves: no successor, room empties to EXPIRED (terminal).
  store.leaveSeat('h1', null, T0 + 1000);
  assert.equal(store.room.phase, 'EXPIRED');
  assert.equal(store.state.hostTokens['h1'], undefined, 'the leaver’s host token must die with the seat');
  assert.equal(store.verifyHost('h1', 'host-hash'), null, 'a left seat never verifies as host');
  const replayed = store.replayMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 2000 });
  assert.equal(replayed.ok, false, 'a left host must not resurrect the room into a lobby');
  assert.equal(replayed.code, 'FORBIDDEN');
  assert.equal(store.room.phase, 'EXPIRED', 'the room stays terminal');
});

test('v23 fix (S1) a left host cannot use its token for any host op', () => {
  const store = makeStore();
  store.leaveSeat('h1', null, T0 + 1000);
  assert.equal(store.room.hostPlayerId, 'r1', 'host moved to the successor on leave');
  assert.equal(store.verifyHost('h1', 'host-hash'), null);
  const started = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 2000 });
  assert.equal(started.ok, false);
  assert.equal(started.code, 'FORBIDDEN');
});

test('v23 fix (S14) host leave crowns the earliest CONNECTED seat, never a suspended one', () => {
  const store = makeStore();
  // Earliest joiner r1 is suspended; r2 is connected.
  store.suspendSeat('r1', 'tab-hidden', T0 + 500);
  assert.equal(store.player('r1').connectionState, 'suspended');
  const r = store.leaveSeat('h1', null, T0 + 1000);
  const moved = transferredEvents(r.events);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].payload['newHostPlayerId'], 'r2', 'the suspended earliest joiner must be skipped');
  assert.equal(store.room.hostPlayerId, 'r2');
  assert.equal(store.player('r1').isHost, false);
});

test('v24 fix (S8) host disconnects while everyone is suspended: room stays hostless during the grace; a resume inside the grace does NOT transfer; the expiry does', () => {
  const store = makeStore();
  store.suspendSeat('r1', 'tab-hidden', T0 + 500);
  store.suspendSeat('r2', 'tab-hidden', T0 + 600);
  store.suspendSeat('hu1', 'tab-hidden', T0 + 700);
  const dropped = disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(transferredEvents(dropped.events).length, 0, 'no connected seat remains, so no succession');
  assert.equal(store.room.hostPlayerId, 'h1', 'the dead host keeps host until someone comes back');
  // r1 reconnects INSIDE the grace: the resume must NOT re-trigger
  // succession while the grace is running — the host keeps host.
  const back = store.resumeOnHello('r1', T0 + 5000);
  assert.equal(back.resumed, true);
  assert.equal(
    transferredEvents(back.events).length,
    0,
    'v24: a resume inside the grace must not transfer — the host keeps host until the deadline',
  );
  assert.equal(store.room.hostPlayerId, 'h1');
  assert.equal(
    store.snapshotFor('r1', T0 + 5000).hostGraceEndsAtMs,
    T0 + 31000,
    'the grace is still running after the resume',
  );
  // At the deadline the expiry transfers to the earliest-joined
  // CONNECTED seat — r1 itself.
  const moved = expireGrace(store, T0 + 31000);
  assert.equal(moved.length, 1, 'the grace expiry must transfer exactly once');
  assert.equal(moved[0].payload['previousHostPlayerId'], 'h1');
  assert.equal(moved[0].payload['newHostPlayerId'], 'r1');
  assert.equal(store.room.hostPlayerId, 'r1');
});

test('v23 fix (S8) host leaves while everyone is suspended: first resuming seat takes host', () => {
  const store = makeStore();
  store.suspendSeat('r1', 'tab-hidden', T0 + 500);
  store.suspendSeat('r2', 'tab-hidden', T0 + 600);
  store.suspendSeat('hu1', 'tab-hidden', T0 + 700);
  // Host leaves: S14 crowns no suspended seat, so the room is hostless
  // with isHost still on the absent host.
  const left = store.leaveSeat('h1', null, T0 + 1000);
  assert.equal(transferredEvents(left.events).length, 0);
  assert.equal(store.player('h1').isHost, true, 'isHost stays on the absent host until a seat returns');
  // r2 comes back first: earliest-joined CONNECTED seat is r2 (r1 is
  // still suspended), so r2 takes host.
  const back = store.resumeOnHello('r2', T0 + 5000);
  assert.equal(back.resumed, true);
  const moved = transferredEvents(back.events);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].payload['newHostPlayerId'], 'r2');
  assert.equal(store.room.hostPlayerId, 'r2');
  assert.equal(store.player('h1').isHost, false);
});

test('v24 fix (S8) alarmTick transfers at grace expiry when a fresh joiner appears in a hostless lobby (not before)', async () => {
  const store = makeStore();
  store.suspendSeat('r1', 'tab-hidden', T0 + 500);
  store.suspendSeat('r2', 'tab-hidden', T0 + 600);
  store.suspendSeat('hu1', 'tab-hidden', T0 + 700);
  disconnectSeat(store, 'h1', 'network-lost', T0 + 1000);
  assert.equal(store.room.hostPlayerId, 'h1', 'hostless: nobody connected to succeed to');
  // A fresh joiner arrives (connected). No hello/resume runs for them.
  // A tick INSIDE the grace must NOT transfer yet — the host keeps
  // host until the deadline, even with a live successor waiting.
  const joined = await store.addPlayerAsync({
    displayName: 'New',
    roomCode: 'ABCDEF',
    reconnectTokenHash: null,
    nowMs: T0 + 2000,
  });
  assert.equal(joined.ok, true);
  const early = store.alarmTick(T0 + 3000);
  assert.equal(
    transferredEvents(early.events).length,
    0,
    'v24: a tick inside the grace must not transfer',
  );
  assert.equal(store.room.hostPlayerId, 'h1');
  // At the deadline the tick transfers to the earliest-joined
  // CONNECTED seat — the fresh joiner (everyone else is suspended).
  const moved = expireGrace(store, T0 + 31000);
  assert.equal(moved.length, 1, 'the grace expiry must transfer exactly once');
  assert.equal(moved[0].payload['newHostPlayerId'], joined.value.player.playerId);
  assert.equal(store.room.hostPlayerId, joined.value.player.playerId);
});

test('v23 fix (S4) a deleted room refuses reconnect checks, ticket ops and WS messages', async () => {
  const store = makeStore();
  const cancelled = hostCancel(store, T0 + 1000);
  assert.equal(cancelled.ok, true);
  assert.equal(store.verifyReconnect('h1', 'reconnect-hash-h1'), null, 'no reconnect check passes on a deleted room');
  assert.equal(store.verifyHost('h1', 'host-hash'), null);
  const ticket = store.registerTicket({
    playerId: 'h1',
    reconnectTokenHash: 'reconnect-hash-h1',
    ticketId: 'ticket-1',
    ticketHash: 'hash-1',
    purpose: 'connect',
    expiresAtMs: T0 + 60_000,
    nowMs: T0 + 2000,
  });
  assert.equal(ticket.ok, false);
  assert.equal(ticket.code, 'ROOM_NOT_FOUND');
  assert.equal(ticket.status, 404);
  const redeemed = store.redeemTicketForConnect('hash-1', T0 + 2000);
  assert.equal(redeemed.ok, false);
  assert.equal(redeemed.code, 'ROOM_NOT_FOUND');
  const ws = await store.handleWsMessage(
    { playerId: 'h1', sessionId: 'tab-h1' },
    { type: 'snapshot.request', payload: {} },
    T0 + 2000,
  );
  assert.equal(ws.events.some((e) => e.type === 'error' && e.payload.code === 'ROOM_NOT_FOUND'), true);
  assert.deepEqual(ws.close, { code: 4403, reason: 'Room deleted.' });
});
