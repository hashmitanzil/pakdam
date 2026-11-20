import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { checkCatchProximity } = await import('../src/catch.ts');

const NOW = 1_000_000;
const fix = (overrides = {}) => ({
  lat: 23.35,
  lng: 85.33,
  accuracyMeters: 8,
  timestampMs: NOW,
  ...overrides,
});

test('catch proximity: phones ~5 m apart can tag', () => {
  const result = checkCatchProximity({
    hunterFix: fix(),
    runnerFix: fix({ lat: 23.35004 }),
    nowMs: NOW,
  });
  assert.deepEqual(result, { ok: true, value: undefined });
});

test('catch proximity: phones ~50 m apart can tag (limit is 100 m)', () => {
  const result = checkCatchProximity({
    hunterFix: fix(),
    runnerFix: fix({ lat: 23.35045 }),
    nowMs: NOW,
  });
  assert.equal(result.ok, true);
});

test('catch proximity: a missing fix on either side waits for GPS', () => {
  assert.deepEqual(
    checkCatchProximity({ hunterFix: null, runnerFix: fix(), nowMs: NOW }),
    {
      ok: false,
      code: 'STALE_LOCATION',
      reason: 'Waiting for GPS — move closer and try again.',
    },
  );
  assert.deepEqual(
    checkCatchProximity({ hunterFix: fix(), runnerFix: null, nowMs: NOW }),
    {
      ok: false,
      code: 'STALE_LOCATION',
      reason: 'Waiting for GPS — move closer and try again.',
    },
  );
});

test('catch proximity: a fix older than 60 s waits for GPS', () => {
  const result = checkCatchProximity({
    hunterFix: fix({ timestampMs: NOW - 61_000 }),
    runnerFix: fix(),
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE_LOCATION');
});

test('catch proximity: phones in different cities are FORBIDDEN, not a tag', () => {
  const result = checkCatchProximity({
    hunterFix: fix(),
    runnerFix: fix({ lat: 25.5941, lng: 85.1376, timestampMs: NOW }),
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FORBIDDEN');
  assert.match(result.reason, /too far apart/);
});
