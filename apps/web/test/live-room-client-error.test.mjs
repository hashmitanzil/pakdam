import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

// The client reads the seat from sessionStorage and the Worker URL from
// the env — both stubbed here so the real client code runs under Node.
process.env.NEXT_PUBLIC_WORKER_URL = 'https://worker.example';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const PLAYER_ID = '22222222-2222-4222-8222-222222222222';

const store = new Map();
store.set(
  'pakdam.session.v1',
  JSON.stringify([
    {
      mode: 'live',
      roomId: ROOM_ID,
      playerId: PLAYER_ID,
      displayName: 'Host',
      reconnectToken: 'reconnect-token',
      hostToken: 'host-token',
      isHost: true,
      roomCode: 'ABCDEF',
    },
  ]),
);
globalThis.window = {
  sessionStorage: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  },
};

const { startLiveMatch, updateLiveRoomConfig, LiveHttpError } = await import(
  '../src/lib/live-room-client.ts'
);
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

/** Stub fetch to answer every POST with the given status + body. */
function stubFetch(status, body, contentType = 'application/json') {
  const payload =
    typeof body === 'string' ? body : JSON.stringify(body);
  globalThis.fetch = async (url) => {
    assert.match(
      String(url),
      /^https:\/\/worker\.example\/v1\/rooms\/11111111-1111-4111-8111-111111111111\//,
    );
    return new Response(payload, {
      status,
      headers: { 'Content-Type': contentType },
    });
  };
}

test('refused start surfaces the server gate reason, not the generic 409 text', async () => {
  const reason = 'Waiting for Ana to tap "I\'m ready".';
  stubFetch(409, { error: reason });
  await assert.rejects(startLiveMatch(ROOM_ID), (err) => {
    assert.ok(err instanceof LiveHttpError);
    assert.equal(err.status, 409);
    assert.equal(err.message, reason);
    assert.notEqual(err.message, 'Full, or no longer open.');
    return true;
  });
});

test('refused start with an unreadable error body falls back to the generic 409 text', async () => {
  stubFetch(409, 'not json', 'text/plain');
  await assert.rejects(startLiveMatch(ROOM_ID), (err) => {
    assert.ok(err instanceof LiveHttpError);
    assert.equal(err.status, 409);
    assert.equal(err.message, 'Full, or no longer open.');
    return true;
  });
});

test('other postHost callers benefit too: a refused config save surfaces the server reason', async () => {
  const reason = 'Set the play zone first — the zone needs at least 3 points on the map.';
  stubFetch(409, { error: reason });
  await assert.rejects(updateLiveRoomConfig(ROOM_ID, DEFAULT_ROOM_CONFIG), (err) => {
    assert.ok(err instanceof LiveHttpError);
    assert.equal(err.status, 409);
    assert.equal(err.message, reason);
    return true;
  });
});
