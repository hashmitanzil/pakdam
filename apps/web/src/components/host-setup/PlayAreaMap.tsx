'use client';

/**
 * PlayAreaMap — Ola dark map + zone overlay + Draw interaction
 * (SCRAM-SPEC §5e–§6).
 *
 * - Circle mode: tap the map to move the centre; drag the red centre
 *   handle; radius changes only via the steppers (Circle untouched by
 *   tap-to-place).
 * - Draw mode: tap the map to place numbered corner points (3 taps =
 *   triangle); corners are draggable markers; Undo removes the last
 *   point, Start again clears all points.
 * - Done commits the draft — the caller applies it to the room config,
 *   which is what updates the summary strip (SCRAM's bug, where Done
 *   left the lobby summary unchanged, is not reproduced here: Done does
 *   nothing on its own, the caller writes the zone on Done).
 * - The map never auto-centres on a fix worse than ±50 m; centring is
 *   the caller's job (it passes `centre` in).
 */
import { useEffect, useRef, useState } from 'react';
import type { GeoPoint, GeoPolygon, ZoneShape } from '@pakdam/shared';
import { circlePolygon, offsetPolygon, scalePolygonTowardCentroid } from '@pakdam/engine';
import {
  createOlaMap,
  isOlaConfigured,
  NO_GO_FILL_COLOR,
  OLA_MAP_INITIAL_CENTRE,
  ZONE_FILL_COLOR,
  ZONE_LINE_COLOR,
  shouldRefly,
  type MapLibreMapLike,
} from '../map/maplibre';
import {
  autoFinalRadiusMeters,
  boundaryRadiusMeters,
  drawPointsToBoundary,
  DRAW_MAX_POINTS,
} from './drawPoints';

export interface ZoneDraft {
  centre: GeoPoint;
  radiusMeters: number;
  shape: ZoneShape;
  drawPoints: GeoPoint[];
}

export interface PlayAreaMapProps {
  centre: GeoPoint;
  radiusMeters: number;
  shape: ZoneShape;
  drawPoints: GeoPoint[];
  /** Null = Auto final size (~25% of the start radius). */
  finalRadiusMeters: number | null;
  noGoAreas: GeoPolygon[];
  /** False for guests: the map renders read-only. */
  editable?: boolean;
  /** When true, the next map tap drops a no-go circle instead of editing the zone. */
  placingNoGo?: boolean;
  onZoneChange: (draft: ZoneDraft) => void;
  onNoGoAdd?: (point: GeoPoint) => void;
  /** Shown when set; the caller applies the draft on Done. */
  onDone?: () => void;
  height?: number;
}

const ZONE_FILL_ID = 'pakdam-zone-fill';
const ZONE_LINE_ID = 'pakdam-zone-line';
const ZONE_FINAL_ID = 'pakdam-zone-final';
const NOGO_FILL_ID = 'pakdam-nogo-fill';
const NOGO_LINE_ID = 'pakdam-nogo-line';

type GeoJsonPolygon = {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: [number, number][][] };
  properties: Record<string, unknown>;
};

function toGeoJson(polygon: GeoPolygon): GeoJsonPolygon {
  const ring: [number, number][] = polygon.map((p) => [p.lng, p.lat]);
  if (ring.length > 0) ring.push(ring[0] as [number, number]);
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

function toGeoJsonCollection(polygons: GeoPolygon[]): {
  type: 'FeatureCollection';
  features: GeoJsonPolygon[];
} {
  return { type: 'FeatureCollection', features: polygons.map(toGeoJson) };
}

function ensureZoneLayers(map: MapLibreMapLike): void {
  if (!map.getLayer(ZONE_FILL_ID)) {
    map.addSource(ZONE_FILL_ID, {
      type: 'geojson',
      data: toGeoJsonCollection([]),
    });
    map.addLayer({
      id: ZONE_FILL_ID,
      type: 'fill',
      source: ZONE_FILL_ID,
      paint: { 'fill-color': ZONE_FILL_COLOR },
    });
    map.addLayer({
      id: ZONE_LINE_ID,
      type: 'line',
      source: ZONE_FILL_ID,
      paint: { 'line-color': ZONE_LINE_COLOR, 'line-width': 2 },
    });
  }
  if (!map.getLayer(ZONE_FINAL_ID)) {
    map.addSource(ZONE_FINAL_ID, {
      type: 'geojson',
      data: toGeoJsonCollection([]),
    });
    map.addLayer({
      id: ZONE_FINAL_ID,
      type: 'line',
      source: ZONE_FINAL_ID,
      paint: { 'line-color': ZONE_LINE_COLOR, 'line-width': 2, 'line-dasharray': [4, 3] },
    });
  }
  if (!map.getLayer(NOGO_FILL_ID)) {
    map.addSource(NOGO_FILL_ID, {
      type: 'geojson',
      data: toGeoJsonCollection([]),
    });
    map.addLayer({
      id: NOGO_FILL_ID,
      type: 'fill',
      source: NOGO_FILL_ID,
      paint: { 'fill-color': NO_GO_FILL_COLOR },
    });
    map.addLayer({
      id: NOGO_LINE_ID,
      type: 'line',
      source: NOGO_FILL_ID,
      paint: { 'line-color': '#B91C1C', 'line-width': 1.5 },
    });
  }
}

export function PlayAreaMap({
  centre,
  radiusMeters,
  shape,
  drawPoints,
  finalRadiusMeters,
  noGoAreas,
  editable = false,
  placingNoGo = false,
  onZoneChange,
  onNoGoAdd,
  onDone,
  height = 220,
}: PlayAreaMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMapLike | null>(null);
  const markersRef = useRef<{ remove: () => void }[]>([]);
  const maplibreRef = useRef<typeof import('maplibre-gl') | null>(null);
  const propsRef = useRef({ centre, radiusMeters, shape, drawPoints, editable, placingNoGo, onZoneChange, onNoGoAdd });
  propsRef.current = { centre, radiusMeters, shape, drawPoints, editable, placingNoGo, onZoneChange, onNoGoAdd };
  const lastFlownRef = useRef<{ lng: number; lat: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mapReady, setMapReady] = useState(isOlaConfigured());

  // Create the map once.
  useEffect(() => {
    if (!isOlaConfigured()) return;
    let cancelled = false;
    let map: MapLibreMapLike | null = null;
    void (async () => {
      const container = containerRef.current;
      if (!container) return;
      const created = await createOlaMap({
        container,
        center: [OLA_MAP_INITIAL_CENTRE[0], OLA_MAP_INITIAL_CENTRE[1]],
      });
      if (cancelled || !created) return;
      map = created;
      mapRef.current = created;
      maplibreRef.current = await import('maplibre-gl');
      created.on('load', () => {
        if (cancelled) return;
        ensureZoneLayers(created);
        setLoaded(true);
        created.resize();
      });
      created.on('click', (event: unknown) => {
        const e = event as { lngLat?: { lng: number; lat: number } };
        if (!e.lngLat) return;
        const p = propsRef.current;
        if (!p.editable) return;
        const point: GeoPoint = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        if (p.placingNoGo) {
          p.onNoGoAdd?.(point);
          return;
        }
        if (p.shape === 'draw') {
          if (p.drawPoints.length >= DRAW_MAX_POINTS) return;
          p.onZoneChange({
            centre: p.centre,
            radiusMeters: p.radiusMeters,
            shape: 'draw',
            drawPoints: [...p.drawPoints, point],
          });
        } else {
          p.onZoneChange({
            centre: point,
            radiusMeters: p.radiusMeters,
            shape: 'circle',
            drawPoints: [],
          });
        }
      });
      // First paint at the caller's centre.
      lastFlownRef.current = { lng: centre.lng, lat: centre.lat };
      created.flyTo({ center: [centre.lng, centre.lat], duration: 0 });
      setMapReady(true);
    })();
    return () => {
      cancelled = true;
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zone / final-ring / no-go overlays.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    ensureZoneLayers(map);
    const boundary =
      shape === 'draw'
        ? drawPointsToBoundary(drawPoints)
        : circlePolygon(centre, radiusMeters);
    const zoneSource = map.getSource(ZONE_FILL_ID);
    zoneSource?.setData(toGeoJsonCollection(boundary.length >= 3 ? [boundary] : []));
    const finalRadius = finalRadiusMeters ?? autoFinalRadiusMeters(radiusMeters);
    const finalBoundary =
      shape === 'draw'
        ? boundary.length >= 3
          ? scalePolygonTowardCentroid(
              boundary,
              Math.min(1, finalRadius / Math.max(1, boundaryRadiusMeters(boundary))),
            )
          : []
        : circlePolygon(centre, finalRadius);
    const finalSource = map.getSource(ZONE_FINAL_ID);
    finalSource?.setData(
      toGeoJsonCollection(finalBoundary.length >= 3 ? [finalBoundary] : []),
    );
    const nogoSource = map.getSource(NOGO_FILL_ID);
    nogoSource?.setData(toGeoJsonCollection(noGoAreas));
    // Re-centre only when the caller's centre moved (> 25 m) — free panning
    // is never fought.
    if (
      shouldRefly(lastFlownRef.current, { ...centre, accuracyMeters: 0 }, null)
    ) {
      lastFlownRef.current = { lng: centre.lng, lat: centre.lat };
      map.flyTo({ center: [centre.lng, centre.lat], duration: 500 });
    }
    map.resize();
  }, [loaded, centre, radiusMeters, shape, drawPoints, finalRadiusMeters, noGoAreas]);

  // Draggable markers: numbered corners (Draw) + centre handle (both modes).
  useEffect(() => {
    const map = mapRef.current;
    const maplibre = maplibreRef.current;
    if (!map || !loaded || !maplibre) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    if (!editable) return;
    const addMarker = (
      element: HTMLElement,
      point: GeoPoint,
      onDragEnd: (next: GeoPoint) => void,
    ): void => {
      // A click on a marker must not also count as a map tap (which
      // would place a corner / move the centre under the marker).
      element.addEventListener('click', (event) => event.stopPropagation());
      const marker = new maplibre.Marker({ element, draggable: true })
        .setLngLat([point.lng, point.lat])
        .addTo(map as unknown as import('maplibre-gl').Map);
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        onDragEnd({ lat: ll.lat, lng: ll.lng });
      });
      markersRef.current.push(marker);
    };
    // Centre handle: moves the centre (Circle) or the whole drawn shape (Draw).
    const handle = document.createElement('div');
    handle.textContent = '↔';
    handle.setAttribute('aria-label', 'Move zone');
    Object.assign(handle.style, {
      width: '28px',
      height: '28px',
      borderRadius: '999px',
      background: '#EF4444',
      color: '#fff',
      border: '2px solid #fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '14px',
      cursor: 'grab',
    });
    addMarker(handle, centre, (next) => {
      const p = propsRef.current;
      if (p.shape === 'draw') {
        const dLatM = (next.lat - p.centre.lat) * 111_320;
        const dLngM =
          (next.lng - p.centre.lng) * 111_320 * Math.cos((p.centre.lat * Math.PI) / 180);
        const moved = offsetPolygon(drawPointsToBoundary(p.drawPoints), dLngM, dLatM);
        p.onZoneChange({
          centre: next,
          radiusMeters: p.radiusMeters,
          shape: 'draw',
          drawPoints: moved,
        });
      } else {
        p.onZoneChange({
          centre: next,
          radiusMeters: p.radiusMeters,
          shape: 'circle',
          drawPoints: [],
        });
      }
    });
    // Numbered corners, Draw mode only.
    if (shape === 'draw') {
      drawPoints.forEach((point, index) => {
        const el = document.createElement('div');
        el.textContent = String(index + 1);
        el.setAttribute('aria-label', `Corner ${index + 1}`);
        Object.assign(el.style, {
          width: '26px',
          height: '26px',
          borderRadius: '999px',
          background: '#EF4444',
          color: '#fff',
          border: '2px solid #fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '13px',
          fontWeight: '700',
          cursor: 'grab',
        });
        addMarker(el, point, (next) => {
          const p = propsRef.current;
          const nextPoints = [...p.drawPoints];
          nextPoints[index] = next;
          p.onZoneChange({
            centre: p.centre,
            radiusMeters: p.radiusMeters,
            shape: 'draw',
            drawPoints: nextPoints,
          });
        });
      });
    }
    return () => {
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
    };
  }, [loaded, editable, shape, drawPoints, centre]);

  const undo = (): void => {
    if (shape !== 'draw' || drawPoints.length === 0) return;
    onZoneChange({
      centre,
      radiusMeters,
      shape: 'draw',
      drawPoints: drawPoints.slice(0, -1),
    });
  };
  const startAgain = (): void => {
    if (shape !== 'draw') return;
    onZoneChange({ centre, radiusMeters, shape: 'draw', drawPoints: [] });
  };

  if (!mapReady) {
    return (
      <div
        className="flex items-center justify-center rounded-[16px] border border-[#26262B] bg-[#141416] px-4 text-center text-[13px] text-[#A1A1AA]"
        style={{ height }}
        role="status"
      >
        Map needs an Ola Maps key — set NEXT_PUBLIC_OLA_MAPS_API_KEY.
      </div>
    );
  }

  return (
    <div>
      <div
        ref={containerRef}
        className="w-full overflow-hidden rounded-[16px] border border-[#26262B] bg-[#141416]"
        style={{ height }}
        aria-label="Play zone map"
      />
      <p className="mt-2 text-[13px] text-[#A1A1AA]">
        {placingNoGo
          ? 'Tap the map to drop a no-go circle.'
          : shape === 'draw'
            ? `Tap the map to place numbered corners — 3 taps make a triangle. (${drawPoints.length} placed)`
            : 'Tap the map to move the zone centre.'}
      </p>
      {editable ? (
        <div className="mt-1 flex items-center gap-4">
          <button
            type="button"
            onClick={undo}
            disabled={shape !== 'draw' || drawPoints.length === 0}
            className="text-[15px] font-semibold text-[#A1A1AA] disabled:opacity-40"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={startAgain}
            disabled={shape !== 'draw' || drawPoints.length === 0}
            className="text-[15px] font-semibold text-[#EF4444] disabled:opacity-40"
          >
            Start again
          </button>
          {onDone ? (
            <button
              type="button"
              onClick={onDone}
              className="ml-auto text-[15px] font-semibold text-[#EF4444]"
            >
              Done
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
