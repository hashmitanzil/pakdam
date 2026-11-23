/**
 * v29 fix-round tests (Meera) — M1–M8.
 *
 * M1: `requestSnapshot` / `resync` send `lastSnapshotKey`
 *     `{ version, serverSeq, maxLastFixAtMs, epochMs }` (null watermark,
 *     never 0); `snapshot.unchanged` stays a no-op.
 * M2: pushed-ticket fallback horizon is the real 60 s TTL
 *     (`WS_TICKET_TTL_MS`); `expiresAtMs` honoured when present.
 * M3: one Idempotency-Key per start / replay action, reused on retry.
 * M4: `teammate.fix` merges into the dot map (no re-fetch); the 8 s
 *     periodic re-fetch is gone; meter math restated.
 * M5: rejoin tokens expire after 12 h at read time; stale entries swept.
 * M6: the "client NEVER computes a deadline" comment is corrected.
 * M7: the R10 route-change churn count is at socket creation.
 * M8: trail points stay discrete (no pill merge); `meDotFeatures` gone.
 *
 * Pure helpers + the socket + HTTP clients only; the hook itself
 * (`useRoomState`) is covered by source pins — it needs React.
 * M9 (demo visibility gap) has no code change and no test: it needs
 * the Diya finding itself or a founder call.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
    _map: map,
  };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
    this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code: 1006 }), 0);
  }

  /** Deliver a server envelope, as the DO would. */
  receive(envelope) {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }
}

const sessionStorageStub = makeStorage();
const localStorageStub = makeStorage();

const doc = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
  dispatch() {},
};

globalThis.document = doc;
globalThis.WebSocket = FakeWebSocket;
globalThis.window = {
  sessionStorage: sessionStorageStub,
  localStorage: localStorageStub,
};

const { SESSION_STORAGE_KEY } = await import('@pakdam/shared');

sessionStorageStub.setItem(
  SESSION_STORAGE_KEY,
  JSON.stringify([
    {
      roomId: 'ROOM1',
      playerId: 'P1',
      mode: 'live',
      displayName: 'Teo',
      reconnectToken: 'RT',
      hostToken: 'HT',
      isHost: true,
      roomCode: 'ABCDEF',
    },
  ]),
);

process.env.NEXT_PUBLIC_WORKER_URL = 'https://worker.test';

/** Mutable fetch behaviour — each test installs its own handler. */
let fetchCalls = [];
let fetchHandler = null;

globalThis.fetch = async (url, init) => {
  const entry = { url: String(url), init };
  fetchCalls.push(entry);
  if (fetchHandler) return fetchHandler(String(url), init);
  // Default: the ws-ticket endpoint.
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: true, ticket: 'TKT', ticketId: 'TID', expiresAtMs: Date.now() + 60_000 }),
  };
};

function resetFetch() {
  fetchCalls = [];
  fetchHandler = null;
}

function headerOf(call, name) {
  const headers = call.init?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? null;
}

const { PakdamSocket, WS_TICKET_TTL_MS } = await import('../src/lib/websocket.ts');
const { buildLastSnapshotKey } = await import('../src/lib/snapshot-key.ts');
const { startLiveMatch } = await import('../src/lib/live-room-client.ts');
const { replayLiveRoom } = await import('../src/lib/live-client.ts');
const {
  REJOIN_TOKEN_MAX_AGE_MS,
  getRejoinToken,
  listRejoinTokens,
  clearRejoinToken,
  sweepStaleRejoinTokens,
} = await import('../src/lib/rejoin-token.ts');
const { mergeTeammateFix } = await import('../src/lib/teammate-fix.ts');
const { TRAIL_MIN_MOVE_DEG, TRAIL_DOT_RADIUS_PX } = await import(
  '../src/components/hud/play-map-logic.ts'
);

function readSrc(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

/** A real server-shaped snapshot: `maxLastFixAtMs` + `epochMs`, top-level. */
function serverSnapshot(overrides = {}) {
  return {
    room: { roomId: 'ROOM1' },
    players: [],
    phase: 'ACTIVE',
    version: 3,
    serverSeq: 450,
    maxLastFixAtMs: 1799999999999,
    epochMs: 1799999990000,
    ...overrides,
  };
}

function snapshotEnvelope(snapshot, serverSeq = snapshot.serverSeq) {
  return {
    v: 1,
    type: 'snapshot',
    roomId: 'ROOM1',
    eventId: `e-${serverSeq}`,
    serverSeq,
    serverTs: new Date().toISOString(),
    payload: snapshot,
  };
}

async function connectOpenSocket(t, extraOptions = {}) {
  const snapshots = [];
  const messages = [];
  const socket = new PakdamSocket({
    roomId: 'ROOM1',
    playerId: 'P1',
    connectTimeoutMs: 5000,
    heartbeatIntervalMs: 30_000,
    onSnapshot: (s) => snapshots.push(s),
    onServerMessage: (e) => messages.push(e),
    onStateChange: () => {},
    ...extraOptions,
  });
  t.after(() => {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  });
  const connecting = socket.connect();
  await sleep(0); // let the ticket fetch resolve and the socket be created
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, 'connect() must create a WebSocket');
  ws.open();
  await connecting;
  ws.receive({ v: 1, type: 'welcome', roomId: 'ROOM1', eventId: 'e-w', serverSeq: 0, serverTs: new Date().toISOString(), payload: {} });
  assert.equal(socket.connectionState, 'connected');
  return { socket, ws, snapshots, messages };
}

function lastSentPayload(ws) {
  return JSON.parse(ws.sent.at(-1)).payload;
}

// -- M1: lastSnapshotKey wiring ---------------------------------------------

test('M1: requestSnapshot / resync send lastSnapshotKey from the last applied snapshot', async (t) => {
  resetFetch();
  const { socket, ws } = await connectOpenSocket(t);
  const snapshot = serverSnapshot();
  ws.receive(snapshotEnvelope(snapshot));
  assert.deepEqual(socket.lastAppliedSnapshotKey, {
    version: 3,
    serverSeq: 450,
    maxLastFixAtMs: 1799999999999,
    epochMs: 1799999990000,
  });
  assert.equal(socket.requestSnapshot(), true);
  const req = JSON.parse(ws.sent.at(-1));
  assert.equal(req.type, 'snapshot.request');
  assert.equal(req.payload.lastServerSeq, 450);
  assert.deepEqual(req.payload.lastSnapshotKey, {
    version: 3,
    serverSeq: 450,
    maxLastFixAtMs: 1799999999999,
    epochMs: 1799999990000,
  });
  assert.equal(socket.resync(), true);
  const resync = JSON.parse(ws.sent.at(-1));
  assert.equal(resync.type, 'resync.request');
  assert.deepEqual(resync.payload.lastSnapshotKey, {
    version: 3,
    serverSeq: 450,
    maxLastFixAtMs: 1799999999999,
    epochMs: 1799999990000,
  });
});

test('M1: null watermark when no fixes exist (never 0), on the wire and in the key', async (t) => {
  resetFetch();
  const { socket, ws } = await connectOpenSocket(t);
  const snapshot = serverSnapshot({ maxLastFixAtMs: null, epochMs: null, players: [] });
  ws.receive(snapshotEnvelope(snapshot));
  assert.deepEqual(socket.lastAppliedSnapshotKey, {
    version: 3,
    serverSeq: 450,
    maxLastFixAtMs: null,
    epochMs: null,
  });
  assert.deepEqual(buildLastSnapshotKey(snapshot), {
    version: 3,
    serverSeq: 450,
    maxLastFixAtMs: null,
    epochMs: null,
  });
  socket.requestSnapshot();
  assert.deepEqual(lastSentPayload(ws).lastSnapshotKey, {
    version: 3,
    serverSeq: 450,
    maxLastFixAtMs: null,
    epochMs: null,
  });
});

test('M1: noteAppliedSnapshot wires a first-paint GET snapshot (socket never saw it)', async (t) => {
  resetFetch();
  const socket = new PakdamSocket({
    roomId: 'ROOM1',
    playerId: 'P1',
    onSnapshot: () => {},
  });
  t.after(() => {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  });
  assert.equal(socket.lastAppliedSnapshotKey, null);
  socket.noteAppliedSnapshot(serverSnapshot());
  assert.deepEqual(socket.lastAppliedSnapshotKey, {
    version: 3,
    serverSeq: 450,
    maxLastFixAtMs: 1799999999999,
    epochMs: 1799999990000,
  });
});

test('M1: snapshot.unchanged is a no-op on both paths (ordering drop + handler)', async (t) => {
  resetFetch();
  const { socket, ws, snapshots, messages } = await connectOpenSocket(t);
  ws.receive(snapshotEnvelope(serverSnapshot()));
  assert.equal(snapshots.length, 1);
  // Baseline: `welcome` + the `snapshot` envelope itself both reach
  // onServerMessage (only the snapshot reaches onSnapshot).
  const baselineMessages = messages.length;
  assert.equal(baselineMessages, 2);
  // Equal seq: the socket ordering check drops it before the handler.
  ws.receive({
    v: 1,
    type: 'snapshot.unchanged',
    roomId: 'ROOM1',
    eventId: 'e-u1',
    serverSeq: 450,
    serverTs: new Date().toISOString(),
    payload: { serverSeq: 450, version: 3 },
  });
  assert.equal(messages.length, baselineMessages, 'an unchanged event at the applied seq never reaches the handler');
  assert.equal(snapshots.length, 1);
  // Higher seq: reaches the handler — still no snapshot applied.
  ws.receive({
    v: 1,
    type: 'snapshot.unchanged',
    roomId: 'ROOM1',
    eventId: 'e-u2',
    serverSeq: 451,
    serverTs: new Date().toISOString(),
    payload: { serverSeq: 451, version: 3 },
  });
  assert.equal(messages.length, baselineMessages + 1);
  assert.equal(messages.at(-1).type, 'snapshot.unchanged');
  assert.equal(snapshots.length, 1, 'unchanged must never apply a snapshot');
  assert.equal(socket.lastAppliedServerSeq, 451);
});

// -- M2: ticket TTL ----------------------------------------------------------

test('M2: WS_TICKET_TTL_MS is the real 60 s TTL', () => {
  assert.equal(WS_TICKET_TTL_MS, 60_000);
  const src = readSrc('src/lib/websocket.ts');
  assert.ok(!src.includes('180_000'), 'no 180 s ticket horizon may remain');
});

test('M2: ticket.renewed without expiresAtMs falls back to 60 s — a pushed ticket is spent, no HTTP call', async (t) => {
  resetFetch();
  const { socket } = await connectOpenSocket(t);
  const ws = FakeWebSocket.instances.at(-1);
  ws.receive({
    v: 1,
    type: 'ticket.renewed',
    roomId: 'ROOM1',
    eventId: 'e-t',
    serverSeq: 1,
    serverTs: new Date().toISOString(),
    payload: { ticket: 'PUSHED' },
  });
  socket.close();
  resetFetch();
  const retrying = socket.retry();
  await sleep(0);
  const ws2 = FakeWebSocket.instances.at(-1);
  assert.ok(ws2 && ws2 !== ws, 'retry must open a new socket');
  assert.ok(ws2.url.includes('ticket=PUSHED'), 'the pushed ticket must be spent, not fetched');
  ws2.open();
  await retrying;
  assert.equal(fetchCalls.length, 0, 'a valid pushed ticket costs no HTTP ticket fetch');
});

test('M2: ticket.renewed honours expiresAtMs when present; an expired push falls back to HTTP', async (t) => {
  resetFetch();
  const { socket } = await connectOpenSocket(t);
  let ws = FakeWebSocket.instances.at(-1);
  // Explicit future expiry: honoured, spent with no fetch.
  ws.receive({
    v: 1,
    type: 'ticket.renewed',
    roomId: 'ROOM1',
    eventId: 'e-t2',
    serverSeq: 2,
    serverTs: new Date().toISOString(),
    payload: { ticket: 'PUSHED2', expiresAtMs: Date.now() + 55_000 },
  });
  socket.close();
  resetFetch();
  let retrying = socket.retry();
  await sleep(0);
  ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws.url.includes('ticket=PUSHED2'), 'expiresAtMs in the future must be honoured');
  ws.open();
  await retrying;
  assert.equal(fetchCalls.length, 0);
  // Expired push: the socket must fetch a fresh ticket instead.
  ws.receive({
    v: 1,
    type: 'ticket.renewed',
    roomId: 'ROOM1',
    eventId: 'e-t3',
    serverSeq: 3,
    serverTs: new Date().toISOString(),
    payload: { ticket: 'STALE', expiresAtMs: Date.now() - 1000 },
  });
  socket.close();
  resetFetch();
  retrying = socket.retry();
  await sleep(0);
  ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws.url.includes('ticket=TKT'), 'an expired push must not be spent');
  ws.open();
  await retrying;
  assert.equal(fetchCalls.length, 1, 'an expired push costs one HTTP ticket fetch');
});

// -- M3: start / replay idempotency -----------------------------------------

test('M3: startLiveMatch mints one Idempotency-Key per action, reused across retries', async () => {
  resetFetch();
  const seenKeys = [];
  let startAttempts = 0;
  fetchHandler = async (url) => {
    if (url.endsWith('/v1/rooms/ROOM1/start')) {
      startAttempts += 1;
      seenKeys.push(headerOf(fetchCalls.at(-1), 'Idempotency-Key'));
      if (startAttempts === 1) {
        return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({ error: 'busy' }) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ phase: 'ACTIVE', startedAt: null, endsAt: null }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const first = await startLiveMatch('ROOM1');
  assert.equal(first.phase, 'ACTIVE');
  assert.equal(startAttempts, 2, 'a lost first response must be retried');
  assert.equal(seenKeys.length, 2);
  assert.match(seenKeys[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(seenKeys[0], seenKeys[1], 'both attempts must carry the SAME key');
  // A second start action mints a fresh key.
  fetchHandler = async (url) => {
    if (url.endsWith('/v1/rooms/ROOM1/start')) {
      seenKeys.push(headerOf(fetchCalls.at(-1), 'Idempotency-Key'));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ phase: 'ACTIVE', startedAt: null, endsAt: null }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await startLiveMatch('ROOM1');
  assert.notEqual(seenKeys[2], seenKeys[0], 'a new action mints a new key');
});

test('M3: startLiveMatch reuses the key across the 403 host-token re-mint retry (no double-wrap)', async () => {
  resetFetch();
  const seenKeys = [];
  let startAttempts = 0;
  fetchHandler = async (url) => {
    if (url.endsWith('/v1/rooms/ROOM1/start')) {
      startAttempts += 1;
      seenKeys.push(headerOf(fetchCalls.at(-1), 'Idempotency-Key'));
      if (startAttempts === 1) {
        return { ok: false, status: 403, headers: { get: () => null }, json: async () => ({ error: 'stale host token' }) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ phase: 'ACTIVE', startedAt: null, endsAt: null }) };
    }
    if (url.endsWith('/v1/rooms/ROOM1/host/token')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, hostToken: 'HT2' }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const out = await startLiveMatch('ROOM1');
  assert.equal(out.phase, 'ACTIVE');
  assert.equal(startAttempts, 2, 'the 403 must trigger exactly one re-mint retry');
  assert.equal(seenKeys[0], seenKeys[1], 'the re-mint retry must reuse the start key');
});

test('M3: replayLiveRoom sends one key, reused across retries', async () => {
  resetFetch();
  const seenKeys = [];
  let attempts = 0;
  fetchHandler = async (url) => {
    if (url.endsWith('/v1/rooms/ROOM1/replay')) {
      attempts += 1;
      seenKeys.push(headerOf(fetchCalls.at(-1), 'Idempotency-Key'));
      if (attempts === 1) {
        return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({ error: 'busy' }) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, phase: 'LOBBY', roomCode: 'ABCDEF', playerCount: 2 }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const out = await replayLiveRoom('ROOM1');
  assert.equal(out.phase, 'LOBBY');
  assert.equal(attempts, 2);
  assert.equal(seenKeys[0], seenKeys[1], 'both replay attempts must carry the SAME key');
  assert.match(seenKeys[0], /^[0-9a-f-]{36}$/i);
});

// -- M4: teammate.fix broadcast ----------------------------------------------

test('M4: mergeTeammateFix applies a valid fix, ignores invalid / own fixes', () => {
  const prev = { P2: { lat: 1, lng: 2, accuracyMeters: 5, timestampMs: 1000 } };
  const merged = mergeTeammateFix(prev, { playerId: 'P3', lat: 23.36, lng: 85.33, accuracyMeters: 10, timestampMs: 2000 }, 'P1');
  assert.deepEqual(merged.P3, { lat: 23.36, lng: 85.33, accuracyMeters: 10, timestampMs: 2000 });
  assert.equal(merged.P2, prev.P2, 'other teammates are untouched');
  assert.notEqual(merged, prev);
  // Invalid payloads return the input map unchanged (same ref).
  assert.equal(mergeTeammateFix(prev, null, 'P1'), prev);
  assert.equal(mergeTeammateFix(prev, { playerId: 'P3', lat: NaN, lng: 85.33, accuracyMeters: 10, timestampMs: 2000 }, 'P1'), prev);
  assert.equal(mergeTeammateFix(prev, { playerId: 'P3', lat: 23.36, lng: 85.33, accuracyMeters: -1, timestampMs: 2000 }, 'P1'), prev);
  assert.equal(mergeTeammateFix(prev, { playerId: '', lat: 23.36, lng: 85.33, accuracyMeters: 10, timestampMs: 2000 }, 'P1'), prev);
  assert.equal(mergeTeammateFix(prev, { playerId: 'P3', lat: 23.36, lng: 85.33, accuracyMeters: 10 }, 'P1'), prev);
  // My own fix is never merged — it comes from local GPS.
  assert.equal(mergeTeammateFix(prev, { playerId: 'P1', lat: 23.36, lng: 85.33, accuracyMeters: 10, timestampMs: 2000 }, 'P1'), prev);
  // A newer fix for the same teammate replaces the old one.
  const replaced = mergeTeammateFix(prev, { playerId: 'P2', lat: 9, lng: 9, accuracyMeters: 8, timestampMs: 3000 }, 'P1');
  assert.deepEqual(replaced.P2, { lat: 9, lng: 9, accuracyMeters: 8, timestampMs: 3000 });
});

test('M4: the 8 s periodic re-fetch is gone; teammate.fix is the primary, with restated meter math', () => {
  const hook = readSrc('src/components/match/useRoomState.ts');
  assert.ok(!hook.includes('LIVE_DOT_REFRESH_MS'), 'the re-fetch interval constant must be gone');
  assert.ok(!hook.includes('enableLiveDotRefresh'), 'the re-fetch option must be gone');
  assert.ok(
    hook.includes('the 8 s periodic snapshot re-fetch is REMOVED'),
    'the removal must be stated at the old interval site (the demo 1 s poll is local-only and stays)',
  );
  assert.ok(hook.includes("case 'teammate.fix'"), 'the broadcast handler must exist');
  assert.ok(hook.includes('mergeTeammateFix'), 'the handler must merge via the pure helper');
  // Restated math: the old claims are gone, the honest figures are in.
  assert.ok(!hook.includes('17,550'), 'the old "~17,550 vs ~54,000" claim must be gone');
  assert.ok(!hook.includes('54,000'), 'the old "~17,550 vs ~54,000" claim must be gone');
  assert.ok(hook.includes('18,400'), 'the recomputed ceiling (≈ 18,400) must be stated');
  assert.ok(hook.includes('22,000'), 'the realistic range (≈ 22,000–33,000) must be stated');
  assert.ok(hook.includes('p95 teammate-fix age ~2 s'), 'the broadcast staleness target must be stated');
  assert.ok(hook.includes('bounded 30 s by the valve'), 'the valve bound must be stated');
  assert.ok(hook.includes('10,800 is the all-stationary figure'), '10,800 must be labelled all-stationary, not a ceiling');
  const play = readSrc('src/app/room/[roomId]/play/page.tsx');
  assert.ok(!play.includes('enableLiveDotRefresh'), 'the play page must not pass the removed option');
});

// -- M5: rejoin-token max age -------------------------------------------------

test('M5: REJOIN_TOKEN_MAX_AGE_MS is 12 hours', () => {
  assert.equal(REJOIN_TOKEN_MAX_AGE_MS, 12 * 60 * 60 * 1000);
});

function writeRejoinEntry(roomId, storedAtMs) {
  localStorageStub.setItem(
    `pakdam.rejoin.v1.${roomId}`,
    JSON.stringify({
      roomId,
      roomCode: 'ABCDEF',
      playerId: 'P1',
      displayName: 'Teo',
      reconnectToken: 'RT',
      isHost: false,
      storedAtMs,
    }),
  );
}

test('M5: a stale read returns null and deletes the entry; a fresh read returns it', () => {
  const now = Date.now();
  writeRejoinEntry('OLD', now - 13 * 60 * 60 * 1000);
  writeRejoinEntry('FRESH', now - 11 * 60 * 60 * 1000);
  assert.equal(getRejoinToken('OLD'), null, '13 h old must read as null');
  assert.equal(
    localStorageStub.getItem('pakdam.rejoin.v1.OLD'),
    null,
    'a stale read must delete the entry',
  );
  const fresh = getRejoinToken('FRESH');
  assert.ok(fresh, '11 h old must still read');
  assert.equal(fresh.roomId, 'FRESH');
  assert.notEqual(
    localStorageStub.getItem('pakdam.rejoin.v1.FRESH'),
    null,
    'a fresh read must not delete the entry',
  );
  clearRejoinToken('FRESH');
});

test('M5: the sweep removes only stale entries, and clearRejoinToken sweeps them (terminal-room path)', () => {
  const now = Date.now();
  writeRejoinEntry('S1', now - 25 * 60 * 60 * 1000);
  writeRejoinEntry('S2', now - 13 * 60 * 60 * 1000);
  writeRejoinEntry('KEEP', now - 60 * 60 * 1000);
  assert.equal(sweepStaleRejoinTokens(now), 2);
  assert.equal(listRejoinTokens().length, 1);
  assert.equal(listRejoinTokens()[0].roomId, 'KEEP');
  // A terminal room's clear sweeps the stale entries left behind.
  writeRejoinEntry('S3', now - 20 * 60 * 60 * 1000);
  clearRejoinToken('KEEP');
  assert.equal(localStorageStub.getItem('pakdam.rejoin.v1.S3'), null, 'clear must sweep stale entries');
  assert.equal(listRejoinTokens().length, 0);
  // Undatable entries fail closed: no storedAtMs = stale.
  localStorageStub.setItem(
    'pakdam.rejoin.v1.NODATE',
    JSON.stringify({ roomId: 'NODATE', roomCode: 'ABCDEF', playerId: 'P1', displayName: 'Teo', reconnectToken: 'RT', isHost: false }),
  );
  assert.equal(getRejoinToken('NODATE'), null, 'an entry with no storedAtMs must read as null');
});

// -- M6 + M7: comments ---------------------------------------------------------

test('M6: the "client NEVER computes a deadline" claim is corrected', () => {
  const hook = readSrc('src/components/match/useRoomState.ts');
  assert.ok(
    !hook.includes('The client NEVER computes a deadline itself'),
    'the absolute claim must be gone — the socket fallback IS client-computed',
  );
  assert.ok(
    hook.includes('30 s from the drop as this client saw it'),
    'the corrected comment must name the socket fallback accurately',
  );
});

test('M7: the R10 route-change churn count is at socket creation', () => {
  const hook = readSrc('src/components/match/useRoomState.ts');
  const at = hook.indexOf('new PakdamSocket(');
  assert.ok(at > 0, 'the socket must be created in useRoomState');
  const before = hook.slice(Math.max(0, at - 2000), at);
  assert.ok(before.includes('≈ 4–5 requests'), 'the per-round-trip count must sit at socket creation');
  assert.ok(before.includes('~150 requests'), 'the ~150 requests/game total must sit at socket creation');
  const socketSrc = readSrc('src/lib/websocket.ts');
  assert.ok(socketSrc.includes('R10'), 'the socket must point back at the R10 count');
});

// -- M8: trails + dead helper --------------------------------------------------

test('M8: trail points stay discrete (spacing > diameter) and meDotFeatures is gone', () => {
  assert.equal(TRAIL_MIN_MOVE_DEG, 0.0001, 'a new trail point needs ~11 m of movement');
  assert.equal(TRAIL_DOT_RADIUS_PX, 3, 'trail dots are 3 px');
  const mapSrc = readSrc('src/components/hud/PlayMap.tsx');
  assert.ok(mapSrc.includes('TRAIL_MIN_MOVE_DEG'), 'the trail must use the spacing constant');
  assert.ok(mapSrc.includes('TRAIL_DOT_RADIUS_PX'), 'the trail must use the radius constant');
  assert.ok(!mapSrc.includes('0.00005'), 'the old 5.5 m merge spacing must be gone');
  const logic = readSrc('src/components/hud/play-map-logic.ts');
  assert.ok(!logic.includes('export function meDotFeatures'), 'the dead helper must be removed');
});
