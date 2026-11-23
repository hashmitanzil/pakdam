/**
 * v30 GPS-dot tests (Meera) — the pill, the display gate, the stale
 * notice, and Retry on a slow load.
 *
 * THE PILL (v30 correction of the v29 M8 fix): the v29 spacing gate
 * never held. Its inline append skipped only when the last point was
 * BOTH < ~11 m away AND < 3 s old, and the trail effect runs on the
 * 5 s-quantised map clock — so the age leg was almost always ≥ 3 s
 * and a point was appended on EVERY tick regardless of distance.
 * Walking 1–2 m/s appended a point every ~5–10 m; the 3 px dots in
 * the me-dot's red merge into a capsule trailing the dot — the pill.
 * The fix is `appendTrailPoint`: distance-only ≥ ~11 m, sub-threshold
 * fixes refresh the last point in place (no new point, no stack).
 * These tests pin the REAL production helper (PlayMap.tsx calls it),
 * including the exact slow-walk sequence that defeated v29.
 *
 * Pure helpers only; the play page's wiring (notice precedence,
 * "Try again" for timeout/unavailable/unsupported) is covered by
 * source pins at the bottom — the page needs React.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const {
  appendTrailPoint,
  TRAIL_MIN_MOVE_DEG,
  TRAIL_DOT_RADIUS_PX,
  TRAIL_MAX_AGE_MS,
  TRAIL_MAX_POINTS,
  meDotMarkerStyle,
  ME_DOT_MARKER_SIZE_PX,
  meAccuracyFeatures,
  gpsStaleFixNotice,
  gpsNoFixNotice,
  retryDisabled,
  RETRY_COOLDOWN_MS,
} = await import('../src/components/hud/play-map-logic.ts');
const { validateFix, MAX_FIX_ACCURACY_METERS } = await import('@pakdam/shared');

const NOW = 1_000_000;
const BASE_LNG = 85.33;
const BASE_LAT = 23.35;
/** ~1.8 m in longitude at Ranchi's latitude (1° lng ≈ 102 km). */
const TWO_METRES_DEG = 0.000018;
/** ~12 m in longitude — just over the ~11 m spacing gate. */
const TWELVE_METRES_DEG = 0.00012;

const fix = (lng, lat, timestampMs, accuracyMeters = 8) => ({
  lng,
  lat,
  accuracyMeters,
  timestampMs,
});

// -- the pill: appendTrailPoint ---------------------------------------------

test('pill (v30): a slow walk — 2 m every 5 s for 30 s — appends NO new trail point', () => {
  // This is the exact sequence that defeated v29: each fix is < 11 m
  // from the last point, but ≥ 3 s newer, so the old
  // `moved < gate && age < 3000ms` skip never fired and a point was
  // appended on every tick — a capsule of overlapping dots.
  let list = appendTrailPoint([], fix(BASE_LNG, BASE_LAT, NOW), NOW);
  assert.equal(list.length, 1);
  for (let step = 1; step <= 6; step++) {
    list = appendTrailPoint(
      list,
      fix(BASE_LNG + step * TWO_METRES_DEG, BASE_LAT, NOW + step * 5000),
      NOW + step * 5000,
    );
    assert.equal(list.length, 1, `step ${step}: slow movement must not append`);
  }
  // The single point stays fresh: its timestamp tracks the latest fix,
  // so a slow/stationary player keeps one live dot instead of a stack —
  // and its POSITION tracks the latest fix too (v30: keeping the old
  // coordinates would let the point lag up to 11 m behind a slow
  // walker and eventually cross the gate and append).
  assert.equal(list[0].atMs, NOW + 6 * 5000);
  assert.equal(list[0].lng, BASE_LNG + 6 * TWO_METRES_DEG);
});

test('pill (v30): standing still refreshes in place — one point, never a stack', () => {
  let list = appendTrailPoint([], fix(BASE_LNG, BASE_LAT, NOW), NOW);
  for (let step = 1; step <= 3; step++) {
    list = appendTrailPoint(list, fix(BASE_LNG, BASE_LAT, NOW + step * 5000), NOW + step * 5000);
    assert.equal(list.length, 1, `step ${step}: same spot must not stack`);
  }
  assert.equal(list[0].atMs, NOW + 3 * 5000);
});

test('pill (v30): a real move (≥ ~11 m) appends exactly one point', () => {
  let list = appendTrailPoint([], fix(BASE_LNG, BASE_LAT, NOW), NOW);
  list = appendTrailPoint(
    list,
    fix(BASE_LNG + TWELVE_METRES_DEG, BASE_LAT, NOW + 5000),
    NOW + 5000,
  );
  assert.equal(list.length, 2);
  assert.equal(list[1].lng, BASE_LNG + TWELVE_METRES_DEG);
  // A second sub-threshold fix after the move refreshes, not appends.
  list = appendTrailPoint(
    list,
    fix(BASE_LNG + TWELVE_METRES_DEG + TWO_METRES_DEG, BASE_LAT, NOW + 10_000),
    NOW + 10_000,
  );
  assert.equal(list.length, 2);
});

test('pill (v30): the gate is distance-only — a just-under-11 m move after a LONG gap still does not append', () => {
  // The v29 bypass was the time leg: after a long gap ANY move
  // appended. Distance alone decides now.
  const list = appendTrailPoint([], fix(BASE_LNG, BASE_LAT, NOW), NOW);
  const afterGap = appendTrailPoint(
    list,
    fix(BASE_LNG + TWO_METRES_DEG, BASE_LAT, NOW + 60_000),
    NOW + 60_000,
  );
  // The 60 s-old point is pruned (10 s window), so the new fix becomes
  // the first point of a fresh list — still length 1, never 2.
  assert.equal(afterGap.length, 1);
  assert.equal(afterGap[0].lng, BASE_LNG + TWO_METRES_DEG);
});

test('trail: points older than the 10 s window are pruned; the list caps at 200', () => {
  const stale = appendTrailPoint([], fix(BASE_LNG, BASE_LAT, NOW - 11_000), NOW - 11_000);
  const fresh = appendTrailPoint(stale, fix(BASE_LNG, BASE_LAT, NOW), NOW);
  assert.equal(fresh.length, 1, 'the 11 s-old point must be pruned, not shipped');
  assert.equal(fresh[0].atMs, NOW);

  let big = [];
  let t = NOW;
  for (let i = 0; i < TRAIL_MAX_POINTS + 5; i++) {
    // Each step moves > 11 m AND stays inside the 10 s window of the
    // latest point by advancing the clock only 10 ms per step (205
    // steps ≈ 2 s total, so nothing is pruned — the cap is what binds).
    big = appendTrailPoint(big, fix(BASE_LNG + i * TWELVE_METRES_DEG, BASE_LAT, t), t);
    t += 10;
  }
  assert.equal(big.length, TRAIL_MAX_POINTS);
  // The input list is not mutated. (List elements are TrailPoints —
  // `{ lng, lat, atMs }` — not raw fixes, which carry `timestampMs`.)
  const input = [{ lng: BASE_LNG, lat: BASE_LAT, atMs: NOW }];
  const out = appendTrailPoint(input, fix(BASE_LNG + TWELVE_METRES_DEG, BASE_LAT, NOW + 1000), NOW + 1000);
  assert.equal(input.length, 1);
  assert.equal(out.length, 2);
});

test('trail constants: ~11 m spacing, 3 px dots, 10 s window', () => {
  assert.equal(TRAIL_MIN_MOVE_DEG, 0.0001);
  assert.equal(TRAIL_DOT_RADIUS_PX, 3);
  assert.equal(TRAIL_MAX_AGE_MS, 10_000);
  assert.equal(TRAIL_MAX_POINTS, 200);
});

// -- the marker itself was NOT the pill -------------------------------------

test('me dot marker: 18×18 square, round, border inside the box', () => {
  assert.equal(ME_DOT_MARKER_SIZE_PX, 18);
  const fresh = meDotMarkerStyle(false);
  assert.equal(fresh.width, '18px');
  assert.equal(fresh.height, '18px');
  assert.equal(fresh.borderRadius, '999px');
  // v30: roundness must not depend on Tailwind preflight or MapLibre
  // marker CSS — border-box keeps the 2 px border inside the 18 px
  // box under any box-sizing, so the box stays square.
  assert.equal(fresh.boxSizing, 'border-box');
  assert.equal(fresh.display, 'block');
  assert.equal(fresh.opacity, '1');
  assert.equal(meDotMarkerStyle(true).opacity, '0.35', 'stale draws faded');
});

// -- display gate: ANY validated fix draws (no ±50 m display gate) ----------

test('display gate: a 900 m fix is validated and draws (ring + dot); 1001 m is rejected', () => {
  assert.equal(MAX_FIX_ACCURACY_METERS, 1000);
  assert.equal(validateFix(fix(BASE_LNG, BASE_LAT, NOW, 900), null, NOW).ok, true);
  assert.equal(validateFix(fix(BASE_LNG, BASE_LAT, NOW, 1001), null, NOW).ok, false);
  assert.equal(validateFix(fix(BASE_LNG, BASE_LAT, NOW, 50), null, NOW).ok, true);
  // The accuracy ring draws for any positive finite accuracy — the
  // ±50 m gate is gameplay usability, never a display gate.
  assert.equal(meAccuracyFeatures(fix(BASE_LNG, BASE_LAT, NOW, 900)).length, 1);
  assert.equal(meAccuracyFeatures(fix(BASE_LNG, BASE_LAT, NOW, 8)).length, 1);
  assert.equal(meAccuracyFeatures(null).length, 0);
});

// -- stale-fix notice (the frozen-dot silence) -------------------------------

test('stale-fix notice: null with no fix or a fresh fix; named once > 60 s old', () => {
  assert.equal(gpsStaleFixNotice(null, NOW), null);
  assert.equal(gpsStaleFixNotice(fix(BASE_LNG, BASE_LAT, NOW - 10_000), NOW), null);
  assert.equal(gpsStaleFixNotice(fix(BASE_LNG, BASE_LAT, NOW - 59_000), NOW), null);
  const stale = gpsStaleFixNotice(fix(BASE_LNG, BASE_LAT, NOW - 61_000), NOW);
  assert.ok(stale, 'a 61 s-old fix must be named, not silent');
  assert.match(stale, /stale/);
  assert.match(stale, /61s/);
});

// -- no-fix notice unchanged -------------------------------------------------

test('no-fix notice: fires at 15 s with no fix, never with a fix', () => {
  assert.equal(gpsNoFixNotice(true, 14_999), null);
  assert.ok(gpsNoFixNotice(true, 15_000));
  assert.equal(gpsNoFixNotice(false, 60_000), null);
});

// -- Retry on a slow load (the "not ready" escape) ---------------------------

test('retryDisabled (v30): a SLOW load can be retried; a fresh load cannot', () => {
  assert.equal(retryDisabled('loading', 20_000, null, false, false), true, 'fresh load: disabled');
  assert.equal(retryDisabled('loading', 20_000, null, false, true), false, 'slow load, never tapped: enabled');
  assert.equal(retryDisabled('loading', 20_000, 19_500, false, true), true, 'slow load, tapped 500 ms ago: cooling down');
  assert.equal(
    retryDisabled('loading', 20_000, 20_000 - RETRY_COOLDOWN_MS, false, true),
    false,
    'slow load, cooldown spent: enabled',
  );
  // Defaults unchanged: old callers (no slowLoad) still block a load,
  // and ready/error behaviour is untouched.
  assert.equal(retryDisabled('loading', 20_000, null), true);
  assert.equal(retryDisabled('ready', 20_000, null), false);
  assert.equal(retryDisabled('error', 20_000, null), false);
});

// -- source pins: the play page wires the new notices + retry ----------------

const pageSrc = readFileSync(
  new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
  'utf8',
);

test('pin: play page renders the stale notice between fixNotice and the no-fix notice', () => {
  assert.ok(pageSrc.includes('gpsStaleFixNotice(myFix, nowMs)'), 'stale notice must be in the shownFixNotice chain');
  const chain = pageSrc.indexOf('gpsStaleFixNotice(myFix, nowMs)');
  // v30 follow-up (item A): the no-fix leg is now gpsNoFixNoticeForWatch
  // (watchable-clock baseline) — the old gpsNoFixNotice( call is gone.
  const noFix = pageSrc.indexOf('gpsNoFixNoticeForWatch(', chain);
  assert.ok(chain > 0 && noFix > chain, 'stale must precede no-fix in the ?? chain');
});

test('pin: play page handles timeout + unsupported errors (not just denied/unavailable)', () => {
  assert.ok(pageSrc.includes("err.kind === 'timeout'"), 'timeout branch must exist');
  assert.ok(pageSrc.includes("err.kind === 'unsupported'"), 'unsupported branch must exist');
  assert.ok(
    pageSrc.includes('GPS is taking a while'),
    'timeout copy must be play-appropriate (no lobby "place the zone")',
  );
});

test('pin: "Try again" shows for retryable GPS errors, not only denial', () => {
  assert.ok(pageSrc.includes('gpsDenied || gpsRetryable'), 'button condition must include gpsRetryable');
  assert.ok(pageSrc.includes('setGpsRetryable(true)'), 'error branches must mark the notice retryable');
  assert.ok(pageSrc.includes('setGpsRetryable(false)'), 'a fresh fix must clear the retryable state');
});

const playMapSrc = readFileSync(
  new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
  'utf8',
);

test('pin: PlayMap appends trails only through appendTrailPoint; Retry passes slowLoad', () => {
  assert.ok(playMapSrc.includes('appendTrailPoint('), 'trail effect must call the pure helper');
  assert.ok(!playMapSrc.includes('TRAIL_MIN_MOVE_DEG'), 'no inline spacing gate may remain in PlayMap');
  assert.ok(!playMapSrc.includes('now - last.atMs < 3000'), 'the v29 time bypass must be gone');
  assert.ok(
    playMapSrc.includes('retryDisabled(\n    mapState,\n    nowMs ?? Date.now(),\n    lastRetryAtMs,\n    isDeferred,\n    slowLoad,'),
    'the pill Retry must pass slowLoad',
  );
  assert.ok(
    playMapSrc.includes('retryDisabled(mapState, Date.now(), lastRetryAtMs, isDeferred, slowLoad)'),
    'the retryMap guard must pass slowLoad too',
  );
});
