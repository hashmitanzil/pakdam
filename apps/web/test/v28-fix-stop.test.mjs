import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const logic = await import('../src/components/hud/play-map-logic.ts');
const {
  shouldWatchLocation,
  gpsNoFixNotice,
  GPS_NO_FIX_WAIT_MS,
  GPS_NO_FIX_NOTICE,
} = logic;

/**
 * v28-fix-stop.test.mjs — client fix-stop for the DO cap (Meera).
 *
 * CAUSE (2026-11-22, founder got the 90% DO email): a phone left on
 * the play screen sends ~1 GPS fix/s (~86,400/day) because the watcher
 * in play/page.tsx runs while the page is open — `mode === 'live'` is
 * the room mode, not the match phase — and the geolocation.ts header
 * claims "Location stops when the tab hides" while `watchLocation`
 * implements no such pause. Heartbeats (30 s, websocket.ts) also keep
 * firing while hidden.
 *
 * FIX REQUIREMENT: the watcher runs only while the match is live AND
 * the tab is visible; it stops on terminal phase and pauses while
 * hidden, resuming on visible. The seat is NOT lost by pausing:
 * live, the socket already reports `player.suspended` ('tab-hidden')
 * on hide (websocket.ts) and the DO exempts suspended seats from the
 * (4a) missing-fix ejection, which runs in ACTIVE only; a fix on
 * return resumes the seat (`location.update` resumes a suspended
 * seat, room-do.ts). Demo: the page's (4a) check freezes while
 * hidden. A missing dot with no explanation is the current behaviour
 * when GPS never delivers — after 15 s with no fix the player gets a
 * plain notice instead of silent nothing.
 */

test('shouldWatchLocation: ACTIVE + visible → watch', () => {
  assert.equal(shouldWatchLocation('ACTIVE', false), true);
});

test('shouldWatchLocation: HEAD_START + visible → watch', () => {
  assert.equal(shouldWatchLocation('HEAD_START', false), true);
});

test('shouldWatchLocation: SAFETY_PAUSED + visible → watch (fixes resume the game)', () => {
  assert.equal(shouldWatchLocation('SAFETY_PAUSED', false), true);
});

test('shouldWatchLocation: every terminal phase → stop, even when visible', () => {
  for (const phase of ['COMPLETED', 'CANCELLED', 'ABANDONED', 'EXPIRED']) {
    assert.equal(shouldWatchLocation(phase, false), false, phase);
  }
});

test('shouldWatchLocation: RESOLVING → stop (the match is over)', () => {
  assert.equal(shouldWatchLocation('RESOLVING', false), false);
});

test('shouldWatchLocation: LOBBY → stop (no match running)', () => {
  assert.equal(shouldWatchLocation('LOBBY', false), false);
});

test('shouldWatchLocation: hidden tab → pause, in every live phase', () => {
  for (const phase of ['ACTIVE', 'HEAD_START', 'SAFETY_PAUSED']) {
    assert.equal(shouldWatchLocation(phase, true), false, phase);
  }
});

test('gpsNoFixNotice: no fix after 15 s → the plain waiting copy', () => {
  assert.equal(GPS_NO_FIX_WAIT_MS, 15_000);
  assert.equal(
    GPS_NO_FIX_NOTICE,
    'Waiting for GPS — no fix yet. Your dot appears once your phone reports a location.',
  );
  assert.equal(gpsNoFixNotice(true, 16_000), GPS_NO_FIX_NOTICE);
});

test('gpsNoFixNotice: no fix yet but under 15 s → silent (GPS may still arrive)', () => {
  assert.equal(gpsNoFixNotice(true, 5_000), null);
});

test('gpsNoFixNotice: a fix exists → no notice, however long the page has been open', () => {
  assert.equal(gpsNoFixNotice(false, 120_000), null);
});
