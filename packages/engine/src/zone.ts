import type { GeoPoint, GeoPolygon, Player, ZoneConfig } from '@pakdam/shared';
import { OUTSIDE_ZONE_RETURN_SECONDS } from '@pakdam/shared';
export function pointInPolygon(pt: GeoPoint, poly: GeoPolygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!; const b = poly[j]!;
    if (((a.lat > pt.lat) !== (b.lat > pt.lat)) && (pt.lng < ((b.lng - a.lng) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lng)) inside = !inside;
  }
  return inside;
}

/** Great-circle distance between two points, in metres. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Widest distance across a zone boundary, in metres (the zone's size
 *  across). For the circle polygons the create screen builds this is the
 *  diameter. Used by the host dashboard; NOT a calibrated measurement. */
export function zoneDiameterMeters(boundary: GeoPolygon): number {
  let max = 0;
  for (let i = 0; i < boundary.length; i++) {
    for (let j = i + 1; j < boundary.length; j++) {
      max = Math.max(max, haversineMeters(boundary[i]!, boundary[j]!));
    }
  }
  return Math.round(max);
}

/**
 * Outside-zone rule (founder FINAL, 2026-11-17 — replaces the old
 * SCRAM live/tag thresholds): a player outside the zone
 * gets a fixed 30-second return countdown (OUTSIDE_ZONE_RETURN_SECONDS)
 * on their own screen. At 0 they are EJECTED from the game. While
 * outside, Hunters may see the player's coarse area — never an exact
 * pin. The helpers below are the whole rule: how many seconds are left
 * on the countdown, and whether the countdown has run out.
 */
export function outsideZoneReturnRemainingSeconds(secondsOutside: number, returnSeconds: number = OUTSIDE_ZONE_RETURN_SECONDS): number {
  return Math.max(0, returnSeconds - Math.max(0, secondsOutside));
}
/** True once the player has been outside for the full return window. */
export function isOutsideZoneEjectionDue(secondsOutside: number, returnSeconds: number = OUTSIDE_ZONE_RETURN_SECONDS): boolean {
  return secondsOutside >= returnSeconds;
}

/** Apply the ejection at countdown zero: the player is out of play
 *  (ejectedAt set) but stays in the room record — leftAt stays null
 *  and the seat is never deleted. Idempotent: an already-ejected
 *  player is returned unchanged, and an ejection is NEVER undone by
 *  rejoining (the caller must not clear ejectedAt on restore).
 *  Call only when isOutsideZoneEjectionDue says the countdown is up. */
export function applyOutsideZoneEjection(player: Player, nowIso: string): Player {
  if (player.ejectedAt) return player;
  return { ...player, ejectedAt: nowIso };
}

/** Shrink schedule: the elapsed seconds at which the zone shrinks, from
 *  the host's shrink interval. Empty when shrinking is off. The geometry
 *  of each smaller boundary is a host/map concern, not computed here. */
export function shrinkTimesSeconds(durationSeconds: number, shrinkIntervalSeconds: number, shrinkEnabled: boolean): number[] {
  if (!shrinkEnabled || shrinkIntervalSeconds <= 0) return [];
  const times: number[] = [];
  for (let t = shrinkIntervalSeconds; t < durationSeconds; t += shrinkIntervalSeconds) times.push(t);
  return times;
}

/** Each shrink loses a quarter of the radius: the zone keeps 75% of
 *  its radius per shrink (host screen: "loses a quarter of its radius
 *  each shrink"). `shrinkCount` is how many shrinks have happened. */
export const SHRINK_RADIUS_FACTOR = 0.75;
export function shrunkRadiusMeters(radiusMeters: number, shrinkCount: number): number {
  if (shrinkCount <= 0) return radiusMeters;
  return radiusMeters * SHRINK_RADIUS_FACTOR ** shrinkCount;
}

/** Centroid of a polygon (average of its vertices). Null when empty.
 *  For the regular polygons this app builds (circle approximations,
 *  regular drawn starts) the centroid is the shape's centre; for a
 *  concave drawn shape it can sit outside the shape — callers that
 *  need an interior point must check containment, not assume it. */
export function polygonCentroid(poly: GeoPolygon): GeoPoint | null {
  if (poly.length === 0) return null;
  let lat = 0;
  let lng = 0;
  for (const p of poly) { lat += p.lat; lng += p.lng; }
  return { lat: lat / poly.length, lng: lng / poly.length };
}

/** N-point circle approximation around a centre (the boundary a room
 *  is created with, and each drawn no-go area). Equirectangular
 *  approximation with the cos(lat) longitude correction — the same
 *  approximation scalePolygonTowardCentroid uses, so a circle polygon
 *  and its shrunk copies stay concentric in metres. Fine for play
 *  zones a few kilometres across. */
export function circlePolygon(lat: number, lng: number, radiusMeters: number, points = 8): GeoPolygon {
  const pts: GeoPolygon = [];
  for (let i = 0; i < points; i++) {
    const a = (i * 2 * Math.PI) / points;
    pts.push({
      lat: lat + (radiusMeters * Math.cos(a)) / 111320,
      lng: lng + (radiusMeters * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180)),
    });
  }
  return pts;
}

/** Scale a polygon toward its centroid by a factor (1 = unchanged,
 *  0.5 = half the size across). Same equirectangular approximation
 *  as circlePolygon. */
export function scalePolygonTowardCentroid(poly: GeoPolygon, factor: number): GeoPolygon {
  const c = polygonCentroid(poly);
  if (!c || poly.length === 0) return poly;
  return scalePolygonTowardPoint(poly, factor, c);
}

/** Scale a polygon toward an arbitrary anchor point (1 = unchanged).
 *  Scaling toward a vertex keeps that vertex fixed and pulls every
 *  other vertex toward it. */
export function scalePolygonTowardPoint(poly: GeoPolygon, factor: number, anchor: GeoPoint): GeoPolygon {
  return poly.map((p) => ({
    lat: anchor.lat + (p.lat - anchor.lat) * factor,
    lng: anchor.lng + (p.lng - anchor.lng) * factor,
  }));
}

/** Signed area of a polygon (degrees² — sign only is used). */
function signedArea(poly: GeoPolygon): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.lng * b.lat - b.lng * a.lat;
  }
  return s / 2;
}

/** True when vertex `i` is convex (interior angle < 180°). A tiny
 *  copy scaled toward a point just inside a convex vertex stays
 *  inside the interior wedge at that vertex, so shrinking toward one
 *  always finds an inside copy — unlike shrinking toward the
 *  centroid, which for a concave shape can sit outside the shape
 *  entirely, so no amount of concentric shrinking ever gets inside.
 *  The anchor is NOT the vertex itself: a copy scaled toward a
 *  boundary vertex shares that vertex and its incident edges, and
 *  polygonFullyInside counts touching the boundary as outside. */
function isConvexVertex(poly: GeoPolygon, i: number): boolean {
  const area = signedArea(poly);
  if (area === 0) return false;
  const prev = poly[(i - 1 + poly.length) % poly.length]!;
  const cur = poly[i]!;
  const next = poly[(i + 1) % poly.length]!;
  const cross = (cur.lng - prev.lng) * (next.lat - cur.lat) - (cur.lat - prev.lat) * (next.lng - cur.lng);
  return area > 0 ? cross > 0 : cross < 0;
}

/** Interior anchor near convex vertex `i`: 10% of the way from the
 *  vertex toward the midpoint of its two neighbours. For a convex
 *  vertex that segment lies inside the triangle prev–vertex–next,
 *  which lies inside the polygon — so the anchor is strictly inside
 *  the shape, never on its boundary. */
function interiorAnchorNearVertex(poly: GeoPolygon, i: number): GeoPoint {
  const prev = poly[(i - 1 + poly.length) % poly.length]!;
  const cur = poly[i]!;
  const next = poly[(i + 1) % poly.length]!;
  const midLat = (prev.lat + next.lat) / 2;
  const midLng = (prev.lng + next.lng) / 2;
  return { lat: cur.lat + (midLat - cur.lat) * 0.1, lng: cur.lng + (midLng - cur.lng) * 0.1 };
}

/** Translate a polygon by degrees of latitude/longitude. */
export function translatePolygon(poly: GeoPolygon, dLat: number, dLng: number): GeoPolygon {
  return poly.map((p) => ({ lat: p.lat + dLat, lng: p.lng + dLng }));
}

function orientation(a: GeoPoint, b: GeoPoint, c: GeoPoint): number {
  const v = (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  if (Math.abs(v) < 1e-15) return 0;
  return v > 0 ? 1 : -1;
}
function onSegment(a: GeoPoint, b: GeoPoint, c: GeoPoint): boolean {
  return b.lng >= Math.min(a.lng, c.lng) && b.lng <= Math.max(a.lng, c.lng) &&
    b.lat >= Math.min(a.lat, c.lat) && b.lat <= Math.max(a.lat, c.lat);
}
/** True when two segments touch or cross (touching counts: a boundary
 *  that merely grazes the outer edge is not fully inside). */
export function segmentsIntersect(a1: GeoPoint, a2: GeoPoint, b1: GeoPoint, b2: GeoPoint): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;
  return false;
}

/** True when `inner` lies fully inside `outer`: every vertex of
 *  `inner` is inside `outer` AND no edge of `inner` crosses an edge
 *  of `outer`. Both checks are needed: vertices-inside alone does not
 *  rule out an edge poking out through a concave bite of `outer`. */
export function polygonFullyInside(inner: GeoPolygon, outer: GeoPolygon): boolean {
  if (inner.length < 3 || outer.length < 3) return false;
  for (const p of inner) {
    if (!pointInPolygon(p, outer)) return false;
  }
  for (let i = 0; i < inner.length; i++) {
    const a1 = inner[i]!;
    const a2 = inner[(i + 1) % inner.length]!;
    for (let j = 0; j < outer.length; j++) {
      const b1 = outer[j]!;
      const b2 = outer[(j + 1) % outer.length]!;
      if (segmentsIntersect(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

/**
 * Minimum centre shift (metres) for a next zone to count as a random
 * offset rather than concentric. A draw that lands within this of the
 * current centre is discarded and re-drawn — the founder rule is
 * "never concentric", and a zero/near-zero draw (hostile RNG, or a
 * real RNG landing on ~0) must never be accepted just because the
 * concentric copy verifies fully inside. 10 m is a geometry guard
 * (the test threshold), not a calibrated gameplay value.
 */
export const MIN_NEXT_ZONE_OFFSET_M = 10;

/**
 * PUBG/BGMI-style random-offset next zone (founder decision,
 * 2026-11-17): scale `boundary` toward its centroid by `factor`
 * (the host's shrink setting — size only), then move the smaller
 * shape to a RANDOMLY selected position fully inside the current
 * boundary — NOT concentric, not the same centre. One side of the
 * zone shrinks a lot, the other barely moves, so players must read
 * the preview and move.
 *
 * The offset is drawn uniformly over the disc the smaller shape can
 * occupy (radius (1 - factor) × the furthest vertex distance from
 * the centroid) and every candidate is verified with
 * polygonFullyInside before it is returned. `random` is injectable
 * so tests can use a seeded RNG; production passes Math.random.
 *
 * Fallback (no random draw verified in 50 attempts): the returned
 * boundary is STILL verified fully inside — never the concentric
 * copy unchecked. In order: (1) deterministic non-concentric offsets
 * of the host-size copy (the founder rule is "never concentric");
 * (2) copies scaled toward a point just inside a convex vertex of
 * the shape, progressively smaller — also non-concentric by
 * construction, and what saves a concave drawn shape whose vertex
 * centroid sits outside the shape: shrinking toward the centroid
 * collapses onto a point outside the shape, so no concentric copy
 * can ever be inside, while a small enough copy scaled toward a
 * convex vertex sits inside the interior wedge at that vertex;
 * (3) progressively smaller concentric copies; (4) the concentric
 * scaled copy itself, ONLY as a last resort when no non-concentric
 * copy verified at all. The fallback copies are smaller than the
 * host's shrink size — a smaller zone that is fully inside is
 * correct; a full-size zone poking outside the play area is not.
 * The last resort (a 2%-size copy toward the first convex
 * vertex) is returned only if no verified copy was found, which
 * cannot happen for a non-degenerate polygon.
 */
export function randomOffsetShrinkBoundary(boundary: GeoPolygon, factor: number, random: () => number = Math.random): GeoPolygon {
  if (boundary.length < 3 || factor >= 1 || factor <= 0) return boundary;
  const scaled = scalePolygonTowardCentroid(boundary, factor);
  const centroid = polygonCentroid(boundary);
  if (!centroid) return scaled;
  let maxVertexDistM = 0;
  for (const p of boundary) maxVertexDistM = Math.max(maxVertexDistM, haversineMeters(centroid, p));
  const maxShiftM = (1 - factor) * maxVertexDistM;
  if (maxShiftM <= 0) return scaled;
  const cosLat = Math.cos((centroid.lat * Math.PI) / 180);
  for (let attempt = 0; attempt < 50; attempt++) {
    const angle = random() * 2 * Math.PI;
    const distM = maxShiftM * Math.sqrt(random());
    // Never accept a (near-)concentric draw: distM ~ 0 verifies fully
    // inside, so without this check a hostile/stuck RNG (or a real
    // one landing on ~0) returns the concentric copy — the one
    // outcome the founder rule forbids. Discard and re-draw instead.
    if (distM <= MIN_NEXT_ZONE_OFFSET_M) continue;
    const dLat = (distM * Math.cos(angle)) / 111320;
    const dLng = (distM * Math.sin(angle)) / (111320 * cosLat);
    const candidate = translatePolygon(scaled, dLat, dLng);
    if (polygonFullyInside(candidate, boundary)) return candidate;
  }
  // Fallback: shrink until a copy verifies fully inside. The founder
  // rule is "never concentric", so NON-concentric copies are tried
  // first: deterministic offsets (8 compass directions, full and half
  // the max shift) of the host-size copy, then copies scaled toward
  // a point just inside a convex vertex of the shape. Only when no
  // non-concentric copy verifies does the fallback try progressively
  // smaller concentric copies, and the concentric scaled copy itself
  // only as a last resort before the unchecked 2% return below.
  // The vertex-anchored step is what saves a concave drawn shape
  // whose vertex centroid sits outside the shape: shrinking toward
  // the centroid collapses onto a point outside the shape, so no
  // concentric copy can ever be inside, while a small enough copy
  // scaled toward a convex vertex sits inside the interior wedge at
  // that vertex. The fallback copies are smaller than the host's
  // shrink size — a smaller zone that is fully inside is correct; a
  // full-size zone poking outside the play area is not.
  for (const frac of [1, 0.5]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const dLat = (frac * maxShiftM * Math.cos(a)) / 111320;
      const dLng = (frac * maxShiftM * Math.sin(a)) / (111320 * cosLat);
      const candidate = translatePolygon(scaled, dLat, dLng);
      if (polygonFullyInside(candidate, boundary)) return candidate;
    }
  }
  for (let i = 0; i < boundary.length; i++) {
    if (!isConvexVertex(boundary, i)) continue;
    const anchor = interiorAnchorNearVertex(boundary, i);
    for (let f = factor; f >= 0.02; f *= 0.9) {
      const candidate = scalePolygonTowardPoint(boundary, f, anchor);
      if (polygonFullyInside(candidate, boundary)) return candidate;
    }
  }
  for (let f = factor * 0.9; f >= 0.05; f *= 0.9) {
    const candidate = scalePolygonTowardCentroid(boundary, f);
    if (polygonFullyInside(candidate, boundary)) return candidate;
  }
  // Last-resort concentric copy: reached only when no non-concentric
  // copy and no smaller concentric copy verified — a verified
  // concentric zone is still a legal zone, just not a random offset.
  if (polygonFullyInside(scaled, boundary)) return scaled;
  // Last resort: the smallest vertex-anchored copy. For a
  // non-degenerate polygon this is inside (see isConvexVertex); it is
  // returned unchecked only because the loop above already covers
  // every size down to 2%.
  const firstConvex = boundary.findIndex((_, i) => isConvexVertex(boundary, i));
  const anchor = firstConvex >= 0 ? interiorAnchorNearVertex(boundary, firstConvex) : boundary[0]!;
  return scalePolygonTowardPoint(boundary, 0.02, anchor);
}

/** The zone boundary in force at `nowMs`: the latest shrink phase
 *  whose time has passed, else the base boundary. `startedAt` is the
 *  match start (ISO string); null before the match starts. This is
 *  the single definition of "current zone" — the map, the HUD size
 *  text, the way-back guide, the outside-zone check (client and
 *  worker) and the next-zone preview all derive from it, so they can
 *  never disagree about which zone is live. */
export function effectiveZoneBoundary(zone: ZoneConfig, startedAt: string | null, nowMs: number): GeoPolygon {
  const elapsed = startedAt ? Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 1000)) : null;
  if (elapsed === null) return zone.boundary;
  let current = zone.boundary;
  for (const p of zone.shrinkPhases) {
    if (p.atSeconds <= elapsed) current = p.boundary;
  }
  return current;
}

/** Next shrink phase for a zone, given the match start. Returns null
 *  when no shrink is scheduled or all phases have passed. The HUD
 *  bar, the next-zone panel and the map's dashed preview all read
 *  this one helper, so the preview, the countdown and the map can
 *  never disagree. */
export function nextShrinkPhaseAt(
  zone: ZoneConfig,
  startedAt: string | null,
  nowMs: number,
): { atSeconds: number; inSeconds: number | null; boundary: GeoPolygon; totalPhases: number; phaseIndex: number } | null {
  const elapsed = startedAt ? Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 1000)) : null;
  const idx = zone.shrinkPhases.findIndex((p) => elapsed === null || p.atSeconds > elapsed);
  if (idx === -1) return null;
  const phase = zone.shrinkPhases[idx]!;
  return {
    atSeconds: phase.atSeconds,
    inSeconds: elapsed === null ? null : phase.atSeconds - elapsed,
    boundary: phase.boundary,
    totalPhases: zone.shrinkPhases.length,
    phaseIndex: idx,
  };
}
