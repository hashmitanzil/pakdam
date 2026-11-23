/**
 * PlayMap — the play map (SCRAM-SPEC §8c).
 *
 * Ola dark tiles via the WEB-CORE map helper (`createOlaMap`), with
 * GeoJSON overlays: red zone ring + fill, ping areas as 150 m circles,
 * no-go areas, my own position dot, and teammates' live dots.
 *
 * NOTE (founder decision, v18): there is NO next-zone preview — no
 * dashed preview ring, no "Next zone in" countdown. The shrink timing
 * is unchanged; the next zone is never shown in advance.
 *
 * The map fits the game zone on first load (fitBounds on the zone
 * boundary) — never the hardcoded Ranchi default. It is 'ready' only
 * after the style loads, and a style/key/network failure surfaces as a
 * banner with the real detail instead of failing silently.
 *
 * A slow load never kills the map: the 12 s watchdog only shows a
 * "still trying" note with a retry — the map keeps loading underneath.
 * A load failure shows an overlay with a Retry button instead of
 * unmounting the map (unmounting orphaned the map in a detached node,
 * so a late load could never paint again).
 *
 * ZERO-SIZE RULE (v18 — the "Map Ready but blank" fix): the play map
 * is kept mounted but hidden with `display:none` when the player is on
 * the Radio / More tab, so its container is 0×0 there. A map created
 * in a 0-size container, a `resize()` to 0, or a `fitBounds` computed
 * for a 0-size viewport leaves a 'ready' map painting nothing — and a
 * plain `resize()` on return never repairs the camera. So: the map is
 * NEVER created while its container is 0-size (creation waits for a
 * non-zero size), `resize()` is NEVER called at 0-size, `fitBounds`
 * runs only at a real size (and is retried on return if it never ran),
 * and returning to the Map tab resizes in a requestAnimationFrame
 * after layout + `triggerRepaint()`. See the creation effect, the
 * ResizeObserver, and the `resizeNonce` effect below.
 *
 * v26 (the map was STILL blank after v25 — founder screenshot
 * 2026-11-21 ~21:30 IST, pill "Zone not in view — camera fit failed
 * — ready"): three v25 lies are fixed here. (1) The tab-return effect
 * used to set the fit-failed flag whenever the fit had not LANDED
 * yet — a false alarm for a fit that was never attempted — and the
 * pill appended the stale 'ready' detail to it. Now only a REAL
 * failed attempt (a throw, or a non-finite boundary) sets the reason,
 * and the pill shows that reason, never `mapDetail`. (2) A deferred
 * fit ('hidden' / 'no-boundary' / 'cannot-fit') was never retried
 * except by a tab switch; it now shares the bounded timer budget with
 * throwing fits, and a ResizeObserver size-return (container gains
 * size) re-attempts it too. (3) `fitBounds` can silently do nothing
 * when the map's transform still holds a stale zero size (the zone
 * effect now resizes before fitting, and `tryFitZone` pre-checks
 * `cameraForBounds` so a no-op fit never consumes the one fit).
 * A fit that has not landed yet is PENDING, not failed: the pill
 * says "Camera moving to the zone…". And the 0-height check now
 * measures the outer slot too, so a 0-height container on a VISIBLE
 * map tab surfaces in the pill instead of hiding behind "hidden tab
 * — not a defect".
 *
 * v26 FIX ROUND (Diya / Zara / Arjun review of the v26 fix): the
 * budget is SPLIT (deferrals vs throws — A2), a spent deferred budget
 * ESCALATES pending → failed with a reason (B1) and Retry is offered
 * while pending too, a manual Retry resets the budget (B2), the
 * `cameraForBounds` pre-check also rejects the exactly-80 px −∞-zoom
 * camera (A1i) and a material size change after the fit landed re-fits
 * once when the zone is out of view (A1ii), the outcome→action
 * mapping is one tested function shared by both call sites (A5i) and
 * the retry timer counts on FIRE not schedule (A5ii), the fit attempt
 * lives in its own effect so a retry nonce can no longer cancel a
 * shrink animation (A6), the sanitisers cover double-encoded / JSON /
 * hyphen key forms (A7), the 0-width container is its own diagnosis
 * (A4), the 0-height detail never clobbers a load failure (D10), the
 * budget resets only on a MATERIAL boundary change (D8), and the pill
 * wraps to two lines (D9b) with a colon before the fit reason (Arjun 5).
 * Deliberately kept, recorded in the fix-round report: zero-height
 * outranks every other failure in the pill (D9), and rapid Map↔Radio
 * toggling can mint fit attempts (D10b — cheap local math, no loop).
 *
 * v27 (Meera — the map was STILL blank after v26, founder
 * 2026-11-21 ~23:33 IST, pill "Map area has no height — try Retry",
 * Retry changed nothing): ROOT CAUSE, proven from the built CSS,
 * was the CONTAINER, not the canvas and not a stale flag. `new Map`
 * adds MapLibre's `.maplibregl-map` class to the container div, and
 * that rule is UNLAYERED (maplibre-gl.css has no `@layer`) while
 * Tailwind v4 puts `.absolute` in `@layer utilities` — unlayered
 * author CSS beats ANY layered rule, so
 * `.maplibregl-map{position:relative}` overrode the container's
 * Tailwind `absolute`. A `relative` div gets NO size from `inset-0`
 * (insets only offset it), and its only children (the canvas
 * container + control container) are absolutely positioned, out of
 * flow — so the container collapsed to exactly 526.4×0, the founder's
 * measurement, while the outer stayed 420. The container ALSO
 * inherits `.maplibregl-map{overflow:hidden}`, so the 526×300 canvas
 * MapLibre sized from the 0-height container (400×300 fallback) was
 * clipped to zero — completely blank, not a strip. Every rebuild
 * re-adds the class, so Retry could never change the outcome; no
 * resize, tab return, or fit retry could either — the height was 0
 * by cascade, not by timing. The setup map paints because its
 * container is a block div with an explicit inline `style={{height}}`
 * (PlayAreaMap.tsx), so the same override is harmless there. FIX:
 * the container now ALSO carries `h-full w-full`, so its size no
 * longer depends on `position:absolute` at all — `relative` or
 * `absolute`, it is 526×420. The pill now names WHICH element has no
 * height or width (container vs canvas — the live diagnosis is kept
 * in `areaDiagnosis` and passed to the pill). Builds go through ONE
 * gate, `mapBuildDecision`: build into a sized container, defer
 * while hidden or while the CONTAINER has no size — on mount, on
 * Retry, and re-checked AFTER the createOlaMap awaits (a tab switch
 * mid-creation defers construction instead of building into a flat
 * container). While the gate defers, Retry stays ENABLED (2 s
 * cooldown only) so the user can re-run the gate by hand — the
 * loading block in `retryDisabled` does not apply while deferred
 * (`isDeferred`), and `retryMap` itself guards on the same
 * predicate, so button and guard can never disagree. After every load / resize / tab return the canvas is
 * VERIFIED against its container (`canvasMatchesContainer`, 1 px
 * tolerance) and a mismatch runs the repair ladder
 * (`canvasRepairStep`): one re-resize first, then ONE bounded
 * rebuild per manual Retry instead of reporting the same failure
 * forever. The diagnosis is re-checked on visibilitychange and
 * window resize too, so it always reflects a live measurement.
 *
 * No map-style switcher, no layers button: single dark style only.
 * When the Ola key is missing, or `maplibre-gl` is not installed yet, the
 * map is not constructed at all and a one-line banner says so — never a
 * blank canvas. The game stays playable without the map.
 */
'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoPoint, GeoPolygon, LocationFix, Ping } from '@pakdam/shared';
import { circlePolygon } from '@pakdam/engine';
import {
  NO_GO_FILL_COLOR,
  PING_FILL_COLOR,
  ZONE_FILL_COLOR,
  ZONE_LINE_COLOR,
  createOlaMap,
  isOlaConfigured,
  type MapLibreMapLike,
} from '@/components/map/maplibre';
// Pure play-map logic, extracted to play-map-logic.ts (v25, Arjun/tests)
// so the blank-map reproduction tests can exercise the REAL code under
// Node without React/DOM. The functions below are the same code that
// used to live inline in this file — same behaviour, one home.
import {
  EMPTY_TILE_LEDGER,
  RECENTRE_NO_FIX_DEFAULT_PILL,
  RECENTRE_NO_FIX_ZONE_PILL,
  TILE_ERROR_QUIET_DECAY_MS,
  appendTrailPoint,
  boundaryChangedMaterially,
  canvasMatchesContainer,
  canvasRepairStep,
  classifyMapError,
  collection,
  createFitRetryBudget,
  diagnoseMapAreaHeight,
  ensureMapLayer,
  ensureMapSource,
  fitEscalationReason,
  fitOutcomeAction,
  handleMapTabReturn,
  isFixStale,
  isMaterialSizeChange,
  mapBuildDecision,
  meAccuracyFeatures,
  meDotMarkerStyle,
  otherResourceStale,
  pillTextForState,
  polygonFeature,
  recentreFailedStale,
  recentreStaleNote,
  recordTileError,
  resetFitRetryBudget,
  resourceLabel,
  resolveRecentreCentre,
  retryDisabled,
  rippleFrame,
  scheduleFitRetryTimer,
  shrinkFrame,
  syncSource,
  tileLedgerStale,
  tryFitZone,
  TRAIL_DOT_RADIUS_PX,
  unknownErrorDetail,
  zoneBboxInView,
  type FitRetryBudget,
  type MapAreaHeightDiagnosis,
  type MapState,
  type OtherResourceProblem,
  type TileErrorLedger,
} from '@/components/hud/play-map-logic';

/** The mapDetail text recorded when the map CONTAINER has no height (v27 — the pill names the element now). */
const ZERO_HEIGHT_CONTAINER_DETAIL = 'map container has no height (0 px tall) — try Retry';
/** The mapDetail text recorded when the map CANVAS has no height (v27). */
const ZERO_HEIGHT_CANVAS_DETAIL = 'map canvas has no height (0 px tall) — try Retry';
/** The mapDetail text recorded when the map CONTAINER has no width (v27). */
const ZERO_WIDTH_CONTAINER_DETAIL = 'map container has no width (0 px wide) — try Retry';
/** The mapDetail text recorded when the map CANVAS has no width (v27). */
const ZERO_WIDTH_CANVAS_DETAIL = 'map canvas has no width (0 px wide) — try Retry';

/** True when the map container has a real (non-zero) size. */
function containerHasSize(container: HTMLElement): boolean {
  return container.clientWidth > 0 && container.clientHeight > 0;
}

export interface PlayMapProps {
  zoneBoundary: GeoPolygon;
  /** Delivered pings (coarse areas only, never exact pins). */
  pings: Ping[];
  noGoAreas: GeoPolygon[];
  /** My own fix (mine to show); null when unknown. */
  myFix: LocationFix | null;
  /**
   * Teammates' latest live fixes, keyed by playerId. Teammates only —
   * the caller must never pass an opponent's position. Empty for a
   * spectator (no live dots) and in demo (no teammate positions tracked).
   */
  teammateFixes: Record<string, LocationFix>;
  /** Clock (ms epoch) — the diagnostic pill's elapsed seconds. */
  nowMs?: number;
  /**
   * Bumped by the caller when something covering the map goes away
   * (the role-reveal overlay dismissing, or the Map tab coming back)
   * — forces a resize so a canvas measured while covered can never stay blank.
   */
  resizeNonce?: number;
}

/** One overlay source, synced: create the source + layers once, then push
 * the data. Callers run this from a per-source effect, so only the source
 * whose input changed ever re-parses GeoJSON. Lives in play-map-logic.ts
 * as `syncSource` (guarded: returns false instead of throwing on a
 * removed map — Diya F8). */

/** Memoized: the parent re-renders every second on its clock tick, and
 *  most of those renders change no map prop — skip them. */
export const PlayMap = memo(function PlayMap({ zoneBoundary, pings, noGoAreas, myFix, teammateFixes, nowMs, resizeNonce = 0 }: PlayMapProps) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMapLike | null>(null);
  // v29 (D): the own-position DOM marker (a real maplibre Marker, not
  // a layer) and the latest fix for the async creation path — the
  // marker is created once per map and removed with it (see the map
  // creation effect's cleanup).
  const meMarkerRef = useRef<import('maplibre-gl').Marker | null>(null);
  const myFixRef = useRef(myFix);
  myFixRef.current = myFix;
  const [mapState, setMapState] = useState<MapState>('loading');
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  // True once the 12 s watchdog fires while the style is still loading
  // — a note only, never a kill: the map keeps loading underneath.
  const [slowLoad, setSlowLoad] = useState(false);
  // Bumped by the Retry button — re-runs map creation from scratch.
  const [retryNonce, setRetryNonce] = useState(0);
  // Exact one-line diagnostic for the current state — loading stage
  // ("creating map… (attempt 1)", "style loading… (attempt 1)") or the
  // real failure detail — shown on screen at all times, never generic.
  const [mapDetail, setMapDetail] = useState<string | null>(null);
  // Post-load tile errors (v25): tiles failing AFTER the style loaded.
  // The map stays up (tiles retry on their own) but the pill must name
  // the failure with the real cause and offer a Retry — never "Map
  // ready" on a blank canvas. Kept as a ledger (play-map-logic.ts):
  // distinct sanitised details only, so one flaky tile re-requested
  // twice reads as ONE error (Diya F4), the FIRST detail is kept
  // (F5), the count is capped, and the slate decays after 30 s quiet.
  const [tileLedger, setTileLedger] = useState<TileErrorLedger>(EMPTY_TILE_LEDGER);
  // A post-load failure that is NOT a tile failure (sprite / glyph /
  // other resource — Diya F4): labelled honestly, never counted in the
  // tile-error count. First one kept, like the tile detail.
  const [otherResource, setOtherResource] = useState<OtherResourceProblem | null>(null);
  // v29 (E): the WebGL context is lost — the canvas is frozen (or
  // blank) and the pill must never claim "Map ready" while it is.
  // Set by the canvas listeners attached at map creation; cleared
  // on restore and on a fresh map (Retry).
  const [contextLost, setContextLost] = useState(false);
  // v28 (Zara A1 + Diya F3): a failed ◎ tap is its OWN state — never
  // recorded as a resource failure. The pill shows the allow-listed
  // `RECENTRE_FAILED_COPY` for it, never raw error text.
  const [recentreFailed, setRecentreFailed] = useState(false);
  // v28 fix round (Zara V1): when the failed ◎ tap happened — the
  // decay clock for `recentreFailed` (same 30 s quiet window as
  // `otherResource`, see the decay effect below). Without a stamp the
  // pill kept showing "Re-centre failed — try again" indefinitely
  // until the next tap, Retry, or fresh map.
  const [recentreFailedAtMs, setRecentreFailedAtMs] = useState<number | null>(null);
  // v28 (Diya F2): the ◎ fallback note — shown under the buttons when
  // the tap centred on a stale fix. Plain words, cleared by the next
  // tap or by a fresh fix arriving.
  // v30 follow-up (Diya review, item C): the NO-FIX fallback is NOT
  // a note any more — a footnote under the buttons (max-w 88 px) let
  // the map move silently, so a dead watcher looked like a working
  // button. It is a LOUD pill instead (`recentreFallback`, rendered
  // top-left, amber, role=status): "No GPS fix — showing zone centre"
  // / "No GPS fix — showing Ranchi". The fallback behaviour itself is
  // unchanged (zone centre with no fix is correct); only the surfacing
  // changed. A stale fix still uses the small note below.
  const [recentreNote, setRecentreNote] = useState<string | null>(null);
  const [recentreFallback, setRecentreFallback] = useState<'zone' | 'default' | null>(null);
  // The first zone fit never landed (Diya F1/F2): the pill must not
  // claim "Map ready" while the camera never reached the zone.
  // v26: this is the reason of the last REAL failed fit attempt (a
  // throw, or a non-finite boundary) — null when no real failure is
  // on record. A merely-deferred fit NEVER sets it (the v25 code set
  // a bare boolean whenever the fit had not landed yet, which is how
  // the founder's screenshot read "camera fit failed — ready" for a
  // fit that had never been attempted). The pill shows this reason,
  // never the stale `mapDetail`. `fitFailed` below is derived from
  // it, so the two can never drift apart.
  const [fitReason, setFitReason] = useState<string | null>(null);
  // Render mirror of fittedRef (a ref change alone re-renders
  // nothing): true once the zone fit has LANDED. The pill's pending
  // state is derived from this, so a landed fit must flip it in the
  // same commit — reading fittedRef during render would leave the
  // pill one render stale.
  const [fitLanded, setFitLanded] = useState(false);
  // The LIVE diagnosis of the map area (v27 — Diya F3's boolean
  // collapsed container-zero and canvas-zero into one flag and one
  // pill text, so no field report could ever pin the element): the
  // full `diagnoseMapAreaHeight` value — 'ok', 'hidden-by-design',
  // 'container-zero-height' | 'canvas-zero-height' |
  // 'container-zero-size' | 'canvas-zero-size' — or null before the
  // first measurement. The pill takes it as its 13th argument and
  // names the element exactly; zeroHeight / zeroWidth below are
  // derived from it for the Retry-button condition.
  const [areaDiagnosis, setAreaDiagnosis] = useState<MapAreaHeightDiagnosis | null>(null);
  // The map area has no width (v26 fix round, Diya 6): a 0×420
  // container on the visible tab paints nothing and must not read
  // "Map ready" either. Height still outranks width in the pill.
  const [zeroWidth, setZeroWidth] = useState(false);
  // Last Retry tap (ms epoch) — both Retry buttons stay disabled while
  // loading and for RETRY_COOLDOWN_MS after a tap (Zara 4).
  const [lastRetryAtMs, setLastRetryAtMs] = useState<number | null>(null);
  // v27 fix round (Diya AT RISK 2): true while map creation is
  // DEFERRED by the build gate — the container has no size and the
  // only exit is waitObserver. While deferred, mapState stays
  // 'loading', which would keep Retry disabled forever (retryDisabled
  // blocks while loading), so the button's disabled state takes the
  // deferred exception: Retry stays enabled (cooldown only) and a
  // tap re-runs the gate via retryNonce → the creation effect. Set
  // at both defer sites (the initial gate and the post-await
  // re-check); cleared when a build starts (startCreation).
  const [isDeferred, setIsDeferred] = useState(false);
  // Bumped by the fit-retry timer — re-runs the zone effect so a failed
  // first fit retries without waiting for a tab switch (Diya F1).
  const [fitRetryNonce, setFitRetryNonce] = useState(0);
  // Creation attempt counter + attempt start (elapsed seconds in the pill).
  const attemptRef = useRef(0);
  const attemptStartedAtRef = useRef(0);
  // The zone is fitted once, on first load with a valid boundary — free
  // panning is never fought afterwards.
  const fittedRef = useRef(false);
  const loadedRef = useRef(false);
  // Fit-retry budget (Diya F1): which boundary the budget belongs to
  // (a new boundary gets a fresh budget) and how many automatic
  // retries each mode has used. v26 fix round (Diya 5 — A2): the
  // budget is SPLIT — deferrals ('hidden' / 'cannot-fit') and real
  // failures ('threw') have separate counters, so a deferral can
  // never starve a later real throw of all timer retries. A counter
  // is incremented when its timer actually FIRES, never when
  // scheduled (Diya 7a — A5ii): a scheduled-but-cancelled retry
  // (effect cleanup / StrictMode double-invoke) burns nothing.
  const fitRetryBudgetRef = useRef<FitRetryBudget>(createFitRetryBudget());
  const fitRetryBoundaryRef = useRef<GeoPolygon | null>(null);
  // Size the first fit landed at (v26 fix round, Diya 4 — A1ii): the
  // container may not be final when the zone effect runs, and a fit
  // computed for a transient size can leave the zone out of view at
  // the final size. The ResizeObserver re-fits (once per size) when
  // the size changes materially AND the zone bbox is out of view.
  const fitLandedSizeRef = useRef<{ width: number; height: number } | null>(null);
  // "WxH" of the last size a refit was done for — one refit per size,
  // so a user who pans the zone out of view is not fought repeatedly.
  const refitAtSizeRef = useRef<string | null>(null);
  // Latest zone boundary for the ResizeObserver callback, which closes
  // over the creation effect's first render (A1ii).
  const zoneBoundaryRef = useRef(zoneBoundary);
  zoneBoundaryRef.current = zoneBoundary;
  // Whether the container had size at the last ResizeObserver
  // notification (v26): a false → true transition is a size-return —
  // the container gained size — and re-attempts a fit that never
  // landed, without waiting for a tab switch.
  const prevHasSizeRef = useRef(false);
  // Previous zone boundary, for the smooth-shrink animation below.
  const prevBoundaryRef = useRef<GeoPolygon | null>(null);
  // Boundary currently on screen — the interpolated mid-state during
  // a shrink animation, the settled boundary otherwise (F6b: a second
  // shrink mid-animation starts from here, not from the previous
  // FINAL boundary, so the ring does not jump).
  const displayedBoundaryRef = useRef<GeoPolygon | null>(null);
  // Dot trails (in-memory only): recent positions per player, pruned
  // to the last 10 s. Own + teammates only — opponents are impossible
  // to trail by construction (the client never receives their fixes).
  const trailPointsRef = useRef(
    new Map<string, { lng: number; lat: number; atMs: number }[]>(),
  );

  // Measure the container AND canvas rects (Diya F3): the founder's
  // live measurement was a 526.4×0 rect — width real, height ZERO —
  // with the pill still saying "Map ready".
  // v26: the outer slot is measured too. The outer div has
  // `min-h-[320px]`, so it is 0-height ONLY while its wrapper is
  // `display:none` (the player is on the Radio / More tab) — that is
  // hidden BY DESIGN and the flag is left alone. A 0-height container
  // while the outer slot HAS height is a REAL defect (the founder's
  // exact case) and surfaces in the pill. The old code returned early
  // on a 0-height container, so that case could never be flagged.
  // Restores mapDetail to 'ready' only when the height/width problem
  // was the detail on record AND the style has loaded — a fit-failure
  // detail is never clobbered, and a not-yet-loaded map never claims
  // 'ready'. v26 fix round (Diya 10 — D10): the defect branch writes
  // the detail ONLY when the style has loaded (`loadedRef`) — a
  // 0-height container coinciding with a load failure (e.g. 401) used
  // to clobber the real failure detail with a zero-height detail. The
  // diagnosis / zeroWidth flags are still set in any state (the pill
  // only reads them when 'ready'), so the defect itself is never
  // lost. v27: the live diagnosis is KEPT in `areaDiagnosis` (not a
  // boolean) — the pill takes it as its 13th argument and names the
  // element, and the detail written is the diagnosis's own text.
  // Measure the container AND canvas rects (Diya F3) and return the
  // live diagnosis, or null when the refs are not mounted yet. The
  // build gate (creation effect) and the pill both read through this
  // one measurement, so they can never disagree about the area.
  const measureAreaDiagnosis = useCallback((): MapAreaHeightDiagnosis | null => {
    const outer = outerRef.current;
    const container = containerRef.current;
    if (!outer || !container) return null;
    const outerRect = outer.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const canvas = container.querySelector('canvas');
    const canvasRect = canvas ? canvas.getBoundingClientRect() : null;
    return diagnoseMapAreaHeight(
      { width: outerRect.width, height: outerRect.height },
      { width: containerRect.width, height: containerRect.height },
      canvasRect ? { width: canvasRect.width, height: canvasRect.height } : null,
    );
  }, []);

  const checkMapAreaHeight = useCallback(() => {
    const diagnosis = measureAreaDiagnosis();
    if (diagnosis === null) return;
    if (diagnosis === 'hidden-by-design') return; // Radio / More tab — not a defect
    setAreaDiagnosis(diagnosis);
    if (diagnosis === 'ok') {
      setZeroWidth(false);
      if (loadedRef.current) {
        setMapDetail((prev) =>
          prev === ZERO_HEIGHT_CONTAINER_DETAIL ||
          prev === ZERO_HEIGHT_CANVAS_DETAIL ||
          prev === ZERO_WIDTH_CONTAINER_DETAIL ||
          prev === ZERO_WIDTH_CANVAS_DETAIL
            ? 'ready'
            : prev,
        );
      }
    } else if (diagnosis === 'container-zero-size') {
      // v26 fix round (Diya 6): height > 0 but width == 0 on the
      // visible tab — a real defect, reported distinctly from height.
      setZeroWidth(true);
      if (loadedRef.current) setMapDetail(ZERO_WIDTH_CONTAINER_DETAIL);
    } else if (diagnosis === 'canvas-zero-size') {
      setZeroWidth(true);
      if (loadedRef.current) setMapDetail(ZERO_WIDTH_CANVAS_DETAIL);
    } else if (diagnosis === 'canvas-zero-height') {
      // v27: the container has height but the canvas inside it does
      // not — a distinct defect with its own pill text, so the next
      // field report pins the element exactly.
      setZeroWidth(false);
      if (loadedRef.current) setMapDetail(ZERO_HEIGHT_CANVAS_DETAIL);
    } else {
      setZeroWidth(false);
      if (loadedRef.current) setMapDetail(ZERO_HEIGHT_CONTAINER_DETAIL);
    }
  }, [measureAreaDiagnosis]);

  // One automatic canvas rebuild per MANUAL Retry (v27): spent by
  // the load-handler verify below, re-armed only by retryMap. Never
  // reset in startCreation — that runs on the auto-rebuild too, and
  // re-arming there would loop rebuilds forever on a persistently
  // 0-height canvas.
  const autoCanvasRecreateRef = useRef(false);
  // Re-resizes tried on the CURRENT map instance (v27 repair ladder):
  // reset in startCreation and retryMap, so a fresh map gets its own
  // one re-resize before the ladder says 'recreate'.
  const canvasResizesTriedRef = useRef(0);

  // VERIFY the canvas actually matches its container after a load /
  // resize / tab return (v27): the pill must never report the same
  // failure forever while a repair was never attempted. The check is
  // `canvasMatchesContainer` (1 px tolerance — canvas style px are
  // integers, a container rect can be fractional). A mismatch runs
  // the repair ladder (`canvasRepairStep`): one re-resize first
  // (resize + repaint, then re-verify once); a canvas still
  // mismatched after that earns ONE bounded rebuild, and only from
  // the load handler — the one place a rebuild has a fresh map to
  // land in. A container with NO size is NOT repaired here — that is
  // the creation effect's defer decision (`mapBuildDecision`), and
  // re-resizing into it would just re-apply the 400×300 fallback.
  const verifyCanvasPainted = useCallback(
    (allowRecreate: boolean) => {
      const container = containerRef.current;
      const map = mapRef.current;
      if (!container || !map) return;
      const containerRect = container.getBoundingClientRect();
      if (containerRect.width <= 0 || containerRect.height <= 0) return;
      const canvas = container.querySelector('canvas');
      const canvasRect = canvas ? canvas.getBoundingClientRect() : null;
      if (canvasRect === null) return;
      if (
        canvasMatchesContainer(
          { width: canvasRect.width, height: canvasRect.height },
          { width: containerRect.width, height: containerRect.height },
        )
      )
        return;
      if (canvasRepairStep(canvasResizesTriedRef.current) === 're-resize') {
        canvasResizesTriedRef.current += 1;
        try {
          map.resize();
        } catch {
          // Dead map: the re-measure below still runs.
        }
        try {
          map.triggerRepaint();
        } catch {
          // Dead map: the re-measure below still runs.
        }
        checkMapAreaHeight();
        // Re-verify once: if the re-resize repaired it this returns
        // at the match check; if not, the ladder's next step is
        // 'recreate' (bounded by allowRecreate + the auto budget).
        verifyCanvasPainted(allowRecreate);
      } else if (allowRecreate && !autoCanvasRecreateRef.current) {
        autoCanvasRecreateRef.current = true;
        setMapReady(false);
        setMapState('loading');
        setMapDetail('canvas still does not match its container — rebuilding once…');
        setAreaDiagnosis(null);
        setZeroWidth(false);
        setRetryNonce((n) => n + 1);
      }
    },
    [checkMapAreaHeight],
  );

  // Tile-error decay (Diya F4): a transient blip must not permanently
  // brand a healthy map. 30 s after the last recorded post-load error
  // with nothing new arriving, the slate clears on its own. Any new
  // error re-runs this effect and restarts the clock; a full Retry
  // resets immediately (retryMap / startCreation).
  // v28 (Diya F3): the two slates clear on SEPARATE clocks. The old
  // code cleared `otherResource` only when `tileLedgerStale(...)`
  // was true, which requires `ledger.count > 0` — so a lone
  // non-tile problem with zero tile errors stuck forever. Now the
  // tile ledger clears on its own staleness and `otherResource`
  // clears on `otherResourceStale` (its own `atMs` clock).
  // v28 fix round (Zara V1): `recentreFailed` clears on the SAME
  // quiet clock — its own `recentreFailedAtMs` stamp via
  // `recentreFailedStale` — so a failed ◎ tap stops branding the
  // pill 30 s after the last failure, like every other pill state.
  useEffect(() => {
    if (tileLedger.count === 0 && otherResource === null && !recentreFailed) return;
    const ledgerAtSchedule = tileLedger;
    const otherAtSchedule = otherResource;
    const failedAtSchedule = recentreFailedAtMs;
    const failedSchedule = recentreFailed;
    const timer = setTimeout(() => {
      if (tileLedgerStale(ledgerAtSchedule, Date.now())) {
        setTileLedger(EMPTY_TILE_LEDGER);
      }
      if (
        otherAtSchedule !== null &&
        otherResourceStale(otherAtSchedule.atMs, Date.now())
      ) {
        setOtherResource(null);
      }
      if (
        failedSchedule &&
        recentreFailedStale(failedAtSchedule, Date.now())
      ) {
        setRecentreFailed(false);
        setRecentreFailedAtMs(null);
      }
    }, TILE_ERROR_QUIET_DECAY_MS);
    return () => clearTimeout(timer);
  }, [tileLedger, otherResource, recentreFailed, recentreFailedAtMs]);

  // Create the map once per mount / retry.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;
    if (!isOlaConfigured()) {
      setMapError('Map needs an Ola key — the game still works without it.');
      setMapDetail('NEXT_PUBLIC_OLA_MAPS_API_KEY is empty in this build');
      setMapState('no-key');
      return;
    }
    // Creation itself lives in startCreation below, so a zero-size
    // container can defer it until it gains size (v18 zero-size rule).
    let cancelled = false;
    // Aborted on unmount / retry while creation is still in flight —
    // createOlaMap then never constructs, so a cancelled attempt can
    // never orphan a live Map (and its WebGL context) in a detached
    // container. v13 fixed the detached-node symptom for the watchdog
    // path; this closes the same hole for every cancellation.
    const abort = new AbortController();
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    let observer: ResizeObserver | null = null;
    let waitObserver: ResizeObserver | null = null;
    const startCreation = () => {
      loadedRef.current = false;
      fittedRef.current = false;
      // A build is starting, so the gate is no longer deferred (F2:
      // a deferred Retry tap that reaches here clears the flag; a
      // tap that defers again sets it at the defer site instead).
      setIsDeferred(false);
      // A fresh attempt starts with a clean diagnostic slate.
      setTileLedger(EMPTY_TILE_LEDGER);
      setOtherResource(null);
      setFitReason(null);
      setFitLanded(false);
      // v28: a fresh map clears the ◎ failure state too — a new map
      // is a new chance to re-centre, not a stale failure.
      setRecentreFailed(false);
      setRecentreNote(null);
      setRecentreFallback(null);
      setAreaDiagnosis(null);
      setZeroWidth(false);
      // v27: a fresh map gets its own one re-resize on the canvas
      // repair ladder (canvasResizesTriedRef — NOT the one auto
      // rebuild, which stays spent until a manual Retry).
      canvasResizesTriedRef.current = 0;
      // v26 fix round (Diya 2 — B2): a manual Retry starts with a
      // FRESH fit-retry budget. The budget used to reset only on a
      // new-boundary identity and on a landed fit, so after 3 throws
      // a Retry rebuilt the map and the first throw on the new map
      // found the budget already spent — no auto-retry on the new map.
      resetFitRetryBudget(fitRetryBudgetRef.current);
      fitRetryBoundaryRef.current = null;
      fitLandedSizeRef.current = null;
      refitAtSizeRef.current = null;
      const attempt = attemptRef.current + 1;
      attemptRef.current = attempt;
      attemptStartedAtRef.current = Date.now();
      setMapDetail(`creating map… (attempt ${attempt})`);
      // A slow load is NOT a dead map — a phone on mobile data can take
      // well over 12 s for style + sprites + glyphs. The watchdog only
      // shows a "still trying" note (with a Retry button); it never
      // unmounts the map. The old code set mapState='error' here, which
      // unmounted the map container with no way back — the map was built
      // under the role-reveal overlay at game start, and by the time the
      // player dismissed the reveal the timeout had already killed it.
      // Worse, a load event arriving after that unmount set 'ready' while
      // the map was still attached to the detached node, so the fresh
      // container stayed blank forever.
      loadTimer = setTimeout(() => {
      if (!cancelled && !loadedRef.current) setSlowLoad(true);
    }, 12_000);
    createOlaMap({ container, signal: abort.signal })
      .then((map) => {
        if (cancelled) {
          // Belt-and-braces with the abort signal above: a map
          // constructed in the sliver before cancellation is removed,
          // never left holding a WebGL context in a dead container.
          map?.remove();
          return;
        }
        if (!map) {
          setMapError('Map needs an Ola key — the game still works without it.');
          setMapDetail('NEXT_PUBLIC_OLA_MAPS_API_KEY is empty in this build');
          setMapState('no-key');
          return;
        }
        // v27 (b): RE-CHECK size AFTER the awaits — the player may
        // have switched tab DURING the style fetch / chunk import, so
        // the container this map was just constructed in may be
        // 0-size now. Never wire up a map built into a flat area:
        // discard it and defer until the container gains size (the
        // same waitObserver the initial gate uses below). The
        // decision is `mapBuildDecision`, the single build gate for
        // mount, Retry, and this post-await re-check.
        const postAwaitDiagnosis = measureAreaDiagnosis();
        if (
          postAwaitDiagnosis !== null &&
          mapBuildDecision(postAwaitDiagnosis) === 'defer'
        ) {
          map.remove();
          // The 12 s slow-load watchdog belongs to the discarded
          // attempt — clear it, or it would fire mid-wait and brand
          // the deferred build "still trying" for no reason.
          clearTimeout(loadTimer);
          setMapDetail('waiting for the map area to become visible…');
          setIsDeferred(true);
          waitObserver = new ResizeObserver(() => {
            const c = containerRef.current;
            if (c && containerHasSize(c)) {
              waitObserver?.disconnect();
              waitObserver = null;
              if (!cancelled) startCreation();
            }
          });
          waitObserver.observe(container);
          return;
        }
        mapRef.current = map;
        // v29 (E): a fresh map has a fresh WebGL context — a
        // context-lost pill from the previous attempt must not survive
        // a Retry into a healthy map.
        setContextLost(false);
        // v29 (E): WebGL context loss — a lost context leaves the
        // canvas frozen on its last frame (or blank) while the pill
        // would otherwise still say "Map ready". Listen on the
        // canvas: on loss, prevent the default (so the context CAN be
        // restored) and show the honest pill; on restore, clear it.
        // No explicit removal: `map.remove()` (the creation effect's
        // cleanup below) destroys the canvas, and the listeners die
        // with the detached element — the same lifecycle as the
        // `map.on` handlers below.
        const canvas = map.getCanvas();
        const onContextLost = (event: Event) => {
          event.preventDefault();
          setContextLost(true);
        };
        const onContextRestored = () => setContextLost(false);
        canvas.addEventListener('webglcontextlost', onContextLost);
        canvas.addEventListener('webglcontextrestored', onContextRestored);
        setMapDetail(`style loading… (attempt ${attempt})`);
        // Resize whenever the container gains size — but NEVER at
        // zero size: the tab switch to Radio / More collapses the
        // container to 0×0, and resizing the live map to 0 is what
        // used to leave it blank on return (v18 zero-size rule).
        // v26: the height check runs on EVERY notification now, not
        // only at a real size — the diagnosis itself tells hidden-by-
        // design apart from a real 0-height container, so a visible
        // tab with a 0-height container surfaces instead of hiding.
        // And a size-RETURN (0 → real size) re-attempts a fit that
        // never landed: the zone effect re-runs on the nonce bump and
        // fits there — the ResizeObserver is the trigger the deferred
        // fit was missing, and it fires even when no tab switch and
        // no boundary change happens. It only fires on the false →
        // true transition, so ordinary resizes never churn the nonce.
        prevHasSizeRef.current = containerHasSize(container);
        observer = new ResizeObserver(() => {
          const hasSize = containerHasSize(container);
          if (hasSize) {
            map.resize();
            const width = container.clientWidth;
            const height = container.clientHeight;
            if (!prevHasSizeRef.current && !fittedRef.current) {
              setFitRetryNonce((n) => n + 1);
            } else if (fittedRef.current && fitLandedSizeRef.current !== null) {
              // v26 fix round (Diya 4 — A1ii): the fit may have landed
              // at a TRANSIENT size (layout settling, overlay dismiss,
              // keyboard, rotation) — a later RO resize() updates the
              // transform but never re-fits, so a fit computed for the
              // transient size can leave the zone out of view at the
              // final size. When the size changed MATERIALLY since the
              // fit landed and the zone bbox is actually out of view,
              // release the fit and re-run the fit effect — ONCE per
              // size (`refitAtSizeRef`), so a user who pans the zone
              // out of view is not fought repeatedly. Shrinks never
              // re-fit; ordinary (non-material) resizes never refit.
              const landedSize = fitLandedSizeRef.current;
              const sizeKey = `${width}x${height}`;
              if (
                sizeKey !== refitAtSizeRef.current &&
                isMaterialSizeChange(landedSize, { width, height }) &&
                !zoneBboxInView(map, zoneBoundaryRef.current, width, height)
              ) {
                refitAtSizeRef.current = sizeKey;
                fittedRef.current = false;
                setFitLanded(false);
                fitLandedSizeRef.current = null;
                setFitRetryNonce((n) => n + 1);
              }
            }
          }
          // Diya F3: a resize that lands on a 0-height canvas must
          // surface in the pill, not hide behind "Map ready".
          checkMapAreaHeight();
          // v27: verify the canvas actually has height after the
          // resize — a still-0 canvas is resized + repainted here
          // (no auto-rebuild from the observer: it fires often).
          verifyCanvasPainted(false);
          prevHasSizeRef.current = hasSize;
        });
        observer.observe(container);
        map.on('load', () => {
          if (cancelled) return;
          clearTimeout(loadTimer);
          loadedRef.current = true;
          setSlowLoad(false);
          setMapReady(true);
          // 'ready' only AFTER the style loads — never before.
          setMapState('ready');
          setMapDetail('ready');
          // Resize only at a real size: a 'load' landing while the
          // player is on the Radio tab must not resize to 0.
          if (containerHasSize(container)) map.resize();
          // Diya F3: measure the area at ready — a 0-height container
          // or canvas surfaces in the pill instead of "Map ready".
          checkMapAreaHeight();
          // v27: verify the canvas actually has height on the fresh
          // map — a still-0 canvas is resized + repainted, and once
          // per manual Retry the map is rebuilt once instead of the
          // pill reporting the same failure forever.
          verifyCanvasPainted(true);
        });
        map.on('error', (event: unknown) => {
          if (cancelled) return;
          // v25: a tile/resource failing AFTER the style loaded is NOT
          // a dead map — keep it up (tiles retry on their own) — but it
          // is RECORDED now (deduped by sanitised detail, first detail
          // kept, key stripped — Diya F4/F5): the old code returned
          // early here, so the failure vanished while the pill kept
          // saying "Map ready" on a blank canvas. A non-tile resource
          // (sprite / glyph / other) is labelled honestly and never
          // counted as a tile error. A pre-load failure still shows the
          // overlay with the real cause and a Retry button — the map
          // container stays mounted, so a late 'load' can still paint
          // into it.
          const classification = classifyMapError(loadedRef.current, event);
          if (classification.kind === 'post-load-non-resource') {
            // v28 (Diya F3): NOT a resource failure — a JS TypeError
            // from camera / render work, not a tile/sprite/glyph.
            // Record nothing: the map is still up and the pill must
            // never brand it "Map resource failing".
            return;
          }
          if (classification.kind === 'post-load-tile-error') {
            if (classification.resource === 'tile') {
              setTileLedger((prev) =>
                recordTileError(prev, classification.detail, Date.now()),
              );
            } else {
              setOtherResource((prev) =>
                prev ?? {
                  label: resourceLabel(classification.resource),
                  detail: classification.detail,
                  // v28 (Diya F3): the decay clock for a lone
                  // non-tile problem (see the decay effect).
                  atMs: Date.now(),
                },
              );
            }
            return;
          }
          clearTimeout(loadTimer);
          setSlowLoad(false);
          const detail = classification.detail;
          setMapDetail(detail ?? 'style failed to load');
          setMapError(
            `Map couldn't load — check your connection and that the Ola Maps key is set and this domain is whitelisted, then reopen this screen.${detail ? ` (${detail})` : ''}`,
          );
          setMapState('error');
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // ROOT CAUSE (v13 left this open): createOlaMap can REJECT —
        // the lazy maplibre-gl chunk failing to download on flaky
        // mobile data, or `new Map` throwing 'Failed to initialize
        // WebGL' — and the old code swallowed the reason into a
        // generic 'unavailable' banner with no detail and no Retry,
        // and unmounted the container so no retry could ever work.
        // Now the real reason is shown on screen and Retry rebuilds
        // from the live container.
        clearTimeout(loadTimer);
        setSlowLoad(false);
        const detail = unknownErrorDetail(err);
        setMapDetail(detail);
        setMapError(
          `Map couldn't start — ${detail}. The game still works without it.`,
        );
        setMapState('unavailable');
      });
    };
    // Zero-size rule (v18) + v27 build gate: never create the map in
    // a 0-size container — `new Map` there (and the `fitBounds`
    // below) leaves a 'ready' map painting nothing. The decision is
    // `mapBuildDecision` on the LIVE diagnosis (not a bare size
    // check): 'defer' while hidden or while the CONTAINER has no
    // size, 'build' when the container has size — including a
    // canvas-only defect, which a rebuild into the sized container
    // repairs. This is the single gate for mount AND Retry (a Retry
    // bump re-runs this effect): a Retry into a still-flat container
    // defers instead of rebuilding into the same flat area. If the
    // container is hidden right now (player on Radio / More while
    // the map was still loading), wait for it to gain size and
    // create then.
    const gateDiagnosis = measureAreaDiagnosis();
    if (gateDiagnosis !== null && mapBuildDecision(gateDiagnosis) === 'build') {
      startCreation();
    } else {
      setMapDetail('waiting for the map area to become visible…');
      setIsDeferred(true);
      waitObserver = new ResizeObserver(() => {
        const c = containerRef.current;
        if (c && containerHasSize(c)) {
          waitObserver?.disconnect();
          waitObserver = null;
          if (!cancelled) startCreation();
        }
      });
      waitObserver.observe(container);
    }
    return () => {
      cancelled = true;
      abort.abort();
      clearTimeout(loadTimer);
      observer?.disconnect();
      waitObserver?.disconnect();
      // v29 (D): the DOM marker belongs to this map — remove it with
      // the map, so a Retry never leaves a stale marker behind.
      meMarkerRef.current?.remove();
      meMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Re-created only when the user taps Retry (checkMapAreaHeight,
    // verifyCanvasPainted and measureAreaDiagnosis are stable
    // callbacks — listed only to satisfy exhaustive-deps).
  }, [retryNonce, checkMapAreaHeight, verifyCanvasPainted, measureAreaDiagnosis]);

  // The role-reveal overlay covers the map at game start, and the Map
  // tab hides the map entirely. Dismissing the overlay / returning to
  // the tab does not change the container's size, so no ResizeObserver
  // fires — the caller bumps `resizeNonce` and the map is resized
  // explicitly. v18: the resize runs in a double requestAnimationFrame
  // AFTER layout (a synchronous resize() in the effect can still read
  // the pre-layout size), is skipped entirely while the container is
  // still zero-size, and is followed by triggerRepaint() so the canvas
  // actually repaints. If the first zone fit never ran (it only runs
  // at a real size — see the zone effect), it runs here instead.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const container = containerRef.current;
    if (!container) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        // Resize + fit-if-never-fitted + repaint, via the tested
        // handler in play-map-logic.ts. (Diya F7: a throw inside this
        // rAF callback would be an uncaught window error, NOT a
        // full-page crash — the load-bearing guard against the
        // full-page crash is the zone effect's fit catch. This
        // handler's own catches keep a failed resize / fit / repaint
        // contained and the repaint running.)
        //
        // v26: the result says WHAT happened — a deferred fit is NOT
        // a failure. Only a REAL failed attempt sets the reason: a
        // throw (fitError) or a non-finite boundary. 'hidden' (no
        // attempt), 'no-boundary' (nothing to fit) and 'cannot-fit'
        // (the viewport cannot fit the bounds yet) leave the reason
        // alone, and the pill reads pending for them instead of
        // "fit failed". The old code set the flag here whenever the
        // fit had not landed yet, with no attempt made and no detail
        // set — the false alarm behind the founder's "camera fit
        // failed — ready" pill.
        //
        // v26 fix round (Diya 7a — A5i): the outcome is decided
        // through `fitOutcomeAction`, the same mapping the fit
        // effect uses. A 'cannot-fit' (or a throw) bumps the fit
        // retry nonce so the fit effect engages its bounded timer
        // retries — a tab-return throw used to set the reason and
        // stop, with no retry path at all.
        const result = handleMapTabReturn(map, zoneBoundary, fittedRef, containerHasSize(container));
        if (result.fitError !== null) {
          const action = fitOutcomeAction('threw', result.fitError);
          if (action.action === 'retry' && action.reason !== null) {
            setFitReason(action.reason);
          }
          setFitRetryNonce((n) => n + 1);
        } else if (result.fitOutcome !== null) {
          const action = fitOutcomeAction(result.fitOutcome);
          if (action.action === 'landed') {
            setFitLanded(true);
            setFitReason(null);
            if (containerHasSize(container)) {
              fitLandedSizeRef.current = {
                width: container.clientWidth,
                height: container.clientHeight,
              };
            }
          } else if (action.action === 'record-failure') {
            setFitReason(action.reason);
          } else if (action.action === 'retry') {
            setFitRetryNonce((n) => n + 1);
          }
          // 'none' (no-boundary): nothing to fit, nothing to do.
        }
        // Diya F3: re-measure the area on return — a 0-height canvas
        // after a tab switch surfaces in the pill.
        checkMapAreaHeight();
        // v27: verify the canvas actually has height after the
        // return resize (resize + repaint only, no auto-rebuild).
        verifyCanvasPainted(false);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [resizeNonce, mapReady, zoneBoundary, checkMapAreaHeight, verifyCanvasPainted]);

  // v27: the flag must reflect a LIVE measurement — re-measure on the
  // paths that can change the area without a ResizeObserver
  // notification or a tab return: coming back to the browser tab
  // (visibilitychange — the browser may have throttled or discarded
  // the WebGL context while hidden) and viewport changes (resize).
  // Resize-then-measure, at a real size only; the canvas verify runs
  // without an auto-rebuild here.
  useEffect(() => {
    if (!mapReady) return;
    const remeasure = () => {
      const map = mapRef.current;
      const container = containerRef.current;
      if (map && container && containerHasSize(container)) {
        try {
          map.resize();
        } catch {
          // Dead map: the re-measure below still runs.
        }
      }
      checkMapAreaHeight();
      verifyCanvasPainted(false);
    };
    const onVisibility = () => {
      if (!document.hidden) remeasure();
    };
    window.addEventListener('resize', remeasure);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('resize', remeasure);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mapReady, checkMapAreaHeight, verifyCanvasPainted]);

  // Ping circles (64-pt geodesic) are built once per ping set, not once
  // per clock tick — the old single overlay effect rebuilt every circle
  // (trig per point) and re-set all 7 sources on every 1 s tick, every
  // GPS fix, and every snapshot, even when only one thing had changed.
  const pingFeatures = useMemo(
    () =>
      pings.flatMap((ping) => {
        const u = ping.uncertainty;
        if (!('centre' in u)) return [];
        return [
          polygonFeature(circlePolygon(u.centre, u.radiusMeters, 64), {
            kind: 'static',
            pingId: ping.pingId,
            createdAtMs: new Date(ping.createdAt).getTime(),
          }),
        ];
      }),
    [pings],
  );
  // One effect per overlay source: a GPS fix only re-runs the me-dot
  // effect, a new ping only the pings effect, a snapshot only the
  // sources it actually replaced — never a full rebuild of all sources.
  // (v18: hold-to-reveal is removed — no reveals source any more.)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const zoneLayers: Record<string, unknown>[] = [
      {
        id: 'pakdam-zone-fill',
        type: 'fill',
        source: 'pakdam-zone',
        paint: { 'fill-color': ZONE_FILL_COLOR },
      },
      {
        id: 'pakdam-zone-line',
        type: 'line',
        source: 'pakdam-zone',
        paint: { 'line-color': ZONE_LINE_COLOR, 'line-width': 2 },
      },
    ];
    // Smooth shrink: zoneBoundary only changes when a shrunk boundary
    // is applied (zone.update → snapshot) — never a preview. When the
    // new boundary has the SAME vertex count as the previous one
    // (circle zones always match; a draw-shape shrink may not),
    // interpolate vertices over 2000 ms with requestAnimationFrame,
    // AFTER the shrink happened. A vertex-count mismatch (or an
    // identical boundary) instant-swaps via the syncSource below.
    // Never driven from nextShrinkAtMs / shrinkPhases — that would be
    // a preview, which v18 removed.
    const prev = prevBoundaryRef.current;
    const willInterpolate =
      prev !== null &&
      prev.length === zoneBoundary.length &&
      zoneBoundary.length >= 3 &&
      JSON.stringify(prev) !== JSON.stringify(zoneBoundary);
    if (willInterpolate) {
      // F6a: do NOT syncSource the FINAL boundary here — that shows
      // one frame of the shrunken zone before the animation runs.
      // Ensure the source/layers only; the rAF below writes the
      // interpolated boundary from frame one. Guarded (Diya F8): on a
      // removed map these return false instead of throwing, so the ref
      // updates below always run (F13b — prevBoundaryRef cannot go
      // stale from a throwing syncSource any more).
      ensureMapSource(map, 'pakdam-zone');
      for (const layer of zoneLayers) ensureMapLayer(map, layer);
    } else {
      syncSource(
        map,
        'pakdam-zone',
        zoneLayers,
        collection(zoneBoundary.length >= 3 ? [polygonFeature(zoneBoundary)] : []),
      );
      displayedBoundaryRef.current = zoneBoundary;
    }
    prevBoundaryRef.current = zoneBoundary;
    let cancelAnim: (() => void) | undefined;
    if (willInterpolate) {
      // F6b: start from the boundary currently on screen — the
      // interrupted animation's mid-state — not the previous FINAL
      // boundary, so a second shrink mid-animation does not jump.
      const displayed = displayedBoundaryRef.current;
      const start =
        displayed !== null && displayed.length === zoneBoundary.length
          ? displayed
          : (prev as GeoPolygon);
      const end = zoneBoundary;
      const startMs = performance.now();
      let raf = 0;
      let stopped = false;
      const step = (t: number) => {
        if (stopped) return;
        const { done, interpolated, wrote } = shrinkFrame(map, start, end, startMs, t);
        // F13a: only store the interpolated boundary as displayed when
        // the write landed — a failed write must not leave
        // displayedBoundaryRef pointing at a boundary that is not on
        // screen (a later shrink would then interpolate from it).
        if (wrote) displayedBoundaryRef.current = interpolated;
        if (!done) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      cancelAnim = () => {
        stopped = true;
        cancelAnimationFrame(raf);
      };
    }
    // NOTE (v26 fix round, Diya 7b — A6): the first-fit attempt used
    // to live in THIS effect. A fit-retry timer firing mid-shrink
    // (animation 2,000 ms, retry delay 2,000 ms — the exact collision
    // window) re-ran the WHOLE effect, whose cleanup cancelled the
    // rAF, and the re-run saw prevBoundaryRef already equal to the new
    // boundary → willInterpolate false → syncSource(final) snapped
    // the ring to its final size instantly. The fit attempt now lives
    // in its own effect below (deps [mapReady, zoneBoundary,
    // fitRetryNonce]); a nonce bump re-runs ONLY the fit, never this
    // animation effect. This effect's deps are [mapReady,
    // zoneBoundary] — a retry nonce can no longer cancel a shrink.
    return () => {
      cancelAnim?.();
    };
  }, [mapReady, zoneBoundary]);

  // First-fit effect (separate from the zone-overlay effect above —
  // see A6): fit the whole zone in view on first load with a valid
  // zone (never the hardcoded Ranchi default — a camera stuck there
  // IS the break, not a fallback the map "paints at"). Later boundary
  // changes (shrinks) never re-fit — free panning is not fought.
  // Zero-size rule: a fit for a 0-size viewport computes a broken
  // camera that no later resize() repairs, so when the container is
  // hidden the fit is SKIPPED (fittedRef stays false) and the
  // resizeNonce effect fits on return instead.
  //
  // THIS is the load-bearing guard against the full-page "Application
  // error" (Diya F7): a throw inside a React effect reaches the error
  // boundary, so a throwing fit must never escape this effect. The
  // rAF callbacks elsewhere cannot produce that crash — their throws
  // are uncaught window errors. tryFitZone leaves fitted false on
  // failure, the reason is kept in fitReason, the pill names it,
  // and the retry below re-runs this effect on a timer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    // One bounded auto-retry for a fit that did not land (v26): the
    // budget is SPLIT (Diya 5 — A2) — deferrals ('hidden' /
    // 'cannot-fit') and throwing fits ('threw') have separate
    // counters, so a deferral can never starve a later real throw.
    // A permanently-deferred container stops after its budget is
    // spent and ESCALATES to a failure (B1 — Diya 1, see below); a
    // size return / tab return / new boundary re-runs this effect
    // and attempts again. Landed, non-finite and no-boundary outcomes
    // never schedule: landed needs none, non-finite would fail the
    // same way, no-boundary has nothing to fit.
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    if (!fittedRef.current && zoneBoundary.length >= 3) {
      const container = containerRef.current;
      // A MATERIALLY new boundary gets a fresh retry budget — a
      // changed boundary may fit where the old one did not — and a
      // fresh reason: a failure recorded for the OLD boundary must
      // not brand the new one. (Diya 8 — D8: identity alone is not
      // the test — a snapshot re-serialising with float jitter
      // grants no fresh budget; see boundaryChangedMaterially.) The
      // fit itself is NOT reset: a landed fit stays landed across
      // shrinks, so free panning is never fought.
      if (boundaryChangedMaterially(fitRetryBoundaryRef.current, zoneBoundary)) {
        fitRetryBoundaryRef.current = zoneBoundary;
        resetFitRetryBudget(fitRetryBudgetRef.current);
        setFitReason(null);
      }
      // v26: resize FIRST, at a real size only. The map's transform
      // can still hold a stale zero size — constructed while hidden,
      // before any resize updated it — and fitBounds against it
      // silently does nothing (cameraForBounds returns undefined, no
      // throw). Verified against installed maplibre-gl 5.24.1:
      // Map.resize() IS synchronous and unthrottled (Map.resize →
      // _resizeInternal → _resizeTransform → transform.resize reads
      // the container and updates tr.width/height at once), so this
      // resize refreshes the transform at the effect's instant. (An
      // earlier comment claimed MapLibre's resize was throttled —
      // that was wrong; the hazard this guards against is a map
      // constructed while hidden, before any resize ran.) Guarded
      // like everywhere else: never at 0-size, and a throw (dead
      // map) must not skip the fit attempt below.
      if (container !== null && containerHasSize(container)) {
        try {
          map.resize();
        } catch {
          // Dead map: the fit below reports it.
        }
      }
      let outcome: 'fitted' | 'already-fitted' | 'no-boundary' | 'hidden' | 'non-finite-bounds' | 'cannot-fit' | 'threw';
      let throwDetail: string | null = null;
      try {
        outcome = tryFitZone(
          fittedRef,
          map,
          zoneBoundary,
          container !== null && containerHasSize(container),
        );
      } catch (err) {
        // v26: a REAL failed attempt — the reason is the fit's own,
        // kept in fitReason for the pill. mapDetail is NOT written
        // here any more: the pill must never show a stale detail.
        outcome = 'threw';
        throwDetail = unknownErrorDetail(err);
      }
      // v26 fix round (Diya 7a — A5i): the outcome is decided through
      // `fitOutcomeAction`, the same mapping the tab-return effect
      // uses — one mapping, two call sites, no drift.
      const action = fitOutcomeAction(outcome, throwDetail);
      if (action.action === 'landed') {
        resetFitRetryBudget(fitRetryBudgetRef.current);
        setFitLanded(true);
        setFitReason(null);
        if (container !== null && containerHasSize(container)) {
          fitLandedSizeRef.current = {
            width: container.clientWidth,
            height: container.clientHeight,
          };
        }
      } else if (action.action === 'record-failure') {
        // Diya F2: a non-finite boundary is surfaced, not retried —
        // the same boundary would fail the same way. A new boundary
        // re-runs this effect with a fresh budget.
        setFitReason(action.reason);
      } else if (action.action === 'retry') {
        // DEFERRED, not failed — the fit never ran (hidden: no size
        // yet; cannot-fit: the viewport cannot fit the bounds yet).
        // No reason is recorded and the pill reads pending. Retry on
        // a timer WITHOUT waiting for a tab switch. A 'threw' records
        // its own detail as the reason first (see fitOutcomeAction).
        if (action.reason !== null) setFitReason(action.reason);
        retryTimer = scheduleFitRetryTimer(
          fitRetryBudgetRef.current,
          action.outcome,
          () => setFitRetryNonce((n) => n + 1),
        );
        if (retryTimer === null && action.outcome !== 'threw') {
          // B1 (Diya 1): the budget is spent and nothing re-arms the
          // timer — escalate pending → failed with a reason, so the
          // pill names the failure and offers Retry instead of reading
          // "Camera moving to the zone…" forever. A later size-return
          // / tab-return still attempts the fit and clears the reason
          // if it lands, so escalation is not terminal.
          setFitReason(fitEscalationReason(action.outcome));
        }
        // A 'threw' with a spent budget needs no escalation: its
        // reason is already recorded above.
      }
      // 'none' (no-boundary) cannot occur here (guarded by length >= 3).
    }
    return () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [mapReady, zoneBoundary, fitRetryNonce]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    syncSource(
      map,
      'pakdam-pings',
      [
        {
          id: 'pakdam-pings-fill',
          type: 'fill',
          source: 'pakdam-pings',
          filter: ['==', ['get', 'kind'], 'static'],
          paint: { 'fill-color': PING_FILL_COLOR },
        },
        // Ping ripple: a second layer on the same source. Each ping's
        // ripple circle expands from ~15% to the full 150 m over
        // ~1.75 s after the ping lands, then rests at the static fill.
        // Keyed by pingId + createdAt (the createdAtMs property), so
        // the 1 s clock tick never re-triggers it — a re-run just
        // recomputes progress from createdAt, which is already 1 for
        // an old ping. Sector pings (no centre) have no ripple.
        {
          id: 'pakdam-pings-ripple',
          type: 'fill',
          source: 'pakdam-pings',
          filter: ['==', ['get', 'kind'], 'ripple'],
          paint: { 'fill-color': 'rgba(29, 78, 216, 0.35)' },
        },
      ],
      collection(pingFeatures),
    );
    const ripplePings = pings.filter(
      (
        p,
      ): p is Ping & {
        uncertainty: { centre: GeoPoint; radiusMeters: number };
      } => 'centre' in p.uncertainty,
    );
    if (ripplePings.length === 0) return;
    let raf = 0;
    let stopped = false;
    // F8: wall-clock deadline — a future-dated createdAt (server/device
    // clock skew, plausible on phones) pins progress at 0 and would
    // otherwise spin this loop at 60 fps until the device clock catches
    // up. The loop stops 3 s after it started regardless of progress;
    // the static ping fill (synced above) stays on screen.
    const loopStartedAtMs = Date.now();
    // v29 (R17): ~30 fps is plenty for a 3 s expanding ring — the
    // 60 fps loop rewrote the ping source (a GL buffer upload) twice
    // as often as any eye can follow. Frames sooner than 33 ms after
    // the last one just re-schedule; the 3 s wall-clock deadline
    // above still bounds the loop.
    let lastFrameAtMs = 0;
    const frame = () => {
      if (stopped) return;
      const now = Date.now();
      if (now - lastFrameAtMs < 33) {
        raf = requestAnimationFrame(frame);
        return;
      }
      lastFrameAtMs = now;
      const { done } = rippleFrame(
        map,
        pingFeatures,
        ripplePings.map((p) => ({
          pingId: p.pingId,
          createdAtMs: new Date(p.createdAt).getTime(),
          centre: p.uncertainty.centre,
          radiusMeters: p.uncertainty.radiusMeters,
        })),
        loopStartedAtMs,
        now,
      );
      if (!done) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [mapReady, pingFeatures, pings]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    syncSource(
      map,
      'pakdam-no-go',
      [
        {
          id: 'pakdam-no-go-fill',
          type: 'fill',
          source: 'pakdam-no-go',
          paint: { 'fill-color': NO_GO_FILL_COLOR },
        },
      ],
      collection(noGoAreas.filter((a) => a.length >= 3).map((a) => polygonFeature(a))),
    );
  }, [mapReady, noGoAreas]);

  // My own position: a DOM MARKER (v29 D) + the accuracy ring.
  // The v28 dot was a MapLibre `circle` layer — a screen-space
  // circle, round by construction — and no non-square box or wrong
  // border-radius exists anywhere in that path, yet the founder's
  // phone showed the GPS point as a pill. The v29 fix-round
  // re-examination (M8) blamed overlapping fading trail points, and
  // the v29 spacing threshold (~11 m) was right — but v30 proved the
  // GATE never held (see `appendTrailPoint`, play-map-logic.ts): the
  // inline append skipped only when the last point was BOTH close
  // AND < 3 s old, and the 5 s-quantised map clock meant the age leg
  // was almost always ≥ 3 s, so a point was appended on every tick
  // regardless of distance. The trail gate is now the pure
  // distance-only `appendTrailPoint` below; the DOM marker stays as
  // well: an 18×18 px square with a 50% radius
  // (`meDotMarkerStyle`, play-map-logic.ts — the same proven pattern
  // as the setup map's orange dot, now with an explicit
  // `boxSizing: border-box` so the border cannot inflate the box),
  // so it is round whatever the canvas does. The ring is the fix's
  // real accuracy circle, so a rough fix shows wide and a precise
  // fix tight; the ±50 m gate is a gameplay-usability gate, never a
  // display gate, so ANY validated fix (up to ±1000 m) draws. A stale
  // fix (> 60 s, STALE_FIX_MS) draws faded instead of masquerading
  // as live. Deps include nowMs so the stale fade advances on the 5 s clock
  // even while standing still. The marker is created once
  // per map (the maplibre chunk is already loaded by createOlaMap,
  // so the import resolves from cache) and removed with the map; the
  // test fake implements MapLibreMapLike but is not a real Map (no
  // getContainer), so no marker is created under it — the style is
  // covered by `meDotMarkerStyle` unit tests.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (typeof (map as unknown as { getContainer?: unknown }).getContainer !== 'function') {
      return;
    }
    let cancelled = false;
    const positionMarker = (marker: import('maplibre-gl').Marker) => {
      const fix = myFixRef.current;
      const el = marker.getElement();
      if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      Object.assign(el.style, meDotMarkerStyle(isFixStale(fix, nowMs ?? Date.now())));
      marker.setLngLat([fix.lng, fix.lat]);
    };
    if (!meMarkerRef.current) {
      void import('maplibre-gl')
        .then((maplibre) => {
          if (cancelled) return;
          if (meMarkerRef.current) return;
          const el = document.createElement('div');
          el.setAttribute('aria-label', 'Your location');
          const marker = new maplibre.Marker({ element: el }).addTo(
            map as unknown as import('maplibre-gl').Map,
          );
          meMarkerRef.current = marker;
          positionMarker(marker);
        })
        .catch(() => {
          // A failed marker never throws the page — the accuracy
          // ring still shows, and the next fix re-runs this effect
          // (myFix is a dep) and retries.
        });
    } else {
      positionMarker(meMarkerRef.current);
    }
    return () => {
      cancelled = true;
    };
  }, [mapReady, myFix, nowMs]);

  // The accuracy ring (v28 Diya F5/F6): the fix's real accuracy
  // circle, from `meAccuracyFeatures` (play-map-logic.ts) — a
  // geodesic circle, untouched by the v29 dot change. Null /
  // non-finite fixes yield no features, never a NaN point.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    syncSource(
      map,
      'pakdam-me-accuracy',
      [
        {
          id: 'pakdam-me-accuracy-fill',
          type: 'fill',
          source: 'pakdam-me-accuracy',
          paint: { 'fill-color': 'rgba(239, 68, 68, 0.10)' },
        },
      ],
      collection(meAccuracyFeatures(myFix)),
    );
  }, [mapReady, myFix, nowMs]);

  // Teammates' live positions (green dots, same size/stroke as the me
  // dot). Teammates only — the caller never passes an opponent here,
  // and a spectator passes an empty map, so no live dots render then.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    syncSource(
      map,
      'pakdam-teammates',
      [
        {
          id: 'pakdam-teammate-dot',
          type: 'circle',
          source: 'pakdam-teammates',
          paint: {
            'circle-color': '#22C55E',
            'circle-radius': 8,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#FFFFFF',
          },
        },
      ],
      collection(
        Object.values(teammateFixes).map((fix) => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [fix.lng, fix.lat] },
        })),
      ),
    );
  }, [mapReady, teammateFixes]);

  // Dot trails (10 s fade, in-memory only): each new fix appends a
  // point for me and for each teammate; points older than 10 s are
  // pruned and the rest fade by per-feature opacity. Re-runs on the
  // 5 s-quantised clock (mapNowMs, passed in as nowMs) so the fade
  // advances in 5 s steps even while standing still.
  // Own + teammates only — the caller never passes an opponent's fix.
  // v30 (Meera — the v29 pill fix did NOT hold): the old inline
  // append skipped only when the last point was BOTH < ~11 m away
  // AND < 3 s old, and the 5 s clock meant the age leg was almost
  // always ≥ 3 s, so a point was appended on every tick while moving
  // slowly and the overlapping 3 px dots merged into a capsule
  // trailing the me-dot — the pill. Appends now go through the pure
  // `appendTrailPoint` (play-map-logic.ts): distance-only ≥ ~11 m,
  // sub-threshold fixes refresh the last point in place instead of
  // stacking a new one. A stationary player still keeps a fresh dot
  // at the same spot (one point, refreshed timestamp — no stack).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const now = nowMs ?? Date.now();
    const cutoff = now - 10_000;
    // F7: drop trails for players no longer in the current fix set —
    // otherwise a departed teammate's key lives forever, its points
    // age past the 10 s cutoff and are serialised into every setData
    // at opacity 0.
    const liveKeys = new Set<string>(Object.keys(teammateFixes));
    if (myFix) liveKeys.add('me');
    for (const key of [...trailPointsRef.current.keys()]) {
      if (!liveKeys.has(key)) trailPointsRef.current.delete(key);
    }
    const append = (key: string, fix: LocationFix | null) => {
      if (!fix) return;
      // v30: the spacing gate lives in `appendTrailPoint`
      // (play-map-logic.ts) — distance-only, tested. The old inline
      // gate had a `< 3 s` time bypass that the 5 s clock defeated,
      // so slow movement appended a point every tick (the pill).
      trailPointsRef.current.set(
        key,
        appendTrailPoint(trailPointsRef.current.get(key) ?? [], fix, now),
      );
    };
    append('me', myFix);
    for (const [playerId, fix] of Object.entries(teammateFixes)) {
      append(playerId, fix);
    }
    const features: Record<string, unknown>[] = [];
    for (const [key, list] of trailPointsRef.current) {
      const color = key === 'me' ? '#EF4444' : '#22C55E';
      for (const p of list) {
        // F7: skip points already past the cutoff — a key that stopped
        // receiving fixes is never re-filtered by append(), so without
        // this its stale points would ship at opacity 0 forever.
        if (p.atMs < cutoff) continue;
        features.push({
          type: 'Feature',
          properties: {
            color,
            opacity: Math.max(0, 1 - (now - p.atMs) / 10_000),
          },
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        });
      }
    }
    syncSource(
      map,
      'pakdam-trails',
      [
        {
          id: 'pakdam-trail-dot',
          type: 'circle',
          source: 'pakdam-trails',
          paint: {
            'circle-color': ['get', 'color'],
            'circle-radius': TRAIL_DOT_RADIUS_PX,
            'circle-opacity': ['get', 'opacity'],
          },
        },
      ],
      collection(features),
    );
  }, [mapReady, myFix, teammateFixes, nowMs]);

  // Compass lock: rotate the map with the device heading. OFF restores
  // north-up. Fails soft ("Compass unavailable") when no heading is
  // available. iOS needs requestPermission() inside the tap gesture.
  const [compassOn, setCompassOn] = useState(false);
  const [compassError, setCompassError] = useState<string | null>(null);
  // F12: the iOS permission prompt is async — the button is disabled
  // while it is pending, and the intent ref re-checks the user's
  // latest tap after the await, so a double-tap (or on-then-off while
  // the prompt is up) cannot leave the lock ON against the last tap.
  const [compassPending, setCompassPending] = useState(false);
  const compassPendingRef = useRef(false);
  const compassIntentRef = useRef<boolean | null>(null);
  // Mirror of compassOn for sensor/async callbacks, which cannot wait
  // for a re-render to see the new state (F11/F13).
  const compassOnRef = useRef(false);
  const lastCompassBearingRef = useRef<number | null>(null);
  // v28 (Diya F1/F2 + Zara A1): the ◎ centre, guarded end to end.
  // The old code had three holes, all on this one path:
  //  (1) NO load guard — `mapRef.current` is assigned as soon as
  //      `createOlaMap` resolves, BEFORE the 'load' event, and ◎/N
  //      were tappable the whole time (no `disabled` prop, unlike
  //      compass). `easeTo` on an unloaded map throws or misbehaves
  //      with no pill and no feedback. Now: no map or not ready →
  //      return, and the buttons are disabled until ready.
  //  (2) NO finite check — `polygonCentroid` sums raw vertices, so
  //      one non-finite vertex yields a NaN centre and MapLibre's
  //      `LngLat` constructor throws synchronously out of the onClick.
  //      Now: `resolveRecentreCentre` (fix → zone → Ranchi) never
  //      returns a non-finite centre.
  //  (3) `bearing: undefined` was passed as a PRESENT key — `easeTo`
  //      reads `'bearing' in options` and runs
  //      `_normalizeBearing(undefined)` → NaN, so EVERY ◎ tap eased
  //      toward a NaN bearing. Now: `bearing` is only included when
  //      defined.
  // A throw is caught here and recorded as the allow-listed
  // `RECENTRE_FAILED_COPY` in the pill — never raw error text, never
  // a "resource failure" (Zara A1, Diya F3). The player is TOLD when
  // the tap fell back: zone centroid / Ranchi default (no fix) get the
  // LOUD amber pill (v30 follow-up, item C — the old footnote under
  // the buttons let a dead watcher look like a working tap), and a
  // stale fix gets a plain note under the buttons (Diya F2) — never
  // silently centring somewhere the player did not ask for.
  const centreOn = useCallback(
    (bearing?: number) => {
      const map = mapRef.current;
      if (!map || !mapReady) return;
      const { centre, source } = resolveRecentreCentre(myFix, zoneBoundary);
      try {
        if (bearing === undefined) {
          map.easeTo({ center: [centre.lng, centre.lat], duration: 300 });
        } else {
          map.easeTo({ center: [centre.lng, centre.lat], bearing, duration: 300 });
        }
      } catch {
        // A tap-handler failure is not a resource failure: record
        // only the allow-listed copy (Zara A1) and nothing else.
        // v28 fix round (Zara V1): stamp it — the decay effect
        // clears the pill after the 30 s quiet window, so a failed
        // tap never brands the map forever.
        setRecentreFailed(true);
        setRecentreFailedAtMs(Date.now());
        setRecentreNote(null);
        setRecentreFallback(null);
        return;
      }
      setRecentreFailed(false);
      setRecentreFailedAtMs(null);
      if (source === 'fix' && myFix !== null) {
        const now = nowMs ?? Date.now();
        setRecentreFallback(null);
        if (isFixStale(myFix, now)) {
          const ageS = Math.max(0, Math.floor((now - myFix.timestampMs) / 1000));
          setRecentreNote(recentreStaleNote(ageS));
        } else {
          setRecentreNote(null);
        }
      } else if (source === 'zone') {
        // v30 follow-up (item C): loud pill, not the footnote.
        setRecentreNote(null);
        setRecentreFallback('zone');
      } else {
        setRecentreNote(null);
        setRecentreFallback('default');
      }
    },
    [myFix, zoneBoundary, mapReady, nowMs],
  );

  // A fresh fix makes a fallback/stale ◎ note obsolete — clear it so
  // the note never outlives the GPS state it described (Diya F2).
  // v30 follow-up (item C): the loud fallback pill clears too — a
  // fresh fix means GPS is back, so "No GPS fix" must not linger.
  useEffect(() => {
    if (myFix !== null && !isFixStale(myFix, nowMs ?? Date.now())) {
      setRecentreNote(null);
      setRecentreFallback(null);
    }
  }, [myFix, nowMs]);

  /** Re-centre only — the ◎ button. */
  const recentre = useCallback(() => centreOn(), [centreOn]);
  /** North-up + re-centre — the N button is NOT a duplicate of re-centre. */
  const resetNorth = useCallback(() => {
    // F11: N turns the compass lock OFF first — otherwise the next
    // sensor event snaps the bearing straight back to the device
    // heading and undoes the reset. The compass button state follows
    // (compassOn false → red active style clears).
    if (compassOnRef.current) {
      compassOnRef.current = false;
      compassIntentRef.current = false;
      setCompassOn(false);
      setCompassError(null);
      lastCompassBearingRef.current = null;
    }
    centreOn(0);
  }, [centreOn]);

  /** Compass lock toggle: on = follow device heading, off = north-up. */
  const toggleCompass = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    // F12: a tap while the iOS permission prompt is still pending
    // cancels the pending enable instead of stacking a second request
    // or turning the lock on against the user's latest tap.
    if (compassPendingRef.current) {
      compassIntentRef.current = false;
      compassPendingRef.current = false;
      setCompassPending(false);
      return;
    }
    if (compassOn) {
      compassIntentRef.current = false;
      compassOnRef.current = false;
      setCompassOn(false);
      setCompassError(null);
      lastCompassBearingRef.current = null;
      map.easeTo({ bearing: 0, duration: 300 });
      return;
    }
    compassIntentRef.current = true;
    compassPendingRef.current = true;
    setCompassPending(true);
    try {
      // F12: the DeviceOrientationEvent global is read inside the try
      // (and guarded with typeof) — the old bare reference outside the
      // try threw a ReferenceError on browsers without that global,
      // which became an unhandled rejection from `void toggleCompass()`.
      const DOE =
        typeof DeviceOrientationEvent !== 'undefined'
          ? (DeviceOrientationEvent as unknown as {
              requestPermission?: () => Promise<string>;
            })
          : undefined;
      if (typeof DOE?.requestPermission === 'function') {
        const result = await DOE.requestPermission();
        // Re-check the intent after the await: the user may have
        // cancelled while the prompt was up.
        if (compassIntentRef.current !== true) return;
        if (result !== 'granted') {
          setCompassError('Compass unavailable');
          return;
        }
      }
    } catch {
      if (compassIntentRef.current !== true) return;
      setCompassError('Compass unavailable');
      return;
    } finally {
      compassPendingRef.current = false;
      setCompassPending(false);
    }
    if (compassIntentRef.current !== true) return;
    // F14: seed the last-bearing from the map's current bearing (via
    // getBearing) so the first heading event only rotates when it is
    // actually > 2° away, instead of snapping on the first event.
    lastCompassBearingRef.current =
      typeof map.getBearing === 'function' ? map.getBearing() : null;
    compassOnRef.current = true;
    setCompassError(null);
    setCompassOn(true);
  }, [mapReady, compassOn]);

  // While the compass lock is on, follow the device heading — throttled
  // to > 2° changes so the camera does not jitter on every sensor tick.
  // webkitCompassHeading on iOS, 360 − alpha elsewhere.
  useEffect(() => {
    if (!compassOn || !mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    // F13: if no heading event ever arrives (a device that never fires
    // deviceorientation at all), fail soft after 3 s instead of showing
    // an active lock that never rotates the map.
    let headingReceived = false;
    const noHeadingTimer = setTimeout(() => {
      if (!headingReceived) {
        compassOnRef.current = false;
        setCompassError('Compass unavailable');
        setCompassOn(false);
      }
    }, 3000);
    const onOrientation = (event: DeviceOrientationEvent) => {
      if (!compassOnRef.current) return;
      const heading =
        (event as unknown as { webkitCompassHeading?: number })
          .webkitCompassHeading ??
        (typeof event.alpha === 'number' ? 360 - event.alpha : null);
      if (heading === null || Number.isNaN(heading)) {
        clearTimeout(noHeadingTimer);
        compassOnRef.current = false;
        setCompassError('Compass unavailable');
        setCompassOn(false);
        return;
      }
      headingReceived = true;
      clearTimeout(noHeadingTimer);
      const last = lastCompassBearingRef.current;
      if (last !== null) {
        let diff = Math.abs(heading - last) % 360;
        if (diff > 180) diff = 360 - diff;
        if (diff <= 2) return;
      }
      lastCompassBearingRef.current = heading;
      map.easeTo({ bearing: heading, duration: 200 });
    };
    window.addEventListener('deviceorientation', onOrientation);
    return () => {
      window.removeEventListener('deviceorientation', onOrientation);
      clearTimeout(noHeadingTimer);
    };
  }, [compassOn, mapReady]);

  /** Tear the map down and build it again (error overlay / slow-load retry). */
  const retryMap = useCallback(() => {
    // v27 fix round (Zara Advisory 3): the guard lives HERE, not only
    // on the buttons' `disabled` attribute — the guard and the button
    // agree on one predicate (`retryDisabled`, with the deferred
    // exception from F2: while deferred the tap goes through, subject
    // to the cooldown, because it is the only manual escape from a
    // flat container). A programmatic / keyboard / double-tap call
    // while a load is in flight is a no-op instead of aborting the
    // creation that is already running.
    // v30: a slow load (12 s watchdog fired) may be retried too — the
    // loading block lifts then (see `retryDisabled`); a stalled style
    // load otherwise leaves the user with no recovery but reopening
    // the PWA.
    if (retryDisabled(mapState, Date.now(), lastRetryAtMs, isDeferred, slowLoad)) return;
    // v27 fix round (Diya Advisory 3): NO re-measure first — the old
    // `checkMapAreaHeight()` call here was dead code: the lines below
    // immediately wiped everything it set (`setAreaDiagnosis(null)`,
    // `setZeroWidth(false)`, `setMapDetail('retrying…')`). The real
    // re-measure is the creation effect's build gate, which re-runs
    // on the retryNonce bump below and measures the LIVE diagnosis
    // before deciding build vs defer — so a Retry can never again
    // rebuild into the same flat area blind. A manual Retry also
    // re-arms the one auto canvas rebuild.
    autoCanvasRecreateRef.current = false;
    setMapError(null);
    setMapDetail('retrying…');
    setSlowLoad(false);
    setMapReady(false);
    setMapState('loading');
    // A retry starts with a clean diagnostic slate (a fresh map, fresh
    // tile requests); startCreation resets it again as well.
    setTileLedger(EMPTY_TILE_LEDGER);
    setOtherResource(null);
    setFitReason(null);
    setFitLanded(false);
    // v28: the ◎ failure state clears on Retry too.
    setRecentreFailed(false);
    setRecentreNote(null);
    setRecentreFallback(null);
    setAreaDiagnosis(null);
    setZeroWidth(false);
    // v27: a manual Retry re-arms the canvas repair ladder's one
    // re-resize too (canvasResizesTriedRef), as well as the one auto
    // rebuild (autoCanvasRecreateRef, reset above).
    canvasResizesTriedRef.current = 0;
    // v26 fix round (Diya 2 — B2): a manual Retry starts with a FRESH
    // fit-retry budget (startCreation resets it again as well — both
    // places, so a Retry can never inherit a spent budget from the
    // map it replaces).
    resetFitRetryBudget(fitRetryBudgetRef.current);
    fitRetryBoundaryRef.current = null;
    fitLandedSizeRef.current = null;
    refitAtSizeRef.current = null;
    setLastRetryAtMs(Date.now());
    setRetryNonce((n) => n + 1);
  }, [mapState, lastRetryAtMs, isDeferred, slowLoad]);

  // No early returns: the map container below stays mounted in EVERY
  // state (no-key / unavailable / error included). The v13 error path
  // already did this; the no-key and unavailable branches used to
  // return a banner WITHOUT the container, so containerRef was null
  // and no Retry could ever re-create the map from those states.
  // Failure UI is an overlay on top of the live container instead.
  // One-line on-screen diagnostic, derived from the exact state.
  // v25: the real post-load tile-error count + first detail are passed
  // in, so the pill can never claim "Map ready" while tiles are failing.
  // Fix round: the fit failure (Diya F1/F2), the 0-height area (F3)
  // and the honest non-tile resource label (F4) are passed in too —
  // the ready pill must not claim "Map ready" while any of them holds.
  // v26: `fitFailed` is derived from the fit's OWN reason (null = no
  // real failure), and a fit that has not landed yet is PENDING, not
  // failed — the pill says so honestly instead of "fit failed — ready".
  // v27: zeroHeight / zeroWidth are derived from the LIVE diagnosis
  // (`areaDiagnosis`), which is also the pill's 13th argument — so
  // the pill names the element exactly (container vs canvas).
  const fitFailed = fitReason !== null;
  const fitPending =
    mapState === 'ready' && !fitFailed && !fitLanded && zoneBoundary.length >= 3;
  const zeroHeight =
    areaDiagnosis === 'container-zero-height' || areaDiagnosis === 'canvas-zero-height';
  const elapsedS =
    nowMs !== undefined && attemptStartedAtRef.current > 0
      ? Math.max(0, Math.floor((nowMs - attemptStartedAtRef.current) / 1000))
      : null;
  const pillText = pillTextForState(
    mapState,
    mapDetail,
    slowLoad,
    elapsedS,
    tileLedger.count,
    tileLedger.details[0] ?? null,
    fitFailed,
    zeroHeight,
    otherResource,
    fitReason,
    fitPending,
    zeroWidth,
    areaDiagnosis,
    // v28 (Zara A1): a failed ◎ tap is its own honest pill part —
    // never a "resource failure", never raw error text.
    recentreFailed,
    // v29 (E): a lost WebGL context is never "Map ready".
    contextLost,
  );
  // Zara 4: both Retry buttons stay disabled while a load is in flight
  // and for 2 s after a tap — spamming Retry aborts creation and can
  // 429 the shared Ola key for everyone. v27 fix round (Diya AT RISK
  // 2): while the build is DEFERRED the loading block does NOT apply
  // — the map is not loading, nothing is in flight to abort, and
  // Retry is the only manual escape from a flat container. The
  // cooldown still applies while deferred. v30: a SLOW load (12 s
  // watchdog fired) lifts the loading block the same way — a stalled
  // style load is otherwise unrecoverable without reopening the PWA.
  const retryIsDisabled = retryDisabled(
    mapState,
    nowMs ?? Date.now(),
    lastRetryAtMs,
    isDeferred,
    slowLoad,
  );

  return (
    <div ref={outerRef} className="relative h-full min-h-[320px] w-full overflow-hidden rounded-2xl border border-[#26262B] bg-[#141416]">
      {/* v27 ROOT CAUSE FIX: this container MUST have height even
          though `new Map` adds MapLibre's unlayered
          `.maplibregl-map{position:relative}` to it, which beats
          Tailwind's layered `.absolute` (unlayered author CSS beats
          ANY layered rule) — the old `absolute inset-0` alone
          collapsed to 526.4×0, and the container's inherited
          `overflow:hidden` then clipped the canvas to nothing. So the
          size does NOT depend on `position:absolute` any more:
          `h-full w-full` sizes it as a block too (100% of the 420 px
          outer, whichever position wins). The setup map never had
          this bug — its container carries an explicit inline height. */}
      <div ref={containerRef} className="absolute inset-0 h-full w-full" aria-label="Play map" />
      {/* v30 follow-up (Diya review, item C): the no-fix re-centre
          fallback is a LOUD pill, top-left, amber, role=status — not
          the old 88 px footnote under the buttons. The map moving to
          the zone centre must never read as a working ◎ tap on a dead
          watcher. Cleared by a fresh fix, a fix-centred tap, Retry,
          or a failed tap (see centreOn / the effects above). */}
      {recentreFallback ? (
        <p
          role="status"
          className="absolute left-3 top-3 z-10 max-w-[calc(100%-6.5rem)] rounded-full border border-[#F59E0B] bg-[#141416] px-3 py-1.5 text-[13px] font-bold text-[#FBBF24]"
        >
          {recentreFallback === 'zone' ? RECENTRE_NO_FIX_ZONE_PILL : RECENTRE_NO_FIX_DEFAULT_PILL}
        </p>
      ) : null}
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-2">
        <button
          type="button"
          aria-label="North up — reset bearing and re-centre the map"
          onClick={resetNorth}
          // v28 (Diya F1): ◎ and N were tappable while the map was
          // still loading (mapRef is set before 'load'), so a tap
          // eased an unloaded map with no feedback. Disabled until
          // ready, like the compass button below.
          disabled={!mapReady}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-[#26262B] bg-[#141416]/90 text-[15px] font-bold text-white disabled:opacity-40"
        >
          N
        </button>
        <button
          type="button"
          aria-label="Re-centre on me"
          onClick={recentre}
          disabled={!mapReady}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-[#26262B] bg-[#141416]/90 text-[18px] text-white disabled:opacity-40"
        >
          ◎
        </button>
        <button
          type="button"
          aria-label="Compass lock — rotate the map with your heading"
          aria-pressed={compassOn}
          disabled={!mapReady || compassPending}
          onClick={() => void toggleCompass()}
          className={`flex h-11 w-11 items-center justify-center rounded-full border border-[#26262B] text-white disabled:opacity-40 ${
            compassOn ? 'bg-[#EF4444]/90' : 'bg-[#141416]/90'
          }`}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
            <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 4 L12 11 L10 9.5 L8 11 Z" fill="currentColor" />
          </svg>
        </button>
        {compassError ? (
          <p className="max-w-[88px] rounded-full border border-[#26262B] bg-[#141416]/90 px-2 py-1 text-center text-[11px] font-semibold text-white">
            {compassError}
          </p>
        ) : null}
        {recentreNote ? (
          <p className="max-w-[88px] rounded-full border border-[#26262B] bg-[#141416]/90 px-2 py-1 text-center text-[11px] font-semibold text-white">
            {recentreNote}
          </p>
        ) : null}
      </div>
      {mapState === 'error' || mapState === 'no-key' || mapState === 'unavailable' ? (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl bg-[#141416]/95 px-4 text-center">
          <p className="text-[15px] font-bold text-white">
            {mapState === 'no-key'
              ? 'Map needs an Ola key'
              : mapState === 'unavailable'
                ? 'Map unavailable'
                : 'Map load failed'}
          </p>
          <p className="text-[14px] text-[#A1A1AA]">
            {mapError ?? 'Map unavailable — the game still works without it.'}
          </p>
          <button
            type="button"
            onClick={retryMap}
            disabled={retryIsDisabled}
            className="mt-1 rounded-full bg-white px-4 py-2 text-[14px] font-bold text-black disabled:opacity-40"
          >
            Retry map
          </button>
        </div>
      ) : null}
      {/* Always-on diagnostic: the exact map state (and the real
          failure detail, never a generic message) is on screen in
          every state, with a Retry button whenever the map is not
          ready — so a future failure can be reported verbatim.
          v25: Retry is also offered while post-load tile errors are
          recorded, even though the map counts as 'ready' — that is
          the state the founder was stuck in (pill "Map ready", blank
          canvas, no Retry). Fix round: Retry is offered for a failed
          fit, a 0-height area and a non-tile resource failure too,
          and both Retry buttons are disabled while loading / cooling
          down (Zara 4). v26 fix round (Diya 1 — B1): Retry is offered
          while the fit is merely PENDING too — a user stuck on
          "Camera moving to the zone…" for 6 s can Retry immediately
          (a manual Retry resets the fit budget — B2 — so it can
          actually help) instead of waiting for the budget-spent
          escalation. (Diya 6: a 0-width area offers Retry too.)
          D9b: the pill text wraps to two lines (line-clamp-2) instead
          of truncating — a combined failure on a narrow phone stays
          readable. */}
      <div className="absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-6.5rem)] items-center gap-2 rounded-full border border-[#26262B] bg-[#141416]/90 py-1.5 pl-3 pr-1.5">
        <p className="line-clamp-2 min-w-0 break-words text-[12px] font-semibold leading-snug text-white">{pillText}</p>
        {mapState !== 'ready' || tileLedger.count > 0 || fitFailed || fitPending || zeroHeight || zeroWidth || otherResource !== null ? (
          <button
            type="button"
            onClick={retryMap}
            disabled={retryIsDisabled}
            className="shrink-0 rounded-full bg-white px-2.5 py-1 text-[12px] font-bold text-black disabled:opacity-40"
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
});
