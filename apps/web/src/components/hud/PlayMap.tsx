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
 * No map-style switcher, no layers button: single dark style only.
 * When the Ola key is missing, or `maplibre-gl` is not installed yet, the
 * map is not constructed at all and a one-line banner says so — never a
 * blank canvas. The game stays playable without the map.
 */
'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoPoint, GeoPolygon, LocationFix, Ping } from '@pakdam/shared';
import { circlePolygon, polygonCentroid } from '@pakdam/engine';
import {
  NO_GO_FILL_COLOR,
  OLA_MAP_INITIAL_CENTRE,
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
  TILE_ERROR_QUIET_DECAY_MS,
  classifyMapError,
  collection,
  ensureMapLayer,
  ensureMapSource,
  handleMapTabReturn,
  mapAreaHasHeight,
  nextFitRetryDelayMs,
  pillTextForState,
  polygonFeature,
  recordTileError,
  resourceLabel,
  retryDisabled,
  rippleFrame,
  shrinkFrame,
  syncSource,
  tileLedgerStale,
  tryFitZone,
  unknownErrorDetail,
  type MapState,
  type OtherResourceProblem,
  type TileErrorLedger,
} from '@/components/hud/play-map-logic';

/** The mapDetail text recorded when the map area has no height (Diya F3). */
const ZERO_HEIGHT_DETAIL = 'map area has no height (0 px tall) — try Retry';

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMapLike | null>(null);
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
  // The first zone fit never landed (Diya F1/F2): the pill must not
  // claim "Map ready" while the camera never reached the zone.
  const [fitFailed, setFitFailed] = useState(false);
  // The map area has no height (Diya F3): the founder measured a
  // 526.4×0 rect while the pill said "Map ready".
  const [zeroHeight, setZeroHeight] = useState(false);
  // Last Retry tap (ms epoch) — both Retry buttons stay disabled while
  // loading and for RETRY_COOLDOWN_MS after a tap (Zara 4).
  const [lastRetryAtMs, setLastRetryAtMs] = useState<number | null>(null);
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
  // Fit-retry budget (Diya F1): how many automatic retries the current
  // boundary has used, and which boundary the budget belongs to (a new
  // boundary gets a fresh budget).
  const fitRetryAttemptsRef = useRef(0);
  const fitRetryBoundaryRef = useRef<GeoPolygon | null>(null);
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
  // with the pill still saying "Map ready". Only judged while the
  // container is visible (height > 0); while hidden (Radio / More tab)
  // the area is 0-height by design and the flag is left alone.
  // Restores mapDetail to 'ready' only when the height problem was the
  // detail on record — a fit-failure detail is never clobbered.
  const checkMapAreaHeight = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    if (containerRect.height <= 0) return; // hidden tab — not a defect
    const canvas = container.querySelector('canvas');
    const canvasRect = canvas ? canvas.getBoundingClientRect() : null;
    const hasHeight = mapAreaHasHeight(
      { width: containerRect.width, height: containerRect.height },
      canvasRect ? { width: canvasRect.width, height: canvasRect.height } : null,
    );
    if (!hasHeight) {
      setZeroHeight(true);
      setMapDetail(ZERO_HEIGHT_DETAIL);
    } else {
      setZeroHeight(false);
      setMapDetail((prev) => (prev === ZERO_HEIGHT_DETAIL ? 'ready' : prev));
    }
  }, []);

  // Tile-error decay (Diya F4): a transient blip must not permanently
  // brand a healthy map. 30 s after the last recorded post-load error
  // with nothing new arriving, the slate clears on its own. Any new
  // error re-runs this effect and restarts the clock; a full Retry
  // resets immediately (retryMap / startCreation).
  useEffect(() => {
    if (tileLedger.count === 0 && otherResource === null) return;
    const ledgerAtSchedule = tileLedger;
    const timer = setTimeout(() => {
      if (tileLedgerStale(ledgerAtSchedule, Date.now())) {
        setTileLedger(EMPTY_TILE_LEDGER);
        setOtherResource(null);
      }
    }, TILE_ERROR_QUIET_DECAY_MS);
    return () => clearTimeout(timer);
  }, [tileLedger, otherResource]);

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
      // A fresh attempt starts with a clean diagnostic slate.
      setTileLedger(EMPTY_TILE_LEDGER);
      setOtherResource(null);
      setFitFailed(false);
      setZeroHeight(false);
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
        mapRef.current = map;
        setMapDetail(`style loading… (attempt ${attempt})`);
        // Resize whenever the container gains size — but NEVER at
        // zero size: the tab switch to Radio / More collapses the
        // container to 0×0, and resizing the live map to 0 is what
        // used to leave it blank on return (v18 zero-size rule).
        observer = new ResizeObserver(() => {
          if (containerHasSize(container)) {
            map.resize();
            // Diya F3: a resize that lands on a 0-height canvas must
            // surface in the pill, not hide behind "Map ready".
            checkMapAreaHeight();
          }
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
    // Zero-size rule: never create the map in a 0-size container —
    // `new Map` there (and the `fitBounds` below) leaves a 'ready'
    // map painting nothing. If the container is hidden right now
    // (player on Radio / More while the map was still loading), wait
    // for it to gain size and create then.
    if (containerHasSize(container)) {
      startCreation();
    } else {
      setMapDetail('waiting for the map area to become visible…');
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
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Re-created only when the user taps Retry (checkMapAreaHeight is a
    // stable callback — listed only to satisfy exhaustive-deps).
  }, [retryNonce, checkMapAreaHeight]);

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
        handleMapTabReturn(map, zoneBoundary, fittedRef, containerHasSize(container));
        // Surface a fit that still has not landed (Diya F2) — the zone
        // effect's timer retry covers the same failure; this only makes
        // the pill honest after a tab return.
        if (!fittedRef.current && zoneBoundary.length >= 3) setFitFailed(true);
        else if (fittedRef.current) setFitFailed(false);
        // Diya F3: re-measure the area on return — a 0-height canvas
        // after a tab switch surfaces in the pill.
        checkMapAreaHeight();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [resizeNonce, mapReady, zoneBoundary, checkMapAreaHeight]);

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
    // First load with a valid zone: fit the whole zone in view (never
    // the hardcoded Ranchi default — a camera stuck there IS the break,
    // not a fallback the map "paints at"). Later boundary changes
    // (shrinks) never re-fit — free panning is not fought. Zero-size
    // rule: a fit for a 0-size viewport computes a broken camera that
    // no later resize() repairs, so when the container is hidden the
    // fit is SKIPPED (fittedRef stays false) and the resizeNonce
    // effect fits on return instead.
    //
    // THIS is the load-bearing guard against the full-page "Application
    // error" (Diya F7): a throw inside a React effect reaches the error
    // boundary, so a throwing fit must never escape this effect. The
    // rAF callbacks elsewhere cannot produce that crash — their throws
    // are uncaught window errors. tryFitZone leaves fitted false on
    // failure, the reason is kept in mapDetail, the pill names it
    // (fitFailed), and the retry below re-runs this effect on a timer.
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    if (!fittedRef.current && zoneBoundary.length >= 3) {
      const container = containerRef.current;
      // A new boundary gets a fresh retry budget — a changed boundary
      // may fit where the old one did not.
      if (fitRetryBoundaryRef.current !== zoneBoundary) {
        fitRetryBoundaryRef.current = zoneBoundary;
        fitRetryAttemptsRef.current = 0;
      }
      try {
        const outcome = tryFitZone(
          fittedRef,
          map,
          zoneBoundary,
          container !== null && containerHasSize(container),
        );
        if (outcome === 'fitted' || outcome === 'already-fitted') {
          fitRetryAttemptsRef.current = 0;
          setFitFailed(false);
          setMapDetail('ready');
        } else if (outcome === 'non-finite-bounds') {
          // Diya F2: a non-finite boundary is surfaced, not retried —
          // the same boundary would fail the same way. A new boundary
          // re-runs this effect with a fresh budget.
          setFitFailed(true);
          setMapDetail('zone boundary is not finite — camera cannot fit it');
        }
        // 'hidden' → deferred to the tab return; 'no-boundary' →
        // nothing to fit.
      } catch (err) {
        setFitFailed(true);
        setMapDetail(unknownErrorDetail(err));
        // Bounded auto-retry (Diya F1): retry on a timer WITHOUT
        // waiting for a tab switch. The nonce re-runs this effect;
        // the budget caps at MAX_FIT_RETRIES, then the pill keeps
        // naming the failure with a manual Retry.
        const delay = nextFitRetryDelayMs(fitRetryAttemptsRef.current);
        if (delay !== null) {
          fitRetryAttemptsRef.current += 1;
          retryTimer = setTimeout(() => setFitRetryNonce((n) => n + 1), delay);
        }
      }
    }
    return () => {
      cancelAnim?.();
      clearTimeout(retryTimer);
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
    const frame = () => {
      if (stopped) return;
      const now = Date.now();
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    syncSource(
      map,
      'pakdam-me',
      [
        {
          id: 'pakdam-me-dot',
          type: 'circle',
          source: 'pakdam-me',
          paint: {
            'circle-color': '#EF4444',
            'circle-radius': 8,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#FFFFFF',
          },
        },
      ],
      collection(
        myFix
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'Point', coordinates: [myFix.lng, myFix.lat] },
              },
            ]
          : [],
      ),
    );
  }, [mapReady, myFix]);

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
      const list = trailPointsRef.current.get(key) ?? [];
      const atMs = fix.timestampMs ?? now;
      const last = list[list.length - 1];
      if (last) {
        // Don't stack a duplicate point for standing still — unless
        // 3 s passed, so a stationary player still leaves a fresh dot.
        const movedDeg = Math.hypot(fix.lng - last.lng, fix.lat - last.lat);
        if (movedDeg < 0.00005 && now - last.atMs < 3000) return;
      }
      list.push({ lng: fix.lng, lat: fix.lat, atMs });
      trailPointsRef.current.set(
        key,
        list.filter((p) => p.atMs >= cutoff).slice(-200),
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
            'circle-radius': 4,
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
  const centreOn = useCallback(
    (bearing?: number) => {
      const map = mapRef.current;
      if (!map) return;
      const centre =
        myFix !== null
          ? { lng: myFix.lng, lat: myFix.lat }
          : zoneBoundary.length >= 3
            ? polygonCentroid(zoneBoundary)
            : { lng: OLA_MAP_INITIAL_CENTRE[0], lat: OLA_MAP_INITIAL_CENTRE[1] };
      map.easeTo({ center: [centre.lng, centre.lat], bearing, duration: 300 });
    },
    [myFix, zoneBoundary],
  );

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
    setMapError(null);
    setMapDetail('retrying…');
    setSlowLoad(false);
    setMapReady(false);
    setMapState('loading');
    // A retry starts with a clean diagnostic slate (a fresh map, fresh
    // tile requests); startCreation resets it again as well.
    setTileLedger(EMPTY_TILE_LEDGER);
    setOtherResource(null);
    setFitFailed(false);
    setZeroHeight(false);
    setLastRetryAtMs(Date.now());
    setRetryNonce((n) => n + 1);
  }, []);

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
  );
  // Zara 4: both Retry buttons stay disabled while a load is in flight
  // and for 2 s after a tap — spamming Retry aborts creation and can
  // 429 the shared Ola key for everyone.
  const retryIsDisabled = retryDisabled(
    mapState,
    nowMs ?? Date.now(),
    lastRetryAtMs,
  );

  return (
    <div className="relative h-full min-h-[320px] w-full overflow-hidden rounded-2xl border border-[#26262B] bg-[#141416]">
      <div ref={containerRef} className="absolute inset-0" aria-label="Play map" />
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-2">
        <button
          type="button"
          aria-label="North up — reset bearing and re-centre the map"
          onClick={resetNorth}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-[#26262B] bg-[#141416]/90 text-[15px] font-bold text-white"
        >
          N
        </button>
        <button
          type="button"
          aria-label="Re-centre on me"
          onClick={recentre}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-[#26262B] bg-[#141416]/90 text-[18px] text-white"
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
          down (Zara 4). */}
      <div className="absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-6.5rem)] items-center gap-2 rounded-full border border-[#26262B] bg-[#141416]/90 py-1.5 pl-3 pr-1.5">
        <p className="min-w-0 truncate text-[12px] font-semibold text-white">{pillText}</p>
        {mapState !== 'ready' || tileLedger.count > 0 || fitFailed || zeroHeight || otherResource !== null ? (
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
