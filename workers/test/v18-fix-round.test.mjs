import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory, durableSnapshot, restoreState } = await import('../src/room-do.ts');
const { handleReplay } = await import('../src/http.ts');

// v18 FIX ROUND tests (Kabir): B1 poor-fix liveness vs usability, B2
// original-zone restore on replay, A1 claim-QR scan, A2/F3 Hunter
// liveness on self-confirm, A3/F4 suspended exemption + wake grace,
// A4 ACTIVE-only ejection, F1 hash stripping, F5 replay limit keying,
// A8 rotation-aware unknown-token copy. Harness mirrors
// v18-server.test.mjs (RoomStore direct, no DO ctx, no network).
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

function makeStore({
  hunters = ['hu1'],
  runners = ['r1'],
  shrink = false,
  headStartSeconds = 0,
  pingIntervalSeconds = 0,
  durationSeconds = 3600,
} = {}) {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds,
    pingIntervalSeconds,
    durationSeconds,
    zoneShrinkEnabled: shrink,
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

const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

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

// ---------------------------------------------------------------------------
// B1 — poor fix = liveness, never a gameplay position
// ---------------------------------------------------------------------------

test('B1 poor-but-present fix (±500 m) stamps lastFixAt and prevents ejection', async () => {
  const store = makeStore({ runners: ['r1', 'r2'] });
  start(store);
  // r1 reports a poor (±500 m) fix at T0+2000 — inside the server
  // validity bound (±1000 m), far outside the ±50 m gameplay bar.
  // r2 never reports at all.
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000, INSIDE, 500);
  assert.equal(store.player('r1').locationQuality, 'poor');
  assert.notEqual(store.player('r1').lastFixAt, null, 'a poor fix must still stamp lastFixAt');
  // A second poor fix keeps liveness fresh (29 s after the first).
  await sendFix(store, 'r1', T0 + 29000, INSIDE, 500);
  store.alarmTick(T0 + 30000);
  assert.equal(store.player('r1').ejectedAt, null, 'a present poor fix must not eject');
  assert.equal(store.player('r2').ejectedAt !== null, true, 'a truly silent seat still ejects');
});

test('B1 no ping is built from a poor fix; the ping fires once a good fix arrives', async () => {
  const store = makeStore({ runners: ['r1'], pingIntervalSeconds: 60 });
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  // Keep everyone alive with fresh fixes; only r1's are poor.
  for (const atMs of [T0 + 2000, T0 + 22000, T0 + 42000, T0 + 61000]) {
    await sendFix(store, 'h1', atMs);
    await sendFix(store, 'hu1', atMs);
    await sendFix(store, 'r1', atMs, INSIDE, 500);
  }
  const tick = store.alarmTick(T0 + 62000);
  const pings = tick.events.filter((e) => e.type === 'ping');
  assert.equal(
    pings.some((e) => e.payload['ping'].subjectPlayerId === 'r1'),
    false,
    'a poor-fix Runner must not be pinged',
  );
  // A good fix from r1: the deferred ping fires on the next tick.
  await sendFix(store, 'r1', T0 + 63000, INSIDE, 10);
  const tick2 = store.alarmTick(T0 + 64000);
  assert.equal(
    tick2.events.some(
      (e) => e.type === 'ping' && e.payload['ping'].subjectPlayerId === 'r1',
    ),
    true,
    'the ping must fire once a usable (±50 m) fix arrives',
  );
});

test('B1 self-confirm with poor fixes on both phones waits for GPS; good fixes tag', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  await sendFix(store, 'hu1', T0 + 2000, INSIDE, 100);
  await sendFix(store, 'r1', T0 + 2000, INSIDE, 100);
  const poor = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-1', T0 + 3000);
  assert.equal(errorOf(poor)?.payload['code'], 'STALE_LOCATION');
  assert.equal(store.state.catches.length, 0, 'a poor-GPS tag must create no claim');
  await sendFix(store, 'hu1', T0 + 4000, INSIDE, 10);
  await sendFix(store, 'r1', T0 + 4000, INSIDE, 10);
  const good = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-2', T0 + 5000);
  assert.ok(good.events.some((e) => e.type === 'catch.confirmed'), 'good fixes must tag');
});

// ---------------------------------------------------------------------------
// B2 — replay restores the ORIGINAL configured zone
// ---------------------------------------------------------------------------

test('B2 replay restores the original zone boundary after a shrink', async () => {
  // v23 NOTE: the finished room is reached by NATURAL completion
  // (endsAt), not by cancel — under v23 host cancel DELETES the room,
  // so cancelMatch can no longer be the replay setup. durationSeconds
  // 65 puts endsAt at T0 + 65 s, after the 60 s shrink; the tick at
  // T0 + 66 s completes it.
  const store = makeStore({ shrink: true, durationSeconds: 65 });
  start(store);
  assert.deepEqual(
    store.state.originalZoneBoundary,
    TRIANGLE,
    'startMatch must snapshot the original boundary',
  );
  const fixAll = async (atMs) => {
    await sendFix(store, 'h1', atMs);
    await sendFix(store, 'hu1', atMs);
    await sendFix(store, 'r1', atMs);
  };
  for (const atMs of [T0 + 1000, T0 + 21000, T0 + 41000, T0 + 59000]) {
    await fixAll(atMs);
    store.alarmTick(atMs);
  }
  store.alarmTick(T0 + 61000);
  assert.equal(store.state.shrinkIndexApplied, 1, 'exactly one shrink must have applied');
  assert.notDeepEqual(store.room.config.zone.boundary, TRIANGLE, 'the boundary must have shrunk');
  store.alarmTick(T0 + 66000);
  assert.equal(store.room.phase, 'COMPLETED', 'the match must complete naturally at endsAt');
  const replayed = store.replayMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 67000 });
  assert.equal(replayed.ok, true);
  assert.deepEqual(
    store.room.config.zone.boundary,
    TRIANGLE,
    'replay must restore the ORIGINAL configured zone, not the shrunk one',
  );
  // And the replayed game plays on the original zone.
  for (const p of store.players) p.isReady = true;
  const again = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 68000 });
  assert.equal(again.ok, true);
  assert.deepEqual(store.room.config.zone.boundary, TRIANGLE);
  assert.deepEqual(store.state.originalZoneBoundary, TRIANGLE);
});

// ---------------------------------------------------------------------------
// A1 — the claim QR scans (even after a "reload")
// ---------------------------------------------------------------------------

test('A1 a Hunter can scan the claim QR after a name-claim — including after a reload', async () => {
  const store = makeStore({ hunters: ['hu1', 'hu2'], runners: ['r1'] });
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  // Name-claim: no token involved. The Runner now shows the CLAIM QR.
  const claim = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'req-1', T0 + 2500);
  assert.ok(claim.events.some((e) => e.type === 'catch.requested'));
  const catchId = claim.events.find((e) => e.type === 'catch.requested').payload['catch'].catchId;
  const rawToken = store.mem.rawCatchTokens.get(catchId)?.token;
  assert.equal(typeof rawToken, 'string', 'the claim must hold a raw QR token in memory');
  // Simulate a reload: a fresh store rebuilt from durable state only.
  // (The raw token string is what the Runner's phone still shows.)
  const reloaded = new RoomStore(restoreState(durableSnapshot(store.state)), emptyMemory());
  assert.equal(reloaded.state.catches.length, 1, 'the claim must survive the reload');
  const scan = await sendWs(reloaded, 'hu1', 'catch.request', { qrToken: rawToken }, 'req-2', T0 + 3000);
  assert.equal(
    errorOf(scan),
    undefined,
    `scanning the claim QR must not error: ${JSON.stringify(errorOf(scan)?.payload ?? null)}`,
  );
  const requested = scan.events.find((e) => e.type === 'catch.requested');
  assert.ok(requested, 'the scan must return the open claim');
  assert.equal(requested.payload['catch'].catchId, catchId, 'it must be the SAME claim, not a new one');
  assert.equal(reloaded.state.catches.length, 1, 'no duplicate claim may be created');
  // A different Hunter scanning the same claim QR is still a conflict.
  const other = await sendWs(reloaded, 'hu2', 'catch.request', { qrToken: rawToken }, 'req-3', T0 + 3500);
  assert.equal(errorOf(other)?.payload['code'], 'CONFLICT');
});

test('A8 an unknown QR says it may have expired or been refreshed (rotation-aware)', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const scan = await sendWs(
    store,
    'hu1',
    'catch.request',
    { qrToken: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    'req-1',
    T0 + 3000,
  );
  assert.equal(errorOf(scan)?.payload['code'], 'FORBIDDEN');
  assert.match(
    String(errorOf(scan)?.payload['message'] ?? ''),
    /may have expired or been refreshed/,
  );
});

// ---------------------------------------------------------------------------
// A2/F3 — a suspended/disconnected Hunter cannot be credited on self-confirm
// ---------------------------------------------------------------------------

test('A2/F3 self-confirm rejects a suspended Hunter on the open-claim path; resumes and tags', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  // No open claim + suspended Hunter: requestCatch already rejects.
  store.suspendSeat('hu1', 'tab-hidden', T0 + 2500);
  assert.equal(store.player('hu1').connectionState, 'suspended');
  const noClaim = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-1', T0 + 3000);
  assert.equal(errorOf(noClaim)?.payload['code'], 'FORBIDDEN');
  assert.equal(store.state.catches.length, 0);
  // Resume, open the claim the QR way, suspend the Hunter again.
  const resumed = store.resumeOnHello('hu1', T0 + 3500);
  assert.equal(resumed.resumed, true);
  const claim = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'req-1', T0 + 4000);
  assert.ok(claim.events.some((e) => e.type === 'catch.requested'));
  store.suspendSeat('hu1', 'screen-locked', T0 + 4500);
  // THE FIX: open claim + suspended Hunter must NOT confirm.
  const suspended = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-2', T0 + 5000);
  assert.equal(errorOf(suspended)?.payload['code'], 'CONFLICT');
  assert.match(String(errorOf(suspended)?.payload['message'] ?? ''), /suspended/);
  assert.equal(store.state.catches[0].state, 'awaiting-confirmation', 'the open claim must survive');
  // Resume the Hunter: the same self-confirm now tags.
  store.resumeOnHello('hu1', T0 + 5500);
  const ok = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-3', T0 + 6000);
  assert.ok(ok.events.some((e) => e.type === 'catch.confirmed'), 'a live Hunter must be credited');
  assert.equal(store.state.catches[0].state, 'confirmed');
});

// ---------------------------------------------------------------------------
// A3/F4 — suspended seats are exempt; first tick after wake skips (4a)
// ---------------------------------------------------------------------------

test('A3/F4 a suspended seat is not ejected for silence; a connected silent seat is', async () => {
  const store = makeStore({ runners: ['r1', 'r2'] });
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  // r1 suspends (tab hidden) and goes quiet; r2 just goes quiet.
  store.suspendSeat('r1', 'tab-hidden', T0 + 2500);
  store.alarmTick(T0 + 31000);
  assert.equal(store.player('r1').ejectedAt, null, 'a suspended seat must not be ejected for silence');
  assert.equal(store.player('r1').connectionState, 'suspended');
  assert.equal(store.player('r2').ejectedAt !== null, true, 'a connected silent seat still ejects');
});

test('A3/F4 the first tick after a wake skips the missing-fix ejection once', () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  // Nobody ever reports: without grace the T0+31000 tick mass-ejects.
  const wakeTick = store.alarmTick(T0 + 31000, { firstTickAfterWake: true });
  assert.equal(store.player('h1').ejectedAt, null, 'the wake-grace tick must eject nobody');
  assert.equal(store.player('hu1').ejectedAt, null);
  assert.equal(store.player('r1').ejectedAt, null);
  assert.equal(wakeTick.events.some((e) => e.type === 'room.state'), false);
  // The very next tick (no grace) ejects the still-silent seats.
  store.alarmTick(T0 + 32000);
  assert.equal(store.player('h1').ejectedAt !== null, true, 'silence after the grace still ejects');
});

// ---------------------------------------------------------------------------
// A4 — no ejection during HEAD_START; 30 s into ACTIVE
// ---------------------------------------------------------------------------

test('A4 no ejection during HEAD_START; a never-reported player ejects 30 s into ACTIVE', async () => {
  const store = makeStore({ headStartSeconds: 120 });
  start(store);
  assert.equal(store.room.phase, 'HEAD_START');
  // 31 s in — past the old 30 s rule — but still head start: nobody ejects.
  store.alarmTick(T0 + 31000);
  assert.equal(store.room.phase, 'HEAD_START');
  for (const p of store.players) assert.equal(p.ejectedAt, null);
  store.alarmTick(T0 + 119000);
  for (const p of store.players) assert.equal(p.ejectedAt, null);
  // Head start ends at T0+120000: ACTIVE begins, but the 30 s clock
  // starts HERE — a never-reported player is not ejected instantly.
  store.alarmTick(T0 + 120000);
  assert.equal(store.room.phase, 'ACTIVE');
  for (const p of store.players) assert.equal(p.ejectedAt, null, 'nobody ejects the instant ACTIVE begins');
  store.alarmTick(T0 + 149000);
  assert.equal(store.player('r1').ejectedAt, null, '29 s into ACTIVE is still safe');
  store.alarmTick(T0 + 150000);
  assert.equal(store.player('r1').ejectedAt !== null, true, '30 s into ACTIVE ejects');
});

// ---------------------------------------------------------------------------
// F1 — neither token hash leaves the server; F6/A10 — replay clears cross-round state
// ---------------------------------------------------------------------------

test('F1 the previous token hash never leaves the server, in events or snapshots', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  // Runner mints a claim-less token BEFORE any claim exists…
  const minted = await sendWs(store, 'r1', 'catch.runner-token', {}, 'tok-1', T0 + 2500);
  const runnerToken = minted.events.find((e) => e.type === 'catch.runner-token')?.payload['token'];
  assert.equal(typeof runnerToken, 'string');
  // …then the Hunter name-claims, then scans the runner token: the
  // scan BINDS it as the claim's previous hash (server-side only).
  const claim = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'req-1', T0 + 3000);
  assert.ok(claim.events.some((e) => e.type === 'catch.requested'));
  const scan = await sendWs(store, 'hu1', 'catch.request', { qrToken: runnerToken }, 'req-2', T0 + 3500);
  const requested = scan.events.find((e) => e.type === 'catch.requested');
  assert.ok(requested, 'the scan must return the open claim');
  assert.equal('qrTokenHash' in requested.payload['catch'], false);
  assert.equal('previousQrTokenHash' in requested.payload['catch'], false);
  assert.equal(
    typeof store.state.catches[0].previousQrTokenHash,
    'string',
    'the server must still hold the previous hash (the strip has something to strip)',
  );
  const snap = store.snapshotFor('hu1', T0 + 3500);
  assert.equal(snap.activeCatches.length, 1);
  assert.equal('qrTokenHash' in snap.activeCatches[0], false);
  assert.equal('previousQrTokenHash' in snap.activeCatches[0], false);
});

test('F6/A10 replay clears announcements + disconnect times and un-suspends kept seats', async () => {
  // v23 NOTE: the finished room is reached by NATURAL completion
  // (endsAt), not by cancel — under v23 host cancel DELETES the room,
  // so cancelMatch can no longer be the replay setup. durationSeconds
  // 10 puts endsAt at T0 + 10 s; the tick at T0 + 11 s completes it.
  const store = makeStore({ runners: ['r1', 'r2'], durationSeconds: 10 });
  start(store);
  store.alarmTick(T0 + 1000);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-1', T0 + 3000);
  // Stale cross-round state: an announcement, a disconnect timestamp,
  // a suspended seat, and a live fix from the finished match.
  store.mem.announcements.push({
    announcementId: 'a1',
    roomId: 'room-1',
    playerId: 'hu1',
    senderName: 'Hunter 1',
    text: 'Runner tagged',
    sentAt: new Date(T0 + 3000).toISOString(),
  });
  store.mem.lastDisconnectAtMs['r2'] = T0 + 2500;
  store.suspendSeat('r2', 'network-lost', T0 + 4000);
  assert.equal(store.player('r2').connectionState, 'suspended');
  store.alarmTick(T0 + 11000);
  assert.equal(store.room.phase, 'COMPLETED', 'the match must complete naturally at endsAt');
  const replayed = store.replayMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 12000 });
  assert.equal(replayed.ok, true);
  assert.deepEqual(store.mem.announcements, [], 'announcements must not leak into the new game');
  assert.deepEqual(store.mem.lastDisconnectAtMs, {}, 'disconnect times must not leak into the new game');
  assert.deepEqual(store.mem.latestFix, {}, 'live fixes must not leak into the new game');
  assert.equal(store.player('r2').connectionState, 'connected', 'a kept seat must re-enter connected');
  assert.equal(store.player('r2').locationQuality, null);
  assert.equal(store.player('r2').lastFixAt, null);
  assert.equal(store.player('r1').connectionState, 'connected');
});

// ---------------------------------------------------------------------------
// F5 — replay rate limit is keyed by room + playerId, not by token hash
// ---------------------------------------------------------------------------

const REPLAY_ROOM_ID = '33333333-3333-4333-8333-333333333333';
const REPLAY_PLAYER_ID = '44444444-4444-4444-8444-444444444444';

async function replayWithDo(hostToken) {
  const stub = {
    fetch: async () => {
      return new Response(
        JSON.stringify({ ok: true, phase: 'LOBBY', roomCode: 'ABCDEF', playerCount: 3 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  };
  const env = { ROOM_DO: { idFromName: (name) => name, get: () => stub } };
  const req = new Request(`https://worker.example/v1/rooms/${REPLAY_ROOM_ID}/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: REPLAY_PLAYER_ID, hostToken }),
  });
  return handleReplay(req, { env, ctx: { waitUntil: () => {} } }, REPLAY_ROOM_ID);
}

test('F5 replay limit shares one bucket per seat: fresh host tokens do not dodge it', async () => {
  // The limit is 5/min. Six replays from the SAME seat with a DIFFERENT
  // (guessed) host token each time: keyed by token hash, every one
  // would pass; keyed by room + playerId, the 6th is 429.
  for (let i = 1; i <= 5; i += 1) {
    const res = await replayWithDo(`host-token-guess-${i}`);
    assert.equal(res.status, 200, `replay ${i} must pass the limiter`);
  }
  const sixth = await replayWithDo('host-token-guess-6');
  assert.equal(sixth.status, 429, 'the 6th replay from the same seat must be rate-limited');
  const body = await sixth.json();
  assert.match(String(body.error ?? ''), /Too many tries/);
});
