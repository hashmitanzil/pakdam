import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomDO } = await import('../src/room-do-class.ts');
const { STATE_KEY } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');
const { clearRuntimeFlagCache, getRuntimeFlags } = await import('../src/admin-flags.ts');

// Admin Console DO ops (workers/src/room-do.ts + room-do-class.ts):
// admin-summary / admin-live-fix / admin-kick / admin-end /
// admin-force-results. These drive REAL room state — end deletes the
// live room, force-results completes the match, kick ejects the seat
// — never a row flip. Seeded-state harness mirrors
// http-idempotency.test.mjs.
const T0 = 1_780_000_000_000;
globalThis.fetch = async () => ({ ok: true });

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const IDS = {
  h1: 'aaaaaaaa-1111-4111-8111-111111111111',
  r1: 'bbbbbbbb-2222-4222-8222-222222222222',
  r2: 'cccccccc-3333-4333-8333-333333333333',
  hu1: 'dddddddd-4444-4444-8444-444444444444',
};

class FakeStorage {
  constructor() { this.map = new Map(); this.alarmsSet = []; this.alarmsDeleted = 0; }
  async get(k) { return this.map.get(k); }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
  async list({ start, end, prefix } = {}) {
    const out = new Map();
    for (const k of [...this.map.keys()].sort()) {
      if (start !== undefined && k < start) continue;
      if (end !== undefined && k >= end) continue;
      // The DO lists session keys by prefix (deleteSessionsForPlayer /
      // wipeRoomStorage). A fake that ignores `prefix` returns the
      // STATE_KEY too, and the caller deletes the room itself.
      if (prefix !== undefined && !k.startsWith(prefix)) continue;
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

function makeEnv() {
  return {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    CODE_REGISTRY_DO: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      }),
    },
  };
}

function player(id, displayName, isHost, joinedAtMs, matchRole = null, team = null) {
  return {
    playerId: id, roomId: 'room-1', kind: 'guest', displayName, isHost,
    matchRole, team, reconnectTokenHash: `reconnect-hash-${id}`,
    joinedAt: new Date(joinedAtMs).toISOString(), leftAt: null, ejectedAt: null,
    connectionState: 'connected', lastFixAt: null, locationQuality: null,
    isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
  };
}

function config() {
  return {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 0, pingIntervalSeconds: 0, durationSeconds: 3600,
    zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 60, playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected', selectedHunterIds: [IDS.hu1], hunterCount: 1,
    balanceHunters: false, randomDraw: false,
  };
}

async function seedRoom(fake, phase) {
  const live = phase === 'ACTIVE';
  await fake.storage.put(STATE_KEY, {
    room: {
      roomId: 'room-1', roomCode: 'ABCDEF', hostPlayerId: IDS.h1, phase,
      version: 1, config: config(), createdAt: new Date(T0 - 5000).toISOString(),
      startedAt: live ? new Date(T0).toISOString() : null,
      endsAt: live ? new Date(T0 + 3600_000).toISOString() : null,
      pausedAt: null, result: null,
    },
    players: [
      player(IDS.h1, 'Host', true, T0 - 5000),
      player(IDS.r1, 'Runner 1', false, T0 - 4000, live ? 'runner' : null, live ? 'runners' : null),
      player(IDS.r2, 'Runner 2', false, T0 - 3000, live ? 'runner' : null, live ? 'runners' : null),
      player(IDS.hu1, 'Hunter 1', false, T0 - 2000, live ? 'hunter' : null, live ? 'hunters' : null),
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

test('admin-summary returns the live roster with NO coordinates anywhere', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  const { status, body } = await op(doInstance, { op: 'admin-summary' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.room.phase, 'ACTIVE');
  assert.equal(body.room.roomCode, 'ABCDEF');
  assert.equal(body.players.length, 4);
  assert.equal(body.players.find((p) => p.playerId === IDS.r1).displayName, 'Runner 1');
  assert.ok(!JSON.stringify(body).includes('"lat"'), 'no latitude in the summary');
  assert.ok(!JSON.stringify(body).includes('"lng"'), 'no longitude in the summary');
});

test('admin-live-fix returns the DO-memory fix, and 404s for a seat with no fix', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  await op(doInstance, { op: 'admin-summary' }); // loads the store
  doInstance.store.mem.latestFix[IDS.r1] = { lat: 23.35, lng: 85.33, accuracyMeters: 8, timestampMs: T0 };
  const withFix = await op(doInstance, { op: 'admin-live-fix', playerId: IDS.r1 });
  assert.equal(withFix.status, 200);
  assert.deepEqual(withFix.body.fix, { lat: 23.35, lng: 85.33, accuracyMeters: 8, timestampMs: T0 });
  const noFix = await op(doInstance, { op: 'admin-live-fix', playerId: IDS.r2 });
  assert.equal(noFix.status, 200);
  assert.equal(noFix.body.fix, null);
  const gone = await op(doInstance, { op: 'admin-live-fix', playerId: 'ffffffff-9999-4999-8999-999999999999' });
  assert.equal(gone.status, 404);
});

test('admin-kick in a live game ejects (4405 path) and a second kick 409s; the host cannot be kicked', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  const kicked = await op(doInstance, { op: 'admin-kick', targetPlayerId: IDS.r1, adminActor: 'owner' });
  assert.equal(kicked.status, 200);
  assert.equal(kicked.body.kickedPlayerId, IDS.r1);
  const state = await fake.storage.get(STATE_KEY);
  const seat = state.players.find((p) => p.playerId === IDS.r1);
  assert.ok(seat.ejectedAt, 'live kick stamps ejectedAt (the v33 ejection primitive)');
  assert.equal(state.room.phase, 'ACTIVE', 'ejecting one of two runners does not end the match');
  const again = await op(doInstance, { op: 'admin-kick', targetPlayerId: IDS.r1, adminActor: 'owner' });
  assert.equal(again.status, 409, 'an ejected seat cannot be kicked twice');
  const host = await op(doInstance, { op: 'admin-kick', targetPlayerId: IDS.h1, adminActor: 'owner' });
  assert.equal(host.status, 409, 'the host cannot be kicked');
});

test('admin-force-results completes the match with current standings; a second call 409s', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  const forced = await op(doInstance, { op: 'admin-force-results' });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.phase, 'COMPLETED');
  assert.equal(forced.body.result.outcome, 'runners-win', 'two runners survive, none caught');
  assert.deepEqual(forced.body.result.survivingRunnerIds.sort(), [IDS.r1, IDS.r2].sort());
  const again = await op(doInstance, { op: 'admin-force-results' });
  assert.equal(again.status, 409, 'a completed match cannot be force-completed again');
});

test('admin-force-results from LOBBY 409s; admin-kick in LOBBY removes the seat; admin-end deletes the room', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'LOBBY');
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  const forced = await op(doInstance, { op: 'admin-force-results' });
  assert.equal(forced.status, 409);
  const kicked = await op(doInstance, { op: 'admin-kick', targetPlayerId: IDS.r1, adminActor: 'admin1' });
  assert.equal(kicked.status, 200);
  let state = await fake.storage.get(STATE_KEY);
  assert.ok(state.players.find((p) => p.playerId === IDS.r1).leftAt, 'lobby kick stamps leftAt');
  const ended = await op(doInstance, { op: 'admin-end', adminActor: 'admin1' });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.phase, 'CANCELLED');
  assert.equal(ended.body.deleted, true, 'cancel deletes the live room (v23 Rule 1 delete flow)');
  state = await fake.storage.get(STATE_KEY);
  assert.equal(state, undefined, 'the wiped room is gone from DO storage');
  const after = await op(doInstance, { op: 'admin-summary' });
  assert.equal(after.status, 404, 'a deleted room answers ROOM_NOT_FOUND');
});

// Fix round 5 (M3-A, DO-level pin): the cancel's persist is a
// match-result PATCH + a room-upsert, BOTH landing phase CANCELLED
// with the cancelled result — and NO delete of the mirror row.
// deleteRoomAfterHostCancel (room-do-class.ts:673-713) deletes the
// DO's own storage, not the Supabase mirror: its own comment says
// "Supabase rows are NOT deleted … The `rooms` row (phase
// CANCELLED + result) and the `players` rows stay as the audit
// record". A regression where the cancel's persist fails (or a
// future change that deleted the row) would leave the mirror on
// DRAFT — or row-less — and the erase host-guard would read a
// state the cancel never produced; this test pins the writes the
// real DO fires.
test('M3-A fix round 5: admin-end persists the cancel record — match-result PATCH + room-upsert, both CANCELLED, and no mirror-row DELETE', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'LOBBY');
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  // Capture EVERY mirror write the DO fires (the capturing fetch
  // answers ok, as PostgREST would for a well-formed write).
  const persisted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (typeof url === 'string' && url.includes('/rest/v1/')) {
      persisted.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const ended = await op(doInstance, { op: 'admin-end', adminActor: 'admin1' });
    assert.equal(ended.status, 200);
    assert.equal(ended.body.phase, 'CANCELLED');
    assert.equal(ended.body.deleted, true, 'cancel deletes the live room (DO storage), not the mirror row');
    await fake.flush();
  } finally {
    globalThis.fetch = realFetch;
  }
  // The match-result PATCH lands phase + result on the mirror row.
  const matchResult = persisted.find((p) => p.method === 'PATCH' && p.url.includes('/rooms?room_id=eq.room-1'));
  assert.ok(matchResult, 'the cancel fires a match-result PATCH to the rooms row');
  assert.equal(matchResult.body.phase, 'CANCELLED', 'the PATCH lands phase CANCELLED');
  assert.equal(matchResult.body.result.outcome, 'cancelled', 'the PATCH lands the cancelled result');
  // The room-upsert carries the same cancelled room.
  const upsert = persisted.find((p) => p.method === 'POST' && p.url.includes('/rooms?on_conflict=room_id'));
  assert.ok(upsert, 'the cancel fires a room-upsert for the same room');
  assert.equal(upsert.body.room_id, 'room-1');
  assert.equal(upsert.body.phase, 'CANCELLED', 'the upsert carries phase CANCELLED');
  assert.equal(upsert.body.result.outcome, 'cancelled', 'the upsert carries the cancelled result');
  // And no mirror write deletes anything: the rooms row stays as
  // the audit record, and the players rows stay with it.
  assert.equal(persisted.filter((p) => p.method === 'DELETE').length, 0, 'the cancel deletes no mirror row (no DELETE anywhere in its persist)');
  // The DO storage itself IS wiped — that is the delete that happened.
  const state = await fake.storage.get(STATE_KEY);
  assert.equal(state, undefined, 'the wiped room is gone from DO storage');
});

test('admin-kick from a terminal phase 409s INVALID_STATE; kicking an already-left seat 409s CONFLICT (fix round M3-1)', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'COMPLETED');
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  const terminal = await op(doInstance, { op: 'admin-kick', targetPlayerId: IDS.r1, adminActor: 'owner' });
  assert.equal(terminal.status, 409, 'a finished room cannot be kicked from');
  assert.equal(terminal.body.code, 'INVALID_STATE');
  assert.equal(terminal.body.status, undefined, 'the real DO failure body carries code but no status — the erase must key on the code');
  const fake2 = makeCtx();
  await seedRoom(fake2, 'LOBBY');
  const do2 = new RoomDO(fake2.ctx, makeEnv());
  const first = await op(do2, { op: 'admin-kick', targetPlayerId: IDS.r1, adminActor: 'owner' });
  assert.equal(first.status, 200);
  const again = await op(do2, { op: 'admin-kick', targetPlayerId: IDS.r1, adminActor: 'owner' });
  assert.equal(again.status, 409, 'an already-left seat cannot be kicked twice');
  assert.equal(again.body.code, 'CONFLICT');
});

test('admin-redact-player forgets the player in DO memory and the following room-upsert carries [erased], never the id (fix round M3-B)', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'COMPLETED');
  // The finished room still names the hunter in its result + config,
  // and the host in hostPlayerId — exactly the residue the mirror
  // scrub cannot protect against a later DO persist.
  const seeded = await fake.storage.get(STATE_KEY);
  seeded.room.result = {
    outcome: 'hunters-win',
    durationSeconds: 600,
    caughtRunnerIds: [IDS.r1],
    survivingRunnerIds: [IDS.r2],
    tags: [{ hunterPlayerId: IDS.hu1, runnerPlayerId: IDS.r1, confirmedAt: new Date(T0).toISOString() }],
  };
  await fake.storage.put(STATE_KEY, seeded);
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  // Capture every persist the DO fires (room-upsert → POST
  // /rest/v1/rooms). The capturing fetch answers ok, as PostgREST
  // would for a well-formed row.
  const persisted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (typeof url === 'string' && url.includes('/rest/v1/rooms')) {
      persisted.push(JSON.parse(init.body));
    }
    return { ok: true };
  };
  try {
    const hunter = await op(doInstance, { op: 'admin-redact-player', targetPlayerId: IDS.hu1 });
    assert.equal(hunter.status, 200);
    assert.equal(hunter.body.redacted, true);
    await fake.flush();
    const host = await op(doInstance, { op: 'admin-redact-player', targetPlayerId: IDS.h1 });
    assert.equal(host.status, 200);
    assert.equal(host.body.redacted, true);
    await fake.flush();
    // Redacting an id the DO never held is still ok, never a 404 —
    // the erase must proceed either way.
    const unknown = await op(doInstance, { op: 'admin-redact-player', targetPlayerId: 'ffffffff-9999-4999-8999-999999999999' });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.redacted, false);
    await fake.flush();
  } finally {
    globalThis.fetch = realFetch;
  }
  // DO memory itself forgot both ids…
  const state = await fake.storage.get(STATE_KEY);
  assert.equal(state.room.hostPlayerId, '[erased]', 'the host id is [erased] in DO memory');
  assert.deepEqual(state.room.config.selectedHunterIds, ['[erased]'], 'selectedHunterIds is redacted in DO memory');
  assert.equal(state.room.result.tags[0].hunterPlayerId, '[erased]', 'result tags are redacted in DO memory');
  assert.equal(state.room.result.tags[0].runnerPlayerId, IDS.r1, 'other players’ ids are untouched');
  // …and the room-upsert the redact triggered carries '[erased]'
  // (never the id again) — with host_player_id null, because
  // '[erased]' is not a UUID and the rooms column is uuid.
  assert.ok(persisted.length >= 2, 'each changing redact persisted the room');
  const last = persisted[persisted.length - 1];
  assert.equal(JSON.stringify(last).includes(IDS.hu1), false, 'the persisted room never carries the hunter id again');
  assert.equal(JSON.stringify(last).includes(IDS.h1), false, 'the persisted room never carries the host id again');
  assert.equal(last.host_player_id, null, 'the uuid host column carries null, not the [erased] marker');
  assert.deepEqual(last.config.selectedHunterIds, ['[erased]']);
  assert.equal(last.result.tags[0].hunterPlayerId, '[erased]');
});

test('getRuntimeFlags fails OPEN to defaults when the flag fetch is unreadable', async () => {
  clearRuntimeFlagCache();
  globalThis.fetch = async () => ({ ok: true }); // no .json — unreadable
  const flags = await getRuntimeFlags({ SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  assert.equal(flags['radio'], true, 'a Supabase outage must never mute a live game');
  assert.equal(flags['gameStart'], true);
  assert.equal(flags['billing.overview'], false);
  clearRuntimeFlagCache();
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [
      { key: 'radio', enabled: false },
      { key: 'billing.overview', enabled: true },
    ],
  });
  const live = await getRuntimeFlags({ SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  assert.equal(live['radio'], false, 'an explicit OFF is honoured');
  assert.equal(live['billing.overview'], true);
  assert.equal(live['pings'], true, 'unlisted flags keep their defaults');
  clearRuntimeFlagCache();
  globalThis.fetch = async () => ({ ok: true });
});

// Fix round 4 (M3-B hole 1): redact a caught runner, then complete
// the match — the rebuilt result (caughtRunnerIds / tags) must carry
// '[erased]', never the id, in ANY mirror write the force-results
// fires (MATCH_COMPLETED room_event payload, rooms match-result
// PATCH, rooms room-upsert). Diya proved the hole live with
// /tmp/m3b-attack.mjs: the unredacted state.catches rebuilt the tag
// and re-persisted r1 into all three writes after an erased:true.
test('M3-B fix round 4: redact-then-force-results persists no erased id anywhere (hole 1: state.catches)', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'ACTIVE');
  const seeded = await fake.storage.get(STATE_KEY);
  seeded.catches = [{
    catchId: 'catch-1', roomId: 'room-1', hunterPlayerId: IDS.hu1, runnerPlayerId: IDS.r1,
    state: 'confirmed', qrTokenHash: null, requestedAt: new Date(T0).toISOString(),
    confirmedAt: new Date(T0 + 1000).toISOString(), disputedAt: null,
    resolution: 'confirmed', gpsEvidence: null,
  }];
  await fake.storage.put(STATE_KEY, seeded);
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  // Capture EVERY mirror write the DO fires (room_events POST,
  // rooms PATCH/POST) — the hole re-persisted r1 into three of them.
  const persisted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (typeof url === 'string' && url.includes('/rest/v1/')) {
      persisted.push({ url, body: init.body ? JSON.parse(init.body) : null });
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const redact = await op(doInstance, { op: 'admin-redact-player', targetPlayerId: IDS.r1 });
    assert.equal(redact.status, 200);
    assert.equal(redact.body.redacted, true);
    await fake.flush();
    const afterRedact = await fake.storage.get(STATE_KEY);
    assert.equal(afterRedact.catches[0].runnerPlayerId, '[erased]', 'the catch itself is redacted in DO memory');
    assert.equal(afterRedact.catches[0].hunterPlayerId, IDS.hu1, 'the other seat of the catch is untouched');
    assert.equal(afterRedact.players.some((p) => p.playerId === IDS.r1), false, 'the seat is dropped from DO memory');
    persisted.length = 0;
    const forced = await op(doInstance, { op: 'admin-force-results' });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.phase, 'COMPLETED');
    await fake.flush();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(persisted.length > 0, 'force-results fired mirror writes to check');
  const leaked = persisted.filter((p) => JSON.stringify(p.body).includes(IDS.r1));
  assert.equal(leaked.length, 0, `no mirror write re-persists the erased id (leaked into: ${leaked.map((p) => p.url).join(', ')})`);
  assert.ok(persisted.some((p) => p.url.includes('/room_events')), 'the MATCH_COMPLETED room_event was among the writes checked');
  assert.ok(persisted.some((p) => p.url.includes('/rooms')), 'the rooms match-result / room-upsert writes were among the writes checked');
  const state = await fake.storage.get(STATE_KEY);
  assert.deepEqual(state.room.result.caughtRunnerIds, ['[erased]'], 'the rebuilt result carries the marker, not the id');
  assert.equal(state.room.result.tags[0].runnerPlayerId, '[erased]');
  assert.deepEqual(state.room.result.survivingRunnerIds, [IDS.r2], 'the other runner still survives');
});

// Fix round 4 (M3-B hole 2): the erased LOBBY seat must not restore
// by display name + saved reconnect token, and no read path may
// re-serve the id or the codename afterwards. Diya proved the hole
// live with /tmp/m3b-attack2.mjs: kick + redact, then rejoin → 200
// restored:true, leftAt:null, and a player-upsert re-created the
// deleted players row.
test('M3-B fix round 4: redact-then-rejoin in LOBBY 403s and the summary never re-serves the id or codename (hole 2: seat + token)', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'LOBBY');
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  const kicked = await op(doInstance, { op: 'admin-kick', targetPlayerId: IDS.r1, adminActor: 'owner' });
  assert.equal(kicked.status, 200);
  const redact = await op(doInstance, { op: 'admin-redact-player', targetPlayerId: IDS.r1 });
  assert.equal(redact.status, 200);
  assert.equal(redact.body.redacted, true);
  await fake.flush();
  let state = await fake.storage.get(STATE_KEY);
  assert.equal(state.players.some((p) => p.playerId === IDS.r1), false, 'the seat is dropped from DO memory');
  assert.ok(state.erasedSeatNames.includes('runner 1'), 'the codename is tombstoned (lowercased)');
  // The erased player rejoins with display name + saved token.
  const rejoin = await op(doInstance, {
    op: 'add-player', displayName: 'Runner 1', roomCode: 'ABCDEF',
    reconnectTokenHash: `reconnect-hash-${IDS.r1}`,
  });
  assert.equal(rejoin.status, 403, 'the restore is refused, not restored:true');
  assert.equal(rejoin.body.code, 'FORBIDDEN');
  await fake.flush();
  state = await fake.storage.get(STATE_KEY);
  assert.equal(state.players.some((p) => p.playerId === IDS.r1), false, 'no player-upsert re-created the seat');
  assert.equal(state.players.length, 3, 'no fresh seat was minted under the codename either');
  // Every read path: summary, live-fix, snapshot (via verify).
  const summary = await op(doInstance, { op: 'admin-summary' });
  assert.equal(summary.status, 200);
  assert.equal(JSON.stringify(summary.body).includes(IDS.r1), false, 'the summary carries no erased id');
  assert.equal(JSON.stringify(summary.body).includes('Runner 1'), false, 'the summary carries no erased codename');
  assert.equal(summary.body.players.length, 3);
  const liveFix = await op(doInstance, { op: 'admin-live-fix', playerId: IDS.r1 });
  assert.equal(liveFix.status, 404, 'the live fix has no seat to serve');
  const verify = await op(doInstance, { op: 'verify-reconnect', playerId: IDS.r1, reconnectTokenHash: `reconnect-hash-${IDS.r1}` });
  assert.equal(verify.body.valid, false, 'the saved token verifies nothing anymore');
});

// Fix round 5 (cached join reply): a join reply is cached under
// `join:<roomId>:<key>`, keyed by room — the redact's `${target}:`
// sweep never touched it, and `dispatchOp` serves the cache before
// dispatch, bypassing the tombstone. Diya proved it live: join with
// idempotencyKey 'k-r1-join' → redact → replay the same add-player
// with the same key → HTTP 200 with the erased id, codename, AND
// the original raw reconnect token. After the fix the replay must
// hit the tombstone 403, while another seat's cached join survives
// (the fix drops only the erased player's cached joins).
test('M3-B fix round 5: redact drops the erased player\'s cached join reply — replaying the join with the same idempotency key 403s, and another seat\'s cached join still replays', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'LOBBY');
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  const join = (displayName, key) => op(doInstance, {
    op: 'add-player', displayName, roomCode: 'ABCDEF',
    reconnectTokenHash: null, idempotencyKey: key,
  });
  // Seat 1 joins with an idempotency key; the reply carries the
  // seat id and the RAW reconnect token.
  const first = await join('Joiner 1', 'k-j1-join');
  assert.equal(first.status, 200);
  assert.equal(first.body.restored, false);
  const joiner1Id = first.body.player.playerId;
  const joiner1Token = first.body.reconnectToken;
  assert.ok(typeof joiner1Token === 'string' && joiner1Token.length > 0, 'the first join minted a raw token');
  // A replay BEFORE the redact is a cache hit: same id, same token.
  const replayBefore = await join('Joiner 1', 'k-j1-join');
  assert.equal(replayBefore.status, 200, 'the cache is populated before the redact (otherwise the pin is vacuous)');
  assert.equal(replayBefore.body.player.playerId, joiner1Id);
  assert.equal(replayBefore.body.reconnectToken, joiner1Token, 'the replay serves the ORIGINAL token from the cache');
  // Seat 2 joins with its own key — its cached reply must survive
  // a redact of seat 1 (the fix is per-player, not per-room).
  const second = await join('Joiner 2', 'k-j2-join');
  assert.equal(second.status, 200);
  const joiner2Id = second.body.player.playerId;
  const joiner2Token = second.body.reconnectToken;
  // Redact seat 1, then replay BOTH joins with their original keys.
  const redact = await op(doInstance, { op: 'admin-redact-player', targetPlayerId: joiner1Id });
  assert.equal(redact.status, 200);
  assert.equal(redact.body.redacted, true);
  await fake.flush();
  const replayErased = await join('Joiner 1', 'k-j1-join');
  assert.equal(replayErased.status, 403, 'the erased seat\'s cached join must not replay — it hits the tombstone');
  assert.equal(replayErased.body.code, 'FORBIDDEN');
  assert.equal(JSON.stringify(replayErased.body).includes(joiner1Id), false, 'the 403 carries no erased id');
  assert.equal(JSON.stringify(replayErased.body).includes(joiner1Token), false, 'the 403 carries no raw token');
  const replayOther = await join('Joiner 2', 'k-j2-join');
  assert.equal(replayOther.status, 200, 'another seat\'s cached join still replays after the redact');
  assert.equal(replayOther.body.player.playerId, joiner2Id);
  assert.equal(replayOther.body.reconnectToken, joiner2Token, 'the other seat keeps its ORIGINAL token from the cache');
});

// Fix round 4 (M3-B, Zara pin): erase a caught runner from a
// COMPLETED room, then replay the room — the replay's player-upserts
// and the admin summary must show the id nowhere. (Force-results
// cannot run from COMPLETED — it 409s — so replay is the rebuild
// that could resurrect the seat; the hole-1 test above pins the
// force-results rebuild from ACTIVE.)
test('M3-B fix round 4: erase a caught runner from a COMPLETED room, then replay + admin-summary show the id nowhere (Zara pin)', async () => {
  const fake = makeCtx();
  await seedRoom(fake, 'COMPLETED');
  const seeded = await fake.storage.get(STATE_KEY);
  seeded.room.result = {
    outcome: 'hunters-win',
    durationSeconds: 600,
    caughtRunnerIds: [IDS.r1],
    survivingRunnerIds: [IDS.r2],
    tags: [{ hunterPlayerId: IDS.hu1, runnerPlayerId: IDS.r1, confirmedAt: new Date(T0).toISOString() }],
  };
  seeded.catches = [{
    catchId: 'catch-1', roomId: 'room-1', hunterPlayerId: IDS.hu1, runnerPlayerId: IDS.r1,
    state: 'confirmed', qrTokenHash: null, requestedAt: new Date(T0).toISOString(),
    confirmedAt: new Date(T0 + 1000).toISOString(), disputedAt: null,
    resolution: 'confirmed', gpsEvidence: null,
  }];
  await fake.storage.put(STATE_KEY, seeded);
  const doInstance = new RoomDO(fake.ctx, makeEnv());
  // A live fix in DO memory for the runner: the redact must clear it.
  await op(doInstance, { op: 'admin-summary' }); // loads the store
  doInstance.store.mem.latestFix[IDS.r1] = { lat: 23.35, lng: 85.33, accuracyMeters: 8, timestampMs: T0 };
  const persisted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (typeof url === 'string' && url.includes('/rest/v1/')) {
      persisted.push({ url, body: init.body ? JSON.parse(init.body) : null });
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const redact = await op(doInstance, { op: 'admin-redact-player', targetPlayerId: IDS.r1 });
    assert.equal(redact.status, 200);
    assert.equal(redact.body.redacted, true);
    await fake.flush();
    const liveFix = await op(doInstance, { op: 'admin-live-fix', playerId: IDS.r1 });
    assert.equal(liveFix.status, 404, 'the live fix is cleared with the seat');
    persisted.length = 0;
    const replayed = await op(doInstance, { op: 'replay', playerId: IDS.h1, hostTokenHash: 'host-hash' });
    assert.equal(replayed.status, 200, 'the host replays the finished room');
    assert.equal(replayed.body.phase, 'LOBBY');
    await fake.flush();
  } finally {
    globalThis.fetch = realFetch;
  }
  const leaked = persisted.filter((p) => JSON.stringify(p.body).includes(IDS.r1));
  assert.equal(leaked.length, 0, `no replay persist re-serves the erased id (leaked into: ${leaked.map((p) => p.url).join(', ')})`);
  assert.ok(persisted.some((p) => p.url.includes('/players')), 'the replay player-upserts were among the writes checked');
  const summary = await op(doInstance, { op: 'admin-summary' });
  assert.equal(summary.status, 200);
  assert.equal(JSON.stringify(summary.body).includes(IDS.r1), false, 'the post-replay summary carries no erased id');
  assert.equal(JSON.stringify(summary.body).includes('Runner 1'), false, 'the post-replay summary carries no erased codename');
  const state = await fake.storage.get(STATE_KEY);
  assert.equal(state.players.some((p) => p.playerId === IDS.r1), false, 'the seat stays dropped after replay');
  assert.ok(state.erasedSeatNames.includes('runner 1'), 'the tombstone survives replay');
  // And the codename still cannot be joined under in the fresh lobby.
  const rejoin = await op(doInstance, {
    op: 'add-player', displayName: 'Runner 1', roomCode: 'ABCDEF',
    reconnectTokenHash: `reconnect-hash-${IDS.r1}`,
  });
  assert.equal(rejoin.status, 403, 'the erased codename stays refused after replay');
});

