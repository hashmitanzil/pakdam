import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { slidingWindowAllow, HttpRateLimiter, clientIp, seatKey } = await import(
  '../src/rate-limit.ts'
);

test('slidingWindowAllow: allows up to the limit, then blocks', () => {
  const windows = new Map();
  assert.deepEqual(slidingWindowAllow(windows, 'k', 3, 60_000, 1000), {
    allowed: true,
    retryAfterSeconds: 0,
  });
  assert.equal(slidingWindowAllow(windows, 'k', 3, 60_000, 1000).allowed, true);
  assert.equal(slidingWindowAllow(windows, 'k', 3, 60_000, 1000).allowed, true);
  const blocked = slidingWindowAllow(windows, 'k', 3, 60_000, 1000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);
});

test('slidingWindowAllow: the window slides — old hits fall out and the key is allowed again', () => {
  const windows = new Map();
  slidingWindowAllow(windows, 'k', 3, 60_000, 1000);
  slidingWindowAllow(windows, 'k', 3, 60_000, 1000);
  slidingWindowAllow(windows, 'k', 3, 60_000, 1000);
  assert.equal(slidingWindowAllow(windows, 'k', 3, 60_000, 1000).allowed, false);
  // 61 s later the first three hits are outside the window.
  assert.equal(slidingWindowAllow(windows, 'k', 3, 60_000, 61_001).allowed, true);
});

test('slidingWindowAllow: different keys have independent windows', () => {
  const windows = new Map();
  slidingWindowAllow(windows, 'a', 1, 60_000, 1000);
  assert.equal(slidingWindowAllow(windows, 'a', 1, 60_000, 1000).allowed, false);
  assert.equal(slidingWindowAllow(windows, 'b', 1, 60_000, 1000).allowed, true);
});

test('HttpRateLimiter: a known route enforces its table limit (POST /v1/rooms is 5/min)', () => {
  const limiter = new HttpRateLimiter();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check('POST /v1/rooms', '1.2.3.4', 1000).allowed, true);
  }
  const blocked = limiter.check('POST /v1/rooms', '1.2.3.4', 1000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);
});

test('HttpRateLimiter: an unknown route fails closed at 10/min, never unlimited', () => {
  const limiter = new HttpRateLimiter();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(limiter.check('POST /v1/nope', '1.2.3.4', 1000).allowed, true);
  }
  assert.equal(limiter.check('POST /v1/nope', '1.2.3.4', 1000).allowed, false);
});

test('HttpRateLimiter: the same route under a different key is a different window', () => {
  const limiter = new HttpRateLimiter();
  for (let i = 0; i < 5; i += 1) {
    limiter.check('POST /v1/rooms', '1.2.3.4', 1000);
  }
  assert.equal(limiter.check('POST /v1/rooms', '5.6.7.8', 1000).allowed, true);
});

test('clientIp: CF-Connecting-IP only — X-Forwarded-For is ignored', () => {
  assert.equal(
    clientIp(
      new Request('http://x/', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }),
    ),
    '203.0.113.7',
  );
  assert.equal(clientIp(new Request('http://x/')), 'unknown');
  assert.equal(
    clientIp(
      new Request('http://x/', { headers: { 'X-Forwarded-For': '203.0.113.7' } }),
    ),
    'unknown',
  );
});

test('seatKey: room + seat, anonymous when the seat is missing', () => {
  assert.equal(seatKey('room1', 'p1'), 'room1:p1');
  assert.equal(seatKey('room1', null), 'room1:anonymous');
  assert.equal(seatKey('room1', undefined), 'room1:anonymous');
});
