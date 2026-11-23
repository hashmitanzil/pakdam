/**
 * api-client tests — reliability spec Gap 4 (§5), client half.
 * Retry rules per method, key reuse across attempts, Retry-After honouring.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const { fetchWithRetry, retryDelayMs, isRetryableStatus } = await import(
  '../src/lib/api-client.ts'
);

function stubFetch(responses) {
  let calls = 0;
  const seenHeaders = [];
  globalThis.fetch = async (url, init) => {
    calls += 1;
    // Minimal Headers stand-in: the eslint env for tests does not
    // define the global `Headers`, and the stub only needs a
    // case-insensitive `.get()`.
    const raw = init?.headers ?? {};
    const entries = new Map();
    if (raw && typeof raw.forEach === 'function') {
      // A real Headers (or Headers-like): enumerate it — plain
      // Object.entries() sees nothing on a Headers instance.
      raw.forEach((v, k) => entries.set(String(k).toLowerCase(), String(v)));
    } else if (raw instanceof Map) {
      for (const [k, v] of raw) entries.set(String(k).toLowerCase(), String(v));
    } else if (Array.isArray(raw)) {
      for (const [k, v] of raw) entries.set(String(k).toLowerCase(), String(v));
    } else if (typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) entries.set(k.toLowerCase(), String(v));
    }
    seenHeaders.push({ get: (name) => entries.get(String(name).toLowerCase()) ?? null });
    const next = responses[Math.min(calls - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: next.headers ?? {},
    });
  };
  return {
    get calls() {
      return calls;
    },
    seenHeaders,
  };
}

test('GET on 503 retries up to 3 times with backoff', async () => {
  const stub = stubFetch([
    { status: 503, body: {} },
    { status: 503, body: {} },
    { status: 200, body: { ok: true } },
  ]);
  const started = Date.now();
  const res = await fetchWithRetry('https://worker.example/v1/rooms/x', { method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(stub.calls, 3);
  // Two backoff waits: 500 ms + 1000 ms (Retry-After absent).
  assert.ok(Date.now() - started >= 1400, `expected >=1400 ms backoff, got ${Date.now() - started}`);
});

test('GET on 503 gives up after 3 attempts and returns the last response', async () => {
  const stub = stubFetch([{ status: 503, body: {} }]);
  const res = await fetchWithRetry('https://worker.example/v1/rooms/x', { method: 'GET' });
  assert.equal(res.status, 503);
  assert.equal(stub.calls, 3);
});

test('GET on 404 / 400 / 403 is never retried', async () => {
  for (const status of [400, 403, 404, 409]) {
    const stub = stubFetch([{ status, body: { error: 'nope' } }]);
    const res = await fetchWithRetry('https://worker.example/v1/rooms/x', { method: 'GET' });
    assert.equal(res.status, status);
    assert.equal(stub.calls, 1, `status ${status} must be attempted once`);
  }
});

test('GET honours Retry-After (seconds) over the exponential backoff', async () => {
  const stub = stubFetch([
    { status: 429, body: {}, headers: { 'Retry-After': '1' } },
    { status: 200, body: { ok: true } },
  ]);
  const started = Date.now();
  const res = await fetchWithRetry('https://worker.example/v1/rooms/x', { method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(stub.calls, 2);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 5000, `expected ~1 s Retry-After wait, got ${elapsed} ms`);
});

test('retryDelayMs: exponential 500 ms → 5 s cap; Retry-After wins', () => {
  assert.equal(retryDelayMs(1, null), 500);
  assert.equal(retryDelayMs(2, null), 1000);
  assert.equal(retryDelayMs(3, null), 2000);
  assert.equal(retryDelayMs(5, null), 5000);
  assert.equal(retryDelayMs(10, null), 5000);
  const fake = { headers: { get: () => '2' } };
  assert.equal(retryDelayMs(1, fake), 2000);
  const bad = { headers: { get: () => 'garbage' } };
  assert.equal(retryDelayMs(1, bad), 500);
});

test('POST without a key is attempted exactly once on a 500', async () => {
  const stub = stubFetch([{ status: 500, body: {} }]);
  const res = await fetchWithRetry(
    'https://worker.example/v1/rooms/x/start',
    { method: 'POST', body: '{}' },
  );
  assert.equal(res.status, 500);
  assert.equal(stub.calls, 1);
});

test('POST with a key retries under the same rules and reuses the SAME key on every attempt', async () => {
  const stub = stubFetch([
    { status: 500, body: {} },
    { status: 500, body: {} },
    { status: 200, body: { ok: true } },
  ]);
  const res = await fetchWithRetry(
    'https://worker.example/v1/rooms/x/join',
    { method: 'POST', body: '{}' },
    { idempotencyKey: '11111111-1111-4111-8111-111111111111' },
  );
  assert.equal(res.status, 200);
  assert.equal(stub.calls, 3);
  for (const headers of stub.seenHeaders) {
    assert.equal(headers.get('Idempotency-Key'), '11111111-1111-4111-8111-111111111111');
  }
});

test('POST with a key sends the Idempotency-Key header on the first attempt too', async () => {
  const stub = stubFetch([{ status: 200, body: { ok: true } }]);
  await fetchWithRetry(
    'https://worker.example/v1/rooms/x/join',
    { method: 'POST', body: '{}' },
    { idempotencyKey: '22222222-2222-4222-8222-222222222222' },
  );
  assert.equal(stub.seenHeaders[0]?.get('Idempotency-Key'), '22222222-2222-4222-8222-222222222222');
});

test('POST without a key sends no Idempotency-Key header', async () => {
  const stub = stubFetch([{ status: 200, body: { ok: true } }]);
  await fetchWithRetry('https://worker.example/v1/rooms/x/start', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(stub.seenHeaders[0]?.get('Idempotency-Key'), null);
});

test('a network throw is retried for GET (like a 503) and rethrown after 3 attempts', async () => {
  const stub = stubFetch([new Error('network down')]);
  await assert.rejects(
    fetchWithRetry('https://worker.example/v1/rooms/x', { method: 'GET' }),
    /network down/,
  );
  assert.equal(stub.calls, 3);
});

test('a network throw on an unkeyed POST throws after one attempt', async () => {
  const stub = stubFetch([new Error('network down')]);
  await assert.rejects(
    fetchWithRetry(
      'https://worker.example/v1/rooms/x/start',
      { method: 'POST', body: '{}' },
    ),
    /network down/,
  );
  assert.equal(stub.calls, 1);
});

test('isRetryableStatus matches the spec set', () => {
  for (const s of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(s), true);
  for (const s of [200, 400, 403, 404, 409]) assert.equal(isRetryableStatus(s), false);
});
