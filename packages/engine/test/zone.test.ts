import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOutsideZoneEjection, circlePolygon, effectiveZoneBoundary, nextShrinkPhaseAt, pointInPolygon, polygonCentroid,
  polygonFullyInside, randomOffsetShrinkBoundary, zoneDiameterMeters,
} from '../src/zone.js';
import type { GeoPolygon, Player, ZoneConfig } from '@pakdam/shared';

/** Deterministic RNG (mulberry32) so the random-offset tests are
 *  repeatable — production passes Math.random. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CENTRE = { lat: 23.3642, lng: 85.331 };
/** Regular hexagon — the same shape a drawn zone starts from. */
function hexagon(lat: number, lng: number, radiusM: number): GeoPolygon {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (i * Math.PI) / 3;
    return {
      lat: lat + (radiusM * Math.cos(a)) / 111320,
      lng: lng + (radiusM * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180)),
    };
  });
}
function centroidShiftM(a: GeoPolygon, b: GeoPolygon): number {
  const ca = polygonCentroid(a);
  const cb = polygonCentroid(b);
  if (!ca || !cb) return 0;
  return Math.hypot((ca.lat - cb.lat) * 111320, (ca.lng - cb.lng) * 111320 * Math.cos((ca.lat * Math.PI) / 180));
}
function closeTo(actual: number, expected: number, tol: number): boolean {
  return Math.abs(actual - expected) <= tol;
}

test('next zone: random offset is smaller and fully inside the current zone (circle)', () => {
  const base = circlePolygon(CENTRE.lat, CENTRE.lng, 500, 32);
  const baseD = zoneDiameterMeters(base);
  assert.ok(closeTo(baseD, 1000, 5), `base diameter ${baseD} should be ~1000 m`);
  let moved = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const next = randomOffsetShrinkBoundary(base, 0.75, seededRandom(seed));
    assert.ok(polygonFullyInside(next, base), `seed ${seed}: next zone must be fully inside the current zone`);
    assert.ok(closeTo(zoneDiameterMeters(next), baseD * 0.75, 10), `seed ${seed}: next zone must be 75% of the current size`);
    if (centroidShiftM(base, next) > 10) moved++;
  }
  // Random position, not concentric: nearly every draw moves the
  // centre by more than 10 m (the disc it can occupy is ~137 m wide).
  assert.ok(moved >= 18, `expected most draws to move the centre, only ${moved}/20 did`);
});

test('next zone: random offset is smaller and fully inside the current zone (drawn hexagon)', () => {
  const base = hexagon(CENTRE.lat, CENTRE.lng, 500);
  for (let seed = 1; seed <= 10; seed++) {
    const next = randomOffsetShrinkBoundary(base, 0.75, seededRandom(seed * 7));
    assert.ok(polygonFullyInside(next, base), `seed ${seed}: drawn next zone must be fully inside the current shape`);
    assert.ok(closeTo(zoneDiameterMeters(next), zoneDiameterMeters(base) * 0.75, 10), `seed ${seed}: drawn next zone must be 75% of the current size`);
  }
});

test('next zone: factor 1 (or invalid) returns the boundary unchanged', () => {
  const base = circlePolygon(CENTRE.lat, CENTRE.lng, 500, 32);
  assert.deepEqual(randomOffsetShrinkBoundary(base, 1, seededRandom(1)), base);
  assert.deepEqual(randomOffsetShrinkBoundary(base, 0, seededRandom(1)), base);
  assert.deepEqual(randomOffsetShrinkBoundary(base, -0.5, seededRandom(1)), base);
});

test('next zone: chained phases stay inside each previous zone and follow the host size', () => {
  const base = circlePolygon(CENTRE.lat, CENTRE.lng, 500, 32);
  const baseD = zoneDiameterMeters(base);
  const phase1 = randomOffsetShrinkBoundary(base, 0.75, seededRandom(3));
  const phase2 = randomOffsetShrinkBoundary(phase1, 0.75, seededRandom(11));
  assert.ok(polygonFullyInside(phase1, base), 'phase 1 must be fully inside the base zone');
  assert.ok(polygonFullyInside(phase2, phase1), 'phase 2 must be fully inside phase 1');
  assert.ok(closeTo(zoneDiameterMeters(phase1), baseD * 0.75, 10), 'phase 1 must be 75% of base');
  assert.ok(closeTo(zoneDiameterMeters(phase2), baseD * 0.5625, 10), 'phase 2 must be 56.25% of base (0.75 x 0.75)');
  assert.ok(centroidShiftM(base, phase2) > 10, 'chained random offsets must move the centre away from the base centre');
});

test('next zone: concave L-shape whose centroid sits outside it — next zone is always fully inside', () => {
  // L-shape (lat/lng): the vertex centroid (0.004667, 0.004667) sits
  // in the missing top-right corner — OUTSIDE the shape. Shrinking
  // toward the centroid can therefore never land inside, so the old
  // concentric fallback poked out. The new fallback must still
  // return a boundary fully inside the shape (smaller is allowed).
  const lShape: GeoPolygon = [
    { lat: 0, lng: 0 },
    { lat: 0.01, lng: 0 },
    { lat: 0.01, lng: 0.004 },
    { lat: 0.004, lng: 0.004 },
    { lat: 0.004, lng: 0.01 },
    { lat: 0, lng: 0.01 },
  ];
  const centroid = polygonCentroid(lShape)!;
  assert.equal(pointInPolygon(centroid, lShape), false, 'test shape sanity: centroid must sit outside the L');
  const baseD = zoneDiameterMeters(lShape);
  // Hostile RNG (always 0): every random draw is the concentric copy,
  // so all 50 attempts fail and the fallback path is exercised.
  const nextHostile = randomOffsetShrinkBoundary(lShape, 0.75, () => 0);
  assert.ok(polygonFullyInside(nextHostile, lShape), 'hostile-RNG fallback must be fully inside the L-shape');
  assert.ok(zoneDiameterMeters(nextHostile) <= baseD * 0.75 + 10, 'fallback must be no bigger than the host shrink size');
  assert.ok(zoneDiameterMeters(nextHostile) > 0, 'fallback must be a real zone, not a point');
  for (let seed = 1; seed <= 10; seed++) {
    const next = randomOffsetShrinkBoundary(lShape, 0.75, seededRandom(seed));
    assert.ok(polygonFullyInside(next, lShape), `seed ${seed}: next zone must be fully inside the concave shape`);
    assert.ok(zoneDiameterMeters(next) <= baseD * 0.75 + 10, `seed ${seed}: next zone must be no bigger than 75% of the current size`);
  }
});
test('next zone: hostile RNG on a circle — fallback is still non-concentric and inside', () => {
  // Founder rule is "never concentric": even when every random draw
  // fails (hostile RNG always returns 0, i.e. the concentric copy),
  // the fallback must prefer a verified non-concentric offset copy.
  const base = circlePolygon(CENTRE.lat, CENTRE.lng, 500, 32);
  const next = randomOffsetShrinkBoundary(base, 0.75, () => 0);
  assert.ok(polygonFullyInside(next, base), 'hostile-RNG fallback must be fully inside');
  assert.ok(closeTo(zoneDiameterMeters(next), zoneDiameterMeters(base) * 0.75, 10), 'fallback must keep the host shrink size');
  assert.ok(centroidShiftM(base, next) > 10, 'fallback must move the centre — never concentric');
});

test('next zone: near-zero RNG draws are re-drawn, never accepted as concentric', () => {
  // RNG stuck near zero: every draw lands within ~4 m of the centre.
  // A ~0 draw verifies fully inside, so without the minimum-shift
  // guard it would be accepted as the (concentric) next zone.
  const base = circlePolygon(CENTRE.lat, CENTRE.lng, 500, 32);
  const next = randomOffsetShrinkBoundary(base, 0.75, () => 0.001);
  assert.ok(polygonFullyInside(next, base), 'near-zero-RNG fallback must be fully inside');
  assert.ok(centroidShiftM(base, next) > 10, 'near-zero draws must never produce a (near-)concentric zone');
  assert.ok(closeTo(zoneDiameterMeters(next), zoneDiameterMeters(base) * 0.75, 10), 'fallback must keep the host shrink size');
});

test('ejection: applyOutsideZoneEjection sets ejectedAt once and never undoes it', () => {
  const p: Player = {
    playerId: 'r1', roomId: 'r1', kind: 'guest', displayName: 'r1',
    isHost: false, matchRole: 'runner', team: 'runners', reconnectTokenHash: 'hash',
    joinedAt: new Date().toISOString(), leftAt: null, connectionState: 'connected',
    lastFixAt: null, locationQuality: 'unknown', isReady: true, briefingConfirmed: true,
    ageGatePassed: true, suspensionCount: 0, ejectedAt: null,
  };
  const now = new Date().toISOString();
  const ejected = applyOutsideZoneEjection(p, now);
  assert.equal(ejected.ejectedAt, now);
  assert.equal(ejected.leftAt, null); // stays in the room record, not deleted
  assert.equal(ejected.matchRole, 'runner');
  // Idempotent: a second call keeps the first ejection time.
  assert.equal(applyOutsideZoneEjection(ejected, '2030-01-01T00:00:00.000Z').ejectedAt, now);
});
test('polygonFullyInside: a smaller circle is inside, a shifted one pokes out, empty is not inside', () => {
  const outer = circlePolygon(CENTRE.lat, CENTRE.lng, 500, 32);
  const inner = circlePolygon(CENTRE.lat, CENTRE.lng, 300, 32);
  assert.equal(polygonFullyInside(inner, outer), true);
  const pokingOut = inner.map((p) => ({ lat: p.lat + 0.004, lng: p.lng }));
  assert.equal(polygonFullyInside(pokingOut, outer), false);
  assert.equal(polygonFullyInside([], outer), false);
});

const STARTED_AT = '2026-11-17T00:00:00.000Z';
function mkZone(): ZoneConfig {
  const base = circlePolygon(CENTRE.lat, CENTRE.lng, 500, 32);
  return {
    boundary: base,
    shrinkPhases: [
      { atSeconds: 600, boundary: randomOffsetShrinkBoundary(base, 0.75, seededRandom(3)) },
      { atSeconds: 1200, boundary: randomOffsetShrinkBoundary(base, 0.5625, seededRandom(5)) },
    ],
  };
}

test('effectiveZoneBoundary: null start returns the base; phases take effect at their times', () => {
  const zone = mkZone();
  const t0 = new Date(STARTED_AT).getTime();
  assert.deepEqual(effectiveZoneBoundary(zone, null, t0 + 10_000), zone.boundary);
  assert.deepEqual(effectiveZoneBoundary(zone, STARTED_AT, t0 + 599_000), zone.boundary);
  assert.deepEqual(effectiveZoneBoundary(zone, STARTED_AT, t0 + 600_000), zone.shrinkPhases[0]!.boundary);
  assert.deepEqual(effectiveZoneBoundary(zone, STARTED_AT, t0 + 1199_000), zone.shrinkPhases[0]!.boundary);
  assert.deepEqual(effectiveZoneBoundary(zone, STARTED_AT, t0 + 1200_000), zone.shrinkPhases[1]!.boundary);
  assert.deepEqual(effectiveZoneBoundary(zone, STARTED_AT, t0 + 2000_000), zone.shrinkPhases[1]!.boundary);
});

test('nextShrinkPhaseAt: first phase before start, countdown while running, null when done', () => {
  const zone = mkZone();
  const t0 = new Date(STARTED_AT).getTime();
  const before = nextShrinkPhaseAt(zone, null, t0);
  assert.ok(before);
  assert.equal(before.phaseIndex, 0);
  assert.equal(before.inSeconds, null);
  assert.equal(before.totalPhases, 2);
  const mid = nextShrinkPhaseAt(zone, STARTED_AT, t0 + 100_000);
  assert.ok(mid);
  assert.equal(mid.phaseIndex, 0);
  assert.equal(mid.inSeconds, 500);
  assert.deepEqual(mid.boundary, zone.shrinkPhases[0]!.boundary);
  const afterFirst = nextShrinkPhaseAt(zone, STARTED_AT, t0 + 600_000);
  assert.ok(afterFirst);
  assert.equal(afterFirst.phaseIndex, 1);
  assert.equal(afterFirst.inSeconds, 600);
  assert.equal(nextShrinkPhaseAt(zone, STARTED_AT, t0 + 1200_000), null);
  assert.equal(nextShrinkPhaseAt({ boundary: zone.boundary, shrinkPhases: [] }, STARTED_AT, t0), null);
});
