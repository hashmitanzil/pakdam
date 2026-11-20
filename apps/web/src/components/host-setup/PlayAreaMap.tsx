'use client';

/**
 * PlayAreaMap — Ola dark map + zone overlay + Draw interaction
 * (SCRAM-SPEC §5e–§6), ShadowHunt layout on the lobby.
 *
 * - Circle mode: tap the map to move the centre; drag the red centre
 *   handle; radius changes only via the Radius stepper below the map.
 * - Draw mode: tap the map to place numbered corner points (3 taps =
 *   triangle); corners are draggable markers; the Corners stepper,
 *   Undo and Start again live in the lobby under the map.
 * - The orange dot is the player's live location; the target button on
 *   the map's top-right re-centres on it. Zoom is pinch-only — there are
 *   no zoom buttons on the map.
 * - Radius auto-zoom: whenever the radius changes, the map zooms to fit
 *   the whole zone in view. Free panning is never fought otherwise.
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
  onZoneChange: (draft: ZoneDraft) => void;
  /** The player's live location — rendered as the orange dot. */
  userLocation?: GeoPoint | null;
  /** Bumped by the caller when the target button is tapped: fly to the dot. */
  locateNonce?: number;
  /** True while a fresh fix is being fetched for the target button. */
  locating?: boolean;
  /** Called when the target button is tapped. */
  onLocate?: () => void;
  /** Fixed map height in px (280 on the create screen). */
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
  onZoneChange,
  userLocation = null,
  locateNonce = 0,
  locating = false,
  onLocate,
  height = 280,
}: PlayAreaMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMapLike | null>(null);
  const markersRef = useRef<{ remove: () => void }[]>([]);
  const dotMarkerRef = useRef<{ remove: () => void } | null>(null);
  const maplibreRef = useRef<typeof import('maplibre-gl') | null>(null);
  const propsRef = useRef({ centre, radiusMeters, shape, drawPoints, editable, onZoneChange });
  propsRef.current = { centre, radiusMeters, shape, drawPoints, editable, onZoneChange };
  const lastFlownRef = useRef<{ lng: number; lat: number } | null>(null);
  const lastFittedRadiusRef = useRef<number | null>(null);
  const lastLocateNonceRef = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [mapReady, setMapReady] = useState(isOlaConfigured());
  // A failed style/key/network must NEVER leave a blank area: surface it
  // in the map slot with a plain-words message instead. The most common
  // cause is a wrong or unwhitelisted Ola key (tiles fail 401), which the
  // MapLibre 'error' event reports — but a hanging style request fires no
  // event at all, so a load timeout covers that case too.
  const [mapError, setMapError] = useState<string | null>(null);

  // Create the map once.
  useEffect(() => {
    if (!isOlaConfigured()) return;
    let cancelled = false;
    let map: MapLibreMapLike | null = null;
    const loadTimer = setTimeout(() => {
      if (!cancelled) {
        setMapError(
          "Map is taking too long to load — check your connection, then reopen this screen.",
        );
      }
    }, 12_000);
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
        clearTimeout(loadTimer);
        ensureZoneLayers(created);
        setLoaded(true);
        created.resize();
      });
      created.on('error', () => {
        if (cancelled) return;
        clearTimeout(loadTimer);
        setMapError(
          "Map couldn't load — check your connection and that the Ola Maps key is set and this domain is whitelisted, then reopen this screen.",
        );
      });
      created.on('click', (event: unknown) => {
        const e = event as { lngLat?: { lng: number; lat: number } };
        if (!e.lngLat) return;
        const p = propsRef.current;
        if (!p.editable) return;
        const point: GeoPoint = { lat: e.lngLat.lat, lng: e.lngLat.lng };
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
      clearTimeout(loadTimer);
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      dotMarkerRef.current?.remove();
      dotMarkerRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zone / final-ring / no-go overlays + radius auto-zoom.
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
    // Radius changed (or first load): zoom to fit the whole zone in view.
    // Otherwise re-centre only when the caller's centre moved (> 25 m) —
    // free panning is never fought.
    if (radiusMeters !== lastFittedRadiusRef.current && boundary.length >= 3) {
      map.fitBounds(boundaryBBox(boundary), { padding: 40, duration: 500 });
      lastFittedRadiusRef.current = radiusMeters;
      lastFlownRef.current = { lng: centre.lng, lat: centre.lat };
    } else if (
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

  // Live location dot (orange, ShadowHunt style) — follows the fix, never
  // moves the camera on its own; only a target-button tap flies to it.
  useEffect(() => {
    const map = mapRef.current;
    const maplibre = maplibreRef.current;
    if (!map || !loaded || !maplibre || !userLocation) {
      dotMarkerRef.current?.remove();
      dotMarkerRef.current = null;
      return;
    }
    dotMarkerRef.current?.remove();
    const el = document.createElement('div');
    el.setAttribute('aria-label', 'Your location');
    Object.assign(el.style, {
      width: '18px',
      height: '18px',
      borderRadius: '999px',
      background: '#F97316',
      border: '3px solid #fff',
      boxShadow: '0 0 0 6px rgba(249, 115, 22, 0.25)',
    });
    const marker = new maplibre.Marker({ element: el })
      .setLngLat([userLocation.lng, userLocation.lat])
      .addTo(map as unknown as import('maplibre-gl').Map);
    dotMarkerRef.current = marker;
    return () => {
      marker.remove();
      dotMarkerRef.current = null;
    };
  }, [loaded, userLocation]);

  // Target-button tap: fly to the live location dot. The nonce guard keeps
  // the continuous watch updates from re-flying the camera.
  useEffect(() => {
    if (!locateNonce || locateNonce === lastLocateNonceRef.current || !userLocation) return;
    const map = mapRef.current;
    if (!map || !loaded) return;
    lastLocateNonceRef.current = locateNonce;
    map.flyTo({ center: [userLocation.lng, userLocation.lat], duration: 500 });
  }, [locateNonce, loaded, userLocation]);

  if (!mapReady) {
    return (
      <div
        className="flex w-full items-center justify-center rounded-[16px] border border-[#26262B] bg-[#141416] px-4 text-center text-[13px] text-[#A1A1AA]"
        style={{ height }}
        role="status"
      >
        Map needs an Ola Maps key — set NEXT_PUBLIC_OLA_MAPS_API_KEY.
      </div>
    );
  }

  if (mapError) {
    return (
      <div
        className="flex w-full flex-col items-center justify-center gap-2 rounded-[16px] border border-[#26262B] bg-[#141416] px-4 text-center"
        style={{ height }}
        role="alert"
      >
        <p className="text-[15px] font-bold text-white">Map load failed</p>
        <p className="text-[13px] text-[#A1A1AA]">{mapError}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="relative">
        <div
          ref={containerRef}
          className="w-full overflow-hidden rounded-[16px] border border-[#26262B] bg-[#141416]"
          style={{ height }}
          aria-label="Play zone map"
        />
        <button
          type="button"
          onClick={() => onLocate?.()}
          disabled={!onLocate || locating}
          aria-label={locating ? 'Finding your location…' : 'Centre on my location'}
          className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full border border-[#26262B] bg-[#1E1E22] text-white shadow-lg disabled:opacity-50"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="7" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
            <line x1="12" y1="2" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="2" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="22" y2="12" />
          </svg>
        </button>
      </div>
      <p className="mt-2 text-[13px] text-[#A1A1AA]">
        {shape === 'draw'
          ? `Tap the map to place numbered corners — 3 taps make a triangle. (${drawPoints.length} placed)`
          : 'Tap the map to move the zone centre.'}
      </p>
    </div>
  );
}
