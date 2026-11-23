/**
 * v30-followup.test.mjs — Diya's adversarial review of the first v30
 * build: five items the first builders did not cover.
 *
 * A. GPS watcher never started (BROKEN, live): the no-fix notice ran
 *    off `watchStartedAtMsRef`, stuck at null when the play page
 *    mounted hidden — elapsed forced to 0, notice never fired.
 * B. "Resume sharing" fuse (BROKEN, demo): resuming a gps-denied seat
 *    sets connected + lastFixAt, so the (4a) check ejects it 30 s later.
 * C. Re-centre fallback masks a dead watcher (AT RISK, live): the zone
 *    fallback was a tiny footnote under the buttons.
 * D. Demo never records who paused (PRODUCT DEFECT, demo): the sheet
 *    renders "Match paused — clock frozen." and the CI regex
 *    /Match paused by Teo — clock frozen\./ can never match.
 * E. ErrorBoundary copy drift (v29-internal): spec expects 'The game
 *    is still running — only the map crashed.' + button 'Retry'.
 *
 * Pure helpers are tested directly; React page wiring is pinned by
 * source assertions (the precedent in v30-gps-dot.test.mjs — the page
 * needs React).
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const {
  GPS_NO_FIX_NOTICE,
  GPS_NO_FIX_WAIT_MS,
  GPS_WATCH_NEVER_STARTED_NOTICE,
  RECENTRE_NO_FIX_DEFAULT_PILL,
  RECENTRE_NO_FIX_ZONE_PILL,
  gpsNoFixNoticeForWatch,
} = await import('../src/components/hud/play-map-logic.ts');

const store = await import('../src/lib/demo-store.ts');
const {
  createRoom,
  demoRoomChangeKey,
  safetyPauseDemo,
  safetyResumeDemo,
  startDemoMatch,
  tickDemoRoom,
} = store;
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

const pageSrc = readFileSync(
  new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
  'utf8',
);
const playMapSrc = readFileSync(
  new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
  'utf8',
);
const errorBoundarySrc = readFileSync(
  new URL('../src/components/ErrorBoundary.tsx', import.meta.url),
  'utf8',
);
const useRoomStateSrc = readFileSync(
  new URL('../src/components/match/useRoomState.ts', import.meta.url),
  'utf8',
);
const demoStoreSrc = readFileSync(
  new URL('../src/lib/demo-store.ts', import.meta.url),
  'utf8',
);

const NOW = 1_780_000_000_000;

// ---------------------------------------------------------------------------
// A. No-fix notice off the watchable clock, not the watch clock.
// ---------------------------------------------------------------------------

test('A: never-started watch fires the notice 15 s after the match became watchable', () => {
  const watchableSince = NOW - 15_000;
  const notice = gpsNoFixNoticeForWatch(true, NOW, null, watchableSince);
  assert.ok(notice, '15 s in a watchable phase with no fix and no watch must name it');
  assert.match(notice, /GPS watcher never started/);
  assert.match(notice, /tab was hidden \/ page loaded in background/);
  assert.equal(GPS_WATCH_NEVER_STARTED_NOTICE, notice);
});

test('A: never-started watch stays silent before 15 s, and silent outside watchable phases', () => {
  assert.equal(gpsNoFixNoticeForWatch(true, NOW, null, NOW - 14_999), null);
  // Not in a watchable phase at all (LOBBY / before start): no notice,
  // however long the page has been open.
  assert.equal(gpsNoFixNoticeForWatch(true, NOW, null, null), null);
  assert.equal(gpsNoFixNoticeForWatch(true, NOW + 3_600_000, null, null), null);
});

test('A: a started watch still uses the watch clock; a fix silences both clocks', () => {
  assert.equal(GPS_NO_FIX_WAIT_MS, 15_000);
  // Watch started 14 s ago, match watchable for an hour: the watch
  // clock rules — GPS may still arrive, no notice yet.
  assert.equal(gpsNoFixNoticeForWatch(true, NOW, NOW - 14_000, NOW - 3_600_000), null);
  // Watch started 15 s ago: the plain waiting notice (not the
  // never-started copy — the watch WAS attempted).
  assert.equal(gpsNoFixNoticeForWatch(true, NOW, NOW - 15_000, NOW - 3_600_000), GPS_NO_FIX_NOTICE);
  // A fix silences everything, started watch or not.
  assert.equal(gpsNoFixNoticeForWatch(false, NOW, NOW - 60_000, NOW - 60_000), null);
  assert.equal(gpsNoFixNoticeForWatch(false, NOW, null, NOW - 60_000), null);
});

test('A (pin): the play page drives the notice off watchableSinceRef, never off a stuck-at-0 watch stamp', () => {
  assert.ok(
    pageSrc.includes('gpsNoFixNoticeForWatch('),
    'shownFixNotice must call gpsNoFixNoticeForWatch',
  );
  assert.ok(
    pageSrc.includes('watchableSinceRef.current'),
    'the page must track when the match entered a watchable phase',
  );
  // The pre-fix shape — elapsed forced to 0 when the watch never
  // started — must be gone.
  assert.ok(
    !pageSrc.includes('watchStartedAtMsRef.current === null\n        ? 0'),
    'the stuck-at-0 elapsed must be gone',
  );
  // The watchable baseline is set on entry to HEAD_START / ACTIVE /
  // SAFETY_PAUSED and cleared on leaving them (no false notice in
  // LOBBY or before start).
  assert.ok(
    pageSrc.includes("phase === 'HEAD_START' || phase === 'ACTIVE' || phase === 'SAFETY_PAUSED'"),
    'the watchable baseline must cover exactly the watchable phases',
  );
  assert.ok(
    pageSrc.includes('watchableSinceRef.current = Date.now();'),
    'the baseline must be stamped on entry to a watchable phase',
  );
});

// ---------------------------------------------------------------------------
// B. "Resume sharing" hidden while GPS is denied (demo).
// ---------------------------------------------------------------------------

test('B (pin): Resume sharing is hidden while gpsDenied and guarded in the handler', () => {
  // The button renders only when NOT gps-denied — the page-local flag
  // is the gate (the suspension reason is not stored on the player).
  assert.ok(
    pageSrc.includes("mode === 'demo' && !gpsDenied"),
    'the Resume sharing button must be gated on !gpsDenied',
  );
  // Defence in depth: the handler itself refuses while denied, so a
  // resume can never start the 30 s ejection fuse on a dead watch.
  assert.ok(
    pageSrc.includes('if (gpsDenied) return;'),
    'handleResumeSharing must refuse while gpsDenied',
  );
  // The old unconditional shape must be gone: the button used to
  // render for every demo suspension.
  assert.ok(
    !pageSrc.includes("mode === 'demo' ? (\n            <button\n              type=\"button\"\n              onClick={handleResumeSharing}"),
    'the unconditional demo-only Resume button must be gone',
  );
});

// ---------------------------------------------------------------------------
// C. Re-centre fallback is a loud pill, not a footnote.
// ---------------------------------------------------------------------------

test('C: fallback pill copy is exact', () => {
  assert.equal(RECENTRE_NO_FIX_ZONE_PILL, 'No GPS fix — showing zone centre');
  assert.equal(RECENTRE_NO_FIX_DEFAULT_PILL, 'No GPS fix — showing Ranchi');
});

test('C (pin): PlayMap renders the fallback as a loud top pill and never as the footnote', () => {
  // Loud: top-left, amber border/text, role=status, full-width pill.
  assert.ok(
    playMapSrc.includes('role="status"'),
    'the fallback pill must carry role=status',
  );
  assert.ok(
    playMapSrc.includes('RECENTRE_NO_FIX_ZONE_PILL'),
    'the zone fallback must use the loud-pill copy',
  );
  assert.ok(
    playMapSrc.includes('RECENTRE_NO_FIX_DEFAULT_PILL'),
    'the Ranchi fallback must use the loud-pill copy',
  );
  assert.ok(
    playMapSrc.includes("setRecentreFallback('zone')"),
    'centreOn must set the zone fallback state',
  );
  assert.ok(
    playMapSrc.includes("setRecentreFallback('default')"),
    'centreOn must set the default fallback state',
  );
  // The footnote is gone for the fallback: centreOn must not set the
  // small note for the zone/default sources any more (a stale fix
  // still uses the note — recentreStaleNote stays).
  assert.ok(
    !playMapSrc.includes('setRecentreNote(RECENTRE_ZONE_FALLBACK_NOTE)'),
    'the zone fallback must not be a footnote any more',
  );
  assert.ok(
    !playMapSrc.includes('setRecentreNote(RECENTRE_DEFAULT_NOTE)'),
    'the default fallback must not be a footnote any more',
  );
  assert.ok(
    playMapSrc.includes('setRecentreNote(recentreStaleNote(ageS))'),
    'a stale fix still gets its small note',
  );
  // The pill clears when GPS comes back, on Retry, and on a fresh map.
  assert.ok(
    playMapSrc.includes('setRecentreFallback(null)'),
    'the fallback pill must be clearable',
  );
});

// ---------------------------------------------------------------------------
// D. Demo records who paused.
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  ...DEFAULT_ROOM_CONFIG,
  hostOnSiteConfirmed: true,
  headStartSeconds: 0,
  durationSeconds: 600,
  zone: {
    boundary: [
      { lat: 23.3441, lng: 85.3096 },
      { lat: 23.3441, lng: 85.3196 },
      { lat: 23.3541, lng: 85.3146 },
    ],
    shrinkPhases: [],
  },
};

/** A started 3-player demo match: Teo (host) + Ana + Ben, ACTIVE. */
function threePlayerMatch() {
  const demo = createRoom('Teo', TEST_CONFIG);
  const host = demo.players[0];
  const joined = (offsetMs) =>
    new Date(Date.parse(host.joinedAt) + offsetMs).toISOString();
  demo.players.push(
    {
      ...host,
      playerId: 'ana-player-id',
      displayName: 'Ana',
      isHost: false,
      isReady: true,
      briefingConfirmed: true,
      joinedAt: joined(1000),
    },
    {
      ...host,
      playerId: 'ben-player-id',
      displayName: 'Ben',
      isHost: false,
      isReady: true,
      briefingConfirmed: true,
      joinedAt: joined(2000),
    },
  );
  startDemoMatch(demo);
  const startedAtMs = Date.parse(demo.room.startedAt);
  tickDemoRoom(demo, startedAtMs + 1000); // head start 0 → ACTIVE
  assert.equal(demo.room.phase, 'ACTIVE');
  return { demo, host };
}

test('D: safetyPauseDemo records the pauser; resume forgets them', () => {
  const { demo, host } = threePlayerMatch();
  assert.equal(demo.pausedByPlayerId, null, 'nobody has paused yet');
  const keyBefore = demoRoomChangeKey(demo);
  safetyPauseDemo(demo, host.playerId);
  assert.equal(demo.room.phase, 'SAFETY_PAUSED');
  assert.equal(demo.pausedByPlayerId, host.playerId, 'the pauser must be recorded');
  assert.notEqual(
    demoRoomChangeKey(demo),
    keyBefore,
    'the change key must move on pause, or a poll would skip the pauser',
  );
  assert.ok(
    demoRoomChangeKey(demo).includes(host.playerId),
    'the change key must carry the pauser id',
  );
  safetyResumeDemo(demo);
  assert.equal(demo.room.phase, 'ACTIVE', 'resume returns to pausedFrom');
  assert.equal(demo.pausedByPlayerId, null, 'resume forgets the pauser');
});

test('D: a pause outside a running phase records nobody', () => {
  const demo = createRoom('Teo', TEST_CONFIG);
  const host = demo.players[0];
  safetyPauseDemo(demo, host.playerId);
  assert.equal(demo.room.phase, 'LOBBY', 'a LOBBY pause is a no-op');
  assert.equal(demo.pausedByPlayerId, null, 'a no-op pause must not record a pauser');
});

test('D (pin): demoSafety returns the recorded pauser (live path untouched)', () => {
  assert.ok(
    useRoomStateSrc.includes('pausedBy: demo.pausedByPlayerId ?? null'),
    'demoSafety must read the demo pauser, not hardcode null',
  );
  // IDLE_SAFETY still legitimately carries `pausedBy: null` — only
  // demoSafety's hardcoded null must be gone.
  const demoSafetyFn = useRoomStateSrc.slice(
    useRoomStateSrc.indexOf('function demoSafety'),
    useRoomStateSrc.indexOf('function demoSafety') + 400,
  );
  assert.ok(
    !demoSafetyFn.includes('pausedBy: null'),
    'demoSafety must not hardcode pausedBy: null',
  );
  assert.ok(
    demoStoreSrc.includes('demo.pausedByPlayerId = playerId;'),
    'safetyPauseDemo must record its playerId argument',
  );
  assert.ok(
    !demoStoreSrc.includes('safetyPauseDemo(demo: DemoRoom, _playerId: string)'),
    'the explicitly-unused _playerId must be gone',
  );
});

// ---------------------------------------------------------------------------
// E. ErrorBoundary copy matches the spec exactly.
// ---------------------------------------------------------------------------

test('E: map fallback copy and button match error-boundary.spec.ts:32 exactly', () => {
  assert.ok(
    errorBoundarySrc.includes('The game is still running — only the map crashed.'),
    'the map fallback must use the spec copy',
  );
  assert.ok(
    !errorBoundarySrc.includes('The game itself is still running'),
    'the drifted copy must be gone',
  );
  assert.ok(
    !errorBoundarySrc.includes('Retry map'),
    'the drifted button name must be gone from the boundary',
  );
  // The Retry button itself: exact 'Retry' text in the map branch.
  assert.match(errorBoundarySrc, />\s*Retry\s*<\/button>/);
});
