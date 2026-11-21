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
 * v26 FIX (Meera — the play map was STILL blank after v25, founder
 * screenshot 2026-11-21 ~21:30 IST, pill "Zone not in view — camera
 * fit failed — ready"): the v25 pill lied in three ways, and the fit
 * could be silently consumed without ever landing —
 *  - the fit branch appended `mapDetail` verbatim, and `mapDetail` is
 *    'ready' after load, so a merely-DEFERRED fit read as a failed fit
 *    with a stale reason; the fit branch now uses the fit's OWN reason
 *    and never touches `mapDetail`;
 *  - a fit flag outranked tile errors, so a tile failure was invisible
 *    whenever the (false-alarm) fit flag was set; the pill now shows
 *    BOTH, and a merely-pending fit is its own honest text;
 *  - `fitBounds` can silently do NOTHING (installed maplibre-gl 5.x:
 *    `cameraForBounds` returns undefined — warn only, no throw — when
 *    the viewport cannot fit the bounds, e.g. a stale zero-size
 *    transform, and `fitBounds` then returns without moving the
 *    camera), and v25 marked the fit consumed on any non-throwing
 *    return. `tryFitZone` now pre-checks `cameraForBounds` and reports
 *    'cannot-fit' WITHOUT consuming the fit;
 *  - deferred fits ('hidden' / 'no-boundary' / 'cannot-fit') were
 *    never retried — only throws were. They now share the same bounded
 *    retry budget (see `fitRetryDelayForOutcome`);
 *  - the 0-height check returned early on a 0-height CONTAINER, so
 *    the founder's exact 526.4×0 case could never surface;
 *    `diagnoseMapAreaHeight` distinguishes hidden-by-design (the
 *    wrapper is `display:none` on the Radio / More tab) from a real
 *    0-height container while the map tab is visible.
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
 *
 * v26 fix round (Zara 1–2, defence in depth — not reachable from
 * current error sources, whose URLs are single-encoded query-form):
 *  - double-encoded `api_key%253D<value>` (a URL encoded twice);
 *  - the hyphen form `api-key=<value>`;
 *  - the JSON-colon form `"api_key":"<value>"` (a serialised error
 *    object), matched by KEY_JSON_RE below.
 */
const KEY_PARAM_RE =
  /(api[-_]?key(?:%253D|%3D|=)|(?:^|[?&"'\s])key=)[^&\s"']*/gi;

/** `"api_key":"<value>"` / `"api-key":"<value>"` / `"key":"<value>"` — a JSON-colon key value. */
const KEY_JSON_RE = /("(?:api[-_]?key|key)"\s*:\s*")[^"]*/gi;

function redactKeyValues(text: string): string {
  return text
    .replace(KEY_JSON_RE, '$1…')
    .replace(KEY_PARAM_RE, (_match, key: string) => `${key}…`);
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
 *
 * v26 FIX ROUND: the fit part uses a COLON before the reason
 * (`camera fit failed: <reason>`) instead of a third ` — ` — the
 * reason itself contains ` — ` (Arjun 5: separator-ambiguous), so a
 * dash there made the pill unreadable as "part — part — part".
 * A zero-WIDTH area is its own pill text (Diya 6): a 0-wide container
 * on the visible tab is a defect, not hidden-by-design, and it must
 * not read "Map ready" either. Zero height still outranks zero width
 * (D9: a 0-height area paints nothing at all, so it outranks the
 * camera, which outranks the tiles).
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
  fitReason: string | null = null,
  fitPending = false,
  zeroWidth = false,
): string {
  if (mapState === 'ready' && zeroHeight) {
    return 'Map area has no height — try Retry';
  }
  if (mapState === 'ready' && zeroWidth) {
    return 'Map area has no width — try Retry';
  }
  if (mapState === 'ready') {
    const parts: string[] = [];
    if (fitFailed) {
      parts.push(
        `Zone not in view — camera fit failed: ${fitReason ?? 'camera could not fit the zone'}`,
      );
    }
    if (tileErrorCount > 0) {
      parts.push(
        `Map tiles failing — ${tileErrorCount} tile error${tileErrorCount === 1 ? '' : 's'}${tileDetail ? ` — ${tileDetail}` : ''}`,
      );
    }
    if (otherResource) {
      parts.push(`Map ${otherResource.label} failing — ${otherResource.detail ?? 'resource failed'}`);
    }
    if (fitPending) {
      parts.push('Camera moving to the zone…');
    }
    if (parts.length > 0) return parts.join(' · ');
    return 'Map ready';
  }
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
  | 'non-finite-bounds'
  // v26: the map's viewport cannot fit the bounds right now — the
  // camera computation itself returns nothing (see tryFitZone). A
  // DEFERRED outcome, like 'hidden': the fit never ran, the one fit
  // is not consumed, and the caller retries it (bounded) once the
  // viewport is real — a resize, a tab return, a new boundary. It is
  // NOT a failure: no reason is recorded and the pill reads pending,
  // never "fit failed".
  | 'cannot-fit';

/**
 * Whether the map's viewport can actually fit `bbox` right now: the
 * camera computation succeeded AND the camera it returned is usable.
 *
 * v26 fix round (Diya 4 — the exactly-80 px edge, verified against
 * installed maplibre-gl 5.24.1, `cameraForBoxAndBearing`):
 * `cameraForBounds` returns undefined ONLY when the available size is
 * strictly NEGATIVE (`scaleX < 0 || scaleY < 0` — the transform is
 * smaller than the padding). At EXACTLY zero available size (an
 * 80 px container with 40 px padding on each side) it returns a
 * camera with `zoom = scaleZoom(0) = log2(0) = -Infinity` — and
 * `fitBounds` then flies the camera to zoom −∞ (via `_fitInternal`
 * → `flyTo`/`easeTo` with that camera), it does NOT no-op. A
 * non-finite zoom (or centre) is therefore treated exactly like
 * undefined: 'cannot-fit', never a `fitBounds` call. The fake models
 * this edge (`fake-map.mjs`: strict `< 0` → undefined, `== 0` →
 * the −∞ camera) so the guard is tested, not assumed.
 */
export function cameraCanFitBounds(
  map: MapLibreMapLike,
  bbox: [[number, number], [number, number]],
  padding = 40,
): boolean {
  let camera;
  try {
    camera = map.cameraForBounds(bbox, { padding });
  } catch {
    return false;
  }
  if (camera === undefined) return false;
  return (
    Number.isFinite(camera.zoom) &&
    Number.isFinite(camera.center.lng) &&
    Number.isFinite(camera.center.lat) &&
    Number.isFinite(camera.bearing)
  );
}

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
 *
 * v26 FIX: "returns without throwing" is NOT enough — installed
 * maplibre-gl 5.x `fitBounds` can silently do NOTHING: it calls
 * `cameraForBounds`, which returns undefined (warn only, no throw)
 * when the viewport cannot fit the bounds — the transform is smaller
 * than the padding, which is exactly a stale zero-size transform
 * (a map constructed while hidden, before any `resize()` updated it).
 * `fitBounds` then returns the map unchanged, the camera never leaves
 * the Ranchi default, and v25 marked the fit consumed forever. So
 * this function pre-checks `cameraForBounds` with the SAME padding
 * `fitBounds` will use: undefined means 'cannot-fit' — the fit never
 * ran, the flag stays false, and the caller retries it once the
 * viewport is real. `fitBounds` is only called when the camera
 * computation succeeded, so a non-throwing return really did move
 * the camera (duration 0 applies synchronously in this MapLibre
 * build: `_ease` with duration 0 runs the frame at k=1 at once).
 *
 * v26 fix round (Diya 4): the pre-check is `cameraCanFitBounds`, not
 * a bare `=== undefined` — at exactly-80 px the camera is DEFINED
 * with zoom −∞ (see above), and calling `fitBounds` with it would
 * fly the camera to zoom −∞.
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
  if (!cameraCanFitBounds(map, bbox, 40)) return 'cannot-fit';
  map.fitBounds(bbox, { padding: 40, duration: 0 });
  fittedRef.current = true;
  return 'fitted';
}

/**
 * Setup-map fit (PlayAreaMap, A3 — Diya 3): fit the boundary if the
 * viewport can actually fit it, WITHOUT consuming the caller's fit
 * marker on a silent no-op. Returns true only when `fitBounds` ran
 * against a computable, finite camera; the caller assigns
 * `lastFittedRadiusRef` only then, so a zero-size / exactly-80 px
 * viewport leaves the fit unconsumed for the next radius change.
 * A throwing `fitBounds` is also a non-landing fit (false, no throw
 * escapes): the setup map has no pill and no retry loop, and a throw
 * out of its zone effect would reach the error boundary — strictly
 * worse than an unconsumed fit.
 */
export function tryFitSetupZone(
  map: MapLibreMapLike,
  boundary: GeoPolygon,
  hasSize: boolean,
): boolean {
  if (!hasSize || boundary.length < 3) return false;
  const bbox = boundaryBBox(boundary);
  if (!bbox.flat().every(Number.isFinite)) return false;
  if (!cameraCanFitBounds(map, bbox, 40)) return false;
  try {
    map.fitBounds(bbox, { padding: 40, duration: 500 });
  } catch {
    return false;
  }
  return true;
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
 * Which fit outcomes get an automatic timer retry, and which never do.
 *
 * v26: v25 only retried a THROWING fit (the zone effect's catch). A
 * DEFERRED fit — 'hidden' (no size yet), 'cannot-fit' (the viewport
 * cannot fit the bounds yet) — was dropped silently, so a fit that
 * never ran had no way back except a tab switch. Deferred fits now
 * share the SAME bounded budget as a throwing fit: retried until one
 * lands or the budget is spent, never forever. 'fitted' /
 * 'already-fitted' need no retry; 'non-finite-bounds' would fail the
 * same way every time; 'no-boundary' has nothing to fit (a boundary
 * arriving re-runs the effect on its own).
 */
export type FitRetryTrigger = FitOutcome | 'threw';

export function fitRetryDelayForOutcome(
  outcome: FitRetryTrigger,
  retriesUsed: number,
): number | null {
  if (outcome === 'hidden' || outcome === 'cannot-fit' || outcome === 'threw') {
    return nextFitRetryDelayMs(retriesUsed);
  }
  return null;
}

/**
 * The fit-retry budget (v26 fix round).
 *
 * Two SEPARATE counters (Diya 5 — A2): deferrals ('hidden' /
 * 'cannot-fit') and real failures ('threw') are different failure
 * modes with different causes, so they do NOT share one budget. One
 * shared budget starved a later real throw of all timer retries:
 * a map loading on the Radio tab burned 3 deferrals over 6 s, the
 * player returned to the Map tab, the first fit threw, and
 * `scheduleFitRetry('threw')` returned null — zero timer retries
 * for the real failure. With separate budgets each mode gets its
 * own MAX_FIT_RETRIES (3); the hard total is 6, still bounded, and
 * no reset-on-tab-return loophole is needed (a reset on every return
 * would let rapid Map↔Radio toggling mint unlimited attempts).
 * A counter is incremented when its timer actually FIRES, never when
 * scheduled (Diya 7a — A5ii): an effect re-run clears the pending
 * timer in cleanup, and a scheduled-but-cancelled retry must not
 * burn budget. StrictMode's dev double-invoke used to burn 2 of 3
 * on first mount; production was spared StrictMode but not
 * cleanup-burn.
 */
export interface FitRetryBudget {
  /** Deferred-fit timers that actually fired ('hidden' / 'cannot-fit'). */
  deferredFired: number;
  /** Throwing-fit timers that actually fired ('threw'). */
  threwFired: number;
}

export function createFitRetryBudget(): FitRetryBudget {
  return { deferredFired: 0, threwFired: 0 };
}

/** Fresh budget in place (a manual Retry / a new boundary starts over). */
export function resetFitRetryBudget(budget: FitRetryBudget): void {
  budget.deferredFired = 0;
  budget.threwFired = 0;
}

/** Delay (ms) before the next automatic fit retry under a split budget, or null when that mode's budget is spent. */
export function fitRetryDelayForBudget(
  outcome: FitRetryTrigger,
  budget: FitRetryBudget,
): number | null {
  if (outcome === 'hidden' || outcome === 'cannot-fit') {
    return nextFitRetryDelayMs(budget.deferredFired);
  }
  if (outcome === 'threw') {
    return nextFitRetryDelayMs(budget.threwFired);
  }
  return null;
}

/**
 * Schedule one bounded fit retry. Returns the timer handle, or null
 * when that mode's budget is spent (the caller escalates — see
 * `fitEscalationReason`). The attempt is counted when the timer
 * FIRES, not when scheduled: cancelling the timer (effect cleanup /
 * StrictMode double-invoke / a new boundary) burns nothing. The
 * `schedule` parameter exists for tests (a synchronous fake proves
 * the fire-vs-schedule accounting without waiting 2 s); production
 * passes the real `setTimeout`.
 */
export function scheduleFitRetryTimer(
  budget: FitRetryBudget,
  outcome: FitRetryTrigger,
  onFire: () => void,
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
): ReturnType<typeof setTimeout> | null {
  const delay = fitRetryDelayForBudget(outcome, budget);
  if (delay === null) return null;
  return schedule(() => {
    if (outcome === 'threw') budget.threwFired += 1;
    else budget.deferredFired += 1;
    onFire();
  }, delay);
}

/**
 * Outcome → action mapping (Diya 7a — A5i). The zone effect and the
 * tab-return effect both decide through this, so the mapping is
 * tested once and cannot drift between the two call sites.
 *  - 'fitted' / 'already-fitted' → landed (clear any reason);
 *  - 'non-finite-bounds' → record the failure, never retry (the same
 *    boundary would fail the same way);
 *  - 'hidden' / 'cannot-fit' → timer-retry (a deferral, not a failure
 *    — no reason is recorded);
 *  - 'threw' → record the throw's own detail AND timer-retry it;
 *  - 'no-boundary' → nothing (a boundary arriving re-runs the effect).
 */
export type FitOutcomeAction =
  | { action: 'landed' }
  | { action: 'record-failure'; reason: string }
  | { action: 'retry'; outcome: 'hidden' | 'cannot-fit' | 'threw'; reason: string | null }
  | { action: 'none' };

/** The reason recorded for a non-finite boundary (shared by both call sites). */
export const NON_FINITE_BOUNDS_REASON =
  'zone boundary is not finite — camera cannot fit it';

export function fitOutcomeAction(
  outcome: FitOutcome | 'threw',
  throwDetail: string | null = null,
): FitOutcomeAction {
  switch (outcome) {
    case 'fitted':
    case 'already-fitted':
      return { action: 'landed' };
    case 'non-finite-bounds':
      return { action: 'record-failure', reason: NON_FINITE_BOUNDS_REASON };
    case 'hidden':
    case 'cannot-fit':
      return { action: 'retry', outcome, reason: null };
    case 'threw':
      return {
        action: 'retry',
        outcome: 'threw',
        reason: throwDetail ?? 'camera could not fit the zone',
      };
    case 'no-boundary':
      return { action: 'none' };
  }
}

/**
 * The reason recorded when a DEFERRED fit's budget is spent (B1 —
 * Diya 1). A permanently-pending fit never escalates on its own in
 * v26: after 3 timer attempts `fitRetryDelayForOutcome` returns null
 * and nothing re-arms it, so the pill read "Camera moving to the
 * zone…" forever with no Retry. Now the caller escalates pending →
 * failed with this reason the moment the timer returns null, so the
 * pill names the failure and offers Retry. Escalation is at BUDGET
 * exhaustion, not on a wall clock: the budget is the existing, tested
 * bound (3 attempts / 6 s), a wall-clock timer would need a second
 * clock and would fire even while retries are still usefully pending,
 * and the escalation reuses the exact condition the timer loop
 * already computes (schedule returns null) — no new timer, no drift.
 * A later size-return / tab-return still attempts the fit and clears
 * the reason if it lands, so escalation is not terminal.
 */
export function fitEscalationReason(outcome: 'hidden' | 'cannot-fit'): string {
  return outcome === 'hidden'
    ? `camera could not fit the zone after ${MAX_FIT_RETRIES} attempts — the map area never gained size`
    : `camera could not fit the zone after ${MAX_FIT_RETRIES} attempts — the viewport cannot fit the zone`;
}

/**
 * Whether a new boundary is a MATERIAL change from the previous one
 * (Diya 8 — D8). The zone boundary is stabilised by `useStableByJson`
 * (play/page.tsx), so per-render identity churn does NOT reset the
 * budget — but a server snapshot re-serialising with float jitter
 * would mint a fresh identity (and a fresh 3 retries) per snapshot
 * indefinitely. A change is material only when the vertex count
 * differs or any vertex moved by more than `toleranceDeg` (1e-6° ≈
 * 11 cm: JSON round-trip jitter is ~1e-15°, a real shrink moves
 * vertices ~1e-3°). Jitter keeps the old budget AND the old reason.
 */
export function boundaryChangedMaterially(
  prev: GeoPolygon | null,
  next: GeoPolygon,
  toleranceDeg = 1e-6,
): boolean {
  if (prev === null) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    const p = prev[i]!;
    const n = next[i]!;
    if (Math.abs(p.lng - n.lng) > toleranceDeg || Math.abs(p.lat - n.lat) > toleranceDeg) {
      return true;
    }
  }
  return false;
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
 *
 * v26: the result now reports WHAT happened, so the caller can tell a
 * real failure from a deferral instead of guessing from the flag:
 * `fitOutcome` is the tryFitZone outcome (null when hidden — no
 * attempt was made), and `fitError` carries the real detail when the
 * fit THREW (a throw is a real failure, not a silent deferral).
 * 'hidden' / 'no-boundary' / 'cannot-fit' are DEFERRED, never failures
 * — the caller must NOT set a fit-failure flag for them. (v25's
 * caller did exactly that: it set the flag whenever the fit had not
 * landed yet, which is how the founder's screenshot read "camera fit
 * failed — ready" for a fit that had never been attempted.)
 */
export interface MapTabReturnResult {
  /** 'resized' when the container had size and resize+fit+repaint ran; 'hidden' when the container had no size and nothing ran. */
  status: 'resized' | 'hidden';
  /** The zone-fit outcome of the tab-return attempt, or null when hidden (no attempt was made). */
  fitOutcome: FitOutcome | null;
  /** The real detail when the fit threw, or null. */
  fitError: string | null;
}

export function handleMapTabReturn(
  map: MapLibreMapLike,
  boundary: GeoPolygon,
  fittedRef: FitFlag,
  hasSize: boolean,
): MapTabReturnResult {
  if (!hasSize) return { status: 'hidden', fitOutcome: null, fitError: null };
  try {
    map.resize();
  } catch {
    // Resize on a removed / dead-GL map: nothing to resize. The fit
    // and repaint below still run — a failed resize must not skip them.
  }
  let fitOutcome: FitOutcome | null = null;
  let fitError: string | null = null;
  try {
    fitOutcome = tryFitZone(fittedRef, map, boundary, true);
  } catch (err) {
    // Failed first fit: fitted stays false (retry on the next return
    // or the zone effect's timer), repaint still runs below. The
    // detail is REPORTED (v26) instead of swallowed: a throw is a
    // real failure and the pill must name it.
    fitError = unknownErrorDetail(err);
  }
  try {
    map.triggerRepaint();
  } catch {
    // Repaint on a dead map: nothing to paint.
  }
  return { status: 'resized', fitOutcome, fitError };
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
 * (Height only, by name: width is diagnosed by
 * `diagnoseMapAreaHeight`, which reports a 0-width container as
 * 'container-zero-size' — v26 fix round, Diya 6.)
 */
export function mapAreaHasHeight(
  containerRect: AreaRect,
  canvasRect: AreaRect | null,
): boolean {
  if (containerRect.height <= 0) return false;
  if (canvasRect !== null && canvasRect.height <= 0) return false;
  return true;
}

/** What the map area's measured rects mean (v26). */
export type MapAreaHeightDiagnosis =
  /** The area can paint (container has height, canvas has height when one exists). */
  | 'ok'
  /** The whole map slot is 0-height because its wrapper is `display:none`
   *  (the player is on the Radio / More tab) — 0-height BY DESIGN, not
   *  a defect. The flag is left alone. */
  | 'hidden-by-design'
  /** The map tab is VISIBLE (the outer slot has height) but the map
   *  container itself is 0-height — a REAL defect: nothing can paint.
   *  This is the founder's exact 526.4×0 measurement, which v25 could
   *  never surface: it returned early on a 0-height container. */
  | 'container-zero-height'
  /** The container has height but the canvas inside it does not — a
   *  real defect (a canvas that never gained size). */
  | 'canvas-zero-height'
  /** v26 fix round (Diya 6): the map tab is VISIBLE and the container
   *  has height, but its WIDTH is 0 — a real defect, not hidden-by-
   *  design. v26's height-only check read this as 'ok': a 0×420
   *  container paints nothing, `tryFitZone` returns 'hidden' forever,
   *  and (before B1) the pill was pending forever with no Retry. */
  | 'container-zero-size'
  /** The container has size but the canvas inside it has no width — a
   *  real defect, like 'canvas-zero-height'. */
  | 'canvas-zero-size';

/**
 * Diagnose the map area from three measured rects. The OUTER rect is
 * the PlayMap slot itself (`min-h-[320px]`, so it is ≥ 320 px tall
 * whenever the map tab is visible and 0 only while the wrapper is
 * `display:none`); it is what separates "hidden by design" from "the
 * visible map has no height". The container rect is the absolute
 * inset-0 div the map is built in; the canvas rect is the MapLibre
 * canvas inside it (null before one exists — pre-load is not a height
 * failure). Width IS checked (v26 fix round, Diya 6): hidden-by-design
 * is only the `display:none` case — the outer rect is all-zero under
 * a `display:none` ancestor, which is sound in this tree (PlayMap
 * measures the outer slot with `getBoundingClientRect`); a container
 * with height > 0 but width == 0 on the visible tab is a defect and
 * is reported distinctly as 'container-zero-size' (or
 * 'canvas-zero-size' for the canvas).
 */
export function diagnoseMapAreaHeight(
  outerRect: AreaRect,
  containerRect: AreaRect,
  canvasRect: AreaRect | null,
): MapAreaHeightDiagnosis {
  if (outerRect.height <= 0) return 'hidden-by-design';
  if (containerRect.height <= 0) return 'container-zero-height';
  if (containerRect.width <= 0) return 'container-zero-size';
  if (canvasRect !== null && canvasRect.height <= 0) return 'canvas-zero-height';
  if (canvasRect !== null && canvasRect.width <= 0) return 'canvas-zero-size';
  return 'ok';
}

// ---------------------------------------------------------------------------
// View bounds (Diya 4 — A1ii): is the zone still in view after a resize?
// ---------------------------------------------------------------------------

/** Web-Mercator tile size (px) at zoom 0 — the world is 512·2^zoom px wide. */
const MERCATOR_TILE_PX = 512;

/** Project [lng, lat] to world pixel coordinates at `zoom`. */
function projectToWorld(lng: number, lat: number, zoom: number): [number, number] {
  const scale = MERCATOR_TILE_PX * Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * scale;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
  return [x, y];
}

/** Unproject world pixel coordinates at `zoom` back to [lng, lat]. */
function unprojectFromWorld(x: number, y: number, zoom: number): [number, number] {
  const scale = MERCATOR_TILE_PX * Math.pow(2, zoom);
  const lng = (x / scale) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * 180) / Math.PI;
  return [lng, lat];
}

/**
 * The [[minLng, minLat], [maxLng, maxLat]] the camera currently shows,
 * from its centre + zoom + the container size in px. Pure Web-Mercator
 * (same projection MapLibre uses): at zoom z one world pixel is one
 * screen pixel, so the visible span is centre ± half the size.
 */
export function viewBounds(
  centre: { lng: number; lat: number },
  zoom: number,
  widthPx: number,
  heightPx: number,
): [[number, number], [number, number]] {
  const [cx, cy] = projectToWorld(centre.lng, centre.lat, zoom);
  const [minLng, maxLat] = unprojectFromWorld(cx - widthPx / 2, cy - heightPx / 2, zoom);
  const [maxLng, minLat] = unprojectFromWorld(cx + widthPx / 2, cy + heightPx / 2, zoom);
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

/**
 * True when the whole zone bbox is inside the camera's current view.
 * A non-finite bbox is never "in view" (the fit attempt must run and
 * record the real failure instead of being skipped).
 */
export function zoneBboxInView(
  map: Pick<MapLibreMapLike, 'getCenter' | 'getZoom'>,
  boundary: GeoPolygon,
  widthPx: number,
  heightPx: number,
): boolean {
  const bbox = boundaryBBox(boundary);
  if (!bbox.flat().every(Number.isFinite)) return false;
  const view = viewBounds(map.getCenter(), map.getZoom(), widthPx, heightPx);
  return (
    bbox[0][0] >= view[0][0] &&
    bbox[0][1] >= view[0][1] &&
    bbox[1][0] <= view[1][0] &&
    bbox[1][1] <= view[1][1]
  );
}

/**
 * Whether a container-size change is MATERIAL (Diya 4 — A1ii). The fit
 * landed at one size; the container may not be final when the zone
 * effect runs (layout settling, overlay dismiss, keyboard, rotation),
 * and a fit computed for a transient size can leave the zone out of
 * view at the final size — while a later RO `resize()` updates the
 * transform but never re-fits. Threshold: ≥ 120 px or ≥ 25% in either
 * dimension (a rotation / keyboard changes hundreds of px; small
 * layout jitter is tens of px and a few percent). The caller re-fits
 * only when the change is material AND the zone bbox is out of view
 * (see `zoneBboxInView`), once per size — free panning is never
 * fought in general, and shrinks never re-fit.
 */
export function isMaterialSizeChange(prev: AreaRect, next: AreaRect): boolean {
  const dw = Math.abs(next.width - prev.width);
  const dh = Math.abs(next.height - prev.height);
  if (dw >= 120 || dh >= 120) return true;
  if (prev.width > 0 && dw / prev.width >= 0.25) return true;
  if (prev.height > 0 && dh / prev.height >= 0.25) return true;
  return false;
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
