/**
 * v34 (B2 — the giant red disc): the accuracy ring is LINE-ONLY.
 *
 * The v28 ring was a `fill` layer (`rgba(239, 68, 68, 0.10)`) — a
 * ±100 m fix in a 500 m zone draws a ~105–175 px disc, and over a
 * black (tile-less) map that fill is the only colour on screen, so
 * it reads as a giant solid blob with the 18 px dot lost in its
 * centre (the founder's screenshot). A filled disc can never look
 * like a locator at that size. The ring is now a thin outline at the
 * fix's true accuracy radius — the radius is still the honest
 * accuracy (no precision invented, no cap), but nothing fills the
 * disc: small dot + faint ring.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const { meAccuracyLayers, meAccuracyFeatures } = await import(
  '../src/components/hud/play-map-logic.ts'
);

const playMapSrc = readFileSync(
  new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
  'utf8',
);

test('v34 B2: the accuracy ring has NO fill layer — line only', () => {
  const layers = meAccuracyLayers();
  assert.equal(layers.length, 1);
  assert.equal(layers[0].type, 'line');
  assert.ok(
    !layers.some((l) => l.type === 'fill'),
    'a fill layer at ±100 m is the giant-disc bug',
  );
});

test('v34 B2: the ring is thin, faint, and on the accuracy source', () => {
  const [ring] = meAccuracyLayers();
  assert.equal(ring.id, 'pakdam-me-accuracy-ring');
  assert.equal(ring.source, 'pakdam-me-accuracy');
  assert.ok(
    ring.paint['line-width'] <= 2,
    `line-width must stay thin, got ${ring.paint['line-width']}`,
  );
  const color = String(ring.paint['line-color']);
  const alpha = Number(color.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)/)?.[1]);
  assert.ok(
    Number.isFinite(alpha) && alpha > 0 && alpha < 1,
    `line-color must be a translucent red, got ${color}`,
  );
});

test('v34 B2: the ring radius is still the honest accuracy (no cap, no invention)', () => {
  const features = meAccuracyFeatures({
    lng: 85.33,
    lat: 23.35,
    accuracyMeters: 100,
    timestampMs: Date.now(),
  });
  assert.equal(features.length, 1);
  assert.equal(features[0].geometry.type, 'Polygon');
  const ring = features[0].geometry.coordinates[0];
  // 64-point geodesic circle: the ring's extent on EITHER axis
  // reaches ~100 m (the first vertex is due north, so its longitude
  // offset is 0 — the max over all vertices is the honest check).
  // Vertices sit within ~2.8° of the cardinal points, so the max
  // extent is ~99.9 m; allow 95–105 m.
  const latM = (dLat) => Math.abs(dLat) * 111_320;
  const lngM = (dLng) => Math.abs(dLng) * 111_320 * Math.cos((23.35 * Math.PI) / 180);
  const maxOffsetM = Math.max(
    ...ring.map(([lng, lat]) => Math.max(lngM(lng - 85.33), latM(lat - 23.35))),
  );
  assert.ok(
    maxOffsetM > 95 && maxOffsetM < 105,
    `ring radius must be the true ±100 m, got ~${maxOffsetM.toFixed(1)} m`,
  );
});

test('v34 B2: PlayMap uses the line ring and the old fill id is gone', () => {
  assert.ok(
    playMapSrc.includes('meAccuracyLayers()'),
    'PlayMap must sync the ring from meAccuracyLayers()',
  );
  assert.ok(
    !playMapSrc.includes('pakdam-me-accuracy-fill'),
    'the old fill layer id must not survive anywhere in PlayMap',
  );
});
