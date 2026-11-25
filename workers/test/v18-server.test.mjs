import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const roomDoNs = await import('../src/room-do.ts');
const sharedNs = await import('@pakdam/shared');
const { DEFAULT_ROOM_CONFIG, WS_CLIENT_TYPES, WS_SERVER_TYPES } = sharedNs;
const { handleReplay } = await import('../src/http.ts');

// v18 server tests (Kabir): start-gate removal + missing-fix ejection,
// runner Self Confirm, replay/reset, zone.preview removal, SOS + reveal
// removal. Harness mirrors phase4-fix-round.test.mjs (RoomStore direct,
// no DO ctx, no network).
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

/**
 * Store with a deterministic role draw: `hunters` are the picked Hunters
 * (teamAssignment 'selected', Balance OFF), everyone else a Runner. The
 * host (h1) is a Runner unless picked. headStart 0 so one alarmTick
 * reaches ACTIVE; pings off so ticks stay quiet.
 */
function makeStore({ hunters = ['hu1'], runners = ['r1'], shrink = false, durationSeconds = 3600 } = {}) {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 0,
    pingIntervalSeconds: 0,
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

function errorOf(result) {
  return result.events.find((e) => e.type === 'error');
}

// ---------------------------------------------------------------------------
// Item 4 — start gate removed; no fix for 30 s -> ejected
// ---------------------------------------------------------------------------

test('v18 (4a) startMatch succeeds with NO GPS fix from anyone', () => {
  const store = makeStore();
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  assert.equal(r.ok, true, 'start must not block on missing GPS');
  assert.equal(store.room.phase, 'HEAD_START');
});

test('v18 (4b) a player with no fix for 30 s is ejected on the tick; players with fresh fixes are not', async () => {
  const store = makeStore();
  start(store);
  // h1 + hu1 report fixes at T0+2000 (inside, good). r1 never reports.
  await sendFix(store, 'h1', T0 + 2000);
  await sendFix(store, 'hu1', T0 + 2000);
  const tick = store.alarmTick(T0 + 31000);
  assert.equal(store.player('r1').ejectedAt !== null, true, 'r1 (no fix for 31 s) must be ejected');
  assert.equal(store.player('h1').ejectedAt, null, 'h1 (fix 29 s ago) must not be ejected');
  assert.equal(store.player('hu1').ejectedAt, null, 'hu1 (fix 29 s ago) must not be ejected');
  assert.ok(
    tick.events.some((e) => e.type === 'room.state'),
    'ejection must broadcast a room.state event',
  );
  // The match does NOT complete: h1 is still a free Runner.
  assert.equal(store.room.phase, 'ACTIVE');
});

test('v18 (4b) a poor-but-present fix freezes instead of ejecting (no indefinite freeze, no false ejection)', async () => {
  const store = makeStore();
  start(store);
  // All three report at T0+29000: h1/hu1 inside + good, r1 OUTSIDE + poor (±100 m).
  await sendFix(store, 'h1', T0 + 29000);
  await sendFix(store, 'hu1', T0 + 29000);
  await sendFix(store, 'r1', T0 + 29000, OUTSIDE_FAR, 100);
  assert.equal(store.player('r1').locationQuality, 'poor');
  store.alarmTick(T0 + 30000);
  assert.equal(store.player('r1').ejectedAt, null, 'a present (poor) fix must not eject');
  assert.equal(
    store.mem.outsideZone['r1'].outsideAccumMs,
    0,
    'the outside-zone countdown must stay frozen at 0 on poor GPS',
  );
  assert.equal(store.player('h1').ejectedAt, null);
});

// ---------------------------------------------------------------------------
// Item 2 — runner Self Confirm
// ---------------------------------------------------------------------------

test('v18 (2) self-confirm creates the claim AND confirms it — no Hunter action needed', async () => {
  const store = makeStore({ runners: ['r1', 'r2'] });
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  // The Hunter sends NOTHING. The Runner names them and taps OK.
  const r = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-1', T0 + 3000);
  assert.ok(
    r.events.some((e) => e.type === 'catch.confirmed'),
    'self-confirm must emit catch.confirmed',
  );
  assert.equal(store.state.catches.length, 1, 'exactly one catch exists');
  assert.equal(store.state.catches[0].state, 'confirmed');
  assert.equal(store.state.catches[0].hunterPlayerId, 'hu1');
  assert.equal(store.state.catches[0].runnerPlayerId, 'r1');
  assert.deepEqual(store.caughtRunnerIds(), ['r1']);
  assert.ok(
    r.persist.some((p) => p.kind === 'catch-insert'),
    'a claim created by self-confirm persists via one catch-insert',
  );
});

test('v18 (2) self-confirm naming another Hunter conflicts; naming a non-Hunter is forbidden', async () => {
  const store = makeStore({ hunters: ['hu1', 'hu2'], runners: ['r1'] });
  start(store);
  store.alarmTick(T0 + 1000);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  // hu1 claims r1 the QR way first.
  const claim = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'req-1', T0 + 2500);
  assert.ok(claim.events.some((e) => e.type === 'catch.requested'));
  // r1 names the WRONG Hunter (hu2 did not claim them).
  const wrong = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu2' }, 'sc-2', T0 + 3000);
  assert.equal(errorOf(wrong)?.payload['code'], 'CONFLICT');
  assert.equal(store.state.catches[0].state, 'awaiting-confirmation', 'the open claim must survive');
  // r1 names h1, who is a Runner (host), not a Hunter.
  const notHunter = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'h1' }, 'sc-3', T0 + 3500);
  assert.equal(errorOf(notHunter)?.payload['code'], 'FORBIDDEN');
  assert.equal(store.state.catches[0].state, 'awaiting-confirmation');
});

test('v18 (2) self-confirm too far apart fails the physical-tag gate and creates no claim', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000);
  await sendFix(store, 'hu1', T0 + 2000, INSIDE, 10);
  await sendFix(store, 'r1', T0 + 2000, OUTSIDE_FAR, 10);
  const r = await sendWs(store, 'r1', 'catch.self-confirm', { hunterId: 'hu1' }, 'sc-1', T0 + 3000);
  assert.equal(errorOf(r)?.payload['code'], 'FORBIDDEN');
  assert.equal(store.state.catches.length, 0, 'a failed self-confirm must leave no claim behind');
});

test('v18 (2) the QR-scan way still works: Hunter claim + token confirm', async () => {
  const store = makeStore();
  start(store);
  store.alarmTick(T0 + 1000);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const claim = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'req-1', T0 + 2500);
  const catchId = claim.events.find((e) => e.type === 'catch.requested').payload['catch'].catchId;
  const rawToken = store.mem.rawCatchTokens.get(catchId)?.token;
  assert.equal(typeof rawToken, 'string', 'the claim must hold a raw QR token in memory');
  assert.equal(rawToken.length, 32, 'the token is 128-bit (32 hex chars)');
  const confirm = await sendWs(
    store,
    'hu1',
    'catch.confirm',
    { catchId, qrToken: rawToken },
    'conf-1',
    T0 + 3000,
  );
  assert.ok(confirm.events.some((e) => e.type === 'catch.confirmed'), 'token confirm must confirm');
  assert.equal(store.state.catches[0].state, 'confirmed');
});

// ---------------------------------------------------------------------------
// Item 3 — replay/reset
// ---------------------------------------------------------------------------

test('v18 (3) replay resets a finished room to LOBBY; host-only; config + code kept', async () => {
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
  store.alarmTick(T0 + 11000);
  assert.equal(store.room.phase, 'COMPLETED');
  assert.ok(store.room.result !== null);

  // Non-host cannot replay.
  const denied = store.replayMatch({ playerId: 'r1', hostTokenHash: null, nowMs: T0 + 12000 });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'FORBIDDEN');
  assert.equal(store.room.phase, 'COMPLETED', 'a denied replay must change nothing');

  const replayed = store.replayMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 12000 });
  assert.equal(replayed.ok, true, `host replay must succeed: ${replayed.ok ? '' : replayed.error}`);
  assert.equal(replayed.value.phase, 'LOBBY');
  assert.equal(replayed.value.roomCode, 'ABCDEF', 'the room code is kept');
  assert.equal(store.room.phase, 'LOBBY');
  assert.equal(store.room.result, null);
  assert.equal(store.room.startedAt, null);
  assert.equal(store.room.endsAt, null);
  assert.deepEqual(store.state.catches, [], 'match catches are cleared');
  assert.equal(store.state.shrinkIndexApplied, 0);
  for (const p of store.players) {
    assert.equal(p.matchRole, null, `${p.displayName} role cleared`);
    assert.equal(p.team, null);
    assert.equal(p.isReady, false, `${p.displayName} must re-ready`);
    assert.equal(p.ejectedAt, null);
  }
  assert.deepEqual(store.room.config.zone.boundary, TRIANGLE, 'the zone/config is kept');
  assert.equal(store.room.config.hunterCount, 1);
  // And the room can start again from the reset lobby.
  for (const p of store.players) p.isReady = true;
  const again = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 13000 });
  assert.equal(again.ok, true, 'the replayed room must start again');
});

test('v18 (3) replay from a live phase is rejected', () => {
  const store = makeStore();
  start(store);
  const r = store.replayMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 + 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_STATE');
  assert.equal(store.room.phase, 'HEAD_START');
});

// ---------------------------------------------------------------------------
// Item 1 — no zone.preview; shrink still fires. Items 5 + 6 — reveal/SOS gone.
// ---------------------------------------------------------------------------

test('v18 (1) no zone.preview is ever emitted, and the shrink still fires on time', async () => {
  const store = makeStore({ shrink: true });
  start(store);
  const seen = [];
  const fixAll = async (atMs) => {
    await sendFix(store, 'h1', atMs);
    await sendFix(store, 'hu1', atMs);
    await sendFix(store, 'r1', atMs);
  };
  // Fixes keep everyone "present" so (4a) never fires; ticks walk up to
  // the first shrink (interval 60 s) and past it. The old code broadcast
  // zone.preview in the 30 s before the shrink.
  for (const atMs of [T0 + 1000, T0 + 21000, T0 + 41000, T0 + 59000]) {
    await fixAll(atMs);
    seen.push(...store.alarmTick(atMs).events);
  }
  seen.push(...store.alarmTick(T0 + 61000).events);
  assert.equal(
    seen.some((e) => e.type === 'zone.preview'),
    false,
    'no zone.preview event may ever be emitted',
  );
  assert.ok(
    seen.some((e) => e.type === 'zone.update'),
    'the shrink must still broadcast zone.update when it fires',
  );
  assert.equal(store.state.shrinkIndexApplied, 1, 'exactly one shrink must have applied');
  assert.notDeepEqual(store.room.config.zone.boundary, TRIANGLE, 'the boundary must have moved');
});

test('v18 (5+6) reveal.send and safety.sos are unknown message types; no SOS state remains', async () => {
  const store = makeStore();
  const reveal = await sendWs(
    store,
    'r1',
    'reveal.send',
    { fix: { ...INSIDE, accuracyMeters: 10, timestampMs: T0 } },
    'rev-1',
    T0,
  );
  assert.equal(errorOf(reveal)?.payload['code'], 'VALIDATION_FAILED');
  assert.match(String(errorOf(reveal)?.payload['message'] ?? ''), /Unknown message type: reveal\.send/);
  const sos = await sendWs(store, 'r1', 'safety.sos', { reason: 'help' }, 'sos-1', T0);
  assert.equal(errorOf(sos)?.payload['code'], 'VALIDATION_FAILED');
  assert.match(String(errorOf(sos)?.payload['message'] ?? ''), /Unknown message type: safety\.sos/);
  const snap = store.snapshotFor('r1', T0);
  assert.equal('sosActive' in snap.safetyState, false, 'SafetyState must carry no sosActive');
  assert.equal(WS_CLIENT_TYPES.includes('safety.sos'), false);
  assert.equal(WS_CLIENT_TYPES.includes('catch.self-confirm'), true);
  assert.equal(WS_SERVER_TYPES.includes('sos.raised'), false);
  assert.equal(WS_SERVER_TYPES.includes('zone.preview'), false);
  assert.equal(sharedNs.SOS_COPY, undefined, 'SOS_COPY must be gone from shared');
  assert.equal(sharedNs.PREVIEW_LEAD_SECONDS, undefined, 'PREVIEW_LEAD_SECONDS must be gone');
  assert.equal(roomDoNs.START_GPS_FRESHNESS_MS, undefined, 'the start-gate constant must be gone');
});

// ---------------------------------------------------------------------------
// Item 3 — HTTP replay endpoint plumbing (stubbed DO, as in start-error.test.mjs)
// ---------------------------------------------------------------------------

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const PLAYER_ID = '22222222-2222-4222-8222-222222222222';

async function replayWithDo(doBody, status = 200) {
  let seenOp = null;
  let seenBody = null;
  const stub = {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      seenOp = body.op;
      seenBody = body;
      // v34 (Diya R3-N1) — handleReplay verifies the host token in the
      // DO BEFORE the seat limit, so the stub must model that op.
      if (body.op === 'verify-host-token') {
        return new Response(JSON.stringify({ ok: true, valid: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(doBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
  const env = { ROOM_DO: { idFromName: (name) => name, get: () => stub } };
  const req = new Request(`https://worker.example/v1/rooms/${ROOM_ID}/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: PLAYER_ID, hostToken: 'host-token-1' }),
  });
  const res = await handleReplay(req, { env, ctx: { waitUntil: () => {} } }, ROOM_ID);
  return { res, seenOp, seenBody };
}

test('v18 (3) POST /v1/rooms/:id/replay forwards hostToken to the DO replay op and returns its result', async () => {
  const { res, seenOp, seenBody } = await replayWithDo({
    ok: true,
    phase: 'LOBBY',
    roomCode: 'ABCDEF',
    playerCount: 3,
  });
  assert.equal(seenOp, 'replay');
  assert.equal(seenBody.playerId, PLAYER_ID);
  assert.equal(typeof seenBody.hostTokenHash, 'string');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.phase, 'LOBBY');
  assert.equal(body.roomCode, 'ABCDEF');
  assert.equal(body.playerCount, 3);
});

test('v18 (3) POST /v1/rooms/:id/replay surfaces a DO 403 as a 403', async () => {
  const { res } = await replayWithDo(
    { ok: false, error: 'Only the host can replay the room.', code: 'FORBIDDEN', status: 403 },
  );
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'Only the host can replay the room.');
});
