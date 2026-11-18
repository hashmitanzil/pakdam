import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveLiveSession, saveDemoSession, getSession, getSessionForRoom,
  isLiveHost, hasLiveCredential, clearSession,
} from '../session-credentials.js';

// ---------------------------------------------------------------------------
// Worker 8 — regression tests for live wiring, web client side:
// per-tab session credentials (apps/web/src/lib/session-credentials.ts).
//
// The stored credential is the whole of items (1), (2) and (5) on the
// client: the reconnect token proves the SEAT, the host token proves
// HOST authority, and a display name alone proves nothing. Storage is
// sessionStorage ONLY — never localStorage (shared across tabs),
// never a URL, never logged. One tab = one seat; sessionStorage
// survives a reload in the same tab but a new tab starts with no
// identity.
//
// RUNNING: see the header of websocket-reconnect.test.ts in this
// directory (same scratch-compile command; add this file to it).
// ---------------------------------------------------------------------------

interface StorageMock {
  store: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function installStorage(t: { after: (fn: () => void) => void }): StorageMock {
  const mock: StorageMock = {
    store: new Map(),
    getItem(key: string) { return this.store.get(key) ?? null; },
    setItem(key: string, value: string) { this.store.set(key, value); },
    removeItem(key: string) { this.store.delete(key); },
    clear() { this.store.clear(); },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g['window'];
  const prevSession = g['sessionStorage'];
  const prevLocal = g['localStorage'];
  g['window'] = {};
  g['sessionStorage'] = mock;
  // localStorage must NEVER be touched: any access throws.
  g['localStorage'] = new Proxy({}, {
    get() { throw new Error('localStorage must never be touched by session credentials'); },
  });
  t.after(() => {
    if (prevWindow === undefined) delete g['window']; else g['window'] = prevWindow;
    if (prevSession === undefined) delete g['sessionStorage']; else g['sessionStorage'] = prevSession;
    if (prevLocal === undefined) delete g['localStorage']; else g['localStorage'] = prevLocal;
  });
  return mock;
}

test('session (1j): a host session stores BOTH tokens; only the host token proves host', (t) => {
  const store = installStorage(t);
  saveLiveSession({
    roomId: 'r1', playerId: 'h1', displayName: 'Host One',
    reconnectToken: 'seat-token-h1', hostToken: 'host-token-h1',
    isHost: true, roomCode: 'ABC123',
  });
  const session = getSessionForRoom('r1');
  assert.equal(session?.mode, 'live');
  assert.equal(session?.playerId, 'h1');
  assert.equal(session?.reconnectToken, 'seat-token-h1');
  assert.equal(session?.hostToken, 'host-token-h1');
  assert.equal(isLiveHost('r1'), true, 'live session + host token = host');
  assert.equal(hasLiveCredential('r1'), true);
  // Exactly one key, and the raw tokens are in sessionStorage only.
  assert.deepEqual([...store.store.keys()], ['pakdam.session.v1']);
  assert.ok(store.store.get('pakdam.session.v1')!.includes('seat-token-h1'));
});

test('session (1k): a display name alone NEVER proves host — no host token, no host powers', (t) => {
  installStorage(t);
  // Same display name as the host, but a non-host seat with no token.
  saveLiveSession({
    roomId: 'r1', playerId: 'r1', displayName: 'Host One',
    reconnectToken: 'seat-token-r1', isHost: false, roomCode: 'ABC123',
  });
  assert.equal(isLiveHost('r1'), false, 'a Runner named like the host is still not the host');
  assert.equal(hasLiveCredential('r1'), true, '...but they still hold their own seat credential');

  // Even isHost: true WITHOUT a host token proves nothing — the
  // token is the proof, not the flag.
  saveLiveSession({
    roomId: 'r1', playerId: 'h1', displayName: 'Host One',
    reconnectToken: 'seat-token-h1', isHost: true, roomCode: 'ABC123',
  });
  assert.equal(isLiveHost('r1'), false, 'isHost without a host token is not host proof');
});

test('session (2k): a token for ANOTHER room is not a token for this one', (t) => {
  installStorage(t);
  saveLiveSession({
    roomId: 'r1', playerId: 'h1', reconnectToken: 'seat-token-h1',
    hostToken: 'host-token-h1', isHost: true,
  });
  assert.equal(getSessionForRoom('r2'), null);
  assert.equal(isLiveHost('r2'), false);
  assert.equal(hasLiveCredential('r2'), false);
  assert.equal(getSession()?.roomId, 'r1', 'getSession returns whatever this tab holds, for any room');
});

test('session (2l): a restore that returns an EMPTY token keeps the stored one — a good token is never overwritten with nothing', (t) => {
  installStorage(t);
  saveLiveSession({
    roomId: 'r1', playerId: 'r1', reconnectToken: 'seat-token-r1',
    hostToken: undefined, isHost: false,
  });
  // The server restore path returns reconnectToken '' (room-do.ts
  // addPlayer: restore mints no token). Saving that empty value for
  // the SAME room + player must keep the stored token.
  const kept = saveLiveSession({
    roomId: 'r1', playerId: 'r1', reconnectToken: '',
    isHost: false,
  });
  assert.equal(kept.reconnectToken, 'seat-token-r1', 'the stored token survives an empty restore');
  assert.equal(getSessionForRoom('r1')?.reconnectToken, 'seat-token-r1');

  // ...but an empty token for a DIFFERENT player does not resurrect
  // the old one.
  saveLiveSession({ roomId: 'r1', playerId: 'r2', reconnectToken: '', isHost: false });
  assert.equal(getSessionForRoom('r1')?.reconnectToken, undefined);
});

test('session (5d): a demo session carries NO tokens at all, and replacing live with demo drops them', (t) => {
  installStorage(t);
  saveLiveSession({
    roomId: 'r1', playerId: 'h1', reconnectToken: 'seat-token-h1',
    hostToken: 'host-token-h1', isHost: true,
  });
  assert.equal(hasLiveCredential('r1'), true);
  saveDemoSession({ roomId: 'r1', playerId: 'h1', isHost: true });
  const session = getSessionForRoom('r1');
  assert.equal(session?.mode, 'demo');
  assert.equal(session?.reconnectToken, undefined);
  assert.equal(session?.hostToken, undefined);
  assert.equal(hasLiveCredential('r1'), false, 'a demo session can never open a live socket');
  assert.equal(isLiveHost('r1'), false);
});

test('session (5e): clearSession drops the seat; malformed storage never throws', (t) => {
  const store = installStorage(t);
  saveLiveSession({
    roomId: 'r1', playerId: 'h1', reconnectToken: 'seat-token-h1',
    hostToken: 'host-token-h1', isHost: true,
  });
  assert.ok(getSession());
  clearSession();
  assert.equal(getSession(), null);
  assert.equal(hasLiveCredential('r1'), false);

  store.store.set('pakdam.session.v1', '{not json');
  assert.equal(getSession(), null, 'malformed storage reads as no session, never a throw');
  store.store.set('pakdam.session.v1', JSON.stringify({ mode: 'weird', roomId: 'r1', playerId: 'h1' }));
  assert.equal(getSession(), null, 'an unknown mode reads as no session');
});
