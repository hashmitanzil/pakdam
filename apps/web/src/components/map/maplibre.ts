/**
 * Ola Maps helper — PROTOCOL-MAP §11 (R10).
 *
 * MapLibre GL JS + Ola Maps vector style `default-dark-standard`.
 * Auth gotcha: the style JSON's own tile/sprite/glyph URLs carry NO api_key,
 * so EVERY request to api.olamaps.io must carry `api_key` as a query
 * parameter — `olaTransformRequest` appends it. Without it the style loads
 * but every tile request fails 401 and the map paints blank.
 *
 * The key comes from `NEXT_PUBLIC_OLA_MAPS_API_KEY` via `getOlaApiKey()` —
 * env only, never hardcoded. If the key is missing, `isOlaConfigured()` is
 * false and the caller must NOT construct the map (show the missing-key
 * banner instead). If the key is wrong, the style load fails 401 and the
 * caller fails gracefully the same way.
 *
 * NOTE: `maplibre-gl` IS in this package's dependency list; the dynamic
 * import below resolves at runtime.
 */

export const OLA_STYLE_URL =
  'https://api.olamaps.io/tiles/vector/v1/styles/default-dark-standard/style.json';

export const OLA_MAP_INITIAL_CENTRE: readonly [number, number] = [85.33, 23.36]; // Ranchi / Doranda [lng, lat]
export const OLA_MAP_INITIAL_ZOOM = 14;
export const OLA_MAP_FIX_ZOOM = 15;
export const OLA_MAP_MIN_ZOOM = 3;
export const OLA_MAP_MAX_ZOOM = 19;

/** Zone overlay colours (SCRAM-SPEC §11): red ring 2 px, 0.08 fill. */
export const ZONE_LINE_COLOR = '#EF4444';
export const ZONE_FILL_COLOR = 'rgba(239, 68, 68, 0.08)';
export const PING_FILL_COLOR = 'rgba(29, 78, 216, 0.18)';
export const NO_GO_FILL_COLOR = 'rgba(185, 28, 28, 0.35)';

/** The Ola API key, from env only. Never hardcoded, never logged. */
export function getOlaApiKey(): string {
  return (process.env.NEXT_PUBLIC_OLA_MAPS_API_KEY ?? '').trim();
}

/** False when no key is configured — the caller must not construct a map. */
export function isOlaConfigured(): boolean {
  return getOlaApiKey().length > 0;
}

export interface OlaTransformRequest {
  url: string;
  resourceType?: string;
}

/**
 * Appends `api_key` to EVERY api.olamaps.io request (style, tiles, sprites,
 * glyphs). Requests to any other host pass through untouched.
 */
export function olaTransformRequest(
  url: string,
  resourceType?: string,
): OlaTransformRequest {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.olamaps.io' && !parsed.searchParams.has('api_key')) {
      parsed.searchParams.set('api_key', getOlaApiKey());
      return { url: parsed.toString(), resourceType };
    }
  } catch {
    // Non-URL (relative) requests pass through untouched.
  }
  return { url, resourceType };
}

/** Minimal structural surface of the MapLibre Map the helpers need. */
export interface MapLibreMapLike {
  resize(): void;
  remove(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  flyTo(options: { center: [number, number]; zoom?: number; duration?: number }): void;
  easeTo(options: { center?: [number, number]; zoom?: number; duration?: number }): void;
  fitBounds(
    bounds: [[number, number], [number, number]],
    options?: { padding?: number; duration?: number },
  ): void;
  addSource(id: string, source: Record<string, unknown>): void;
  getSource(id: string): { setData(data: unknown): void } | undefined;
  addLayer(layer: Record<string, unknown>): void;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  removeSource(id: string): void;
}

export interface CreateOlaMapOptions {
  container: HTMLElement;
  /** [lng, lat]. Defaults to Ranchi/Doranda when no fix / zone is set. */
  center?: readonly [number, number];
  /** True when a GPS fix is held — starts at zoom 15 instead of 14. */
  hasFix?: boolean;
  zoom?: number;
}

/**
 * Construct the Ola dark map. Returns null (and constructs nothing) when
 * the Ola key is missing. Callers must call `map.resize()` after the
 * container resizes or is hidden-then-shown, or the canvas stays blank
 * though tiles loaded.
 */
export async function createOlaMap(
  options: CreateOlaMapOptions,
): Promise<MapLibreMapLike | null> {
  if (!isOlaConfigured()) return null;
  const maplibre = await import('maplibre-gl');
  const map = new maplibre.Map({
    container: options.container,
    style: OLA_STYLE_URL,
    transformRequest: (url: string, resourceType?: string) =>
      olaTransformRequest(url, resourceType),
    center: options.center
      ? [options.center[0], options.center[1]]
      : [OLA_MAP_INITIAL_CENTRE[0], OLA_MAP_INITIAL_CENTRE[1]],
    zoom: options.zoom ?? (options.hasFix ? OLA_MAP_FIX_ZOOM : OLA_MAP_INITIAL_ZOOM),
    minZoom: OLA_MAP_MIN_ZOOM,
    maxZoom: OLA_MAP_MAX_ZOOM,
    dragRotate: false,
    touchPitch: false,
  }) as unknown as MapLibreMapLike;
  return map;
}

/**
 * Re-centre only when the fix moved > 25 m or accuracy at least halved —
 * otherwise the camera stays put so the player can pan freely.
 */
export function shouldRefly(
  lastCentre: { lng: number; lat: number } | null,
  fix: { lng: number; lat: number; accuracyMeters: number },
  lastAccuracyMeters: number | null,
): boolean {
  if (lastCentre === null) return true;
  const dLat = (fix.lat - lastCentre.lat) * 111_320;
  const dLng =
    (fix.lng - lastCentre.lng) *
    111_320 *
    Math.cos((fix.lat * Math.PI) / 180);
  const movedM = Math.hypot(dLat, dLng);
  if (movedM > 25) return true;
  if (
    lastAccuracyMeters !== null &&
    fix.accuracyMeters * 2 <= lastAccuracyMeters
  ) {
    return true;
  }
  return false;
}
