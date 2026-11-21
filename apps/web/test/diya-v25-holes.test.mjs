import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const {
  pillTextForState,
  handleMapTabReturn,
  recordTileError,
  EMPTY_TILE_LEDGER,
  tileLedgerStale,
  TILE_ERROR_QUIET_DECAY_MS,
} = await import('../src/components/hud/play-map-logic.ts');
const { circlePolygon } = await import('@pakdam/engine');
const { FakeMapLibreMap } = await import('./fake-map.mjs');

/**
 * diya-v25-holes.test.mjs — Diya (adversarial review) hole tests, CLOSED.
 *
 * Each test used to PASS by showing a hole in the v25 fix was PRESENT.
 * They are now flipped to assert the FIXED behaviour — a test that
 * passes here means the hole is closed. The hole descriptions are kept
 * as comments so the fix contract stays readable.
 */

const PATNA = { lat: 25.5941, lng: 85.1376 };
const REAL_BOUNDARY = circlePolygon(PATNA, 500, 64);

// ---------------------------------------------------------------------------
// HOLE 1 (CLOSED) — a zone-effect fit failure was invisible in the pill.
// The zone effect caught a throwing fit and recorded the reason in
// mapDetail, but pillTextForState's 'ready' branch never looked at
// mapDetail — so the founder still saw "Map ready" with the camera
// stuck at the default view. FIX: the pill takes a fitFailed flag
// (play-map-logic.ts pillTextForState) and names the failure.
// ---------------------------------------------------------------------------
test('FIXED (Diya-1): a failed first fit surfaces in the pill — never "Map ready" while the camera never reached the zone', () => {
  const fitFailureDetail = 'Invalid LngLat object: (NaN, 25.5)';
  // v26: the fit branch uses the fit's OWN reason (10th arg), never
  // the stale mapDetail — the v25 call passed the detail as mapDetail
  // and the pill appended it verbatim, so a deferred fit with
  // mapDetail 'ready' read "camera fit failed — ready".
  const pill = pillTextForState('ready', 'ready', false, null, 0, null, true, false, null, fitFailureDetail);
  assert.notEqual(pill, 'Map ready');
  assert.match(pill, /not in view|fit failed/i);
  assert.match(pill, /NaN/);
  // And without the flag the healthy pill is unchanged.
  assert.equal(pillTextForState('ready', 'ready', false, null, 0, null, false), 'Map ready');
});

// ---------------------------------------------------------------------------
// HOLE 2 (CLOSED) — handleMapTabReturn left resize() and triggerRepaint()
// OUTSIDE the try/catch (only the fitBounds call was guarded). Real
// MapLibre resize() after remove() runs _resizeInternal on a destroyed
// painter and is NOT a proven no-op. FIX: every step is guarded — a tab
// return never throws, and the repaint still runs when the resize throws.
// ---------------------------------------------------------------------------
test('FIXED (Diya-2a): handleMapTabReturn does NOT throw when resize() throws — the fit is still attempted and the repaint still runs', () => {
  class ThrowingResizeMap extends FakeMapLibreMap {
    resize() {
      this.record('resize');
      throw new Error('resize boom (removed map / dead GL context)');
    }
  }
  const map = new ThrowingResizeMap();
  const fitted = { current: false };
  assert.doesNotThrow(() => handleMapTabReturn(map, REAL_BOUNDARY, fitted, true));
  assert.equal(map.repaintCount, 1, 'triggerRepaint runs even when resize throws');
  assert.equal(map.fitBoundsCount, 1, 'the fit is still attempted');
  assert.equal(fitted.current, true, 'the fit landed');
  const cam = map.camera();
  assert.ok(Math.abs(cam.centre[0] - PATNA.lng) < 0.001, 'camera reached the zone');
});

test('FIXED (Diya-2b): handleMapTabReturn does NOT throw when triggerRepaint() throws — the successful fit stays consumed (it landed)', () => {
  class ThrowingRepaintMap extends FakeMapLibreMap {
    triggerRepaint() {
      this.record('triggerRepaint');
      throw new Error('triggerRepaint boom');
    }
  }
  const map = new ThrowingRepaintMap();
  const fitted = { current: false };
  assert.doesNotThrow(() => handleMapTabReturn(map, REAL_BOUNDARY, fitted, true));
  assert.equal(
    fitted.current,
    true,
    'fitBounds succeeded and consumed the one fit — the repaint failure does not un-fit the camera',
  );
  assert.equal(map.resizeCount, 1, 'resize ran');
  assert.equal(map.fitBoundsCount, 1, 'fit ran once');
});

// ---------------------------------------------------------------------------
// HOLE 3 (CLOSED) — the tile-error count was taken at face value with no
// dedupe and no recovery input. MapLibre fires one `error` event per
// failed tile request, so one flaky tile re-requested twice read as
// "2 tile errors"; and once the count was > 0 the pill was branded
// forever (until a full Retry rebuild). FIX: the tile-error ledger
// (play-map-logic.ts recordTileError) dedupes by sanitised detail, caps
// the count, and goes stale after 30 s quiet — the pill shows the
// ledger count, so a transient blip clears on its own.
// ---------------------------------------------------------------------------
test('FIXED (Diya-3): one flaky tile re-requested twice reads as 1 tile error, and a transient blip does not permanently brand a healthy map', () => {
  const detail = 'HTTP 401 — tile failed';
  const once = recordTileError(EMPTY_TILE_LEDGER, detail, 1000);
  assert.equal(once.count, 1, 'first failure counts once');
  const twice = recordTileError(once, detail, 2000);
  assert.equal(twice.count, 1, 'the same tile failing again is NOT a second error');
  assert.deepEqual(twice.details, [detail], 'first detail kept');
  const pill = pillTextForState('ready', 'ready', false, null, twice.count, twice.details[0]);
  assert.match(pill, /1 tile error\b/);
  assert.doesNotMatch(pill, /2 tile errors/);
  // Recovery: 30 s quiet and the slate is stale — the component's decay
  // timer clears it, so the pill returns to "Map ready".
  assert.equal(tileLedgerStale(twice, 2000 + TILE_ERROR_QUIET_DECAY_MS - 1), false);
  assert.equal(tileLedgerStale(twice, 2000 + TILE_ERROR_QUIET_DECAY_MS), true);
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null),
    'Map ready',
    'a cleared slate reads "Map ready" again',
  );
});
