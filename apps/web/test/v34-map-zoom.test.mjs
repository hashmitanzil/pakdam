/**
 * v34 (B5 — "map zoom doesn't work inside the game"): config pin.
 *
 * What code proves: nothing in the tree disables zoom. `new Map`
 * is created with only `dragRotate: false` + `touchPitch: false`
 * (two-finger rotate/pitch off); `touchZoomRotate`, `doubleClickZoom`
 * and `scrollZoom` are never set, so the MapLibre defaults (all
 * true, installed maplibre-gl 5.x) stand, the maplibre stylesheet
 * is imported by the layout (its `.maplibregl-touch-zoom-rotate`
 * rules are what let a pinch reach the canvas), and no overlay in
 * PlayMap covers the canvas.
 *
 * What this does NOT prove: that a pinch actually zooms on a real
 * phone. This VM cannot do touch, and the founder's zoom complaint
 * came in the same report as the black map (B1) — a flat/black map
 * has nothing to pinch, so the most likely cause was the map
 * itself, not the zoom config. Only the founder's phone proves
 * pinch zoom end to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const maplibreSrc = readFileSync(
  new URL('../src/components/map/maplibre.ts', import.meta.url),
  'utf8',
);
const layoutSrc = readFileSync(
  new URL('../src/app/layout.tsx', import.meta.url),
  'utf8',
);

test('v34 B5: map creation never disables zoom (pinch, double-tap, scroll)', () => {
  const start = maplibreSrc.indexOf('new maplibre.Map({');
  assert.ok(start >= 0, 'createOlaMap must construct a MapLibre Map');
  const block = maplibreSrc.slice(start, maplibreSrc.indexOf('})', start));
  for (const disabled of [
    'touchZoomRotate: false',
    'doubleClickZoom: false',
    'scrollZoom: false',
    'interactive: false',
  ]) {
    assert.ok(!block.includes(disabled), `map creation must not contain "${disabled}"`);
  }
  assert.ok(block.includes('dragRotate: false'), 'only rotate is off (by design)');
  assert.ok(block.includes('touchPitch: false'), 'only pitch is off (by design)');
});

test('v34 B5: the maplibre stylesheet is imported (its touch rules gate pinch zoom)', () => {
  assert.ok(
    layoutSrc.includes("import 'maplibre-gl/dist/maplibre-gl.css'"),
    'the layout must import the maplibre stylesheet',
  );
});
