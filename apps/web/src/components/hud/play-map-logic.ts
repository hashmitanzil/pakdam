/**
 * play-map-logic.ts — pure, testable logic for the play map (PlayMap.tsx).
 *
 * Extracted verbatim from PlayMap.tsx (v25, Arjun/tests) so the blank-map
 * reproduction tests can exercise the REAL production code under Node,
 * without React, DOM, or a browser. PlayMap.tsx imports from here; there
 * is no second copy of any of these functions.
 *
 * v25 FIX (Meera): the PRE-FIX sites are fixed here — post-load tile
 * errors are classified (not swallowed), the pill names tile failures,
 * the fit flag is set only after a successful fitBounds, tab returns
 * never throw, and rAF-loop writes on a removed map end the loop
 * instead of throwing. The tests in
 * `apps/web/test/play-map-logic.test.mjs` assert the fixed behaviour.
 *
 * v25 FIX ROUND (Diya + Zara review): the holes are closed here too —
 * fit failures auto-retry (bounded) and surface in the pill, non-finite
 * bounds are a distinct outcome, zero-height areas are diagnosed,
 * tile errors dedupe/cap/decay with honest non-tile labels, the
 * sanitisers are hardened and null-safe, Retry is rate-limited, the
 * overlay writes are all guarded, and the crash narrative is corrected
 * (an rAF throw is an uncaught window error, not an error-boundary
 * crash — the zone effect's fit catch is the load-bearing guard).
 *
 * No React, no DOM, no I/O. Type-only imports are erased by Node's type
 * stripping; the only runtime import is `circlePolygon` from
 * @pakdam/engine (already a PlayMap dependency).
 */
import { circlePolygon } from '@pakdam/engine';
import type { GeoPoint, GeoPolygon } from '@pakdam/shared';
import type { MapLibreMapLike } from '../map/maplibre';

export type MapState = 'loading' | 'ready' | 'no-key' | 'unavailable' | 'error';

/**
 * Redact API-key values from a diagnostic string before it is ever
 * shown. Matches the plain `api_key=` / `apikey=` / `apiKey=` query
 * parameter (and its URL-encoded `api_key%3D` form), plus a bare
 * `key=` query parameter — the `?`/`&`/start/whitespace prefix keeps
 * words that merely contain "key" (turkey=, donkey=) untouched.
 * The key itself is NEXT_PUBLIC by design (hygiene, not a secret
 * compromise), but a verbatim key in a pill is still a leak.
 */
const KEY_PARAM_RE =
  /(api_?key(?:%3D|=)|(?:^|[?&"'\s])key=)[^&\s"']*/gi;

function redactKeyValues(text: string): string {
  return text.replace(KEY_PARAM_RE, (_match, key: string) => `${key}…`);
}

/**
 * Short, safe detail from a MapLibre error event (status + message).
 * The message can contain the request URL — including the Ola api_key
 * as a query parameter — so any key value is stripped before the text
 * is ever shown. Returns null when there is nothing useful.
 *
 * v25 fix round (Zara 3): `err.message` is NOT assumed to be a string
 * — `String(err.message ?? '')` first, so a non-string message
 * (`{error:{message:{url:'…'}}}` / `{error:{message:12345}}`) cannot
 * throw a TypeError out of the error listener. MapLibre's `Evented.fire`
 * has no try/catch, so such a throw would escape the listener and the
 * tile error itself would be lost. (Moved verbatim from PlayMap.tsx,
 * sanitiser hardened in the fix round.)
 */
export function mapErrorDetail(event: unknown): string | null {
  const err = (event as { error?: { message?: unknown; status?: number | string } })
    ?.error;
  if (!err) return null;
  const status = err.status !== undefined ? String(err.status) : '';
  const raw = redactKeyValues(String(err.message ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const parts = [status ? `HTTP ${status}` : '', raw].filter(Boolean);
  return parts.length > 0 ? parts.join(' — ') : null;
}

/**
 * Short, safe detail from a thrown / rejected value — the lazy
 * `maplibre-gl` chunk failing to download, `new Map` throwing
 * 'Failed to initialize WebGL', the import timeout. Same key
 * stripping + truncation as mapErrorDetail.
 *
 * v25 fix round (Zara 3): same `String(...)` guard as mapErrorDetail —
 * an Error whose `message` is not a string at runtime must not throw
 * here. (Moved verbatim from PlayMap.tsx, sanitiser hardened.)
 */
export function unknownErrorDetail(err: unknown): string {
  const raw = String(
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown error',
  );
  return (
    redactKeyValues(raw)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || 'unknown error'
  );
}

/** [[minLng, minLat], [maxLng, maxLat]] of a boundary, for fitBounds. (Moved verbatim from PlayMap.tsx.) */
export function boundaryBBox(polygon: GeoPolygon): [[number, number], [number, number]] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const p of polygon) {
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

/** A polygon as one closed GeoJSON ring ([lng, lat] pairs, first point repeated at the end). */
export function ring(polygon: GeoPolygon): number[][][] {
  const coords = polygon.map((p) => [p.lng, p.lat]);
  if (coords.length > 0) {
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
      coords.push([first[0]!, first[1]!]);
    }
  }
  return [coords];
}

export function polygonFeature(
  polygon: GeoPolygon,
  properties: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Polygon', coordinates: ring(polygon) },
  };
}

export function collection(features: Record<string, unknown>[]): Record<string, unknown> {
  return { type: 'FeatureCollection', features };
}

/** A post-load failure that is NOT a tile failure — labelled honestly, never counted as one. */
export interface OtherResourceProblem {
  /** Plain-words label: 'sprite', 'glyph', or 'resource'. */
  label: string;
  detail: string | null;
}

/**
 * The one-line diagnostic pill text for a map state — the exact text
 * PlayMap renders. (Moved verbatim from PlayMap.tsx.)
 *
 * v25 FIX: `tileErrorCount` is honoured — a map whose tiles are failing
 * AFTER `load` never claims "Map ready" (the founder's exact symptom:
 * pill "Map ready", blank canvas, no Retry). With tile errors recorded
 * the pill names the tile failure and carries the first real detail.
 * The component passes the real count and offers a Retry while tile
 * errors are recorded — pill text alone does not add the button.
 *
 * v25 fix round: the 'ready' branch now also honours `fitFailed`
 * (Diya F1/F2 — a camera that never reached the zone must not read
 * "Map ready"), `zeroHeight` (Diya F3 — a 0-height map area must not
 * read "Map ready"; the founder measured a 526.4×0 rect), and
 * `otherResource` (Diya F4 — a failing sprite/glyph is not a tile
 * error and is labelled as what it is). Order is deliberate: a map
 * area with no height paints nothing at all, so it outranks the
 * camera, which outranks the tiles.
 */
export function pillTextForState(
  mapState: MapState,
  mapDetail: string | null,
  slowLoad: boolean,
  elapsedS: number | null,
  tileErrorCount = 0,
  tileDetail: string | null = null,
  fitFailed = false,
  zeroHeight = false,
  otherResource: OtherResourceProblem | null = null,
): string {
  if (mapState === 'ready' && zeroHeight) {
    return 'Map area has no height — try Retry';
  }
  if (mapState === 'ready' && fitFailed) {
    return `Zone not in view — camera fit failed${mapDetail ? ` — ${mapDetail}` : ''}`;
  }
  if (mapState === 'ready' && tileErrorCount > 0) {
    return `Map tiles failing — ${tileErrorCount} tile error${tileErrorCount === 1 ? '' : 's'}${tileDetail ? ` — ${tileDetail}` : ''}`;
  }
  if (mapState === 'ready' && otherResource) {
    return `Map ${otherResource.label} failing — ${otherResource.detail ?? 'resource failed'}`;
  }
  if (mapState === 'ready') return 'Map ready';
  if (mapState === 'loading') {
    return `Map loading — ${mapDetail ?? 'creating map…'}${
      slowLoad ? ' · still trying…' : ''
    }${elapsedS !== null ? ` · ${elapsedS}s` : ''}`;
  }
  return `Map ${mapState} — ${mapDetail ?? 'failed'}`;
}

export type MapErrorClassification =
  | { kind: 'pre-load-failure'; detail: string | null }
  // v25 FIX: a tile/resource error arriving AFTER `load` is a
  // 'post-load-tile-error' (same detail) — the component records it
  // (tile-error count + first detail for the pill) instead of
  // returning early. The old 'ignored-after-load' kind swallowed it.
  // v25 fix round (Diya F4): the post-load kind also carries
  // `resource` — only a real tile failure is a "tile error". Sprites,
  // glyphs and anything else are labelled honestly by the component
  // and never counted in the tile-error count.
  | { kind: 'post-load-tile-error'; detail: string | null; resource: PostLoadResource };

/**
 * Which post-load resource failed, from the event shape — grounded in
 * the installed maplibre-gl 5.x build (`ErrorEvent` = `{ error }` plus
 * whatever `data` the firer passed):
 *  - tile loads fire `ErrorEvent(err, { tile })` — a `tile` property
 *    on the event is the positive tile signal;
 *  - sprite / glyph loads fire a bare `ErrorEvent(err)` — identified
 *    only by the message;
 *  - style / TileJSON / source loads also fire a bare `ErrorEvent(err)`
 *    with no `sourceId` attached anywhere in this build, so they
 *    cannot be positively identified as "source" — they are 'other',
 *    labelled "resource", never "tile".
 */
export type PostLoadResource = 'tile' | 'sprite' | 'glyph' | 'other';

export function classifyPostLoadResource(event: unknown): PostLoadResource {
  const ev = (event ?? {}) as {
    tile?: unknown;
    error?: { message?: unknown };
  };
  if (ev.tile !== undefined && ev.tile !== null) return 'tile';
  const message = String(ev.error?.message ?? '');
  if (/sprite/i.test(message)) return 'sprite';
  if (/glyph/i.test(message)) return 'glyph';
  return 'other';
}

/** Plain-words pill label for a non-tile post-load resource. */
export function resourceLabel(resource: PostLoadResource): string {
  switch (resource) {
    case 'tile':
      return 'tile';
    case 'sprite':
      return 'sprite';
    case 'glyph':
      return 'glyph';
    case 'other':
      return 'resource';
  }
}

/**
 * Decide what a MapLibre `error` event means, given whether the style
 * has loaded yet.
 *
 * v25 FIX: a tile error arriving AFTER `load` is classified
 * 'post-load-tile-error' — PlayMap records it (count + detail) and the
 * pill names the tile failure with a Retry, instead of swallowing the
 * error while the map sits blank behind a "Map ready" pill.
 */
export function classifyMapError(
  loaded: boolean,
  event: unknown,
): MapErrorClassification {
  const detail = mapErrorDetail(event);
  if (loaded) {
    return {
      kind: 'post-load-tile-error',
      detail,
      resource: classifyPostLoadResource(event),
    };
  }
  return { kind: 'pre-load-failure', detail };
}

// ---------------------------------------------------------------------------
// Tile-error ledger (Diya F4/F5): dedupe, cap, first detail, decay.
// ---------------------------------------------------------------------------

/** Distinct tile errors ever counted at once — the pill count is capped here. */
export const MAX_TILE_ERROR_COUNT = 10;
/**
 * Quiet period after the last recorded tile error after which the
 * slate clears on its own: a transient blip must not permanently
 * brand a healthy map. Any new tile error restarts the clock. A full
 * Retry also resets the ledger immediately (see PlayMap).
 */
export const TILE_ERROR_QUIET_DECAY_MS = 30_000;

export interface TileErrorLedger {
  /** Distinct tile errors recorded — capped at MAX_TILE_ERROR_COUNT. */
  count: number;
  /**
   * Distinct sanitised details, FIRST first. The pill shows details[0]
   * (F5: the first detail is kept, never overwritten by a later one).
   */
  details: string[];
  /** ms epoch of the most recent recorded error, or null when empty. */
  lastErrorAtMs: number | null;
}

export const EMPTY_TILE_LEDGER: TileErrorLedger = {
  count: 0,
  details: [],
  lastErrorAtMs: null,
};

/**
 * Record one post-load tile error. Dedupe key is the sanitised detail
 * (F4): MapLibre fires one `error` event per failed tile request, so
 * one flaky tile re-requested twice reads as ONE error, not two. An
 * error with no usable detail dedupes under the single key
 * 'tile failed'. The count is the number of distinct details, capped.
 * A repeat still refreshes `lastErrorAtMs` so a flapping tile keeps
 * the slate (and its decay clock) alive.
 */
export function recordTileError(
  ledger: TileErrorLedger,
  detail: string | null,
  nowMs: number,
): TileErrorLedger {
  const key = detail ?? 'tile failed';
  if (ledger.details.includes(key)) {
    return { ...ledger, lastErrorAtMs: nowMs };
  }
  const details = [...ledger.details, key].slice(0, MAX_TILE_ERROR_COUNT);
  return { count: details.length, details, lastErrorAtMs: nowMs };
}

/** True when the ledger's last error is at least the quiet period old — time to clear the slate. */
export function tileLedgerStale(ledger: TileErrorLedger, nowMs: number): boolean {
  return (
    ledger.count > 0 &&
    ledger.lastErrorAtMs !== null &&
    nowMs - ledger.lastErrorAtMs >= TILE_ERROR_QUIET_DECAY_MS
  );
}

/** A `{ current: boolean }` flag — a React `useRef(false)` satisfies this. */
export interface FitFlag {
  current: boolean;
}

export type FitOutcome =
  | 'fitted'
  | 'already-fitted'
  | 'no-boundary'
  | 'hidden'
  // v25 fix round (Diya F2): a boundary whose bbox is not finite is
  // reported as its own outcome instead of letting fitBounds throw —
  // the caller can surface it (and must NOT auto-retry it: the same
  // boundary would fail the same way). A camera stuck at the Ranchi
  // default is the break, never a fallback the map "paints at".
  | 'non-finite-bounds';

/**
 * Fit the whole zone in view, once, on first load with a valid boundary.
 *
 * v25 FIX: the flag is set only AFTER `fitBounds` returns without
 * throwing. The old mark-before-call ordering meant a throwing first
 * fit (NaN bounds, a zero-size viewport camera, a dead map) left the
 * flag true and no later resize/tab-return ever retried — the map was
 * permanently un-fitted with no retry. NOTE the setup map (PlayAreaMap)
 * already does mark-after-call (`lastFittedRadiusRef` is assigned after
 * `fitBounds`) — the play map was the only one with the
 * mark-before-call ordering. A throw still propagates to the caller:
 * the tab-return handler catches it; the zone effect catches it too.
 */
export function tryFitZone(
  fittedRef: FitFlag,
  map: MapLibreMapLike,
  boundary: GeoPolygon,
  hasSize: boolean,
): FitOutcome {
  if (fittedRef.current) return 'already-fitted';
  if (boundary.length < 3) return 'no-boundary';
  if (!hasSize) return 'hidden';
  const bbox = boundaryBBox(boundary);
  if (!bbox.flat().every(Number.isFinite)) return 'non-finite-bounds';
  map.fitBounds(bbox, { padding: 40, duration: 0 });
  fittedRef.current = true;
  return 'fitted';
}

/** How many automatic fit retries a failed first fit gets, before giving up to manual Retry / tab return. */
export const MAX_FIT_RETRIES = 3;
/** Delay between automatic fit retries. */
export const FIT_RETRY_DELAY_MS = 2000;

/**
 * Delay (ms) before the next automatic fit retry, or null when the
 * retry budget is spent. (Diya F1: a caught zone-effect fit failure
 * must retry WITHOUT waiting for a tab switch — the component schedules
 * one retry per call of this, up to MAX_FIT_RETRIES, then stops: a
 * permanently broken camera must not spin the retry loop forever.)
 */
export function nextFitRetryDelayMs(retriesUsed: number): number | null {
  return retriesUsed < MAX_FIT_RETRIES ? FIT_RETRY_DELAY_MS : null;
}

/**
 * Write GeoJSON into a map source.
 *
 * v25 FIX: a `getSource`/`setData` failure (MapLibre rejects calls on
 * a removed map) is caught and reported as false — the map is gone,
 * there is nothing to write to. Callers treat false as "loop over".
 * Returns true when the write landed (or the source simply does not
 * exist yet — a missing source is not a failure).
 */
export function safeSetSourceData(
  map: MapLibreMapLike,
  id: string,
  data: Record<string, unknown>,
): boolean {
  try {
    map.getSource(id)?.setData(data);
  } catch {
    return false;
  }
  return true;
}

/**
 * Create the GeoJSON source if it is missing. Returns false (instead
 * of throwing) when the map is gone — `getSource`/`addSource` on a
 * removed map throw in real MapLibre. (Diya F8: no unguarded
 * ensure/add calls on a removed map.)
 */
export function ensureMapSource(map: MapLibreMapLike, id: string): boolean {
  try {
    if (!map.getSource(id)) {
      map.addSource(id, { type: 'geojson', data: collection([]) });
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Create the layer if it is missing. Returns false (instead of
 * throwing) when the map is gone. (Diya F8.)
 */
export function ensureMapLayer(
  map: MapLibreMapLike,
  layer: Record<string, unknown>,
): boolean {
  try {
    if (!map.getLayer(layer['id'] as string)) {
      map.addLayer(layer);
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * One overlay source, synced: create the source + layers once, then
 * push the data. Returns false when the map is gone (or the write
 * failed) instead of throwing — the overlay effects call this from
 * every per-source effect, so a removal mid-effect can never take
 * the page down. (Diya F8: the six synchronous overlay writes in
 * PlayMap route through here; the zone effect's interpolate branch
 * routes its ensure calls through ensureMapSource/ensureMapLayer.)
 */
export function syncSource(
  map: MapLibreMapLike,
  id: string,
  layers: Record<string, unknown>[],
  data: Record<string, unknown>,
): boolean {
  if (!ensureMapSource(map, id)) return false;
  for (const layer of layers) {
    if (!ensureMapLayer(map, layer)) return false;
  }
  return safeSetSourceData(map, id, data);
}

/**
 * What the resizeNonce (tab-return / overlay-dismiss) effect does once
 * layout has settled: resize at the real size, fit the zone if its first
 * fit never ran, repaint. Mirrors the PlayMap effect body verbatim.
 *
 * v25 FIX: a `fitBounds` failure is caught inside this handler — the
 * fitted flag stays false (tryFitZone marks only after success), so the
 * next return retries, and `triggerRepaint()` still runs so the canvas
 * repaints at its real size.
 *
 * v25 fix round (Diya F6): EVERY step is guarded now, not just the fit
 * — `resize()` and `triggerRepaint()` used to sit outside the try and
 * can throw (real `resize()` after `remove()` runs `_resizeInternal`
 * on a destroyed painter). A tab return never throws, whatever the
 * map's state.
 *
 * v25 fix round (Diya F7 — crash-narrative correction): a throw inside
 * an rAF callback CANNOT produce the Next.js full-page "Application
 * error" — rAF throws are uncaught window errors, not error-boundary
 * crashes. The load-bearing guard against the full-page crash was and
 * is the ZONE EFFECT's fit catch (a throw inside a React effect
 * reaches the error boundary) — see PlayMap's zone effect. This
 * handler's catches keep a failed fit / resize / repaint from escaping
 * as an uncaught error and keep the repaint running; they are not the
 * thing that stopped the full-page crash. Both guards stay.
 */
export function handleMapTabReturn(
  map: MapLibreMapLike,
  boundary: GeoPolygon,
  fittedRef: FitFlag,
  hasSize: boolean,
): 'resized' | 'hidden' {
  if (!hasSize) return 'hidden';
  try {
    map.resize();
  } catch {
    // Resize on a removed / dead-GL map: nothing to resize. The fit
    // and repaint below still run — a failed resize must not skip them.
  }
  try {
    tryFitZone(fittedRef, map, boundary, true);
  } catch {
    // Failed first fit: fitted stays false (retry on the next return
    // or the zone effect's timer), repaint still runs below.
  }
  try {
    map.triggerRepaint();
  } catch {
    // Repaint on a dead map: nothing to paint.
  }
  return 'resized';
}

/** One frame of the zone-shrink interpolation: `start` → `end` at progress `p` (0..1). */
export function interpolateBoundary(
  start: GeoPolygon,
  end: GeoPolygon,
  p: number,
): GeoPolygon {
  return end.map((pt, i) => {
    const s = start[i]!;
    return { lng: s.lng + (pt.lng - s.lng) * p, lat: s.lat + (pt.lat - s.lat) * p };
  });
}

/** Ping-ripple progress: 0 at `createdAtMs`, 1 after 1750 ms, clamped. Future-dated → 0. */
export function rippleProgress(createdAtMs: number, nowMs: number): number {
  return Math.min(1, Math.max(0, (nowMs - createdAtMs) / 1750));
}

export interface RipplePingInput {
  pingId: string;
  createdAtMs: number;
  centre: GeoPoint;
  radiusMeters: number;
}

/**
 * One frame of the zone-shrink animation (was the inline `step` in the
 * PlayMap zone effect). Writes the interpolated boundary and reports
 * whether the animation is finished. The caller schedules the next
 * frame while this returns `done: false`.
 *
 * v25 FIX: a failed write (the map was removed mid-flight) ends the
 * loop (`done: true`) instead of throwing out of the rAF callback.
 *
 * v25 fix round (Diya F7 — crash-narrative correction): a throw out of
 * an rAF callback is an uncaught window error, NOT a Next.js
 * full-page "Application error" — only a throw inside a React effect
 * reaches an error boundary. This guard stays because a loop that
 * throws every frame on a dead map is still a bug, not because it
 * stopped a full-page crash.
 *
 * v25 fix round (Diya F13a): the frame reports `wrote` — the caller
 * must only store the interpolated boundary as displayed when the
 * write actually landed, so a failed frame never leaves
 * `displayedBoundaryRef` pointing at a boundary that is not on screen.
 */
export function shrinkFrame(
  map: MapLibreMapLike,
  start: GeoPolygon,
  end: GeoPolygon,
  startMs: number,
  nowMs: number,
): { done: boolean; interpolated: GeoPolygon; wrote: boolean } {
  const p = Math.min(1, (nowMs - startMs) / 2000);
  const interpolated = interpolateBoundary(start, end, p);
  const wrote = safeSetSourceData(map, 'pakdam-zone', collection([polygonFeature(interpolated)]));
  return { done: p >= 1 || !wrote, interpolated, wrote };
}

/**
 * One frame of the ping-ripple animation (was the inline `frame` in the
 * PlayMap pings effect). Writes the static ping fills + the expanding
 * ripple circles and reports whether the loop is finished — done when
 * every ripple reached full size, or 3 s after the loop started (the
 * wall-clock deadline for future-dated `createdAt` clock skew).
 *
 * v25 FIX: a failed write (the map was removed mid-flight) ends the
 * loop (`done: true`) instead of throwing out of the rAF callback.
 * (Diya F7: as with shrinkFrame, an rAF throw is an uncaught window
 * error, not an error-boundary crash — the guard stays to end the loop
 * on a dead map, not to stop a full-page crash.)
 */
export function rippleFrame(
  map: MapLibreMapLike,
  staticFeatures: Record<string, unknown>[],
  ripplePings: RipplePingInput[],
  loopStartedAtMs: number,
  nowMs: number,
): { done: boolean } {
  const pastDeadline = nowMs - loopStartedAtMs >= 3000;
  let allDone = true;
  const ripples = ripplePings.map((p) => {
    const progress = rippleProgress(p.createdAtMs, nowMs);
    if (progress < 1 && !pastDeadline) allDone = false;
    const radius = p.radiusMeters * (0.15 + 0.85 * progress);
    return polygonFeature(circlePolygon(p.centre, radius, 64), {
      kind: 'ripple',
      pingId: p.pingId,
    });
  });
  const wrote = safeSetSourceData(
    map,
    'pakdam-pings',
    collection([...staticFeatures, ...ripples]),
  );
  return { done: allDone || !wrote };
}

// ---------------------------------------------------------------------------
// Zero-height map area (Diya F3) + Retry rate limit (Zara 4).
// ---------------------------------------------------------------------------

/** A measured rect — container or canvas — for the height check. */
export interface AreaRect {
  width: number;
  height: number;
}

/**
 * True when the map area can actually paint: the container has height
 * AND the canvas (when one exists yet) has height. The founder's live
 * measurement was a 526.4×0 rect — width real, height ZERO — and the
 * pill still said "Map ready". Either rect at 0 height means no paint.
 * (Width is not checked: a 0-width area is the hidden-tab state, which
 * the container-size rules already handle; height is the failure the
 * field evidence showed.)
 */
export function mapAreaHasHeight(
  containerRect: AreaRect,
  canvasRect: AreaRect | null,
): boolean {
  if (containerRect.height <= 0) return false;
  if (canvasRect !== null && canvasRect.height <= 0) return false;
  return true;
}

/** Cooldown after a Retry tap, during which both Retry buttons stay disabled. */
export const RETRY_COOLDOWN_MS = 2000;

/**
 * Whether the Retry buttons must be disabled. Disabled while a load is
 * in flight (Zara 4: spamming Retry during a load keeps aborting map
 * creation so it never finishes) and for RETRY_COOLDOWN_MS after a tap
 * (each tap re-runs the style fetch + tile fetches against the shared
 * Ola key, so sustained hammering can 429 the map for everyone on
 * that key). The component re-derives this on every render (the 1 s
 * clock tick re-renders), so the cooldown lifts without a timer.
 */
export function retryDisabled(
  mapState: MapState,
  nowMs: number,
  lastRetryAtMs: number | null,
): boolean {
  if (mapState === 'loading') return true;
  if (lastRetryAtMs === null) return false;
  return nowMs - lastRetryAtMs < RETRY_COOLDOWN_MS;
}
