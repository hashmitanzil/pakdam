import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { resumeMatch, shiftDisconnectDeadlines } = await import('../src/safety.ts');

// Engine safety — resume shifts the 30 s return windows with the
// pause (v29 fix round, F4). A deadline set before a pause is
// extended by exactly the paused duration.
const T0 = 1_780_000_000_000;

test('resumeMatch shifts disconnectDeadlineMs forward by the paused duration', () => {
  const r = resumeMatch({
    phase: 'SAFETY_PAUSED',
    pausedFrom: 'ACTIVE',
    pausedAt: new Date(T0 + 10_000).toISOString(),
    startedAt: new Date(T0).toISOString(),
    endsAt: new Date(T0 + 3_600_000).toISOString(),
    nowMs: T0 + 40_000,
    disconnectDeadlineMs: { r1: T0 + 35_000, hu1: T0 + 50_000 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.phase, 'ACTIVE');
  assert.equal(r.startedAt, new Date(T0 + 30_000).toISOString(), 'startedAt shifts by the 30 s pause');
  assert.equal(r.endsAt, new Date(T0 + 3_630_000).toISOString());
  assert.deepEqual(r.disconnectDeadlineMs, { r1: T0 + 65_000, hu1: T0 + 80_000 });
});

test('resumeMatch without disconnectDeadlineMs returns none (old callers unaffected)', () => {
  const r = resumeMatch({
    phase: 'SAFETY_PAUSED',
    pausedFrom: 'ACTIVE',
    pausedAt: new Date(T0 + 10_000).toISOString(),
    startedAt: new Date(T0).toISOString(),
    endsAt: new Date(T0 + 3_600_000).toISOString(),
    nowMs: T0 + 40_000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.disconnectDeadlineMs, undefined);
});

test('shiftDisconnectDeadlines shifts every deadline and leaves the input untouched', () => {
  const input = { r1: T0 + 35_000 };
  const out = shiftDisconnectDeadlines(input, 30_000);
  assert.deepEqual(out, { r1: T0 + 65_000 });
  assert.deepEqual(input, { r1: T0 + 35_000 });
});
