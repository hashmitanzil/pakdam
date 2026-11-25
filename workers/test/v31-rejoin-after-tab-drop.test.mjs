import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory, durableSnapshot, restoreState } = await import('../src/room-do.ts');
const { RoomDO } = await import('../src/room-do-class.ts');
const { STATE_KEY } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// v31 FIX 1 — rejoin must survive a dropped tab (founder-confirmed live
// defect on v30: game started → other app for 2-3 s → back → "Game not
// found on this device"; Android had discarded the tab, 20 tabs open).
//
// What the code proved (server side; the client half — the play page
// consulting the localStorage rejoin mirror on mount — is Meera's):
//   D1. `register-ticket` / `revoke-tickets` never persisted. Every
//       other mutating /op saves (afterMutation / save), but the
//       register-ticket case (room-do-class.ts dispatchOp) returned
//       without one, so a ticket lived only in `mem.tickets` until
//       the next mutation save. `restoreDurableMemory` rebuilds
//       mem.tickets from `state.tickets`, so a DO eviction between
//       registration and the WS upgrade lost the ticket and the
//       upgrade failed 4401 TICKET_INVALID — and the rejoin flow is
//       exactly register-then-upgrade. The class header claims the
//       ticket registry survives a wake; that was false for this
//       window. `handleUpgrade` likewise never persisted the redeem,
//       so a redeemed ticket resurrected as unredeemed after a wake
//       (single-use bypass inside its 60 s TTL).
//   D2. The WS upgrade conflated room-gone with ticket-invalid:
//       `handleWsUpgrade` mapped every non-101 non-FORBIDDEN DO error
//       to 4401, so a deleted/gone room (DO 404 ROOM_NOT_FOUND)
//       reached the client as 4401 "fetch a fresh ticket and
//       reconnect once" — burning its retry on a dead room instead
//       of going home. Fixed as a distinct close code 4404 (see
//       WS_CLOSE_CODE_ACTION; the client maps it to do-not-reconnect).
//
// The 30 s rule itself was verified intact for this defect: a 2-3 s
// absence is far inside the window — `setDisconnectDeadline` never
// restarts a running window, alarmTick (4b) only ejects past the
// deadline, (4a) exempts suspended seats, and the first tick after a
// wake skips both. Tests below pin that, plus the restore paths.
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

/** Simulate a DO eviction: durable snapshot → fresh store, as load() does. */
function wake(store) {
  const restored = restoreState(durableSnapshot(store.state));
  assert.notEqual(restored, null, 'durable state must restore');
  const woken = new RoomStore(restored, emptyMemory());
  woken.restoreDurableMemory();
  return woken;
}

// ---------------------------------------------------------------------------
// 1. Reload-as-resume restores role/score
// ---------------------------------------------------------------------------

test('v31 FIX 1: hello resume after a dropped tab restores role, team and suspension count', () => {
  const store = makeStore();
  start(store);
  assert.equal(store.player('r1').matchRole, 'runner');
  assert.equal(store.player('r1').team, 'runners');
  // The tab is discarded: socket closes, seat suspends (network-lost).
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  assert.equal(store.player('r1').connectionState, 'suspended');
  assert.equal(store.player('r1').suspensionCount, 1);
  // The reloaded tab reconnects 3 s later — well inside the 30 s window.
  const resumed = store.resumeOnHello('r1', T0 + 8000);
  assert.equal(resumed.resumed, true, 'the suspended seat must resume on hello');
  const seat = store.player('r1');
  assert.equal(seat.connectionState, 'connected');
  assert.equal(seat.matchRole, 'runner', 'role survives the drop');
  assert.equal(seat.team, 'runners', 'team survives the drop');
  assert.equal(seat.suspensionCount, 1, 'the suspension count stays on the record');
  assert.equal(store.reconnectEndsAtMs('r1'), null, 'the return window clears on resume');
});

test('v31 FIX 1: HTTP rejoin with the saved reconnect token restores the seat (role/score intact)', async () => {
  const store = makeStore();
  start(store);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  const r = await store.addPlayerAsync({
    displayName: 'Runner 1',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 8000,
  });
  assert.equal(r.ok, true, `restore must succeed: ${r.ok ? '' : r.error}`);
  assert.equal(r.value.restored, true, 'an existing seat + valid token is a restore, not a new join');
  assert.equal(r.value.reconnectToken, '', 'a restore returns an empty token — the client keeps its saved one');
  assert.equal(r.value.player.matchRole, 'runner');
  assert.equal(r.value.player.team, 'runners');
  assert.equal(r.value.player.connectionState, 'connected');
  assert.equal(store.state.players.length, 3, 'no duplicate seat is created');
  assert.equal(store.reconnectEndsAtMs('r1'), null);
});

test('v31 FIX 1: a reload WITHOUT the saved key is rejected as a new join (403 name taken), never duplicated', async () => {
  const store = makeStore();
  start(store);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  const noToken = await store.addPlayerAsync({
    displayName: 'Runner 1',
    roomCode: 'ABCDEF',
    reconnectTokenHash: null,
    nowMs: T0 + 8000,
  });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.status, 403);
  assert.match(noToken.error, /name is taken/);
  const wrongToken = await store.addPlayerAsync({
    displayName: 'Runner 1',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-somebody-else',
    nowMs: T0 + 8000,
  });
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.status, 403);
  assert.equal(store.state.players.length, 3, 'rejected rejoins mint no seat');
  assert.equal(store.player('r1').connectionState, 'suspended', 'the seat stays suspended, restorable');
});

// ---------------------------------------------------------------------------
// 2. A 2-3 s absence never ejects (and a deadline sweep mid-rejoin cannot)
// ---------------------------------------------------------------------------

test('v31 FIX 1: a 2-3 s absence never ejects — the seat is still in at 3 s and at 29 s', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  // Founder repro: game started, other app for 2-3 s, tab discarded.
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  assert.equal(store.reconnectEndsAtMs('r1'), T0 + 35_000, 'deadline is suspend + 30 s');
  store.alarmTick(T0 + 8000);
  assert.equal(store.player('r1').ejectedAt, null, '3 s in, the seat must not eject');
  assert.equal(store.player('r1').connectionState, 'suspended');
  await sendFix(store, 'h1', T0 + 33_000);
  await sendFix(store, 'hu1', T0 + 33_000);
  store.alarmTick(T0 + 34_000);
  assert.equal(store.player('r1').ejectedAt, null, '29 s in, the window is still open');
  assert.equal(store.reconnectEndsAtMs('r1'), T0 + 35_000, 'the window was not restarted by the ticks');
});

test('v31 FIX 1: a deadline sweep landing mid-rejoin cannot eject the returning seat', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // ACTIVE
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  // A tick fires while the reloaded tab is mid-rejoin (deadline still future).
  store.alarmTick(T0 + 8000);
  assert.equal(store.player('r1').ejectedAt, null, 'the sweep must not eject inside the window');
  // The rejoin itself lands right after the tick.
  const resumed = store.resumeOnHello('r1', T0 + 8100);
  assert.equal(resumed.resumed, true);
  await sendFix(store, 'r1', T0 + 9000);
  await sendFix(store, 'h1', T0 + 36_000);
  await sendFix(store, 'hu1', T0 + 36_000);
  store.alarmTick(T0 + 36_000);
  assert.equal(store.player('r1').ejectedAt, null, 'a seat that rejoined is never ejected for the earlier absence');
});

// ---------------------------------------------------------------------------
// 3. Rejoin with a valid saved key after the tab's session is gone
// ---------------------------------------------------------------------------

test('v31 FIX 1: a fresh ticket + hello restores a suspended seat after its tab session is gone', () => {
  const store = makeStore();
  start(store);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  // The tab's WS session is gone (discarded tab); the client holds only
  // the saved reconnect token (localStorage mirror) and mints a ticket.
  const minted = store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    ticketId: 'ticket-v31-r1',
    ticketHash: 'ticket-hash-v31-r1',
    purpose: 'connect',
    expiresAtMs: T0 + 68_000,
    nowMs: T0 + 8000,
  });
  assert.equal(minted.ok, true, `ticket mint must succeed for a suspended seat: ${minted.ok ? '' : minted.error}`);
  const redeemed = store.redeemTicketForConnect('ticket-hash-v31-r1', T0 + 8100);
  assert.equal(redeemed.ok, true, `upgrade must redeem: ${redeemed.ok ? '' : redeemed.error}`);
  assert.equal(redeemed.value.playerId, 'r1');
  const resumed = store.resumeOnHello('r1', T0 + 8200);
  assert.equal(resumed.resumed, true);
  assert.equal(store.player('r1').connectionState, 'connected');
  assert.equal(store.player('r1').matchRole, 'runner');
  // A wrong saved key cannot mint: the server requires the seat's token.
  const badMint = store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-wrong',
    ticketId: 'ticket-v31-bad',
    ticketHash: 'ticket-hash-v31-bad',
    purpose: 'connect',
    expiresAtMs: T0 + 68_000,
    nowMs: T0 + 8300,
  });
  assert.equal(badMint.ok, false);
  assert.equal(badMint.status, 403);
  // An unknown ticket hash cannot open a socket.
  const badRedeem = store.redeemTicketForConnect('ticket-hash-no-such', T0 + 8400);
  assert.equal(badRedeem.ok, false);
  assert.equal(badRedeem.code, 'TICKET_INVALID');
});

// ---------------------------------------------------------------------------
// 4. Rejoin after DO eviction (durable state)
// ---------------------------------------------------------------------------

test('v31 FIX 1: after a DO eviction, HTTP rejoin with the saved token restores the seat and its deadline survives', async () => {
  const store = makeStore();
  start(store);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  const snap = durableSnapshot(store.state);
  assert.equal(snap.disconnectDeadlineMs?.['r1'], T0 + 35_000, 'the deadline is in the durable snapshot');
  assert.equal(
    snap.players.find((p) => p.playerId === 'r1')?.reconnectTokenHash,
    'reconnect-hash-r1',
    'the token hash is durable',
  );
  const woken = wake(store);
  assert.equal(woken.reconnectEndsAtMs('r1'), T0 + 35_000, 'the deadline survives the wake');
  assert.equal(woken.player('r1').connectionState, 'suspended');
  // First-paint GET works on the woken DO with the saved token.
  const state = woken.getStateOp({ playerId: 'r1', reconnectTokenHash: 'reconnect-hash-r1', nowMs: T0 + 8000 });
  assert.equal(state.ok, true, `GET state must succeed after a wake: ${state.ok ? '' : state.error}`);
  // HTTP rejoin restores the seat on the woken DO.
  const r = await woken.addPlayerAsync({
    displayName: 'Runner 1',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 8000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.restored, true);
  assert.equal(r.value.player.matchRole, 'runner');
  assert.equal(r.value.player.team, 'runners');
});

test('v31 FIX 1: a registered ticket survives a wake once saved (what the class save() does) and redeems', () => {
  const store = makeStore();
  start(store);
  store.suspendSeat('r1', 'network-lost', T0 + 5000);
  const minted = store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    ticketId: 'ticket-v31-wake',
    ticketHash: 'ticket-hash-v31-wake',
    purpose: 'connect',
    expiresAtMs: T0 + 68_000,
    nowMs: T0 + 8000,
  });
  assert.equal(minted.ok, true);
  // What RoomDO.save() does for the ticket registry (syncDurableMemory).
  store.syncDurableMemory();
  const snap = durableSnapshot(store.state);
  assert.equal(
    snap.tickets.some((t) => t.ticketId === 'ticket-v31-wake'),
    true,
    'a saved ticket is in the durable snapshot',
  );
  const woken = wake(store);
  const redeemed = woken.redeemTicketForConnect('ticket-hash-v31-wake', T0 + 8100);
  assert.equal(redeemed.ok, true, `the ticket must redeem after a wake: ${redeemed.ok ? '' : redeemed.error}`);
  assert.equal(redeemed.value.playerId, 'r1');
});

test('v31 FIX 1: a redeemed ticket stays spent across a wake (no single-use bypass)', () => {
  const store = makeStore();
  start(store);
  store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    ticketId: 'ticket-v31-spent',
    ticketHash: 'ticket-hash-v31-spent',
    purpose: 'connect',
    expiresAtMs: T0 + 68_000,
    nowMs: T0 + 8000,
  });
  const first = store.redeemTicketForConnect('ticket-hash-v31-spent', T0 + 8100);
  assert.equal(first.ok, true);
  // What RoomDO.save() does after the redeem (persist the spent flag).
  store.syncDurableMemory();
  const woken = wake(store);
  const second = woken.redeemTicketForConnect('ticket-hash-v31-spent', T0 + 8200);
  assert.equal(second.ok, false, 'a spent ticket must not redeem again after a wake');
  assert.equal(second.code, 'TICKET_REUSED');
});

test('v31 FIX 1 (window, documented): the store alone does not persist tickets — the class must save after register', () => {
  const store = makeStore();
  start(store);
  store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    ticketId: 'ticket-v31-unsaved',
    ticketHash: 'ticket-hash-v31-unsaved',
    purpose: 'connect',
    expiresAtMs: T0 + 68_000,
    nowMs: T0 + 8000,
  });
  // Deliberately NO syncDurableMemory(): this is the pre-fix class
  // behaviour (register-ticket returned without save()). The ticket
  // is lost on the wake — which is why the v31 class fix saves in
  // the register-ticket / revoke-tickets cases and after redeem.
  const snap = durableSnapshot(store.state);
  assert.equal(
    snap.tickets.some((t) => t.ticketId === 'ticket-v31-unsaved'),
    false,
    'an unsaved ticket is NOT in the durable snapshot',
  );
  const woken = wake(store);
  const redeemed = woken.redeemTicketForConnect('ticket-hash-v31-unsaved', T0 + 8100);
  assert.equal(redeemed.ok, false);
  assert.equal(redeemed.code, 'TICKET_INVALID');
});

// ---------------------------------------------------------------------------
// 5. Class level (D1): register-ticket / revoke-tickets persist to storage
// ---------------------------------------------------------------------------
// Real RoomDO through /op fetch with a fake DurableObjectState / env —
// harness mirrors v23-host-rules-do.test.mjs. No network, no Supabase,
// no registry.
globalThis.fetch = async () => ({ ok: true });

const IDS = {
  h1: 'aaaaaaaa-1111-4111-8111-111111111111',
  r1: 'bbbbbbbb-2222-4222-8222-222222222222',
  r2: 'cccccccc-3333-4333-8333-333333333333',
  hu1: 'dddddddd-4444-4444-8444-444444444444',
};

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
    async flush() {
      await Promise.allSettled(pending);
      pending.length = 0;
    },
  };
}

function makeEnv() {
  return {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    CODE_REGISTRY_DO: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    },
  };
}

function classPlayer(id, displayName, isHost, joinedAtMs, matchRole = null) {
  return {
    playerId: id,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole,
    team: matchRole === 'hunter' ? 'hunters' : matchRole === 'runner' ? 'runners' : null,
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

function classStateFor(phase = 'ACTIVE') {
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
    selectedHunterIds: [IDS.hu1],
    hunterCount: 1,
    balanceHunters: false,
    randomDraw: false,
  };
  const live = phase !== 'LOBBY';
  return {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: IDS.h1,
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
      classPlayer(IDS.h1, 'Host', true, T0 - 5000, live ? 'runner' : null),
      classPlayer(IDS.r1, 'Runner 1', false, T0 - 4000, live ? 'runner' : null),
      classPlayer(IDS.r2, 'Runner 2', false, T0 - 3000, live ? 'runner' : null),
      classPlayer(IDS.hu1, 'Hunter 1', false, T0 - 2000, live ? 'hunter' : null),
    ],
    catches: [],
    hostTokens: { [IDS.h1]: 'host-hash' },
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

async function op(doInstance, body) {
  const res = await doInstance.fetch(
    new Request('http://do.test/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

test('v31 FIX 1 (class, D1): register-ticket persists — a fresh instance (eviction) still holds the ticket', async () => {
  const fake = makeCtx();
  const env = makeEnv();
  await fake.storage.put(STATE_KEY, classStateFor('ACTIVE'));
  const do1 = new RoomDO(fake.ctx, env);
  const res = await op(do1, {
    op: 'register-ticket',
    playerId: IDS.r1,
    reconnectTokenHash: `reconnect-hash-${IDS.r1}`,
    ticketId: 'ticket-v31-class-1',
    ticketHash: 'ticket-hash-v31-class-1',
    purpose: 'connect',
    expiresAtMs: Date.now() + 60_000,
  });
  assert.equal(res.body.ok, true, `register-ticket must succeed: ${JSON.stringify(res.body)}`);
  // The fix: the dispatch case saves, so the ticket is in DO storage —
  // not only in the first instance's memory. Pre-fix this was empty.
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(
    stored.tickets.some((t) => t.ticketId === 'ticket-v31-class-1'),
    true,
    'the registered ticket must be persisted to DO storage',
  );
  // Eviction: a brand-new instance on the same storage (load() restores).
  const do2 = new RoomDO(fake.ctx, env);
  const res2 = await op(do2, {
    op: 'register-ticket',
    playerId: IDS.r1,
    reconnectTokenHash: `reconnect-hash-${IDS.r1}`,
    ticketId: 'ticket-v31-class-2',
    ticketHash: 'ticket-hash-v31-class-2',
    purpose: 'connect',
    expiresAtMs: Date.now() + 60_000,
  });
  assert.equal(res2.body.ok, true);
  const stored2 = await fake.storage.get(STATE_KEY);
  assert.equal(
    stored2.tickets.some((t) => t.ticketId === 'ticket-v31-class-1'),
    true,
    'the first ticket survives the wake (it was persisted, not memory-only)',
  );
  assert.equal(
    stored2.tickets.some((t) => t.ticketId === 'ticket-v31-class-2'),
    true,
    'the second ticket is persisted too',
  );
});

test('v31 FIX 1 (class, D1): revoke-tickets persists — a revoked ticket does not resurrect after a wake', async () => {
  const fake = makeCtx();
  const env = makeEnv();
  await fake.storage.put(STATE_KEY, classStateFor('ACTIVE'));
  const do1 = new RoomDO(fake.ctx, env);
  await op(do1, {
    op: 'register-ticket',
    playerId: IDS.r1,
    reconnectTokenHash: `reconnect-hash-${IDS.r1}`,
    ticketId: 'ticket-v31-revoke-1',
    ticketHash: 'ticket-hash-v31-revoke-1',
    purpose: 'connect',
    expiresAtMs: Date.now() + 60_000,
  });
  const revoked = await op(do1, {
    op: 'revoke-tickets',
    playerId: IDS.r1,
    reconnectTokenHash: `reconnect-hash-${IDS.r1}`,
  });
  assert.equal(revoked.body.ok, true);
  assert.equal(revoked.body.revoked, 1);
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(
    stored.tickets.some((t) => t.ticketId === 'ticket-v31-revoke-1'),
    false,
    'the revoked ticket must be gone from DO storage, not only from memory',
  );
  // Eviction must not resurrect it.
  const do2 = new RoomDO(fake.ctx, env);
  const stored2 = await fake.storage.get(STATE_KEY);
  assert.equal(
    stored2.tickets.some((t) => t.ticketId === 'ticket-v31-revoke-1'),
    false,
    'the revoked ticket stays revoked after a wake',
  );
  void do2;
});

// ---------------------------------------------------------------------------
// 6. HTTP level (D2): WS upgrade distinguishes room-gone (4404) from
//    ticket-invalid (4401) and seat-removed (4403)
// ---------------------------------------------------------------------------
// Node has no WebSocketPair; stub the pair the handler closes. The stub
// only records the close code — the production runtime supplies the real
// pair.
const closedPairs = [];
class FakeWs {
  constructor() {
    this.closed = [];
  }
  accept() {}
  close(code, reason) {
    this.closed.push({ code, reason });
  }
  send() {}
}
globalThis.WebSocketPair = class FakeWebSocketPair {
  constructor() {
    this[0] = new FakeWs();
    this[1] = new FakeWs();
    closedPairs.push(this);
  }
};

const { handleWsUpgrade } = await import('../src/http.ts');

function fakeUpgradeEnv(doJson, doStatus = 404) {
  return {
    ROOM_DO: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify(doJson), {
            status: doStatus,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    },
  };
}

async function upgradeWith(doJson, doStatus) {
  const env = fakeUpgradeEnv(doJson, doStatus);
  const ctx = { env, ctx: { waitUntil: () => {}, passThroughOnException: () => {} } };
  const before = closedPairs.length;
  // Node's undici Response rejects status 101 (Workers accepts it), so
  // the call throws AFTER the close frame was recorded on the fake
  // pair — the close code is the contract under test, and it is
  // recorded before the throw. In production the 101 + close is
  // returned normally.
  try {
    await handleWsUpgrade(
      new Request('https://worker.test/v1/rooms/room-1/ws?ticket=abcdef0123456789'),
      ctx,
      'room-1',
    );
  } catch {
    // Expected under Node only (see above).
  }
  assert.equal(closedPairs.length, before + 1, 'exactly one close pair is produced');
  return closedPairs[closedPairs.length - 1][1].closed[0];
}

test('v31 FIX 1 (http, D2): a gone room closes 4404 (room gone), not 4401 (ticket invalid)', async () => {
  const close = await upgradeWith(
    { ok: false, error: 'Room not found.', code: 'ROOM_NOT_FOUND', status: 404 },
    404,
  );
  assert.equal(close.code, 4404, 'room-gone must be distinguishable from ticket-invalid');
  assert.match(close.reason, /Room not found/);
});

test('v31 FIX 1 (http, D2): ticket-invalid still closes 4401 and seat-removed still closes 4403', async () => {
  const badTicket = await upgradeWith(
    { ok: false, error: 'Ticket invalid — fetch a fresh ticket and reconnect once.', code: 'TICKET_INVALID', status: 4401 },
    401,
  );
  assert.equal(badTicket.code, 4401);
  const forbidden = await upgradeWith(
    { ok: false, error: 'That seat is no longer in the room.', code: 'FORBIDDEN', status: 4403 },
    401,
  );
  assert.equal(forbidden.code, 4403);
});
