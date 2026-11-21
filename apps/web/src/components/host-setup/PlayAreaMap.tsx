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
import { memo, useEffect, useRef, useState } from 'react';
import type { GeoPoint, GeoPolygon, ZoneShape } from '@pakdam/shared';
import { METERS_PER_DEG_LAT, metersPerDegreeLng } from '@pakdam/shared';
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
import { tryFitSetupZone } from '../hud/play-map-logic';

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
  /** Null = Auto final size (~42% of the start radius, 0.75³ after 3 shrinks). */
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

/** Minimal Marker surface used here (B16: update in place via setLngLat). */
interface MarkerLike {
  remove(): void;
  setLngLat(lngLat: [number, number]): MarkerLike;
  on(event: string, handler: () => void): MarkerLike;
  getLngLat(): { lat: number; lng: number };
}

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

/**
 * True when the map container has a real (non-zero) size — same guard
 * as PlayMap (v18 zero-size rule, A11): `resize()` is NEVER called at
 * 0-size, or the canvas can stay blank when the container gains size.
 * Latent here (the setup map is always visible in practice), added for
 * defence in depth.
 */
function containerHasSize(container: HTMLElement): boolean {
  return container.clientWidth > 0 && container.clientHeight > 0;
}

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

// NOTE (v26 fix round, A3): the local boundaryBBox helper lived here
// for the radius fit — the fit now goes through `tryFitSetupZone`
// (play-map-logic.ts), which computes the bbox itself, so the local
// copy is removed rather than left unused.

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

/** Memoized (B14): setup re-renders on every poll tick — the map only re-renders when its zone / location props change. */
export const PlayAreaMap = memo(function PlayAreaMap({
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
  // B16: markers keyed by role ('centre' + 'corner-i') and updated IN
  // PLACE with setLngLat — the old effect removed and recreated every
  // marker on each centre/draw change, which dropped an in-progress drag.
  const markersRef = useRef(new Map<string, MarkerLike>());
  const dotMarkerRef = useRef<MarkerLike | null>(null);
  const maplibreRef = useRef<typeof import('maplibre-gl') | null>(null);
  const propsRef = useRef({ centre, radiusMeters, shape, drawPoints, editable, onZoneChange });
  propsRef.current = { centre, radiusMeters, shape, drawPoints, editable, onZoneChange };
  const lastFlownRef = useRef<{ lng: number; lat: number } | null>(null);
  const lastFittedRadiusRef = useRef<number | null>(null);
  const lastLocateNonceRef = useRef(0);
  // B16: true while the user drags the map or a marker — camera moves
  // (fitBounds / flyTo) are skipped until the drag ends, so a 500 ms
  // animation never fights the user's finger.
  const draggingRef = useRef(false);
  // B22: bumped by the Retry button — re-runs map creation.
  const [retryNonce, setRetryNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);
  // Mirrors `loaded` for the once-registered map event handlers, which
  // close over the first render. A tile failing AFTER the style loaded
  // must not destroy a working map — only a pre-load failure replaces
  // the map with the banner.
  const loadedRef = useRef(false);
  const [mapReady, setMapReady] = useState(isOlaConfigured());
  // A failed style/key/network must NEVER leave a blank area: surface it
  // in the map slot with a plain-words message instead. The most common
  // cause is a wrong or unwhitelisted Ola key (tiles fail 401), which the
  // MapLibre 'error' event reports — but a hanging style request fires no
  // event at all, so a load timeout covers that case too.
  const [mapError, setMapError] = useState<string | null>(null);

  // Create the map once (B22: re-created when the user taps Retry).
  useEffect(() => {
    if (!isOlaConfigured()) return;
    let cancelled = false;
    let map: MapLibreMapLike | null = null;
    let observer: ResizeObserver | null = null;
    let waitObserver: ResizeObserver | null = null;
    // Captured for the cleanup below (the ref itself never changes
    // identity, but the rule wants the value copied into the effect).
    const markers = markersRef.current;
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
      // v26 fix round (Diya 3 — A3): NEVER construct the map in a
      // 0-size container — `new Map` there leaves a 'ready' map with
      // a stale zero-size transform, and the radius fit below would
      // silently no-op. Same zero-size wait as PlayMap: wait for the
      // container to gain size first. (The setup map is always
      // visible at fixed 280 px height in practice, so reaching zero
      // size is hard — but the invariant must hold in code.)
      if (!containerHasSize(container)) {
        await new Promise<void>((resolve) => {
          waitObserver = new ResizeObserver(() => {
            if (containerHasSize(container)) {
              waitObserver?.disconnect();
              waitObserver = null;
              resolve();
            }
          });
          waitObserver.observe(container);
        });
        if (cancelled) return;
        // The 12 s load timer above can fire while waiting for size —
        // clear a stale timeout error so it never covers a map that
        // then loads fine.
        setMapError(null);
      }
      const created = await createOlaMap({
        container,
        center: [OLA_MAP_INITIAL_CENTRE[0], OLA_MAP_INITIAL_CENTRE[1]],
      });
      // A map constructed after the screen went away must be removed —
      // otherwise it keeps its WebGL context alive in a detached
      // container, and repeated fast navigation can exhaust the
      // browser's context budget so the NEXT map fails to initialise.
      if (cancelled || !created) {
        created?.remove();
        return;
      }
      map = created;
      mapRef.current = created;
      maplibreRef.current = await import('maplibre-gl');
      // B16: resize ONLY when the container's size changes — the old
      // code called map.resize() on every centre/radius/draw change.
      // A11: never resize at zero size (same guard as PlayMap).
      observer = new ResizeObserver(() => {
        if (containerHasSize(container)) created.resize();
      });
      observer.observe(container);
      // B16: a camera move must never fight the user's drag.
      created.on('dragstart', () => {
        draggingRef.current = true;
      });
      created.on('dragend', () => {
        draggingRef.current = false;
      });
      created.on('load', () => {
        if (cancelled) return;
        clearTimeout(loadTimer);
        ensureZoneLayers(created);
        loadedRef.current = true;
        setLoaded(true);
        // A11: resize only at a real size, same guard as PlayMap.
        if (containerHasSize(container)) created.resize();
      });
      created.on('error', (event: unknown) => {
        if (cancelled) return;
        clearTimeout(loadTimer);
        // A tile/sprite/glyph failing after the style loaded is not a
        // dead map — keep the map up (tiles retry) instead of swapping
        // the whole slot for the failure banner. Only a failure before
        // the style loads replaces the map, and then the banner carries
        // the real cause (status + message, key stripped) so the exact
        // failure can be reported instead of guessed at.
        if (loadedRef.current) return;
        const detail = mapErrorDetail(event);
        setMapError(
          `Map couldn't load — check your connection and that the Ola Maps key is set and this domain is whitelisted, then reopen this screen.${detail ? ` (${detail})` : ''}`,
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
      observer?.disconnect();
      waitObserver?.disconnect();
      for (const m of markers.values()) m.remove();
      markers.clear();
      dotMarkerRef.current?.remove();
      dotMarkerRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
    // Re-created only when the user taps Retry (centre is first-paint only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

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
    // free panning is never fought. B16: skipped entirely while the user
    // is dragging (map or marker) — a 500 ms camera animation must not
    // fight the drag — and resize() is NOT called here at all: the
    // ResizeObserver on the container owns that now.
    if (draggingRef.current) return;
    if (radiusMeters !== lastFittedRadiusRef.current && boundary.length >= 3) {
      // v26 fix round (Diya 3 — A3): the UNGUARDED fitBounds that used
      // to sit here is the exact v25 bug class — a silent no-op in a
      // 0-size / exactly-80 px viewport, with lastFittedRadiusRef
      // assigned immediately after, consuming that radius's fit
      // forever. `tryFitSetupZone` fits only when the viewport can
      // actually fit the boundary (size + finite camera), and the
      // radius is consumed ONLY when the fit landed — a skipped fit
      // retries on the next radius / loaded change.
      const container = containerRef.current;
      if (
        tryFitSetupZone(
          map,
          boundary,
          container !== null && containerHasSize(container),
        )
      ) {
        lastFittedRadiusRef.current = radiusMeters;
        lastFlownRef.current = { lng: centre.lng, lat: centre.lat };
      }
    } else if (
      shouldRefly(lastFlownRef.current, { ...centre, accuracyMeters: 0 }, null)
    ) {
      lastFlownRef.current = { lng: centre.lng, lat: centre.lat };
      map.flyTo({ center: [centre.lng, centre.lat], duration: 500 });
    }
  }, [loaded, centre, radiusMeters, shape, drawPoints, finalRadiusMeters, noGoAreas]);

  // Draggable markers: numbered corners (Draw) + centre handle (both modes).
  // B16: markers are created once per key and MOVED with setLngLat on
  // every centre/draw change — the old effect removed and recreated all
  // of them on every change, which dropped an in-progress drag and
  // re-created DOM nodes the user was holding.
  useEffect(() => {
    const map = mapRef.current;
    const maplibre = maplibreRef.current;
    if (!map || !loaded || !maplibre) return;
    const markers = markersRef.current;
    if (!editable) {
      for (const m of markers.values()) m.remove();
      markers.clear();
      return;
    }
    const getMarker = (
      key: string,
      element: () => HTMLElement,
      point: GeoPoint,
      onDragEnd: (next: GeoPoint) => void,
    ): MarkerLike => {
      const existing = markers.get(key);
      if (existing) {
        existing.setLngLat([point.lng, point.lat]);
        return existing;
      }
      const el = element();
      // A click on a marker must not also count as a map tap (which
      // would place a corner / move the centre under the marker).
      el.addEventListener('click', (event) => event.stopPropagation());
      const marker = new maplibre.Marker({ element: el, draggable: true })
        .setLngLat([point.lng, point.lat])
        .addTo(map as unknown as import('maplibre-gl').Map) as unknown as MarkerLike;
      marker.on('dragstart', () => {
        draggingRef.current = true;
      });
      marker.on('dragend', () => {
        draggingRef.current = false;
        const ll = marker.getLngLat();
        onDragEnd({ lat: ll.lat, lng: ll.lng });
      });
      markers.set(key, marker);
      return marker;
    };
    // Centre handle: moves the centre (Circle) or the whole drawn shape (Draw).
    getMarker(
      'centre',
      () => {
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
        return handle;
      },
      centre,
      (next) => {
        const p = propsRef.current;
        if (p.shape === 'draw') {
          const dLatM = (next.lat - p.centre.lat) * METERS_PER_DEG_LAT;
          const dLngM =
            (next.lng - p.centre.lng) * metersPerDegreeLng(p.centre.lat);
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
      },
    );
    // Numbered corners, Draw mode only.
    if (shape === 'draw') {
      drawPoints.forEach((point, index) => {
        getMarker(
          `corner-${index}`,
          () => {
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
            return el;
          },
          point,
          (next) => {
            const p = propsRef.current;
            const nextPoints = [...p.drawPoints];
            nextPoints[index] = next;
            p.onZoneChange({
              centre: p.centre,
              radiusMeters: p.radiusMeters,
              shape: 'draw',
              drawPoints: nextPoints,
            });
          },
        );
      });
    }
    // Drop corners that no longer exist (Undo / Start again / − stepper
    // only ever remove from the end, so surviving indices keep their
    // marker — and their drag — intact).
    for (const key of [...markers.keys()]) {
      if (key === 'centre') continue;
      const index = Number(key.slice('corner-'.length));
      if (shape !== 'draw' || Number.isNaN(index) || index >= drawPoints.length) {
        markers.get(key)?.remove();
        markers.delete(key);
      }
    }
  }, [loaded, editable, shape, drawPoints, centre]);

  // Live location dot (orange, ShadowHunt style) — follows the fix, never
  // moves the camera on its own; only a target-button tap flies to it.
  // B16: the dot marker is created once and MOVED with setLngLat —
  // the old effect removed and recreated it on every fix.
  useEffect(() => {
    const map = mapRef.current;
    const maplibre = maplibreRef.current;
    if (!map || !loaded || !maplibre) return;
    if (!userLocation) {
      dotMarkerRef.current?.remove();
      dotMarkerRef.current = null;
      return;
    }
    const existing = dotMarkerRef.current;
    if (existing) {
      existing.setLngLat([userLocation.lng, userLocation.lat]);
      return;
    }
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
      .addTo(map as unknown as import('maplibre-gl').Map) as unknown as MarkerLike;
    dotMarkerRef.current = marker;
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

  // B22: tear the map down and build it again — the container stays
  // mounted, so a retry can always paint into it (the old error path
  // unmounted the container, so no retry could ever work).
  const retryMap = (): void => {
    setMapError(null);
    setLoaded(false);
    loadedRef.current = false;
    setMapReady(isOlaConfigured());
    setRetryNonce((n) => n + 1);
  };

  // B22: the container stays mounted in EVERY state (no-key / error
  // included) — failure UI is an overlay on top of it, with a Retry
  // button, exactly like PlayMap. The old early returns unmounted the
  // container on error, so a late load could never paint again.
  if (!mapReady) {
    return (
      <div>
        <div className="relative">
          <div
            ref={containerRef}
            className="w-full overflow-hidden rounded-[16px] border border-[#26262B] bg-[#141416]"
            style={{ height }}
            aria-label="Play zone map"
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[16px] bg-[#141416]/95 px-4 text-center">
            <p className="text-[15px] font-bold text-white">Map needs an Ola Maps key</p>
            <p className="text-[13px] text-[#A1A1AA]">
              Map needs an Ola Maps key — set NEXT_PUBLIC_OLA_MAPS_API_KEY.
            </p>
            <button
              type="button"
              onClick={retryMap}
              className="mt-1 rounded-full bg-white px-4 py-2 text-[14px] font-bold text-black"
            >
              Retry map
            </button>
          </div>
        </div>
        <p className="mt-2 text-[13px] text-[#A1A1AA]">
          {shape === 'draw'
            ? `Tap the map to place numbered corners — 3 taps make a triangle. (${drawPoints.length} placed)`
            : 'Tap the map to move the zone centre.'}
        </p>
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
        {mapError ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[16px] bg-[#141416]/95 px-4 text-center"
            role="alert"
          >
            <p className="text-[15px] font-bold text-white">Map load failed</p>
            <p className="text-[13px] text-[#A1A1AA]">{mapError}</p>
            <button
              type="button"
              onClick={retryMap}
              className="mt-1 rounded-full bg-white px-4 py-2 text-[14px] font-bold text-black"
            >
              Retry map
            </button>
          </div>
        ) : null}
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
});
