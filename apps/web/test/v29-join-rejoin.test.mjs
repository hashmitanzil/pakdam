/**
 * join-key + rejoin-token tests — v29 (Gap 4 join dedupe, 30 s rule rejoin).
 * localStorage stubbed with a Map; no DOM, no network.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const store = new Map();
globalThis.window = {
  localStorage: {
    get length() {
      return store.size;
    },
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    key: (i) => [...store.keys()][i] ?? null,
  },
  sessionStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
};

const { getOrCreateJoinKey, clearJoinKey, JOIN_KEY_TTL_MS } = await import(
  '../src/lib/join-key.ts'
);
const {
  storeRejoinToken,
  getRejoinToken,
  getRejoinTokenForCode,
  listRejoinTokens,
  clearRejoinToken,
} = await import('../src/lib/rejoin-token.ts');

test('join key: first attempt generates + stores BEFORE sending; retry reuses the SAME key', () => {
  store.clear();
  const first = getOrCreateJoinKey('ROOMID', 'Ana');
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(store.size, 1);
  const second = getOrCreateJoinKey('ROOMID', 'Ana');
  assert.equal(second, first, 'a retry must reuse the stored key, never mint a fresh one');
  // A different codename is a different attempt.
  assert.notEqual(getOrCreateJoinKey('ROOMID', 'Ben'), first);
  // Case-insensitive scope + codename.
  assert.equal(getOrCreateJoinKey('roomid', 'ana'), first);
});

test('join key: a key older than the 10-min server cache is replaced', () => {
  store.clear();
  const first = getOrCreateJoinKey('ROOMID', 'Ana');
  const raw = JSON.parse(store.values().next().value);
  raw.storedAtMs = Date.now() - JOIN_KEY_TTL_MS - 1000;
  store.set([...store.keys()][0], JSON.stringify(raw));
  assert.notEqual(getOrCreateJoinKey('ROOMID', 'Ana'), first);
});

test('join key: cleared on success — the next join is a fresh attempt', () => {
  store.clear();
  const first = getOrCreateJoinKey('ROOMID', 'Ana');
  clearJoinKey('ROOMID', 'Ana');
  assert.notEqual(getOrCreateJoinKey('ROOMID', 'Ana'), first);
});

test('rejoin token: stored per room, listed newest-first, found by code', () => {
  store.clear();
  storeRejoinToken({
    roomId: 'room-1',
    roomCode: 'ABCDEF',
    playerId: 'p1',
    displayName: 'Ana',
    reconnectToken: 'tok-1',
    isHost: false,
  });
  storeRejoinToken({
    roomId: 'room-2',
    roomCode: 'GHIJKL',
    playerId: 'p2',
    displayName: 'Ben',
    reconnectToken: 'tok-2',
    isHost: true,
  });
  assert.equal(getRejoinToken('room-1')?.reconnectToken, 'tok-1');
  assert.equal(getRejoinToken('missing'), null);
  assert.equal(getRejoinTokenForCode('abcdef')?.roomId, 'room-1');
  assert.equal(getRejoinTokenForCode('ZZZZZZ'), null);
  assert.equal(listRejoinTokens().length, 2);
  clearRejoinToken('room-1');
  assert.equal(getRejoinToken('room-1'), null);
  assert.equal(listRejoinTokens().length, 1);
});

test('rejoin token: an empty token is never stored', () => {
  store.clear();
  storeRejoinToken({
    roomId: 'room-1',
    roomCode: 'ABCDEF',
    playerId: 'p1',
    displayName: 'Ana',
    reconnectToken: '',
    isHost: false,
  });
  assert.equal(listRejoinTokens().length, 0);
});
