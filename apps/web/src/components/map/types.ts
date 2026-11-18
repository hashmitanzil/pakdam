/** Shared props for the map view — one contract: the offline
 *  MapLibre view draws the zone, next zone, ping areas, no-go areas,
 *  and own location as an uncertainty circle. Coordinates live here
 *  only as numbers in props; the view never renders them as text
 *  (founder rule: no lat/lng numbers anywhere in the UI). */
import type { GeoPolygon } from '@pakdam/shared';

export interface OverlayProps {
  lat: number | null; lng: number | null; accuracyM: number | null; label: string;
  zoneBoundary?: GeoPolygon; nextZoneBoundary?: GeoPolygon;
  pingArea?: { lat: number; lng: number; radiusMeters: number; label: string } | null;
  /** Named coarse ping areas: one shaded area per Runner ping,
   *  labelled with the Runner's name + age ("0:27 ago", counting
   *  up). The centre is offset and the radius wide by design —
   *  these are areas, never exact pins. A ping stays until the next
   *  ping replaces it (founder decision, 2026-11-17 — never removed
   *  on a timer). `stale` marks an earlier ping kept only because
   *  Show ping history is on: it renders dimmer, and its age keeps
   *  counting up. */
  pingAreas?: { name: string; lat: number; lng: number; radiusMeters: number; reportedAt: string; stale?: boolean }[];
  /** Show ping history is ON in this room: earlier ping areas stay
   *  visible (dimmer, aged) instead of only the latest showing. */
  pingHistoryOn?: boolean;
  noGoAreas?: GeoPolygon[];
}

export interface MapViewProps extends OverlayProps {
  /** Tap handler — reports tapped map coordinates to the caller. When
   *  given, the cursor becomes a crosshair. */
  onMapClick?: (lat: number, lng: number) => void;
  /** Keyboard panning. Host setup passes false so arrow keys move the
   *  zone instead of panning the map. Defaults to true. */
  keyboardPan?: boolean;
  /** Called when the view cannot initialise (no WebGL / library
   *  failed to load) so the parent can show an honest error instead
   *  of a blank map. There is no fallback view, by founder decision. */
  onInitFailed?: () => void;
}
