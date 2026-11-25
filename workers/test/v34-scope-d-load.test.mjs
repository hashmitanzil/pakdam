import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory, STATE_KEY } = await import('../src/room-do.ts');
const { RoomDO } = await import('../src/room-do-class.ts');
const { persistPlayer } = await import('../src/supabase.ts');
const sharedNs = await import('@pakdam/shared');
const {
  DEFAULT_ROOM_CONFIG,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSED_LIMIT,
} = sharedNs;

globalThis.fetch = async () => ({ ok: true });

// v34 Scope D (item 13) — heavy-user handling, server side.
// The load target is a 30-player live game. These tests pin, at 30
// seats, that presence, heartbeat (30 s / missed 3) and the 30-second
// rule hold — plus the two measurements Scope D item 11 needs from the
// server: the per-join snapshot-storm count, and the persistPlayer
// mirror shape (12a). A5 per-tab presence is an OPEN founder call and
// is NOT built or tested here; F1 (self-confirm ±50 m leg) likewise.
//
// What this file does NOT prove (VM limits, stated plainly): real DO
// CPU / save latency (FakeStorage.put is a Map set), real network
// round-trips, or a live 30-phone game. The founder's CI + phone run
// is the verdict for those.
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

// 30 seats: host + 2 hunters + 27 runners. IDs sort lexicographically
// in storage-list order; join order is the array order.
const IDS = [
  'h1',
  'hu1',
  'hu2',
  ...Array.from({ length: 27 }, (_, i) => `r${i + 1}`),
];
const HUNTER_IDS = ['hu1', 'hu2'];

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

function makeStore({ phase = 'LOBBY', ids = IDS } = {}) {
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
    selectedHunterIds: [...HUNTER_IDS],
    hunterCount: HUNTER_IDS.length,
    balanceHunters: false,
    randomDraw: false,
  };
  const players = ids.map((id, i) =>
    player(id, id === 'h1' ? 'Host' : `Player ${i}`, id === 'h1'),
  );
  const live = phase !== 'LOBBY';
  const state = {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase,
      version: 1,
      config,
      createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: live ? new Date(T0).toISOString() : null,
      endsAt: live ? new Date(T0 + 3600_000).toISOString() : null,
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

function startActive(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `startMatch must succeed: ${r.ok ? '' : r.error}`);
  // headStartSeconds = 0: the next tick moves HEAD_START -> ACTIVE.
  store.alarmTick(atMs + 1000, { liveSocketCount: 30 });
  assert.equal(store.room.phase, 'ACTIVE');
}

async function sendFix(store, playerId, atMs, point = INSIDE) {
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

async function sendWs(store, playerId, type, payload, commandId, atMs) {
  return store.handleWsMessage({ playerId, sessionId: 's1' }, { type, commandId, payload }, atMs);
}

// ---------------------------------------------------------------------------
// 13 — presence + heartbeat hold at 30 players
// ---------------------------------------------------------------------------

test('v34 Scope D (13): 30-player ACTIVE game — every seat fixes + heartbeats, presence present for all 30, no suspension', async () => {
  const store = makeStore();
  startActive(store);
  for (const id of IDS) {
    await sendFix(store, id, T0 + 2000);
    const hb = await sendWs(store, id, 'heartbeat', {}, `hb-${id}`, T0 + 2000);
    assert.equal(
      hb.events.some((e) => e.type === 'heartbeat.ack'),
      true,
      `${id} must get a heartbeat.ack`,
    );
  }
  for (const id of IDS) {
    assert.equal(store.presenceFor(store.player(id)), 'present', `${id} must read present`);
    assert.equal(store.player(id).connectionState, 'connected', `${id} must stay connected`);
    assert.equal(store.player(id).ejectedAt, null, `${id} must not be ejected`);
  }
  // Every seat can still read a full snapshot (the fan-out input).
  for (const id of IDS) {
    const snap = store.snapshotFor(id, T0 + 2000);
    assert.equal(snap.players.length, 30, 'snapshot must carry all 30 seats');
  }
});

// ---------------------------------------------------------------------------
// 11b — per-join snapshot-storm count, MEASURED
// ---------------------------------------------------------------------------

test('v34 Scope D (11b) MEASURED: one join into a 29-player lobby triggers 61 client snapshot re-fetches', async () => {
  // 29 seats + the joiner = the 30-seat cap (a 30-seat lobby refuses
  // a 31st join with "This room is full" — pinned by the cap itself).
  const store = makeStore({ ids: IDS.slice(0, 29) });
  const before = store.state.players.length;
  assert.equal(before, 29);
  const joined = await store.addPlayerAsync({
    displayName: 'Late Joiner',
    roomCode: 'ABCDEF',
    reconnectTokenHash: null,
    nowMs: T0 + 5000,
  });
  assert.equal(joined.ok, true, `join must succeed: ${joined.ok ? '' : joined.error}`);
  const subjectId = joined.value.player.playerId;
  // The client re-fetches on player.joined and on room.state
  // (useRoomState.ts). Count trigger deliveries per recipient:
  // - broadcast player.joined -> all 30 seats (redacted view)
  // - direct player.joined -> the subject only (own view)
  // - room.state -> all 30 seats
  // Existing seat: 2 triggers. Subject: 3. Total 29*2 + 3 = 61.
  // The server answers the second identical request with
  // snapshot.unchanged ONLY when the client's key already moved; both
  // requests leave with the same stale key, so both are full
  // snapshots. The fix is client-side coalescing (Meera) — this test
  // pins the count so the fix can prove it drops.
  let triggers = 0;
  const perRecipient = new Map();
  for (const e of joined.events) {
    if (e.type !== 'player.joined' && e.type !== 'room.state') continue;
    for (const rid of e.recipients) {
      triggers += 1;
      perRecipient.set(rid, (perRecipient.get(rid) ?? 0) + 1);
    }
  }
  assert.equal(triggers, 61, `one join must trigger 61 snapshot re-fetches, got ${triggers}`);
  assert.equal(perRecipient.get(subjectId), 3, 'the joining seat itself re-fetches 3 times');
  for (const id of IDS.slice(0, 29)) {
    assert.equal(perRecipient.get(id), 2, `existing seat ${id} must re-fetch twice per join`);
  }
});

// ---------------------------------------------------------------------------
// 13 — heartbeat missed-3 at 30 players (real RoomDO alarm)
// ---------------------------------------------------------------------------

class FakeSocket {
  sent = [];
  closed = [];
  /** Set by makeCtx: detaches this socket from every tag list on close,
   * mirroring the runtime (a closed socket leaves getWebSockets). */
  _detach = null;
  send(text) {
    this.sent.push(text);
  }
  close(code, reason) {
    this.closed.push({ code, reason });
    if (this._detach) this._detach();
  }
}

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
  const wsTags = new Map();
  const pending = [];
  const ctx = {
    storage,
    blockConcurrencyWhile: async (fn) => fn(),
    getWebSockets: (tag) => sockets.get(tag) ?? [],
    getTags: (ws) => wsTags.get(ws) ?? [],
    waitUntil: (p) => {
      pending.push(p);
      p.catch(() => undefined);
    },
  };
  return {
    ctx,
    storage,
    sockets,
    addSocket(tag, existing) {
      const s = existing ?? new FakeSocket();
      // A close detaches from EVERY tag (one physical socket carries
      // both [playerId, tab:sessionId] tags in production).
      s._detach = () => {
        for (const list of sockets.values()) {
          const i = list.indexOf(s);
          if (i >= 0) list.splice(i, 1);
        }
      };
      if (!sockets.has(tag)) sockets.set(tag, []);
      sockets.get(tag).push(s);
      return s;
    },
    tagSocket(ws, tags) {
      wsTags.set(ws, tags);
    },
    async flush() {
      await Promise.allSettled(pending);
      pending.length = 0;
    },
  };
}

function makeEnv() {
  return {
    env: {
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
    },
  };
}

function sessionFor(playerId, tab, lastHeartbeatAtMs) {
  return {
    sessionId: tab,
    playerId,
    ticketId: `ticket-${playerId}`,
    // Far-future expiry: this test measures heartbeat misses, not tickets.
    ticketExpiresAtMs: T0 + 600_000,
    renewalWarned: false,
    lastHeartbeatAtMs,
    missedHeartbeats: 0,
    helloDone: true,
  };
}

async function seedLobby30(fake, silentIds) {
  const store = makeStore();
  await fake.storage.put(STATE_KEY, store.state);
  for (const id of IDS) {
    const lastBeat = silentIds.includes(id) ? T0 - 100_000 : T0;
    await fake.storage.put(
      `session:${id}:tab-${id}`,
      sessionFor(id, `tab-${id}`, lastBeat),
    );
  }
}

test('v34 Scope D (13): heartbeat missed-3 at 30 players — 5 silent seats close 1011 + suspend, 25 live untouched', async () => {
  const silent = ['r23', 'r24', 'r25', 'r26', 'r27'];
  const live = IDS.filter((id) => !silent.includes(id));
  assert.equal(live.length, 25);
  const fake = makeCtx();
  const { env } = makeEnv();
  await seedLobby30(fake, silent);
  const doInstance = new RoomDO(fake.ctx, env);
  // Every seat has ONE listed socket under both its tags (a dead TCP
  // still lists — that is the v29 F5 shape: socket attached,
  // heartbeats stopped).
  const tabSockets = {};
  for (const id of IDS) {
    const s = fake.addSocket(`tab:tab-${id}`);
    fake.addSocket(id, s);
    tabSockets[id] = s;
  }
  // Mock the clock: the class reads Date.now() everywhere.
  let nowMs = T0;
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    // First tick: first-tick-after-wake grace resets the silent seats'
    // clocks (socket attached = proof of life on a wake) — nobody
    // suspends yet. That grace is the v28/v29 design, pinned here.
    await doInstance.alarm();
    await fake.flush();
    for (const id of silent) {
      assert.equal(
        tabSockets[id].closed.length,
        0,
        `first tick must not close silent seat ${id} (wake grace)`,
      );
    }
    // Live seats heartbeat at +30 s / +60 s / +90 s; silent seats never do.
    for (const beatMs of [T0 + 30_000, T0 + 60_000, T0 + 90_000]) {
      nowMs = beatMs;
      for (const id of live) {
        const ws = new FakeSocket();
        fake.tagSocket(ws, [id, `tab:tab-${id}`]);
        await doInstance.webSocketMessage(
          ws,
          JSON.stringify({ type: 'heartbeat', playerId: id, commandId: `hb-${id}-${beatMs}` }),
        );
      }
    }
    // Second tick at +95 s: silent seats missed 3 (95 s / 30 s), live
    // seats missed 0 (beat at +90 s).
    nowMs = T0 + 95_000;
    await doInstance.alarm();
    await fake.flush();
    const stored = await fake.storage.get(STATE_KEY);
    for (const id of silent) {
      assert.deepEqual(
        tabSockets[id].closed.map((c) => c.code),
        [1011],
        `silent seat ${id} must be closed 1011 (heartbeat timeout)`,
      );
      const seat = stored.players.find((p) => p.playerId === id);
      assert.equal(seat.connectionState, 'suspended', `silent seat ${id} must suspend`);
    }
    for (const id of live) {
      assert.equal(tabSockets[id].closed.length, 0, `live seat ${id} must never close`);
      const seat = stored.players.find((p) => p.playerId === id);
      assert.equal(seat.connectionState, 'connected', `live seat ${id} must stay connected`);
    }
    assert.equal(
      HEARTBEAT_MISSED_LIMIT,
      3,
      'the missed-3 limit is the calibration value this test exercises',
    );
    assert.equal(HEARTBEAT_INTERVAL_MS, 30_000, 'the heartbeat interval is 30 s');
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// 13 — the 30-second rule at 30 players (store)
// ---------------------------------------------------------------------------

test('v34 Scope D (13): 30 s rule at 30 players — 5 suspended, 1 resumes inside the window, 4 eject at +31 s, 25 untouched', async () => {
  const store = makeStore();
  startActive(store);
  const gone = ['r1', 'r2', 'r3', 'r4', 'r5'];
  const staying = IDS.filter((id) => !gone.includes(id));
  // Mid-game network loss for 5 seats at T0.
  for (const id of gone) {
    const r = store.suspendSeat(id, 'network-lost', T0);
    assert.equal(r.events.length > 0, true, `${id} must suspend`);
  }
  for (const id of gone) {
    assert.equal(
      store.reconnectEndsAtMs(id),
      T0 + 30_000,
      `${id} deadline must be start + 30 s`,
    );
  }
  // Tick at +29 s: nobody ejects (inside the window).
  let tick = store.alarmTick(T0 + 29_000, { liveSocketCount: 25 });
  assert.equal(
    tick.disconnect.length,
    0,
    'no ejection inside the 30 s window',
  );
  // r1 comes back inside the window: deadline cleared, role/score intact.
  const resumed = store.resumeOnHello('r1', T0 + 29_500);
  assert.equal(resumed.resumed, true, 'r1 must resume inside the window');
  assert.equal(store.reconnectEndsAtMs('r1'), null, 'r1 deadline must clear on resume');
  assert.equal(store.player('r1').connectionState, 'connected');
  assert.equal(store.player('r1').matchRole, 'runner', 'r1 keeps its role');
  // Everyone still in play sends a fresh fix before the +31 s tick,
  // so (4a) missing-fix ejection cannot fire for them — only the
  // return-window ejection (4b) may fire, for the 4 still-gone seats.
  for (const id of [...staying, 'r1']) {
    await sendFix(store, id, T0 + 30_500);
  }
  tick = store.alarmTick(T0 + 31_000, { liveSocketCount: 26 });
  const ejected = tick.disconnect.map((d) => d.playerId).sort();
  assert.deepEqual(ejected, ['r2', 'r3', 'r4', 'r5'], 'exactly the 4 still-gone seats eject at +31 s');
  for (const d of tick.disconnect) {
    assert.equal(d.code, 4405, 'return-window ejection closes 4405');
  }
  for (const id of [...staying, 'r1']) {
    assert.equal(store.player(id).ejectedAt, null, `${id} must not eject`);
    assert.equal(store.player(id).connectionState, 'connected', `${id} must stay connected`);
  }
});

// ---------------------------------------------------------------------------
// 13 — reconnect storm at 30 players (store): all 30 drop, all resume
// ---------------------------------------------------------------------------

test('v34 Scope D (13): reconnect storm — all 30 seats drop mid-game and re-hello, all resume with role/score intact, none eject', async () => {
  const store = makeStore();
  startActive(store);
  // Whole roster drops at once (signal loss): every seat suspends.
  for (const id of IDS) {
    store.suspendSeat(id, 'network-lost', T0 + 10_000);
  }
  assert.equal(
    IDS.filter((id) => store.player(id).connectionState === 'suspended').length,
    30,
    'all 30 must suspend on the drop',
  );
  // All 30 re-hello inside the window (storm order = array order).
  let resumedCount = 0;
  for (const id of IDS) {
    const r = store.resumeOnHello(id, T0 + 15_000);
    if (r.resumed) resumedCount += 1;
    const snap = store.snapshotFor(id, T0 + 15_000);
    assert.equal(snap.players.length, 30, 'resumed seat must read a full 30-seat snapshot');
  }
  assert.equal(resumedCount, 30, 'all 30 must resume');
  for (const id of IDS) {
    assert.equal(store.player(id).connectionState, 'connected', `${id} must be connected`);
    assert.equal(store.player(id).ejectedAt, null, `${id} must not eject`);
    assert.equal(store.reconnectEndsAtMs(id), null, `${id} deadline must clear`);
  }
  assert.equal(store.player('hu1').matchRole, 'hunter', 'hunter keeps role through the storm');
  assert.equal(store.player('r1').matchRole, 'runner', 'runner keeps role through the storm');
  assert.equal(store.room.hostPlayerId, 'h1', 'host keeps host through the storm');
  // A tick right after the storm ejects nobody.
  const tick = store.alarmTick(T0 + 16_000, { liveSocketCount: 30 });
  assert.equal(tick.disconnect.length, 0, 'no ejection after a full-roster resume');
});

// ---------------------------------------------------------------------------
// 12a — persistPlayer writes the six restored columns, no coordinates
// ---------------------------------------------------------------------------

test('v34 Scope D (12a): persistPlayer upsert carries ejected_at / connection_state / last_fix_at / location_quality / is_ready / briefing_confirmed, and no coordinate key', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true };
  };
  try {
    const p = player('r1', 'Runner 1');
    p.ejectedAt = new Date(T0 + 1000).toISOString();
    p.connectionState = 'suspended';
    p.lastFixAt = new Date(T0 + 500).toISOString();
    p.locationQuality = 'fair';
    p.isReady = true;
    p.briefingConfirmed = true;
    const ok = await persistPlayer(
      { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' },
      'room-1',
      p,
    );
    assert.equal(ok, true, 'persistPlayer must succeed');
    assert.equal(seen.length, 1, 'exactly one PostgREST call');
    assert.match(seen[0].url, /\/rest\/v1\/players\?on_conflict=player_id/);
    const row = seen[0].body;
    assert.equal(row.ejected_at, p.ejectedAt);
    assert.equal(row.connection_state, 'suspended');
    assert.equal(row.last_fix_at, p.lastFixAt);
    assert.equal(row.location_quality, 'fair');
    assert.equal(row.is_ready, true);
    assert.equal(row.briefing_confirmed, true);
    assert.equal(row.reconnect_token_hash, 'reconnect-hash-r1', 'hash still written, raw token never');
    const flat = JSON.stringify(row);
    for (const key of ['"lat"', '"lng"', '"latitude"', '"longitude"', '"fix"']) {
      assert.equal(flat.includes(key), false, `row must not carry ${key}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
