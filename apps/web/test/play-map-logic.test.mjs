import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const {
  boundaryBBox,
  polygonFeature,
  collection,
  pillTextForState,
  classifyMapError,
  classifyPostLoadResource,
  resourceLabel,
  mapErrorDetail,
  unknownErrorDetail,
  tryFitZone,
  tryFitSetupZone,
  cameraCanFitBounds,
  safeSetSourceData,
  syncSource,
  ensureMapSource,
  ensureMapLayer,
  handleMapTabReturn,
  interpolateBoundary,
  rippleProgress,
  shrinkFrame,
  rippleFrame,
  recordTileError,
  EMPTY_TILE_LEDGER,
  MAX_TILE_ERROR_COUNT,
  nextFitRetryDelayMs,
  MAX_FIT_RETRIES,
  FIT_RETRY_DELAY_MS,
  fitRetryDelayForOutcome,
  fitRetryDelayForBudget,
  createFitRetryBudget,
  resetFitRetryBudget,
  scheduleFitRetryTimer,
  fitOutcomeAction,
  fitEscalationReason,
  NON_FINITE_BOUNDS_REASON,
  boundaryChangedMaterially,
  viewBounds,
  zoneBboxInView,
  isMaterialSizeChange,
  mapAreaHasHeight,
  diagnoseMapAreaHeight,
  mapBuildDecision,
  canvasMatchesContainer,
  canvasRepairStep,
  retryDisabled,
  retryCooldownActive,
  RETRY_COOLDOWN_MS,
} = await import('../src/components/hud/play-map-logic.ts');
const { circlePolygon } = await import('@pakdam/engine');
const { isValidGeoPolygon } = await import('@pakdam/shared');
const { FakeMapLibreMap } = await import('./fake-map.mjs');

/**
 * play-map-logic.test.mjs — v25: the in-game (play-screen) map is BLANK
 * on the live site while the setup map on the same site paints.
 *
 * Founder field report (2026-11-21) + independent browser check of
 * https://pakdam.vercel.app (Classic, 500 m zone, Patna, room
 * b8d6e655-3326-4e31-b989-a071cc0645c0, code 6RB79G): play canvas present
 * (~660×525), pill "Map ready", but NO tiles, NO zone polygon, NO player
 * dot after ~2 min + Re-centre. No error banner, no Retry. Control: the
 * SETUP map paints full dark Ola tiles + the red 500 m circle.
 *
 * Every test here runs the REAL production code (play-map-logic.ts, the
 * module PlayMap.tsx imports) against FakeMapLibreMap — no browser.
 *
 * Tests are labelled:
 *  - REPRODUCTION (passes pre-fix — demonstrates the break): the test
 *    PASSES by showing the broken behaviour exists. It documents the
 *    mechanism; it does not need the fix to pass.
 *  - REPRODUCTION (fails pre-fix — passes after the fix): the test
 *    asserts the FIXED behaviour and FAILS against the pre-fix code.
 *    The failing test IS the reproduction. The fix contract is stated
 *    in the v25 FIX comment at the matching site in play-map-logic.ts
 *    (pre-fix, those sites were marked PRE-FIX).
 */

// The founder's live game: Classic, 500 m zone, Patna.
const PATNA = { lat: 25.5941, lng: 85.1376 };
const RANCHI_DEFAULT = [85.33, 23.36];
/** The REAL snapshot zone boundary: 64 {lng, lat} points from circlePolygon. */
const REAL_BOUNDARY = circlePolygon(PATNA, 500, 64);

function assertCameraAtZone(map, label = 'camera') {
  const cam = map.camera();
  assert.ok(Number.isFinite(cam.centre[0]) && Number.isFinite(cam.centre[1]), `${label}: centre must be finite`);
  assert.ok(Number.isFinite(cam.zoom), `${label}: zoom must be finite`);
  assert.ok(Math.abs(cam.centre[0] - PATNA.lng) < 0.001, `${label}: lng ${cam.centre[0]} should be ~Patna ${PATNA.lng}`);
  assert.ok(Math.abs(cam.centre[1] - PATNA.lat) < 0.001, `${label}: lat ${cam.centre[1]} should be ~Patna ${PATNA.lat}`);
  assert.ok(cam.zoom >= 13 && cam.zoom <= 17, `${label}: zoom ${cam.zoom} should be street-level (13–17)`);
}

function assertCameraAtRanchiDefault(map, label = 'camera') {
  const cam = map.camera();
  assert.deepEqual(cam.centre, RANCHI_DEFAULT, `${label}: camera never left the Ranchi default`);
}

// ---------------------------------------------------------------------------
// The real snapshot shape (what the server actually sends)
// ---------------------------------------------------------------------------

test('real snapshot shape: the server sends {lng, lat} objects — the shared validator accepts them, rejects [lng, lat] arrays', () => {
  // GeoPolygon = GeoPoint[] ({lat, lng}); circlePolygon, drawPointsToBoundary
  // and the DO (`config.zone.boundary.map(p => ({ ...p }))`) all produce
  // objects, and JSON round-tripping (the snapshot path) keeps objects.
  const roundTripped = JSON.parse(JSON.stringify(REAL_BOUNDARY));
  assert.equal(isValidGeoPolygon(roundTripped), true);
  assert.equal(isValidGeoPolygon(REAL_BOUNDARY), true);
  const asArrays = REAL_BOUNDARY.map((p) => [p.lng, p.lat]);
  assert.equal(isValidGeoPolygon(asArrays), false);
});

test('boundaryBBox: REAL shape ({lng, lat} 64-pt Patna 500 m circle) → finite bounds centred on Patna', () => {
  const bbox = boundaryBBox(REAL_BOUNDARY);
  assert.deepEqual(
    bbox.flat().map((v) => Number.isFinite(v)),
    [true, true, true, true],
  );
  // 500 m at Patna ≈ 0.010° lng span, ≈ 0.009° lat span.
  const [[minLng, minLat], [maxLng, maxLat]] = bbox;
  assert.ok(Math.abs((minLng + maxLng) / 2 - PATNA.lng) < 0.0005);
  assert.ok(Math.abs((minLat + maxLat) / 2 - PATNA.lat) < 0.0005);
  assert.ok(maxLng - minLng > 0.008 && maxLng - minLng < 0.012);
  assert.ok(maxLat - minLat > 0.007 && maxLat - minLat < 0.011);
});

test('fitBounds path: REAL shape → fake camera ends up at the zone (finite centre + street zoom), not the Ranchi default', () => {
  const map = new FakeMapLibreMap();
  map.fitBounds(boundaryBBox(REAL_BOUNDARY), { padding: 40, duration: 0 });
  assertCameraAtZone(map);
});

test('ring/polygonFeature: the zone payload the map receives is a closed ring of [lng, lat] pairs', () => {
  const feature = polygonFeature(REAL_BOUNDARY);
  const coords = feature.geometry.coordinates[0];
  assert.equal(feature.geometry.type, 'Polygon');
  assert.deepEqual(coords[0], coords[coords.length - 1], 'ring closes');
  assert.equal(coords.length, REAL_BOUNDARY.length + 1);
  assert.ok(Math.abs(coords[0][0] - REAL_BOUNDARY[0].lng) < 1e-9, 'first coord is [lng, lat], not [lat, lng]');
  assert.ok(Math.abs(coords[0][1] - REAL_BOUNDARY[0].lat) < 1e-9);
  assert.equal(collection([feature]).type, 'FeatureCollection');
});

// ---------------------------------------------------------------------------
// REPRODUCTION: wrong boundary shape breaks the camera
// ---------------------------------------------------------------------------

test('REPRODUCTION (passes pre-fix — demonstrates the break): [lng, lat] ARRAY boundary → NaN bbox → fitBounds throws, camera stuck at the Ranchi default', () => {
  // If anything upstream ever handed the play map GeoJSON-style arrays
  // instead of {lng, lat} objects, boundaryBBox reads p.lng/p.lat as
  // undefined and every bound is NaN — a NaN camera paints nothing.
  // boundaryBBox has no shape guard, so this fails loudly instead of
  // silently falling back to the Ranchi default — and that fallback
  // would BE the break, not a degradation: a camera stuck at the
  // default paints the wrong place while the pill says "Map ready".
  // (v25 fix round: tryFitZone now reports a non-finite bbox as its
  // own outcome instead of letting fitBounds throw — see below.)
  const asArrays = REAL_BOUNDARY.map((p) => [p.lng, p.lat]);
  const bbox = boundaryBBox(asArrays);
  assert.ok(bbox.flat().every((v) => Number.isNaN(v)), 'all four bounds are NaN');
  const map = new FakeMapLibreMap();
  assert.throws(() => map.fitBounds(bbox, { padding: 40, duration: 0 }), /non-finite bounds/);
  assertCameraAtRanchiDefault(map);
});

// ---------------------------------------------------------------------------
// fittedRef ordering: a fitBounds that throws must not consume the one fit
// ---------------------------------------------------------------------------

test('tryFitZone: success marks fitted once — a second call is a no-op so free panning is never fought', () => {
  const map = new FakeMapLibreMap();
  const fitted = { current: false };
  assert.equal(tryFitZone(fitted, map, REAL_BOUNDARY, true), 'fitted');
  assert.equal(fitted.current, true);
  assert.equal(tryFitZone(fitted, map, REAL_BOUNDARY, true), 'already-fitted');
  assert.equal(map.fitBoundsCount, 1);
  assertCameraAtZone(map);
});

test('tryFitZone: empty / <3-point boundary never fits (no call, flag stays false)', () => {
  const map = new FakeMapLibreMap();
  const fitted = { current: false };
  assert.equal(tryFitZone(fitted, map, [], true), 'no-boundary');
  assert.equal(tryFitZone(fitted, map, REAL_BOUNDARY.slice(0, 2), true), 'no-boundary');
  assert.equal(map.fitBoundsCount, 0);
  assert.equal(fitted.current, false);
});

test('tryFitZone: hidden container (0-size) never fits — the fit is deferred, not consumed', () => {
  const map = new FakeMapLibreMap();
  const fitted = { current: false };
  assert.equal(tryFitZone(fitted, map, REAL_BOUNDARY, false), 'hidden');
  assert.equal(map.fitBoundsCount, 0);
  assert.equal(fitted.current, false);
});

// (F12: the byte-identical FIXED twin of this test was removed — one
// assertion per behaviour, no padded count.)
test('REPRODUCTION (fails pre-fix — passes after the fix): a fitBounds that throws on first call must NOT consume the one fit — the retry fits the camera', () => {
  const map = new FakeMapLibreMap();
  map.failFitBoundsTimes(1);
  const fitted = { current: false };
  assert.throws(() => tryFitZone(fitted, map, REAL_BOUNDARY, true), /injected failure/);
  // FIX contract (play-map-logic.ts tryFitZone): mark fitted only AFTER
  // fitBounds returns, so this retry fits instead of reporting
  // 'already-fitted'.
  assert.equal(tryFitZone(fitted, map, REAL_BOUNDARY, true), 'fitted');
  assertCameraAtZone(map);
});

// ---------------------------------------------------------------------------
// Post-load tile errors: must surface, never hide behind "Map ready"
// ---------------------------------------------------------------------------

test('classifyMapError: pre-load failure → pre-load-failure with the real detail, api_key stripped', () => {
  const c = classifyMapError(false, {
    error: { status: 401, message: 'GET https://api.olamaps.io/tiles?api_key=abc123secret failed' },
  });
  assert.equal(c.kind, 'pre-load-failure');
  assert.match(c.detail, /HTTP 401/);
  assert.doesNotMatch(c.detail, /abc123secret/);
  assert.match(c.detail, /api_key=…/);
});

test('REPRODUCTION (fails pre-fix — passes after the fix): a tile error arriving AFTER load must be recorded as a post-load tile error, not swallowed', () => {
  // PlayMap today: `if (loadedRef.current) return;` — the error vanishes.
  const c = classifyMapError(true, {
    error: { status: 401, message: 'Tile request failed 401' },
  });
  // FIX contract (play-map-logic.ts classifyMapError): loaded + error →
  // { kind: 'post-load-tile-error', detail } and the component records it.
  assert.equal(c.kind, 'post-load-tile-error');
  assert.match(c.detail, /HTTP 401/);
});

test('pillTextForState: loading and error pills carry the real detail', () => {
  assert.equal(
    pillTextForState('loading', 'style loading… (attempt 1)', false, 5),
    'Map loading — style loading… (attempt 1) · 5s',
  );
  assert.equal(
    pillTextForState('loading', 'creating map… (attempt 1)', true, null),
    'Map loading — creating map… (attempt 1) · still trying…',
  );
  assert.equal(
    pillTextForState('error', 'HTTP 401 — tile failed', false, null),
    'Map error — HTTP 401 — tile failed',
  );
});

test('REPRODUCTION (fails pre-fix — passes after the fix): the pill is never "Map ready" while tile errors are being recorded', () => {
  // The founder's exact symptom: pill "Map ready", blank canvas, no
  // Retry — because the pill ignores post-load tile errors entirely.
  const pill = pillTextForState('ready', 'ready', false, null, 2);
  // FIX contract (play-map-logic.ts pillTextForState): with tile errors
  // recorded, name the tile failure instead of claiming "Map ready".
  assert.notEqual(pill, 'Map ready');
  assert.match(pill, /tile/i);
});

// ---------------------------------------------------------------------------
// rAF loops after map removal
// ---------------------------------------------------------------------------

test('safeSetSourceData: normal path writes the data', () => {
  const map = new FakeMapLibreMap();
  map.addSource('pakdam-zone', { type: 'geojson', data: collection([]) });
  assert.equal(safeSetSourceData(map, 'pakdam-zone', collection([polygonFeature(REAL_BOUNDARY)])), true);
  const src = map.getSource('pakdam-zone');
  assert.equal(src.setDataCount, 1);
  assert.equal(src.data.features.length, 1);
});

test('REPRODUCTION (fails pre-fix — passes after the fix): setData on a removed map must not throw — it reports false', () => {
  const map = new FakeMapLibreMap();
  map.addSource('pakdam-zone', { type: 'geojson', data: collection([]) });
  const src = map.getSource('pakdam-zone');
  map.remove();
  // FIX contract (play-map-logic.ts safeSetSourceData): swallow the
  // removed-map failure and return false; the loops end instead of
  // throwing out of a rAF callback.
  assert.equal(safeSetSourceData(map, 'pakdam-zone', collection([])), false);
  assert.equal(src.setDataCount, 0, 'no write landed on the removed map');
});

test('interpolateBoundary / rippleProgress: pure frame math (endpoints, midpoint, future-dated clamp)', () => {
  const start = circlePolygon(PATNA, 500, 8);
  const end = circlePolygon(PATNA, 375, 8);
  assert.deepEqual(interpolateBoundary(start, end, 0), start);
  assert.deepEqual(interpolateBoundary(start, end, 1), end);
  const mid = interpolateBoundary(start, end, 0.5);
  assert.ok(Math.abs(mid[0].lng - (start[0].lng + end[0].lng) / 2) < 1e-12);
  assert.equal(rippleProgress(1000, 1000), 0);
  assert.equal(rippleProgress(1000, 2750), 1);
  assert.equal(rippleProgress(5000, 1000), 0, 'future-dated createdAt clamps to 0');
});

test('REPRODUCTION (fails pre-fix — passes after the fix): zone-shrink animation removed mid-flight does not throw and the loop ends', () => {
  const map = new FakeMapLibreMap();
  map.addSource('pakdam-zone', { type: 'geojson', data: collection([]) });
  const start = circlePolygon(PATNA, 500, 8);
  const end = circlePolygon(PATNA, 375, 8);
  const first = shrinkFrame(map, start, end, 0, 500);
  assert.equal(first.done, false);
  assert.ok(first.interpolated.length === 8);
  map.remove(); // removal lands between two rAF frames
  let second;
  assert.doesNotThrow(() => {
    second = shrinkFrame(map, start, end, 0, 1000);
  });
  assert.equal(second.done, true, 'loop ends when the map is gone — it must not spin on a dead map');
});

test('REPRODUCTION (fails pre-fix — passes after the fix): ping-ripple loop removed mid-flight does not throw and the loop ends', () => {
  const map = new FakeMapLibreMap();
  map.addSource('pakdam-pings', { type: 'geojson', data: collection([]) });
  const pings = [{ pingId: 'p1', createdAtMs: 1000, centre: PATNA, radiusMeters: 150 }];
  const first = rippleFrame(map, [], pings, 1000, 1500);
  assert.equal(first.done, false, 'ripple still expanding at 500 ms');
  map.remove(); // removal lands between two rAF frames
  let second;
  assert.doesNotThrow(() => {
    second = rippleFrame(map, [], pings, 1000, 2000);
  });
  assert.equal(second.done, true, 'loop ends when the map is gone');
});

test('rippleFrame: future-dated createdAt (clock skew) stops at the 3 s wall-clock deadline', () => {
  const map = new FakeMapLibreMap();
  map.addSource('pakdam-pings', { type: 'geojson', data: collection([]) });
  const pings = [{ pingId: 'p1', createdAtMs: 61_000, centre: PATNA, radiusMeters: 150 }];
  assert.equal(rippleFrame(map, [], pings, 1000, 1000).done, false);
  assert.equal(rippleFrame(map, [], pings, 1000, 2000).done, false);
  assert.equal(rippleFrame(map, [], pings, 1000, 4000).done, true, '3 s deadline ends the loop');
});

// ---------------------------------------------------------------------------
// Tab switch: Radio → Map (resizeNonce bump + container resize)
// ---------------------------------------------------------------------------

test('handleMapTabReturn: hidden container (0-size, still on Radio) → no resize/fit/repaint, no throw, fit not consumed', () => {
  const map = new FakeMapLibreMap();
  const fitted = { current: false };
  const result = handleMapTabReturn(map, REAL_BOUNDARY, fitted, false);
  assert.deepEqual(result, { status: 'hidden', fitOutcome: null, fitError: null });
  assert.equal(map.resizeCount, 0);
  assert.equal(map.fitBoundsCount, 0);
  assert.equal(map.repaintCount, 0);
  assert.equal(fitted.current, false);
});

test('handleMapTabReturn: happy path resizes, fits, then repaints — in that order — and the camera lands on the zone', () => {
  const map = new FakeMapLibreMap();
  const fitted = { current: false };
  const result = handleMapTabReturn(map, REAL_BOUNDARY, fitted, true);
  assert.deepEqual(result, { status: 'resized', fitOutcome: 'fitted', fitError: null });
  assert.deepEqual(
    map.calls.map((c) => c.method),
    ['resize', 'fitBounds', 'triggerRepaint'],
  );
  assertCameraAtZone(map);
});

// (F12: the byte-identical FIXED twin of this test was removed — one
// assertion per behaviour, no padded count.)
test('REPRODUCTION (fails pre-fix — passes after the fix): Radio → Map must never throw — a failed first fit still repaints, leaves fitted=false, and the next return fits', () => {
  const map = new FakeMapLibreMap();
  map.failFitBoundsTimes(1);
  const fitted = { current: false };
  // FIX contract (play-map-logic.ts handleMapTabReturn): catch the fit
  // failure, leave fitted false, still triggerRepaint. A tab return
  // must never crash the app — the founder's Radio → Map crash was
  // exactly this path (1 of 2 attempts).
  // v26: the failure is REPORTED (fitError carries the real detail),
  // not swallowed — the caller can name it in the pill.
  let first;
  assert.doesNotThrow(() => {
    first = handleMapTabReturn(map, REAL_BOUNDARY, fitted, true);
  });
  assert.equal(first.status, 'resized');
  assert.equal(first.fitOutcome, null, 'no outcome: the fit threw');
  assert.match(first.fitError, /injected failure/);
  assert.equal(map.repaintCount, 1, 'repaint still runs so the canvas paints at its real size');
  assert.equal(fitted.current, false, 'failed fit does not consume the one fit');
  const second = handleMapTabReturn(map, REAL_BOUNDARY, fitted, true);
  assert.equal(second.status, 'resized');
  assert.equal(second.fitOutcome, 'fitted');
  assert.equal(second.fitError, null);
  assertCameraAtZone(map);
});

// ---------------------------------------------------------------------------
// v25 FIX ROUND (Diya + Zara review): the holes are closed here.
// ---------------------------------------------------------------------------

test('FIX ROUND (Zara 5): the sanitisers redact the encoded, camelCase and bare key= shapes — not just literal api_key=', () => {
  const cases = [
    'GET https://api.olamaps.io/tiles?api_key%3Dabc123secret failed',
    'GET https://api.olamaps.io/tiles?apiKey=abc123secret failed',
    'GET https://api.olamaps.io/tiles?key=abc123secret failed',
    'GET https://api.olamaps.io/tiles?api_key=abc123secret failed',
  ];
  for (const message of cases) {
    const detail = mapErrorDetail({ error: { status: 401, message } });
    assert.doesNotMatch(detail, /abc123secret/, message);
    assert.match(detail, /…/, message);
  }
  // The same shapes through unknownErrorDetail (the createOlaMap
  // rejection path: chunk download / WebGL init failures).
  for (const message of cases) {
    assert.doesNotMatch(unknownErrorDetail(new Error(message)), /abc123secret/, message);
  }
  // Words that merely contain "key" are NOT redacted (the ?/&/start/
  // whitespace prefix guard): a diagnostic mentioning turkey= stays readable.
  const innocent = mapErrorDetail({ error: { message: 'turkey=leg day failed' } });
  assert.match(innocent, /turkey=leg/);
});

test('FIX ROUND (Zara 6): mapErrorDetail / unknownErrorDetail do NOT throw on a non-string error.message', () => {
  // MapLibre's Evented.fire has no try/catch, so a TypeError here would
  // escape the error listener and the tile error itself would be lost.
  let objectMessage;
  assert.doesNotThrow(() => {
    objectMessage = mapErrorDetail({
      error: {
        status: 500,
        message: { url: 'https://api.olamaps.io/tiles?api_key=abc123secret' },
      },
    });
  });
  assert.doesNotMatch(
    objectMessage,
    /abc123secret/,
    'an object message stringifies to [object Object] — no URL leaks',
  );
  let numericMessage;
  assert.doesNotThrow(() => {
    numericMessage = mapErrorDetail({ error: { message: 12345 } });
  });
  assert.match(numericMessage, /12345/);
  // Same guard in unknownErrorDetail's Error.message branch.
  const weird = new Error('unused');
  weird.message = { url: 'https://example.com/?api_key=abc123secret' };
  let unknownDetail;
  assert.doesNotThrow(() => {
    unknownDetail = unknownErrorDetail(weird);
  });
  assert.doesNotMatch(unknownDetail, /abc123secret/);
});

test('FIX ROUND (Diya F4): post-load errors are labelled by resource — only a real tile failure is a "tile error"', () => {
  // A tile failure carries the tile on the event (maplibre-gl fires
  // ErrorEvent(err, { tile }) from the tile loader).
  const tile = classifyMapError(true, {
    error: { status: 401, message: 'Tile request failed 401' },
    tile: { tileID: { z: 14, x: 1, y: 2 } },
  });
  assert.equal(tile.kind, 'post-load-tile-error');
  assert.equal(tile.resource, 'tile');
  assert.equal(classifyPostLoadResource({ tile: {} }), 'tile');
  // Sprite / glyph failures fire a bare ErrorEvent(err) — message only.
  const sprite = classifyMapError(true, {
    error: { message: 'Failed to load sprite https://api.olamaps.io/sprite.json' },
  });
  assert.equal(sprite.resource, 'sprite');
  const glyph = classifyMapError(true, {
    error: { message: 'Failed to load glyphs: range 0-255' },
  });
  assert.equal(glyph.resource, 'glyph');
  // A style / TileJSON / source failure carries neither a tile nor a
  // sprite/glyph message — 'other', never 'tile'.
  const other = classifyMapError(true, {
    error: { message: 'Failed to load TileJSON' },
  });
  assert.equal(other.resource, 'other');
  assert.equal(resourceLabel('sprite'), 'sprite');
  assert.equal(resourceLabel('other'), 'resource');
  // The pill labels a non-tile failure honestly — no "tile" in it.
  const spritePill = pillTextForState('ready', 'ready', false, null, 0, null, false, false, {
    label: 'sprite',
    detail: 'sprite failed',
  });
  assert.match(spritePill, /sprite/i);
  assert.doesNotMatch(spritePill, /tile/i);
  // Pre-load failures are unchanged (no resource label needed — the
  // overlay shows the detail).
  const pre = classifyMapError(false, { error: { status: 401, message: 'x' } });
  assert.equal(pre.kind, 'pre-load-failure');
  assert.ok(!('resource' in pre));
});

test('FIX ROUND (Diya F2): tryFitZone reports a non-finite bbox as its own outcome instead of letting fitBounds throw', () => {
  // An [lng, lat]-array boundary (the pre-fix shape bug) bboxes to NaN.
  const asArrays = REAL_BOUNDARY.map((p) => [p.lng, p.lat]);
  const map = new FakeMapLibreMap();
  const fitted = { current: false };
  assert.equal(tryFitZone(fitted, map, asArrays, true), 'non-finite-bounds');
  assert.equal(map.fitBoundsCount, 0, 'fitBounds never called with a NaN bbox');
  assert.equal(fitted.current, false, 'the one fit is not consumed by a bad boundary');
  // A boundary with a NaN coordinate reports the same way.
  const nanBoundary = REAL_BOUNDARY.map((p, i) =>
    i === 0 ? { lng: Number.NaN, lat: p.lat } : p,
  );
  assert.equal(tryFitZone(fitted, map, nanBoundary, true), 'non-finite-bounds');
  assert.equal(map.fitBoundsCount, 0);
});

test('FIX ROUND (Diya F1): a failed first fit is retried WITHOUT a tab switch and lands — bounded retries only', () => {
  // The component's zone effect drives this loop: on a throwing fit it
  // asks nextFitRetryDelayMs for the delay, bumps its retry nonce, and
  // the effect re-runs tryFitZone. This test drives the same loop
  // directly (no handleMapTabReturn anywhere) against a map whose
  // first two fits throw.
  const map = new FakeMapLibreMap();
  map.failFitBoundsTimes(2);
  const fitted = { current: false };
  let retriesUsed = 0;
  let outcome = 'threw';
  assert.throws(() => tryFitZone(fitted, map, REAL_BOUNDARY, true), /injected failure/);
  while (!fitted.current) {
    const delay = nextFitRetryDelayMs(retriesUsed);
    assert.notEqual(delay, null, 'budget must cover the retries this map needs');
    assert.equal(delay, FIT_RETRY_DELAY_MS);
    retriesUsed += 1;
    try {
      outcome = tryFitZone(fitted, map, REAL_BOUNDARY, true);
    } catch {
      outcome = 'threw';
    }
  }
  assert.equal(outcome, 'fitted');
  assert.equal(retriesUsed, 2, 'two retries: the first retry threw, the second landed');
  assertCameraAtZone(map);
  // And the budget is bounded: a map that ALWAYS throws exhausts it.
  const dead = new FakeMapLibreMap();
  dead.failFitBoundsTimes(99);
  const deadFitted = { current: false };
  let used = 0;
  assert.throws(() => tryFitZone(deadFitted, dead, REAL_BOUNDARY, true));
  for (;;) {
    const delay = nextFitRetryDelayMs(used);
    if (delay === null) break;
    used += 1;
    assert.throws(() => tryFitZone(deadFitted, dead, REAL_BOUNDARY, true));
  }
  assert.equal(used, MAX_FIT_RETRIES, 'at most MAX_FIT_RETRIES automatic retries, then it stops');
  assert.equal(deadFitted.current, false);
});

test('FIX ROUND (Diya F3): a ready map with a 0-height area reports the height problem, not "Map ready"', () => {
  // The founder's live measurement: 526.4×0 — width real, height ZERO.
  assert.equal(mapAreaHasHeight({ width: 526.4, height: 0 }, { width: 526.4, height: 0 }), false);
  assert.equal(mapAreaHasHeight({ width: 526.4, height: 0 }, null), false);
  assert.equal(mapAreaHasHeight({ width: 526.4, height: 400 }, { width: 526.4, height: 0 }), false);
  assert.equal(mapAreaHasHeight({ width: 526.4, height: 400 }, { width: 526.4, height: 400 }), true);
  assert.equal(mapAreaHasHeight({ width: 526.4, height: 400 }, null), true, 'no canvas yet (pre-load) is not a height failure');
  const pill = pillTextForState('ready', 'ready', false, null, 0, null, false, true);
  assert.notEqual(pill, 'Map ready');
  assert.match(pill, /no height/i);
  assert.match(pill, /Retry/);
  // Height outranks even a fit failure / tile errors — a map area with
  // no height paints nothing at all.
  assert.match(
    pillTextForState('ready', 'fit failed', false, null, 2, 'HTTP 401', true, true),
    /no height/i,
  );
});

test('FIX ROUND (Diya F5): the tile-error ledger keeps the FIRST detail, never the last', () => {
  const first = recordTileError(EMPTY_TILE_LEDGER, 'HTTP 401 — tile failed', 1000);
  const second = recordTileError(first, 'HTTP 500 — tile failed', 2000);
  assert.equal(second.count, 2, 'two DISTINCT details count as two errors');
  assert.deepEqual(second.details, ['HTTP 401 — tile failed', 'HTTP 500 — tile failed']);
  assert.equal(second.details[0], 'HTTP 401 — tile failed', 'the pill shows the first detail');
  const pill = pillTextForState('ready', 'ready', false, null, second.count, second.details[0]);
  assert.match(pill, /HTTP 401/);
  assert.doesNotMatch(pill, /HTTP 500/);
});

test('FIX ROUND (Diya F4): the tile-error count is capped at MAX_TILE_ERROR_COUNT', () => {
  let ledger = EMPTY_TILE_LEDGER;
  for (let i = 0; i < MAX_TILE_ERROR_COUNT + 5; i++) {
    ledger = recordTileError(ledger, `HTTP 500 — tile ${i} failed`, 1000 + i);
  }
  assert.equal(ledger.count, MAX_TILE_ERROR_COUNT);
  assert.equal(ledger.details.length, MAX_TILE_ERROR_COUNT);
});

test('FIX ROUND (Diya F8): syncSource on a removed map returns false instead of throwing — no unguarded getSource/setData on a dead map', () => {
  const map = new FakeMapLibreMap();
  const layers = [{ id: 'pakdam-zone-fill', type: 'fill', source: 'pakdam-zone' }];
  assert.equal(syncSource(map, 'pakdam-zone', layers, collection([])), true);
  assert.equal(map.getSource('pakdam-zone').setDataCount, 1);
  map.remove();
  assert.doesNotThrow(() => {
    assert.equal(syncSource(map, 'pakdam-zone', layers, collection([])), false);
  });
  assert.equal(ensureMapSource(map, 'pakdam-zone'), false);
  assert.equal(ensureMapLayer(map, layers[0]), false);
  // And the normal path still writes through safeSetSourceData.
  const live = new FakeMapLibreMap();
  assert.equal(
    syncSource(live, 'pakdam-zone', layers, collection([polygonFeature(REAL_BOUNDARY)])),
    true,
  );
  assert.equal(live.getSource('pakdam-zone').data.features.length, 1);
});

test('FIX ROUND (Diya F13a): shrinkFrame reports whether the write landed — a failed frame must not be stored as displayed', () => {
  const map = new FakeMapLibreMap();
  map.addSource('pakdam-zone', { type: 'geojson', data: collection([]) });
  const start = circlePolygon(PATNA, 500, 8);
  const end = circlePolygon(PATNA, 375, 8);
  const first = shrinkFrame(map, start, end, 0, 500);
  assert.equal(first.wrote, true, 'the write landed');
  assert.equal(first.done, false);
  map.remove();
  const second = shrinkFrame(map, start, end, 0, 1000);
  assert.equal(second.wrote, false, 'no write landed on the removed map');
  assert.equal(second.done, true, 'loop ends');
  // The component only stores displayedBoundaryRef when wrote is true —
  // modelled here: a failed frame leaves the displayed boundary alone.
  let displayed = first.interpolated;
  if (second.wrote) displayed = second.interpolated;
  assert.deepEqual(displayed, first.interpolated);
});

test('FIX ROUND (Diya F6): handleMapTabReturn on a removed map never throws — resize throws on a destroyed painter and is caught', () => {
  const map = new FakeMapLibreMap();
  map.addSource('pakdam-zone', { type: 'geojson', data: collection([]) });
  map.remove();
  const fitted = { current: false };
  let result;
  assert.doesNotThrow(() => {
    result = handleMapTabReturn(map, REAL_BOUNDARY, fitted, true);
  });
  assert.equal(result.status, 'resized');
});

test('FIX ROUND (Zara 4): Retry is disabled while loading and for 2 s after a tap', () => {
  assert.equal(retryDisabled('loading', 10_000, null), true, 'loading: disabled even with no prior tap');
  assert.equal(retryDisabled('loading', 10_000, 9_000), true);
  assert.equal(retryDisabled('ready', 10_000, null), false, 'ready, never tapped: enabled');
  assert.equal(retryDisabled('ready', 10_000, 9_500), true, 'tapped 500 ms ago: still cooling down');
  assert.equal(
    retryDisabled('ready', 10_000, 10_000 - RETRY_COOLDOWN_MS),
    false,
    'cooldown spent: enabled',
  );
  assert.equal(retryDisabled('error', 10_000, 10_000 - RETRY_COOLDOWN_MS - 1), false);
});

// ---------------------------------------------------------------------------
// v26 FIX (Meera): the play map was STILL blank after v25 — founder
// screenshot 2026-11-21 ~21:30 IST, live room 73928e83, pill
// "Zone not in view — camera fit failed — ready" on a uniformly dark
// canvas (no tiles, no zone, no dot). Kabir exonerated the server:
// the snapshot boundary is current, finite, >= 3 points (281 m after
// 2 shrinks), so the failure is in the fit/camera path and/or tile
// loading on the client. The holes, all verified against the
// installed maplibre-gl 5.x build:
//  - fitBounds can silently do NOTHING: cameraForBounds returns
//    undefined (warn only, no throw) when the viewport cannot fit
//    the bounds — a stale zero-size transform — and fitBounds then
//    returns without moving the camera. v25 marked the fit consumed
//    on any non-throwing return.
//  - a deferred fit ('hidden' / 'cannot-fit') was never retried.
//  - the pill appended the stale 'ready' mapDetail to the fit flag,
//    and the fit flag outranked tile errors, hiding them.
//  - the 0-height check returned early on a 0-height container, so
//    the founder's exact 526.4×0 case could never surface.
// ---------------------------------------------------------------------------

test('v26 REPRODUCTION (fails pre-fix — passes after the fix): a fitBounds against a stale zero-size viewport silently does nothing in real MapLibre — and tryFitZone must NOT consume the one fit for it', () => {
  // The fake models the installed maplibre-gl 5.x behaviour exactly:
  // cameraForBounds returns undefined when the viewport cannot fit
  // the bounds (transform smaller than the padding), and fitBounds
  // then returns without moving the camera and without throwing.
  const map = new FakeMapLibreMap({ containerWidth: 0, containerHeight: 0 });
  assert.equal(map.cameraForBounds(boundaryBBox(REAL_BOUNDARY), { padding: 40 }), undefined);
  map.fitBounds(boundaryBBox(REAL_BOUNDARY), { padding: 40, duration: 0 });
  assertCameraAtRanchiDefault(map, 'silent no-op fit');
  // FIX contract (play-map-logic.ts tryFitZone): the cameraForBounds
  // pre-check reports 'cannot-fit' WITHOUT consuming the one fit.
  const fitted = { current: false };
  assert.equal(tryFitZone(fitted, map, REAL_BOUNDARY, true), 'cannot-fit');
  assert.equal(fitted.current, false, 'the one fit is not consumed by a no-op');
  assert.equal(map.fitBoundsCount, 1, 'fitBounds was called once above (directly) and never by tryFitZone');
  // The container gains size (a resize / tab return syncs the
  // transform) and the SAME fit attempt lands — no Retry needed.
  map.containerWidth = 660;
  map.containerHeight = 525;
  assert.notEqual(map.cameraForBounds(boundaryBBox(REAL_BOUNDARY), { padding: 40 }), undefined);
  assert.equal(tryFitZone(fitted, map, REAL_BOUNDARY, true), 'fitted');
  assertCameraAtZone(map);
});

test('v26: tryFitZone on a viewport too small for the padding (e.g. 60 px tall) is a deferral, not a failure — and a real-size viewport fits', () => {
  const tiny = new FakeMapLibreMap({ containerWidth: 526, containerHeight: 60 });
  const fitted = { current: false };
  assert.equal(tryFitZone(fitted, tiny, REAL_BOUNDARY, true), 'cannot-fit');
  assert.equal(fitted.current, false);
  assert.equal(tiny.fitBoundsCount, 0, 'fitBounds is never called when the camera cannot be computed');
  const roomy = new FakeMapLibreMap({ containerWidth: 526, containerHeight: 420 });
  assert.equal(tryFitZone(fitted, roomy, REAL_BOUNDARY, true), 'fitted');
  assertCameraAtZone(roomy);
});

test('v26: deferred fits share the bounded retry budget with throwing fits — landed / non-finite / no-boundary never retry', () => {
  // The component's zone effect drives this: on a deferred outcome
  // it asks fitRetryDelayForOutcome for the delay, bumps its retry
  // nonce, and the effect re-runs tryFitZone. A permanently-hidden
  // container stops after the budget is spent — it must not spin.
  for (const outcome of ['hidden', 'cannot-fit', 'threw']) {
    assert.equal(fitRetryDelayForOutcome(outcome, 0), FIT_RETRY_DELAY_MS, `${outcome}: retries while budget remains`);
    assert.equal(fitRetryDelayForOutcome(outcome, MAX_FIT_RETRIES - 1), FIT_RETRY_DELAY_MS);
    assert.equal(fitRetryDelayForOutcome(outcome, MAX_FIT_RETRIES), null, `${outcome}: budget spent, stop`);
  }
  for (const outcome of ['fitted', 'already-fitted', 'non-finite-bounds', 'no-boundary']) {
    assert.equal(fitRetryDelayForOutcome(outcome, 0), null, `${outcome}: never retried`);
  }
  // And the loop itself: a hidden container that gains size on the
  // third attempt lands within budget.
  const map = new FakeMapLibreMap({ containerWidth: 0, containerHeight: 0 });
  const fitted = { current: false };
  let retriesUsed = 0;
  let outcome = tryFitZone(fitted, map, REAL_BOUNDARY, true);
  assert.equal(outcome, 'cannot-fit');
  while (outcome !== 'fitted') {
    const delay = fitRetryDelayForOutcome(outcome, retriesUsed);
    assert.notEqual(delay, null, 'budget must cover the retries this map needs');
    retriesUsed += 1;
    if (retriesUsed === 2) {
      map.containerWidth = 660;
      map.containerHeight = 525;
    }
    outcome = tryFitZone(fitted, map, REAL_BOUNDARY, true);
  }
  assert.equal(retriesUsed, 2, 'two bounded retries, then the fit landed');
  assertCameraAtZone(map);
});

test('v26: handleMapTabReturn reports a cannot-fit instead of consuming the fit — a later return with a real viewport lands it', () => {
  const map = new FakeMapLibreMap({ containerWidth: 0, containerHeight: 0 });
  const fitted = { current: false };
  // hasSize=true (the container HAS size — the transform is stale,
  // e.g. constructed while hidden and never resized): resize runs,
  // the fit cannot be computed, the repaint still runs.
  const first = handleMapTabReturn(map, REAL_BOUNDARY, fitted, true);
  assert.equal(first.status, 'resized');
  assert.equal(first.fitOutcome, 'cannot-fit');
  assert.equal(first.fitError, null, 'a deferral is not a failure — no reason is recorded');
  assert.equal(fitted.current, false);
  assert.equal(map.repaintCount, 1);
  map.containerWidth = 660;
  map.containerHeight = 525;
  const second = handleMapTabReturn(map, REAL_BOUNDARY, fitted, true);
  assert.equal(second.fitOutcome, 'fitted');
  assertCameraAtZone(map);
});

test('v26: the fit pill uses the fit’s OWN reason — never the stale mapDetail — and a fit failure never hides a tile failure', () => {
  // The founder's exact screenshot pill: fit flag set, mapDetail
  // 'ready' (set on load). v25 appended mapDetail verbatim:
  // "Zone not in view — camera fit failed — ready". v26: the fit
  // branch never reads mapDetail.
  const stale = pillTextForState('ready', 'ready', false, null, 0, null, true, false, null, 'FakeMap fitBounds: injected failure (first fit throws)');
  assert.equal(
    stale,
    'Zone not in view — camera fit failed: FakeMap fitBounds: injected failure (first fit throws)',
  );
  assert.doesNotMatch(stale, /— ready$/);
  // A real failure AND tile errors are BOTH visible, joined.
  const both = pillTextForState(
    'ready', 'ready', false, null, 2, 'HTTP 401 — tile failed',
    true, false, null, 'zone boundary is not finite — camera cannot fit it',
  );
  assert.match(both, /camera fit failed: zone boundary is not finite/);
  assert.match(both, /Map tiles failing — 2 tile errors — HTTP 401/);
  // A fit failure with no reason falls back to plain words — never
  // to a stale detail.
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, true),
    'Zone not in view — camera fit failed: camera could not fit the zone',
  );
  // Tiles alone are unchanged.
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 2, 'HTTP 401 — tile failed'),
    'Map tiles failing — 2 tile errors — HTTP 401 — tile failed',
  );
});

test('v26: a merely-pending fit reads pending — not failed, not "Map ready" — and combines honestly with tile errors', () => {
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, true),
    'Camera moving to the zone…',
  );
  const pendingTiles = pillTextForState(
    'ready', 'ready', false, null, 1, 'HTTP 500 — tile failed',
    false, false, null, null, true,
  );
  assert.match(pendingTiles, /Map tiles failing — 1 tile error — HTTP 500/);
  assert.match(pendingTiles, /Camera moving to the zone…/);
  // Not pending, not failed, no tile errors: the healthy pill.
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, false),
    'Map ready',
  );
});

test('v26: diagnoseMapAreaHeight tells hidden-by-design apart from a real 0-height container — the founder’s exact 526.4×0 case', () => {
  // The founder's probe: a 526.4×0 rect while the pill said "Map
  // ready". v25 returned early on a 0-height container, so this
  // could never surface. The outer slot (min-h-[320px]) is the
  // witness: 0-height only while the wrapper is display:none.
  assert.equal(
    diagnoseMapAreaHeight({ width: 526.4, height: 420 }, { width: 526.4, height: 0 }, null),
    'container-zero-height',
    'visible tab (outer 420 tall) + 0-height container = a real defect',
  );
  assert.equal(
    diagnoseMapAreaHeight({ width: 526.4, height: 0 }, { width: 526.4, height: 0 }, null),
    'hidden-by-design',
    'outer 0-height (Radio / More tab, wrapper display:none) = by design, not a defect',
  );
  assert.equal(
    diagnoseMapAreaHeight({ width: 526.4, height: 420 }, { width: 526.4, height: 400 }, { width: 526.4, height: 0 }),
    'canvas-zero-height',
    'container fine + 0-height canvas = a real defect',
  );
  assert.equal(
    diagnoseMapAreaHeight({ width: 526.4, height: 420 }, { width: 526.4, height: 400 }, { width: 526.4, height: 400 }),
    'ok',
  );
  assert.equal(
    diagnoseMapAreaHeight({ width: 526.4, height: 420 }, { width: 526.4, height: 400 }, null),
    'ok',
    'no canvas yet (pre-load) is not a height failure',
  );
  // v27: with NO diagnosis passed (13th arg null — the legacy
  // default), the generic text still applies; the element-specific
  // texts need the diagnosis (see the v27 section at the end of this
  // file, and play-map-v27.test.mjs Section B).
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, true),
    'Map area has no height — try Retry',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, true, null, null, false, false, 'container-zero-height'),
    'Map container has no height — try Retry',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, true, null, null, false, false, 'canvas-zero-height'),
    'Map canvas has no height — try Retry',
  );
});

// ---------------------------------------------------------------------------
// v26 FIX ROUND (Diya / Zara / Arjun review of the v26 fix).
//
// B1: a permanently-pending fit never escalated, and the pill offered
// no Retry for it. B2: a manual Retry did not reset the fit-retry
// budget. A1: the exactly-80 px edge + the transient-size race. A2: a
// 'hidden' deferral could starve a later real throw of all timer
// retries. A3: PlayAreaMap's unguarded fitBounds. A4: the height-only
// diagnosis. A5: the outcome→action mapping + fire-vs-schedule
// accounting. A6: the nonce bump killing a mid-flight shrink
// animation (React-only — verified by code reading, see the note at
// the end of this section). A7: sanitiser hardening. D8: the
// material-change guard. D10: the zero-height detail clobbering a load
// failure. Arjun 5: the separator-ambiguous pill.
//
// What Node CANNOT test here (React-only, stated, not papered over):
//  - the Retry BUTTON being present while pending (the JSX condition
//    in PlayMap.tsx now includes `fitPending` — verified by reading
//    the condition, not by a test);
//  - the manual-Retry reset actually running on a tap (the
//    `resetFitRetryBudget` calls in `retryMap` / `startCreation` —
//    the reset itself is tested below, the call sites by reading);
//  - the shrink animation surviving a nonce bump (A6 — the fit effect
//    no longer lists the animation effect's deps; verified by
//    reading the two effects' dependency arrays: the zone effect is
//    [mapReady, zoneBoundary], the fit effect is [mapReady,
//    zoneBoundary, fitRetryNonce]).
// ---------------------------------------------------------------------------

test('v26 FIX ROUND (A7 — Zara 1–2): the sanitisers redact the double-encoded, JSON-colon and hyphen key forms', () => {
  const cases = [
    // Double-encoded: api_key%253D<value> (a URL encoded twice).
    'GET https://api.olamaps.io/tiles?api_key%253Dabc123secret failed',
    // JSON-colon: "api_key":"<value>" (a serialised error object).
    '{"error":{"message":"GET https://api.olamaps.io/tiles","api_key":"abc123secret"}}',
    '{"api_key": "abc123secret"}',
    // Hyphen form: api-key=<value>.
    'GET https://api.olamaps.io/tiles?api-key=abc123secret failed',
    // The v25 forms still redact (no regression).
    'GET https://api.olamaps.io/tiles?api_key%3Dabc123secret failed',
    'GET https://api.olamaps.io/tiles?apiKey=abc123secret failed',
    'GET https://api.olamaps.io/tiles?key=abc123secret failed',
  ];
  for (const message of cases) {
    const detail = mapErrorDetail({ error: { status: 401, message } });
    assert.doesNotMatch(detail, /abc123secret/, message);
    assert.match(detail, /…/, message);
  }
  for (const message of cases) {
    assert.doesNotMatch(unknownErrorDetail(new Error(message)), /abc123secret/, message);
  }
  // Words that merely contain "key" are still untouched.
  const innocent = mapErrorDetail({ error: { message: 'turkey=leg day failed' } });
  assert.match(innocent, /turkey=leg/);
  // A JSON object whose key is NOT an api key is untouched.
  const otherJson = mapErrorDetail({ error: { message: '{"id":"abc123secret"}' } });
  assert.match(otherJson, /abc123secret/);
});

test('v26 FIX ROUND (A1i — Diya 4): at exactly 80 px the real cameraForBounds returns a −∞-zoom camera — tryFitZone must treat it as cannot-fit, never call fitBounds', () => {
  // The fake models the installed maplibre-gl 5.24.1 exactly: strict
  // < 0 → undefined; == 0 → the −∞ camera. (80 px − 40 px padding × 2 = 0.)
  const edge = new FakeMapLibreMap({ containerWidth: 80, containerHeight: 420 });
  const camera = edge.cameraForBounds(boundaryBBox(REAL_BOUNDARY), { padding: 40 });
  assert.notEqual(camera, undefined, 'at exactly 0 available width the camera is DEFINED');
  assert.equal(camera.zoom, -Infinity, 'zoom is scaleZoom(0) = log2(0) = −∞');
  // A direct fitBounds there is the real break: the camera flies to −∞.
  edge.fitBounds(boundaryBBox(REAL_BOUNDARY), { padding: 40, duration: 0 });
  assert.equal(edge.camera().zoom, -Infinity, 'real fitBounds applies the −∞ camera — the break');
  // FIX contract (play-map-logic.ts cameraCanFitBounds / tryFitZone):
  // the guard rejects the −∞ camera BEFORE any fitBounds call.
  const guarded = new FakeMapLibreMap({ containerWidth: 80, containerHeight: 420 });
  assert.equal(cameraCanFitBounds(guarded, boundaryBBox(REAL_BOUNDARY), 40), false);
  const fitted = { current: false };
  assert.equal(tryFitZone(fitted, guarded, REAL_BOUNDARY, true), 'cannot-fit');
  assert.equal(guarded.fitBoundsCount, 0, 'fitBounds is never called with a −∞ camera');
  assert.equal(fitted.current, false, 'the one fit is not consumed');
  assert.ok(Number.isFinite(guarded.camera().zoom), 'the camera is still at its finite default');
  // Same edge on the height axis (420 × 80).
  const edgeH = new FakeMapLibreMap({ containerWidth: 420, containerHeight: 80 });
  assert.equal(cameraCanFitBounds(edgeH, boundaryBBox(REAL_BOUNDARY), 40), false);
  assert.equal(tryFitZone(fitted, edgeH, REAL_BOUNDARY, true), 'cannot-fit');
  assert.equal(edgeH.fitBoundsCount, 0);
  // And the guard still passes a real viewport / still rejects the < 0 cases.
  const roomy = new FakeMapLibreMap({ containerWidth: 660, containerHeight: 525 });
  assert.equal(cameraCanFitBounds(roomy, boundaryBBox(REAL_BOUNDARY), 40), true);
  const zero = new FakeMapLibreMap({ containerWidth: 0, containerHeight: 0 });
  assert.equal(cameraCanFitBounds(zero, boundaryBBox(REAL_BOUNDARY), 40), false);
  const tiny = new FakeMapLibreMap({ containerWidth: 526, containerHeight: 60 });
  assert.equal(cameraCanFitBounds(tiny, boundaryBBox(REAL_BOUNDARY), 40), false);
  // A non-finite bbox is not fittable either.
  const nanBbox = [[Number.NaN, 0], [1, 1]];
  assert.equal(cameraCanFitBounds(roomy, nanBbox, 40), false);
});

test('v26 FIX ROUND (A1ii — Diya 4): view bounds + zone-in-view + material-size change', () => {
  // viewBounds is centred on the camera centre at any zoom. (The
  // latitude midpoint in DEGREES is not exactly the centre latitude —
  // Mercator is non-linear in latitude, so a pixel-symmetric view
  // spans ~4e-7° asymmetrically in degrees at this zoom. The centre
  // check below therefore uses the pixel centre, and the midpoint
  // check allows that curvature.)
  const view = viewBounds(PATNA, 14, 660, 525);
  const [[minLng, minLat], [maxLng, maxLat]] = view;
  assert.ok(Math.abs((minLng + maxLng) / 2 - PATNA.lng) < 1e-9, 'view is centred on the camera lng');
  assert.ok(Math.abs((minLat + maxLat) / 2 - PATNA.lat) < 1e-6, 'view is centred on the camera lat (within Mercator curvature)');
  // At zoom 14, 660 px ≈ 0.028° lng; 525 px ≈ 0.020° lat at Patna.
  assert.ok(maxLng - minLng > 0.025 && maxLng - minLng < 0.032, `lng span ${maxLng - minLng}`);
  assert.ok(maxLat - minLat > 0.018 && maxLat - minLat < 0.023, `lat span ${maxLat - minLat}`);
  // A fitted 500 m Patna zone is in view; the Ranchi default is not.
  const map = new FakeMapLibreMap();
  assert.equal(zoneBboxInView(map, REAL_BOUNDARY, 660, 525), false, 'Ranchi default does not show Patna');
  const fitted = { current: false };
  assert.equal(tryFitZone(fitted, map, REAL_BOUNDARY, true), 'fitted');
  assert.equal(zoneBboxInView(map, REAL_BOUNDARY, 660, 525), true, 'after the fit the whole zone is in view');
  // A much smaller viewport at the same camera loses the zone.
  assert.equal(zoneBboxInView(map, REAL_BOUNDARY, 100, 80), false, 'a 100×80 view cannot hold the 500 m zone');
  // Material-size thresholds: ≥ 120 px or ≥ 25% in either dimension.
  assert.equal(isMaterialSizeChange({ width: 660, height: 525 }, { width: 660, height: 400 }), true, '125 px height change is material');
  assert.equal(isMaterialSizeChange({ width: 660, height: 525 }, { width: 700, height: 525 }), false, '40 px / 6% is layout jitter, not material');
  assert.equal(isMaterialSizeChange({ width: 660, height: 525 }, { width: 500, height: 525 }), true, '160 px width change is material');
  assert.equal(isMaterialSizeChange({ width: 100, height: 100 }, { width: 130, height: 100 }), true, '30% on a small container is material');
  assert.equal(isMaterialSizeChange({ width: 100, height: 100 }, { width: 120, height: 100 }), false, '20% on a small container is not');
  assert.equal(isMaterialSizeChange({ width: 660, height: 525 }, { width: 660, height: 525 }), false);
});

test('v26 FIX ROUND (A2 — Diya 5): separate budgets — 3× hidden must NOT starve a later real throw of all timer retries', () => {
  // The scenario: map loads on the Radio tab → zone effect 'hidden' →
  // timer retries ×3 over 6 s → budget spent; player returns to the
  // Map tab, first fit throws → the throw must still have timer
  // retries. A synchronous fake scheduler proves the accounting
  // without waiting 2 s per retry (the real setTimeout is the default
  // in production).
  const syncSchedule = (fn) => {
    fn();
    return 1;
  };
  const budget = createFitRetryBudget();
  let fired = 0;
  for (let i = 0; i < MAX_FIT_RETRIES; i++) {
    const timer = scheduleFitRetryTimer(budget, 'hidden', () => {
      fired += 1;
    }, syncSchedule);
    assert.notEqual(timer, null, `deferral retry ${i + 1} is scheduled`);
  }
  assert.equal(fired, MAX_FIT_RETRIES, '3 deferral timers fired');
  assert.equal(budget.deferredFired, MAX_FIT_RETRIES);
  assert.equal(budget.threwFired, 0, 'deferrals never touched the throw budget');
  // The deferral budget is spent — but the throw budget is fresh.
  assert.equal(scheduleFitRetryTimer(budget, 'hidden', () => {}, syncSchedule), null);
  assert.equal(fitRetryDelayForBudget('hidden', budget), null);
  assert.notEqual(fitRetryDelayForBudget('threw', budget), null, 'a real throw still has timer retries');
  const throwTimer = scheduleFitRetryTimer(budget, 'threw', () => {
    fired += 1;
  }, syncSchedule);
  assert.notEqual(throwTimer, null, 'the throw retry is scheduled');
  assert.equal(budget.threwFired, 1);
  assert.equal(fired, MAX_FIT_RETRIES + 1);
  // 'cannot-fit' shares the DEFERRAL budget with 'hidden'.
  const budget2 = createFitRetryBudget();
  for (let i = 0; i < MAX_FIT_RETRIES; i++) {
    assert.notEqual(scheduleFitRetryTimer(budget2, 'cannot-fit', () => {}, syncSchedule), null);
  }
  assert.equal(scheduleFitRetryTimer(budget2, 'hidden', () => {}, syncSchedule), null, 'hidden shares the spent deferral budget');
  assert.notEqual(scheduleFitRetryTimer(budget2, 'threw', () => {}, syncSchedule), null);
});

test('v26 FIX ROUND (A5ii — Diya 7a): the attempt is counted when the timer FIRES, not when scheduled — a cancelled timer burns nothing', () => {
  const budget = createFitRetryBudget();
  let fired = 0;
  // Scheduled but never fired (effect cleanup / StrictMode
  // double-invoke): no increment, budget intact.
  const pending = scheduleFitRetryTimer(budget, 'hidden', () => {
    fired += 1;
  }, () => 99);
  assert.notEqual(pending, null, 'scheduled');
  assert.equal(budget.deferredFired, 0, 'nothing fired yet — nothing counted');
  assert.equal(fired, 0);
  // The same budget still schedules (the cancelled attempt did not
  // consume one of the 3), and firing counts exactly once.
  const syncSchedule = (fn) => {
    fn();
    return 1;
  };
  assert.notEqual(scheduleFitRetryTimer(budget, 'hidden', () => {
    fired += 1;
  }, syncSchedule), null);
  assert.equal(budget.deferredFired, 1);
  assert.equal(fired, 1);
  // resetFitRetryBudget (the manual-Retry / new-boundary reset, B2/D8)
  // zeroes both counters in place.
  resetFitRetryBudget(budget);
  assert.deepEqual(budget, { deferredFired: 0, threwFired: 0 });
});

test('v26 FIX ROUND (A5i — Diya 7a): fitOutcomeAction maps all 7 outcomes + threw', () => {
  assert.deepEqual(fitOutcomeAction('fitted'), { action: 'landed' });
  assert.deepEqual(fitOutcomeAction('already-fitted'), { action: 'landed' });
  assert.deepEqual(fitOutcomeAction('non-finite-bounds'), {
    action: 'record-failure',
    reason: NON_FINITE_BOUNDS_REASON,
  });
  assert.equal(NON_FINITE_BOUNDS_REASON, 'zone boundary is not finite — camera cannot fit it');
  assert.deepEqual(fitOutcomeAction('hidden'), { action: 'retry', outcome: 'hidden', reason: null });
  assert.deepEqual(fitOutcomeAction('cannot-fit'), { action: 'retry', outcome: 'cannot-fit', reason: null });
  assert.deepEqual(fitOutcomeAction('threw', 'FakeMap fitBounds: injected failure'), {
    action: 'retry',
    outcome: 'threw',
    reason: 'FakeMap fitBounds: injected failure',
  });
  assert.deepEqual(fitOutcomeAction('threw'), {
    action: 'retry',
    outcome: 'threw',
    reason: 'camera could not fit the zone',
  });
  assert.deepEqual(fitOutcomeAction('no-boundary'), { action: 'none' });
  // The mapping agrees with the retry-delay table: only hidden /
  // cannot-fit / threw ever schedule a timer.
  for (const outcome of ['fitted', 'already-fitted', 'non-finite-bounds', 'no-boundary']) {
    assert.equal(fitRetryDelayForOutcome(outcome, 0), null, `${outcome}: never retried`);
  }
  for (const outcome of ['hidden', 'cannot-fit', 'threw']) {
    assert.equal(fitRetryDelayForOutcome(outcome, 0), FIT_RETRY_DELAY_MS, `${outcome}: retried`);
  }
});

test('v26 FIX ROUND (B1 — Diya 1): a spent deferred budget escalates pending → failed with a reason', () => {
  // The exact scenario: container 0 px wide × 420 px tall (width-0
  // is invisible to the height-only diagnosis) → tryFitZone returns
  // 'hidden' → timer retries ×3 over 6 s → budget spent → the pill
  // must read failed-with-a-reason, not "Camera moving to the zone…"
  // forever. The escalation reason is a pure function of the outcome;
  // the component sets it the moment the timer returns null.
  const hiddenReason = fitEscalationReason('hidden');
  assert.equal(hiddenReason, 'camera could not fit the zone after 3 attempts — the map area never gained size');
  const cannotFitReason = fitEscalationReason('cannot-fit');
  assert.equal(cannotFitReason, 'camera could not fit the zone after 3 attempts — the viewport cannot fit the zone');
  // The pill with that reason is a failure pill (with Retry offered by
  // the component — the JSX condition now includes fitPending too, so
  // Retry is present even BEFORE escalation; verified by reading the
  // condition in PlayMap.tsx, not by this test).
  const pill = pillTextForState('ready', 'ready', false, null, 0, null, true, false, null, hiddenReason);
  assert.equal(pill, `Zone not in view — camera fit failed: ${hiddenReason}`);
  // And the budget-spent state that triggers it, driven end to end
  // through the real timer helper with a synchronous scheduler:
  const budget = createFitRetryBudget();
  const syncSchedule = (fn) => {
    fn();
    return 1;
  };
  let outcome = 'hidden';
  for (let i = 0; i < MAX_FIT_RETRIES; i++) {
    assert.notEqual(scheduleFitRetryTimer(budget, outcome, () => {}, syncSchedule), null);
  }
  assert.equal(scheduleFitRetryTimer(budget, outcome, () => {}, syncSchedule), null, 'budget spent — the caller escalates');
  // The same width-0 container via the height diagnosis: 0×420 is a
  // zero-SIZE defect (A4), not 'ok' — see the A4 test below.
  assert.equal(
    diagnoseMapAreaHeight({ width: 526.4, height: 420 }, { width: 0, height: 420 }, null),
    'container-zero-size',
  );
});

test('v26 FIX ROUND (A3 — Diya 3): a zero-size setup-map fit does not consume the fit', () => {
  // tryFitSetupZone is the exact production function PlayAreaMap's
  // zone effect calls; lastFittedRadiusRef is assigned only when it
  // returns true (verified by reading PlayAreaMap.tsx:403).
  const map = new FakeMapLibreMap({ containerWidth: 0, containerHeight: 0 });
  assert.equal(tryFitSetupZone(map, REAL_BOUNDARY, false), false, 'no size → no fit');
  assert.equal(map.fitBoundsCount, 0);
  assert.equal(tryFitSetupZone(map, REAL_BOUNDARY, true), false, 'hasSize lies but the viewport is 0-size → no fit');
  assert.equal(map.fitBoundsCount, 0, 'fitBounds never called on a silent no-op viewport');
  // Exactly-80 px: the −∞ camera — no fit, no consumption.
  const edge = new FakeMapLibreMap({ containerWidth: 80, containerHeight: 420 });
  assert.equal(tryFitSetupZone(edge, REAL_BOUNDARY, true), false);
  assert.equal(edge.fitBoundsCount, 0);
  assert.ok(Number.isFinite(edge.camera().zoom), 'the camera was not flown to −∞');
  // A real viewport fits, with the animated 500 ms fit.
  const roomy = new FakeMapLibreMap({ containerWidth: 660, containerHeight: 525 });
  assert.equal(tryFitSetupZone(roomy, REAL_BOUNDARY, true), true);
  assert.equal(roomy.fitBoundsCount, 1);
  assert.deepEqual(roomy.callsOf('fitBounds')[0].options, { padding: 40, duration: 500 });
  const cam = roomy.camera();
  assert.ok(Math.abs(cam.centre[0] - PATNA.lng) < 0.001);
  assert.ok(Math.abs(cam.centre[1] - PATNA.lat) < 0.001);
  // A throwing fitBounds does not escape and does not land.
  const throwing = new FakeMapLibreMap();
  throwing.failFitBoundsTimes(1);
  assert.equal(tryFitSetupZone(throwing, REAL_BOUNDARY, true), false);
  assert.equal(throwing.fitBoundsCount, 1);
  // <3-point and non-finite boundaries never fit.
  assert.equal(tryFitSetupZone(roomy, [], true), false);
  const asArrays = REAL_BOUNDARY.map((p) => [p.lng, p.lat]);
  assert.equal(tryFitSetupZone(roomy, asArrays, true), false);
});

test('v26 FIX ROUND (A4 — Diya 6): diagnoseMapAreaHeight checks width too — the exact 0×420 case', () => {
  assert.equal(
    diagnoseMapAreaHeight({ width: 526.4, height: 420 }, { width: 0, height: 420 }, null),
    'container-zero-size',
    'visible tab + 0-width container = a real defect, not ok',
  );
  assert.equal(
    diagnoseMapAreaHeight({ width: 526.4, height: 420 }, { width: 526.4, height: 400 }, { width: 0, height: 400 }),
    'canvas-zero-size',
    'container fine + 0-width canvas = a real defect',
  );
  // The height cases are unchanged.
  assert.equal(
    diagnoseMapAreaHeight({ width: 526.4, height: 420 }, { width: 526.4, height: 0 }, null),
    'container-zero-height',
  );
  assert.equal(
    diagnoseMapAreaHeight({ width: 526.4, height: 0 }, { width: 526.4, height: 0 }, null),
    'hidden-by-design',
    'outer 0-height (Radio / More tab, wrapper display:none) = by design',
  );
  assert.equal(
    diagnoseMapAreaHeight({ width: 526.4, height: 420 }, { width: 526.4, height: 400 }, { width: 526.4, height: 400 }),
    'ok',
  );
  // The zero-width pill text, and height still outranks width.
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, false, true),
    'Map area has no width — try Retry',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, true, null, null, false, true),
    'Map area has no height — try Retry',
    'both dimensions zero on a visible tab reads as the height defect (legacy generic text with no diagnosis passed)',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, true),
    'Map area has no height — try Retry',
  );
});

test('v26 FIX ROUND (D8 — Diya 8): the budget resets only on a MATERIAL boundary change — float jitter grants nothing', () => {
  const shrink = circlePolygon(PATNA, 375, 64);
  assert.equal(boundaryChangedMaterially(null, REAL_BOUNDARY), true, 'first boundary is a change');
  assert.equal(boundaryChangedMaterially(REAL_BOUNDARY, REAL_BOUNDARY), false, 'identical boundary is not a change');
  // A snapshot re-serialised with float jitter (each coord + 1e-9°):
  // a fresh identity, but NOT a material change.
  const jittered = REAL_BOUNDARY.map((p) => ({ lng: p.lng + 1e-9, lat: p.lat - 1e-9 }));
  assert.equal(boundaryChangedMaterially(REAL_BOUNDARY, jittered), false, 'jitter must not mint a fresh budget');
  // A real shrink moves vertices ~1e-3° — material.
  assert.equal(boundaryChangedMaterially(REAL_BOUNDARY, shrink), true, 'a shrink is material');
  // A vertex-count change is material.
  assert.equal(boundaryChangedMaterially(REAL_BOUNDARY, REAL_BOUNDARY.slice(0, 32)), true);
  // A sub-tolerance move is not; a 2e-6° move is.
  const tinyMove = REAL_BOUNDARY.map((p, i) => (i === 0 ? { lng: p.lng + 5e-7, lat: p.lat } : p));
  assert.equal(boundaryChangedMaterially(REAL_BOUNDARY, tinyMove), false);
  const smallMove = REAL_BOUNDARY.map((p, i) => (i === 0 ? { lng: p.lng + 2e-6, lat: p.lat } : p));
  assert.equal(boundaryChangedMaterially(REAL_BOUNDARY, smallMove), true);
});

test('v26 FIX ROUND (Arjun 5): the combined pill is separator-unambiguous — the fit reason follows a colon, not a third dash', () => {
  // A fit reason that itself contains ' — ' (the escalation reason)
  // plus tile errors: the outer structure splits on ' · ' and the fit
  // part on ': ' — there is exactly one colon-delimited reason.
  const reason = fitEscalationReason('cannot-fit');
  const pill = pillTextForState(
    'ready', 'ready', false, null, 2, 'HTTP 401 — tile failed',
    true, false, null, reason,
  );
  assert.equal(
    pill,
    'Zone not in view — camera fit failed: camera could not fit the zone after 3 attempts — the viewport cannot fit the zone · Map tiles failing — 2 tile errors — HTTP 401 — tile failed',
  );
  assert.equal(pill.split(' · ').length, 2, 'two parts, joined once');
  assert.ok(pill.split(' · ')[0].startsWith('Zone not in view — camera fit failed: '));
});

// NOTE (A6 — Diya 7b, React-only): the nonce bump killing a mid-flight
// shrink animation cannot be exercised under Node — there is no React
// here. The fix is structural: the fit attempt lives in its own
// effect (deps [mapReady, zoneBoundary, fitRetryNonce]) and the zone
// overlay + shrink-animation effect lists only [mapReady,
// zoneBoundary], so a fit-retry timer firing mid-shrink re-runs the
// fit effect only — its cleanup never cancels the animation's rAF.
// Verified by reading PlayMap.tsx: the string 'fitRetryNonce' appears
// in the fit effect's dependency array and NOWHERE in the zone
// effect's. The founder's live check (a shrink landing while a fit
// retry is pending) is the verdict for the animation itself.

// ---------------------------------------------------------------------------
// v27 FIX (Meera — the play map was STILL blank after v26, founder
// 2026-11-21 ~23:33 IST, pill "Map area has no height — try Retry",
// Retry changed nothing).
//
// ROOT CAUSE (proven from the built CSS, not assumed): the element
// with no height was the CONTAINER. `new Map` adds MapLibre's
// `.maplibregl-map` class to the container div; that rule is UNLAYERED
// (maplibre-gl.css carries no `@layer`) while Tailwind v4 puts
// `.absolute` in `@layer utilities` — and unlayered author CSS beats
// ANY layered rule, so `.maplibregl-map{position:relative}` overrode
// the container's Tailwind `absolute`. A `relative` div gets NO size
// from `inset-0`, and its only children (canvas container + control
// container) are absolutely positioned, out of flow — so the container
// collapsed to exactly 526.4×0 (the founder's measurement) while the
// outer stayed 420. The container also inherits
// `.maplibregl-map{overflow:hidden}`, so the 526×300 canvas MapLibre
// sized from the 0-height container (400×300 fallback) was clipped to
// zero — completely blank. Every rebuild re-adds the class, so Retry
// could never change the outcome. The setup map paints because its
// container is a block div with an explicit inline `style={{height}}`.
// The fix (PlayMap.tsx, React-only — stated, not papered over): the
// container now ALSO carries `h-full w-full`, so its size no longer
// depends on `position:absolute` at all.
//
// What Node CAN test here (this section): the pill names WHICH
// element has no height, and a zero-height area still outranks every
// other ready-state failure for BOTH kinds.
//
// What Node CANNOT test here (React/DOM-only, stated):
//  - the container actually measuring 526×420 once `h-full w-full`
//    is present (the class string in PlayMap.tsx — verified by
//    reading the JSX, and by the production build regenerating the
//    `.h-full` / `.w-full` rules, which are already in the bundle);
//  - the canvas verify (resize + repaint + one bounded rebuild) and
//    the visibilitychange / window-resize re-measure (the callbacks
//    in PlayMap.tsx — verified by reading them, not by a test);
//  - the Retry re-measure before rebuilding: v27 fix round (Diya
//    Advisory 3) REMOVED the dead `checkMapAreaHeight()` call from
//    `retryMap` — it wiped everything it set, and the real
//    re-measure is the creation effect's build gate, which re-runs
//    on the retryNonce bump (verified by reading).
// ---------------------------------------------------------------------------

test('v27: the 0-height pill names the element — container vs canvas — and still outranks everything else', () => {
  // The founder's exact pill, with the element named: the v25/v26
  // text ("Map area has no height") could never pin it. The 13th
  // argument is the live diagnosis (play-map-v27.test.mjs Section B
  // pins the same contract exhaustively).
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, true, null, null, false, false, 'container-zero-height'),
    'Map container has no height — try Retry',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, true, null, null, false, false, 'canvas-zero-height'),
    'Map canvas has no height — try Retry',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, false, true, 'container-zero-size'),
    'Map container has no width — try Retry',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, false, true, 'canvas-zero-size'),
    'Map canvas has no width — try Retry',
  );
  // Zero height still outranks a fit failure AND tile errors, for
  // both elements (D9 — a 0-height area paints nothing at all).
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 2, 'HTTP 401', true, true, null, 'camera could not fit the zone', false, false, 'container-zero-height'),
    'Map container has no height — try Retry',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 2, 'HTTP 401', true, true, null, 'camera could not fit the zone', false, false, 'canvas-zero-height'),
    'Map canvas has no height — try Retry',
  );
  // No diagnosis (null) keeps the legacy generic texts.
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, true, null, null, false, false, null),
    'Map area has no height — try Retry',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, false, true, null),
    'Map area has no width — try Retry',
  );
});

test('v27: mapBuildDecision — build into a sized container, defer into a flat one', () => {
  assert.equal(mapBuildDecision('ok'), 'build');
  assert.equal(mapBuildDecision('canvas-zero-height'), 'build');
  assert.equal(mapBuildDecision('canvas-zero-size'), 'build');
  assert.equal(mapBuildDecision('hidden-by-design'), 'defer');
  assert.equal(mapBuildDecision('container-zero-height'), 'defer');
  assert.equal(mapBuildDecision('container-zero-size'), 'defer');
});

test('v27: canvasMatchesContainer — 1 px tolerance absorbs a fractional container rect; canvasRepairStep — one re-resize, then recreate', () => {
  assert.equal(
    canvasMatchesContainer({ width: 526, height: 420 }, { width: 526.4, height: 420 }),
    true,
  );
  assert.equal(
    canvasMatchesContainer({ width: 526, height: 420 }, { width: 526.4, height: 420 }, 0),
    false,
  );
  assert.equal(
    canvasMatchesContainer({ width: 400, height: 300 }, { width: 526.4, height: 420 }),
    false,
  );
  assert.equal(canvasRepairStep(0), 're-resize');
  assert.equal(canvasRepairStep(1), 'recreate');
  assert.equal(canvasRepairStep(2), 'recreate');
});

// ---------------------------------------------------------------------------
// v27 FIX ROUND (Meera — Diya AT RISK 1+2, Zara Advisory 1–4, Diya
// Advisory 3): the review round after v27.
//  F1: apps/web/test/*.test.mjs now runs in `pnpm --filter
//      pakdam-web test`, wired into the root `test` script before
//      test:e2e (package.json — verified by running it, not by a
//      test in this file).
//  F2: a deferred build is no longer a dead end — Retry stays
//      enabled while deferred (cooldown only) and re-runs the gate.
//  F3: the pill re-sanitises at its boundary, and the sanitiser
//      covers the encoded-underscore, colon-space and bare-key forms.
//  F4: retryMap guards on the same predicate as the button.
//  F5: retryMap's dead re-measure call is removed (see the v27
//      "verified by reading" note above — updated, not deleted).
// What Node CANNOT test here (React/DOM-only, stated): the
// `isDeferred` state flips at the two defer sites in PlayMap.tsx
// and clears in startCreation, and the retryNonce bump re-running
// the creation effect's gate — the predicate tests below pin the
// exact values those sites read and write, and the wiring is
// verified by reading PlayMap.tsx (retryMap / retryIsDisabled /
// the creation effect), not by a test.
// ---------------------------------------------------------------------------

test('v27 FIX ROUND (F2 — Diya AT RISK 2): Retry is ENABLED while the build is deferred, and the cooldown still applies', () => {
  // (a) Retry enabled while deferred: mapState stays 'loading' while
  // the gate defers, but the loading block must not apply — the map
  // is not loading, nothing is in flight to abort.
  assert.equal(retryDisabled('loading', 10_000, null, true), false, 'deferred, never tapped: enabled');
  // (b) A deferred Retry tap re-runs the gate: the tap passes the
  // guard (this predicate — see the F4 test), so retryMap bumps
  // retryNonce and the creation effect re-runs the gate
  // (PlayMap.tsx retryMap → retryNonce → creation effect). The
  // gate, not the button, decides build vs defer on the live
  // diagnosis — the button's job is only to let the tap through.
  assert.equal(retryDisabled('loading', 10_000, null, true), false, 'deferred tap passes the guard → gate re-runs');
  // (c) Cooldown still enforced after a deferred Retry tap: a tap
  // stamps lastRetryAtMs, so the next tap inside 2 s is blocked
  // even while deferred — the escape is manual, not a hammer.
  assert.equal(retryDisabled('loading', 10_000, 9_500, true), true, 'deferred, tapped 500 ms ago: still cooling down');
  assert.equal(
    retryDisabled('loading', 10_000, 10_000 - RETRY_COOLDOWN_MS, true),
    false,
    'deferred, cooldown spent: enabled again',
  );
  // (d) Normal loading still disables Retry — the exception is the
  // deferred flag, not loading as such.
  assert.equal(retryDisabled('loading', 10_000, null, false), true, 'loading, not deferred: disabled');
  assert.equal(retryDisabled('loading', 10_000, null), true, 'default isDeferred=false: loading still disables');
  assert.equal(retryDisabled('loading', 10_000, 9_000, false), true);
  // Non-loading states are unchanged by the flag (the cooldown is
  // the only block there, deferred or not).
  assert.equal(retryDisabled('ready', 10_000, null, true), false);
  assert.equal(retryDisabled('ready', 10_000, 9_500, true), true);
  assert.equal(retryDisabled('error', 10_000, 10_000 - RETRY_COOLDOWN_MS - 1, true), false);
});

test('v27 FIX ROUND (F2): retryCooldownActive — the 2 s window, boundary-exact', () => {
  assert.equal(retryCooldownActive(10_000, null), false, 'never tapped: no cooldown');
  assert.equal(retryCooldownActive(10_000, 9_500), true, 'tapped 500 ms ago: cooling down');
  assert.equal(
    retryCooldownActive(10_000, 10_000 - RETRY_COOLDOWN_MS),
    false,
    'exactly RETRY_COOLDOWN_MS ago: window spent',
  );
  assert.equal(retryCooldownActive(10_000, 10_000 - RETRY_COOLDOWN_MS - 1), false);
});

test('v27 FIX ROUND (F4 — Zara Advisory 3): retryMap\'s internal guard — loading (non-deferred) is a no-op, deferred proceeds', () => {
  // The guard in PlayMap.tsx retryMap is `if (retryDisabled(mapState,
  // Date.now(), lastRetryAtMs, isDeferred)) return;` — the SAME
  // predicate the button reads (retryIsDisabled), so guard and
  // button can never disagree. Node cannot mount the component, so
  // this pins the predicate the guard reads, with the exact argument
  // shape the guard passes (mapState first, isDeferred last).
  assert.equal(
    retryDisabled('loading', 10_000, null, false),
    true,
    'loading, non-deferred: guard blocks — retryMap is a no-op, the in-flight creation is not aborted',
  );
  assert.equal(
    retryDisabled('loading', 10_000, null, true),
    false,
    'loading, deferred: guard lets the tap through — the deferred escape is not blocked by its own guard',
  );
  assert.equal(
    retryDisabled('loading', 10_000, 9_500, true),
    true,
    'deferred but cooling down: guard blocks — the cooldown is enforced by the guard too',
  );
  assert.equal(retryDisabled('error', 10_000, null, false), false, 'error: guard lets the tap through');
  assert.equal(retryDisabled('ready', 10_000, null, false), false, 'ready: guard lets the tap through');
});

test('v27 FIX ROUND (F3 — Zara Advisory 1–2): the sanitisers redact the encoded-underscore, colon-space and bare-key forms', () => {
  const bareKey = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3z'; // 36 chars, letters + digits
  const cases = [
    // Encoded underscore in the name: api%5Fkey%3D<value> (and %5f lowercase, plain =).
    'GET https://api.olamaps.io/tiles?api%5Fkey%3Dabc123secret failed',
    'GET https://api.olamaps.io/tiles?api%5fkey=abc123secret failed',
    // Colon-space form, unquoted and quoted, api_key / api-key / bare key.
    'Invalid api_key: abc123secret — check the key',
    'Invalid api-key: abc123secret',
    'key: abc123secret is not valid',
    'api_key: "abc123secret"',
    // Bare key value with no parameter name at all.
    `tile request failed for ${bareKey}`,
  ];
  for (const message of cases) {
    const detail = mapErrorDetail({ error: { status: 401, message } });
    assert.doesNotMatch(detail, /abc123secret/, message);
    assert.doesNotMatch(detail, new RegExp(bareKey), message);
    assert.match(detail, /…/, message);
  }
  // The same shapes through unknownErrorDetail (the createOlaMap
  // rejection path).
  for (const message of cases) {
    assert.doesNotMatch(unknownErrorDetail(new Error(message)), /abc123secret/, message);
    assert.doesNotMatch(unknownErrorDetail(new Error(message)), new RegExp(bareKey), message);
  }
  // Words that merely contain "key" are NOT redacted — the prefix
  // guards on the param and colon forms (turkey=, donkey=, monkey:).
  const innocent = mapErrorDetail({ error: { message: 'turkey=leg day failed' } });
  assert.match(innocent, /turkey=leg/);
  const monkey = pillTextForState('loading', 'monkey: business as usual', false, null);
  assert.equal(monkey, 'Map loading — monkey: business as usual');
  // A long token that is NOT key-like is left alone: all letters
  // (a word) or all digits (a count) with no parameter name.
  const allLetters = pillTextForState('ready', 'ready', false, null, 1, 'a'.repeat(36));
  assert.match(allLetters, /a{36}/, '36 letters, no digit: not a bare key');
  const allDigits = pillTextForState('ready', 'ready', false, null, 1, '1'.repeat(36));
  assert.match(allDigits, /1{36}/, '36 digits, no letter: not a bare key');
});

test('v27 FIX ROUND (F3 — Zara Advisory 1–2): an unsanitised detail passed to pillTextForState comes out redacted — the pill is the last boundary', () => {
  // Every current producer sanitises at source; these go in RAW, as
  // a future unsanitised producer would, and the pill must redact.
  const tilePill = pillTextForState(
    'ready', 'ready', false, null, 1,
    'GET https://api.olamaps.io/tiles?api%5Fkey%3Dabc123secret failed',
  );
  assert.doesNotMatch(tilePill, /abc123secret/);
  assert.match(tilePill, /api%5Fkey%3D…/);
  const fitPill = pillTextForState(
    'ready', 'ready', false, null, 0, null, true, false, null, 'api_key: abc123secret',
  );
  assert.doesNotMatch(fitPill, /abc123secret/);
  assert.match(fitPill, /camera fit failed: api_key: …/);
  const resourcePill = pillTextForState(
    'ready', 'ready', false, null, 0, null, false, false,
    { label: 'sprite', detail: 'api_key=abc123secret' },
  );
  assert.doesNotMatch(resourcePill, /abc123secret/);
  assert.match(resourcePill, /Map sprite failing — api_key=…/);
  const loadingPill = pillTextForState('loading', 'style failed api_key=abc123secret', false, null);
  assert.doesNotMatch(loadingPill, /abc123secret/);
  assert.match(loadingPill, /api_key=…/);
  const barePill = pillTextForState(
    'ready', 'ready', false, null, 1,
    'tile failed for aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3z',
  );
  assert.doesNotMatch(barePill, /aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3z/);
});

test('v27 FIX ROUND (F3): the pill-boundary re-sanitisation does NOT mangle legitimate pill text', () => {
  // Exact legitimate texts, byte-identical through pillTextForState.
  assert.equal(pillTextForState('ready', 'ready', false, null), 'Map ready');
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, true, false, null, 'camera could not fit the zone'),
    'Zone not in view — camera fit failed: camera could not fit the zone',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 2, 'HTTP 401 — Unauthorized'),
    'Map tiles failing — 2 tile errors — HTTP 401 — Unauthorized',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, true),
    'Camera moving to the zone…',
  );
  assert.equal(
    pillTextForState('loading', 'creating map… (attempt 1)', false, 5),
    'Map loading — creating map… (attempt 1) · 5s',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, true, null, null, false, false, 'container-zero-height'),
    'Map container has no height — try Retry',
  );
  assert.equal(
    pillTextForState('error', 'HTTP 401 — tile failed', false, null),
    'Map error — HTTP 401 — tile failed',
  );
});
