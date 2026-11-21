import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory, durableSnapshot, restoreState } = await import('../src/room-do.ts');
const sharedNs = await import('@pakdam/shared');
const { DEFAULT_ROOM_CONFIG, WS_CLIENT_TYPES, WS_SERVER_TYPES, WS_DIRECT_SERVER_TYPES } = sharedNs;

// v18 follow-up server tests (Kabir): the claim-less runner QR token.
// Harness mirrors v18-server.test.mjs (RoomStore direct, no DO ctx, no network).
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };
const OUTSIDE_FAR = { lat: 23.5, lng: 85.33 };

function player(playerId, displayName, isHost = false) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole: null,
    team: null,
    reconnectTokenHash: '',
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

function makeStore({ hunters = ['hu1'], runners = ['r1'] } = {}) {
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
  };
  return new RoomStore(state, emptyMemory());
}

function start(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `startMatch must succeed: ${r.ok ? '' : r.error}`);
  return r;
}

/** Start + reach ACTIVE (headStart 0). */
function startActive(store, atMs = T0) {
  start(store, atMs);
  store.alarmTick(atMs + 1000);
  assert.equal(store.room.phase, 'ACTIVE');
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

/** Runner mints; returns { result, token, expiresAt }. */
async function mint(store, runnerId, commandId, atMs) {
  const result = await sendWs(store, runnerId, 'catch.runner-token', {}, commandId, atMs);
  const issued = eventOf(result, 'catch.runner-token');
  return { result, issued, token: issued?.payload['token'] ?? null };
}

// ---------------------------------------------------------------------------
// Catalogue + mint
// ---------------------------------------------------------------------------

test('runner-token catalogue: catch.runner-token is a client + direct server type', () => {
  assert.equal(WS_CLIENT_TYPES.includes('catch.runner-token'), true);
  assert.equal(WS_SERVER_TYPES.includes('catch.runner-token'), true);
  assert.equal(WS_DIRECT_SERVER_TYPES.includes('catch.runner-token'), true);
});

test('runner-token (mint) Runner mints with no claim: 128-bit token, 120 s TTL, hash-only durable record', async () => {
  const store = makeStore();
  startActive(store);
  const { result, issued, token } = await mint(store, 'r1', 'mint-1', T0 + 2000);
  assert.equal(errorOf(result), undefined, 'mint must not error');
  assert.ok(issued, 'mint must reply with a direct catch.runner-token event');
  assert.deepEqual(issued.recipients, ['r1'], 'the raw token goes to the Runner only');
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 32, 'the token is 128-bit (32 hex chars)');
  assert.match(token, /^[0-9A-F]{32}$/, 'the token is 32 uppercase hex chars');
  assert.equal(issued.payload['runnerId'], 'r1');
  assert.equal(
    issued.payload['expiresAt'],
    new Date(T0 + 2000 + 120_000).toISOString(),
    'TTL is 120 s from mint',
  );
  assert.equal(result.durable, true, 'the mint changes durable state, so the DO must save it');
  assert.equal(store.state.runnerQrTokens.length, 1, 'exactly one record is stored');
  const record = store.state.runnerQrTokens[0];
  assert.equal(record.runnerPlayerId, 'r1');
  assert.equal(record.used, false);
  assert.match(record.tokenHash, /^[0-9a-f]{64}$/, 'the stored hash is SHA-256 hex');
  assert.equal('token' in record, false, 'the record must never carry the raw value');
  assert.equal(
    JSON.stringify(store.state.runnerQrTokens).includes(token),
    false,
    'the raw token must not leak into durable state',
  );
});

test('runner-token (mint) Hunter mint is forbidden; lobby mint is forbidden (no Runner role yet)', async () => {
  const store = makeStore();
  const lobby = await mint(store, 'r1', 'mint-1', T0);
  assert.equal(errorOf(lobby.result)?.payload['code'], 'FORBIDDEN');
  startActive(store);
  const hunter = await mint(store, 'hu1', 'mint-2', T0 + 2000);
  assert.equal(errorOf(hunter.result)?.payload['code'], 'FORBIDDEN');
  assert.equal(store.state.runnerQrTokens.length, 0, 'a rejected mint stores nothing');
});

test('runner-token (mint) mint while SAFETY_PAUSED is INVALID_STATE', async () => {
  const store = makeStore();
  startActive(store);
  const paused = await sendWs(store, 'h1', 'safety.pause', { reason: null }, 'pause-1', T0 + 2000);
  assert.equal(errorOf(paused), undefined);
  assert.equal(store.room.phase, 'SAFETY_PAUSED');
  const { result } = await mint(store, 'r1', 'mint-1', T0 + 3000);
  assert.equal(errorOf(result)?.payload['code'], 'INVALID_STATE');
});

test('runner-token (mint) mint with an open claim is CONFLICT — the claim QR rules instead', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const claim = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'req-1', T0 + 2500);
  assert.ok(eventOf(claim, 'catch.requested'), 'the name claim must open');
  const { result } = await mint(store, 'r1', 'mint-1', T0 + 3000);
  assert.equal(errorOf(result)?.payload['code'], 'CONFLICT');
  assert.equal(store.state.runnerQrTokens.length, 0);
});

test('runner-token (mint) mint with a disputed catch is CONFLICT — the host owns it', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'req-1', T0 + 2500);
  const catchId = store.state.catches[0].catchId;
  const disputed = await sendWs(
    store,
    'r1',
    'catch.dispute',
    { catchId, reason: 'not me' },
    'disp-1',
    T0 + 3000,
  );
  assert.ok(eventOf(disputed, 'catch.disputed'));
  const { result } = await mint(store, 'r1', 'mint-1', T0 + 3500);
  assert.equal(errorOf(result)?.payload['code'], 'CONFLICT');
});

test('runner-token (mint) an already-caught Runner cannot mint', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const done = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-1', T0 + 3000);
  assert.ok(eventOf(done, 'catch.confirmed'), 'self-confirm must catch r1');
  const { result } = await mint(store, 'r1', 'mint-1', T0 + 4000);
  assert.equal(errorOf(result)?.payload['code'], 'CONFLICT');
});

// ---------------------------------------------------------------------------
// Re-mint + expiry
// ---------------------------------------------------------------------------

test('runner-token (re-mint) re-mint rotates: the old QR dies at once, the new one works', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const first = await mint(store, 'r1', 'mint-1', T0 + 3000);
  const second = await mint(store, 'r1', 'mint-2', T0 + 4000);
  assert.notEqual(second.token, first.token, 're-mint must issue a fresh token');
  assert.equal(store.state.runnerQrTokens.length, 1, 'one live record per Runner');
  // The old QR no longer resolves — the hash is gone, not just expired.
  const stale = await sendWs(
    store,
    'hu1',
    'catch.request',
    { qrToken: first.token },
    'req-old',
    T0 + 5000,
  );
  assert.equal(errorOf(stale)?.payload['code'], 'FORBIDDEN');
  assert.equal(store.state.catches.length, 0, 'a dead token creates no claim');
  // The new QR creates the claim.
  const fresh = await sendWs(
    store,
    'hu1',
    'catch.request',
    { qrToken: second.token },
    'req-new',
    T0 + 5000,
  );
  assert.ok(eventOf(fresh, 'catch.requested'));
  assert.equal(store.state.catches.length, 1);
});

test('runner-token (expiry) an expired QR is CATCH_EXPIRED, and the Runner can re-mint after it', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const first = await mint(store, 'r1', 'mint-1', T0 + 3000);
  // 121 s later: past the 120 s TTL.
  const expired = await sendWs(
    store,
    'hu1',
    'catch.request',
    { qrToken: first.token },
    'req-exp',
    T0 + 124_000,
  );
  assert.equal(errorOf(expired)?.payload['code'], 'CATCH_EXPIRED');
  assert.equal(store.state.catches.length, 0);
  // The Runner re-mints and the fresh QR works (fixes are fresh again).
  await sendFix(store, 'hu1', T0 + 125_000);
  await sendFix(store, 'r1', T0 + 125_000);
  const second = await mint(store, 'r1', 'mint-2', T0 + 126_000);
  assert.notEqual(second.token, first.token);
  const fresh = await sendWs(
    store,
    'hu1',
    'catch.request',
    { qrToken: second.token },
    'req-new',
    T0 + 127_000,
  );
  assert.ok(eventOf(fresh, 'catch.requested'));
});

// ---------------------------------------------------------------------------
// Scan -> claim -> confirm
// ---------------------------------------------------------------------------

test('runner-token (scan) Hunter scan with the token only creates the claim, then Tag confirms it', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const { token } = await mint(store, 'r1', 'mint-1', T0 + 3000);
  // No runnerId — the token alone names the Runner.
  const claim = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, 'req-1', T0 + 4000);
  assert.equal(errorOf(claim), undefined);
  const requested = eventOf(claim, 'catch.requested');
  assert.ok(requested, 'scan must emit catch.requested');
  const view = requested.payload['catch'];
  assert.equal(view.runnerPlayerId, 'r1');
  assert.equal(view.hunterPlayerId, 'hu1');
  assert.equal(view.state, 'awaiting-confirmation');
  assert.equal(store.state.runnerQrTokens[0].used, true, 'the token is consumed by the claim');
  assert.ok(
    claim.persist.some((p) => p.kind === 'catch-insert'),
    'the scan-created claim persists via one catch-insert',
  );
  // The Runner keeps showing the same QR — the claim holds the
  // catchId-scoped hash of the same raw value.
  assert.equal(
    store.mem.rawCatchTokens.get(view.catchId)?.token,
    token,
    'the claim re-holds the scanned raw token in memory',
  );
  // Then the Hunter taps Tag → the existing catch.confirm with the token.
  const confirm = await sendWs(
    store,
    'hu1',
    'catch.confirm',
    { catchId: view.catchId, qrToken: token },
    'conf-1',
    T0 + 5000,
  );
  assert.ok(eventOf(confirm, 'catch.confirmed'), 'token confirm must confirm');
  assert.equal(store.state.catches[0].state, 'confirmed');
  assert.deepEqual(store.caughtRunnerIds(), ['r1']);
});

test('runner-token (scan) single-use: the same QR cannot create a second claim', async () => {
  const store = makeStore({ runners: ['r1', 'r2'] });
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const { token } = await mint(store, 'r1', 'mint-1', T0 + 3000);
  const first = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, 'req-1', T0 + 4000);
  assert.ok(eventOf(first, 'catch.requested'));
  // r1 is claimed; mint a token for r2 and try r1's consumed token again
  // (it must not bind to anything — it is used, full stop).
  const second = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, 'req-2', T0 + 5000);
  assert.equal(errorOf(second)?.payload['code'], 'FORBIDDEN');
  assert.equal(store.state.catches.length, 1, 'no second claim may be created');
});

test('runner-token (scan) unknown / malformed / mismatched tokens are rejected and consume nothing', async () => {
  const store = makeStore({ runners: ['r1', 'r2'] });
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const { token } = await mint(store, 'r1', 'mint-1', T0 + 3000);
  const unknown = await sendWs(
    store,
    'hu1',
    'catch.request',
    { qrToken: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
    'req-unk',
    T0 + 4000,
  );
  assert.equal(errorOf(unknown)?.payload['code'], 'FORBIDDEN');
  const malformed = await sendWs(store, 'hu1', 'catch.request', { qrToken: 'short' }, 'req-mal', T0 + 4000);
  assert.equal(errorOf(malformed)?.payload['code'], 'VALIDATION_FAILED');
  const mismatch = await sendWs(
    store,
    'hu1',
    'catch.request',
    { runnerId: 'r2', qrToken: token },
    'req-mis',
    T0 + 4000,
  );
  assert.equal(errorOf(mismatch)?.payload['code'], 'VALIDATION_FAILED');
  assert.equal(store.state.runnerQrTokens[0].used, false, 'a rejected scan must not consume the token');
  assert.equal(store.state.catches.length, 0);
  // The same token still works after the rejections.
  const good = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, 'req-ok', T0 + 5000);
  assert.ok(eventOf(good, 'catch.requested'));
});

test('runner-token (scan) a failed claim does not consume the token — retry with the same QR', async () => {
  const store = makeStore();
  startActive(store);
  // Hunter close, Runner far: the physical-tag gate rejects the claim.
  await sendFix(store, 'hu1', T0 + 2000, INSIDE, 10);
  await sendFix(store, 'r1', T0 + 2000, OUTSIDE_FAR, 10);
  const { token } = await mint(store, 'r1', 'mint-1', T0 + 3000);
  const far = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, 'req-1', T0 + 4000);
  assert.equal(errorOf(far)?.payload['code'], 'FORBIDDEN');
  assert.equal(store.state.catches.length, 0, 'a failed scan leaves no claim behind');
  assert.equal(store.state.runnerQrTokens[0].used, false, 'a failed scan must not consume the token');
  // Runner walks up; the same QR now claims.
  await sendFix(store, 'r1', T0 + 5000, INSIDE, 10);
  const close = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, 'req-2', T0 + 6000);
  assert.ok(eventOf(close, 'catch.requested'));
});

test('runner-token (confirm) the physical gate still applies at confirm: far apart rejects, close confirms', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const { token } = await mint(store, 'r1', 'mint-1', T0 + 3000);
  const claim = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, 'req-1', T0 + 4000);
  const catchId = eventOf(claim, 'catch.requested').payload['catch'].catchId;
  // Runner walks away before the Hunter taps Tag.
  await sendFix(store, 'r1', T0 + 5000, OUTSIDE_FAR, 10);
  const far = await sendWs(
    store,
    'hu1',
    'catch.confirm',
    { catchId, qrToken: token },
    'conf-1',
    T0 + 6000,
  );
  assert.equal(errorOf(far)?.payload['code'], 'FORBIDDEN');
  assert.equal(store.state.catches[0].state, 'awaiting-confirmation', 'a rejected confirm leaves the claim pending');
  // Runner comes back; the same token confirms.
  await sendFix(store, 'r1', T0 + 7000, INSIDE, 10);
  const close = await sendWs(
    store,
    'hu1',
    'catch.confirm',
    { catchId, qrToken: token },
    'conf-2',
    T0 + 8000,
  );
  assert.ok(eventOf(close, 'catch.confirmed'));
});

test('runner-token (bind) name-claim first, then scan: the scanned QR binds to the open claim', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  // Race: the Runner minted, then the Hunter claimed by name first.
  const { token } = await mint(store, 'r1', 'mint-1', T0 + 3000);
  const named = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'req-1', T0 + 4000);
  const catchId = eventOf(named, 'catch.requested').payload['catch'].catchId;
  const nameToken = store.mem.rawCatchTokens.get(catchId)?.token;
  assert.equal(typeof nameToken, 'string', 'the name claim holds its own raw token');
  assert.notEqual(nameToken, token, 'the name-claim token differs from the runner token');
  // The Hunter scans the Runner's QR: same claim back, token bound.
  const scanned = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, 'req-2', T0 + 5000);
  const rebound = eventOf(scanned, 'catch.requested');
  assert.ok(rebound, 'scan of an open same-Hunter claim returns it');
  assert.equal(rebound.payload['catch'].catchId, catchId, 'no second claim is created');
  assert.equal(store.state.catches.length, 1);
  assert.equal(store.state.runnerQrTokens[0].used, true, 'the scanned token is consumed by the bind');
  // Tag with the scanned token confirms (bound as the previous hash).
  const confirm = await sendWs(
    store,
    'hu1',
    'catch.confirm',
    { catchId, qrToken: token },
    'conf-1',
    T0 + 6000,
  );
  assert.ok(eventOf(confirm, 'catch.confirmed'), 'the bound scanned token must confirm');
});

test('runner-token (regression) the claim-tied path still works: name claim + claim token confirm', async () => {
  const store = makeStore();
  startActive(store);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const claim = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'req-1', T0 + 2500);
  const catchId = eventOf(claim, 'catch.requested').payload['catch'].catchId;
  const rawToken = store.mem.rawCatchTokens.get(catchId)?.token;
  assert.equal(typeof rawToken, 'string');
  assert.equal(rawToken.length, 32);
  const confirm = await sendWs(
    store,
    'hu1',
    'catch.confirm',
    { catchId, qrToken: rawToken },
    'conf-1',
    T0 + 3000,
  );
  assert.ok(eventOf(confirm, 'catch.confirmed'));
  assert.equal(store.state.catches[0].state, 'confirmed');
});

// ---------------------------------------------------------------------------
// Durability across a hibernate/wake round-trip
// ---------------------------------------------------------------------------

test('runner-token (durable) the hash-only record survives durableSnapshot/restoreState and still scans', async () => {
  const store = makeStore();
  startActive(store);
  const { token } = await mint(store, 'r1', 'mint-1', T0 + 2000);
  const snapJson = JSON.stringify(durableSnapshot(store.state));
  assert.equal(snapJson.includes(token), false, 'the raw token must not be in the durable snapshot');
  const restored = restoreState(JSON.parse(snapJson));
  assert.ok(restored, 'restoreState must accept the snapshot');
  assert.equal(restored.runnerQrTokens.length, 1);
  assert.equal(restored.runnerQrTokens[0].runnerPlayerId, 'r1');
  assert.equal(restored.runnerQrTokens[0].used, false);
  // A woken DO (fresh memory, restored state) still resolves the scan.
  const woken = new RoomStore(restored, emptyMemory());
  assert.equal(woken.room.phase, 'ACTIVE', 'the restored room is still live');
  await sendFix(woken, 'hu1', T0 + 3000);
  await sendFix(woken, 'r1', T0 + 3000);
  const claim = await sendWs(woken, 'hu1', 'catch.request', { qrToken: token }, 'req-1', T0 + 4000);
  assert.ok(eventOf(claim, 'catch.requested'), 'a pre-hibernate runner token must still scan after the wake');
  const catchId = eventOf(claim, 'catch.requested').payload['catch'].catchId;
  const confirm = await sendWs(
    woken,
    'hu1',
    'catch.confirm',
    { catchId, qrToken: token },
    'conf-1',
    T0 + 5000,
  );
  assert.ok(eventOf(confirm, 'catch.confirmed'));
});
