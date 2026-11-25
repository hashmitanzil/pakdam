import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { handleStart } = await import('../src/http.ts');

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const PLAYER_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Drive the real POST /v1/rooms/:id/start handler with a stubbed Room DO
 * that refuses the start the way `RoomStore.startMatch` does: 409 with a
 * specific gate reason. This proves the reason survives the Worker ->
 * HTTP boundary (`doError` -> `{ error: '…' }`) so the client can show
 * it — the client side is covered by
 * apps/web/test/live-room-client-error.test.mjs.
 */
async function startWithDoFailure({ error, hostToken }) {
  let seenOp = null;
  const stub = {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      seenOp = body.op;
      // v34 (Diya R3-N1) — handleStart verifies the host token in the
      // DO BEFORE the seat limit, so the stub must model that op: the
      // host's token verifies, and the start op itself is refused 409.
      if (body.op === 'verify-host-token') {
        return new Response(JSON.stringify({ ok: true, valid: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ ok: false, error, code: 'CONFLICT', status: 409 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  };
  const env = {
    ROOM_DO: {
      idFromName: (name) => name,
      get: () => stub,
    },
  };
  const req = new Request(`https://worker.example/v1/rooms/${ROOM_ID}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: PLAYER_ID, hostToken }),
  });
  const res = await handleStart(req, { env, ctx: { waitUntil: () => {} } }, ROOM_ID);
  return { res, seenOp };
}

test('handleStart: a not-ready gate refusal returns 409 with the server reason in { error }', async () => {
  const reason = 'Waiting for Ana to tap "I\'m ready".';
  const { res, seenOp } = await startWithDoFailure({
    error: reason,
    hostToken: 'host-token-1',
  });
  assert.equal(seenOp, 'start');
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, reason);
  assert.notEqual(body.error, 'Full, or no longer open.');
});

test('handleStart: a missing-zone gate refusal returns 409 with the server reason in { error }', async () => {
  const reason = 'Set the play zone first — the zone needs at least 3 points on the map.';
  const { res } = await startWithDoFailure({
    error: reason,
    hostToken: 'host-token-2',
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, reason);
});
