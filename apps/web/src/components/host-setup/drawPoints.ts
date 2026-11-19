import type { GeoPolygon } from '@pakdam/shared';

/**
 * Tap-to-place draw points — pure helpers for the Draw zone editor
 * (founder spec, 2026-11-19). No default shape: the host taps the map
 * and a numbered point drops (1, 2, 3…); 3 taps enclose a triangle,
 * a 4th tap makes 4 corners, a 5th makes 5, open-ended. Undo removes
 * the last point, Redraw clears all points, DONE applies the polygon.
 * These helpers are pure (no React, no map) so the web-lib suite can
 * pin the semantics without a constructed map; the Playwright specs
 * cover the map UI itself.
 */

/** Append a tapped point. Points are never reordered — the number a
 *  point shows is its position in this list, so Undo (pop the last)
 *  always removes the most recently placed point. */
export function addDrawPoint(points: GeoPolygon, lat: number, lng: number): GeoPolygon {
  return [...points, { lat, lng }];
}

/** Undo: drop the most recently placed point. Empty stays empty. */
export function undoDrawPoint(points: GeoPolygon): GeoPolygon {
  return points.slice(0, -1);
}

/** A draft applies only once it encloses an area: 3 points minimum.
 *  0–2 points can never be a zone. */
export function canApplyDraw(points: GeoPolygon): boolean {
  return points.length >= 3;
}

/** True when the draft is exactly the applied shape (same points, in
 *  order) — the editor shows "Zone applied" only then, and "tap DONE
 *  to apply" while they differ. */
export function drawPointsEqual(a: GeoPolygon | null, b: GeoPolygon | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => p.lat === b[i]!.lat && p.lng === b[i]!.lng);
}
