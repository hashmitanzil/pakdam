import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

/**
 * v28-doubletap.test.mjs — double-tap zoom is a LIBRARY DEFAULT (Diya F4).
 *
 * STOP: the v28 brief claimed no double-tap handling exists in the
 * installed maplibre-gl 5.24.1 bundle. That is WRONG — verified in the
 * installed dist (`node_modules/maplibre-gl/dist/maplibre-gl-dev.js`):
 *  - `TapZoomHandler` (:66581) — `_zoomIn` is a `TapRecognizer`
 *    ({numTouches: 1, numTaps: 2}: single-finger double-tap → zoom
 *    in +1, around the tap point) and `_zoomOut` is
 *    ({numTouches: 2, numTaps: 1}: two-finger single tap → zoom out
 *    −1, around the tap point);
 *  - registered (:68474-68479) as `tapZoom` / `clickZoom` under one
 *    `DoubleClickZoomHandler`, enabled when `options.interactive &&
 *    options.doubleClickZoom`;
 *  - defaults (:71233, :71256-71257) are `interactive: true`,
 *    `doubleClickZoom: true`, `touchZoomRotate: true`;
 *  - `createOlaMap` (maplibre.ts) passes NEITHER `interactive` NOR
 *    `doubleClickZoom`, so the defaults apply — the built-in is ON.
 * A custom handler would have double-zoomed every double-tap, so
 * NONE is built. The likelier cause of the founder's report is the
 * 0-height map (v27, fixed): with a 526×0 container there was no
 * tap target and no tiles to zoom into. The verdict is the founder's
 * live check on the healthy map; if the built-in is proven not to
 * fire there, only then is a replacement built — with the built-in
 * disabled first.
 *
 * This test pins the dist facts above so a future upgrade (or a
 * future "build double-tap" brief) re-verifies them instead of
 * assuming the handler is missing.
 */

const require = createRequire(import.meta.url);
const distPath = require.resolve('maplibre-gl/dist/maplibre-gl-dev.js');
const dist = readFileSync(distPath, 'utf8');

test('F4: the installed dist ships TapZoomHandler (double-tap in, two-finger tap out)', () => {
  assert.match(dist, /class TapZoomHandler/);
  // Single-finger double-tap → zoom in.
  assert.match(dist, /numTouches: 1,\s*numTaps: 2/);
  // Two-finger single tap → zoom out.
  assert.match(dist, /numTouches: 2,\s*numTaps: 1/);
  // Both ease ±1 around the tap point.
  assert.match(dist, /zoom: symbol_layout\.evaluateZoomSnap\(tr\.zoom \+ 1/);
  assert.match(dist, /zoom: symbol_layout\.evaluateZoomSnap\(tr\.zoom - 1/);
});

test('F4: the handler is registered and enabled under the defaults createOlaMap uses', () => {
  assert.match(dist, /const tapZoom = new TapZoomHandler\(map\);/);
  assert.match(dist, /map\.doubleClickZoom = new DoubleClickZoomHandler\(clickZoom, tapZoom\);/);
  assert.match(
    dist,
    /if \(options\.interactive && options\.doubleClickZoom\) \{\s*map\.doubleClickZoom\.enable\(\);/,
  );
  assert.match(dist, /interactive: true,/);
  assert.match(dist, /doubleClickZoom: true,/);
  assert.match(dist, /touchZoomRotate: true,/);
});

test('F4: createOlaMap does not disable the built-in (no interactive/doubleClickZoom override)', () => {
  const maplibreSrc = readFileSync(
    new URL('../src/components/map/maplibre.ts', import.meta.url),
    'utf8',
  );
  // Scope the check to the `new maplibre.Map({...})` constructor
  // call — the file's comments quote the defaults
  // (`doubleClickZoom: true`) for documentation, which is not an
  // override; only the options object decides.
  const start = maplibreSrc.indexOf('new maplibre.Map({');
  assert.ok(start >= 0, 'createOlaMap must construct via new maplibre.Map');
  const end = maplibreSrc.indexOf('}) as unknown as MapLibreMapLike', start);
  assert.ok(end > start, 'constructor call must end as expected');
  const options = maplibreSrc.slice(start, end);
  assert.doesNotMatch(options, /doubleClickZoom\s*:/);
  assert.doesNotMatch(options, /interactive\s*:\s*false/);
  // And the play map builds no custom tap handler of its own.
  const playMapSrc = readFileSync(
    new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(playMapSrc, /onTouchStart|onTouchEnd|doubleTap|isDoubleTap/);
});
