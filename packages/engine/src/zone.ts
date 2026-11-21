/**
 * Pakdam engine — zone geometry, shrink, and the outside-zone rule.
 *
 * Circle or host-drawn polygon zones (tap-to-place, 3 taps = triangle).
 * Radius min 100 m, NO maximum (founder decision — "unlimited past 1 km").
 * Never auto-centred on a fix worse than ±50 m — the host places it by hand
 * instead (see `canAutoCentreZone` in @pakdam/shared).
 *
 * Each shrink scales the zone to 75% of its radius, then moves it to a
 * RANDOM position fully inside the old boundary — NEVER concentric
 * (near-concentric draws are discarded and re-drawn).
 *
 * Outside the zone: 30 s return countdown, then ejection. Poor GPS freezes
 * the countdown (counted seconds stay); back inside clears it. Ejection is
 * never undone by rejoining.
 */
import {
  EARTH_RADIUS_M,
  METERS_PER_DEG_LAT,
  MIN_NEXT_ZONE_OFFSET_M,
  OUTSIDE_ZONE_RETURN_SECONDS,
  SHRINK_COUNT_PER_ROUND,
  SHRINK_MAX_ATTEMPTS,
  SHRINK_RADIUS_FACTOR,
  ZONE_RADIUS_MIN_M,
  type GeoPoint,
  type GeoPolygon,
  haversineMeters,
} from '@pakdam/shared';

export { haversineMeters, OUTSIDE_ZONE_RETURN_SECONDS, ZONE_RADIUS_MIN_M };

/**
 * Convert a point to local metres relative to an origin point.
 * METERS_PER_DEG_LAT comes from @pakdam/shared — the same (R·π)/180 the
 * haversine uses. Used for offsets/containment only; circles are built
 * with the geodesic destination formula in `circlePolygon`, not here.
 */
function toLocalMeters(point: GeoPoint, origin: GeoPoint): { x: number; y: number } {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return {
    x: (point.lng - origin.lng) * METERS_PER_DEG_LAT * cosLat,
    y: (point.lat - origin.lat) * METERS_PER_DEG_LAT,
  };
}

/** Convert local metres back to a point, relative to an origin point. */
function fromLocalMeters(local: { x: number; y: number }, origin: GeoPoint): GeoPoint {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return {
    lat: origin.lat + local.y / METERS_PER_DEG_LAT,
    lng: origin.lng + local.x / (METERS_PER_DEG_LAT * cosLat),
  };
}

/** Ray-casting point-in-polygon. A point exactly on the boundary counts as inside. */
export function pointInPolygon(point: GeoPoint, polygon: GeoPolygon): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i] as GeoPoint;
    const b = polygon[j] as GeoPoint;
    const crosses =
      a.lng > point.lng !== b.lng > point.lng &&
      point.lat < ((b.lat - a.lat) * (point.lng - a.lng)) / (b.lng - a.lng) + a.lat;
    if (crosses) inside = !inside;
  }
  if (inside) return true;
  // On-boundary check: within a hair of any edge counts as inside (ST_Covers semantics).
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as GeoPoint;
    const b = polygon[(i + 1) % polygon.length] as GeoPoint;
    if (distancePointToSegmentMeters(point, a, b) < 0.5) return true;
  }
  return false;
}

/** Distance from a point to a segment, in metres (equirectangular). */
export function distancePointToSegmentMeters(
  point: GeoPoint,
  a: GeoPoint,
  b: GeoPoint,
): number {
  const p = toLocalMeters(point, a);
  const q = toLocalMeters(b, a);
  const dx = q.x;
  const dy = q.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : (p.x * dx + p.y * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = t * dx;
  const cy = t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Vertex average of a polygon. May sit outside a concave shape — callers needing an interior point must check containment. */
export function polygonCentroid(polygon: GeoPolygon): GeoPoint {
  let lat = 0;
  let lng = 0;
  for (const p of polygon) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / polygon.length, lng: lng / polygon.length };
}

/** Widest pair of vertices, in metres — the zone diameter. */
export function zoneDiameterMeters(polygon: GeoPolygon): number {
  let widest = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    for (let j = i + 1; j < polygon.length; j += 1) {
      const a = polygon[i] as GeoPoint;
      const b = polygon[j] as GeoPoint;
      widest = Math.max(widest, haversineMeters(a, b));
    }
  }
  return widest;
}

/**
 * N-point circle approximation — TRUE geodesic destination points on a
 * spherical earth (same R = 6_371_000 m the haversine uses, single-sourced
 * as EARTH_RADIUS_M from @pakdam/shared — no second radius literal).
 * Given centre (lat1, lng1), bearing θ, distance d:
 *   lat2 = asin(sin(lat1)·cos(d/R) + cos(lat1)·sin(d/R)·cos(θ))
 *   lng2 = lng1 + atan2(sin(θ)·sin(d/R)·cos(lat1),
 *                       cos(d/R) − sin(lat1)·sin(lat2))
 * Every edge point is then exactly `radiusMeters` from the centre by
 * haversine (to floating-point precision), for ANY radius and ANY
 * latitude — the old equirectangular (METERS_PER_DEG_LAT + cos(lat))
 * construction drifted up to ~5 m at a 10 km radius (60°N).
 * Longitude is normalised to (−180, 180] so a huge radius crossing the
 * antimeridian still lands on a valid meridian.
 */
export function circlePolygon(
  centre: GeoPoint,
  radiusMeters: number,
  points = 64,
): GeoPolygon {
  const lat1 = (centre.lat * Math.PI) / 180;
  const lng1 = (centre.lng * Math.PI) / 180;
  const angularDistance = radiusMeters / EARTH_RADIUS_M;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAngular = Math.sin(angularDistance);
  const cosAngular = Math.cos(angularDistance);
  const boundary: GeoPolygon = [];
  for (let i = 0; i < points; i += 1) {
    const bearing = (2 * Math.PI * i) / points;
    const lat2 = Math.asin(
      sinLat1 * cosAngular + cosLat1 * sinAngular * Math.cos(bearing),
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * sinAngular * cosLat1,
        cosAngular - sinLat1 * Math.sin(lat2),
      );
    boundary.push({
      lat: (lat2 * 180) / Math.PI,
      lng: (((lng2 * 180) / Math.PI + 540) % 360) - 180,
    });
  }
  return boundary;
}

/** Scale a polygon toward a point by `factor` (0.75 = keep 75% of the radius). */
export function scalePolygonTowardPoint(
  polygon: GeoPolygon,
  point: GeoPoint,
  factor: number,
): GeoPolygon {
  return polygon.map((p) => ({
    lat: point.lat + (p.lat - point.lat) * factor,
    lng: point.lng + (p.lng - point.lng) * factor,
  }));
}

/** Scale a polygon toward its centroid by `factor`. */
export function scalePolygonTowardCentroid(
  polygon: GeoPolygon,
  factor: number,
): GeoPolygon {
  return scalePolygonTowardPoint(polygon, polygonCentroid(polygon), factor);
}

/** Offset every vertex of a polygon by (dx, dy) metres. */
export function offsetPolygon(polygon: GeoPolygon, dxMeters: number, dyMeters: number): GeoPolygon {
  const origin = polygon[0] as GeoPoint;
  return polygon.map((p) => {
    const local = toLocalMeters(p, origin);
    return fromLocalMeters({ x: local.x + dxMeters, y: local.y + dyMeters }, origin);
  });
}

type Segment = { x1: number; y1: number; x2: number; y2: number };

function segmentsCross(a: Segment, b: Segment): boolean {
  const d = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const p1 = { x: a.x1, y: a.y1 };
  const p2 = { x: a.x2, y: a.y2 };
  const p3 = { x: b.x1, y: b.y1 };
  const p4 = { x: b.x2, y: b.y2 };
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Is `inner` fully inside `outer`? All vertices inside AND no edge crossing.
 * Touching the boundary counts as inside.
 */
export function polygonFullyInside(inner: GeoPolygon, outer: GeoPolygon): boolean {
  if (inner.length < 3 || outer.length < 3) return false;
  for (const p of inner) {
    if (!pointInPolygon(p, outer)) return false;
  }
  const origin = outer[0] as GeoPoint;
  const innerSegs: Segment[] = inner.map((p, i) => {
    const a = toLocalMeters(p, origin);
    const b = toLocalMeters(inner[(i + 1) % inner.length] as GeoPoint, origin);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  });
  const outerSegs: Segment[] = outer.map((p, i) => {
    const a = toLocalMeters(p, origin);
    const b = toLocalMeters(outer[(i + 1) % outer.length] as GeoPoint, origin);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  });
  for (const a of innerSegs) {
    for (const b of outerSegs) {
      if (segmentsCross(a, b)) return false;
    }
  }
  return true;
}

/** Is this point inside the play zone? (Empty boundary = unplaced zone: not inside.) */
export function isPointInZone(point: GeoPoint, boundary: GeoPolygon): boolean {
  return pointInPolygon(point, boundary);
}

// ---------------------------------------------------------------------------
// Shrink schedule
// ---------------------------------------------------------------------------

/**
 * Shrink times (seconds from match start): exactly 3 shrinks per round —
 * [I, 2I, 3I] where I is the shrink interval (duration/3 by the
 * auto-adjust, so a 30-min round shrinks at 10, 20 and 30 min). The old
 * `t < duration` loop emitted only 2 shrinks (the third landed exactly at
 * match end and was dropped). Empty when shrinking is off.
 */
export function shrinkTimesSeconds(
  durationSeconds: number,
  intervalSeconds: number,
  shrinkEnabled: boolean,
): number[] {
  if (!shrinkEnabled || intervalSeconds <= 0) return [];
  void durationSeconds;
  const times: number[] = [];
  for (let k = 1; k <= SHRINK_COUNT_PER_ROUND; k += 1) {
    times.push(k * intervalSeconds);
  }
  return times;
}

/**
 * Final radius factor after `shrinkCount` shrinks of 0.75 each:
 * 0.75^3 = 0.42 after the standard 3 shrinks — the final zone is 42% of
 * the start radius, NOT 25% (25% needs 5 shrinks). The setup copy and
 * the final-size ring must use this helper, never a hardcoded 25%.
 */
export function finalRadiusFactor(shrinkCount: number = SHRINK_COUNT_PER_ROUND): number {
  return SHRINK_RADIUS_FACTOR ** Math.max(0, Math.floor(shrinkCount));
}

/** Final radius as a whole percent of the start radius (42 after 3 shrinks). */
export function finalRadiusPercent(shrinkCount: number = SHRINK_COUNT_PER_ROUND): number {
  return Math.round(finalRadiusFactor(shrinkCount) * 100);
}

/** How many shrinks have fired by `elapsedSeconds` into the match (max 3). */
export function shrinkIndexAt(
  elapsedSeconds: number,
  intervalSeconds: number,
  shrinkEnabled: boolean,
): number {
  if (!shrinkEnabled || intervalSeconds <= 0 || elapsedSeconds < 0) return 0;
  return Math.min(SHRINK_COUNT_PER_ROUND, Math.floor(elapsedSeconds / intervalSeconds));
}

/** Epoch ms of the next shrink after `nowMs`, or null when none is scheduled. */
export function nextShrinkAtMs(
  startedAtMs: number,
  durationSeconds: number,
  intervalSeconds: number,
  shrinkEnabled: boolean,
  nowMs: number,
): number | null {
  const times = shrinkTimesSeconds(durationSeconds, intervalSeconds, shrinkEnabled);
  for (const t of times) {
    const at = startedAtMs + t * 1000;
    if (at > nowMs) return at;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Random next zone per shrink — never concentric
// ---------------------------------------------------------------------------

export interface ShrinkDrawResult {
  boundary: GeoPolygon;
  /** How the boundary was produced: random draw, or which fallback saved it. */
  method: 'random' | 'compass-fallback' | 'vertex-fallback' | 'smaller-concentric' | 'concentric-last-resort';
  /** Centre offset of the new zone from the old centre, in metres. */
  offsetMeters: number;
}

/**
 * Draw the next zone: scale the boundary toward its centroid by the shrink
 * factor (75% of the radius), then move the smaller shape to a RANDOM
 * position fully inside the current boundary — NOT concentric. The DO calls
 * this at the moment a shrink fires (v18: there is NO next-zone preview —
 * the founder removed `zone.preview`, so nothing is drawn or broadcast
 * ahead of the shrink; the next zone appears suddenly at a random place).
 * Offset drawn uniformly over the disc the smaller shape can occupy; every
 * candidate is verified with `polygonFullyInside`; draws within 10 m of
 * the current centre are discarded and re-drawn. Up to 50 attempts, then
 * fallbacks in order: deterministic non-concentric offsets (8 compass
 * directions) → copies scaled toward a point just inside a convex vertex
 * (saves concave drawn shapes whose centroid sits outside) → progressively
 * smaller concentric copies → the concentric scaled copy itself only as a
 * last resort.
 */
export function randomOffsetShrinkBoundary(
  boundary: GeoPolygon,
  options: {
    factor?: number;
    random?: () => number;
    maxAttempts?: number;
  } = {},
): ShrinkDrawResult {
  const factor = options.factor ?? SHRINK_RADIUS_FACTOR;
  const random = options.random ?? Math.random;
  const maxAttempts = options.maxAttempts ?? SHRINK_MAX_ATTEMPTS;
  const centroid = polygonCentroid(boundary);
  const scaled = scalePolygonTowardCentroid(boundary, factor);
  const scaledRadius = zoneDiameterMeters(scaled) / 2;
  const currentRadius = zoneDiameterMeters(boundary) / 2;
  // The smaller shape can move at most (current − scaled) radius from centre.
  const maxOffset = Math.max(0, currentRadius - scaledRadius);

  // Random draws, uniform over the disc the smaller shape can occupy.
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const angle = random() * 2 * Math.PI;
    const radius = Math.sqrt(random()) * maxOffset;
    const dx = radius * Math.cos(angle);
    const dy = radius * Math.sin(angle);
    const offset = Math.hypot(dx, dy);
    if (offset < MIN_NEXT_ZONE_OFFSET_M) continue;
    const candidate = offsetPolygon(scaled, dx, dy);
    if (polygonFullyInside(candidate, boundary)) {
      return { boundary: candidate, method: 'random', offsetMeters: offset };
    }
  }

  // Fallback 1: deterministic non-concentric offsets, 8 compass directions.
  const directions = [0, 45, 90, 135, 180, 225, 270, 315];
  for (const degrees of directions) {
    const angle = (degrees * Math.PI) / 180;
    for (const fraction of [0.75, 0.5, 0.25]) {
      const dx = Math.cos(angle) * maxOffset * fraction;
      const dy = Math.sin(angle) * maxOffset * fraction;
      const offset = Math.hypot(dx, dy);
      if (offset < MIN_NEXT_ZONE_OFFSET_M) continue;
      const candidate = offsetPolygon(scaled, dx, dy);
      if (polygonFullyInside(candidate, boundary)) {
        return { boundary: candidate, method: 'compass-fallback', offsetMeters: offset };
      }
    }
  }

  // Fallback 2: scale toward a point just inside a convex vertex (saves
  // concave drawn shapes whose centroid sits outside the shape).
  for (const vertex of boundary) {
    const toward = { lat: centroid.lat + (vertex.lat - centroid.lat) * 0.9, lng: centroid.lng + (vertex.lng - centroid.lng) * 0.9 };
    if (!pointInPolygon(toward, boundary)) continue;
    const candidate = scalePolygonTowardPoint(boundary, toward, factor);
    const offset = haversineMeters(polygonCentroid(candidate), centroid);
    if (offset >= MIN_NEXT_ZONE_OFFSET_M && polygonFullyInside(candidate, boundary)) {
      return { boundary: candidate, method: 'vertex-fallback', offsetMeters: offset };
    }
  }

  // Fallback 3: progressively smaller concentric copies.
  for (const smaller of [0.6, 0.5, 0.4, 0.3]) {
    const candidate = scalePolygonTowardCentroid(boundary, smaller);
    if (polygonFullyInside(candidate, boundary)) {
      return { boundary: candidate, method: 'smaller-concentric', offsetMeters: 0 };
    }
  }

  // Last resort only: the concentric scaled copy itself.
  return { boundary: scaled, method: 'concentric-last-resort', offsetMeters: 0 };
}

// ---------------------------------------------------------------------------
// Outside-zone rule: 30 s, then ejection
// ---------------------------------------------------------------------------

/** Per-player outside-zone countdown state (DO memory only, never persisted). */
export interface OutsideZoneState {
  /** Epoch ms of the first-seen-outside of the current segment, or null. */
  outsideSinceMs: number | null;
  /** Seconds already counted in earlier segments (kept while GPS is poor). */
  outsideAccumMs: number;
}

export function emptyOutsideZoneState(): OutsideZoneState {
  return { outsideSinceMs: null, outsideAccumMs: 0 };
}

export interface OutsideZoneUpdate {
  state: OutsideZoneState;
  /** Seconds left on the return countdown (30 when fully inside). */
  remainingSeconds: number;
  /** True when the accumulated outside time has reached 30 s: eject. */
  shouldEject: boolean;
}

/**
 * Advance one player's outside-zone countdown from a fresh fix.
 * - Inside with a trustworthy fix: both counters clear.
 * - Outside with a trustworthy fix: the current segment accrues; at
 *   accumulated + current segment ≥ 30 s the player is ejected.
 * - Poor accuracy (B1): the countdown FREEZES — seconds already counted
 *   stay in `outsideAccumMs`, no new seconds accrue — WHICHEVER side of
 *   the boundary the fix's centre falls on. A ±1000 m fix whose centre
 *   happens to land inside must not clear accrued outside time any more
 *   than one landing outside may accrue it: a poor fix is never used for
 *   a zone decision, in either direction.
 */
export function updateOutsideZone(
  state: OutsideZoneState,
  input: { inside: boolean; poorAccuracy: boolean; nowMs: number },
): OutsideZoneUpdate {
  if (input.poorAccuracy) {
    const frozen = state.outsideSinceMs === null
      ? { ...state }
      : { outsideSinceMs: null, outsideAccumMs: state.outsideAccumMs + (input.nowMs - state.outsideSinceMs) };
    const remaining = Math.max(
      0,
      OUTSIDE_ZONE_RETURN_SECONDS - frozen.outsideAccumMs / 1000,
    );
    return { state: frozen, remainingSeconds: remaining, shouldEject: false };
  }
  if (input.inside) {
    return {
      state: emptyOutsideZoneState(),
      remainingSeconds: OUTSIDE_ZONE_RETURN_SECONDS,
      shouldEject: false,
    };
  }
  const since = state.outsideSinceMs ?? input.nowMs;
  const totalMs = state.outsideAccumMs + (input.nowMs - since);
  const shouldEject = totalMs >= OUTSIDE_ZONE_RETURN_SECONDS * 1000;
  return {
    state: { outsideSinceMs: since, outsideAccumMs: state.outsideAccumMs },
    remainingSeconds: Math.max(0, OUTSIDE_ZONE_RETURN_SECONDS - totalMs / 1000),
    shouldEject,
  };
}

/**
 * Apply an outside-zone ejection to a seat. Idempotent and never undone by
 * rejoining: a second call leaves the first `ejectedAt` in place.
 * Returns the updated seat (a shallow copy; the input is not mutated).
 */
export function applyOutsideZoneEjection<T extends { ejectedAt: string | null }>(
  player: T,
  nowMs: number,
): T {
  if (player.ejectedAt !== null) return player;
  return { ...player, ejectedAt: new Date(nowMs).toISOString() };
}
