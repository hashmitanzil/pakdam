/**
 * PlayMap — the play map (SCRAM-SPEC §8c).
 *
 * Ola dark tiles via the WEB-CORE map helper (`createOlaMap`), with
 * GeoJSON overlays: red zone ring + fill, dashed next-zone ring (only when
 * a preview boundary is supplied — the next zone is never invented), ping
 * areas as 150 m circles, no-go areas, and my own position dot.
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

export interface PlayMapProps {
  zoneBoundary: GeoPolygon;
  /** Next-zone preview boundary — only during the shrink preview; never guessed. */
  nextZoneBoundary?: GeoPolygon | null;
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
}

type MapState = 'loading' | 'ready' | 'no-key' | 'unavailable';

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

export function PlayMap({ zoneBoundary, nextZoneBoundary, pings, noGoAreas, myFix, teammateFixes }: PlayMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMapLike | null>(null);
  const [mapState, setMapState] = useState<MapState>('loading');
  const [mapReady, setMapReady] = useState(false);

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;
    if (!isOlaConfigured()) {
      setMapState('no-key');
      return;
    }
    let cancelled = false;
    createOlaMap({ container })
      .then((map) => {
        if (cancelled) return;
        if (!map) {
          setMapState('no-key');
          return;
        }
        mapRef.current = map;
        map.on('load', () => {
          if (!cancelled) setMapReady(true);
        });
        setMapState('ready');
      })
      .catch(() => {
        if (!cancelled) setMapState('unavailable');
      });
    return () => {
      cancelled = true;
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
  }, [mapReady, zoneBoundary, nextZoneBoundary, pings, noGoAreas, myFix, teammateFixes]);

  const recentre = () => {
    const map = mapRef.current;
    if (!map) return;
    const centre =
      myFix !== null
        ? { lng: myFix.lng, lat: myFix.lat }
        : zoneBoundary.length >= 3
          ? polygonCentroid(zoneBoundary)
          : { lng: OLA_MAP_INITIAL_CENTRE[0], lat: OLA_MAP_INITIAL_CENTRE[1] };
    map.easeTo({ center: [centre.lng, centre.lat], duration: 300 });
  };

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

  return (
    <div className="relative h-full min-h-[320px] w-full overflow-hidden rounded-2xl border border-[#26262B] bg-[#141416]">
      <div ref={containerRef} className="absolute inset-0" aria-label="Play map" />
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-2">
        <button
          type="button"
          aria-label="North up — re-centre the map"
          onClick={recentre}
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
