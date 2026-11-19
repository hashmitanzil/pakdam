/**
 * Pure point / zone math for the host-setup map (SCRAM-SPEC §5e–§6).
 *
 * No I/O, no React, no map instance — the PlayAreaMap and ZoneEditor
 * components own the map; this module only turns tap points into zone
 * geometry. Canonical circle/polygon helpers come from @pakdam/engine.
 */
import {
  circlePolygon,
  polygonCentroid,
  scalePolygonTowardCentroid,
  zoneDiameterMeters,
  type GeoPoint,
  type GeoPolygon,
} from '@pakdam/engine';
import {
  ZONE_RADIUS_DEFAULT_M,
  ZONE_RADIUS_MIN_M,
  haversineMeters,
} from '@pakdam/shared';

export type { GeoPoint, GeoPolygon };

/** A drawn zone needs at least 3 taps — 3 taps = a triangle. */
export const DRAW_MIN_POINTS = 3;
/** Cap on placed corners; the editor's Corners stepper stops here. */
export const DRAW_MAX_POINTS = 12;

/** True once the drawn shape closes (3+ points). */
export function isCompleteDrawPolygon(points: readonly GeoPoint[]): boolean {
  return points.length >= DRAW_MIN_POINTS;
}

/** Drawn tap points as a zone boundary (a copy; [] until 3 points). */
export function drawPointsToBoundary(points: readonly GeoPoint[]): GeoPolygon {
  if (!isCompleteDrawPolygon(points)) return [];
  return points.map((p) => ({ lat: p.lat, lng: p.lng }));
}

/** Radius of a zone boundary (half its widest span); default when empty. */
export function boundaryRadiusMeters(boundary: readonly GeoPoint[]): number {
  if (boundary.length < 3) return ZONE_RADIUS_DEFAULT_M;
  return Math.round(zoneDiameterMeters(boundary as GeoPolygon) / 2);
}

/** Centre of a zone boundary; Ranchi/Doranda when there is no boundary. */
export function boundaryCentre(boundary: readonly GeoPoint[]): GeoPoint {
  if (boundary.length === 0) return { lat: 23.36, lng: 85.33 };
  return polygonCentroid(boundary as GeoPolygon);
}

/** Circle boundary for a centre + radius (the Circle shape). */
export function circleBoundary(centre: GeoPoint, radiusMeters: number): GeoPolygon {
  return circlePolygon(centre, clampRadiusMeters(radiusMeters));
}

/** Zone radius, clamped to the founder minimum (100 m); no maximum. */
export function clampRadiusMeters(radiusMeters: number): number {
  if (!Number.isFinite(radiusMeters)) return ZONE_RADIUS_DEFAULT_M;
  return Math.max(ZONE_RADIUS_MIN_M, Math.round(radiusMeters));
}

/** Auto final size = ~25% of the start radius (after two quarter-shrinks). */
export function autoFinalRadiusMeters(startRadiusMeters: number): number {
  return Math.max(25, Math.round(clampRadiusMeters(startRadiusMeters) * 0.25));
}

/** Final-size ring for a drawn polygon: the drawn shape scaled toward its
 *  centroid by final/start, so the preview keeps the drawn shape. */
export function drawFinalBoundary(
  points: readonly GeoPoint[],
  finalRadiusMeters: number,
): GeoPolygon {
  const boundary = drawPointsToBoundary(points);
  if (boundary.length < 3) return [];
  const startRadius = boundaryRadiusMeters(boundary);
  if (startRadius <= 0) return boundary;
  return scalePolygonTowardCentroid(
    boundary,
    Math.min(1, finalRadiusMeters / startRadius),
  );
}

/**
 * Size range of a drawn polygon as `min–max m across` (nearest/farthest
 * vertex from the centroid, doubled) — the Corners stepper sub-label.
 */
export function drawSizeRangeLabel(points: readonly GeoPoint[]): string {
  if (points.length === 0) return '';
  const centre = polygonCentroid(points as GeoPolygon);
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const p of points) {
    const d = haversineMeters(centre, p);
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  const fmt = (m: number): string =>
    m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  return `${fmt(min * 2)}–${fmt(max * 2)} across`;
}

/** Final-size percent of the start radius (null = Auto). */
export function finalSizePercent(
  startRadiusMeters: number,
  finalRadiusMeters: number | null,
): number | null {
  if (finalRadiusMeters === null) return null;
  if (startRadiusMeters <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((finalRadiusMeters / startRadiusMeters) * 100)));
}

/** Final radius in metres from a stored percent (null = Auto). */
export function finalRadiusFromPercent(
  startRadiusMeters: number,
  percent: number | null,
): number {
  if (percent === null || percent === undefined) {
    return autoFinalRadiusMeters(startRadiusMeters);
  }
  return Math.max(25, Math.round((clampRadiusMeters(startRadiusMeters) * percent) / 100));
}
