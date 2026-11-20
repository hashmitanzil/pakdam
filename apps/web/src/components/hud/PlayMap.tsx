/**
 * PlayMap — the play map (SCRAM-SPEC §8c).
 *
 * Ola dark tiles via the WEB-CORE map helper (`createOlaMap`), with
 * GeoJSON overlays: red zone ring + fill, dashed next-zone ring (only when
 * a preview boundary is supplied — the next zone is never invented) + a
 * "Next zone in MM:SS" label, ping areas as 150 m circles, no-go areas,
 * my own position dot, and incoming hold-to-reveal markers (amber).
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
 * so a late load could never paint again). The ResizeObserver is
 * attached from birth, not only after 'ready', so a canvas created
 * while its container was zero-height is resized as soon as it gains size.
 *
 * ROOT CAUSE (after v13 — the map still did not load on a real phone):
 * v13 fixed the watchdog kill and the size, but `createOlaMap` could
 * still (a) HANG forever — the style-JSON pre-fetch had no timeout,
 * so a stalled fetch on flaky mobile data left the map in 'loading'
 * with no error event and no way back — and (b) REJECT (the lazy
 * `maplibre-gl` chunk failing to download, or `new Map` throwing
 * 'Failed to initialize WebGL'), which landed in a dead-end
 * 'unavailable' banner: generic text, no error detail, no Retry, and
 * the container unmounted so no retry could ever work. Both are fixed
 * here and in maplibre.ts (bounded pre-fetch 8 s / import 30 s, abort
 * signal so a cancelled attempt never orphans a live Map, rejections
 * surface their real message), the container stays mounted in EVERY
 * state, and a one-line diagnostic — exact state + real detail +
 * Retry — is always on screen, so a future failure can be reported
 * verbatim instead of guessed at.
 *
 * No map-style switcher, no layers button: single dark style only.
 * When the Ola key is missing, or `maplibre-gl` is not installed yet, the
 * map is not constructed at all and a one-line banner says so — never a
 * blank canvas. The game stays playable without the map.
 */
'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoPolygon, LocationFix, Ping } from '@pakdam/shared';
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
import { formatCountdown } from '@/lib/utils';

/** One incoming hold-to-reveal: a player shared their position. */
export interface RevealMarker {
  playerId: string;
  displayName: string;
  centre: { lat: number; lng: number };
  radiusMeters: number;
  expiresAtMs: number;
}

export interface PlayMapProps {
  zoneBoundary: GeoPolygon;
  /** Next-zone preview boundary — only during the shrink preview; never guessed. */
  nextZoneBoundary?: GeoPolygon | null;
  /** When the previewed zone fires (ms epoch) — drives the "Next zone in" label. */
  nextZoneFiresAtMs?: number | null;
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
  /** Incoming hold-to-reveal markers (expired ones are not rendered). */
  reveals?: RevealMarker[];
  /** Clock (ms epoch) — expiry filtering + the next-zone countdown. */
  nowMs?: number;
  /**
   * Bumped by the caller when something covering the map goes away
   * (the role-reveal overlay dismissing) — forces a resize so a
   * canvas measured while covered can never stay blank.
   */
  resizeNonce?: number;
}

type MapState = 'loading' | 'ready' | 'no-key' | 'unavailable' | 'error';

/**
 * Short, safe detail from a MapLibre error event (status + message).
 * The message can contain the request URL — including the Ola api_key
 * as a query parameter — so any `api_key=…` value is stripped before
 * the text is ever shown. Returns null when there is nothing useful.
 */
function mapErrorDetail(event: unknown): string | null {
  const err = (event as { error?: { message?: string; status?: number | string } })
    ?.error;
  if (!err) return null;
  const status = err.status !== undefined ? String(err.status) : '';
  const raw = (err.message ?? '')
    .replace(/api_key=[^&\s"']*/gi, 'api_key=…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const parts = [status ? `HTTP ${status}` : '', raw].filter(Boolean);
  return parts.length > 0 ? parts.join(' — ') : null;
}

/**
 * Short, safe detail from a thrown / rejected value — the lazy
 * `maplibre-gl` chunk failing to download, `new Map` throwing
 * 'Failed to initialize WebGL', the import timeout. Same api_key
 * stripping + truncation as mapErrorDetail, so the real cause can be
 * shown on screen verbatim instead of a generic "unavailable".
 */
function unknownErrorDetail(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
  return (
    raw
      .replace(/api_key=[^&\s"']*/gi, 'api_key=…')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || 'unknown error'
  );
}

/** [[minLng, minLat], [maxLng, maxLat]] of a boundary, for fitBounds. */
function boundaryBBox(polygon: GeoPolygon): [[number, number], [number, number]] {
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

function ring(polygon: GeoPolygon): number[][][] {
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

function polygonFeature(
  polygon: GeoPolygon,
  properties: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Polygon', coordinates: ring(polygon) },
  };
}

function collection(features: Record<string, unknown>[]): Record<string, unknown> {
  return { type: 'FeatureCollection', features };
}

function ensureSource(map: MapLibreMapLike, id: string): void {
  if (!map.getSource(id)) {
    map.addSource(id, { type: 'geojson', data: collection([]) });
  }
}

function ensureLayer(map: MapLibreMapLike, layer: Record<string, unknown>): void {
  if (!map.getLayer(layer['id'] as string)) {
    map.addLayer(layer);
  }
}

/**
 * One overlay source, synced: create the source + layers once, then push
 * the data. Callers run this from a per-source effect, so only the source
 * whose input changed ever re-parses GeoJSON.
 */
function syncSource(
  map: MapLibreMapLike,
  id: string,
  layers: Record<string, unknown>[],
  data: Record<string, unknown>,
): void {
  ensureSource(map, id);
  for (const layer of layers) ensureLayer(map, layer);
  map.getSource(id)?.setData(data);
}

/** Memoized: the parent re-renders every second on its clock tick, and
 *  most of those renders change no map prop — skip them. */
export const PlayMap = memo(function PlayMap({ zoneBoundary, nextZoneBoundary, nextZoneFiresAtMs, pings, noGoAreas, myFix, teammateFixes, reveals = [], nowMs, resizeNonce = 0 }: PlayMapProps) {
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
  // Creation attempt counter + attempt start (elapsed seconds in the pill).
  const attemptRef = useRef(0);
  const attemptStartedAtRef = useRef(0);
  // The zone is fitted once, on first load with a valid boundary — free
  // panning is never fought afterwards.
  const fittedRef = useRef(false);
  const loadedRef = useRef(false);

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
    loadedRef.current = false;
    fittedRef.current = false;
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    attemptStartedAtRef.current = Date.now();
    setMapDetail(`creating map… (attempt ${attempt})`);
    let cancelled = false;
    // Aborted on unmount / retry while creation is still in flight —
    // createOlaMap then never constructs, so a cancelled attempt can
    // never orphan a live Map (and its WebGL context) in a detached
    // container. v13 fixed the detached-node symptom for the watchdog
    // path; this closes the same hole for every cancellation.
    const abort = new AbortController();
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
    const loadTimer = setTimeout(() => {
      if (!cancelled && !loadedRef.current) setSlowLoad(true);
    }, 12_000);
    let observer: ResizeObserver | null = null;
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
        // Resize whenever the container gains size — attached from
        // birth, not only after 'ready': a canvas created while its
        // container was zero-height stays blank until resize() runs,
        // and ResizeObserver fires an initial notification on observe.
        observer = new ResizeObserver(() => map.resize());
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
          map.resize();
        });
        map.on('error', (event: unknown) => {
          if (cancelled) return;
          // A tile failing AFTER the style loaded is not a dead map —
          // keep it up (tiles retry). A pre-load failure shows the
          // overlay with the real cause (status + message, key
          // stripped) and a Retry button — the map container stays
          // mounted, so a late 'load' can still paint into it.
          if (loadedRef.current) return;
          clearTimeout(loadTimer);
          setSlowLoad(false);
          const detail = mapErrorDetail(event);
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
    return () => {
      cancelled = true;
      abort.abort();
      clearTimeout(loadTimer);
      observer?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Re-created only when the user taps Retry.
  }, [retryNonce]);

  // The role-reveal overlay covers the map at game start. Dismissing it
  // does not change the container's size, so no ResizeObserver fires —
  // the caller bumps `resizeNonce` on dismiss and the map is resized
  // explicitly, so a canvas measured while covered can never stay blank.
  useEffect(() => {
    if (mapRef.current && mapReady) mapRef.current.resize();
  }, [resizeNonce, mapReady]);

  // Ping circles (64-pt geodesic) are built once per ping set, not once
  // per clock tick — the old single overlay effect rebuilt every circle
  // (trig per point) and re-set all 7 sources on every 1 s tick, every
  // GPS fix, and every snapshot, even when only one thing had changed.
  const pingFeatures = useMemo(
    () =>
      pings.flatMap((ping) => {
        const u = ping.uncertainty;
        if (!('centre' in u)) return [];
        return [polygonFeature(circlePolygon(u.centre, u.radiusMeters, 64))];
      }),
    [pings],
  );
  // Live reveals only — expiry filtering is the one thing the 1 s clock
  // drives here, so it lives in its own memo, not in the overlay effects.
  const liveReveals = useMemo(
    () => reveals.filter((r) => nowMs === undefined || r.expiresAtMs > nowMs),
    [reveals, nowMs],
  );
  const revealFeatures = useMemo(
    () =>
      liveReveals.map((r) =>
        polygonFeature(circlePolygon(r.centre, Math.max(1, r.radiusMeters), 64), {
          playerId: r.playerId,
          displayName: r.displayName,
        }),
      ),
    [liveReveals],
  );

  // One effect per overlay source: a clock tick only re-runs the reveals
  // effect, a GPS fix only the me-dot effect, a new ping only the pings
  // effect, a snapshot only the sources it actually replaced — never a
  // full rebuild of all 7 sources.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    syncSource(
      map,
      'pakdam-zone',
      [
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
      ],
      collection(zoneBoundary.length >= 3 ? [polygonFeature(zoneBoundary)] : []),
    );
    // First load with a valid zone: fit the whole zone in view (never
    // the hardcoded Ranchi default). Later boundary changes (shrinks)
    // never re-fit — free panning is not fought.
    if (!fittedRef.current && zoneBoundary.length >= 3) {
      fittedRef.current = true;
      map.fitBounds(boundaryBBox(zoneBoundary), { padding: 40, duration: 0 });
    }
  }, [mapReady, zoneBoundary]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    syncSource(
      map,
      'pakdam-next-zone',
      [
        {
          id: 'pakdam-next-zone-line',
          type: 'line',
          source: 'pakdam-next-zone',
          paint: { 'line-color': ZONE_LINE_COLOR, 'line-width': 2, 'line-dasharray': [2, 2] },
        },
      ],
      collection(
        nextZoneBoundary && nextZoneBoundary.length >= 3
          ? [polygonFeature(nextZoneBoundary)]
          : [],
      ),
    );
  }, [mapReady, nextZoneBoundary]);

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
          paint: { 'fill-color': PING_FILL_COLOR },
        },
      ],
      collection(pingFeatures),
    );
  }, [mapReady, pingFeatures]);

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

  // Hold-to-reveal markers (amber circles): a player shared their
  // position with everyone. Expired reveals never render — this is the
  // only overlay the 1 s clock touches, via `liveReveals` above.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    syncSource(
      map,
      'pakdam-reveals',
      [
        {
          id: 'pakdam-reveals-fill',
          type: 'fill',
          source: 'pakdam-reveals',
          paint: { 'fill-color': 'rgba(245, 158, 11, 0.18)' },
        },
        {
          id: 'pakdam-reveals-line',
          type: 'line',
          source: 'pakdam-reveals',
          paint: { 'line-color': '#F59E0B', 'line-width': 2, 'line-dasharray': [4, 3] },
        },
      ],
      collection(revealFeatures),
    );
  }, [mapReady, revealFeatures]);

  // Stable callbacks: the buttons must not get a new handler (and the
  // parent a new render reason) on every clock tick.
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
  const resetNorth = useCallback(() => centreOn(0), [centreOn]);

  /** Tear the map down and build it again (error overlay / slow-load retry). */
  const retryMap = useCallback(() => {
    setMapError(null);
    setMapDetail('retrying…');
    setSlowLoad(false);
    setMapReady(false);
    setMapState('loading');
    setRetryNonce((n) => n + 1);
  }, []);

  // No early returns: the map container below stays mounted in EVERY
  // state (no-key / unavailable / error included). The v13 error path
  // already did this; the no-key and unavailable branches used to
  // return a banner WITHOUT the container, so containerRef was null
  // and no Retry could ever re-create the map from those states.
  // Failure UI is an overlay on top of the live container instead.
  // One-line on-screen diagnostic, derived from the exact state.
  const elapsedS =
    nowMs !== undefined && attemptStartedAtRef.current > 0
      ? Math.max(0, Math.floor((nowMs - attemptStartedAtRef.current) / 1000))
      : null;
  const pillText =
    mapState === 'ready'
      ? 'Map ready'
      : mapState === 'loading'
        ? `Map loading — ${mapDetail ?? 'creating map…'}${
            slowLoad ? ' · still trying…' : ''
          }${elapsedS !== null ? ` · ${elapsedS}s` : ''}`
        : `Map ${mapState} — ${mapDetail ?? 'failed'}`;
  const nextZoneSeconds =
    nextZoneFiresAtMs !== null &&
    nextZoneFiresAtMs !== undefined &&
    nextZoneBoundary &&
    nextZoneBoundary.length >= 3 &&
    nowMs !== undefined
      ? Math.max(0, Math.ceil((nextZoneFiresAtMs - nowMs) / 1000))
      : null;

  return (
    <div className="relative h-full min-h-[320px] w-full overflow-hidden rounded-2xl border border-[#26262B] bg-[#141416]">
      <div ref={containerRef} className="absolute inset-0" aria-label="Play map" />
      {nextZoneSeconds !== null ? (
        <div className="absolute left-3 top-3 z-10 rounded-full border border-[#26262B] bg-[#141416]/90 px-3 py-1.5 text-[13px] font-semibold text-white">
          Next zone in {formatCountdown(nextZoneSeconds)}
        </div>
      ) : null}
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
            className="mt-1 rounded-full bg-white px-4 py-2 text-[14px] font-bold text-black"
          >
            Retry map
          </button>
        </div>
      ) : null}
      {/* Always-on diagnostic: the exact map state (and the real
          failure detail, never a generic message) is on screen in
          every state, with a Retry button whenever the map is not
          ready — so a future failure can be reported verbatim. */}
      <div className="absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-6.5rem)] items-center gap-2 rounded-full border border-[#26262B] bg-[#141416]/90 py-1.5 pl-3 pr-1.5">
        <p className="min-w-0 truncate text-[12px] font-semibold text-white">{pillText}</p>
        {mapState !== 'ready' ? (
          <button
            type="button"
            onClick={retryMap}
            className="shrink-0 rounded-full bg-white px-2.5 py-1 text-[12px] font-bold text-black"
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
});
