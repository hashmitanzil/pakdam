/**
 * v31 rejoin-restore tests (Meera) — Fix 1: rejoin does not survive a
 * dropped tab.
 *
 * ROOT CAUSE (founder-confirmed live, v30): the v29 localStorage mirror
 * (`pakdam.rejoin.v1.<roomId>`) WAS written at join/create, but NOTHING
 * on a room page ever read it back — only the two join pages offered
 * "Rejoin your game". A discarded tab (Android, 20 tabs open) comes
 * back with no sessionStorage, `useRoomState` read a null session,
 * fell back to `mode: 'demo'`, polled the demo store, found no demo
 * room, and set the dead-end "Game not found on this device." — while
 * a live seat token sat in localStorage, never tried.
 *
 * The fix is `getOrRestoreSessionForRoom` (session-credentials.ts):
 * sessionStorage first, else the rejoin mirror — synchronously, in
 * the `useState` initializer that decides the mode, so the demo
 * fallback can never win the race. These tests pin the REAL helper
 * (localStorage + sessionStorage stubbed with Maps; no DOM, no
 * network), including the exact discard-and-return sequence: mount
 * with no sessionStorage but a saved localStorage key → seat restored.
 *
 * The hook/lobby wiring (which callers use the helper) is pinned by
 * source pins at the bottom — the pages need React.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const localStore = new Map();
const sessionStore = new Map();
globalThis.window = {
  localStorage: {
    get length() {
      return localStore.size;
    },
    getItem: (key) => localStore.get(key) ?? null,
    setItem: (key, value) => {
      localStore.set(key, value);
    },
    removeItem: (key) => {
      localStore.delete(key);
    },
    key: (i) => [...localStore.keys()][i] ?? null,
  },
  sessionStorage: {
    getItem: (key) => sessionStore.get(key) ?? null,
    setItem: (key, value) => {
      sessionStore.set(key, value);
    },
    removeItem: (key) => {
      sessionStore.delete(key);
    },
  },
};

const {
  getSessionForRoom,
  getOrRestoreSessionForRoom,
  storeLiveSeat,
  storeDemoSeat,
} = await import('../src/lib/session-credentials.ts');
const { storeRejoinToken, getRejoinToken, listRejoinTokens, REJOIN_TOKEN_MAX_AGE_MS } = await import(
  '../src/lib/rejoin-token.ts'
);

function reset() {
  localStore.clear();
  sessionStore.clear();
}

const ENTRY = {
  roomId: 'room-1',
  roomCode: 'ABCDEF',
  playerId: 'p1',
  displayName: 'Ana',
  reconnectToken: 'tok-live-1',
  isHost: false,
};

test('discard-and-return: no sessionStorage + saved localStorage key → seat restored as live', () => {
  reset();
  storeRejoinToken(ENTRY);
  // The tab was discarded: sessionStorage is empty, localStorage holds the mirror.
  assert.equal(getSessionForRoom('room-1'), null);
  const restored = getOrRestoreSessionForRoom('room-1');
  assert.notEqual(restored, null);
  assert.equal(restored.mode, 'live');
  assert.equal(restored.roomId, 'room-1');
  assert.equal(restored.playerId, 'p1');
  assert.equal(restored.displayName, 'Ana');
  assert.equal(restored.reconnectToken, 'tok-live-1');
  assert.equal(restored.isHost, false);
  assert.equal(restored.roomCode, 'ABCDEF');
  // And it is written back into sessionStorage, so every later read
  // (socket, catch token, host-token mint) finds it without a re-restore.
  assert.equal(getSessionForRoom('room-1')?.reconnectToken, 'tok-live-1');
  // The mirror itself is left in place (leave / eject / match-end clear it).
  assert.equal(getRejoinToken('room-1')?.reconnectToken, 'tok-live-1');
});

test('existing sessionStorage session wins — the mirror is never consulted', () => {
  reset();
  storeLiveSeat({
    mode: 'live',
    roomId: 'room-1',
    playerId: 'p1',
    displayName: 'Ana',
    reconnectToken: 'tok-session',
    isHost: false,
    roomCode: 'ABCDEF',
  });
  storeRejoinToken({ ...ENTRY, reconnectToken: 'tok-mirror' });
  const found = getOrRestoreSessionForRoom('room-1');
  assert.equal(found?.reconnectToken, 'tok-session');
  assert.equal(getRejoinToken('room-1')?.reconnectToken, 'tok-mirror');
});

test('no session and no mirror → null (the "Game not found" path stands)', () => {
  reset();
  assert.equal(getOrRestoreSessionForRoom('room-1'), null);
  assert.equal(getSessionForRoom('room-1'), null);
});

test('mirror for a DIFFERENT room never restores this room', () => {
  reset();
  storeRejoinToken({ ...ENTRY, roomId: 'room-2', roomCode: 'GHIJKL' });
  assert.equal(getOrRestoreSessionForRoom('room-1'), null);
});

test('stale mirror (older than the 12 h max age) → null, and the entry is deleted', () => {
  reset();
  storeRejoinToken(ENTRY);
  const key = 'pakdam.rejoin.v1.room-1';
  const raw = JSON.parse(localStore.get(key));
  raw.storedAtMs = Date.now() - REJOIN_TOKEN_MAX_AGE_MS - 1000;
  localStore.set(key, JSON.stringify(raw));
  assert.equal(getOrRestoreSessionForRoom('room-1'), null);
  assert.equal(localStore.has(key), false);
});

test('empty-token mirror → null, and no session is written', () => {
  reset();
  // Hand-crafted: storeRejoinToken itself refuses empty tokens, but a
  // corrupted / hand-written entry must still never restore a dead seat.
  localStore.set(
    'pakdam.rejoin.v1.room-1',
    JSON.stringify({ ...ENTRY, reconnectToken: '', storedAtMs: Date.now() }),
  );
  assert.equal(getOrRestoreSessionForRoom('room-1'), null);
  assert.equal(getSessionForRoom('room-1'), null);
});

test('hand-crafted entry under key room-1 stamped room-2 never restores room-1 (Zara b)', () => {
  reset();
  // A hand-crafted entry: the key says room-1 but the payload says
  // room-2. Before the fix, `readRejoinToken` never compared the two,
  // so this restored a session stamped room-2 under room-1's key.
  localStore.set(
    'pakdam.rejoin.v1.room-1',
    JSON.stringify({ ...ENTRY, roomId: 'room-2', roomCode: 'GHIJKL', storedAtMs: Date.now() }),
  );
  assert.equal(getRejoinToken('room-1'), null);
  assert.equal(getOrRestoreSessionForRoom('room-1'), null);
  assert.equal(getSessionForRoom('room-1'), null);
  // And it never leaks into the list either (the list reads through
  // the same validated read).
  assert.equal(listRejoinTokens().length, 0);
});

test('host mirror restores as host WITHOUT a host token (lazy mint owns that)', () => {
  reset();
  storeRejoinToken({ ...ENTRY, isHost: true });
  const restored = getOrRestoreSessionForRoom('room-1');
  assert.equal(restored?.isHost, true);
  assert.equal(restored?.hostToken, undefined);
});

test('an existing demo session is returned untouched — never converted to live', () => {
  reset();
  storeDemoSeat({
    mode: 'demo',
    roomId: 'room-1',
    playerId: 'demo-p1',
    displayName: 'Ana',
    isHost: false,
  });
  const found = getOrRestoreSessionForRoom('room-1');
  assert.equal(found?.mode, 'demo');
  assert.equal(found?.playerId, 'demo-p1');
});

// -- Source pins: the pages/hook must actually USE the helper. --------
const useRoomStateSrc = readFileSync(
  new URL('../src/components/match/useRoomState.ts', import.meta.url),
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
const liveClientSrc = readFileSync(
  new URL('../src/lib/live-client.ts', import.meta.url),
  'utf8',
);

test('source pin: useRoomState reads the session via the restore helper, not sessionStorage alone', () => {
  assert.match(
    useRoomStateSrc,
    /useState<PakdamSession \| null>\(\(\) => getOrRestoreSessionForRoom\(roomId\)\)/,
    'the mode-deciding initializer must restore from the mirror first',
  );
  assert.doesNotMatch(
    useRoomStateSrc,
    /useState<PakdamSession \| null>\(\(\) => getSessionForRoom\(roomId\)\)/,
    'the old sessionStorage-only initializer must be gone',
  );
});

test('source pin: the lobby load effect restores from the mirror too', () => {
  assert.match(
    lobbySrc,
    /getOrRestoreSessionForRoom\(roomId\)/,
    'the lobby reads the session via the restore helper',
  );
});

test('source pin: the setup page restores from the mirror too (F1)', () => {
  // Diya's review found this page still used the plain
  // sessionStorage-only read, so its Retry could never succeed after
  // a tab discard — the same defect as the lobby, one page over.
  assert.match(
    setupSrc,
    /getOrRestoreSessionForRoom\(roomId\)/,
    'the setup load effect reads the session via the restore helper',
  );
  assert.doesNotMatch(
    setupSrc,
    /getSessionForRoom\(roomId\)/,
    'the old sessionStorage-only read must be gone from the setup page',
  );
});

test('source pin: the mirror is still written at join/create (write side unchanged)', () => {
  assert.match(liveClientSrc, /mirrorRejoinToken\(data\.roomId\)/);
  assert.match(liveClientSrc, /mirrorRejoinToken\(roomId\)/);
});

// -- v31 Kabir fold-in: 4404 (room gone, terminal) vs 4401 (retryable ticket). --
const { WS_CLOSE_CODE_ACTION } = await import('@pakdam/shared');
const websocketSrc = readFileSync(
  new URL('../src/lib/websocket.ts', import.meta.url),
  'utf8',
);

test('close-code contract: 4404 is terminal, 4401 is fresh-ticket-reconnect-once', () => {
  // Kabir's server half (workers/src/http.ts:1097-1104): ROOM_NOT_FOUND
  // closes 4404, FORBIDDEN closes 4403, everything else non-101 closes
  // 4401. The client must treat 4404 as terminal (room gone — a fresh
  // ticket cannot help) and 4401 as retryable. This pins the REAL
  // shared contract the socket switches on (websocket.ts handleClose).
  assert.equal(WS_CLOSE_CODE_ACTION[4404], 'do-not-reconnect');
  assert.equal(WS_CLOSE_CODE_ACTION[4401], 'fresh-ticket-reconnect-once');
  assert.equal(WS_CLOSE_CODE_ACTION[4403], 'do-not-reconnect');
  assert.equal(WS_CLOSE_CODE_ACTION[4400], 'fresh-ticket-reconnect-once');
});

test('source pin: a 4404 close carries the distinct room-gone detail (not the 4401 wording)', () => {
  assert.match(
    websocketSrc,
    /event\.code === 4404\s*\n\s*\? 'Room not found — the game has ended\.'/,
    'the do-not-reconnect branch names 4404 distinctly from 4401/4403',
  );
  assert.match(
    websocketSrc,
    /4404 → room gone, terminal/,
    'the header documents 4404 as terminal and distinct from 4401',
  );
});

test('source pin: "Game not found" fires only after the restore returns null (demo path)', () => {
  // The demo 'Game not found on this device.' is set in applyDemo(null)
  // only when there was no demo room AND no session — and the session
  // now comes from the restore helper, so a stored mirror entry is
  // tried BEFORE this error can fire. The live 404 path goes home via
  // markDeleted, never through this error.
  assert.match(useRoomStateSrc, /if \(hadDemoRoomRef\.current \|\| session\) \{\n\s*markDeleted\(\);/);
  assert.match(useRoomStateSrc, /setError\('Game not found on this device\.'\);/);
});
