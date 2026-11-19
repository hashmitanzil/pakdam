/** MapLibre GL JS loader + GeoJSON helpers — OLA MAPS (vector tiles).
 *
 *  Founder decision (2026-11-19): replace the bundled offline map
 *  with Ola Maps, fully. The map is now the Ola Maps vector style
 *  `default-dark-standard` (dark style, fits the single dark
 *  theme), rendered by the SAME vendored MapLibre GL JS engine —
 *  no CDN, no Leaflet, no fallback / switcher / reload.
 *
 *  AUTH GOTCHA (critical): the style JSON's own tile / sprite /
 *  glyph URLs carry NO api_key. Every request to api.olamaps.io
 *  must carry `api_key` as a query parameter, so the map is
 *  constructed with `transformRequest: olaTransformRequest` (see
 *  below), which appends `api_key` to EVERY api.olamaps.io
 *  request — style, tiles, sprites and glyphs alike. Without it
 *  the style loads but every tile request fails with 401 and the
 *  map paints blank. The key comes from
 *  `NEXT_PUBLIC_OLA_MAPS_API_KEY` (Vercel: Production + Preview)
 *  via `getOlaApiKey()` — NEVER put a key value in code.
 *
 *  The map is world-wide now: there is NO maxBounds and NO
 *  downloaded-area guard. The camera starts on Ranchi / Doranda
 *  (MAP_INITIAL_CENTRE) when no fix / zone is set, because that is
 *  the game's home area — not because tiles exist only there.
 *
 *  The vendored library lives at `apps/web/public/vendor/maplibre/`
 *  (moved there from `public/offline-map/vendor/` by a separate
 *  worker). GPS is independent of tiles, as before. If the key is
 *  missing, `isOlaConfigured()` is false and the view does not
 *  construct the map at all — the parent shows the missing-key
 *  banner instead. If the key is wrong, the style load fails
 *  (401) and the view fails gracefully the same way. */

/** Ola Maps vector style (dark standard). */
export const OLA_STYLE_URL = 'https://api.olamaps.io/tiles/vector/v1/styles/default-dark-standard/style.json';
/** Ranchi / Doranda — the map starts here when no fix / zone is
 *  set. [lng, lat]. This is the game's home area; the map itself
 *  is world-wide (no maxBounds), so this is a starting centre
 *  only, not a boundary. */
export const MAP_INITIAL_CENTRE: [number, number] = [85.33, 23.36];
export const OLA_MAP_INITIAL_ZOOM = 14;
export const OLA_MAP_MIN_ZOOM = 3;
export const OLA_MAP_MAX_ZOOM = 19;
/** Vendored MapLibre GL JS — local file only, never a CDN. */
const MAPLIBRE_JS_URL = '/vendor/maplibre/maplibre-gl.js';
const MAPLIBRE_CSS_URL = '/vendor/maplibre/maplibre-gl.css';

/** The Ola Maps API key, from the public env var ('' when unset).
 *  Never put a key value in code. */
export function getOlaApiKey(): string {
  return process.env.NEXT_PUBLIC_OLA_MAPS_API_KEY ?? '';
}

/** True when an Ola Maps API key is configured. */
export function isOlaConfigured(): boolean {
  return getOlaApiKey().trim().length > 0;
}

/** MapLibre transformRequest for Ola Maps: appends `api_key` to
 *  EVERY request to api.olamaps.io — the style JSON's own
 *  tile / sprite / glyph URLs carry no key, so without this the
 *  style loads but tile requests fail with 401. Handles existing
 *  query strings ('&' when '?' is already present, else '?').
 *  Non-Ola requests (and requests with no key configured) pass
 *  through unchanged. */
export function olaTransformRequest(url: string, _resourceType: string): { url: string } {
  if (!url.includes('api.olamaps.io')) return { url };
  const key = getOlaApiKey();
  if (!key) return { url };
  const separator = url.includes('?') ? '&' : '?';
  return { url: `${url}${separator}api_key=${encodeURIComponent(key)}` };
}

/** Minimal structural typing for the MapLibre surface this app uses,
 *  so the code typechecks with no `maplibre-gl` npm package
 *  installed (the library is vendored as plain scripts under
 *  `public/vendor/maplibre/` and loaded by `loadMapLibre`). */
export interface MapLibreLngLat { lat: number; lng: number }
/** Event payloads MapLibre hands to listeners (kept loose: only the
 *  fields this app reads). */
export interface MapLibreEvent {
  error?: Error;
  tile?: unknown;
  lngLat?: { lat: number; lng: number };
  isSourceLoaded?: boolean;
}
export interface MapLibreMap {
  on(event: string, handler: (e: MapLibreEvent) => void): void;
  off(event: string, handler: (e: MapLibreEvent) => void): void;
  remove(): void;
  /** Re-measure the container and repaint the tiles. REQUIRED after
   *  the container is resized, hidden-then-shown (tab switch), or a
   *  fix moves the camera — without it the WebGL canvas can stay
   *  blank white even though the tiles loaded (2026-11-17 live
   *  check: tiles counted, nothing painted, reload did not fix it). */
  resize(): void;
  /** Force a repaint of the current frame (used after a WebGL
   *  context restore). */
  triggerRepaint(): void;
  setStyle(style: string | Record<string, unknown>): void;
  flyTo(opts: { center: [number, number]; zoom?: number }): void;
  /** Animated camera move that can also change the zoom — the zoom
   *  buttons use this with the pin/zone centre as the anchor, so
   *  zooming keeps the pin in view instead of drifting it off-screen
   *  (the old centre-of-map zoom). */
  easeTo(opts: { center?: [number, number]; zoom?: number; duration?: number }): void;
  /** Fit the camera to a [[west, south], [east, north]] box. */
  fitBounds(bounds: [[number, number], [number, number]], opts?: { padding?: number; maxZoom?: number }): void;
  setCenter(center: [number, number]): void;
  getCenter(): { lng: number; lat: number };
  setZoom(zoom: number): void;
  getZoom(): number;
  addSource(id: string, source: { type: 'geojson'; data: unknown }): void;
  getSource(id: string): { setData(data: unknown): void } | undefined;
  removeSource(id: string): void;
  addLayer(layer: Record<string, unknown>): void;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  getContainer(): HTMLElement;
  /** True when every visible tile has finished loading (MapLibre
   *  v5). */
  areTilesLoaded(): boolean;
}
export interface MapLibreMarker {
  setLngLat(lngLat: [number, number]): this;
  getLngLat(): { lng: number; lat: number };
  addTo(map: MapLibreMap): this;
  remove(): void;
  setPopup(popup: MapLibrePopup): this;
  // Marker drag events (MapLibre v5): dragstart fires when a drag
  // begins, dragend when it ends. PlayAreaMap uses dragstart to
  // guard the marker rebuild so a drag in progress is never snapped
  // back to the stored centre.
  on(event: 'dragstart' | 'drag' | 'dragend', handler: () => void): this;
  /** The marker's wrapper element in the map container. */
  getElement(): HTMLElement;
}
export interface MapLibrePopup {
  setText(text: string): this;
  setHTML(html: string): this;
}
export interface MapLibreLib {
  Map: new (opts: {
    container: HTMLElement;
    style: string | Record<string, unknown>;
    center: [number, number];
    zoom: number;
    minZoom?: number;
    maxZoom?: number;
    maxBounds?: [[number, number], [number, number]];
    transformRequest?: (url: string, resourceType: string) => { url: string };
    attributionControl?: boolean;
    trackResize?: boolean;
    dragRotate?: boolean;
    touchPitch?: boolean;
  }) => MapLibreMap;
  Marker: new (opts?: { element?: HTMLElement; draggable?: boolean; anchor?: string }) => MapLibreMarker;
  Popup: new (opts?: { offset?: number }) => MapLibrePopup;
}

declare global {
  interface Window {
    maplibregl?: MapLibreLib;
  }
}

let cachedLib: MapLibreLib | null = null;
let loadPromise: Promise<MapLibreLib> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') { reject(new Error('no document')); return; }
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Map library script failed to load: ${src}`));
    document.head.appendChild(script);
  });
}

function loadStylesheet(href: string): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

/** REAL WebGL capability check — the thing `lib.supported()` used
 *  to pretend to be. The vendored MapLibre v5 bundle has NO
 *  `supported` export (verified 2026-11-18: `window.maplibregl`
 *  exposes Map/Marker/Popup but `supported` is `undefined`), so
 *  gating on it killed the map on EVERY device while blaming the
 *  library. This helper probes a throwaway canvas instead:
 *  `webgl2` first, then `webgl`. Callers use it where a no-WebGL
 *  honest error is needed — never as a library-load check. */
export function isWebGLSupported(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Returns the MapLibre library (vendored script only). Throws when
 *  the vendored script is missing — the caller shows an honest
 *  error. There is no CDN and no alternate map provider, by founder
 *  decision. A browser with no WebGL throws a distinct, honest
 *  error (the map genuinely cannot draw without WebGL) — it is NOT
 *  reported as a missing library. */
export async function loadMapLibre(): Promise<MapLibreLib> {
  if (cachedLib) return cachedLib;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    loadStylesheet(MAPLIBRE_CSS_URL);
    await loadScript(MAPLIBRE_JS_URL);
    const lib = window.maplibregl;
    if (!lib || !lib.Map) {
      throw new Error('MapLibre library failed to load (vendored script missing or corrupt)');
    }
    if (!isWebGLSupported()) {
      throw new Error('WebGL is not available in this browser — the Ola map needs WebGL to draw tiles');
    }
    cachedLib = lib;
    return lib;
  })();
  return loadPromise;
}

/** GeoJSON helpers — overlays are GeoJSON sources, never exact pins. */
export function polygonToGeoJSON(poly: { lat: number; lng: number }[]): Record<string, unknown> {
  const ring = poly.map((p) => [p.lng, p.lat]);
  if (ring.length > 0) ring.push(ring[0]!);
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

/** Approximate a circle of `radiusMeters` around a point as a
 *  64-sided polygon (MapLibre circle layers are pixel-sized; a
 *  geographic radius needs a polygon). */
export function circlePolygon(lat: number, lng: number, radiusMeters: number, points = 64): Record<string, unknown> {
  const R = 6371000;
  const d = radiusMeters / R;
  const latR = (lat * Math.PI) / 180;
  const lngR = (lng * Math.PI) / 180;
  const ring: [number, number][] = [];
  for (let i = 0; i < points; i += 1) {
    const bearing = (i / points) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(latR) * Math.cos(d) + Math.cos(latR) * Math.sin(d) * Math.cos(bearing));
    const lng2 = lngR + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(latR), Math.cos(d) - Math.sin(latR) * Math.sin(lat2));
    ring.push([(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  ring.push(ring[0]!);
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

export function featureCollection(features: Record<string, unknown>[]): Record<string, unknown> {
  return { type: 'FeatureCollection', features };
}
