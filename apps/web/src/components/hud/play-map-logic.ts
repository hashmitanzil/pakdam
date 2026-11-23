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
import { circlePolygon, polygonCentroid } from '@pakdam/engine';
import { LOCATION_FRESHNESS_SECONDS, STALE_FIX_MS } from '@pakdam/shared';
import type { GeoPoint, GeoPolygon, LocationFix } from '@pakdam/shared';
import {
  OLA_MAP_INITIAL_CENTRE,
  type MapLibreMapLike,
} from '../map/maplibre';

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
 *
 * v27 fix round (Zara Advisory 1–2 — same defence in depth):
 *  - an encoded underscore in the name, `api%5Fkey%3D<value>`
 *    (and the encoded equals on a bare `key%3D<value>`);
 *  - the colon-space form `api_key: <value>` / `key: <value>`,
 *    quoted or unquoted (an error message naming the key, not a
 *    query string), matched by KEY_COLON_RE below;
 *  - a bare key value with no parameter name at all — a long
 *    standalone token (≥ 32 chars, letters + digits), matched by
 *    BARE_KEY_RE below. The length + mixed-content bar keeps
 *    ordinary diagnostic words out: a 32-char token that is all
 *    letters or all digits is left alone.
 */
const KEY_PARAM_RE =
  /(api(?:[-_]|%5F)?key(?:%253D|%3D|=)|(?:^|[?&"'\s])key(?:%3D|=))[^&\s"']*/gi;

/** `"api_key":"<value>"` / `"api-key":"<value>"` / `"key":"<value>"` — a JSON-colon key value. */
const KEY_JSON_RE = /("(?:api[-_]?key|key)"\s*:\s*")[^"]*/gi;

/**
 * `api_key: <value>` / `api-key: <value>` / `key: <value>` — the
 * colon-space form, value quoted or unquoted. The `[^\w]` prefix
 * guard keeps words that merely contain "key" (turkey:, monkey:)
 * untouched, like KEY_PARAM_RE's prefix guard.
 */
const KEY_COLON_RE = /((?:^|[^\w])(?:api[-_]?key|key)\s*:\s*)"?[^,\s"'}\]]+"?/gi;

/**
 * A bare key value with no parameter name: a standalone token of
 * ≥ 32 `[A-Za-z0-9_-]` chars, delimited by whitespace or a URL
 * delimiter on both sides (so a token embedded in a longer word is
 * never half-redacted). The replace callback redacts only when the
 * token carries both a letter and a digit — a long run of digits
 * (a count, a timestamp) or of letters (a word) is not a key.
 */
const BARE_KEY_RE = /(^|[\s/?&=])([A-Za-z0-9_-]{32,})(?=$|[\s/?&=.,;"'}])/g;

function redactKeyValues(text: string): string {
  return text
    .replace(KEY_JSON_RE, '$1…')
    .replace(KEY_PARAM_RE, (_match, key: string) => `${key}…`)
    .replace(KEY_COLON_RE, '$1…')
    .replace(BARE_KEY_RE, (match, prefix: string, token: string) =>
      /[A-Za-z]/.test(token) && /\d/.test(token) ? `${prefix}…` : match,
    );
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
  /**
   * ms epoch the problem was recorded (v28, Diya F3 — the decay clock
   * for a LONE non-tile problem: the old decay only cleared
   * `otherResource` when the TILE ledger was stale, and
   * `tileLedgerStale` requires `count > 0`, so a lone TypeError with
   * zero tile errors stuck forever. The component stamps this and
   * clears via `otherResourceStale` on its own 30 s quiet clock).
   */
  atMs?: number;
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
 *
 * v27 FIX (Meera — the play map was STILL blank after v26, founder
 * 2026-11-21 ~23:33 IST, pill "Map area has no height — try Retry",
 * and Retry changed nothing): the pill now NAMES which element has
 * no height — `heightDiagnosis` ('container-zero-height' vs
 * 'canvas-zero-height', and the width pair) — because v25/v26
 * collapsed both into one flag and one text, so the next field report
 * could never pin the element. The root cause (see PlayMap.tsx) was
 * the CONTAINER: unlayered
 * `.maplibregl-map{position:relative}` beats Tailwind's layered
 * `.absolute`, so the `absolute inset-0` container collapsed to
 * 526.4×0 and its `overflow:hidden` clipped the canvas to nothing.
 * When `heightDiagnosis` is null the legacy boolean behaviour
 * applies (the generic "Map area has no height/width" texts) — the
 * component always passes its live diagnosis, so the generic texts
 * only survive for older callers. A defect diagnosis on a ready map
 * is the WHOLE pill (D9: it outranks fit failures and tile errors);
 * 'ok' / 'hidden-by-design' fall through to the normal ready text.
 *
 * v27 FIX ROUND (Zara Advisory 1–2): this is the UNREDACTED
 * implementation (`pillTextForStateRaw`) — the exported
 * `pillTextForState` below re-sanitises the composed string, so any
 * future unsanitised producer (a new fit reason, tile detail, or
 * resource detail) leaks nothing to screen. The re-sanitisation
 * runs on the composed pill, not per value, so a new interpolated
 * value is covered without touching this function.
 */
/**
 * v28 (Zara A1): the ONLY copy a failed ◎ tap may ever show. It is
 * ALLOW-LISTED — no raw `err.message`, no stack, no coordinates.
 * A tap-handler failure is not a tile/sprite/glyph resource failure,
 * so it never goes through `otherResource` / `mapErrorDetail` either.
 */
export const RECENTRE_FAILED_COPY = 'Re-centre failed — try again';

/** v28 (Diya F2): the ◎ note when there is no fix to centre on. */
export const RECENTRE_ZONE_FALLBACK_NOTE =
  'Centred on the zone — no GPS fix yet.';

/**
 * v28 (Diya F2): the ◎ note when there is neither a fix nor a USABLE
 * zone to centre on. v28 fix round (Diya A6): the old copy said "no
 * zone yet", which is wrong when a zone EXISTS but is degenerate /
 * malformed (a < 3-point boundary, a non-finite vertex, a NaN
 * centroid) — `resolveRecentreCentre` falls back to the Ranchi
 * default for that boundary too. "No usable zone" covers both: no
 * boundary at all, or a boundary that could not be centred on.
 */
export const RECENTRE_DEFAULT_NOTE =
  'Centred on Ranchi — no GPS fix and no usable zone.';

/** v28 (Diya F2/F6): the ◎ note when the fix it centred on is stale. */
export function recentreStaleNote(ageSeconds: number): string {
  return `Centred on your last fix from ${ageSeconds}s ago — GPS is stale.`;
}

function pillTextForStateRaw(
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
  heightDiagnosis: MapAreaHeightDiagnosis | null = null,
  // v28 (Zara A1 + Diya F3): a failed ◎ tap is its OWN honest pill
  // part — a tap-handler failure is not a tile/sprite/glyph resource
  // failure, and it must never be labelled as one. The copy is
  // ALLOW-LISTED (`RECENTRE_FAILED_COPY`): no raw `err.message`, no
  // stack, no coordinates ever reach the pill from this path.
  recentreFailed = false,
  // v29 (E): a lost WebGL context outranks every other ready-state
  // part — the canvas is frozen (or blank) on its last frame, so
  // "Map ready" would be a lie. The pill names the loss and offers
  // Retry (the map remounts on Retry).
  contextLost = false,
): string {
  if (mapState === 'ready' && contextLost) {
    return 'Map graphics lost — try Retry';
  }
  if (mapState === 'ready' && heightDiagnosis === 'container-zero-height') {
    return 'Map container has no height — try Retry';
  }
  if (mapState === 'ready' && heightDiagnosis === 'canvas-zero-height') {
    return 'Map canvas has no height — try Retry';
  }
  if (mapState === 'ready' && heightDiagnosis === 'container-zero-size') {
    return 'Map container has no width — try Retry';
  }
  if (mapState === 'ready' && heightDiagnosis === 'canvas-zero-size') {
    return 'Map canvas has no width — try Retry';
  }
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
    if (recentreFailed) {
      parts.push(RECENTRE_FAILED_COPY);
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

/**
 * The one-line diagnostic pill text for a map state — the exact text
 * PlayMap renders. Every current producer sanitises at source, but
 * the pill is the last boundary before the screen: the composed
 * string is re-sanitised here (`redactKeyValues`), so a future
 * unsanitised `fitReason` / `tileDetail` / `otherResource.detail` /
 * `mapDetail` can never leak a key. Legitimate pill text is
 * untouched — the sanitiser only fires on key-like patterns (see
 * the tests: exact legitimate texts pass through byte-identical).
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
  heightDiagnosis: MapAreaHeightDiagnosis | null = null,
  recentreFailed = false,
  contextLost = false,
): string {
  return redactKeyValues(
    pillTextForStateRaw(
      mapState,
      mapDetail,
      slowLoad,
      elapsedS,
      tileErrorCount,
      tileDetail,
      fitFailed,
      zeroHeight,
      otherResource,
      fitReason,
      fitPending,
      zeroWidth,
      heightDiagnosis,
      recentreFailed,
      contextLost,
    ),
  );
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
  | { kind: 'post-load-tile-error'; detail: string | null; resource: PostLoadResource }
  // v28 (Diya F3): a post-load error that is NOT a resource failure
  // at all — no tile, no sprite/glyph signal, no HTTP status, no
  // resource word in the message (e.g. a JS TypeError from camera /
  // render work, "Cannot read properties of null (reading '0')").
  // The old code filed every post-load error as a tile/resource
  // error, so a camera/JS failure was branded "Map resource
  // failing". This kind is NOT recorded in the tile ledger or
  // `otherResource`: the map is still up and the pill stays honest.
  | { kind: 'post-load-non-resource'; detail: string | null };

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
 * True when a post-load MapLibre `error` event is actually a RESOURCE
 * failure (v28, Diya F3 — the positive-signal test). Grounded in the
 * installed maplibre-gl 5.24.1 build (`ErrorEvent` = `{ error }` plus
 * whatever `data` the firer passed, spread onto the event):
 *  - tile loads fire `ErrorEvent(err, { tile })` — a `tile` property
 *    is the positive tile signal (TileManager._loadTile :51123);
 *  - sprite / glyph loads fire a bare `ErrorEvent(err)` — identified
 *    only by the message;
 *  - a fetch failure is an `AJAXError`, which carries an HTTP `status`
 *    AND the request `url` (`AJAXError: <statusText> (<status>):
 *    <url>`) — either is a positive fetch signal;
 *  - style / source / layer failures name the resource in the
 *    message ("Source layer … does not exist", "Failed to load …").
 * MapLibre errors carry NO `code` (verified against the installed
 * 5.24.1 build: `AJAXError` has only `status` / `statusText` / `url` /
 * `body`), so there is no error-code allow-list to prefer — the
 * positive signals above ARE the allow-list.
 * v28 fix round (Zara V4): the message fallback is NARROW on purpose.
 * The old regex matched bare `load` / `style` / `fetch`, so any
 * future JS error whose message contained "load" ("Failed to load
 * user settings") was misfiled as a resource failure. Now a message
 * matches only on a genuine resource word (sprite / glyph / tile /
 * source / layer / network / an HTTP status), or on a load FAILURE
 * naming a resource ("Failed to load style", "style failed to
 * load") — a bare "load"/"fetch"/"style" with no resource in the
 * sentence does not match. A bare JS TypeError ("Cannot read
 * properties of null (reading '0')") matches NONE of these — it is
 * camera/render work failing, not a resource, and must never be
 * labelled one.
 */
export function isMapResourceError(event: unknown): boolean {
  const ev = (event ?? {}) as {
    tile?: unknown;
    error?: { message?: unknown; status?: unknown; url?: unknown };
  };
  if (ev.tile !== undefined && ev.tile !== null) return true;
  if (ev.error?.status !== undefined && ev.error?.status !== null) return true;
  // An AJAXError always carries the request URL — a url on the error
  // is a fetch that was actually attempted (see the doc above).
  if (typeof ev.error?.url === 'string' && ev.error.url.length > 0) return true;
  const message = String(ev.error?.message ?? '');
  // Plurals included (`glyphs`, `tiles`): MapLibre's own messages
  // use them ("Failed to load glyphs: range 0-255"). `tilejson` is
  // a resource in its own right (a style/source TileJSON load).
  if (/\b(sprites?|glyphs?|tiles?|tilejson|source|layer)\b/i.test(message)) return true;
  if (/\bnetwork\b|HTTP\s*\d/i.test(message)) return true;
  // A load failure naming a resource ("Failed to load style",
  // "style failed to load") — but NOT a bare "Failed to load …"
  // with no resource in the sentence ("Failed to load user
  // settings" is an app/JS error, not a map resource).
  return /\b(style|sprites?|glyphs?|tiles?|tilejson|source|layer)\b[^.]{0,32}\b(failed|failure|error)\b|\b(failed|failure|error)\b[^.]{0,32}\b(style|sprites?|glyphs?|tiles?|tilejson|source|layer)\b/i.test(
    message,
  );
}

/**
 * Decide what a MapLibre `error` event means, given whether the style
 * has loaded yet.
 *
 * v25 FIX: a tile error arriving AFTER `load` is classified
 * 'post-load-tile-error' — PlayMap records it (count + detail) and the
 * pill names the tile failure with a Retry, instead of swallowing the
 * error while the map sits blank behind a "Map ready" pill.
 *
 * v28 (Diya F3): a post-load error that is NOT a resource failure
 * (see `isMapResourceError`) is 'post-load-non-resource' — the
 * component records nothing for it. The old code filed it as a
 * tile/resource error, which is how the founder's ◎ tap read
 * "Map resource failing — Cannot read properties of null
 * (reading '0')" for what was camera/JS work failing, not a
 * resource.
 */
export function classifyMapError(
  loaded: boolean,
  event: unknown,
): MapErrorClassification {
  const detail = mapErrorDetail(event);
  if (loaded) {
    if (!isMapResourceError(event)) {
      return { kind: 'post-load-non-resource', detail };
    }
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

/**
 * True when a lone non-tile problem (`otherResource`, stamped with
 * `atMs` when recorded) is at least the quiet period old — time to
 * clear it on its OWN clock (v28, Diya F3). The old decay only
 * cleared `otherResource` when `tileLedgerStale(...)` was true, and
 * that requires `ledger.count > 0` — so a lone TypeError with zero
 * tile errors never cleared and the pill branded a healthy map
 * "Map resource failing" forever. An unstamped problem (no `atMs`,
 * e.g. built by an older caller) is treated as stale: nothing may
 * stick forever for want of a timestamp.
 */
export function otherResourceStale(
  atMs: number | null | undefined,
  nowMs: number,
): boolean {
  if (atMs === null || atMs === undefined) return true;
  return nowMs - atMs >= TILE_ERROR_QUIET_DECAY_MS;
}

/**
 * True when a failed ◎ tap (`recentreFailed`, stamped with `atMs`
 * when recorded) is at least the quiet period old — time to clear it
 * on its OWN clock (v28 fix round, Zara V1). The pill used to keep
 * showing "Re-centre failed — try again" indefinitely until the next
 * tap, Retry, or fresh map: the decay effect only cleared the tile
 * ledger and `otherResource`. Same window as `otherResourceStale`
 * (30 s quiet, `TILE_ERROR_QUIET_DECAY_MS`); an unstamped failure is
 * treated as stale, like an unstamped `otherResource` — nothing may
 * stick forever for want of a timestamp.
 */
export function recentreFailedStale(
  atMs: number | null | undefined,
  nowMs: number,
): boolean {
  return otherResourceStale(atMs, nowMs);
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
 *
 * v29 (R17): the `setData` is SKIPPED when the serialised payload is
 * unchanged — the overlay effects re-run on the 5 s clock, and an
 * identical write still costs a GL buffer upload + re-render. A
 * freshly created source ALWAYS writes: a rebuilt map starts empty
 * even when the payload matches the old map's last write, so the
 * skip only applies when the source already existed. The ping ripple
 * loop writes the same source directly (see `rippleFrame`) and
 * invalidates this cache on every write, so a finished ripple can
 * never be left on screen by a skipped static write.
 */
const lastSourcePayloadJson = new Map<string, string>();

export function invalidateSourcePayloadCache(id: string): void {
  lastSourcePayloadJson.delete(id);
}

export function syncSource(
  map: MapLibreMapLike,
  id: string,
  layers: Record<string, unknown>[],
  data: Record<string, unknown>,
): boolean {
  let existed = false;
  try {
    existed = !!map.getSource(id);
  } catch {
    existed = false;
  }
  if (!ensureMapSource(map, id)) return false;
  for (const layer of layers) {
    if (!ensureMapLayer(map, layer)) return false;
  }
  const json = JSON.stringify(data);
  if (existed && lastSourcePayloadJson.get(id) === json) return true;
  lastSourcePayloadJson.set(id, json);
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
  // v29 (R17): the ripple writes this source directly, bypassing
  // `syncSource`'s payload cache — invalidate it, so the next static
  // sync writes (and clears the finished ripple) instead of skipping
  // on a stale cache hit.
  invalidateSourcePayloadCache('pakdam-pings');
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

/**
 * Whether a map may be BUILT for this area diagnosis, or must DEFER
 * (v27 — the single build gate, used by the creation effect for the
 * initial mount, every Retry, and the post-await re-check).
 *
 * 'build' when the container HAS size: 'ok', and a canvas defect
 * ('canvas-zero-height' / 'canvas-zero-size' — a canvas defect is
 * repaired by recreating into the sized container). 'defer' when it
 * does not: 'hidden-by-design' (Radio / More tab) and the container
 * defects ('container-zero-height' / 'container-zero-size') — never
 * build into a flat area: a rebuild there just re-adds
 * `maplibregl-map` and reproduces the 526×0 collapse.
 */
export function mapBuildDecision(diagnosis: MapAreaHeightDiagnosis): 'build' | 'defer' {
  switch (diagnosis) {
    case 'ok':
    case 'canvas-zero-height':
    case 'canvas-zero-size':
      return 'build';
    case 'hidden-by-design':
    case 'container-zero-height':
    case 'container-zero-size':
      return 'defer';
  }
}

/**
 * Whether the canvas rect matches the container rect (v27 — the
 * post-resize verification). Per-dimension |diff| <= tolerancePx.
 * The 1 px default is load-bearing: canvas style px are integers
 * (clientWidth) while a getBoundingClientRect container width can be
 * fractional (526 vs 526.4) on a healthy map.
 */
export function canvasMatchesContainer(
  canvasRect: AreaRect,
  containerRect: AreaRect,
  tolerancePx = 1,
): boolean {
  return (
    Math.abs(canvasRect.width - containerRect.width) <= tolerancePx &&
    Math.abs(canvasRect.height - containerRect.height) <= tolerancePx
  );
}

/**
 * The repair ladder for a canvas that does not match its container
 * (v27 — defensive: the real canvas was never 0, the container was;
 * this is for a genuinely stuck canvas). 0 re-resizes tried →
 * 're-resize' (one more resize may repair it); >= 1 → 'recreate'
 * (a resize already failed to repair it).
 */
export function canvasRepairStep(resizesTried: number): 're-resize' | 'recreate' {
  return resizesTried === 0 ? 're-resize' : 'recreate';
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

/** True while the RETRY_COOLDOWN_MS window after a Retry tap is still running. */
export function retryCooldownActive(nowMs: number, lastRetryAtMs: number | null): boolean {
  return lastRetryAtMs !== null && nowMs - lastRetryAtMs < RETRY_COOLDOWN_MS;
}

/**
 * Whether the Retry buttons must be disabled. Disabled while a load is
 * in flight (Zara 4: spamming Retry during a load keeps aborting map
 * creation so it never finishes) and for RETRY_COOLDOWN_MS after a tap
 * (each tap re-runs the style fetch + tile fetches against the shared
 * Ola key, so sustained hammering can 429 the map for everyone on
 * that key). The component re-derives this on every render (the 1 s
 * clock tick re-renders), so the cooldown lifts without a timer.
 *
 * v27 fix round (Diya AT RISK 2 — the deferred exception): while the
 * build is DEFERRED (`isDeferred`, set by the component when the
 * build gate defers) the map is NOT loading — nothing is in flight
 * to abort — so the loading block must not apply. A deferred build
 * whose only exit is the ResizeObserver leaves the user with no
 * manual recovery when the container stays flat for a non-
 * `display:none` reason; Retry while deferred re-runs the gate
 * (retryNonce → creation effect). The cooldown still applies while
 * deferred: a deferred tap still stamps `lastRetryAtMs`, so a
 * hammering user waits 2 s between gate re-runs.
 */
export function retryDisabled(
  mapState: MapState,
  nowMs: number,
  lastRetryAtMs: number | null,
  isDeferred = false,
): boolean {
  if (isDeferred) return retryCooldownActive(nowMs, lastRetryAtMs);
  if (mapState === 'loading') return true;
  return retryCooldownActive(nowMs, lastRetryAtMs);
}

// ---------------------------------------------------------------------------
// v28 — ◎ re-centre, GPS-dot staleness + accuracy, client fix-stop.
// ---------------------------------------------------------------------------

/**
 * v28 (Diya F1/F2): the ◎ centre, resolved with a finite check at
 * every step. The pre-v28 `centreOn` passed an UNVALIDATED centre
 * straight to `map.easeTo`:
 *  - `polygonCentroid` (engine/zone.ts:97) sums raw vertex values and
 *    divides by length — one non-finite vertex (a malformed snapshot
 *    vertex) poisons the sum to NaN, and MapLibre's `LngLat`
 *    constructor throws on NaN (`Invalid LngLat object: (NaN, NaN)`,
 *    installed maplibre-gl 5.24.1) — synchronously out of the onClick,
 *    so the pill could never name it and the tap died silently;
 *  - `centreOn` also passed `bearing: undefined` as a PRESENT key —
 *    `easeTo` reads `'bearing' in options` and runs
 *    `_normalizeBearing(undefined)` → `wrap(undefined, -180, 180)`
 *    → NaN (maplibre-gl-dev.js `wrap$1` :9075, verified by
 *    arithmetic), so EVERY ◎ tap eased the camera toward a NaN
 *    bearing and poisoned the transform. `resetNorth` (bearing 0)
 *    never had this defect.
 * This resolver NEVER returns a non-finite centre: fix → zone
 * centroid → Ranchi default. The caller omits `bearing` entirely
 * when it has none (never passes an explicit `undefined` key) and
 * wraps `easeTo` in try/catch with the allow-listed copy.
 */
export type RecentCentreSource = 'fix' | 'zone' | 'default';

/** True when the point is a usable map centre (finite, in range). */
export function isFiniteLngLat(
  p: { lng: number; lat: number } | null | undefined,
): p is { lng: number; lat: number } {
  return (
    p !== null &&
    p !== undefined &&
    Number.isFinite(p.lng) &&
    Number.isFinite(p.lat) &&
    p.lng >= -180 &&
    p.lng <= 180 &&
    p.lat >= -90 &&
    p.lat <= 90
  );
}

export function resolveRecentreCentre(
  myFix: LocationFix | null,
  zoneBoundary: GeoPolygon | null | undefined,
): { centre: { lng: number; lat: number }; source: RecentCentreSource } {
  if (isFiniteLngLat(myFix)) {
    return { centre: { lng: myFix.lng, lat: myFix.lat }, source: 'fix' };
  }
  const boundary = zoneBoundary ?? [];
  if (boundary.length >= 3 && boundary.every(isFiniteLngLat)) {
    const centroid = polygonCentroid(boundary);
    if (isFiniteLngLat(centroid)) {
      return { centre: { lng: centroid.lng, lat: centroid.lat }, source: 'zone' };
    }
  }
  return {
    centre: { lng: OLA_MAP_INITIAL_CENTRE[0], lat: OLA_MAP_INITIAL_CENTRE[1] },
    source: 'default',
  };
}

/**
 * v28 (Diya F2/F6): a fix is stale when it is older than
 * `STALE_FIX_MS` (60 s, calibration.ts:280). The dot and ◎ used to
 * treat a minutes-old fix as live — GPS dying mid-game left the dot
 * sitting at the last position indefinitely, indistinguishable from
 * live. Callers flag it (faded dot, ◎ note) instead of trusting it.
 */
export function isFixStale(fix: LocationFix | null, nowMs: number): boolean {
  if (fix === null) return false;
  return nowMs - fix.timestampMs > STALE_FIX_MS;
}

/**
 * v29 (H2) — the demo (4a) missing-fix ejection decision, pure and
 * unit-tested. The server rule (room-do.ts): a player silent for 30 s
 * is ejected 30 s into ACTIVE, NEVER during HEAD_START — a cold GPS
 * lock gets the head start to acquire GPS. The demo mirror used to
 * eject 30 s after MATCH start (HEAD_START included); this is the
 * corrected rule, with the baseline the moment ACTIVE began.
 *
 * - `activeAtMs`: epoch ms when ACTIVE began (null when not ACTIVE).
 * - `lastSeenMs`: the freshest fix this tab has seen OR the store's
 *   `lastFixAt` (either may be -Infinity when nothing was ever seen).
 *   A poor-but-present fix counts — it proves liveness, even though
 *   its position is never used for gameplay.
 * - `effectiveNowMs`: wall clock minus hidden time (hidden time is
 *   frozen browser time, not time without GPS).
 * - Suspended seats never eject; live mode never ejects here (the
 *   server enforces it); an already-ejected seat stays ejected once.
 */
export interface MissingFixEjectionInput {
  mode: 'live' | 'demo';
  phase: string;
  activeAtMs: number | null;
  lastSeenMs: number;
  effectiveNowMs: number;
  connectionState: string;
  alreadyEjected: boolean;
}

export function shouldEjectForMissingFix(input: MissingFixEjectionInput): boolean {
  if (input.mode !== 'demo') return false;
  if (input.phase !== 'ACTIVE') return false;
  if (input.activeAtMs === null) return false;
  if (input.alreadyEjected) return false;
  if (input.connectionState === 'suspended') return false;
  const baselineMs = Math.max(input.lastSeenMs, input.activeAtMs);
  return input.effectiveNowMs - baselineMs >= LOCATION_FRESHNESS_SECONDS * 1000;
}

/**
 * v29 (D) — the own-position dot as a DOM marker style, square by
 * construction. The v28 dot is a MapLibre `circle` layer (screen-space
 * circle, round by construction) with a geodesic accuracy ring — no
 * non-square box and no wrong border-radius exists in that path — yet
 * the founder's phone showed the GPS point as a pill. The one
 * mechanism that can elongate a WebGL layer dot is a stretched canvas
 * (the v27 526×0 collapse proved the canvas/container can disagree
 * about size), and a canvas stretch would stretch the dot with it. A
 * DOM marker is positioned by the map but its box is plain CSS: an
 * 18×18 px square with 50% radius, so it is round whatever the canvas
 * does — the same proven pattern as the setup map's orange dot
 * (PlayAreaMap.tsx). The accuracy ring stays a MapLibre fill layer
 * (geodesic circle, untouched). Stale fixes draw faded.
 */
export const ME_DOT_MARKER_SIZE_PX = 18;

export function meDotMarkerStyle(stale: boolean): Record<string, string> {
  return {
    width: `${ME_DOT_MARKER_SIZE_PX}px`,
    height: `${ME_DOT_MARKER_SIZE_PX}px`,
    borderRadius: '999px',
    background: '#EF4444',
    border: '2px solid #fff',
    boxShadow: '0 0 0 5px rgba(239, 68, 68, 0.25)',
    opacity: stale ? '0.35' : '1',
  };
}

/**
 * Dot trails — spacing and size (v29 fix round M8).
 *
 * THE PILL, FOUND IN CODE: the v28 me-dot is a MapLibre `circle`
 * layer and the v29 dot is a DOM marker — both round by construction
 * — yet the founder's phone showed the GPS point as a pill. The
 * stretched-canvas hypothesis for that has no supporting evidence
 * (the only observed canvas/container disagreement, the v27 526×0
 * collapse, renders nothing, not a pill), and the accuracy ring is a
 * true geodesic circle and the status pill is HUD text, not a map
 * point — neither can elongate the dot. The trails CAN, and the
 * mechanism is provable from this file alone: every new fix appends
 * a fading circle, and while moving slowly the points land a few
 * metres apart — closer together than their own diameter at play
 * zoom — so the overlapping circles merge into one elongated
 * capsule trailing the dot, i.e. the dot reads as a pill. The fix
 * is spacing, not shape: a new trail point is appended only after
 * ~11 m of movement (`TRAIL_MIN_MOVE_DEG`, 0.0001 deg ≈ 11.1 m),
 * so consecutive points stay discrete dots with a clear gap at any
 * play zoom, and the points are smaller (`TRAIL_DOT_RADIUS_PX`).
 * Standing still still refreshes the same spot (points stack
 * exactly — no elongation). The DOM marker stays: it is correct and
 * robust, and it keeps the dot round whatever the canvas does. The
 * pill's cause remains unproven on a real phone — the founder's
 * phone is the verdict — but the trail merge is the only
 * code-provable elongation mechanism, and it is fixed here.
 */
export const TRAIL_MIN_MOVE_DEG = 0.0001;
export const TRAIL_DOT_RADIUS_PX = 3;

/**
 * The 'pakdam-me' dot features (v28, Diya F5/F6) — REMOVED (v29 fix
 * round M8): the me dot is a DOM marker now (`meDotMarkerStyle`,
 * PlayMap.tsx), and this helper had no caller left in src — only
 * tests called it. Dead code that builds a circle layer for a dot
 * that no longer exists is a trap for the next reader (it was already
 * misread once as the pill's source). The display rules it carried
 * live on in the marker path: ANY validated fix draws (no ±50 m gate
 * on display), a non-finite fix hides the marker, a stale fix draws
 * faded (`meDotMarkerStyle`). `meAccuracyFeatures` below stays — the
 * accuracy ring still syncs through it.
 */

/**
 * The 'pakdam-me-accuracy' ring (v28, Diya F5): the dot used to
 * render a 900 m-accuracy fix as the identical 8 px circle as a 5 m
 * fix — a rough fix drawn as a precise point. The ring is the fix's
 * real accuracy circle (`circlePolygon`, 64 points), so a rough fix
 * shows as a wide honest circle around the dot and a precise fix as
 * a tight one. Empty when there is no (finite) fix or no positive
 * accuracy — the ring never invents precision.
 */
export function meAccuracyFeatures(
  myFix: LocationFix | null,
): Record<string, unknown>[] {
  if (!isFiniteLngLat(myFix)) return [];
  const radius =
    Number.isFinite(myFix.accuracyMeters) && myFix.accuracyMeters > 0
      ? myFix.accuracyMeters
      : 0;
  if (radius <= 0) return [];
  return [
    polygonFeature(
      circlePolygon({ lng: myFix.lng, lat: myFix.lat }, radius, 64),
      {},
    ),
  ];
}

// ---------------------------------------------------------------------------
// v28 — client fix-stop (DO cap).
// ---------------------------------------------------------------------------

/**
 * Whether the play-page GPS watcher may run (v28, Diya F13): only
 * while a match is actually running AND the tab is visible. The old
 * watcher ran while the page was open in EVERY phase — `mode ===
 * 'live'` is the room mode, not the match phase — so a phone left on
 * the play screen after the game ended kept sending ~1 fix/s all
 * night (~86,400 DO requests/day), and the geolocation.ts header
 * claimed "Location stops when the tab hides" while `watchLocation`
 * implemented no such pause. Terminal phases (COMPLETED / CANCELLED /
 * ABANDONED / EXPIRED), RESOLVING, and LOBBY never watch; a hidden
 * tab never watches, in any phase. The seat is NOT lost by pausing:
 * live, the socket already reports `player.suspended` ('tab-hidden')
 * on hide and the DO exempts suspended seats from the ACTIVE-only
 * (4a) missing-fix ejection, and the first fix on return resumes the
 * seat (`location.update` resumes a suspended seat, room-do.ts);
 * demo, the page's (4a) check excludes hidden time (see play page).
 */
export function shouldWatchLocation(phase: string, hidden: boolean): boolean {
  if (hidden) return false;
  return phase === 'HEAD_START' || phase === 'ACTIVE' || phase === 'SAFETY_PAUSED';
}

/** How long with no fix at all before the player gets a plain GPS state (v28, Diya F16). */
export const GPS_NO_FIX_WAIT_MS = 15_000;

/** The plain-words no-fix notice — a missing dot with no explanation is the current behaviour. */
export const GPS_NO_FIX_NOTICE =
  'Waiting for GPS — no fix yet. Your dot appears once your phone reports a location.';

/** The no-fix notice, or null when there is a fix or GPS may still arrive. */
export function gpsNoFixNotice(noFix: boolean, elapsedMs: number): string | null {
  return noFix && elapsedMs >= GPS_NO_FIX_WAIT_MS ? GPS_NO_FIX_NOTICE : null;
}

/**
 * v28 fix round (Diya R2): the demo (4a) 30 s clock runs on
 * `effectiveNow`, the wall clock minus all hidden time since mount —
 * hidden time is frozen browser time, not time without GPS. A play
 * page opened in a background tab is hidden from mount, so the
 * hidden span starts at mount (see play/page.tsx — the watcher
 * effect seeds `hiddenSinceRef` when `document.hidden` at mount);
 * the (4a) check subtracts the accumulated gap through here.
 */
export function effectiveNowMs(nowMs: number, hiddenGapTotalMs: number): number {
  return nowMs - hiddenGapTotalMs;
}

/**
 * v28 fix round (Diya R3): the GPS-denied notice, shared by the play
 * page and its "Try again" retry. The watch is DEAD on denial — the
 * OS never calls back again until permission is re-granted AND the
 * watch is recreated — so the notice names the recovery (allow it in
 * browser settings) and the page offers the retry next to it.
 */
export const GPS_DENIED_NOTICE =
  'Location is off — allow it in your browser settings.';
