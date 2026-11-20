import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { isPingDue, nextPingAtMs, dueRunnerIds, dueHunterIds } = await import(
  '../src/pings.ts'
);

// Head start 180 s, ping interval 60 s. Match starts (HEAD_START) at T0;
// ACTIVE starts at T0 + 180_000.
const T0 = 1_780_000_000_000;
const STARTED_AT = T0;
const ACTIVE_AT = T0 + 180_000;
const INTERVAL = 60;
const FIX = { lat: 23.35, lng: 85.33, accuracyMeters: 10, timestampMs: T0 };

test('first ping is NOT due during HEAD_START even when the interval elapsed since match start', () => {
  // 120 s into the head start: two whole intervals since startedAt.
  assert.equal(isPingDue(null, STARTED_AT, INTERVAL, T0 + 120_000, ACTIVE_AT), false);
  // One second before ACTIVE starts: still not due.
  assert.equal(isPingDue(null, STARTED_AT, INTERVAL, ACTIVE_AT - 1_000, ACTIVE_AT), false);
});

test('first ping is NOT due the instant ACTIVE begins — it needs a full interval of ACTIVE', () => {
  assert.equal(isPingDue(null, STARTED_AT, INTERVAL, ACTIVE_AT, ACTIVE_AT), false);
  assert.equal(isPingDue(null, STARTED_AT, INTERVAL, ACTIVE_AT + 59_000, ACTIVE_AT), false);
  assert.equal(isPingDue(null, STARTED_AT, INTERVAL, ACTIVE_AT + 60_000, ACTIVE_AT), true);
});

test('nextPingAtMs anchors the first ping one interval after ACTIVE starts', () => {
  assert.equal(nextPingAtMs(null, STARTED_AT, INTERVAL, ACTIVE_AT), ACTIVE_AT + 60_000);
  // After a ping lands, the next one anchors on the delivery, not the head start.
  assert.equal(
    nextPingAtMs(ACTIVE_AT + 60_000, STARTED_AT, INTERVAL, ACTIVE_AT),
    ACTIVE_AT + 120_000,
  );
});

test('dueRunnerIds / dueHunterIds return nobody during HEAD_START', () => {
  const base = {
    fixes: { r1: FIX, h1: FIX },
    lastPingAtMs: {},
    startedAtMs: STARTED_AT,
    intervalSeconds: INTERVAL,
    nowMs: T0 + 120_000,
    activeAtMs: ACTIVE_AT,
  };
  assert.deepEqual(dueRunnerIds({ ...base, freeRunnerIds: ['r1'] }), []);
  assert.deepEqual(dueHunterIds({ ...base, freeHunterIds: ['h1'] }), []);
});

test('dueRunnerIds / dueHunterIds fire one interval after ACTIVE starts', () => {
  const base = {
    fixes: { r1: FIX, h1: FIX },
    lastPingAtMs: {},
    startedAtMs: STARTED_AT,
    intervalSeconds: INTERVAL,
    nowMs: ACTIVE_AT + 60_000,
    activeAtMs: ACTIVE_AT,
  };
  assert.deepEqual(dueRunnerIds({ ...base, freeRunnerIds: ['r1'] }), ['r1']);
  assert.deepEqual(dueHunterIds({ ...base, freeHunterIds: ['h1'] }), ['h1']);
});

test('omitting activeAtMs keeps the old behaviour (head start of 0)', () => {
  assert.equal(isPingDue(null, STARTED_AT, INTERVAL, STARTED_AT + 60_000), true);
  assert.equal(nextPingAtMs(null, STARTED_AT, INTERVAL), STARTED_AT + 60_000);
});
