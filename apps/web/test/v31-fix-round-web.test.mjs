/**
 * v31 fix-round (web) tests (Meera) — Diya's adversarial review, fix round.
 *
 * F3 (AT RISK): a seat removed while its tab is discarded resurrects
 *     as if still in the game — the client half: when a snapshot/state
 *     shows my own seat with `leftAt` set, the rejoin mirror dies at
 *     once and the page says so in plain words. (Server half is Kabir's.)
 * F4 (AT RISK): the mirror goes stale after 12 h on a still-live room
 *     — `refreshRejoinToken` re-stamps `storedAtMs` on a successful
 *     resume, so a live seat keeps a fresh mirror.
 * F5 (AT RISK): manual Retry raced the 4404 probe — `retryConnection`
 *     is serialised (state fetch first, socket retry only after it
 *     settles), in `useRoomState` and in the lobby's own retry.
 * Zara (a) (AT RISK, AppSec): `PakdamSocket.retry()` had no terminal
 *     guard — after a 4404/4403 close it minted a fresh ticket against
 *     a gone room / dead seat. It now refuses, and `retryConnection`
 *     refuses while `roomDeleted` is latched.
 * Zara (b) is tested in v31-rejoin-restore.test.mjs (it lives in the
 *     rejoin-token read path); F1's setup pin lives there too, and F2's
 *     `contextLost` test lives in v31-map-refresh.test.mjs.
 *
 * Pure helpers + the live socket + source pins — the pages need React,
 * so their wiring is pinned by source, not rendered.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

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

const sessionStorageStub = makeStorage();
const localStorageStub = makeStorage();

globalThis.document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = {
  sessionStorage: sessionStorageStub,
  localStorage: localStorageStub,
};

/** Minimal fake socket: tests drive open/close/message explicitly. */
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
    this.readyState = 3;
  }

  receive(envelope) {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }
}

globalThis.WebSocket = FakeWebSocket;

let fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  return {
    ok: true,
    json: async () => ({
      ok: true,
      ticket: 'TICKET-1',
      ticketId: 'tid-1',
      expiresAtMs: Date.now() + 60_000,
    }),
  };
};

process.env.NEXT_PUBLIC_WORKER_URL = 'https://worker.test';

const { SESSION_STORAGE_KEY } = await import('@pakdam/shared');
const { PakdamSocket } = await import('../src/lib/websocket.ts');
const {
  storeRejoinToken,
  getRejoinToken,
  refreshRejoinToken,
  REJOIN_TOKEN_MAX_AGE_MS,
} = await import('../src/lib/rejoin-token.ts');

// -- F4: refreshRejoinToken (the real helper). --------------------------
const ENTRY = {
  roomId: 'room-1',
  roomCode: 'ABCDEF',
  playerId: 'p1',
  displayName: 'Ana',
  reconnectToken: 'tok-live-1',
  isHost: false,
};

function readRaw(roomId) {
  return JSON.parse(localStorageStub._map.get(`pakdam.rejoin.v1.${roomId}`));
}

test('F4: refresh re-stamps storedAtMs to now and keeps the seat', () => {
  localStorageStub._map.clear();
  sessionStorageStub._map.clear();
  storeRejoinToken(ENTRY);
  const raw = readRaw('room-1');
  raw.storedAtMs = Date.now() - 11 * 60 * 60 * 1000; // 11 h old, not stale
  localStorageStub._map.set('pakdam.rejoin.v1.room-1', JSON.stringify(raw));
  assert.equal(refreshRejoinToken('room-1'), true);
  const refreshed = readRaw('room-1');
  assert.ok(Date.now() - refreshed.storedAtMs < 5000, 'storedAtMs must be ~now');
  assert.equal(refreshed.reconnectToken, 'tok-live-1');
  assert.equal(refreshed.roomId, 'room-1');
  // Still readable afterwards — the refresh did not corrupt the entry.
  assert.equal(getRejoinToken('room-1')?.reconnectToken, 'tok-live-1');
});

test('F4: refresh of a stale entry deletes it instead of reviving it', () => {
  localStorageStub._map.clear();
  storeRejoinToken(ENTRY);
  const raw = readRaw('room-1');
  raw.storedAtMs = Date.now() - REJOIN_TOKEN_MAX_AGE_MS - 1000;
  localStorageStub._map.set('pakdam.rejoin.v1.room-1', JSON.stringify(raw));
  assert.equal(refreshRejoinToken('room-1'), false);
  assert.equal(localStorageStub._map.has('pakdam.rejoin.v1.room-1'), false);
});

test('F4: refresh of a missing entry is a no-op false', () => {
  localStorageStub._map.clear();
  assert.equal(refreshRejoinToken('room-1'), false);
});

// -- Zara (a): the terminal guard, driven on a live socket. -------------
function seedLiveSession() {
  sessionStorageStub._map.clear();
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
}

async function connectSocket() {
  fetchCalls = [];
  FakeWebSocket.instances = [];
  seedLiveSession();
  const states = [];
  const socket = new PakdamSocket({
    roomId: 'ROOM1',
    playerId: 'P1',
    connectTimeoutMs: 500,
    onSnapshot: () => {},
    onStateChange: (state, detail) => states.push([state, detail]),
  });
  const connecting = socket.connect();
  // The ticket fetch is async — let its microtasks drain so the fake
  // socket exists before opening it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(FakeWebSocket.instances.length, 1, 'one ticket fetch + one socket');
  FakeWebSocket.instances[0].open();
  await connecting;
  FakeWebSocket.instances[0].receive({ type: 'welcome' });
  assert.equal(socket.connectionState, 'connected');
  return { socket, states };
}

test('Zara (a): retry() after a 4404 close is refused — no ticket fetch, no new socket', async () => {
  const { socket } = await connectSocket();
  const callsBefore = fetchCalls.length;
  FakeWebSocket.instances[0].onclose({ code: 4404 });
  assert.equal(socket.connectionState, 'closed');
  assert.equal(socket.terminalCloseCode, 4404);
  await socket.retry();
  assert.equal(fetchCalls.length, callsBefore, 'no fresh ticket was fetched');
  assert.equal(FakeWebSocket.instances.length, 1, 'no new socket was opened');
  assert.equal(socket.connectionState, 'closed');
  socket.close();
});

test('Zara (a): retry() after a 4403 close is refused the same way', async () => {
  const { socket } = await connectSocket();
  const callsBefore = fetchCalls.length;
  FakeWebSocket.instances[0].onclose({ code: 4403 });
  assert.equal(socket.connectionState, 'closed');
  assert.equal(socket.terminalCloseCode, 4403);
  await socket.retry();
  assert.equal(fetchCalls.length, callsBefore, 'no fresh ticket was fetched');
  assert.equal(FakeWebSocket.instances.length, 1, 'no new socket was opened');
  socket.close();
});

test('Zara (a): a non-terminal close still retries (control — the guard is not a blanket refusal)', async () => {
  const { socket } = await connectSocket();
  FakeWebSocket.instances[0].onclose({ code: 1006 });
  assert.equal(socket.connectionState, 'reconnecting');
  assert.equal(socket.terminalCloseCode, null);
  const callsBefore = fetchCalls.length;
  const instancesBefore = FakeWebSocket.instances.length;
  await socket.retry();
  assert.ok(fetchCalls.length > callsBefore, 'a fresh ticket was fetched');
  assert.ok(
    FakeWebSocket.instances.length > instancesBefore,
    'a new socket was opened',
  );
  // Stop the reconnect loop the retry started (the new socket never
  // opens in this test, so its connect timeout would reschedule).
  socket.close();
});

// -- Source pins: hook + pages. -----------------------------------------
const useRoomStateSrc = readFileSync(
  new URL('../src/components/match/useRoomState.ts', import.meta.url),
  'utf8',
);
const playSrc = readFileSync(
  new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
  'utf8',
);
const catchSrc = readFileSync(
  new URL('../src/app/room/[roomId]/catch/page.tsx', import.meta.url),
  'utf8',
);
const lobbySrc = readFileSync(
  new URL('../src/app/room/[roomId]/page.tsx', import.meta.url),
  'utf8',
);
const setupSrc = readFileSync(
  new URL('../src/app/room/[roomId]/setup/page.tsx', import.meta.url),
  'utf8',
);

test('source pin (F3/F4): a snapshot decides the mirror — leftAt marks the seat removed, a live seat refreshes it', () => {
  assert.match(
    useRoomStateSrc,
    /if \(meLeft && meLeft\.leftAt !== null\) \{\n\s*markSeatRemoved\(\);\n\s*return;\n\s*\}/,
    'applySnapshot must never apply a snapshot that lands with my own seat already left',
  );
  assert.match(
    useRoomStateSrc,
    /const markSeatRemoved = useCallback\(\(\) => \{\n\s*clearRejoinToken\(roomId\);/,
    'markSeatRemoved kills the mirror with the seat',
  );
  assert.match(
    useRoomStateSrc,
    /if \(me\.ejectedAt === null\) refreshRejoinToken\(roomId\);/,
    'applySnapshot must refresh a still-live seat (never an ejected one)',
  );
});

test('source pin (F3): the play page shows a plain-words removal banner for leftAt', () => {
  assert.match(playSrc, /const removedAt = myPlayer\?\.leftAt \?\? null;/);
  assert.match(playSrc, /The host removed you from this game\./);
});

test('source pin (F3): the catch page has ejected/removed handling — banner + mirror-clear', () => {
  assert.match(catchSrc, /const ejectedAt = myPlayer\?\.ejectedAt \?\? null;/);
  assert.match(catchSrc, /const removedAt = myPlayer\?\.leftAt \?\? null;/);
  assert.match(catchSrc, /if \(ejectedAt \|\| removedAt\) clearRejoinToken\(roomId\);/);
  assert.match(catchSrc, /You were removed from the game\./);
});

test('source pin (F3/F4): lobby + setup note every live state arrival the same way', () => {
  for (const [name, src] of [
    ['lobby', lobbySrc],
    ['setup', setupSrc],
  ]) {
    assert.match(
      src,
      /if \(seat\.leftAt !== null\) clearRejoinToken\(roomId\);/,
      `${name}: a removed seat's mirror dies on state arrival`,
    );
    assert.match(
      src,
      /else if \(seat\.ejectedAt === null\) refreshRejoinToken\(roomId\);/,
      `${name}: a still-live seat refreshes on state arrival`,
    );
    assert.match(src, /You were removed from the game\./, `${name}: removal banner`);
  }
});

function retrySlice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} must exist after ${startMarker}`);
  return src.slice(start, end);
}

test('source pin (F5 + Zara a): useRoomState retryConnection is serialised and refuses a deleted room', () => {
  const slice = retrySlice(
    useRoomStateSrc,
    'const retryConnection = useCallback',
    'const sendRadio = useCallback',
  );
  assert.match(slice, /if \(roomDeleted \|\| seatRemoved\) return;/, 'latched deletion or removal refuses outright');
  assert.match(
    slice,
    /\.then\(\(state\) => \{\n\s*applySnapshot\(state\);\n\s*void socketRef\.current\?\.retry\(\);/,
    'the socket retry runs only after the state fetch resolves',
  );
  assert.match(
    slice,
    /if \(err instanceof LiveHttpError && err\.status === 404\) \{\n\s*markDeleted\(\);\n\s*return;/,
    'a 404 goes home with no socket retry',
  );
  const retries = slice.match(/socketRef\.current\?\.retry\(\)/g) ?? [];
  assert.equal(
    retries.length,
    3,
    'exactly three socket retries: no-token (no fetch to race), fetch-success, and non-404 failure — none concurrent with the fetch',
  );
  assert.match(
    slice,
    /if \(!session\?\.reconnectToken\) \{\n\s*void socketRef\.current\?\.retry\(\);/,
    'the no-token branch retries the socket with no fetch at all',
  );
  assert.doesNotMatch(
    slice,
    /\n {4}void socketRef\.current\?\.retry\(\);\n {2}\}, \[mode/,
    'the old trailing concurrent retry() call must be gone',
  );
});

test('source pin (F5): the lobby retryConnection is serialised the same way', () => {
  const slice = retrySlice(
    lobbySrc,
    'const retryConnection = useCallback',
    'const toggleMyReady',
  );
  assert.match(
    slice,
    /\.then\(\(state\) => \{\n\s*setLobby\(/,
    'the lobby fetch still repopulates the roster first',
  );
  const retries = slice.match(/socketRef\.current\?\.retry\(\)/g) ?? [];
  assert.equal(
    retries.length,
    2,
    'exactly two socket retries: fetch-success and non-404 failure — none concurrent with the fetch',
  );
  assert.doesNotMatch(
    slice,
    /\n {6}void socketRef\.current\?\.retry\(\);\n {4}\} else \{/,
    'the old concurrent retry() after the fetch must be gone',
  );
});
