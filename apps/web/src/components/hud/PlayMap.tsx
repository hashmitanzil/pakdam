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
 * No map-style switcher, no layers button: single dark style only.
 * When the Ola key is missing, or `maplibre-gl` is not installed yet, the
 * map is not constructed at all and a one-line banner says so — never a
 * blank canvas. The game stays playable without the map.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
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

export function PlayMap({ zoneBoundary, nextZoneBoundary, nextZoneFiresAtMs, pings, noGoAreas, myFix, teammateFixes, reveals = [], nowMs }: PlayMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMapLike | null>(null);
  const [mapState, setMapState] = useState<MapState>('loading');
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  // The zone is fitted once, on first load with a valid boundary — free
  // panning is never fought afterwards.
  const fittedRef = useRef(false);
  const loadedRef = useRef(false);

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;
    if (!isOlaConfigured()) {
      setMapState('no-key');
      return;
    }
    let cancelled = false;
    const loadTimer = setTimeout(() => {
      if (!cancelled && !loadedRef.current) {
        setMapError('Map is taking too long to load — check your connection, then reopen this screen.');
        setMapState('error');
      }
    }, 12_000);
    createOlaMap({ container })
      .then((map) => {
        if (cancelled) return;
        if (!map) {
          setMapState('no-key');
          return;
        }
        mapRef.current = map;
        map.on('load', () => {
          if (cancelled) return;
          clearTimeout(loadTimer);
          loadedRef.current = true;
          setMapReady(true);
          // 'ready' only AFTER the style loads — never before.
          setMapState('ready');
          map.resize();
        });
        map.on('error', (event: unknown) => {
          if (cancelled) return;
          // A tile failing AFTER the style loaded is not a dead map —
          // keep it up (tiles retry). Only a pre-load failure replaces
          // the map, and then the banner carries the real cause (status
          // + message, key stripped) so it can be reported, not guessed.
          if (loadedRef.current) return;
          clearTimeout(loadTimer);
          const detail = mapErrorDetail(event);
          setMapError(
            `Map couldn't load — check your connection and that the Ola Maps key is set and this domain is whitelisted, then reopen this screen.${detail ? ` (${detail})` : ''}`,
          );
          setMapState('error');
        });
      })
      .catch(() => {
        if (!cancelled) setMapState('unavailable');
      });
    return () => {
      cancelled = true;
      clearTimeout(loadTimer);
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // The map is created once for the life of the screen.
  }, []);

  // Resize after the container changes size (a hidden-then-shown canvas stays blank otherwise).
  useEffect(() => {
    const container = containerRef.current;
    const map = mapRef.current;
    if (!container || !map) return;
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [mapReady]);

  // Sync overlays whenever the data changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    ensureSource(map, 'pakdam-zone');
    ensureLayer(map, {
      id: 'pakdam-zone-fill',
      type: 'fill',
      source: 'pakdam-zone',
      paint: { 'fill-color': ZONE_FILL_COLOR },
    });
    ensureLayer(map, {
      id: 'pakdam-zone-line',
      type: 'line',
      source: 'pakdam-zone',
      paint: { 'line-color': ZONE_LINE_COLOR, 'line-width': 2 },
    });
    map.getSource('pakdam-zone')?.setData(
      collection(zoneBoundary.length >= 3 ? [polygonFeature(zoneBoundary)] : []),
    );

    ensureSource(map, 'pakdam-next-zone');
    ensureLayer(map, {
      id: 'pakdam-next-zone-line',
      type: 'line',
      source: 'pakdam-next-zone',
      paint: { 'line-color': ZONE_LINE_COLOR, 'line-width': 2, 'line-dasharray': [2, 2] },
    });
    map.getSource('pakdam-next-zone')?.setData(
      collection(
        nextZoneBoundary && nextZoneBoundary.length >= 3
          ? [polygonFeature(nextZoneBoundary)]
          : [],
      ),
    );

    ensureSource(map, 'pakdam-pings');
    ensureLayer(map, {
      id: 'pakdam-pings-fill',
      type: 'fill',
      source: 'pakdam-pings',
      paint: { 'fill-color': PING_FILL_COLOR },
    });
    const pingFeatures = pings.flatMap((ping) => {
      const u = ping.uncertainty;
      if (!('centre' in u)) return [];
      return [polygonFeature(circlePolygon(u.centre, u.radiusMeters, 64))];
    });
    map.getSource('pakdam-pings')?.setData(collection(pingFeatures));

    ensureSource(map, 'pakdam-no-go');
    ensureLayer(map, {
      id: 'pakdam-no-go-fill',
      type: 'fill',
      source: 'pakdam-no-go',
      paint: { 'fill-color': NO_GO_FILL_COLOR },
    });
    map.getSource('pakdam-no-go')?.setData(
      collection(noGoAreas.filter((a) => a.length >= 3).map((a) => polygonFeature(a))),
    );

    ensureSource(map, 'pakdam-me');
    ensureLayer(map, {
      id: 'pakdam-me-dot',
      type: 'circle',
      source: 'pakdam-me',
      paint: {
        'circle-color': '#EF4444',
        'circle-radius': 8,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#FFFFFF',
      },
    });
    map.getSource('pakdam-me')?.setData(
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

    // Teammates' live positions (green dots, same size/stroke as the me
    // dot). Teammates only — the caller never passes an opponent here,
    // and a spectator passes an empty map, so no live dots render then.
    ensureSource(map, 'pakdam-teammates');
    ensureLayer(map, {
      id: 'pakdam-teammate-dot',
      type: 'circle',
      source: 'pakdam-teammates',
      paint: {
        'circle-color': '#22C55E',
        'circle-radius': 8,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#FFFFFF',
      },
    });
    map.getSource('pakdam-teammates')?.setData(
      collection(
        Object.values(teammateFixes).map((fix) => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [fix.lng, fix.lat] },
        })),
      ),
    );

    // Hold-to-reveal markers (amber circles): a player shared their
    // position with everyone. Expired reveals never render.
    ensureSource(map, 'pakdam-reveals');
    ensureLayer(map, {
      id: 'pakdam-reveals-fill',
      type: 'fill',
      source: 'pakdam-reveals',
      paint: { 'fill-color': 'rgba(245, 158, 11, 0.18)' },
    });
    ensureLayer(map, {
      id: 'pakdam-reveals-line',
      type: 'line',
      source: 'pakdam-reveals',
      paint: { 'line-color': '#F59E0B', 'line-width': 2, 'line-dasharray': [4, 3] },
    });
    const liveReveals = reveals.filter(
      (r) => nowMs === undefined || r.expiresAtMs > nowMs,
    );
    map.getSource('pakdam-reveals')?.setData(
      collection(
        liveReveals.map((r) =>
          polygonFeature(circlePolygon(r.centre, Math.max(1, r.radiusMeters), 64), {
            playerId: r.playerId,
            displayName: r.displayName,
          }),
        ),
      ),
    );

    // First load with a valid zone: fit the whole zone in view (never
    // the hardcoded Ranchi default). Later boundary changes (shrinks)
    // never re-fit — free panning is not fought.
    if (!fittedRef.current && zoneBoundary.length >= 3) {
      fittedRef.current = true;
      map.fitBounds(boundaryBBox(zoneBoundary), { padding: 40, duration: 0 });
    }
  }, [mapReady, zoneBoundary, nextZoneBoundary, pings, noGoAreas, myFix, teammateFixes, reveals, nowMs]);

  const centreOn = (bearing?: number) => {
    const map = mapRef.current;
    if (!map) return;
    const centre =
      myFix !== null
        ? { lng: myFix.lng, lat: myFix.lat }
        : zoneBoundary.length >= 3
          ? polygonCentroid(zoneBoundary)
          : { lng: OLA_MAP_INITIAL_CENTRE[0], lat: OLA_MAP_INITIAL_CENTRE[1] };
    map.easeTo({ center: [centre.lng, centre.lat], bearing, duration: 300 });
  };

  /** Re-centre only — the ◎ button. */
  const recentre = () => centreOn();
  /** North-up + re-centre — the N button is NOT a duplicate of re-centre. */
  const resetNorth = () => centreOn(0);

  if (mapState === 'no-key') {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-[#26262B] bg-[#141416] px-4 text-center">
        <p className="text-[14px] text-[#A1A1AA]">
          Map needs an Ola key — the game still works without it.
        </p>
      </div>
    );
  }
  if (mapState === 'unavailable') {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-[#26262B] bg-[#141416] px-4 text-center">
        <p className="text-[14px] text-[#A1A1AA]">
          Map unavailable — the game still works without it.
        </p>
      </div>
    );
  }
  if (mapState === 'error') {
    return (
      <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 rounded-2xl border border-[#26262B] bg-[#141416] px-4 text-center">
        <p className="text-[15px] font-bold text-white">Map load failed</p>
        <p className="text-[14px] text-[#A1A1AA]">{mapError ?? 'Map unavailable — the game still works without it.'}</p>
      </div>
    );
  }

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
    </div>
  );
}
