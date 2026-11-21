import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomDO } = await import('../src/room-do-class.ts');
const { STATE_KEY } = await import('../src/room-do.ts');
const sharedNs = await import('@pakdam/shared');
const { DEFAULT_ROOM_CONFIG } = sharedNs;

// v23 fix round 1 — GAP tests (Arjun). The S1/S2/S3/S4/S6/S7/S8/S13/S14
// behaviours are already pinned by the other fix-round tests in
// v23-host-rules.test.mjs, v23-host-rules-do.test.mjs and
// host-cancel-succession.test.mjs; this file holds only the items those
// files do NOT cover:
//   T2(a) — the CANCELLED + `deleted=true` DO-storage save lands BEFORE
//           any wipe (the sibling gap test covers the Supabase PATCH
//           ordering; this one covers the DO-storage `put` ordering).
//   T6    — lifecycle 'end' rate limit keyed by room+playerId (see the
//           HTTP file: `v23-fix-round-1-gaps-http.test.mjs`).
//   T9    — probe/retry e2e (see `apps/web/e2e/v23-fix-round-1.spec.ts`).
//
// Harness mirrors v23-host-rules-do.test.mjs (a REAL `RoomDO` through
// its `/op` fetch with a fake DurableObjectState / env). `globalThis.fetch`
// is the PostgREST transport (the registry uses a stub, not fetch), so a
// per-test stub stands in for Supabase.
const T0 = 1_780_000_000_000;

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
  ops = [];
  async get(key) {
    return this.map.get(key);
  }
  async put(key, value) {
    this.ops.push({ kind: 'put', key, value });
    this.map.set(key, value);
  }
  async delete(key) {
    this.ops.push({ kind: 'delete', key });
    this.map.delete(key);
  }
  async deleteAll() {
    this.ops.push({ kind: 'deleteAll' });
    this.map.clear();
  }
  async deleteAlarm() {
    this.ops.push({ kind: 'deleteAlarm' });
  }
  async setAlarm(atMs) {
    this.ops.push({ kind: 'setAlarm', atMs });
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
    addSocket(tag) {
      const s = new FakeSocket();
      if (!sockets.has(tag)) sockets.set(tag, []);
      sockets.get(tag).push(s);
      return s;
    },
    async flush() {
      await Promise.allSettled(pending);
      pending.length = 0;
    },
  };
}

function makeEnv() {
  const registryCalls = [];
  return {
    registryCalls,
    env: {
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SERVICE_ROLE_KEY: 'test-key',
      CODE_REGISTRY_DO: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (_url, init) => {
            registryCalls.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        }),
      },
    },
  };
}

function player(id, displayName, isHost, joinedAtMs, matchRole = null) {
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

function stateFor(ids, phase = 'ACTIVE') {
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
    selectedHunterIds: [ids.hu1],
    hunterCount: 1,
    balanceHunters: false,
    randomDraw: false,
  };
  return {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: ids.h1,
      phase,
      version: 1,
      config,
      createdAt: new Date(T0 - 5000).toISOString(),
      startedAt: new Date(T0).toISOString(),
      endsAt: new Date(T0 + 3600_000).toISOString(),
      pausedAt: null,
      result: null,
    },
    players: [
      player(ids.h1, 'Host', true, T0 - 5000, 'runner'),
      player(ids.r1, 'Runner 1', false, T0 - 4000, 'runner'),
      player(ids.r2, 'Runner 2', false, T0 - 3000, 'runner'),
      player(ids.hu1, 'Hunter 1', false, T0 - 2000, 'hunter'),
    ],
    catches: [],
    hostTokens: { [ids.h1]: 'host-hash' },
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

async function seedRoom(fake, ids, phase = 'ACTIVE') {
  await fake.storage.put(STATE_KEY, stateFor(ids, phase));
  for (const id of Object.values(ids)) {
    await fake.storage.put(`session:${id}:tab-${id}`, {
      sessionId: `tab-${id}`,
      playerId: id,
      ticketId: `ticket-${id}`,
      ticketExpiresAtMs: Date.now() + 60_000,
      renewalWarned: false,
      lastHeartbeatAtMs: Date.now(),
      missedHeartbeats: 0,
      helloDone: true,
    });
  }
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

// ---------------------------------------------------------------------------
// T2(a) — the CANCELLED + deleted=true DO-storage save lands BEFORE any wipe
// ---------------------------------------------------------------------------

test('v23 fix (T2a) host cancel saves CANCELLED + deleted=true to DO storage BEFORE wiping it', async () => {
  const fake = makeCtx();
  const { env } = makeEnv();
  const ids = IDS;
  await seedRoom(fake, ids, 'ACTIVE');
  const doInstance = new RoomDO(fake.ctx, env);
  for (const id of Object.values(ids)) fake.addSocket(id);

  // Supabase is up: every PostgREST call lands.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true });
  // The seed's own puts are not part of the cancel — clear the log so
  // only the cancel path's storage ops are observed.
  fake.storage.ops.length = 0;
  let r;
  try {
    r = await op(doInstance, {
      op: 'lifecycle',
      action: 'end',
      playerId: ids.h1,
      hostTokenHash: 'host-hash',
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(r.status, 200, `lifecycle end must succeed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.deleted, true, 'the wipe must complete when the record lands');
  await fake.flush();

  const ops = fake.storage.ops;
  // The save: a put of the state key carrying the cancelled room.
  const saveIdx = ops.findIndex(
    (o) =>
      o.kind === 'put' &&
      o.key === STATE_KEY &&
      o.value?.room?.phase === 'CANCELLED' &&
      o.value?.deleted === true,
  );
  assert.notEqual(
    saveIdx,
    -1,
    `the CANCELLED + deleted=true state must be saved to DO storage: ${JSON.stringify(ops.map((o) => o.kind + ':' + o.key))}`,
  );
  assert.equal(
    ops[saveIdx].value.room.result?.outcome,
    'cancelled',
    'the saved state carries the cancelled result',
  );
  // The wipe: the state key is deleted (S9: explicit deletes, no deleteAll).
  const wipeIdx = ops.findIndex((o) => o.kind === 'delete' && o.key === STATE_KEY);
  assert.notEqual(wipeIdx, -1, 'the wipe must delete the state key');
  assert.ok(
    saveIdx < wipeIdx,
    `the durable save (idx ${saveIdx}) must land BEFORE the wipe (idx ${wipeIdx}) — a crash between them must wake to a deleted room, never a live one`,
  );
  assert.equal(
    ops.some((o) => o.kind === 'deleteAll'),
    false,
    'the wipe must not bulk-delete (S9: explicit keys only)',
  );
  // And the wipe itself ran to completion.
  assert.equal(await fake.storage.get(STATE_KEY), undefined, 'the state must be gone after the wipe');
});
