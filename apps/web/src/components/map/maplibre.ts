import { METERS_PER_DEG_LAT, metersPerDegreeLng } from '@pakdam/shared';

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

/** Style-JSON pre-fetch budget (ms) — see fetchCleanedOlaStyle. */
const OLA_STYLE_FETCH_TIMEOUT_MS = 8_000;

/** Dynamic-import budget (ms) for the `maplibre-gl` chunk — see createOlaMap. */
const MAPLIBRE_IMPORT_TIMEOUT_MS = 30_000;

/**
 * A promise that rejects after `ms` with `message`. The rejection is
 * pre-handled (noop catch) so the losing side of a `Promise.race`
 * never surfaces as an unhandled rejection.
 */
function timeoutAfter(
  ms: number,
  message: string,
): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  promise.catch(() => undefined);
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Fetch the Ola style JSON (key appended, like every other Ola request)
 * and return the cleaned style object, or null when the fetch / parse
 * fails. Callers fall back to the style URL on null so the existing
 * error banner still shows the real failure detail.
 *
 * BOUNDED (root cause, after v13): the pre-fetch used to have no
 * timeout, so a stalled fetch on flaky mobile data wedged map creation
 * forever — the play map sat in 'loading' with no error event and no
 * way back. After `timeoutMs` the fetch is aborted and this resolves
 * null, so the caller falls back to the style URL instead of hanging.
 */
export async function fetchCleanedOlaStyle(
  timeoutMs: number = OLA_STYLE_FETCH_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildOlaStyleUrl(), { signal: controller.signal });
    if (!response.ok) return null;
    return cleanOlaStyle((await response.json()) as unknown);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
export interface MapLibreMapLike {
  resize(): void;
  /** Force a repaint — used after a hidden-then-shown resize so a 'ready' map actually paints (v18). */
  triggerRepaint(): void;
  remove(): void;
  /** The map's WebGL canvas — v29 (E): the context-loss listeners attach here. */
  getCanvas(): HTMLCanvasElement;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  /** Current bearing in degrees (0 = north up); the compass lock seeds
   *  its last-bearing from this when locking, so the first heading
   *  event does not snap the map (PlayMap toggleCompass). */
  getBearing(): number;
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
  /**
   * The camera that would fit the bounds at the map's CURRENT viewport
   * size, or undefined when the viewport cannot fit them. Real MapLibre
   * returns undefined (warn only, no throw) when the transform is
   * smaller than the padding — e.g. a map constructed in a 0-size
   * container whose transform was never resized — and fitBounds then
   * silently does nothing. Callers (tryFitZone) must check this BEFORE
   * trusting a fitBounds call: a silent no-op must never consume the
   * one fit. (v26 — see play-map-logic.ts tryFitZone.)
   *
   * v26 fix round (Diya 4 — verified against installed maplibre-gl
   * 5.24.1, `cameraForBoxAndBearing`): undefined is returned ONLY
   * when the available size is strictly NEGATIVE (scaleX/scaleY < 0).
   * At EXACTLY zero available size (an 80 px container with 40 px
   * padding) it returns a camera with zoom −∞ (`scaleZoom(0)`), and
   * fitBounds flies there instead of no-op-ing. Callers must ALSO
   * reject a non-finite camera — see `cameraCanFitBounds`.
   */
  cameraForBounds(
    bounds: [[number, number], [number, number]],
    options?: { padding?: number },
  ):
    | { center: { lng: number; lat: number }; zoom: number; bearing: number }
    | undefined;
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
  /**
   * Aborted when the caller unmounts / retries while creation is still
   * in flight — the map is then never constructed, so a cancelled
   * attempt can never orphan a live Map (and its WebGL context) in a
   * detached container.
   */
  signal?: AbortSignal;
  /**
   * v31 (Fix 2 — map blank on refresh): WebGL context-loss hooks,
   * attached to the canvas IMMEDIATELY after `new Map` — inside this
   * function, not by the caller after the promise resolves. A context
   * lost during construction / style load (e.g. a refresh with the
   * old page's context not yet collected and 20 tabs open) used to
   * fire with NO listener attached — the caller's listeners only
   * attach after `createOlaMap` resolves — so the map sat 'ready'
   * and black with no honest pill and no recovery. These callbacks
   * are optional; callers that pass none get today's behaviour.
   * The listeners die with the canvas on `map.remove()`, the same
   * lifecycle as a caller-attached pair. `preventDefault()` on the
   * loss event is what lets the context be restored at all.
   */
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

/**
 * Construct the Ola dark map. Returns null (and constructs nothing) when
 * the Ola key is missing. Callers must call `map.resize()` after the
 * container resizes or is hidden-then-shown, or the canvas stays blank
 * though tiles loaded.
 *
 * DOUBLE-TAP ZOOM (v28, Diya F4 — do NOT build a custom handler):
 * double-tap zoom is a LIBRARY DEFAULT in the installed maplibre-gl
 * 5.24.1 — `TapZoomHandler` (dist :66581: single-finger double-tap
 * zooms in +1, two-finger single tap zooms out −1, both around the
 * tap point), registered and enabled when `interactive &&
 * doubleClickZoom` (dist :68474-68479), with defaults
 * `interactive: true, doubleClickZoom: true, touchZoomRotate: true`
 * (dist :71233, :71256-71257). This function passes NEITHER option,
 * so the defaults apply and the built-in is ON. A custom handler
 * would double-zoom every double-tap. The founder's "no double-tap
 * zoom" report predates the v27 height fix — with a 526×0 container
 * there was no tap target and no tiles to zoom into. If the built-in
 * is ever proven not to fire on a healthy map, build a replacement
 * ONLY with the built-in disabled first.
 *
 * BOUNDED (root cause, after v13): neither await inside may hang
 * forever. The style pre-fetch is capped at 8 s (falls back to the
 * style URL on timeout) and the lazy `maplibre-gl` import — a ~1 MB
 * chunk fetched at map-creation time — is capped at 30 s and rejects
 * with a plain-words error. Before this, a stalled fetch/import on
 * flaky mobile data wedged the play map in 'loading' forever with no
 * error event, and a rejection landed in a dead-end generic banner.
 * `new Map` throwing (e.g. 'Failed to initialize WebGL') propagates
 * as a rejection too, so the caller can show the real cause + Retry.
 */
export async function createOlaMap(
  options: CreateOlaMapOptions,
): Promise<MapLibreMapLike | null> {
  if (!isOlaConfigured()) return null;
  const cleanedStyle = await fetchCleanedOlaStyle();
  if (options.signal?.aborted) return null;
  const importGuard = timeoutAfter(
    MAPLIBRE_IMPORT_TIMEOUT_MS,
    'Map library download timed out after 30s — check your connection and retry',
  );
  try {
    const maplibre = await Promise.race([
      import('maplibre-gl'),
      importGuard.promise,
    ]);
    if (options.signal?.aborted) return null;
    // The Ola style declares a `3d_model_data` layer whose source layer
    // `3d_model` does not exist in the vectordata tiles — MapLibre refuses
    // the whole style if it is passed the URL as-is. Fetch + strip first
    // and pass the cleaned style OBJECT; on a fetch failure fall back to
    // the URL so the caller's error banner shows the real detail.
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
    // v31 (Fix 2): attach the context-loss listeners HERE, on the
    // fresh canvas, before the promise resolves — a loss during
    // construction / style load must be reported, not missed because
    // the caller had not attached yet. No explicit removal: the
    // listeners die with the canvas on `map.remove()`.
    if (options.onContextLost || options.onContextRestored) {
      const canvas = map.getCanvas();
      if (options.onContextLost) {
        canvas.addEventListener('webglcontextlost', (event: Event) => {
          event.preventDefault();
          options.onContextLost?.();
        });
      }
      if (options.onContextRestored) {
        canvas.addEventListener('webglcontextrestored', () => {
          options.onContextRestored?.();
        });
      }
    }
    return map;
  } finally {
    importGuard.cancel();
  }
}

/**
 * Prefetch the map assets at idle time (B21): the lazy `maplibre-gl`
 * chunk (~1 MB) and the cleaned Ola style JSON, so the first map paint
 * on setup / play does not pay the serial style-fetch → chunk → tiles
 * wait. Warms the browser cache only — constructing the map still goes
 * through `createOlaMap`. Runs once per page load, only when an Ola key
 * is configured; failures are swallowed (the map path retries on its own).
 */
let mapAssetsPrefetched = false;
export function prefetchMapAssets(): void {
  if (mapAssetsPrefetched || typeof window === 'undefined' || !isOlaConfigured()) return;
  // v29 (R11): never prefetch on a data-saver connection or a 2G
  // link — a ~1 MB chunk + style fetch is the wrong spend when the
  // player asked the browser to save data. The map path fetches on
  // demand instead, so nothing breaks; the first paint is just slower.
  const connection = (
    window.navigator as unknown as {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (connection?.saveData === true) return;
  if (connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g') return;
  mapAssetsPrefetched = true;
  const run = (): void => {
    void import('maplibre-gl').catch(() => undefined);
    void fetchCleanedOlaStyle().catch(() => undefined);
  };
  const idle = (
    window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === 'function') idle(run, { timeout: 3000 });
  else window.setTimeout(run, 500);
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
  const dLat = (fix.lat - lastCentre.lat) * METERS_PER_DEG_LAT;
  const dLng =
    (fix.lng - lastCentre.lng) * metersPerDegreeLng(fix.lat);
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
