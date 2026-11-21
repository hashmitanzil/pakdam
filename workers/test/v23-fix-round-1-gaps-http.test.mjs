import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { handleLifecycle } = await import('../src/http.ts');

// v23 fix round 1 — GAP test (Arjun): T6 / Zara A2.
//
// The lifecycle 'end' rate limit must be keyed by room+playerId, NOT by
// the presented host-token hash (the replay F5 pattern): the same player
// spamming 'end' with ROTATING bogus host tokens must hit the limit —
// every guessed token getting a fresh bucket cannot throttle credential
// guessing at all. The calibration table gives
// 'POST /v1/rooms/:id/lifecycle' 10/min.
//
// NOTE (2026-11-21): this test FAILS against the current tree —
// `handleLifecycle` still keys `checkSeatLimit` by the token hash, so
// rotating tokens dodge the bucket entirely. It pins the required
// behaviour for Kabir's fix (pass `seatKey(roomId, playerId)` as the
// bucket key for action 'end', exactly as `handleReplay` already does
// for replay). Do not "fix" the test by asserting the current
// token-hash behaviour.

const ROOM_ID = '11111111-2222-4333-8444-555555555555';
const PLAYER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

function makeDoStub() {
  let calls = 0;
  return {
    calls: () => calls,
    env: {
      ROOM_DO: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async () => {
            calls += 1;
            return new Response(
              JSON.stringify({
                ok: false,
                error: 'Only the host can end the round.',
                code: 'FORBIDDEN',
                status: 403,
              }),
              { status: 403, headers: { 'Content-Type': 'application/json' } },
            );
          },
        }),
      },
    },
  };
}

async function endCall(stub, playerId, hostToken) {
  const req = new Request(`http://worker.test/v1/rooms/${ROOM_ID}/lifecycle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'end', playerId, hostToken }),
  });
  const ctx = { env: stub.env, ctx: {} };
  const res = await handleLifecycle(req, ctx, ROOM_ID);
  return { status: res.status, retryAfter: res.headers.get('Retry-After'), body: await res.text() };
}

test('v23 fix (T6) lifecycle end is rate-limited by room+playerId: rotating bogus host tokens still hit the limit', async () => {
  const stub = makeDoStub();
  // Ten 'end' attempts with ten DIFFERENT bogus host tokens — the DO
  // refuses each (403: only the host can end the round).
  for (let i = 0; i < 10; i += 1) {
    const r = await endCall(stub, PLAYER_ID, `bogus-host-token-${i}`);
    assert.equal(r.status, 403, `attempt ${i + 1} must reach the DO and be refused as non-host, got ${r.status}: ${r.body}`);
  }
  assert.equal(stub.calls(), 10, 'all ten attempts must have reached the DO');
  // The eleventh attempt — same player, yet another bogus token — must
  // be stopped by the Worker limiter BEFORE the DO is called: one
  // bucket per room+player, not one per guessed token.
  const blocked = await endCall(stub, PLAYER_ID, 'bogus-host-token-10');
  assert.equal(blocked.status, 429, `the 11th end from the same player must be rate-limited, got ${blocked.status}: ${blocked.body}`);
  assert.notEqual(blocked.retryAfter, null, 'a 429 must carry Retry-After');
  assert.equal(stub.calls(), 10, 'the blocked attempt must never reach the DO');
  // A DIFFERENT player has their own bucket: their first attempt still
  // reaches the DO (and is refused as non-host there).
  const other = await endCall(stub, 'bbbbbbbb-2222-4222-8222-222222222222', 'bogus-host-token-x');
  assert.equal(other.status, 403, `another player must not share the bucket, got ${other.status}: ${other.body}`);
  assert.equal(stub.calls(), 11, 'the other player’s attempt must reach the DO');
});
