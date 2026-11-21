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
  mapAreaHasHeight,
  retryDisabled,
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
  assert.equal(handleMapTabReturn(map, REAL_BOUNDARY, fitted, false), 'hidden');
  assert.equal(map.resizeCount, 0);
  assert.equal(map.fitBoundsCount, 0);
  assert.equal(map.repaintCount, 0);
  assert.equal(fitted.current, false);
});

test('handleMapTabReturn: happy path resizes, fits, then repaints — in that order — and the camera lands on the zone', () => {
  const map = new FakeMapLibreMap();
  const fitted = { current: false };
  assert.equal(handleMapTabReturn(map, REAL_BOUNDARY, fitted, true), 'resized');
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
  assert.doesNotThrow(() => handleMapTabReturn(map, REAL_BOUNDARY, fitted, true));
  assert.equal(map.repaintCount, 1, 'repaint still runs so the canvas paints at its real size');
  assert.equal(fitted.current, false, 'failed fit does not consume the one fit');
  assert.equal(handleMapTabReturn(map, REAL_BOUNDARY, fitted, true), 'resized');
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
  assert.equal(result, 'resized');
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
