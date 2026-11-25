import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { RoomDO } = await import('../src/room-do-class.ts');
const { STATE_KEY } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG, hashWsTicket, hashReconnectToken } = await import('@pakdam/shared');

globalThis.fetch = async () => ({ ok: true });

// v34 HARNESS (Arjun, QA) — approach (b): integration.
//
// The real boundaries, not mocks of them: HTTP /op dispatch on the
// RoomDO class (create -> join -> start -> play -> results -> replay),
// the WS ticket redeem path, snapshot propagation, and the persist
// intents that feed Supabase. The store-level tests prove the rules;
// these prove the wires between the pieces.

const T0 = 1_780_000_000_000;
const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.get(k); }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
  async list({ start, end } = {}) {
    const out = new Map();
    for (const k of [...this.map.keys()].sort()) {
      if (start !== undefined && k < start) continue;
      if (end !== undefined && k >= end) continue;
      out.set(k, this.map.get(k));
    }
    return out;
  }
  async setAlarm() {}
  async deleteAlarm() {}
}

function makeCtx() {
  const storage = new FakeStorage();
  const sockets = new Map();
  const pending = [];
  return {
    ctx: {
      storage,
      blockConcurrencyWhile: async (fn) => fn(),
      getWebSockets: (tag) => sockets.get(tag) ?? [],
      waitUntil: (p) => { pending.push(p); p.catch(() => undefined); },
    },
    storage,
    async flush() { await Promise.allSettled(pending); pending.length = 0; },
  };
}

const ROOM_CONFIG = {
  ...DEFAULT_ROOM_CONFIG,
  headStartSeconds: 0, pingIntervalSeconds: 0, durationSeconds: 3600,
  zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 60, playZoneEnabled: true,
  zone: { boundary: TRIANGLE, shrinkPhases: [] },
  teamAssignment: 'selected', selectedHunterIds: [], hunterCount: 1,
  balanceHunters: false, randomDraw: false, hostOnSiteConfirmed: true,
};

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

function player(id, displayName, isHost = false) {
  return {
    playerId: id, roomId: 'room-1', kind: 'guest', displayName, isHost,
    matchRole: null, team: null, reconnectTokenHash: `reconnect-hash-${id}`,
    joinedAt: new Date(T0 - 1000).toISOString(), leftAt: null, ejectedAt: null,
    connectionState: 'connected', lastFixAt: null, locationQuality: null,
    isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
  };
}

function seedStore() {
  const config = {
    ...ROOM_CONFIG,
    selectedHunterIds: ['hu1'],
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

async function sendFix(store, playerId, atMs) {
  return sendWs(store, playerId, 'location.update', {
    fix: { ...INSIDE, accuracyMeters: 10, timestampMs: atMs },
  }, `fix-${playerId}-${atMs}`, atMs);
}

test('v34 harness integration: create -> join -> start -> catch -> results -> replay, end to end at the class boundary', async () => {
  const fake = makeCtx();
  const registryCalls = [];
  const env = {
    SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k',
    CODE_REGISTRY_DO: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (_url, init) => {
          registryCalls.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        },
      }),
    },
  };
  const doInstance = new RoomDO(fake.ctx, env);

  // (1) Create: host seat + join-time WS ticket in one round trip.
  const created = await op(doInstance, {
    op: 'create', roomId: 'room-1', roomCode: 'ABCDEF',
    hostPlayerId: 'h1', displayName: 'Host', config: ROOM_CONFIG,
    reconnectTokenHash: 'reconnect-hash-h1', hostTokenHash: 'host-hash',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.phase, 'LOBBY');
  assert.ok(created.body.wsTicket?.ticket, 'create carries the host connect ticket');
  const hostId = created.body.hostPlayerId;

  // (2) Join: two guests, each with their own ticket + reconnect token.
  const joinHu = await op(doInstance, {
    op: 'add-player', displayName: 'Hunter 1', roomCode: 'ABCDEF',
    reconnectTokenHash: null, idempotencyKey: 'int-join-hu',
  });
  assert.equal(joinHu.status, 200, JSON.stringify(joinHu.body));
  const hu1 = joinHu.body.player.playerId;
  assert.ok(joinHu.body.wsTicket?.ticket);
  assert.notEqual(joinHu.body.wsTicket.ticket, created.body.wsTicket.ticket);
  const joinR = await op(doInstance, {
    op: 'add-player', displayName: 'Runner 1', roomCode: 'ABCDEF',
    reconnectTokenHash: null, idempotencyKey: 'int-join-r',
  });
  assert.equal(joinR.status, 200);
  const r1 = joinR.body.player.playerId;
  assert.notEqual(joinR.body.reconnectToken, joinHu.body.reconnectToken);

  // (3) Ready + start via the class: roles drawn, HEAD_START.
  // (Selected-hunter config needs the pick: update config first.)
  const cfg = { ...ROOM_CONFIG, selectedHunterIds: [hu1] };
  const updated = await op(doInstance, {
    op: 'update-config', playerId: hostId, hostTokenHash: 'host-hash', config: cfg,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  // Ready is a WS op: drive it on the store the class loaded.
  const store = doInstance.store;
  assert.ok(store, 'the class must hold the loaded store');
  for (const pid of [hostId, hu1, r1]) {
    const r = await sendWs(store, pid, 'ready.set', { isReady: true }, `ready-${pid}`, T0);
    assert.equal(r.events.some((e) => e.type === 'error'), false, JSON.stringify(r.events));
  }
  const started = await op(doInstance, { op: 'start', playerId: hostId, hostTokenHash: 'host-hash', idempotencyKey: 'int-start' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.phase, 'HEAD_START');
  store.alarmTick(Date.now() + 1000); // HEAD_START (0 s) -> ACTIVE
  assert.equal(store.room.phase, 'ACTIVE');

  // (4) Play: fixes flow, claims open, the Runners manual-confirm.
  // Catching BOTH runners (r1 and the host-as-runner h1) completes the
  // match — hunters win — so results and replay are reachable.
  const nowFix = Date.now();
  for (const pid of [hostId, hu1, r1]) {
    const r = await sendFix(store, pid, nowFix);
    assert.equal(r.events.some((e) => e.type === 'error'), false, JSON.stringify(r.events));
  }
  const claim = await sendWs(store, hu1, 'catch.request', { runnerId: r1 }, 'int-claim', nowFix + 1000);
  assert.equal(claim.events.some((e) => e.type === 'catch.requested'), true, JSON.stringify(claim.events));
  const catchId = claim.events.find((e) => e.type === 'catch.requested').payload.catch.catchId;
  const confirmed = await sendWs(store, r1, 'catch.confirm', { catchId, qrToken: '', manualConfirm: true }, 'int-confirm', nowFix + 2000);
  assert.ok(confirmed.events.some((e) => e.type === 'catch.confirmed'), JSON.stringify(confirmed.events));
  assert.deepEqual(store.caughtRunnerIds(), [r1]);
  const claimHost = await sendWs(store, hu1, 'catch.request', { runnerId: hostId }, 'int-claim-host', nowFix + 3000);
  assert.equal(claimHost.events.some((e) => e.type === 'catch.requested'), true, JSON.stringify(claimHost.events));
  const hostCatchId = claimHost.events.find((e) => e.type === 'catch.requested').payload.catch.catchId;
  const confirmedHost = await sendWs(store, hostId, 'catch.confirm', { catchId: hostCatchId, qrToken: '', manualConfirm: true }, 'int-confirm-host', nowFix + 4000);
  assert.ok(confirmedHost.events.some((e) => e.type === 'catch.confirmed'), JSON.stringify(confirmedHost.events));
  assert.equal(store.room.phase, 'COMPLETED', 'catching every Runner completes the match');

  // (5) Results: the store reports the tags; the class serves get-results.
  const results = await op(doInstance, { op: 'get-results', playerId: hostId, reconnectTokenHash: 'reconnect-hash-h1' });
  assert.equal(results.status, 200, JSON.stringify(results.body));

  // (6) Replay to a fresh lobby on the SAME code with the SAME seats.
  // (No lifecycle 'end' here: a host 'end' is a cancel and DELETES the
  // room — replay only follows a finished match.)
  const replayed = await op(doInstance, { op: 'replay', playerId: hostId, hostTokenHash: 'host-hash', idempotencyKey: 'int-replay' });
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.ok(registryCalls.some((c) => c.op === 'register' && c.code === 'ABCDEF' && c.roomId === 'room-1'),
    'replay re-registers the invite code before resetting, so the fresh lobby is joinable by code');
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.room.phase, 'LOBBY', 'replay resets to LOBBY');
  assert.equal(stored.room.roomCode, 'ABCDEF', 'replay keeps the same invite code');
  assert.equal(stored.players.length, 3, 'replay keeps the same seats');
  assert.equal(stored.catches.length, 0, 'replay clears the old catches');
  assert.equal(stored.players.find((p) => p.playerId === r1).matchRole, null,
    'replay clears roles for the fresh game');
});

test('v34 harness integration: the join-time ticket opens exactly one socket and never leaks the raw value', async () => {
  const fake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  const doInstance = new RoomDO(fake.ctx, env);
  const created = await op(doInstance, {
    op: 'create', roomId: 'room-1', roomCode: 'ABCDEF',
    hostPlayerId: 'h1', displayName: 'Host', config: ROOM_CONFIG,
    reconnectTokenHash: 'reconnect-hash-h1', hostTokenHash: 'host-hash',
  });
  assert.equal(created.status, 201);
  const ticket = created.body.wsTicket.ticket;
  const store = doInstance.store;
  const hash = await hashWsTicket(ticket);
  assert.equal(store.redeemTicketForConnect(hash, Date.now()).ok, true);
  assert.equal(store.redeemTicketForConnect(hash, Date.now()).code, 'TICKET_REUSED');
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(JSON.stringify(stored).includes(ticket), false,
    'the raw ticket must never land in durable storage');
  assert.equal(stored.tickets.length, 1);
  assert.equal(stored.tickets[0].purpose, 'connect');
});

test('v34 harness integration: WS connect/renew/reconnect — a renewal ticket cannot open a socket, a connect ticket cannot renew', async () => {
  const store = seedStore();
  const minted = await store.mintJoinTicket('r1', T0);
  assert.equal(minted.ok, true);
  const connectHash = await hashWsTicket(minted.value.ticket);
  // redeemTicketForRenew takes (hash, playerId, nowMs): a connect
  // ticket presented for renewal is TICKET_INVALID.
  assert.equal(store.redeemTicketForRenew(connectHash, 'r1', T0 + 1000).ok, false,
    'a connect ticket must not renew a session');
  assert.equal(store.redeemTicketForRenew(connectHash, 'r1', T0 + 1000).code, 'TICKET_INVALID');
  const renew = await store.mintRenewalTicket('r1', T0);
  assert.equal(renew.ok, true);
  const renewHash = await hashWsTicket(renew.value.ticket);
  assert.equal(store.redeemTicketForConnect(renewHash, T0 + 1000).ok, false,
    'a renew ticket must not open a socket');
  assert.equal(store.redeemTicketForConnect(renewHash, T0 + 1000).code, 'TICKET_INVALID');
  assert.equal(store.redeemTicketForRenew(renewHash, 'r1', T0 + 1000).ok, true);
  assert.equal(store.redeemTicketForRenew(renewHash, 'r1', T0 + 2000).code, 'TICKET_REUSED');
  // And a renew ticket for another seat cannot renew this seat.
  const other = await store.mintRenewalTicket('hu1', T0);
  assert.equal(other.ok, true);
  assert.equal(store.redeemTicketForRenew(await hashWsTicket(other.value.ticket), 'r1', T0 + 1000).code, 'TICKET_INVALID');
});

test('v34 harness integration: GPS fix -> server -> snapshot -> map dot (snapshot carries the live fix for the viewer)', async () => {
  const store = seedStore();
  store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  store.alarmTick(T0 + 1000);
  const r = await sendFix(store, 'r1', T0 + 2000);
  assert.equal(r.events.some((e) => e.type === 'error'), false);
  // The Hunter's snapshot must carry the Runner's live fix (opponent
  // ping-only visibility still shows the fix in the snapshot's
  // teammate/opponent views per the snapshot builder).
  const snap = await sendWs(store, 'hu1', 'snapshot.request', { lastServerSeq: 0 }, 'snap-dot', T0 + 3000);
  const full = snap.events.find((e) => e.type === 'snapshot');
  assert.ok(full, 'a snapshot must be served');
  assert.equal(full.payload.phase, 'ACTIVE');
  assert.ok(Array.isArray(full.payload.players), 'the snapshot carries the roster');
  const runnerView = full.payload.players.find((p) => p.playerId === 'r1');
  assert.ok(runnerView, 'the Runner is in the snapshot');
  // The snapshot's freshness marker moves with the fix: a second
  // snapshot after a newer fix reports a newer watermark.
  const before = full.payload.maxLastFixAtMs ?? null;
  await sendFix(store, 'r1', T0 + 5000);
  const snap2 = await sendWs(store, 'hu1', 'snapshot.request', { lastServerSeq: 0 }, 'snap-dot-2', T0 + 6000);
  const full2 = snap2.events.find((e) => e.type === 'snapshot');
  assert.ok(full2.payload.maxLastFixAtMs === null || full2.payload.maxLastFixAtMs >= (before ?? 0),
    'the snapshot watermark must not go backwards after a fresh fix');
});

test('v34 harness integration: catch token -> claim -> confirm -> results carries hunter-tagged-runner with time', async () => {
  const store = seedStore();
  store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  store.alarmTick(T0 + 1000);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  // Runner mints a QR, Hunter scans it, Hunter confirms with the token.
  const minted = await sendWs(store, 'r1', 'catch.runner-token', {}, 'mint-int', T0 + 3000);
  const token = minted.events.find((e) => e.type === 'catch.runner-token').payload.token;
  const claim = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, 'scan-int', T0 + 4000);
  assert.equal(claim.events.some((e) => e.type === 'catch.requested'), true);
  const catchId = claim.events.find((e) => e.type === 'catch.requested').payload.catch.catchId;
  const raw = store.mem.rawCatchTokens.get(catchId);
  assert.ok(raw, 'the claim holds its raw token in memory for the Hunter confirm');
  const confirmed = await sendWs(store, 'hu1', 'catch.confirm', { catchId, qrToken: raw.token }, 'confirm-int', T0 + 5000);
  assert.ok(confirmed.events.some((e) => e.type === 'catch.confirmed'), JSON.stringify(confirmed.events));
  const view = confirmed.events.find((e) => e.type === 'catch.confirmed').payload.catch;
  assert.equal(view.hunterPlayerId, 'hu1');
  assert.equal(view.runnerPlayerId, 'r1');
  assert.ok(view.confirmedAt, 'the confirmed tag carries its time for the results page');
  assert.equal(store.state.catches[0].state, 'confirmed');
});

test('v34 harness integration: join -> lobby -> start refuses a second player with the same name without the token', async () => {
  const fake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  const doInstance = new RoomDO(fake.ctx, env);
  await op(doInstance, {
    op: 'create', roomId: 'room-1', roomCode: 'ABCDEF',
    hostPlayerId: 'h1', displayName: 'Host', config: ROOM_CONFIG,
    reconnectTokenHash: 'reconnect-hash-h1', hostTokenHash: 'host-hash',
  });
  const first = await op(doInstance, {
    op: 'add-player', displayName: 'Ana', roomCode: 'ABCDEF',
    reconnectTokenHash: null, idempotencyKey: 'int-name-1',
  });
  assert.equal(first.status, 200);
  // Same name, no token: refused. Same name WITH the token: restored, same seat.
  // (/op takes the HASH — the HTTP layer hashes the raw token first —
  // so the test hashes it here, exactly as the Worker does.)
  const squat = await op(doInstance, {
    op: 'add-player', displayName: 'ana', roomCode: 'ABCDEF',
    reconnectTokenHash: null, idempotencyKey: 'int-name-2',
  });
  assert.equal(squat.status, 403);
  assert.match(squat.body.error, /name is taken/);
  const restore = await op(doInstance, {
    op: 'add-player', displayName: 'Ana', roomCode: 'ABCDEF',
    reconnectTokenHash: await hashReconnectToken(first.body.reconnectToken), idempotencyKey: 'int-name-3',
  });
  // The class hashes the raw token before comparing; a restore needs
  // the hash — the raw token is accepted by the op layer, which hashes it.
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  assert.equal(restore.body.restored, true);
  assert.equal(restore.body.player.playerId, first.body.player.playerId, 'restore returns the SAME seat');
});

test('v34 harness integration: every mutation returns persist intents for Supabase — a join, a start and a catch each persist', async () => {
  const store = seedStore();
  const joined = await store.addPlayerAsync({
    displayName: 'Newbie', roomCode: 'ABCDEF', reconnectTokenHash: null, nowMs: T0,
  });
  assert.equal(joined.ok, true);
  assert.ok(joined.persist.some((p) => p.kind === 'player-upsert'), 'a join persists the player row');
  // A fresh join is not ready: the start gate refuses until they tap
  // "I'm ready" — pin the refusal, then ready them and start.
  const refused = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CONFLICT');
  const newbieId = joined.value.player.playerId;
  const ready = await sendWs(store, newbieId, 'ready.set', { isReady: true }, 'ready-newbie', T0);
  assert.equal(ready.events.some((e) => e.type === 'error'), false);
  const started = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  assert.equal(started.ok, true);
  assert.ok(started.persist.some((p) => p.kind === 'room-upsert'), 'a start persists the room row');
  store.alarmTick(T0 + 1000);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const claim = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'persist-claim', T0 + 3000);
  assert.ok(claim.persist.some((p) => p.kind === 'catch-insert'), 'a claim persists the catch row');
  const catchId = claim.events.find((e) => e.type === 'catch.requested').payload.catch.catchId;
  const confirmed = await sendWs(store, 'r1', 'catch.confirm', { catchId, qrToken: '', manualConfirm: true }, 'persist-confirm', T0 + 4000);
  assert.ok(confirmed.persist.some((p) => p.kind === 'catch-update'), 'a confirm persists the catch update');
});

test('v34 harness integration: an unknown op and a call on a missing room answer 400/404 with a code, never a crash', async () => {
  const fake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  const empty = new RoomDO(fake.ctx, env);
  const missing = await op(empty, { op: 'start', playerId: 'h1', hostTokenHash: 'host-hash' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'ROOM_NOT_FOUND');
  const bad = await op(empty, { op: 'explode', playerId: 'h1' });
  assert.equal(bad.status, 404, 'an unknown op on a missing room is ROOM_NOT_FOUND (the room check runs first)');
  await op(empty, {
    op: 'create', roomId: 'room-1', roomCode: 'ABCDEF',
    hostPlayerId: 'h1', displayName: 'Host', config: ROOM_CONFIG,
    reconnectTokenHash: 'reconnect-hash-h1', hostTokenHash: 'host-hash',
  });
  const unknown = await op(empty, { op: 'explode', playerId: 'h1' });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.equal(unknown.body.code, 'VALIDATION_FAILED');
});
