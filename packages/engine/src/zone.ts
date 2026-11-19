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
  MIN_NEXT_ZONE_OFFSET_M,
  SHRINK_MAX_ATTEMPTS,
  SHRINK_RADIUS_FACTOR,
  ZONE_RADIUS_MIN_M,
  type GeoPoint,
  type GeoPolygon,
  haversineMeters,
} from '@pakdam/shared';

export { haversineMeters, ZONE_RADIUS_MIN_M };

/** Outside-zone return countdown: 30 s, then ejection (fixed founder rule). */
export const OUTSIDE_ZONE_RETURN_SECONDS = 30;

/**
 * Metres per degree of latitude (equirectangular approximation). This MUST
 * match the haversine Earth radius in @pakdam/shared (R = 6,371,000 m):
 * a circle built with this constant measures its nominal radius back
 * through `zoneDiameterMeters` (haversine). The old 111,320 value made a
 * nominal 500 m zone measure 499 m in the lobby and the zone editor.
 */
const METERS_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;

/** Convert a point to local metres relative to an origin point. */
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

/** N-point circle approximation (equirectangular + cos(lat) correction). */
export function circlePolygon(
  centre: GeoPoint,
  radiusMeters: number,
  points = 64,
): GeoPolygon {
  const boundary: GeoPolygon = [];
  for (let i = 0; i < points; i += 1) {
    const angle = (2 * Math.PI * i) / points;
    boundary.push(
      fromLocalMeters(
        { x: radiusMeters * Math.cos(angle), y: radiusMeters * Math.sin(angle) },
        centre,
      ),
    );
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
 * Shrink times (seconds from match start): every `intervalSeconds` while
 * `< durationSeconds`. Empty when shrinking is off.
 */
export function shrinkTimesSeconds(
  durationSeconds: number,
  intervalSeconds: number,
  shrinkEnabled: boolean,
): number[] {
  if (!shrinkEnabled || intervalSeconds <= 0) return [];
  const times: number[] = [];
  for (let t = intervalSeconds; t < durationSeconds; t += intervalSeconds) {
    times.push(t);
  }
  return times;
}

/** How many shrinks have fired by `elapsedSeconds` into the match. */
export function shrinkIndexAt(
  elapsedSeconds: number,
  intervalSeconds: number,
  shrinkEnabled: boolean,
): number {
  if (!shrinkEnabled || intervalSeconds <= 0 || elapsedSeconds < 0) return 0;
  return Math.floor(elapsedSeconds / intervalSeconds);
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
 * position fully inside the current boundary — NOT concentric. Offset drawn
 * uniformly over the disc the smaller shape can occupy; every candidate is
 * verified with `polygonFullyInside`; draws within 10 m of the current
 * centre are discarded and re-drawn. Up to 50 attempts, then fallbacks in
 * order: deterministic non-concentric offsets (8 compass directions) →
 * copies scaled toward a point just inside a convex vertex (saves concave
 * drawn shapes whose centroid sits outside) → progressively smaller
 * concentric copies → the concentric scaled copy itself only as a last
 * resort.
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
 * - Inside: both counters clear.
 * - Outside with a trustworthy fix: the current segment accrues; at
 *   accumulated + current segment ≥ 30 s the player is ejected.
 * - Outside with poor accuracy: the countdown FREEZES — seconds already
 *   counted stay in `outsideAccumMs`, no new seconds accrue.
 */
export function updateOutsideZone(
  state: OutsideZoneState,
  input: { inside: boolean; poorAccuracy: boolean; nowMs: number },
): OutsideZoneUpdate {
  if (input.inside) {
    return {
      state: emptyOutsideZoneState(),
      remainingSeconds: OUTSIDE_ZONE_RETURN_SECONDS,
      shouldEject: false,
    };
  }
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
