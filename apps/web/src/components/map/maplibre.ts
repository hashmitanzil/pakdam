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
 * STYLE FIX (founder-reported, live site): the Ola style JSON declares a
 * style layer `3d_model_data` whose `source-layer` is `3d_model` on the
 * source `vectordata` — but the vectordata tiles contain NO `3d_model`
 * source layer, so MapLibre refuses the whole style:
 * "Source layer "3d_model" does not exist on source "vectordata" as
 * specified by style layer "3d_model_data"." This is a STYLE error, not a
 * network/key error. `createOlaMap` therefore fetches the style JSON
 * first, strips every layer that references the missing `3d_model`
 * source layer (and the `3d_model_data` layer itself), and passes the
 * CLEANED STYLE OBJECT to MapLibre — never the style URL. If the style
 * fetch itself fails, it falls back to the URL so the caller's existing
 * error banner still shows the real detail.
 *
 * NOTE: `maplibre-gl` IS in this package's dependency list; the dynamic
 * import below resolves at runtime.
 */

export const OLA_STYLE_URL =
  'https://api.olamaps.io/tiles/vector/v1/styles/default-dark-standard/style.json';

/**
 * The Ola dark style URL with the api_key appended. The style request
 * itself must carry the key — relying only on transformRequest leaves the
 * style fetch unauthenticated if the transform is not applied to it, and
 * the whole map then fails to load (blank area). Tiles, sprites and
 * glyphs still get the key via transformRequest (it skips URLs that
 * already carry api_key, so there is no duplicate).
 */
export function buildOlaStyleUrl(): string {
  const key = getOlaApiKey();
  if (!key) return OLA_STYLE_URL;
  try {
    const url = new URL(OLA_STYLE_URL);
    url.searchParams.set('api_key', key);
    return url.toString();
  } catch {
    return OLA_STYLE_URL;
  }
}

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
 * Appends `api_key` to EVERY Ola Maps request (style, tiles, sprites,
 * glyphs). Requests to any other host pass through untouched.
 *
 * Host gotcha (this is why the map never loaded): Ola's style JSON
 * references `app.olamaps.io` for some resources (tiles / sprites /
 * glyphs), not `api.olamaps.io`. The Ola SDK's `getTransformRequest`
 * rewrites `app.olamaps.io` to `api.olamaps.io` before appending the
 * key — without that rewrite, those requests go out with NO api_key,
 * Ola answers 401, MapLibre fires 'error', and the map shows
 * "Map couldn't load". So this matches the SDK exactly: normalise the
 * host first, then append the key to every olamaps.io request.
 */
export function olaTransformRequest(
  url: string,
  resourceType?: string,
): OlaTransformRequest {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname !== 'api.olamaps.io' &&
      parsed.hostname !== 'app.olamaps.io'
    ) {
      return { url, resourceType };
    }
    if (parsed.hostname === 'app.olamaps.io') {
      parsed.hostname = 'api.olamaps.io';
    }
    if (!parsed.searchParams.has('api_key')) {
      parsed.searchParams.set('api_key', getOlaApiKey());
    }
    return { url: parsed.toString(), resourceType };
  } catch {
    // Non-URL (relative) requests pass through untouched.
    return { url, resourceType };
  }
}

/** Style-layer ids that reference a source layer the Ola tiles do not ship. */
const INCOMPATIBLE_STYLE_LAYER_IDS = new Set(['3d_model_data', '3d_model']);
/** Source layers missing from the Ola `vectordata` tiles. */
const INCOMPATIBLE_SOURCE_LAYERS = new Set(['3d_model']);

/**
 * Strip layers MapLibre cannot render from a fetched Ola style object:
 * any layer whose `source-layer` is `3d_model` (missing from the
 * `vectordata` tiles) and any layer with id `3d_model_data` (the style
 * layer that references it). Defensive: unknown/malformed layers are
 * kept — only the known-incompatible ones are dropped. Returns the
 * style unchanged (same object shape) when there is nothing to strip,
 * and null when the input is not a style object at all.
 */
export function cleanOlaStyle(style: unknown): Record<string, unknown> | null {
  if (!style || typeof style !== 'object') return null;
  const layers = (style as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return style as Record<string, unknown>;
  const cleaned = layers.filter((layer) => {
    if (!layer || typeof layer !== 'object') return true;
    const id = (layer as { id?: unknown }).id;
    const sourceLayer = (layer as { 'source-layer'?: unknown })['source-layer'];
    if (typeof id === 'string' && INCOMPATIBLE_STYLE_LAYER_IDS.has(id)) return false;
    if (
      typeof sourceLayer === 'string' &&
      INCOMPATIBLE_SOURCE_LAYERS.has(sourceLayer)
    )
      return false;
    return true;
  });
  return { ...(style as Record<string, unknown>), layers: cleaned };
}

/**
 * Fetch the Ola style JSON (key appended, like every other Ola request)
 * and return the cleaned style object, or null when the fetch / parse
 * fails. Callers fall back to the style URL on null so the existing
 * error banner still shows the real failure detail.
 */
export async function fetchCleanedOlaStyle(): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(buildOlaStyleUrl());
    if (!response.ok) return null;
    return cleanOlaStyle((await response.json()) as unknown);
  } catch {
    return null;
  }
}
export interface MapLibreMapLike {
  resize(): void;
  remove(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  flyTo(options: { center: [number, number]; zoom?: number; duration?: number }): void;
  easeTo(options: {
    center?: [number, number];
    zoom?: number;
    /** Bearing in degrees (0 = north up); the N button resets this. */
    bearing?: number;
    duration?: number;
  }): void;
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
  // The Ola style declares a `3d_model_data` layer whose source layer
  // `3d_model` does not exist in the vectordata tiles — MapLibre refuses
  // the whole style if it is passed the URL as-is. Fetch + strip first
  // and pass the cleaned style OBJECT; on a fetch failure fall back to
  // the URL so the caller's error banner shows the real detail.
  const cleanedStyle = await fetchCleanedOlaStyle();
  const map = new maplibre.Map({
    container: options.container,
    style: (cleanedStyle ?? buildOlaStyleUrl()) as unknown as import('maplibre-gl').StyleSpecification,
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
