import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  haversineMeters,
  pointInPolygon,
  polygonCentroid,
  zoneDiameterMeters,
  circlePolygon,
  scalePolygonTowardCentroid,
  polygonFullyInside,
  shrinkTimesSeconds,
  finalRadiusFactor,
  finalRadiusPercent,
  shrinkIndexAt,
  nextShrinkAtMs,
  randomOffsetShrinkBoundary,
  updateOutsideZone,
  emptyOutsideZoneState,
  applyOutsideZoneEjection,
} = await import('../src/zone.ts');

const { METERS_PER_DEG_LAT } = await import('@pakdam/shared');

const CENTRE = { lat: 23.35, lng: 85.33 };

test('shrink schedule: exactly 3 shrinks at [I, 2I, 3I]; none when shrinking is off', () => {
  assert.deepEqual(shrinkTimesSeconds(1800, 600, true), [600, 1200, 1800]);
  assert.deepEqual(shrinkTimesSeconds(3600, 1200, true), [1200, 2400, 3600]);
  assert.deepEqual(shrinkTimesSeconds(1800, 600, false), []);
  assert.deepEqual(shrinkTimesSeconds(1800, 0, true), []);
});

test('final radius: 0.75^3 = 42% after the standard 3 shrinks, not 25%', () => {
  assert.ok(Math.abs(finalRadiusFactor() - 0.421875) < 1e-9);
  assert.equal(finalRadiusPercent(), 42);
  assert.equal(finalRadiusFactor(0), 1);
  assert.equal(finalRadiusFactor(1), 0.75);
});

test('shrinkIndexAt: counts fired shrinks, capped at 3', () => {
  assert.equal(shrinkIndexAt(0, 600, true), 0);
  assert.equal(shrinkIndexAt(599, 600, true), 0);
  assert.equal(shrinkIndexAt(600, 600, true), 1);
  assert.equal(shrinkIndexAt(1200, 600, true), 2);
  assert.equal(shrinkIndexAt(1800, 600, true), 3);
  assert.equal(shrinkIndexAt(9999, 600, true), 3);
  assert.equal(shrinkIndexAt(1200, 600, false), 0);
  assert.equal(shrinkIndexAt(-5, 600, true), 0);
});

test('nextShrinkAtMs: the next shrink strictly after now, or null', () => {
  assert.equal(nextShrinkAtMs(0, 1800, 600, true, 0), 600_000);
  assert.equal(nextShrinkAtMs(0, 1800, 600, true, 600_000), 1_200_000);
  assert.equal(nextShrinkAtMs(0, 1800, 600, true, 1_800_000), null);
  assert.equal(nextShrinkAtMs(0, 1800, 600, true, 2_000_000), null);
  assert.equal(nextShrinkAtMs(0, 1800, 600, false, 0), null);
});

test('pointInPolygon: inside, outside, and fewer than 3 points', () => {
  const triangle = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.01 },
    { lat: 0.01, lng: 0 },
  ];
  assert.equal(pointInPolygon({ lat: 0.002, lng: 0.002 }, triangle), true);
  assert.equal(pointInPolygon({ lat: 0.02, lng: 0.02 }, triangle), false);
  assert.equal(pointInPolygon({ lat: -0.001, lng: 0.001 }, triangle), false);
  assert.equal(pointInPolygon({ lat: 0.002, lng: 0.002 }, triangle.slice(0, 2)), false);
});

test('circlePolygon: 64 points whose diameter is twice the radius', () => {
  const boundary = circlePolygon(CENTRE, 500);
  assert.equal(boundary.length, 64);
  const diameter = zoneDiameterMeters(boundary);
  assert.ok(Math.abs(diameter - 1000) < 5, `got ${diameter}`);
});

test('circlePolygon: a 500 m circle\'s edge is ~500 m from the centre by haversine (±1 m)', () => {
  // The single-sourced constant must be (6,371,000 · π) / 180 — the same
  // Earth radius the haversine uses — not the stale 111,320 (≈499 m).
  assert.ok(
    Math.abs(METERS_PER_DEG_LAT - (6_371_000 * Math.PI) / 180) < 1e-9,
    `got ${METERS_PER_DEG_LAT}`,
  );
  for (const centre of [
    CENTRE, // Ranchi, 23.35°N — the real game latitude
    { lat: 0, lng: 0 }, // equator
    { lat: 60, lng: 10 }, // high latitude — the cos(lat) correction matters
  ]) {
    const boundary = circlePolygon(centre, 500);
    assert.equal(boundary.length, 64);
    for (const point of boundary) {
      const d = haversineMeters(centre, point);
      assert.ok(Math.abs(d - 500) < 1, `centre ${centre.lat},${centre.lng}: got ${d}`);
    }
  }
});

test('circlePolygon: edge is the NOMINAL radius by haversine for 100–5000 m at Ranchi, equator and 60°N (±0.05 m)', () => {
  // True geodesic destination points: every edge point must be exactly
  // the nominal radius by haversine, for ANY radius — the old
  // equirectangular construction drifted 1.3 cm at 500 m and 1.3 m at
  // 5 km (60°N). Tight ±0.05 m tolerance, not the ±1 m of the test above.
  const centres = [
    CENTRE, // Ranchi, 23.35°N — the real game latitude
    { lat: 0, lng: 0 }, // equator
    { lat: 60, lng: 10 }, // high latitude — worst case for the old approximation
  ];
  for (const radius of [100, 200, 500, 1000, 5000]) {
    let maxErr = 0;
    for (const centre of centres) {
      const boundary = circlePolygon(centre, radius);
      assert.equal(boundary.length, 64);
      for (const point of boundary) {
        const err = Math.abs(haversineMeters(centre, point) - radius);
        maxErr = Math.max(maxErr, err);
        assert.ok(
          err < 0.05,
          `radius ${radius} m, centre ${centre.lat},${centre.lng}: error ${err} m`,
        );
      }
    }
    assert.ok(maxErr < 0.05, `radius ${radius} m: max error ${maxErr} m`);
  }
});

test('polygonCentroid and scaling: the centroid is the vertex average, scaling halves the diameter', () => {
  const square = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.01 },
    { lat: 0.01, lng: 0.01 },
    { lat: 0.01, lng: 0 },
  ];
  assert.deepEqual(polygonCentroid(square), { lat: 0.005, lng: 0.005 });
  const before = zoneDiameterMeters(square);
  const after = zoneDiameterMeters(scalePolygonTowardCentroid(square, 0.5));
  const ratio = after / before;
  assert.ok(ratio > 0.49 && ratio < 0.51, `ratio ${ratio}`);
});

test('randomOffsetShrinkBoundary: a deterministic draw is random, non-concentric and fully inside', () => {
  const original = circlePolygon(CENTRE, 500);
  const result = randomOffsetShrinkBoundary(original, { random: () => 0.5 });
  assert.equal(result.method, 'random');
  // angle π, radius sqrt(0.5) × (500 − 375) ≈ 88.4 m — well clear of the 10 m minimum.
  assert.ok(result.offsetMeters > 80 && result.offsetMeters < 95, `got ${result.offsetMeters}`);
  assert.equal(polygonFullyInside(result.boundary, original), true);
  const diameter = zoneDiameterMeters(result.boundary);
  assert.ok(Math.abs(diameter - 750) < 5, `got ${diameter}`);
});

test('outside-zone countdown: inside clears it, 30 s outside ejects', () => {
  const inside = updateOutsideZone(emptyOutsideZoneState(), {
    inside: true,
    poorAccuracy: false,
    nowMs: 1000,
  });
  assert.equal(inside.shouldEject, false);
  assert.equal(inside.remainingSeconds, 30);
  assert.deepEqual(inside.state, { outsideSinceMs: null, outsideAccumMs: 0 });

  const started = updateOutsideZone(emptyOutsideZoneState(), {
    inside: false,
    poorAccuracy: false,
    nowMs: 10_000,
  });
  assert.equal(started.shouldEject, false);
  assert.equal(started.remainingSeconds, 30);
  assert.equal(started.state.outsideSinceMs, 10_000);

  const almost = updateOutsideZone(started.state, {
    inside: false,
    poorAccuracy: false,
    nowMs: 39_000,
  });
  assert.equal(almost.shouldEject, false);
  assert.equal(almost.remainingSeconds, 1);

  const ejected = updateOutsideZone(started.state, {
    inside: false,
    poorAccuracy: false,
    nowMs: 40_000,
  });
  assert.equal(ejected.shouldEject, true);
  assert.equal(ejected.remainingSeconds, 0);
});

test('outside-zone countdown: poor GPS freezes it — counted seconds stay', () => {
  const state = { outsideSinceMs: 10_000, outsideAccumMs: 0 };
  const frozen = updateOutsideZone(state, {
    inside: false,
    poorAccuracy: true,
    nowMs: 20_000,
  });
  assert.equal(frozen.shouldEject, false);
  assert.equal(frozen.remainingSeconds, 20);
  assert.deepEqual(frozen.state, { outsideSinceMs: null, outsideAccumMs: 10_000 });
});

test('applyOutsideZoneEjection: stamps once, never overwrites, never mutates the input', () => {
  const player = { ejectedAt: null };
  const stamped = applyOutsideZoneEjection(player, 1_700_000_000_000);
  assert.equal(stamped.ejectedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(player.ejectedAt, null);
  assert.notEqual(stamped, player);
  assert.equal(applyOutsideZoneEjection(stamped, 1_700_000_000_001), stamped);
});

test('outside-zone countdown: a poor fix NEVER clears it — not even from inside (B1)', () => {
  // 20 s already accrued outside; a poor fix whose centre lands inside
  // must freeze the countdown, not wipe the accrued time: a ±1000 m
  // fix cannot prove the player is actually back inside.
  const state = { outsideSinceMs: null, outsideAccumMs: 20_000 };
  const frozen = updateOutsideZone(state, {
    inside: true,
    poorAccuracy: true,
    nowMs: 30_000,
  });
  assert.equal(frozen.shouldEject, false);
  assert.equal(frozen.remainingSeconds, 10);
  assert.deepEqual(frozen.state, { outsideSinceMs: null, outsideAccumMs: 20_000 });
  // A trustworthy inside fix still clears it.
  const cleared = updateOutsideZone(frozen.state, {
    inside: true,
    poorAccuracy: false,
    nowMs: 31_000,
  });
  assert.deepEqual(cleared.state, { outsideSinceMs: null, outsideAccumMs: 0 });
  assert.equal(cleared.remainingSeconds, 30);
});
