'use client';
import { useEffect, useRef, useState } from 'react';
import type { GeoPolygon } from '@pakdam/shared';
import { ZONE_RADIUS_MIN_M, ZONE_RADIUS_STEP_M, ZONE_AUTO_CENTRE_MAX_ACCURACY_M } from '@pakdam/shared';
import { checkLocationPermission, coarseFixMessage, getCurrentFix, LOCATION_DENIED_HELP, locationPrecisionLabel, type ForegroundFix, type LocationProgress } from '@/lib/geolocation';
import { formatDistance, haversineMeters, polygonCentroid } from '@/components/match/freshness';
import { circlePolygon, scalePolygonTowardCentroid } from '@/components/match/ZoneEditor';
import {
  loadMapLibre, isWebGLSupported, OFFLINE_STYLE_URL,
  OFFLINE_MAP_CENTRE, OFFLINE_MAP_INITIAL_ZOOM, OFFLINE_MAP_MIN_ZOOM,
  OFFLINE_MAP_MAX_ZOOM, OFFLINE_MAP_MAX_BOUNDS,
  OUTSIDE_MAP_AREA_MESSAGE, isInsideOfflineMap,
  polygonToGeoJSON, circlePolygon as circleGeoJSON, featureCollection,
  type MapLibreLib, type MapLibreMap, type MapLibreMarker,
} from '@/components/map/maplibre';

/**
 * Play-area map (location-first host setup). A real MapLibre map on
 * the BUNDLED offline map (founder decision, 2026-11-17 19:34 IST):
 * ONE simple working map, downloaded offline and bundled in the app,
 * covering Doranda + Hinoo, Ranchi, Jharkhand, for now. NO fallback /
 * switcher / reload. The full live map service is a SEPARATE later
 * task. The editor is MapLibre — the same map as the play/result
 * maps — with the interactive editor pieces (draggable centre pin,
 * draggable corner + middle markers) built on MapLibre Markers.
 * The centre comes from the host's GPS ("Use my location"); when
 * GPS is off or denied, the host taps the map to place the zone
 * where they are standing. There is no area/place-name field: the
 * game starts from this point on the map. There is no fake centre,
 * no demo location, no demo clock or countdown anywhere in this
 * component — the zone is real or it is not set yet. On load the
 * component requests the host's real GPS location and centres there;
 * until a fix arrives it shows "Finding your location…" and the
 * zone stays un-centred — never a fallback place as the centre, and
 * no city name anywhere in the map UI.
 *
 * Two shapes (founder final take-list):
 * - Circle: a circle around the centre, sized by the radius stepper.
 * - Draw: a custom polygon. Corners are draggable markers on the map,
 *   the middle marker drags the whole zone, tapping a corner selects
 *   it and "− Remove corner" drops it (min 3 corners), Undo steps back
 *   through edits, Start again redraws a regular polygon. The polygon
 *   is stored in the room config as zone.boundary — the engine already
 *   enforces polygons (point-in-polygon), so a drawn zone is enforced
 *   exactly like a circle, including shrink phases (scaled copies).
 * Mode switch (founder decision, 2026-11-17): switching to Circle
 * CLEARS the drawn shape entirely — the form nulls drawnBoundary, and
 * this component drops the Draw-only UI state (selected corner, undo
 * history) too, so no corner marker, polygon layer or stale undo entry
 * survives into Circle mode. Returning to Draw starts clean: the form
 * generates a fresh regular polygon around the centre.
 */
const NO_GO_RADIUS_M = 25;
const STEP_DEG = 0.0005; // ~55 m per arrow press — labelled on screen
const DRAW_DEFAULT_CORNERS = 6;

/** Centre of the bundled area (Doranda) — the map starts here when
 *  no centre is set yet. There are no tiles for anywhere else, so a
 *  world view would be an empty background. */
const BBOX_CENTRE: [number, number] = OFFLINE_MAP_CENTRE;

export interface PlayAreaValue {
  centreLat: number | null;
  centreLng: number | null;
  radiusMeters: number;
  noGoAreas: GeoPolygon[];
  zoneShape: 'circle' | 'draw';
  drawnBoundary: GeoPolygon | null;
}

function polygonDiameterMeters(poly: GeoPolygon): number {
  let max = 0;
  for (let i = 0; i < poly.length; i++) {
    for (let j = i + 1; j < poly.length; j++) {
      max = Math.max(max, haversineMeters(poly[i]!.lat, poly[i]!.lng, poly[j]!.lat, poly[j]!.lng));
    }
  }
  return max;
}

function translatePolygon(poly: GeoPolygon, dLat: number, dLng: number): GeoPolygon {
  return poly.map((p) => ({ lat: p.lat + dLat, lng: p.lng + dLng }));
}

const SOURCE_IDS = {
  zone: 'pakdam-editor-zone',
  noGo: 'pakdam-editor-nogo',
  accuracy: 'pakdam-editor-accuracy',
} as const;

export default function PlayAreaMap({ value, onChange, fitSignal }: {
  value: PlayAreaValue;
  onChange: (next: PlayAreaValue) => void;
  /** Increment to refit the camera to the whole zone (radius/centre changed). */
  fitSignal: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<MapLibreLib | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const loadedRef = useRef(false);
  const styleLoadedRef = useRef(false);
  const propsRef = useRef(value);
  propsRef.current = value;
  const [locState, setLocState] = useState<'idle' | 'locating' | 'ok' | 'error'>('idle');
  const [locError, setLocError] = useState('');
  const [locAccuracy, setLocAccuracy] = useState<number | null>(null);
  /** Best accuracy seen so far while a fix is refining — shown live
   *  ("Best fix so far: ±X m — still refining…") so the host sees GPS
   *  improving instead of a static spinner. */
  const [locBest, setLocBest] = useState<number | null>(null);
  /** Current stage of the location chain ("Trying high-accuracy
   *  GPS…", "Trying standard GPS…") — shown live while locating,
   *  so the host sees which method is being tried instead of a
   *  static spinner. */
  const [locStage, setLocStage] = useState<string | null>(null);
  /** Where the zone centre came from: a real GPS fix ('gps'), or
   *  placed by hand on the map ('placed' — tap or arrow keys). The
   *  centre is NEVER presented as the user's real location unless it
   *  came from GPS: a hand-placed centre is labelled as such until a
   *  real GPS fix arrives (founder bug fix, 2026-11-17). */
  const [centreSource, setCentreSource] = useState<'gps' | 'placed' | null>(null);
  const [noGoMode, setNoGoMode] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [selectedCorner, setSelectedCorner] = useState<number | null>(null);
  const selectedCornerRef = useRef<number | null>(null);
  selectedCornerRef.current = selectedCorner;
  // Undo history for Draw edits only (circle edits are single-value
  // steppers with their own reset). Capped at 20 entries.
  const drawHistoryRef = useRef<GeoPolygon[]>([]);
  const lastDragEndRef = useRef(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  /** Key of the zone the camera was last fitted to (centre +
   *  radius + shape). The fit runs when this changes — including
   *  when the centre was already set before the map finished
   *  loading, which the old fitSignal-only effect missed (the
   *  un-centred zone: GPS landed before the map, the fit was
   *  skipped, and the zone sat off-screen). */
  const lastFittedRef = useRef<string | null>(null);

  const noGoModeRef = useRef(noGoMode);
  noGoModeRef.current = noGoMode;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const isDraw = value.zoneShape === 'draw';
  const drawn = isDraw ? value.drawnBoundary : null;

  // Mode switch to Circle: drop the Draw-only UI state (selected
  // corner, undo history) so nothing drawn can survive the switch.
  // The form already nulls drawnBoundary; the markers and polygon
  // layer are removed by the overlay sync below.
  /** Fit the camera to the whole zone (drawn polygon's own box, or
   *  the circle around the centre). Records what it fitted, so a
   *  repeat call with the same zone is a no-op — the fit never
   *  fights the host's own panning. */
  const fitToZone = (map: MapLibreMap, p: PlayAreaValue) => {
    const key = p.zoneShape === 'draw'
      ? `draw:${(p.drawnBoundary ?? []).map((c) => `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`).join('|')}`
      : `circle:${p.centreLat?.toFixed(5) ?? 'null'},${p.centreLng?.toFixed(5) ?? 'null'},${p.radiusMeters}`;
    if (lastFittedRef.current === key) return;
    lastFittedRef.current = key;
    if (p.zoneShape === 'draw' && p.drawnBoundary && p.drawnBoundary.length >= 3) {
      const lats = p.drawnBoundary.map((pt) => pt.lat);
      const lngs = p.drawnBoundary.map((pt) => pt.lng);
      map.fitBounds(
        [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 40, maxZoom: 17 },
      );
      return;
    }
    if (p.centreLat == null || p.centreLng == null) return;
    const lat = p.centreLat;
    const lng = p.centreLng;
    const r = p.radiusMeters;
    const dLat = r / 111320;
    const dLng = r / (111320 * Math.cos((lat * Math.PI) / 180));
    map.fitBounds(
      [[lng - dLng, lat - dLat], [lng + dLng, lat + dLat]],
      { padding: 40, maxZoom: 17 },
    );
  };

  /** Zoom anchor: the zone centre pin when set, else the drawn
   *  shape's middle, else the current camera centre. Zooming on
   *  the pin keeps the pin in view; zooming on the screen centre
   *  drifted it off-screen (live check 2026-11-17). */
  const zoomAnchor = (): [number, number] => {
    const p = propsRef.current;
    if (p.centreLat != null && p.centreLng != null) return [p.centreLng, p.centreLat];
    if (p.drawnBoundary && p.drawnBoundary.length >= 3) {
      const c = polygonCentroid(p.drawnBoundary);
      if (c) return [c.lng, c.lat];
    }
    const map = mapRef.current;
    if (map) {
      const c = map.getCenter();
      return [c.lng, c.lat];
    }
    return BBOX_CENTRE;
  };
  const zoomBy = (dir: 1 | -1) => {
    const map = mapRef.current;
    if (!map) return;
    const z = Math.min(OFFLINE_MAP_MAX_ZOOM, Math.max(OFFLINE_MAP_MIN_ZOOM, map.getZoom() + dir));
    map.easeTo({ center: zoomAnchor(), zoom: z, duration: 300 });
  };
  const centreOnPin = () => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ center: zoomAnchor(), zoom: Math.max(map.getZoom(), 15), duration: 300 });
  };

  useEffect(() => {
    if (value.zoneShape === 'circle') {
      setSelectedCorner(null);
      drawHistoryRef.current = [];
    }
  }, [value.zoneShape]);

  /** Commit a new drawn polygon: push the old one on the undo stack,
   *  then report the change. Radius follows the polygon's size across. */
  const commitDraw = (next: GeoPolygon | null, label: string) => {
    const cur = propsRef.current.drawnBoundary;
    if (cur) drawHistoryRef.current = [...drawHistoryRef.current.slice(-19), cur];
    const dia = next ? polygonDiameterMeters(next) : 0;
    onChangeRef.current({
      ...propsRef.current,
      drawnBoundary: next,
      // No maximum (founder decision, 2026-11-17 — unlimited past
      // 1 km): the radius follows the drawn size, uncapped.
      radiusMeters: dia > 0 ? Math.round(Math.max(ZONE_RADIUS_MIN_M, dia / 2)) : propsRef.current.radiusMeters,
    });
    setAnnounce(label);
  };

  const undoDraw = () => {
    const prev = drawHistoryRef.current[drawHistoryRef.current.length - 1];
    if (!prev) { setAnnounce('Nothing to undo.'); return; }
    drawHistoryRef.current = drawHistoryRef.current.slice(0, -1);
    setSelectedCorner(null);
    onChangeRef.current({ ...propsRef.current, drawnBoundary: prev });
    setAnnounce('Undid the last Draw change.');
  };

  const startAgainDraw = () => {
    const p = propsRef.current;
    if (p.centreLat == null || p.centreLng == null) { setAnnounce('Set the zone centre first — use your location or tap the map.'); return; }
    const corners = p.drawnBoundary?.length ?? DRAW_DEFAULT_CORNERS;
    commitDraw(circlePolygon(p.centreLat, p.centreLng, p.radiusMeters, Math.max(3, corners)), `Started again — a regular ${Math.max(3, corners)}-corner shape around the centre. Drag the corners to shape it.`);
    setSelectedCorner(null);
  };

  const ensureSourcesAndLayers = (map: MapLibreMap) => {
    const add = (id: string, sourceId: string, kind: string, paint: Record<string, unknown>) => {
      if (!map.getSource(sourceId)) map.addSource(sourceId, { type: 'geojson', data: featureCollection([]) });
      if (!map.getLayer(id)) map.addLayer({ id, type: kind, source: sourceId, paint });
    };
    // The zone ring must read as a RING at street zoom: a white
    // halo under a thick red line, over a stronger fill (live check
    // 2026-11-17: the old 3px line / 0.08 fill was barely visible).
    // Halo first so it draws beneath the red line.
    add(SOURCE_IDS.zone, SOURCE_IDS.zone, 'fill', { 'fill-color': '#B91C1C', 'fill-opacity': 0.2 });
    add(`${SOURCE_IDS.zone}-halo`, SOURCE_IDS.zone, 'line', { 'line-color': '#FFFFFF', 'line-width': 9, 'line-opacity': 0.9 });
    add(`${SOURCE_IDS.zone}-line`, SOURCE_IDS.zone, 'line', { 'line-color': '#B91C1C', 'line-width': 5, 'line-opacity': 1 });
    add(SOURCE_IDS.noGo, SOURCE_IDS.noGo, 'fill', { 'fill-color': '#7F1D1D', 'fill-opacity': 0.25 });
    add(SOURCE_IDS.accuracy, SOURCE_IDS.accuracy, 'fill', { 'fill-color': '#1D4ED8', 'fill-opacity': 0.1 });
  };

  /** Rebuild every overlay from the live value: the zone (circle or
   *  drawn polygon), no-go areas, accuracy circle, centre pin, and —
   *  Draw only — the draggable corner markers + the drag-the-middle
   *  marker. GeoJSON sources are re-set and markers rebuilt on each
   *  sync, so the map always matches the stored state exactly. */
  const syncOverlays = (map: MapLibreMap, lib: MapLibreLib, p: PlayAreaValue, accuracyM: number | null) => {
    const set = (id: string, data: Record<string, unknown>) => { map.getSource(id)?.setData(data); };
    const draw = p.zoneShape === 'draw';
    if (draw) {
      set(SOURCE_IDS.zone, p.drawnBoundary && p.drawnBoundary.length >= 3 ? polygonToGeoJSON(p.drawnBoundary) : featureCollection([]));
    } else if (p.centreLat != null && p.centreLng != null) {
      set(SOURCE_IDS.zone, circleGeoJSON(p.centreLat, p.centreLng, p.radiusMeters));
    } else {
      set(SOURCE_IDS.zone, featureCollection([]));
    }
    set(SOURCE_IDS.noGo, featureCollection((p.noGoAreas ?? []).map((poly) => polygonToGeoJSON(poly))));
    set(SOURCE_IDS.accuracy, p.centreLat != null && p.centreLng != null && accuracyM != null && accuracyM > 0
      ? circleGeoJSON(p.centreLat, p.centreLng, accuracyM) : featureCollection([]));

    // Markers are rebuilt each sync (cheap: a pin + a few corners).
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    // Circle centre pin (circle mode only) — DRAGGABLE: the host can
    // drag the pin to their exact spot even when GPS is coarse (the
    // manual fallback that makes exact placement possible). Dragging
    // marks the centre hand-placed, never a GPS fix.
    if (!draw && p.centreLat != null && p.centreLng != null) {
      const el = document.createElement('div');
      el.title = 'Zone centre pin — drag to move it to your exact spot';
      el.innerHTML = '<span style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#B91C1C;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"><span style="width:12px;height:12px;border-radius:50%;background:#fff;"></span></span>';
      const marker = new lib.Marker({ element: el, draggable: true, anchor: 'bottom' }).setLngLat([p.centreLng, p.centreLat]).addTo(map);
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        onChangeRef.current({ ...propsRef.current, centreLat: ll.lat, centreLng: ll.lng });
        setCentreSource('placed');
        setAnnounce('Centre pin dragged to your exact spot — placed by hand on the map, not a GPS fix.');
      });
      markersRef.current.push(marker);
    }
    // Draggable corner markers + the drag-the-middle marker (Draw only).
    if (draw && p.drawnBoundary && p.drawnBoundary.length >= 3) {
      const poly = p.drawnBoundary;
      poly.forEach((pt, i) => {
        const selected = selectedCornerRef.current === i;
        const el = document.createElement('div');
        // 48 px touch target (corner drag must work by touch at
        // 360 px); touch-action none so a finger drag moves the
        // corner instead of panning the map.
        el.innerHTML = `<span role="button" aria-label="Corner ${i + 1} of ${poly.length}${selected ? ' — selected' : ''}. Drag to move, tap to select." style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;border:3px solid #B91C1C;background:${selected ? '#B91C1C' : '#fff'};color:${selected ? '#fff' : '#B91C1C'};font-weight:800;font-size:15px;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,0.35);touch-action:none;">${i + 1}</span>`;
        const marker = new lib.Marker({ element: el, draggable: true }).setLngLat([pt.lng, pt.lat]).addTo(map);
        marker.on('dragend', () => {
          lastDragEndRef.current = Date.now();
          const ll = marker.getLngLat();
          const cur = propsRef.current.drawnBoundary;
          if (!cur) return;
          const next = cur.map((c, j) => (j === i ? { lat: ll.lat, lng: ll.lng } : c));
          commitDraw(next, `Corner ${i + 1} moved.`);
        });
        el.addEventListener('click', () => {
          // A click straight after a drag is the drag ending, not a tap.
          if (Date.now() - lastDragEndRef.current < 250) return;
          setSelectedCorner(i);
          setAnnounce(`Corner ${i + 1} selected — tap “− Remove corner” to drop it, or drag it to move it.`);
        });
        markersRef.current.push(marker);
      });
      // Middle marker: drag it to move the whole zone.
      const centre = polygonCentroid(poly);
      if (centre) {
        const el = document.createElement('div');
        el.innerHTML = '<span role="button" aria-label="Drag to move the whole zone." style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:10px;border:2px solid #fff;background:#B91C1C;color:#fff;font-weight:800;font-size:18px;cursor:move;box-shadow:0 1px 4px rgba(0,0,0,0.35);touch-action:none;">✥</span>';
        const marker = new lib.Marker({ element: el, draggable: true }).setLngLat([centre.lng, centre.lat]).addTo(map);
        marker.on('dragend', () => {
          const ll = marker.getLngLat();
          const cur = propsRef.current.drawnBoundary;
          const old = cur ? polygonCentroid(cur) : null;
          if (!cur || !old) return;
          commitDraw(translatePolygon(cur, ll.lat - old.lat, ll.lng - old.lng), 'Whole zone moved.');
        });
        markersRef.current.push(marker);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let lib: MapLibreLib;
      try {
        lib = await loadMapLibre();
      } catch {
        return;
      }
      if (cancelled || !ref.current) return;
      // Real WebGL probe (loadMapLibre already checks too). The old
      // `lib.supported()` call sat OUTSIDE try/catch and threw a
      // TypeError on every device — MapLibre v5 has no such export.
      // Without WebGL there is no map to draw; the zone is still
      // settable from the steppers below.
      if (!isWebGLSupported()) { return; }
      libRef.current = lib;
      const centre: [number, number] = value.centreLat != null && value.centreLng != null
        ? [value.centreLng, value.centreLat] : BBOX_CENTRE;
      let map: MapLibreMap;
      try {
        map = new lib.Map({
          container: ref.current,
          style: OFFLINE_STYLE_URL,
          center: centre,
          zoom: value.centreLat != null ? 15 : OFFLINE_MAP_INITIAL_ZOOM,
          minZoom: OFFLINE_MAP_MIN_ZOOM,
          maxZoom: OFFLINE_MAP_MAX_ZOOM,
          maxBounds: OFFLINE_MAP_MAX_BOUNDS,
          dragRotate: false,
          touchPitch: false,
          trackResize: true,
        });
      } catch {
        return;
      }
      mapRef.current = map;
      map.on('click', (e) => {
        if (!e.lngLat) return;
        const p = propsRef.current;
        if (noGoModeRef.current) {
          onChangeRef.current({ ...p, noGoAreas: [...p.noGoAreas, circlePolygon(e.lngLat.lat, e.lngLat.lng, NO_GO_RADIUS_M)] });
          setAnnounce(`No-go area added. ${p.noGoAreas.length + 1} no-go areas on the map.`);
        } else if (p.zoneShape === 'draw') {
          // Draw mode: taps do not move anything — corners and the middle
          // marker are dragged. Tapping only selects a corner (on the
          // marker itself), never reshapes the zone by accident.
          setAnnounce('Draw mode — drag a numbered corner to reshape the zone, or drag the ✥ marker in the middle to move the whole zone.');
        } else {
          onChangeRef.current({ ...p, centreLat: e.lngLat.lat, centreLng: e.lngLat.lng });
          setCentreSource('placed');
          setAnnounce('Zone centre moved — placed by hand on the map, not a GPS fix.');
        }
      });
      map.on('style.load', () => {
        styleLoadedRef.current = true;
        ensureSourcesAndLayers(map);
        syncOverlays(map, lib, propsRef.current, null);
      });
      map.on('load', () => {
        loadedRef.current = true;
        ensureSourcesAndLayers(map);
        syncOverlays(map, lib, propsRef.current, null);
        // The centre may already be set (GPS landed before the map
        // finished loading): fit now, or the zone stays off-screen.
        fitToZone(map, propsRef.current);
      });
      // Container size changes leave the WebGL canvas at its old
      // size — blank or clipped — until resize() is called.
      if (typeof ResizeObserver !== 'undefined' && ref.current) {
        const resizeObserver = new ResizeObserver(() => { map.resize(); });
        resizeObserver.observe(ref.current);
        resizeObserverRef.current = resizeObserver;
      }
      map.on('webglcontextlost', () => { /* wait for restore */ });
      map.on('webglcontextrestored', () => { map.resize(); map.triggerRepaint(); });
      map.getContainer().style.cursor = 'crosshair';
    })();
    return () => {
      cancelled = true;
      loadedRef.current = false;
      styleLoadedRef.current = false;
      lastFittedRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Map is created once. Overlay sync + camera fits run in the
    // effects below, reading live props — never by recreating the map.
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || !loadedRef.current || !styleLoadedRef.current) return;
    syncOverlays(map, lib, value, locAccuracy);
    // Centre/radius may have changed while the map was still
    // loading (fitSignal fired too early): fit here too, so the
    // zone is actually centred on the chosen centre.
    fitToZone(map, value);
  });

  // Refit the camera to the whole zone when the host changes its size
  // or sets its centre (stepper/slider/GPS/tap), so a zone is
  // actually visible instead of overflowing a street-level zoom. Draw
  // mode fits the polygon's own bounding box. The fit is keyed (see
  // fitToZone), so a fit requested before the map loaded is picked
  // up by the sync effect instead of being lost.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    fitToZone(map, value);
  }, [fitSignal]);

  /** Apply a GPS fix as the zone centre. Only a real GPS fix ever
   *  reaches here — a fix coarser than ±50 m never auto-centres the
   *  zone (the caller rejects it); the host places the pin by hand. */
  const applyFix = (fix: ForegroundFix) => {
    setCentreSource('gps');
    const p = propsRef.current;
    if (p.zoneShape === 'draw' && p.drawnBoundary && p.drawnBoundary.length >= 3) {
      // Move the whole drawn shape so its middle sits where the host stands.
      const old = polygonCentroid(p.drawnBoundary);
      const next = old ? translatePolygon(p.drawnBoundary, fix.lat - old.lat, fix.lng - old.lng) : p.drawnBoundary;
      onChange({ ...p, centreLat: fix.lat, centreLng: fix.lng, drawnBoundary: next });
      setAnnounce(`Your location found — GPS accuracy ±${Math.round(fix.accuracyMeters)} m. The drawn zone moved to where you are standing.`);
    } else if (p.zoneShape === 'draw') {
      // No shape yet: place the centre and draw the starting shape.
      onChange({ ...p, centreLat: fix.lat, centreLng: fix.lng, drawnBoundary: circlePolygon(fix.lat, fix.lng, p.radiusMeters, DRAW_DEFAULT_CORNERS) });
      setAnnounce(`Your location found — GPS accuracy ±${Math.round(fix.accuracyMeters)} m. Zone centre set to where you are standing.`);
    } else {
      onChange({ ...p, centreLat: fix.lat, centreLng: fix.lng });
      setAnnounce(`Your location found — GPS accuracy ±${Math.round(fix.accuracyMeters)} m. Zone centre set to where you are standing.`);
    }
  };

  const handleLocError = (msg: string) => {
    setLocState('error');
    setLocError(msg);
    setAnnounce(msg);
  };

  /** Run one location attempt. getCurrentFix runs the staged chain
   *  (watch → one-shot → low accuracy → cached), so a hanging method
   *  fails over to the next automatically; onProgress reports the best
   *  accuracy AND the stage, so the host watches GPS refining live
   *  instead of a static spinner. */
  const runLocation = (getter: (onProgress: LocationProgress) => Promise<ForegroundFix>) => {
    setLocState('locating');
    setLocError('');
    setLocBest(null);
    setLocStage(null);
    getter((best, stage) => { setLocBest(best); if (stage) setLocStage(stage); })
      .then((fix) => {
        // Defence in depth for the founder's ±50 m auto-centre rule:
        // even if a fix somehow arrives here coarser than ±50 m, it
        // must NOT become the zone centre — the host places the pin.
        if (fix.accuracyMeters > ZONE_AUTO_CENTRE_MAX_ACCURACY_M) {
          handleLocError(coarseFixMessage());
          return;
        }
        setLocAccuracy(fix.accuracyMeters);
        setLocBest(null);
        setLocStage(null);
        setLocState('ok');
        applyFix(fix);
      })
      .catch((msg: string) => handleLocError(msg));
  };

  const useMyLocation = () => runLocation(getCurrentFix);

  // Founder rule (2026-11-17): the zone centre is the host's real GPS
  // location — request it on load and centre there. Until a fix
  // arrives the button reads "Finding your location…" and the zone
  // stays un-centred (no fake centre, no city name). Only once, and
  // only when no centre is set yet — reopening settings with a centre
  // already placed must not re-prompt for location. Permission is
  // checked FIRST: when location is already denied, the chain is
  // skipped entirely (no spinner, no waiting) and the denied help
  // shows with tap-the-map as the primary path.
  const useMyLocationRef = useRef(useMyLocation);
  useMyLocationRef.current = useMyLocation;
  const autoLocRequestedRef = useRef(false);
  useEffect(() => {
    if (autoLocRequestedRef.current) return;
    autoLocRequestedRef.current = true;
    if (propsRef.current.centreLat == null || propsRef.current.centreLng == null) {
      void checkLocationPermission().then((perm) => {
        if (perm === 'denied') {
          setLocState('error');
          setLocError(LOCATION_DENIED_HELP);
          setAnnounce(LOCATION_DENIED_HELP);
        } else {
          useMyLocationRef.current();
        }
      });
    }
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cLat = value.centreLat;
    const cLng = value.centreLng;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (cLat == null || cLng == null)) {
      e.preventDefault();
      setAnnounce('Set the zone centre first — use your location or tap the map.');
      return;
    }
    const dLat = e.key === 'ArrowUp' ? STEP_DEG : e.key === 'ArrowDown' ? -STEP_DEG : 0;
    const dLng = e.key === 'ArrowRight' ? STEP_DEG : e.key === 'ArrowLeft' ? -STEP_DEG : 0;
    if (dLat !== 0 || dLng !== 0) {
      e.preventDefault();
      // Arrow keys move the zone by hand — the centre is no longer
      // the live GPS fix, so it is labelled as hand-placed.
      setCentreSource('placed');
      if (value.zoneShape === 'draw' && value.drawnBoundary) {
        commitDraw(translatePolygon(value.drawnBoundary, dLat, dLng), 'Whole zone moved.');
      } else if (cLat != null && cLng != null) {
        onChange({ ...value, centreLat: cLat + dLat, centreLng: cLng + dLng });
      }
      return;
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      if (value.zoneShape === 'draw' && value.drawnBoundary) {
        const dia = polygonDiameterMeters(value.drawnBoundary);
        const target = dia + 100;
        commitDraw(scalePolygonTowardCentroid(value.drawnBoundary, target / dia), 'Zone grew — about 100 m wider across.');
      } else {
        // No maximum (founder decision, 2026-11-17 — unlimited
        // past 1 km): + keeps growing the radius.
        onChange({ ...value, radiusMeters: value.radiusMeters + ZONE_RADIUS_STEP_M });
      }
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      if (value.zoneShape === 'draw' && value.drawnBoundary) {
        const dia = polygonDiameterMeters(value.drawnBoundary);
        const target = Math.max(ZONE_RADIUS_MIN_M * 2, dia - 100);
        commitDraw(scalePolygonTowardCentroid(value.drawnBoundary, target / dia), 'Zone shrank — about 100 m narrower across.');
      } else {
        onChange({ ...value, radiusMeters: Math.max(ZONE_RADIUS_MIN_M, value.radiusMeters - ZONE_RADIUS_STEP_M) });
      }
    } else if (e.key === 'u' || e.key === 'U') {
      if (value.zoneShape === 'draw') { e.preventDefault(); undoDraw(); }
    }
  };

  const centreSet = value.centreLat != null && value.centreLng != null;
  // The zone centre is outside the downloaded area: the pin still
  // works, but no streets will show there. Plain words only — no
  // fallback, no reload, no switcher.
  const centreOutsideArea = centreSet && !isInsideOfflineMap(value.centreLat!, value.centreLng!);
  const drawSize = drawn ? polygonDiameterMeters(drawn) : 0;

  return (
    <div>
      <p>
        <button type="button" className="btn btn-lg" onClick={useMyLocation} disabled={locState === 'locating'}>
          {locState === 'locating' ? 'Finding your location…' : 'Use my location'}
        </button>
      </p>
      {locState === 'locating' ? <p role="status">{locStage ?? 'Finding your location…'} Waiting for a good GPS fix (accuracy ±10 m or better) — this can take a few seconds outdoors. Indoors GPS may not lock at all.{locBest != null ? ` Best fix so far: ±${Math.round(locBest)} m — still refining…` : ''} You can tap the map right now to place the zone — no need to wait for GPS.</p> : null}
      {locState === 'ok' && locAccuracy != null ? <p role="status">✓ Location found — {locationPrecisionLabel(locAccuracy)} (GPS accuracy ±{Math.round(locAccuracy)} m). The map is centred where you are standing.</p> : null}
      {locState === 'error' ? (
        <div className="banner" role="alert">
          {locError}
        </div>
      ) : null}
      {!centreSet ? <p className="small">No centre yet. Tap “Use my location” above, or tap anywhere on the map to drop the zone there. Nothing is centred on a guessed place.</p> : null}

      <div
        className="mapbox"
        role="region"
        aria-label={isDraw
          ? (drawn ? `Drawn play zone — ${drawn.length} corners, about ${formatDistance(drawSize)} across. Drag a numbered corner to reshape it, drag the middle marker to move the whole zone. Arrow keys move the whole zone, plus and minus change its size, U undoes.` : 'Drawn play zone — no shape yet. Use your location to place the starting shape.')
          : centreSet ? `Play zone map — centre set, about ${formatDistance(value.radiusMeters * 2)} across. Arrow keys move the zone, plus and minus change its size.` : 'Play zone map — no centre yet. Use your location or tap the map to place the zone.'}
        tabIndex={0}
        onKeyDown={onKeyDown}
        style={{ height: 320, borderRadius: 12, overflow: 'hidden', position: 'relative' }}
      >
        <div ref={ref} style={{ width: '100%', height: '100%' }} aria-hidden="true" />
        <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 5 }} role="group" aria-label="Map zoom controls">
          <button type="button" className="btn btn-secondary" style={{ minWidth: 48, minHeight: 48, padding: '8px 12px' }} onClick={() => zoomBy(1)} aria-label="Zoom in, centred on the zone centre">+</button>
          <button type="button" className="btn btn-secondary" style={{ minWidth: 48, minHeight: 48, padding: '8px 12px' }} onClick={() => zoomBy(-1)} aria-label="Zoom out, centred on the zone centre">−</button>
          <button type="button" className="btn btn-secondary" style={{ minWidth: 48, minHeight: 48, padding: '8px 12px' }} onClick={centreOnPin} aria-label="Centre the map on the zone centre">◎</button>
        </div>
      </div>
      {centreOutsideArea ? (
        <p className="small" role="status">{OUTSIDE_MAP_AREA_MESSAGE}</p>
      ) : null}
      {isDraw ? (
        <>
          <p><strong>Drawn zone:</strong> {drawn ? `${drawn.length} corners · about ${formatDistance(drawSize)} across` : 'not drawn yet — use your location to place the starting shape'}</p>
          {drawn && centreSource === 'gps' && locAccuracy != null ? <p className="small">GPS fix — {locationPrecisionLabel(locAccuracy)} (GPS accuracy ±{Math.round(locAccuracy)} m).</p> : null}
          {drawn && centreSource === 'placed' ? <p className="small">Placed by hand on the map — not a GPS fix. Tap “Use my location” for your real position.</p> : null}
          <p className="small">Drag a numbered corner to reshape the zone. Arrow keys move it, + / − resize.</p>
          <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" disabled={selectedCorner === null || !drawn || drawn.length <= 3} onClick={() => {
              if (selectedCorner === null || !drawn) return;
              const next = drawn.filter((_, j) => j !== selectedCorner);
              setSelectedCorner(null);
              commitDraw(next, `Corner ${selectedCorner + 1} removed — ${next.length} corners left.`);
            }}>− Remove corner{selectedCorner !== null ? ` ${selectedCorner + 1}` : ''}</button>
            <button type="button" className="btn btn-secondary" disabled={drawHistoryRef.current.length === 0} onClick={undoDraw}>Undo</button>
            <button type="button" className="btn btn-secondary" disabled={!centreSet} onClick={startAgainDraw}>Start again</button>
          </p>
          {selectedCorner !== null ? <p className="small" role="status">Corner {selectedCorner + 1} selected.</p> : null}
        </>
      ) : (
        <>
          {centreSet && centreSource === 'gps' && locAccuracy != null ? <p className="small">GPS fix — {locationPrecisionLabel(locAccuracy)} (GPS accuracy ±{Math.round(locAccuracy)} m).</p> : null}
          {centreSet && centreSource === 'placed' ? <p className="small">Placed by hand on the map — not a GPS fix. Tap “Use my location” for your real position.</p> : null}
          {centreSet && centreSource === null ? <p className="small">Centre set before this screen opened — tap “Use my location” to confirm it against your real GPS position.</p> : null}
          <p><strong>Zone size:</strong> about {formatDistance(value.radiusMeters * 2)} across (radius {formatDistance(value.radiusMeters)})</p>
          <p className="small">Tap the map to move the centre. Arrow keys move it, + / − resize.</p>
        </>
      )}
      <p aria-live="polite" className="small">{announce}</p>

      <h3>No-go areas</h3>
      <p className="small">Tap the map to drop a no-go circle. Players must stay out.</p>
      <p>
        <button type="button" className="btn btn-secondary" aria-pressed={noGoMode} onClick={() => setNoGoMode((m) => !m)}>
          {noGoMode ? 'No-go mode: ON — tap the map to add a no-go area' : 'Add no-go areas on the map'}
        </button>
      </p>
      {value.noGoAreas.length === 0 ? <p>No no-go areas drawn yet.</p> : (
        <ul>{value.noGoAreas.map((_a, i) => {
          return (
            <li key={i}>
              No-go area {i + 1}
              {' '}
              <button type="button" className="btn btn-secondary" onClick={() => onChange({ ...value, noGoAreas: value.noGoAreas.filter((_, j) => j !== i) })}>Remove</button>
            </li>
          );
        })}</ul>
      )}
    </div>
  );
}
