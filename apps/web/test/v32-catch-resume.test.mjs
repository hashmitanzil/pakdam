/**
 * v32 catch-resume tests (Arjun) — the v31 CI catch failures, pinned at
 * the demo-store level.
 *
 * ROOT CAUSE (all 8 tests in this cluster): in the headless multi-page
 * setup only one tab is visible — creating the guest pages backgrounds
 * the earlier tabs, and `useRoomState` suspends each backgrounded seat
 * ('tab-hidden'); the one visible tab suspends itself on GPS denial
 * (no permission granted). A catch claim (`demo-store requestCatch`)
 * rejects a suspended Hunter AND a suspended Runner, so a claim or a
 * self-confirm across two seats could never land while both seats were
 * suspended: catch-nav 178/220/270/281, catch-results 65/88/136,
 * brutal-phone 20. The product behaviour is CORRECT (the server gate
 * is the same) — the fix is test-side: the catch page is the
 * suspension-safe harbour (P0-1 resume on arrival, no GPS watcher),
 * plus emulated GPS at the zone centre — which on its own delivers
 * exactly ONE static fix and does NOT keep `lastFixAt` fresh (v32
 * fix round, Diya A1): the (4a) 30 s clock is held off by the 4 s
 * keep-fresh nudge loop (`startCentreFixKeepFresh` in e2e/helpers.ts)
 * for the front seat, by suspension-exemption for backgrounded seats,
 * and by the harbour for seats on the catch page (see e2e/helpers.ts
 * `resumeSeatViaCatchPage` / `newCentredDemoContext`).
 *
 * These tests pin the mechanism the spec fix relies on:
 *  - a suspended Runner blocks the Hunter's claim; resuming the
 *    Runner (the P0-1 arrival resume) restores the claim;
 *  - a suspended Hunter blocks a claim AND a Runner self-confirm;
 *    resuming the Hunter restores both;
 *  - the catch page itself cannot re-suspend the seat (it mounts the
 *    P0-1 resume and runs no GPS watcher);
 *  - the three specs harbour both seats before any claim/confirm.
 *
 * Harness mirrors v30-happy-path.test.mjs (demo store direct, no DOM,
 * no network). Timer hygiene: a host suspension schedules one 30 s
 * wake-up timer, so every test that suspends the host ends with a
 * resume (which clears it).
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const store = await import('../src/lib/demo-store.ts');
const {
  createRoom,
  recordPlayerSuspension,
  requestCatch,
  resumePlayerOnCatchPageArrival,
  selfConfirmCatch,
  startDemoMatch,
  tickDemoRoom,
} = store;
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

const E2E = new URL('./../e2e/', import.meta.url);
const SRC = new URL('./../src/', import.meta.url);

function readE2E(name) {
  return readFileSync(new URL(name, E2E), 'utf8');
}

function readSrc(path) {
  return readFileSync(new URL(path, SRC), 'utf8');
}

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

/** A demo lobby room with host Teo + Ana (joined first) + Ben. */
function threePlayerLobby() {
  const demo = createRoom('Teo', TEST_CONFIG);
  const host = demo.players[0];
  const joined = (offsetMs) =>
    new Date(Date.parse(host.joinedAt) + offsetMs).toISOString();
  const ana = {
    ...host,
    playerId: 'ana-player-id',
    displayName: 'Ana',
    isHost: false,
    isReady: false,
    briefingConfirmed: false,
    joinedAt: joined(1000),
  };
  const ben = {
    ...host,
    playerId: 'ben-player-id',
    displayName: 'Ben',
    isHost: false,
    isReady: false,
    briefingConfirmed: false,
    joinedAt: joined(2000),
  };
  demo.players.push(ana, ben);
  return { demo, host, ana, ben };
}

function startMatch(demo) {
  for (const p of demo.players) {
    p.isReady = true;
    p.briefingConfirmed = true;
  }
  startDemoMatch(demo);
  const startedAtMs = Date.parse(demo.room.startedAt);
  tickDemoRoom(demo, startedAtMs + 1000);
  assert.equal(demo.room.phase, 'ACTIVE', 'headStart 0 must reach ACTIVE on the first tick');
  const hunter = demo.players.find((p) => p.matchRole === 'hunter');
  const runners = demo.players.filter((p) => p.matchRole === 'runner');
  assert.ok(hunter, 'the match must draw a hunter');
  assert.ok(runners.length >= 2, 'the match must draw two runners');
  return { hunter, runners };
}

test('v32: a suspended Runner blocks the Hunter claim; the P0-1 arrival resume restores it (catch-nav:178, brutal-phone:20)', () => {
  const { demo } = threePlayerLobby();
  const { hunter, runners } = startMatch(demo);
  const runner = runners[0];
  // The headless multi-page setup: the Runner's tab is backgrounded,
  // so their seat is suspended ('tab-hidden') when the Hunter claims.
  recordPlayerSuspension(demo, runner.playerId, 'tab-hidden');
  assert.equal(runner.connectionState, 'suspended');
  assert.throws(
    () => requestCatch(demo, hunter.playerId, runner.playerId),
    /That player is suspended — wait for them to come back\./,
    'a suspended Runner must reject the claim, not open a claim nobody can confirm',
  );
  assert.equal(
    demo.catches.length,
    0,
    'the rejected claim must leave no dangling claim behind',
  );
  // The Runner mounts the catch page: P0-1 resumes them on arrival.
  assert.equal(
    resumePlayerOnCatchPageArrival(demo, runner.playerId),
    true,
    'catch-page arrival must resume a suspended Runner',
  );
  assert.equal(runner.connectionState, 'connected');
  const { catch: claim } = requestCatch(demo, hunter.playerId, runner.playerId);
  assert.equal(claim.state, 'awaiting-confirmation');
  assert.equal(claim.runnerPlayerId, runner.playerId);
  assert.equal(claim.hunterPlayerId, hunter.playerId);
});

test('v32: a suspended Hunter blocks a claim; resuming them restores it (catch-nav:220, catch-results:65/88/136)', () => {
  const { demo } = threePlayerLobby();
  const { hunter, runners } = startMatch(demo);
  const runner = runners[0];
  // The Hunter's tab is backgrounded too — their seat is suspended
  // when the Runner self-confirms (which creates the claim).
  recordPlayerSuspension(demo, hunter.playerId, 'tab-hidden');
  assert.equal(hunter.connectionState, 'suspended');
  assert.throws(
    () => requestCatch(demo, hunter.playerId, runner.playerId),
    /A suspended or disconnected Hunter cannot tag\./,
    'a suspended Hunter must not open a claim',
  );
  assert.equal(demo.catches.length, 0);
  // The Hunter mounts the catch page: P0-1 resumes them on arrival.
  assert.equal(resumePlayerOnCatchPageArrival(demo, hunter.playerId), true);
  assert.equal(hunter.connectionState, 'connected');
  const { catch: claim } = requestCatch(demo, hunter.playerId, runner.playerId);
  assert.equal(claim.state, 'awaiting-confirmation');
  // Timer hygiene: a host suspension schedules a 30 s wake-up timer;
  // the resume above already cleared it.
});

test('v32: a Runner self-confirm fails while the Hunter is suspended and succeeds once the Hunter resumes (Way 2 shape)', () => {
  const { demo } = threePlayerLobby();
  const { hunter, runners } = startMatch(demo);
  const runner = runners[0];
  recordPlayerSuspension(demo, hunter.playerId, 'tab-hidden');
  assert.throws(
    () => selfConfirmCatch(demo, runner.playerId, hunter.playerId),
    /A suspended or disconnected Hunter cannot tag\./,
    'Way 2 creates its claim through requestCatch, so a suspended Hunter blocks the whole self-confirm',
  );
  assert.equal(demo.catches.length, 0, 'the failed self-confirm must roll its claim back');
  assert.equal(resumePlayerOnCatchPageArrival(demo, hunter.playerId), true);
  const confirmed = selfConfirmCatch(demo, runner.playerId, hunter.playerId);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.runnerPlayerId, runner.playerId);
  assert.equal(confirmed.hunterPlayerId, hunter.playerId);
});

test('v32 (harbour property): the catch page mounts the P0-1 resume and runs no GPS watcher, so it cannot re-suspend the seat', () => {
  const page = readSrc('app/room/[roomId]/catch/page.tsx');
  assert.ok(
    page.includes('resumePlayerOnCatchPageArrival(demo, myPlayerId)'),
    'the catch page must resume the seat on arrival (P0-1) — that is what the e2e harbour relies on',
  );
  // v34 (Kabir item 2 — SUPERSEDES the no-watcher grep below): the
  // catch page now runs a GPS watch so the Runner's fix stays fresh
  // for self-confirm (a frozen fix is STALE_LOCATION >60 s after
  // navigation). The property this pin protects is NOT "no watcher"
  // — it is "the watch cannot re-suspend the seat". The play page's
  // re-suspension lives in a separate effect (F16:
  // recordPlayerSuspension('gps-denied')), which the catch page
  // never had and the new watch does not add: the watch effect only
  // SENDS fixes (sendLocationUpdate / recordPlayerFix) and stops on
  // hide. So the pin asserts the mechanism, not the proxy: no
  // suspension call anywhere on this page.
  assert.ok(
    !page.includes('recordPlayerSuspension'),
    'the catch page must never suspend a seat — its GPS watch only sends fixes, so the P0-1 harbour holds',
  );
  assert.ok(
    page.includes("resumePlayerOnCatchPageArrival"),
    'the resume import must be present',
  );
});

test('v32 (spec pins): the catch helpers harbour both seats before any claim/confirm', () => {
  const catchNav = readE2E('catch-nav.spec.ts');
  const catchResults = readE2E('catch-results.spec.ts');
  const brutal = readE2E('brutal-phone.spec.ts');
  // Way 1 (catch-nav tagRunnerViaFallback): the Runner is harboured
  // before the Hunter opens the catch screen and claims.
  const fallback = catchNav.slice(catchNav.indexOf('async function tagRunnerViaFallback'));
  assert.ok(
    fallback.includes('resumeSeatViaCatchPage(runnerPage, roomId, runnerName)'),
    'tagRunnerViaFallback must harbour the Runner before the Hunter claims them',
  );
  // Way 2 (catch-nav selfConfirmAsRunner): the Hunter is harboured
  // before the Runner confirms, so the claim the confirm creates lands.
  const selfConfirm = catchNav.slice(catchNav.indexOf('async function selfConfirmAsRunner'));
  assert.ok(
    selfConfirm.includes('resumeSeatViaCatchPage(hunterPage, roomId, hunterName)'),
    'selfConfirmAsRunner must harbour the Hunter before the Runner confirms',
  );
  assert.ok(
    selfConfirm.includes('resumeSeatViaCatchPage(runnerPage, roomId, runnerName)'),
    'selfConfirmAsRunner must harbour the Runner before the Runner confirms',
  );
  // catch-results catchRunner: both seats harboured before the confirm.
  const catchRunner = catchResults.slice(catchResults.indexOf('async function catchRunner'));
  assert.ok(
    catchRunner.includes('resumeSeatViaCatchPage(hunterPage, roomId, hunterName)'),
    'catchRunner must harbour the Hunter before the Runner confirms',
  );
  assert.ok(
    catchRunner.includes('resumeSeatViaCatchPage(runnerPage, roomId, runnerName)'),
    'catchRunner must harbour the Runner before the Runner confirms',
  );
  // catch-results:88 second claim: the second Runner is harboured
  // before the Hunter claims them.
  const secondClaim = catchResults.slice(catchResults.indexOf("'all runners caught"));
  assert.ok(
    secondClaim.includes('resumeSeatViaCatchPage(runnerPages[1]!'),
    'the second claim must harbour the second Runner before the Hunter claims them',
  );
  // brutal-phone:20 Way 1: the Runner is harboured before the Hunter claims.
  const brutalFlow = brutal.slice(brutal.indexOf("'create → join → ready → start → play → catch → confirm → results → fresh game'"));
  assert.ok(
    brutalFlow.includes('resumeSeatViaCatchPage(runnerPage, roomId, runnerName)'),
    'brutal-phone:20 must harbour the Runner before the Hunter claims them',
  );
  // v32 fix round (Diya A1): a centred context on its own does NOT
  // hold the (4a) clock off — it delivers exactly ONE static fix, so
  // the front seat's `lastFixAt` goes stale at ACTIVE+30 s. What holds
  // it off is the 4 s keep-fresh nudge loop (`startCentreFixKeepFresh`)
  // in the exposed specs, where the untouched Runner is never
  // harboured (catch-results:65, catch-results:136, brutal-phone:20 —
  // plus catch-results:88, whose second Runner is unharboured until
  // the second claim). All eight tests still run on a centred-GPS
  // context (v30 pin: a no-GPS demo test whose ACTIVE span crosses
  // 30 s must grant geolocation or end first).
  for (const [name, src] of [
    ['catch-nav.spec.ts', catchNav],
    ['catch-results.spec.ts', catchResults],
    ['brutal-phone.spec.ts', brutal],
  ]) {
    assert.ok(
      src.includes('newCentredDemoContext(browser)'),
      `${name} must create its catch contexts with emulated GPS at the zone centre`,
    );
  }
  // The exposed tests must run the keep-fresh loop for the whole
  // ACTIVE span — the centred context alone is not enough (see above).
  // Slices are bounded to each test's own body (next test title), so a
  // later test's loop cannot satisfy an earlier test's pin.
  const boundedSlice = (src, from, to) =>
    to === null ? src.slice(src.indexOf(from)) : src.slice(src.indexOf(from), src.indexOf(to));
  for (const [name, src, from, to] of [
    ['catch-results.spec.ts (:65)', catchResults, "'one tag then time up", "'all runners caught"],
    ['catch-results.spec.ts (:88)', catchResults, "'all runners caught", "'Replay — back to the lobby"],
    ['catch-results.spec.ts (:136)', catchResults, "'Replay — back to the lobby", "'results before the match finishes"],
    ['brutal-phone.spec.ts (:20)', brutal, "'create → join → ready → start → play → catch → confirm → results → fresh game'", "'phone HUD basics"],
  ]) {
    assert.ok(
      boundedSlice(src, from, to).includes('startCentreFixKeepFresh('),
      `${name} must run the 4 s keep-fresh nudge loop — its untouched Runner is never harboured, so a static centred fix would go stale at ACTIVE+30 s`,
    );
  }
});
