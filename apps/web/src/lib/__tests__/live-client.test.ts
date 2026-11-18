import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveRoom, joinLiveRoom, openLiveSocket, resolveRoomByCode, storeLiveSeat,
  regenerateLiveRoomCode,
  LiveApiError,
} from '../live-client.js';
import { getSessionForRoom, saveLiveSession } from '../session-credentials.js';

// ---------------------------------------------------------------------------
// Worker 8 — regression tests for live wiring, web client side:
// the live HTTPS client (apps/web/src/lib/live-client.ts).
//
// Create / join go over HTTPS (POST /v1/rooms, POST /v1/rooms/:id/
// join) and the raw credential comes back ONCE in the response — the
// client must store it (sessionStorage, see session-credentials
// tests) and never invent one. openLiveSocket refuses to open a
// socket when this tab holds no stored credential for the room.
//
// RUNNING: see the header of websocket-reconnect.test.ts in this
// directory (same scratch-compile command; add this file to it).
// ---------------------------------------------------------------------------

const API = 'https://worker.example';

function setWorkerUrl(t: { after: (fn: () => void) => void }, url: string | null = API): void {
  const prev = process.env['NEXT_PUBLIC_WORKER_URL'];
  if (url === null) delete process.env['NEXT_PUBLIC_WORKER_URL'];
  else process.env['NEXT_PUBLIC_WORKER_URL'] = url;
  t.after(() => {
    if (prev === undefined) delete process.env['NEXT_PUBLIC_WORKER_URL'];
    else process.env['NEXT_PUBLIC_WORKER_URL'] = prev;
  });
}

interface FetchCall { url: string; body: unknown }
function stubFetch(
  t: { after: (fn: () => void) => void },
  handler: (call: FetchCall) => { ok: boolean; status: number; json: unknown } | Promise<{ ok: boolean; status: number; json: unknown }>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const call: FetchCall = { url, body: init?.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const res = await handler(call);
    return { ok: res.ok, status: res.status, json: async () => res.json } as Response;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

function installSessionStorage(t: { after: (fn: () => void) => void }): Map<string, string> {
  const store = new Map<string, string>();
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g['window'];
  const prevSession = g['sessionStorage'];
  g['window'] = {};
  g['sessionStorage'] = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
  t.after(() => {
    if (prevWindow === undefined) delete g['window']; else g['window'] = prevWindow;
    if (prevSession === undefined) delete g['sessionStorage']; else g['sessionStorage'] = prevSession;
  });
  return store;
}

const validConfig = {
  mode: 'classic', teamAssignment: 'random', maxPlayers: 30, hunterCount: 1,
  durationSeconds: 600, headStartSeconds: 60, pingIntervalSeconds: 180,
  zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 300,
  catchConfirmationRequired: true, playZoneEnabled: true,
  balanceHunters: true, randomDraw: true,
  zone: {
    boundary: [
      { lat: 23.40, lng: 85.40 }, { lat: 23.40, lng: 85.405 },
      { lat: 23.405, lng: 85.405 }, { lat: 23.405, lng: 85.40 },
    ],
    shrinkPhases: [],
  },
  safeAreas: [], noGoAreas: [], selectedHunterIds: [], hostOnSiteConfirmed: true,
};

test('create/join (5f): createLiveRoom posts the exact createRoomBody and returns the seat credential from the 201', async (t) => {
  setWorkerUrl(t);
  const calls = stubFetch(t, () => ({
    ok: true, status: 201,
    json: { ok: true, roomId: 'r1', roomCode: 'ABC123', hostPlayerId: 'h1', reconnectToken: 'seat-token-h1', hostToken: 'host-token-h1' },
  }));
  const result = await createLiveRoom({ displayName: 'Host One', config: validConfig as never, ageGatePassed: true });
  assert.equal(result.roomId, 'r1');
  assert.equal(result.roomCode, 'ABC123');
  assert.equal(result.hostPlayerId, 'h1');
  assert.equal(result.reconnectToken, 'seat-token-h1', 'the 201 credential is returned, never invented');
  assert.equal(result.hostToken, 'host-token-h1', 'the 201 host token is returned, never invented');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${API}/v1/rooms`);
  assert.deepEqual(calls[0]!.body, {
    displayName: 'Host One', kind: 'guest', config: validConfig, ageGatePassed: true,
  });
});

test('create/join (5g): createLiveRoom refuses a 201 without a usable credential — it never invents one', async (t) => {
  setWorkerUrl(t);
  stubFetch(t, () => ({
    ok: true, status: 201,
    json: { ok: true, roomId: 'r1', roomCode: 'ABC123', hostPlayerId: 'h1', reconnectToken: '' },
  }));
  await assert.rejects(
    createLiveRoom({ displayName: 'Host One', config: validConfig as never, ageGatePassed: true }),
    (e: unknown) => e instanceof LiveApiError,
  );
});

test('create/join (5h): joinLiveRoom posts the room code as invite proof and surfaces an empty token on restore', async (t) => {
  setWorkerUrl(t);
  const calls = stubFetch(t, () => ({
    ok: true, status: 200,
    json: { ok: true, player: { playerId: 'p2', isHost: false }, reconnectToken: 'seat-token-p2', restored: false },
  }));
  const result = await joinLiveRoom({ roomId: 'r1', roomCode: 'ABC123', displayName: 'Runner One' });
  assert.equal(result.roomId, 'r1');
  assert.equal(result.playerId, 'p2');
  assert.equal(result.isHost, false);
  assert.equal(result.reconnectToken, 'seat-token-p2');
  assert.equal(result.restored, false);
  assert.equal(calls[0]!.url, `${API}/v1/rooms/r1/join`);
  assert.deepEqual(calls[0]!.body, { displayName: 'Runner One', kind: 'guest', roomCode: 'ABC123' });
});

test('create/join (5i): joinLiveRoom maps a wrong room code (403) to plain words and keeps the status', async (t) => {
  setWorkerUrl(t);
  stubFetch(t, () => ({
    ok: false, status: 403, json: { error: 'room code does not match this room' },
  }));
  await assert.rejects(
    joinLiveRoom({ roomId: 'r1', roomCode: 'XXXXXX', displayName: 'Runner One' }),
    (e: unknown) => e instanceof LiveApiError
      && (e as LiveApiError).status === 403
      && (e as LiveApiError).message === 'That room code does not match this game. Check the code with your host.',
  );
});

test('create/join (5j): a restored join returns an EMPTY token — the client surfaces it faithfully, never a fresh one', async (t) => {
  setWorkerUrl(t);
  stubFetch(t, () => ({
    ok: true, status: 200,
    json: { ok: true, player: { playerId: 'p2', isHost: false }, reconnectToken: '', restored: true },
  }));
  const result = await joinLiveRoom({ roomId: 'r1', roomCode: 'ABC123', displayName: 'Runner One' });
  assert.equal(result.restored, true);
  assert.equal(result.reconnectToken, '', 'an empty restore token stays empty here — saveLiveSession keeps the stored one');
});

test('reconnect (2m): openLiveSocket refuses without a stored credential for the room — no socket, no guess', async (t) => {
  setWorkerUrl(t);
  installSessionStorage(t);
  const noSession = await openLiveSocket('r1', {});
  assert.ok('error' in noSession, 'no stored session: a plain-words error, not a socket');
  assert.match(noSession.error, /sign-in for this game is missing/);

  // A session for ANOTHER room does not open this room's socket.
  saveLiveSession({ roomId: 'r2', playerId: 'p9', reconnectToken: 'seat-token-p9', isHost: false });
  const wrongRoom = await openLiveSocket('r1', {});
  assert.ok('error' in wrongRoom);
});

test('reconnect (2n): openLiveSocket opens a socket from the STORED credential (ticket fetched over HTTPS)', async (t) => {
  setWorkerUrl(t);
  installSessionStorage(t);
  saveLiveSession({ roomId: 'r1', playerId: 'p1', reconnectToken: 'seat-token-p1', isHost: false });
  const calls = stubFetch(t, (call) => {
    assert.equal(call.url, `${API}/v1/rooms/r1/ws-ticket`);
    assert.deepEqual(call.body, { playerId: 'p1', reconnectToken: 'seat-token-p1', purpose: 'connect' });
    return { ok: true, status: 200, json: { ticket: 'ticket-1' } };
  });
  const opened = await openLiveSocket('r1', {});
  assert.ok('socket' in opened, `expected a socket, got ${JSON.stringify(opened)}`);
  assert.equal(calls.length, 1, 'the stored credential was exchanged for exactly one ticket');
  // The socket tries the real WebSocket URL (no server in this test);
  // close it at once so no reconnect timers survive the test.
  opened.socket.close();
});

// Join by 6-letter code goes live via GET /v1/rooms/by-code/:code
// (live-client.ts `resolveRoomByCode`, Worker F): the Worker resolves
// the code to the roomId. The old blocker test that asserted a code
// alone could NOT join is obsolete by design and was replaced by
// these resolve tests (2026-11-17, Worker H) — the deleted
// LIVE_JOIN_BY_CODE_MESSAGE constant is NOT re-added.
test('create/join: resolveRoomByCode resolves a 6-letter code to roomId/roomCode via GET /v1/rooms/by-code/:code', async (t) => {
  setWorkerUrl(t);
  const calls = stubFetch(t, () => ({
    ok: true, status: 200,
    json: { ok: true, roomId: 'r1', roomCode: 'ABC123' },
  }));
  const result = await resolveRoomByCode('ABC123');
  assert.deepEqual(result, { roomId: 'r1', roomCode: 'ABC123' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${API}/v1/rooms/by-code/ABC123`);
});

test('create/join: resolveRoomByCode maps an unknown code (404) to plain words and keeps the status', async (t) => {
  setWorkerUrl(t);
  stubFetch(t, () => ({
    ok: false, status: 404, json: { error: 'no room with that code' },
  }));
  await assert.rejects(
    resolveRoomByCode('XXXXXX'),
    (e: unknown) => e instanceof LiveApiError
      && (e as LiveApiError).status === 404
      && /could not be found/.test((e as LiveApiError).message),
  );
});

test('create/join: resolveRoomByCode maps too many lookups (429) to plain words and keeps the status', async (t) => {
  setWorkerUrl(t);
  stubFetch(t, () => ({
    ok: false, status: 429, json: { error: 'too many lookups' },
  }));
  await assert.rejects(
    resolveRoomByCode('ABC123'),
    (e: unknown) => e instanceof LiveApiError
      && (e as LiveApiError).status === 429
      && /Too many tries/.test((e as LiveApiError).message),
  );
});

test('create/join: resolveRoomByCode refuses a malformed 200 — no roomId/roomCode, no invented room', async (t) => {
  setWorkerUrl(t);
  stubFetch(t, () => ({
    ok: true, status: 200, json: { ok: true },
  }));
  await assert.rejects(
    resolveRoomByCode('ABC123'),
    (e: unknown) => e instanceof LiveApiError
      && /unexpected reply/.test((e as LiveApiError).message),
  );
});

// CONTRACT — createLiveRoom returns + storeLiveSeat stores the SEPARATE host token.
// Contract, quoted from workers/src/index.ts (handleCreateRoom, Worker 5):
//   "return json({ ok: true, roomId, roomCode, hostPlayerId,
//    reconnectToken, hostToken }, 201);"
// and workers/src/room-do.ts (RoomDoState.hostTokens):
//   "The host token is a SEPARATE credential from the reconnect
//    token: the reconnect token proves a SEAT ... the host token
//    proves HOST authority".
// Honoured since the live-client fix: createLiveRoom requires a
// non-empty hostToken in the 201 (live-client.ts) and storeLiveSeat
// stores THAT as hostToken — never the reconnect token. This test
// pins the server contract; it was skipped until the client read +
// stored the real hostToken from the 201 (un-skipped 2026-11-17).
test('create/join CONTRACT-ONLY: createLiveRoom returns the separate host token and storeLiveSeat stores THAT as hostToken', async (t) => {
  setWorkerUrl(t);
  installSessionStorage(t);
  stubFetch(t, () => ({
    ok: true, status: 201,
    json: { ok: true, roomId: 'r1', roomCode: 'ABC123', hostPlayerId: 'h1', reconnectToken: 'seat-token-h1', hostToken: 'host-token-h1' },
  }));
  const result = await createLiveRoom({ displayName: 'Host One', config: validConfig as never, ageGatePassed: true });
  const hostToken = (result as unknown as Record<string, unknown>)['hostToken'];
  assert.equal(hostToken, 'host-token-h1', 'create must surface the separate host credential');
  assert.notEqual(hostToken, result.reconnectToken, 'the two credentials must differ');
  storeLiveSeat(result, 'Host One');
  assert.equal(getSessionForRoom('r1')?.hostToken, 'host-token-h1', 'the stored hostToken is the 201 host token, not the reconnect token');
  assert.equal(getSessionForRoom('r1')?.reconnectToken, 'seat-token-h1');
});

// D-M2: host regenerates the room code from the lobby — POST
// /v1/rooms/:id/regenerate-code { playerId, hostToken }. The server
// generates the fresh code, so the client sends NO code of its own,
// and the call proves host authority with the HOST token (SEC-06) —
// never the reconnect token, never a display name.
test('host controls (D-M2): regenerateLiveRoomCode posts playerId + hostToken only and returns the new + old codes', async (t) => {
  setWorkerUrl(t);
  const calls = stubFetch(t, () => ({
    ok: true, status: 200,
    json: { ok: true, roomCode: 'XYZ789', oldRoomCode: 'ABC123' },
  }));
  const result = await regenerateLiveRoomCode({ roomId: 'r1', playerId: 'h1', hostToken: 'host-token-h1' });
  assert.deepEqual(result, { roomCode: 'XYZ789', oldRoomCode: 'ABC123' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${API}/v1/rooms/r1/regenerate-code`);
  assert.deepEqual(calls[0]!.body, { playerId: 'h1', hostToken: 'host-token-h1' },
    'no roomCode in the body — the server generates the fresh code');
});

test('host controls (D-M2): regenerateLiveRoomCode maps a wrong host token (403) to plain words and keeps the status', async (t) => {
  setWorkerUrl(t);
  stubFetch(t, () => ({
    ok: false, status: 403, json: { error: 'host token does not match this host seat' },
  }));
  await assert.rejects(
    regenerateLiveRoomCode({ roomId: 'r1', playerId: 'r1', hostToken: 'not-a-host-token' }),
    (e: unknown) => e instanceof LiveApiError
      && (e as LiveApiError).status === 403,
  );
});

test('host controls (D-M2): regenerateLiveRoomCode refuses a 200 without both codes — no invented code', async (t) => {
  setWorkerUrl(t);
  stubFetch(t, () => ({
    ok: true, status: 200, json: { ok: true, roomCode: 'XYZ789' },
  }));
  await assert.rejects(
    regenerateLiveRoomCode({ roomId: 'r1', playerId: 'h1', hostToken: 'host-token-h1' }),
    (e: unknown) => e instanceof LiveApiError
      && /unexpected reply/.test((e as LiveApiError).message),
  );
});
