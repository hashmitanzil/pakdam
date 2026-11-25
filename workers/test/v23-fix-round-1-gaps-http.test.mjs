import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { handleLifecycle } = await import('../src/http.ts');
const { hashHostToken } = await import('@pakdam/shared');

// v23 fix round 1 — GAP test (Arjun): T6 / Zara A2, RE-PINNED by
// v34 (Diya R3-N1).
//
// The old pin ("the same player spamming 'end' with ROTATING bogus
// host tokens must hit the limit — the 11th 429s") IS the R3-N1 hole:
// the pre-auth bucket was keyed by the client-supplied playerId, so
// forged attempts burned the victim seat's budget and 429'd the
// host's real call. Verify-then-limit replaced it: the DO proves the
// host token BEFORE the seat bucket is touched, so rotating bogus
// tokens each 403 at verify and never consume the host's budget.
// What is still throttled: hammering with ONE bogus token (pre-auth
// bucket, per credential — the 11th repeat 429s) and genuinely
// excessive VERIFIED calls (seat bucket — the 11th verified end
// 429s; lifecycle is 10/min). The calibration table gives
// 'POST /v1/rooms/:id/lifecycle' 10/min.

const ROOM_ID = '11111111-2222-4333-8444-555555555555';
const PLAYER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

function makeDoStub(validHashes = new Set()) {
  let verifyCalls = 0;
  let lifecycleCalls = 0;
  return {
    verifyCalls: () => verifyCalls,
    lifecycleCalls: () => lifecycleCalls,
    env: {
      ROOM_DO: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? '{}'));
            if (body.op === 'verify-host-token') {
              verifyCalls += 1;
              return new Response(
                JSON.stringify({ ok: true, valid: validHashes.has(body.hostTokenHash) }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              );
            }
            lifecycleCalls += 1;
            return new Response(
              JSON.stringify({ ok: true, phase: 'CANCELLED' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
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

test('v34 R3-N1 (T6 re-pin): rotating bogus host tokens do NOT burn the host bucket — the verified end still succeeds', async () => {
  const realHash = await hashHostToken('real-host-token');
  const stub = makeDoStub(new Set([realHash]));
  // Eleven 'end' attempts with eleven DIFFERENT bogus host tokens —
  // the DO refuses each at verify (403). None may 429, and none may
  // reach the lifecycle op.
  for (let i = 0; i < 11; i += 1) {
    const r = await endCall(stub, PLAYER_ID, `bogus-host-token-${i}`);
    assert.equal(r.status, 403, `attempt ${i + 1} must 403 at verify, got ${r.status}: ${r.body}`);
  }
  assert.equal(stub.verifyCalls(), 11, 'all eleven forged attempts must have been verified (and refused) by the DO');
  assert.equal(stub.lifecycleCalls(), 0, 'no forged attempt may reach the lifecycle op');
  // The host's real end — same playerId — must still reach the DO
  // and succeed: the forged attempts consumed none of its budget.
  const real = await endCall(stub, PLAYER_ID, 'real-host-token');
  assert.equal(real.status, 200, `the host's real end must still succeed after 11 forged attempts, got ${real.status}: ${real.body}`);
  assert.equal(stub.lifecycleCalls(), 1, 'the real end must reach the lifecycle op exactly once');
  // A DIFFERENT player has their own buckets: their first forged
  // attempt still 403s at verify (and reaches the DO).
  const other = await endCall(stub, 'bbbbbbbb-2222-4222-8222-222222222222', 'bogus-host-token-x');
  assert.equal(other.status, 403, `another player must not share the bucket, got ${other.status}: ${other.body}`);
  assert.equal(stub.verifyCalls(), 13, 'the other player’s attempt must reach the DO');
});

test('v34 R3-N1 (T6 re-pin): hammering end with ONE bogus token still 429s at the pre-auth bucket', async () => {
  const stub = makeDoStub(new Set());
  const otherPlayer = 'cccccccc-3333-4333-8333-333333333333';
  for (let i = 0; i < 10; i += 1) {
    const r = await endCall(stub, otherPlayer, 'same-bogus-token');
    assert.equal(r.status, 403, `attempt ${i + 1} must 403 at verify, got ${r.status}: ${r.body}`);
  }
  assert.equal(stub.verifyCalls(), 10, 'all ten attempts must have reached the DO');
  const blocked = await endCall(stub, otherPlayer, 'same-bogus-token');
  assert.equal(blocked.status, 429, `the 11th end with the same bogus token must be rate-limited, got ${blocked.status}: ${blocked.body}`);
  assert.notEqual(blocked.retryAfter, null, 'a 429 must carry Retry-After');
  assert.equal(stub.verifyCalls(), 10, 'the blocked attempt must never reach the DO');
});

test('v34 R3-N1 (T6 re-pin): genuinely excessive VERIFIED ends still 429 at the seat bucket', async () => {
  const realHash = await hashHostToken('real-host-token-2');
  const stub = makeDoStub(new Set([realHash]));
  const thirdPlayer = 'dddddddd-4444-4444-8444-444444444444';
  for (let i = 0; i < 10; i += 1) {
    const r = await endCall(stub, thirdPlayer, 'real-host-token-2');
    assert.equal(r.status, 200, `verified end ${i + 1} must pass the limiter, got ${r.status}: ${r.body}`);
  }
  assert.equal(stub.lifecycleCalls(), 10, 'all ten verified ends must have reached the lifecycle op');
  const blocked = await endCall(stub, thirdPlayer, 'real-host-token-2');
  assert.equal(blocked.status, 429, `the 11th verified end must be rate-limited, got ${blocked.status}: ${blocked.body}`);
  assert.notEqual(blocked.retryAfter, null, 'a 429 must carry Retry-After');
  assert.equal(stub.lifecycleCalls(), 10, 'the blocked attempt must never reach the lifecycle op');
});
