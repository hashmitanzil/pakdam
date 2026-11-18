import test from 'node:test';
import assert from 'node:assert/strict';
import { route, roomCodeSchema, lookupAllowed } from '../src/http.js';
import { lookupRoomCode, registerRoomCode } from '../src/room-do.js';
import type { CodeIndex } from '../src/room-do.js';

// Worker F (2026-11-17): GET /v1/rooms/by-code/:code — code → roomId
// lookup. The Worker entry (index.ts) imports 'cloudflare:workers'
// via room-do-class.ts, so the live handler itself cannot run under
// plain Node — what is unit-tested here is everything around it:
// the route table, the code-shape schema, the pure index helpers,
// and the rate limit. The handler path (create → register → lookup
// → join) is verified by a wrangler-dev smoke test, not here.

test('routes: GET /v1/rooms/by-code/:code resolves; neighbouring routes unchanged', () => {
  assert.equal(route('/v1/rooms/by-code/ABC123'), 'by-code');
  assert.equal(route('/v1/rooms/abc'), 'get-state');
  assert.equal(route('/v1/rooms/abc/join'), 'join');
  assert.equal(route('/v1/rooms/abc/ws'), 'websocket');
  // No code segment: not a lookup — 'by-code' reads as a room id for
  // get-state, exactly as before (GET /v1/rooms/by-code → 404 room
  // not found from the DO, not a lookup).
  assert.equal(route('/v1/rooms/by-code'), 'get-state');
  assert.equal(route('/v1/rooms/by-code/ABC123/extra'), 'not-found');
});

test('roomCodeSchema: 6 uppercase A-Z0-9 only — mirrors shared isValidRoomCode', () => {
  assert.equal(roomCodeSchema.safeParse('ABC123').success, true);
  assert.equal(roomCodeSchema.safeParse('KX7Q2M').success, true);
  assert.equal(roomCodeSchema.safeParse('abc123').success, false, 'lowercase is malformed (400), not unknown (404)');
  assert.equal(roomCodeSchema.safeParse('ABC12').success, false);
  assert.equal(roomCodeSchema.safeParse('ABC1234').success, false);
  assert.equal(roomCodeSchema.safeParse('ABC12!').success, false);
  assert.equal(roomCodeSchema.safeParse('ABC 23').success, false);
  assert.equal(roomCodeSchema.safeParse('').success, false);
  // The shared regex is wider than the 32-char generation alphabet
  // (0/O/1/I are never generated): a code the server accepted at
  // create must stay lookable-up, so they still parse here.
  assert.equal(roomCodeSchema.safeParse('AB0123').success, true);
  assert.equal(roomCodeSchema.safeParse('ABO123').success, true);
});

test('code index: register → lookup, unknown → null, same-room re-register idempotent, other-room conflict', () => {
  let index: CodeIndex = {};
  assert.equal(lookupRoomCode(index, 'ABC123'), null);
  const first = registerRoomCode(index, 'ABC123', 'room-1');
  assert.equal(first.conflict, false);
  index = first.index;
  assert.equal(lookupRoomCode(index, 'ABC123'), 'room-1');
  assert.equal(lookupRoomCode(index, 'ZZZZZZ'), null);
  // Idempotent retry: same code, same room — no conflict, map unchanged.
  const retry = registerRoomCode(index, 'ABC123', 'room-1');
  assert.equal(retry.conflict, false);
  assert.deepEqual(retry.index, index);
  // Collision: same code, different room — conflict, original mapping kept.
  const clash = registerRoomCode(index, 'ABC123', 'room-2');
  assert.equal(clash.conflict, true);
  assert.equal(lookupRoomCode(clash.index, 'ABC123'), 'room-1');
  // A second code is independent.
  const second = registerRoomCode(index, 'KX7Q2M', 'room-2');
  assert.equal(second.conflict, false);
  assert.equal(lookupRoomCode(second.index, 'KX7Q2M'), 'room-2');
  assert.equal(lookupRoomCode(second.index, 'ABC123'), 'room-1');
});

test('lookupAllowed: 5/min per IP, 6th lookup in the window is refused; another IP unaffected', () => {
  for (let i = 0; i < 5; i++) assert.equal(lookupAllowed('203.0.113.7', 1000 + i), true);
  assert.equal(lookupAllowed('203.0.113.7', 1006), false);
  assert.equal(lookupAllowed('198.51.100.9', 1006), true);
  assert.equal(lookupAllowed('203.0.113.7', 1000 + 61_000), true, 'window slides');
});
