import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { clearRuntimeFlagCache } = await import('../src/admin-flags.ts');
const { handleStart, handleLifecycle } = await import('../src/http.ts');
const { RoomDO } = await import('../src/room-do-class.ts');
const { STATE_KEY } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG, hashHostToken } = await import('@pakdam/shared');

const T0 = 1_780_000_000_000;
const TRIANGLE = [
  { lat: 23.35, lng: 85.32 },
  { lat: 23.36, lng: 85.33 },
  { lat: 23.34, lng: 85.33 },
];

// ---------------------------------------------------------------------------
// gameStart OFF → start returns 503 FEATURE_DISABLED (fix round item 15)
// ---------------------------------------------------------------------------

function startReq() {
  return new Request('http://worker.test/v1/rooms/x/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: 'aaaaaaaa-1111-4111-8111-111111111111', hostToken: 'test-host-token' }),
  });
}

test('gameStart OFF: handleStart answers 503 FEATURE_DISABLED and never touches the DO', async () => {
  clearRuntimeFlagCache();
  let doCalls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/feature_flags')) {
      return new Response(
        JSON.stringify([
          { key: 'gameStart', enabled: false, updated_by: 'owner', updated_at: '2026-11-25T12:00:00.000Z' },
        ]),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ROOM_DO: { idFromName: (name) => name, get: () => { doCalls += 1; throw new Error('DO must not be called when gameStart is OFF'); } },
  };
  const ctx = { env, waitUntil: () => {} };
  const res = await handleStart(startReq(), ctx, 'rrrrrrrr-1111-4111-8111-111111111111');
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'FEATURE_DISABLED');
  assert.equal(doCalls, 0, 'the DO is never called when the kill-switch is OFF');
  clearRuntimeFlagCache();
});

test('gameStart ON: handleStart reaches the DO (control — the flag consult does not block normal starts)', async () => {
  clearRuntimeFlagCache();
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/feature_flags')) {
      return new Response(JSON.stringify([{ key: 'gameStart', enabled: true, updated_by: null, updated_at: null }]), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  let doCalls = 0;
  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ROOM_DO: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => {
          doCalls += 1;
          return new Response(JSON.stringify({ ok: true, room: { roomId: 'rrrrrrrr-1111-4111-8111-111111111111', phase: 'ACTIVE' }, players: [] }), { status: 200 });
        },
      }),
    },
  };
  const ctx = { env, waitUntil: () => {} };
  const res = await handleStart(startReq(), ctx, 'rrrrrrrr-1111-4111-8111-111111111111');
  assert.notEqual(res.status, 503, 'an ON flag does not 503');
  assert.equal(doCalls, 1, 'the start reaches the DO when the flag is ON');
  clearRuntimeFlagCache();
});

// ---------------------------------------------------------------------------
// gameStart OFF → lifecycle start is refused too (fix round, 2026-11-27:
// handleLifecycle used to bypass the kill-switch entirely —
// POST /v1/rooms/:id/lifecycle {action:'start'} started a match
// while new games were OFF). Only `start` is gated: pause/resume/end
// must keep working while new games are off.
// ---------------------------------------------------------------------------

const ROOM_ID = 'rrrrrrrr-1111-4111-8111-111111111111';
const PLAYER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

function lifecycleReq(action) {
  return new Request(`http://worker.test/v1/rooms/${ROOM_ID}/lifecycle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, playerId: PLAYER_ID, hostToken: 'test-host-token' }),
  });
}

function stubGameStartFetch(enabled) {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/feature_flags')) {
      return new Response(JSON.stringify([{ key: 'gameStart', enabled, updated_by: 'owner', updated_at: '2026-11-25T12:00:00.000Z' }]), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

function lifecycleEnv(validHostHashes, counters) {
  return {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ROOM_DO: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          if (body.op === 'verify-host-token') {
            counters.verify += 1;
            return new Response(JSON.stringify({ ok: true, valid: validHostHashes.has(body.hostTokenHash) }), { status: 200 });
          }
          counters.lifecycle += 1;
          return new Response(JSON.stringify({ ok: true, phase: 'ACTIVE' }), { status: 200 });
        },
      }),
    },
  };
}

test('gameStart OFF: lifecycle start answers 503 FEATURE_DISABLED and never touches the DO', async () => {
  clearRuntimeFlagCache();
  stubGameStartFetch(false);
  const counters = { verify: 0, lifecycle: 0 };
  const env = lifecycleEnv(new Set([await hashHostToken('test-host-token')]), counters);
  const ctx = { env, waitUntil: () => {} };
  const res = await handleLifecycle(lifecycleReq('start'), ctx, ROOM_ID);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'FEATURE_DISABLED');
  assert.equal(counters.verify, 0, 'the DO is never called when the kill-switch is OFF — not even to verify the host token');
  assert.equal(counters.lifecycle, 0, 'no lifecycle op reaches the DO');
  clearRuntimeFlagCache();
});

test('gameStart ON: lifecycle start reaches the DO (control — the flag consult does not block normal starts)', async () => {
  clearRuntimeFlagCache();
  stubGameStartFetch(true);
  const counters = { verify: 0, lifecycle: 0 };
  const env = lifecycleEnv(new Set([await hashHostToken('test-host-token')]), counters);
  const ctx = { env, waitUntil: () => {} };
  const res = await handleLifecycle(lifecycleReq('start'), ctx, ROOM_ID);
  assert.equal(res.status, 200, `an ON flag must let the lifecycle start through, got ${res.status}: ${await res.text()}`);
  assert.equal(counters.verify, 1, 'the host token is still verified first (verify-then-limit unchanged)');
  assert.equal(counters.lifecycle, 1, 'the start op reaches the DO when the flag is ON');
  clearRuntimeFlagCache();
});

test('gameStart OFF: lifecycle end is NOT gated — it still reaches the DO', async () => {
  clearRuntimeFlagCache();
  stubGameStartFetch(false);
  const counters = { verify: 0, lifecycle: 0 };
  const env = lifecycleEnv(new Set([await hashHostToken('test-host-token')]), counters);
  const ctx = { env, waitUntil: () => {} };
  const res = await handleLifecycle(lifecycleReq('end'), ctx, ROOM_ID);
  assert.equal(res.status, 200, `ending a game must keep working while new games are off, got ${res.status}: ${await res.text()}`);
  assert.equal(counters.lifecycle, 1, 'the end op reaches the DO');
  clearRuntimeFlagCache();
});

// ---------------------------------------------------------------------------
// radio OFF → WS radio message refused with an error event, socket stays
// open, nothing forwarded (fix round item 15). Harness mirrors the
// v33 ejected-seat test: ctx.getTags / getWebSockets, sessions at
// `session:<playerId>:<tab>`, room state under STATE_KEY.
// ---------------------------------------------------------------------------

class FakeSocket {
  sent = [];
  closed = [];
  send(text) {
    this.sent.push(text);
  }
  close(code, reason) {
    this.closed.push({ code, reason });
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
  async list({ prefix } = {}) {
    const out = new Map();
    for (const key of [...this.map.keys()].sort()) {
      if (prefix === undefined || key.startsWith(prefix)) out.set(key, this.map.get(key));
    }
    return out;
  }
  async setAlarm(atMs) {
    this.alarmsSet.push(atMs);
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
    addSocket(tag) {
      const s = new FakeSocket();
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

function doPlayer(id, displayName, isHost, joinedAtMs, matchRole = null) {
  return {
    playerId: id,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole,
    team: null,
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

function stateFor() {
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
    selectedHunterIds: ['hu1'],
    hunterCount: 1,
    balanceHunters: false,
    randomDraw: false,
  };
  return {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase: 'ACTIVE',
      version: 1,
      config,
      createdAt: new Date(T0 - 5000).toISOString(),
      startedAt: new Date(T0).toISOString(),
      endsAt: new Date(T0 + 3600_000).toISOString(),
      pausedAt: null,
      result: null,
    },
    players: [
      doPlayer('h1', 'Host', true, T0 - 5000, 'runner'),
      doPlayer('r1', 'Runner 1', false, T0 - 4000, 'runner'),
      doPlayer('hu1', 'Hunter 1', false, T0 - 2000, 'hunter'),
    ],
    catches: [],
    hostTokens: { h1: 'host-hash' },
    hostGrace: null,
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

function sessionFor(playerId, tab) {
  return {
    sessionId: tab,
    playerId,
    ticketId: `ticket-${playerId}`,
    ticketExpiresAtMs: Date.now() + 60_000,
    renewalWarned: false,
    lastHeartbeatAtMs: Date.now(),
    missedHeartbeats: 0,
    helloDone: true,
  };
}

function stubFlagFetch(enabled) {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/feature_flags')) {
      return new Response(JSON.stringify([{ key: 'radio', enabled, updated_by: 'owner', updated_at: '2026-11-25T12:00:00.000Z' }]), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

async function seededDo(radioEnabled) {
  clearRuntimeFlagCache();
  stubFlagFetch(radioEnabled);
  const fake = makeCtx();
  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    CODE_REGISTRY_DO: {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) }),
    },
  };
  await fake.storage.put(STATE_KEY, stateFor());
  await fake.storage.put('session:r1:tab-r1', sessionFor('r1', 'tab-r1'));
  const ws = fake.addSocket('r1');
  fake.addSocket('tab:tab-r1');
  fake.tagSocket(ws, ['r1', 'tab:tab-r1']);
  const doInstance = new RoomDO(fake.ctx, env);
  return { fake, ws, doInstance };
}

test('radio OFF: a radio.send over WS gets an error event (FEATURE_DISABLED), the socket stays open, nothing is forwarded', async () => {
  const { fake, ws, doInstance } = await seededDo(false);
  await doInstance.webSocketMessage(ws, JSON.stringify({ playerId: 'r1', type: 'radio.send', payload: { text: 'hello team' } }));
  await fake.flush();
  const sent = ws.sent.map((t) => JSON.parse(t));
  const errors = sent.filter((e) => e.type === 'error');
  assert.ok(errors.length >= 1, 'the client gets an error event, not silence');
  assert.equal(errors[0].payload.code, 'FEATURE_DISABLED', 'the refusal names the flag, not a generic error');
  assert.deepEqual(ws.closed, [], 'the socket stays open — a refused radio message is not a disconnect');
  assert.ok(!sent.some((e) => e.type === 'radio.receive'), 'nothing was forwarded to teammates');
  clearRuntimeFlagCache();
});

test('radio ON: a radio.send is accepted (control — no FEATURE_DISABLED error)', async () => {
  const { fake, ws, doInstance } = await seededDo(true);
  await doInstance.webSocketMessage(ws, JSON.stringify({ playerId: 'r1', type: 'radio.send', payload: { text: 'hello team' } }));
  await fake.flush();
  const sent = ws.sent.map((t) => JSON.parse(t));
  const disabled = sent.filter((e) => e.type === 'error' && e.payload && e.payload.code === 'FEATURE_DISABLED');
  assert.equal(disabled.length, 0, 'no FEATURE_DISABLED error when radio is ON');
  assert.deepEqual(ws.closed, [], 'the socket stays open');
  clearRuntimeFlagCache();
});
