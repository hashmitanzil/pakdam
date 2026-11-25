import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { RoomDO } = await import('../src/room-do-class.ts');
const { STATE_KEY } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG, hashWsTicket } = await import('@pakdam/shared');

globalThis.fetch = async () => ({ ok: true });

// v34 — Kabir (server):
// (1) SLOW ENTRY — a join/create response carries a pre-registered
// connect WS ticket (`wsTicket`), so the client's first socket connect
// skips the POST ws-ticket leg (one client<->Worker<->DO round-trip +
// one DO save off the entry path). Best-effort: a mint failure never
// fails the join/create — the client falls back to POST ws-ticket.
// (2) SELF CONFIRM — founder field scenario pins: a Runner whose fix
// froze when they left the play page (the catch page sends no fixes —
// the watch lives in play/page.tsx only) is rejected STALE_LOCATION
// once the fix is >60 s old, and a coarse Hunter fix (>±50 m) rejects
// even when the Runner's fix is good and the phones are together.
// The gate itself is by design (P1-11 / v18 B1); these tests pin the
// exact rejection the field hits, so the client fix (surface the
// server's error instead of swallowing it) and any founder decision
// on the accuracy leg have a failing/passing test to land against.
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

const IDS = {
  h1: 'aaaaaaaa-1111-4111-8111-111111111111',
  r1: 'bbbbbbbb-2222-4222-8222-222222222222',
  hu1: 'dddddddd-4444-4444-8444-444444444444',
};

class FakeStorage {
  constructor() { this.map = new Map(); this.alarmsSet = []; this.alarmsDeleted = 0; }
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
  async setAlarm(ms) { this.alarmsSet.push(ms); }
  async deleteAlarm() { this.alarmsDeleted += 1; }
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
    sockets,
    async flush() { await Promise.allSettled(pending); pending.length = 0; },
  };
}

function seedPlayer(id, displayName, isHost, joinedAtMs) {
  return {
    playerId: id, roomId: 'room-1', kind: 'guest', displayName, isHost,
    matchRole: null, team: null, reconnectTokenHash: `reconnect-hash-${id}`,
    joinedAt: new Date(joinedAtMs).toISOString(), leftAt: null, ejectedAt: null,
    connectionState: 'connected', lastFixAt: null, locationQuality: null,
    isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
  };
}

async function seedRoom(fake) {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 0, pingIntervalSeconds: 0, durationSeconds: 3600,
    zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 60, playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected', selectedHunterIds: [IDS.hu1], hunterCount: 1,
    balanceHunters: false, randomDraw: false,
  };
  await fake.storage.put(STATE_KEY, {
    room: {
      roomId: 'room-1', roomCode: 'ABCDEF', hostPlayerId: IDS.h1, phase: 'LOBBY',
      version: 1, config, createdAt: new Date(Date.now() - 5000).toISOString(),
      startedAt: null, endsAt: null, pausedAt: null, result: null,
    },
    players: [
      seedPlayer(IDS.h1, 'Host', true, T0 - 5000),
      seedPlayer(IDS.r1, 'Runner 1', false, T0 - 4000),
      seedPlayer(IDS.hu1, 'Hunter 1', false, T0 - 2000),
    ],
    catches: [], hostTokens: { [IDS.h1]: 'host-hash' }, serverSeq: 0, deleted: false,
    gameEventLog: [], lastPingAtMs: {}, paused: false, pausedBy: null, pausedFrom: null,
    eventLog: [], shrinkIndexApplied: 0, tickets: [], idempotency: [],
    idempotentReplies: [], pendingPings: [], pendingPingRecipients: {}, runnerQrTokens: [],
  });
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// (1) Join-time WS ticket — class level (RoomDO dispatchOp)
// ---------------------------------------------------------------------------

test('v34 join: add-player returns a connect wsTicket; the registry holds its hash (never the raw value)', async () => {
  const fake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  await seedRoom(fake);
  const doInstance = new RoomDO(fake.ctx, env);
  const before = Date.now();
  const first = await op(doInstance, {
    op: 'add-player', displayName: 'Newbie', roomCode: 'ABCDEF',
    reconnectTokenHash: null, idempotencyKey: 'join-key-1',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  const wsTicket = first.body.wsTicket;
  assert.ok(wsTicket, 'a fresh join must carry a wsTicket');
  assert.match(wsTicket.ticket, /^[0-9a-f]{64}$/, 'ticket is 128-bit hex (randomHex(32))');
  assert.match(wsTicket.ticketId, UUID_RE, 'ticketId is a UUID');
  assert.ok(
    wsTicket.expiresAtMs > before && wsTicket.expiresAtMs <= before + 61_000,
    // 60_000 ms TTL plus up to 1 s of clock skew between the test's
    // `before` stamp and the DO's own `nowMs` inside the op.
    `ticket TTL must be 60 s (got ${wsTicket.expiresAtMs - before} ms)`,
  );
  const playerId = first.body.player.playerId;
  // A retry with the same key replays the SAME ticket — no second seat,
  // no second ticket.
  const again = await op(doInstance, {
    op: 'add-player', displayName: 'Newbie', roomCode: 'ABCDEF',
    reconnectTokenHash: null, idempotencyKey: 'join-key-1',
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.player.playerId, playerId, 'the retry must return the original seat');
  assert.equal(again.body.wsTicket.ticket, wsTicket.ticket, 'the retry must replay the SAME ticket');
  // Durable state: the ticket registry holds the hash, purpose
  // 'connect', unredeemed — and the raw value appears NOWHERE.
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.players.length, 4, 'one cached retry must not mint a second seat');
  assert.equal(stored.tickets.length, 1, 'exactly one ticket must be registered');
  const rec = stored.tickets[0];
  assert.equal(rec.playerId, playerId);
  assert.equal(rec.purpose, 'connect');
  assert.equal(rec.redeemed, false);
  assert.equal(rec.ticketHash, await hashWsTicket(wsTicket.ticket), 'only the hash is stored');
  assert.equal(
    JSON.stringify(stored).includes(wsTicket.ticket),
    false,
    'the raw ticket value must never land in durable storage',
  );
});

test('v34 join: create returns a connect wsTicket for the host seat', async () => {
  const fake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  const doInstance = new RoomDO(fake.ctx, env);
  const hostPlayerId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const created = await op(doInstance, {
    op: 'create', roomId: 'room-1', roomCode: 'ABCDEF', hostPlayerId,
    displayName: 'Host', config: DEFAULT_ROOM_CONFIG,
    reconnectTokenHash: 'reconnect-hash-host', hostTokenHash: 'host-hash',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.ok, true);
  const wsTicket = created.body.wsTicket;
  assert.ok(wsTicket, 'create must carry a wsTicket for the host seat');
  assert.match(wsTicket.ticket, /^[0-9a-f]{64}$/);
  const stored = await fake.storage.get(STATE_KEY);
  assert.equal(stored.tickets.length, 1);
  assert.equal(stored.tickets[0].playerId, hostPlayerId);
  assert.equal(stored.tickets[0].purpose, 'connect');
  assert.equal(JSON.stringify(stored).includes(wsTicket.ticket), false);
});

test('v34 join: a restore whose ticket mint is rate-limited still joins — without a ticket', async () => {
  const fake = makeCtx();
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  await seedRoom(fake);
  const doInstance = new RoomDO(fake.ctx, env);
  // Fill r1's 10/min ticket-issue bucket via the HTTP mint path first.
  for (let i = 0; i < 10; i += 1) {
    const minted = await op(doInstance, {
      op: 'register-ticket', playerId: IDS.r1,
      reconnectTokenHash: `reconnect-hash-${IDS.r1}`,
      ticketId: `ticket-${i}`, ticketHash: `hash-${i}`,
      purpose: 'connect', expiresAtMs: Date.now() + 60_000,
    });
    assert.equal(minted.status, 200, `issue ${i + 1} must succeed: ${JSON.stringify(minted.body)}`);
  }
  // The restore itself must still succeed — just with no wsTicket, so
  // the client falls back to POST ws-ticket (today's path).
  const restored = await op(doInstance, {
    op: 'add-player', displayName: 'Runner 1', roomCode: 'ABCDEF',
    reconnectTokenHash: `reconnect-hash-${IDS.r1}`, idempotencyKey: 'join-restore-1',
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.restored, true);
  assert.equal(restored.body.wsTicket, undefined, 'a rate-limited mint must not fail the join — it omits the ticket');
});

// ---------------------------------------------------------------------------
// (1) mintJoinTicket — store level (redeem semantics + rate limit)
// ---------------------------------------------------------------------------

function storePlayer(playerId, displayName, isHost = false) {
  return {
    playerId, roomId: 'room-1', kind: 'guest', displayName, isHost,
    matchRole: null, team: null, reconnectTokenHash: '',
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
    players: [storePlayer('h1', 'Host', true), storePlayer('hu1', 'Hunter 1'), storePlayer('r1', 'Runner 1')],
    catches: [], hostTokens: { h1: 'host-hash' }, serverSeq: 0,
    gameEventLog: [], lastPingAtMs: {}, paused: false, pausedBy: null, pausedFrom: null,
    eventLog: [], shrinkIndexApplied: 0, tickets: [], idempotency: [],
    idempotentReplies: [], pendingPings: [], pendingPingRecipients: {}, runnerQrTokens: [],
  };
  return new RoomStore(state, emptyMemory());
}

test('v34 mintJoinTicket: a connect ticket redeems once; a second redeem is TICKET_REUSED; a renew ticket cannot open a socket', async () => {
  const store = makeStore();
  const minted = await store.mintJoinTicket('r1', T0);
  assert.equal(minted.ok, true, `mint must succeed: ${minted.ok ? '' : minted.error}`);
  assert.match(minted.value.ticket, /^[0-9a-f]{64}$/);
  assert.equal(minted.value.expiresAtMs, T0 + 60_000);
  const hash = await hashWsTicket(minted.value.ticket);
  const first = store.redeemTicketForConnect(hash, T0 + 1000);
  assert.equal(first.ok, true, 'the join ticket must open a socket');
  assert.equal(first.value.playerId, 'r1');
  const second = store.redeemTicketForConnect(hash, T0 + 2000);
  assert.equal(second.ok, false, 'a redeemed ticket must not open a second socket');
  assert.equal(second.code, 'TICKET_REUSED');
  // Purpose confusion is refused both ways: a 'renew' ticket cannot
  // open a socket.
  const renew = await store.mintRenewalTicket('r1', T0);
  assert.equal(renew.ok, true);
  const wrongPurpose = store.redeemTicketForConnect(await hashWsTicket(renew.value.ticket), T0 + 1000);
  assert.equal(wrongPurpose.ok, false);
  assert.equal(wrongPurpose.code, 'TICKET_INVALID');
});

test('v34 mintJoinTicket: the 11th issue inside a minute is RATE_LIMITED 429', async () => {
  const store = makeStore();
  for (let i = 0; i < 10; i += 1) {
    const m = await store.mintJoinTicket('r1', T0 + i * 1000);
    assert.equal(m.ok, true, `issue ${i + 1} must succeed`);
  }
  const over = await store.mintJoinTicket('r1', T0 + 11_000);
  assert.equal(over.ok, false);
  assert.equal(over.code, 'RATE_LIMITED');
  assert.equal(over.status, 429);
});

// ---------------------------------------------------------------------------
// (2) Self confirm — founder field scenarios (store level)
// ---------------------------------------------------------------------------

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

function errorOf(result) {
  return result.events.find((e) => e.type === 'error');
}

test('v34 self-confirm: a Runner whose fix froze on the catch page (>60 s, no fixes sent there) is rejected STALE_LOCATION', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  // The Runner's last fix is from the play page (T0+2000) — the catch
  // page sends no fixes, so by the time they tap OK at T0+65000 the
  // fix is 63 s old. The Hunter's fix is fresh.
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 64000);
  const r = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-1', T0 + 65000);
  const err = errorOf(r);
  assert.ok(err, 'a stale-fix self-confirm must answer with an error envelope');
  assert.equal(err.payload['code'], 'STALE_LOCATION');
  assert.equal(err.payload['message'], 'Waiting for GPS — move closer and try again.');
  assert.equal(err.payload['retryable'], false);
  assert.deepEqual(err.recipients, ['r1'], 'the rejection goes to the Runner only');
  assert.equal(store.state.catches.length, 0, 'a rejected self-confirm must create no claim');
});

test('v34 self-confirm: a coarse Hunter fix (>±50 m) rejects even with a good Runner fix and the phones together', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  // Both phones are at the same point, both fixes fresh — but the
  // Hunter's fix is ±100 m, the field reality on the founder's phone.
  await sendFix(store, 'hu1', T0 + 2000, INSIDE, 100);
  await sendFix(store, 'r1', T0 + 2000, INSIDE, 10);
  const r = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-1', T0 + 3000);
  const err = errorOf(r);
  assert.ok(err, 'a coarse-fix self-confirm must answer with an error envelope');
  assert.equal(err.payload['code'], 'STALE_LOCATION');
  assert.equal(store.state.catches.length, 0, 'a rejected self-confirm must create no claim');
  // The same two phones with good fixes tag — the gate is the fix
  // quality, not the flow.
  await sendFix(store, 'hu1', T0 + 4000, INSIDE, 10);
  await sendFix(store, 'r1', T0 + 4000, INSIDE, 10);
  const good = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-2', T0 + 5000);
  assert.ok(good.events.some((e) => e.type === 'catch.confirmed'), 'good fixes must tag');
});
