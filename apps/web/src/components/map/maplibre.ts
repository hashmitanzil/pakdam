/** MapLibre GL JS loader + GeoJSON helpers — OFFLINE map (raster tiles).
 *
 *  Founder decision (2026-11-17 19:34 IST): ONE simple working map,
 *  downloaded offline and bundled in the app, covering Doranda +
 *  Hinoo, Ranchi, Jharkhand, for now. NO fallback / switcher /
 *  reload. GPS works on the downloaded map (device GPS is
 *  independent of tiles). The full live map service is a SEPARATE
 *  later task.
 *
 *  LANDED APPROACH (2026-11-17, reconciliation): bundled Esri World
 *  Street Map raster tiles — 808 JPEG tiles, zooms 12–17, bbox
 *  23.325–23.38 N / 85.285–85.355 E, 13 MB, served from
 *  `public/offline-map/tiles/{z}/{x}/{y}.jpg` via the MapLibre
 *  raster style `public/offline-map/style.json`. A sample tile
 *  (16/48301/28392.jpg) was visually verified to paint REAL Ranchi
 *  streets (Konka Road, M. G. Marg, Sharad Babu Lane). This approach
 *  was chosen over the PMTiles vector file because the PMTiles
 *  wiring was half-done and unprovable on disk: it needed vendored
 *  glyphs under `public/offline-map/fonts/` that were never copied
 *  (the folder does not exist), so its labels could never render.
 *  The raster style needs no glyphs, no pmtiles.js, no basemaps.js
 *  — just MapLibre GL JS (vendored) + local JPEG tiles.
 *
 *  SPARE (NOT a live path): `public/offline-map/ranchi.pmtiles`
 *  (2,226,722 B) and `public/offline-map/vendor/pmtiles.js` /
 *  `basemaps.js` remain on disk as a documented spare only. Nothing
 *  in `src/` loads them, registers a pmtiles protocol, or references
 *  them — there is exactly one map, the raster tiles. Do NOT
 *  reintroduce live tile providers as a fallback. If the bundled
 *  tiles ever fail to load, the view shows the plain out-of-area /
 *  failed message and the pin flow carries the game.
 *
 *  Refreshing the map later: re-download the Esri tiles for the
 *  same bbox/zooms (see `apps/web/scripts/download-offline-map.mjs`,
 *  which verifies the raster pack) and replace `tiles/` +
 *  `style.json` + `manifest.json` together. */

export const OFFLINE_MAP_BBOX = {
  minLat: 23.325, maxLat: 23.38, minLng: 85.285, maxLng: 85.355,
} as const;
/** Attribution for the bundled Esri World Street Map tiles (as in
 *  `public/offline-map/style.json`). */
export const OFFLINE_MAP_ATTRIBUTION = '© Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS user community';
/** The ONE map style, served by Next.js from `public/`. It points
 *  at the bundled raster tiles only — no live URL anywhere. */
export const OFFLINE_STYLE_URL = '/offline-map/style.json';
/** Tile template inside the style (documented here for grep-ability). */
export const OFFLINE_TILES_TEMPLATE = '/offline-map/tiles/{z}/{x}/{y}.jpg';
/** Vendored MapLibre GL JS — local file only, never a CDN. */
export const OFFLINE_VENDOR_BASE = '/offline-map/vendor';
const MAPLIBRE_JS_URL = `${OFFLINE_VENDOR_BASE}/maplibre-gl.js`;
const MAPLIBRE_CSS_URL = `${OFFLINE_VENDOR_BASE}/maplibre-gl.css`;
/** Doranda, Ranchi — the map starts here. [lng, lat]. */
export const OFFLINE_MAP_CENTRE: [number, number] = [85.33, 23.36];
export const OFFLINE_MAP_INITIAL_ZOOM = 14;
export const OFFLINE_MAP_MIN_ZOOM = 12;
export const OFFLINE_MAP_MAX_ZOOM = 17;
/** The camera never leaves the downloaded area. */
export const OFFLINE_MAP_MAX_BOUNDS: [[number, number], [number, number]] = [
  [OFFLINE_MAP_BBOX.minLng, OFFLINE_MAP_BBOX.minLat],
  [OFFLINE_MAP_BBOX.maxLng, OFFLINE_MAP_BBOX.maxLat],
];
/** Plain-words area messages (no lat/lng numbers in the UI).
 *  Founder rule, reconciled 2026-11-17: no city/area names in the
 *  normal map UI — both messages say only "downloaded area".
 *  (D-M3 follow-up, 2026-11-18: the outside-area message used to
 *  be the ONE minimal exception, "Map downloaded for Ranchi only"
 *  — reworded to the same downloaded-area wording as the area
 *  message; no city name remains in any user-visible map string.) */
export const OFFLINE_MAP_AREA_MESSAGE = 'Offline map: downloaded area only';
export const OUTSIDE_MAP_AREA_MESSAGE = 'Offline map: downloaded area only';

/** True when a fix sits inside the downloaded map area. */
export function isInsideOfflineMap(lat: number, lng: number): boolean {
  return lat >= OFFLINE_MAP_BBOX.minLat && lat <= OFFLINE_MAP_BBOX.maxLat
    && lng >= OFFLINE_MAP_BBOX.minLng && lng <= OFFLINE_MAP_BBOX.maxLng;
}

/** Minimal structural typing for the MapLibre surface this app uses,
 *  so the code typechecks with no `maplibre-gl` npm package
 *  installed (the library is vendored as plain scripts under
 *  `public/offline-map/vendor/` and loaded by `loadMapLibre`). */
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
   *  v5). With the offline bundle, a tile that never loads means a
   *  file is missing from the pack — the view reports it honestly. */
  areTilesLoaded(): boolean;
}
export interface MapLibreMarker {
  setLngLat(lngLat: [number, number]): this;
  getLngLat(): { lng: number; lat: number };
  addTo(map: MapLibreMap): this;
  remove(): void;
  setPopup(popup: MapLibrePopup): this;
  on(event: 'dragend', handler: () => void): this;
}
export interface MapLibrePopup {
  setText(text: string): this;
  setHTML(html: string): this;
}
export interface MapLibreLib {
  supported(): boolean;
  Map: new (opts: {
    container: HTMLElement;
    style: string | Record<string, unknown>;
    center: [number, number];
    zoom: number;
    minZoom?: number;
    maxZoom?: number;
    maxBounds?: [[number, number], [number, number]];
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
    script.onerror = () => reject(new Error(`Offline map script failed to load: ${src}`));
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

/** Returns the MapLibre library (vendored script only). Throws when
 *  the vendored script is missing — the caller shows an honest
 *  error. There is no CDN and no alternate map provider, by founder
 *  decision. Only maplibre-gl.js is loaded: the raster style needs
 *  no pmtiles.js, basemaps.js or glyphs. */
export async function loadMapLibre(): Promise<MapLibreLib> {
  if (cachedLib) return cachedLib;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    loadStylesheet(MAPLIBRE_CSS_URL);
    await loadScript(MAPLIBRE_JS_URL);
    const lib = window.maplibregl;
    if (!lib || !lib.Map || typeof lib.supported !== 'function') {
      throw new Error('Offline MapLibre library failed to load (vendored script missing or corrupt)');
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
