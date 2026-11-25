/**
 * v34 (Diya round 2 — self-confirm freshness chain, R2-4/R2-5/R2-6/
 * R2-7/R2-8/R2-14): the founder's "tap hunter → tap OK → nothing
 * happens" had more ingredients than the error swallow:
 *
 * - R2-4: a stationary phone's OS watch may never call back, so the
 *   server purges mem.latestFix after 30 s and the OK tap fails
 *   STALE_LOCATION. Both watch effects (play + catch) now re-send
 *   the last SENT fix every 5 s, re-stamped with now (a heartbeat,
 *   not a new observation).
 * - R2-5: the DO's mem.latestFix is memory-only and starts empty
 *   after an eviction/wake. Both pages re-seed the last-sent fix
 *   on every (re)connect while ACTIVE.
 * - R2-6: a device clock >60 s behind makes every fix look stale
 *   to the server, silently. `detectClockSkew` compares the
 *   device clock against the DO's `serverTs` on every envelope and
 *   warns past 30 s.
 * - R2-7: catch-page GPS denial was silent — the watch now has an
 *   error handler with a notice + "Try again" (and it never
 *   suspends the seat: the P0-1 harbour).
 * - R2-8: a suspended-Hunter rejection left a 120 s dead window
 *   with no guidance — the notice now names the wait.
 * - R2-14: the confirm timeout was 10 s while the error window is
 *   15 s — a rejection at 11–15 s was dropped. Both are 15 s now.
 *
 * The pure helper is behaviour-tested; the page wiring is pinned
 * by source checks (these are wiring pins, not behaviour proofs —
 * only a real phone/CI run proves the chain end to end).
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const { detectClockSkew, clockSkewNotice, CLOCK_SKEW_WARN_MS } = await import(
  '../src/lib/clock-skew.ts'
);

const playSrc = readFileSync(
  new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
  'utf8',
);
const catchSrc = readFileSync(
  new URL('../src/app/room/[roomId]/catch/page.tsx', import.meta.url),
  'utf8',
);
const roomStateSrc = readFileSync(
  new URL('../src/components/match/useRoomState.ts', import.meta.url),
  'utf8',
);

test('v34 R2-6: no skew when the clocks agree, or the timestamp is missing/bad', () => {
  assert.equal(CLOCK_SKEW_WARN_MS, 30_000);
  const now = Date.now();
  assert.equal(detectClockSkew(new Date(now).toISOString(), now), null);
  assert.equal(detectClockSkew(new Date(now - 10_000).toISOString(), now), null);
  assert.equal(detectClockSkew(undefined, now), null);
  assert.equal(detectClockSkew('not-a-date', now), null);
});

test('v34 R2-6: skew warns past 30 s in either direction, not at exactly 30 s', () => {
  const now = Date.now();
  assert.equal(detectClockSkew(new Date(now - 30_000).toISOString(), now), null);
  // Server 30_001 ms in the past = device 30_001 ms AHEAD → +30_001.
  assert.equal(detectClockSkew(new Date(now - 30_001).toISOString(), now), 30_001);
  assert.equal(detectClockSkew(new Date(now - 90_000).toISOString(), now), 90_000);
  // Server 45_000 ms in the future = device 45_000 ms BEHIND → −45_000.
  assert.equal(detectClockSkew(new Date(now + 45_000).toISOString(), now), -45_000);
});

test('v34 R2-6: the notice names the direction and the minutes in plain words', () => {
  assert.match(clockSkewNotice(-90_000), /2 minutes behind/);
  assert.match(clockSkewNotice(45_000), /1 minute ahead/);
  assert.match(clockSkewNotice(-61_000), /automatic date & time/);
});

test('v34 R2-6: useRoomState detects skew from the envelope serverTs', () => {
  assert.ok(
    roomStateSrc.includes('detectClockSkew(envelope.serverTs'),
    'useRoomState must compare the device clock against the envelope serverTs',
  );
  assert.ok(
    roomStateSrc.includes('clockSkewMs'),
    'useRoomState must expose clockSkewMs to the pages',
  );
  assert.ok(
    playSrc.includes('clockSkewNotice(clockSkewMs)'),
    'the play page must render the skew banner',
  );
  assert.ok(
    catchSrc.includes('clockSkewNotice(clockSkewMs)'),
    'the catch page must render the skew banner',
  );
});

test('v34 R2-4: both watch effects re-send the last sent fix on a 5 s timer', () => {
  for (const [name, src] of [
    ['play', playSrc],
    ['catch', catchSrc],
  ]) {
    assert.ok(
      src.includes('resendTimer = setInterval'),
      `${name} page must run the re-send timer`,
    );
    assert.ok(
      src.includes('timestampMs: Date.now()'),
      `${name} page must re-stamp the re-sent fix with now`,
    );
  }
});

test('v34 R2-5: both pages re-seed the last-sent fix on (re)connect', () => {
  for (const [name, src] of [
    ['play', playSrc],
    ['catch', catchSrc],
  ]) {
    assert.ok(
      src.includes('R2-5'),
      `${name} page must carry the re-seed effect`,
    );
  }
});

test('v34 R2-7: the catch-page watch has an error handler and never suspends', () => {
  assert.ok(
    catchSrc.includes('watchLocation(sendFix, onError)'),
    'the catch watch must pass an onError handler',
  );
  assert.ok(
    catchSrc.includes("Location is off or blocked"),
    'a denial must show a plain-words notice',
  );
  assert.ok(
    catchSrc.includes('setCatchGpsRetryNonce'),
    'the denial notice must offer a retry',
  );
  assert.ok(
    !catchSrc.includes('recordPlayerSuspension'),
    'the catch page must never suspend (P0-1 harbour)',
  );
});

test('v34 R2-8/R2-14: suspended-Hunter guidance + 15 s confirm timeout', () => {
  assert.ok(
    catchSrc.includes('up to 2 minutes for this tag request to expire'),
    'a suspended-Hunter rejection must name the 2-minute wait',
  );
  assert.ok(
    catchSrc.includes("You can't pick another hunter while this request is open"),
    'the notice must say no other Hunter can be picked meanwhile',
  );
  assert.ok(
    catchSrc.includes('}, 15_000);'),
    'the confirm timeout must match the 15 s error window',
  );
  assert.ok(
    !catchSrc.includes('}, 10_000);'),
    'no 10 s confirm timeout may survive',
  );
});
