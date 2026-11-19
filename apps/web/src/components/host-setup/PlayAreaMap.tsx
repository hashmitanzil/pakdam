'use client';
import { useEffect, useRef, useState } from 'react';
import type { GeoPolygon } from '@pakdam/shared';
import { ZONE_RADIUS_MIN_M, ZONE_RADIUS_STEP_M, ZONE_AUTO_CENTRE_MAX_ACCURACY_M } from '@pakdam/shared';
import { checkLocationPermission, coarseFixMessage, getCurrentFix, LOCATION_DENIED_HELP, locationPrecisionLabel, type ForegroundFix, type LocationProgress } from '@/lib/geolocation';
import { formatDistance, haversineMeters, polygonCentroid } from '@/components/match/freshness';
import { scalePolygonTowardCentroid } from '@/components/match/ZoneEditor';
import { addDrawPoint, canApplyDraw, drawPointsEqual, undoDrawPoint } from './drawPoints';
import {
  loadMapLibre, isWebGLSupported, OLA_STYLE_URL,
  MAP_INITIAL_CENTRE, OLA_MAP_INITIAL_ZOOM, OLA_MAP_MIN_ZOOM,
  OLA_MAP_MAX_ZOOM, olaTransformRequest, isOlaConfigured,
  polygonToGeoJSON, circlePolygon as circleGeoJSON, featureCollection,
  type MapLibreLib, type MapLibreMap, type MapLibreMarker,
} from '@/components/map/maplibre';

/**
 * Play-area map (location-first host setup). A real MapLibre map on
 * Ola Maps (founder decision, 2026-11-19): the offline tile pack is
 * GONE — live Ola tiles, no downloaded area, no maxBounds, no
 * outside-area guard or caption. NO fallback / switcher / reload.
 * The editor is MapLibre — the same map as the play/result
 * maps — with the interactive editor pieces (draggable centre pin,
 * draggable numbered point + middle markers) built on MapLibre Markers.
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
 * - Draw: tap-to-place (founder spec, 2026-11-19). NO default shape:
 *   the host taps the map and a numbered point drops (1, 2, 3…); 3
 *   taps enclose a triangle = the zone, a 4th tap makes 4 corners,
 *   a 5th makes 5, open-ended. Placed points stay draggable to
 *   fine-tune, the middle ✥ marker drags the whole draft. Undo
 *   removes the last point, Redraw clears all points, DONE applies
 *   the polygon — until DONE the points are a DRAFT: the room's
 *   drawnBoundary (and the form's validation) only see the applied
 *   shape. The polygon is stored in the room config as
 *   zone.boundary — the engine already enforces polygons
 *   (point-in-polygon), so a drawn zone is enforced exactly like a
 *   circle, including shrink phases (scaled copies).
 * Mode switch (founder decision, 2026-11-17): switching to Circle
 * CLEARS the drawn shape entirely — the form nulls drawnBoundary, and
 * this component drops the draft too, so no point marker, polygon
 * layer or stale draft survives into Circle mode. Returning to Draw
 * starts clean: no points until the host taps.
 * GPS in Draw mode sets the centre only — it never creates or moves
 * the shape: the shape is where the host tapped it.
 */
const STEP_DEG = 0.0005; // ~55 m per arrow press — labelled on screen

/** Ranchi home area — the map starts here (MAP_INITIAL_CENTRE,
 *  from @/components/map/maplibre) when no centre is set yet. The
 *  map is world-wide, so this is a starting centre only, not a
 *  boundary. */

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
  // True while the host is mid-drag on a marker. The sync effect
  // below runs after EVERY render and rebuilds all markers — without
  // this guard it destroys the marker being dragged and snaps it back
  // to the stored centre (the pin-drag test caught exactly that:
  // mid-drag the pin read at its start position, not +80 px).
  const draggingRef = useRef(false);
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
  const [announce, setAnnounce] = useState('');
  // Draw draft: the tap-to-place points, local until DONE applies
  // them (see commitDraft). The committed boundary lives in the
  // form value (value.drawnBoundary); the draft follows it when it
  // changes from outside (settings reopened, Radius stepper) — see
  // the sync effect below. Taps and drags only touch the draft.
  const [draftPoints, setDraftPoints] = useState<GeoPolygon>([]);
  const draftRef = useRef<GeoPolygon>([]);
  draftRef.current = draftPoints;
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  /** Key of the zone the camera was last fitted to (centre +
   *  radius + shape). The fit runs when this changes — including
   *  when the centre was already set before the map finished
   *  loading, which the old fitSignal-only effect missed (the
   *  un-centred zone: GPS landed before the map, the fit was
   *  skipped, and the zone sat off-screen). */
  const lastFittedRef = useRef<string | null>(null);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const isDraw = value.zoneShape === 'draw';
  const drawn = isDraw ? value.drawnBoundary : null;

  // Mode switch to Circle: the draft is dropped (see the effect
  // below) and the form already nulls drawnBoundary; the markers
  // and polygon layer are removed by the overlay sync below.
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
    if (p.zoneShape === 'draw') {
      // Draw with no shape yet: do NOT fall through to the circle
      // fit — there is no circle to fit, and the camera must stay
      // where the host is tapping. Callers pass the draft as
      // drawnBoundary (see the sync effects), so this fits the
      // draft polygon once it encloses.
      if (p.drawnBoundary && p.drawnBoundary.length >= 3) {
        const lats = p.drawnBoundary.map((pt) => pt.lat);
        const lngs = p.drawnBoundary.map((pt) => pt.lng);
        map.fitBounds(
          [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
          { padding: 40, maxZoom: 17 },
        );
      }
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

  /** The value fitToZone should fit: in Draw mode the DRAFT polygon
   *  (the shape being placed), not the committed boundary. */
  const fitValue = (p: PlayAreaValue): PlayAreaValue =>
    p.zoneShape === 'draw'
      ? { ...p, drawnBoundary: draftRef.current.length >= 3 ? [...draftRef.current] : null }
      : p;

  /** Zoom anchor: in Draw mode the draft polygon's middle, else the
   *  zone centre pin when set, else the drawn shape's middle, else
   *  the current camera centre. Zooming on the pin keeps the pin in
   *  view; zooming on the screen centre drifted it off-screen (live
   *  check 2026-11-17). */
  const zoomAnchor = (): [number, number] => {
    const p = propsRef.current;
    // Draw mode anchors on the draft polygon, not the centre pin:
    // the shape is where the host tapped it, which may be nowhere
    // near the GPS centre.
    if (p.zoneShape === 'draw') {
      const d = draftRef.current;
      if (d.length >= 3) {
        const c = polygonCentroid(d);
        if (c) return [c.lng, c.lat];
      }
    }
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
    return MAP_INITIAL_CENTRE;
  };
  const zoomBy = (dir: 1 | -1) => {
    const map = mapRef.current;
    if (!map) return;
    const z = Math.min(OLA_MAP_MAX_ZOOM, Math.max(OLA_MAP_MIN_ZOOM, map.getZoom() + dir));
    map.easeTo({ center: zoomAnchor(), zoom: z, duration: 300 });
  };
  const centreOnPin = () => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ center: zoomAnchor(), zoom: Math.max(map.getZoom(), 15), duration: 300 });
  };

  // Mode switch to Circle: drop the draft, so no point marker,
  // polygon layer or stale draft survives into Circle mode. The
  // form already nulls drawnBoundary; the overlay sync below
  // removes the rest.
  useEffect(() => {
    if (value.zoneShape === 'circle') {
      setDraftPoints([]);
    }
  }, [value.zoneShape]);

  // Draw draft follows the committed boundary when it changes from
  // OUTSIDE the draft (settings reopened on a saved Draw room, the
  // Radius stepper scaling the applied shape). Taps and drags only
  // touch the draft, so this never fights the host's placing.
  useEffect(() => {
    if (value.zoneShape === 'draw') {
      setDraftPoints(value.drawnBoundary ? [...value.drawnBoundary] : []);
    }
  }, [value.drawnBoundary, value.zoneShape]);

  /** Draft helpers (Draw only). Taps, drags and the arrow keys edit
   *  the DRAFT — the form value is untouched until DONE applies it. */
  const updateDraft = (next: GeoPolygon, label: string) => {
    setDraftPoints(next);
    setAnnounce(label);
  };

  /** Undo: remove the last placed point. Drags are not undone —
   *  the founder's spec names Undo as "removes the last point". */
  const undoDraw = () => {
    const cur = draftRef.current;
    if (cur.length === 0) { setAnnounce('Nothing to undo.'); return; }
    const next = undoDrawPoint(cur);
    setDraftPoints(next);
    setAnnounce(next.length === 0
      ? 'Point removed — no points left. Tap the map to place point 1.'
      : `Point ${cur.length} removed — ${next.length} point${next.length === 1 ? '' : 's'} left.`);
  };

  /** Redraw: clear every point and start over. */
  const redrawDraw = () => {
    setDraftPoints([]);
    setAnnounce('Cleared — tap the map to place point 1.');
  };

  /** DONE: apply the draft as the room's drawn boundary. The radius
   *  follows the polygon's size across (no maximum — founder
   *  decision, 2026-11-17, unlimited past 1 km). Under 3 points
   *  there is nothing to apply. */
  const commitDraft = () => {
    const pts = draftRef.current;
    if (!canApplyDraw(pts)) {
      setAnnounce(`Tap at least 3 points on the map first — ${pts.length} point${pts.length === 1 ? '' : 's'} cannot enclose an area.`);
      return;
    }
    const dia = polygonDiameterMeters(pts);
    onChangeRef.current({
      ...propsRef.current,
      drawnBoundary: [...pts],
      radiusMeters: Math.round(Math.max(ZONE_RADIUS_MIN_M, dia / 2)),
    });
    setAnnounce(`Zone applied — ${pts.length} points, about ${formatDistance(dia)} across.`);
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
   *  Draw only — the draggable numbered point markers + the
   *  drag-the-middle marker. In Draw mode the zone and markers render
   *  the DRAFT (draftRef), not the committed boundary — the map shows
   *  the shape being placed until DONE applies it. GeoJSON sources
   *  are re-set and markers rebuilt on each sync, so the map always
   *  matches the stored state exactly. */
  const syncOverlays = (map: MapLibreMap, lib: MapLibreLib, p: PlayAreaValue, accuracyM: number | null) => {
    const set = (id: string, data: Record<string, unknown>) => { map.getSource(id)?.setData(data); };
    const draw = p.zoneShape === 'draw';
    // Draw renders the DRAFT, not the committed boundary — the zone
    // on the map is the shape being placed, until DONE applies it.
    const draft = draw ? draftRef.current : null;
    if (draw) {
      set(SOURCE_IDS.zone, draft && draft.length >= 3 ? polygonToGeoJSON(draft) : featureCollection([]));
    } else if (p.centreLat != null && p.centreLng != null) {
      set(SOURCE_IDS.zone, circleGeoJSON(p.centreLat, p.centreLng, p.radiusMeters));
    } else {
      set(SOURCE_IDS.zone, featureCollection([]));
    }
    set(SOURCE_IDS.noGo, featureCollection((p.noGoAreas ?? []).map((poly) => polygonToGeoJSON(poly))));
    set(SOURCE_IDS.accuracy, p.centreLat != null && p.centreLng != null && accuracyM != null && accuracyM > 0
      ? circleGeoJSON(p.centreLat, p.centreLng, accuracyM) : featureCollection([]));

    // Markers are rebuilt each sync (cheap: a pin + a few corners)
    // — UNLESS a drag is in progress. Rebuilding mid-drag destroys
    // the marker being dragged and snaps it back to the stored centre;
    // the dragend handler commits the new position, which triggers the
    // next sync with the drag over. GeoJSON sources above already
    // updated; only the marker rebuild is skipped here.
    if (draggingRef.current) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    // Circle centre pin (circle mode only) — DRAGGABLE: the host can
    // drag the pin to their exact spot even when GPS is coarse (the
    // manual fallback that makes exact placement possible). Dragging
    // marks the centre hand-placed, never a GPS fix.
    if (!draw && p.centreLat != null && p.centreLng != null) {
      const el = document.createElement('div');
      el.title = 'Zone centre pin — drag to move it to your exact spot';
      el.innerHTML = '<span style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#B91C1C;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);touch-action:none;"><span style="width:12px;height:12px;border-radius:50%;background:#fff;"></span></span>';
      const marker = new lib.Marker({ element: el, draggable: true, anchor: 'bottom' }).setLngLat([p.centreLng, p.centreLat]).addTo(map);
      marker.on('dragstart', () => { draggingRef.current = true; });
      marker.on('dragend', () => {
        draggingRef.current = false;
        const ll = marker.getLngLat();
        onChangeRef.current({ ...propsRef.current, centreLat: ll.lat, centreLng: ll.lng });
        setCentreSource('placed');
        setAnnounce('Centre pin dragged to your exact spot — placed by hand on the map, not a GPS fix.');
      });
      markersRef.current.push(marker);
    }
    // Draggable numbered point markers + the drag-the-middle marker
    // (Draw only). Points render from 1 — even a single placed point
    // shows its marker, so the host sees every tap land. The middle
    // marker appears once the draft encloses (3+ points).
    if (draw && draft && draft.length >= 1) {
      const poly = draft;
      poly.forEach((pt, i) => {
        const el = document.createElement('div');
        // 48 px touch target (point drag must work by touch at
        // 360 px); touch-action none so a finger drag moves the
        // point instead of panning the map.
        el.innerHTML = `<span role="button" aria-label="Point ${i + 1} of ${poly.length} — drag to move." style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;border:3px solid #B91C1C;background:#fff;color:#B91C1C;font-weight:800;font-size:15px;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,0.35);touch-action:none;">${i + 1}</span>`;
        const marker = new lib.Marker({ element: el, draggable: true }).setLngLat([pt.lng, pt.lat]).addTo(map);
        marker.on('dragstart', () => { draggingRef.current = true; });
        marker.on('dragend', () => {
          draggingRef.current = false;
          const ll = marker.getLngLat();
          const cur = draftRef.current;
          const next = cur.map((c, j) => (j === i ? { lat: ll.lat, lng: ll.lng } : c));
          updateDraft(next, `Point ${i + 1} moved.`);
        });
        markersRef.current.push(marker);
      });
      // Middle marker: drag it to move the whole draft.
      const centre = poly.length >= 3 ? polygonCentroid(poly) : null;
      if (centre) {
        const el = document.createElement('div');
        el.innerHTML = '<span role="button" aria-label="Drag to move the whole zone." style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:10px;border:2px solid #fff;background:#B91C1C;color:#fff;font-weight:800;font-size:18px;cursor:move;box-shadow:0 1px 4px rgba(0,0,0,0.35);touch-action:none;">✥</span>';
        const marker = new lib.Marker({ element: el, draggable: true }).setLngLat([centre.lng, centre.lat]).addTo(map);
        marker.on('dragstart', () => { draggingRef.current = true; });
        marker.on('dragend', () => {
          draggingRef.current = false;
          const ll = marker.getLngLat();
          const cur = draftRef.current;
          const old = polygonCentroid(cur);
          if (!old) return;
          updateDraft(translatePolygon(cur, ll.lat - old.lat, ll.lng - old.lng), 'Whole zone moved.');
        });
        markersRef.current.push(marker);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // No Ola key configured — do NOT construct the map. The
      // missing-key line renders below; the zone is still settable
      // from the steppers / tap-to-place flow.
      if (!isOlaConfigured()) return;
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
        ? [value.centreLng, value.centreLat] : MAP_INITIAL_CENTRE;
      let map: MapLibreMap;
      try {
        map = new lib.Map({
          container: ref.current,
          style: OLA_STYLE_URL,
          transformRequest: olaTransformRequest,
          center: centre,
          zoom: value.centreLat != null ? 15 : OLA_MAP_INITIAL_ZOOM,
          minZoom: OLA_MAP_MIN_ZOOM,
          maxZoom: OLA_MAP_MAX_ZOOM,
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
        if (p.zoneShape === 'draw') {
          // Draw mode: every tap drops a numbered point on the draft.
          // 3 points enclose the zone; more taps add corners. The
          // shape is only applied when the host taps DONE.
          const next = addDrawPoint(draftRef.current, e.lngLat.lat, e.lngLat.lng);
          setDraftPoints(next);
          if (next.length < 3) {
            setAnnounce(`Point ${next.length} placed — tap ${3 - next.length} more to enclose the zone.`);
          } else {
            setAnnounce(`Point ${next.length} placed — ${next.length} points enclose the zone. Drag a point to fine-tune, or tap DONE to apply it.`);
          }
          // Fit the camera to the new polygon the moment it first
          // encloses, so the triangle is actually visible.
          if (next.length === 3) fitToZone(map, { ...p, drawnBoundary: next });
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
        fitToZone(map, fitValue(propsRef.current));
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
    fitToZone(map, fitValue(value));
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
    fitToZone(map, fitValue(value));
  }, [fitSignal]);

  /** Apply a GPS fix as the zone centre. Only a real GPS fix ever
   *  reaches here — a fix coarser than ±50 m never auto-centres the
   *  zone (the caller rejects it); the host places the pin by hand. */
  const applyFix = (fix: ForegroundFix) => {
    setCentreSource('gps');
    const p = propsRef.current;
    // Draw mode: GPS sets the centre only — it never creates or
    // moves the shape. The shape is where the host tapped it; moving
    // it under them would fight the tap-to-place flow.
    onChange({ ...p, centreLat: fix.lat, centreLng: fix.lng });
    setAnnounce(p.zoneShape === 'draw'
      ? `Your location found — GPS accuracy ±${Math.round(fix.accuracyMeters)} m. Zone centre set to where you are standing. Tap the map to place the zone points.`
      : `Your location found — GPS accuracy ±${Math.round(fix.accuracyMeters)} m. Zone centre set to where you are standing.`);
  };

  const handleLocError = (msg: string) => {
    // Founder decision, 2026-11-18: the denied-help line ("Location
    // is off — allow it in your browser settings…") is removed from
    // this screen — no banner, no announce for it. The host just taps
    // the map to place the zone. The coarse-fix line ("GPS is too
    // rough here…") still shows, as before.
    if (msg === LOCATION_DENIED_HELP) {
      setLocState('idle');
      setLocError('');
      setAnnounce('');
      return;
    }
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
  // skipped entirely (no spinner, no waiting) and no denied text is
  // shown — the host just taps the map (founder decision, 2026-11-18).
  const useMyLocationRef = useRef(useMyLocation);
  useMyLocationRef.current = useMyLocation;
  const autoLocRequestedRef = useRef(false);
  useEffect(() => {
    if (autoLocRequestedRef.current) return;
    autoLocRequestedRef.current = true;
    if (propsRef.current.centreLat == null || propsRef.current.centreLng == null) {
      void checkLocationPermission().then((perm) => {
        if (perm === 'denied') {
          handleLocError(LOCATION_DENIED_HELP);
        } else {
          useMyLocationRef.current();
        }
      });
    }
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cLat = value.centreLat;
    const cLng = value.centreLng;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (cLat == null || cLng == null) && value.zoneShape !== 'draw') {
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
      if (value.zoneShape === 'draw') {
        // Draw points need no centre: arrows move the draft itself.
        if (draftRef.current.length === 0) {
          setAnnounce('Tap the map to place points first — there is no shape to move yet.');
        } else {
          updateDraft(translatePolygon(draftRef.current, dLat, dLng), 'Whole zone moved.');
        }
      } else if (cLat != null && cLng != null) {
        onChange({ ...value, centreLat: cLat + dLat, centreLng: cLng + dLng });
      }
      return;
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      if (value.zoneShape === 'draw') {
        const draft = draftRef.current;
        if (draft.length < 3) {
          setAnnounce('Tap at least 3 points first — there is no zone to grow yet.');
        } else {
          const dia = polygonDiameterMeters(draft);
          const target = dia + 100;
          updateDraft(scalePolygonTowardCentroid(draft, target / dia), 'Zone grew — about 100 m wider across.');
        }
      } else {
        // No maximum (founder decision, 2026-11-17 — unlimited
        // past 1 km): + keeps growing the radius.
        onChange({ ...value, radiusMeters: value.radiusMeters + ZONE_RADIUS_STEP_M });
      }
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      if (value.zoneShape === 'draw') {
        const draft = draftRef.current;
        if (draft.length < 3) {
          setAnnounce('Tap at least 3 points first — there is no zone to shrink yet.');
        } else {
          const dia = polygonDiameterMeters(draft);
          const target = Math.max(ZONE_RADIUS_MIN_M * 2, dia - 100);
          updateDraft(scalePolygonTowardCentroid(draft, target / dia), 'Zone shrank — about 100 m narrower across.');
        }
      } else {
        onChange({ ...value, radiusMeters: Math.max(ZONE_RADIUS_MIN_M, value.radiusMeters - ZONE_RADIUS_STEP_M) });
      }
    } else if (e.key === 'u' || e.key === 'U') {
      if (value.zoneShape === 'draw') { e.preventDefault(); undoDraw(); }
    }
  };

  const centreSet = value.centreLat != null && value.centreLng != null;
  const drawSize = draftPoints.length >= 1 ? polygonDiameterMeters(draftPoints) : 0;
  // True once the draft is exactly the applied shape — the status
  // line says "zone applied" only then.
  const draftApplied = drawPointsEqual(draftPoints, drawn);

  return (
    <div>
      <p>
        <button type="button" className="btn btn-lg" onClick={useMyLocation} disabled={locState === 'locating'}>
          {locState === 'locating' ? 'Finding your location…' : 'Use my location'}
        </button>
      </p>
      {locState === 'locating' ? <p role="status">{locStage ?? 'Finding your location…'}{locBest != null ? ` Best fix so far: ±${Math.round(locBest)} m — still refining…` : ''}</p> : null}
      {locState === 'ok' && locAccuracy != null ? <p role="status">✓ Location found — {locationPrecisionLabel(locAccuracy)} (GPS accuracy ±{Math.round(locAccuracy)} m). The map is centred where you are standing.</p> : null}
      {locState === 'error' ? (
        <div className="banner" role="alert">
          {locError}
        </div>
      ) : null}

      <div
        className="mapbox"
        role="region"
        aria-label={isDraw
          ? (draftPoints.length >= 3
            ? `Drawn play zone — ${draftPoints.length} points, about ${formatDistance(drawSize)} across.${draftApplied ? ' Zone applied.' : ' Tap DONE to apply it.'}`
            : draftPoints.length > 0
              ? `Drawn play zone — ${draftPoints.length} point${draftPoints.length === 1 ? '' : 's'} placed. Tap the map to add more.`
              : 'Drawn play zone — no points yet. Tap the map to place point 1.')
          : centreSet ? `Play zone map — centre set, about ${formatDistance(value.radiusMeters * 2)} across.` : 'Play zone map — tap the map to place the zone.'}
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
      {!isOlaConfigured() ? <p className="small" role="status">Map key not set — add NEXT_PUBLIC_OLA_MAPS_API_KEY in Vercel and redeploy.</p> : null}
      {isDraw ? (
        <>
          <p><strong>Drawn zone:</strong> {draftPoints.length === 0
            ? 'not drawn yet — tap the map to place point 1'
            : draftPoints.length < 3
              ? `${draftPoints.length} point${draftPoints.length === 1 ? '' : 's'} placed — tap ${3 - draftPoints.length} more to enclose the zone`
              : draftApplied
                ? `${draftPoints.length} points · about ${formatDistance(drawSize)} across — zone applied`
                : `${draftPoints.length} points · about ${formatDistance(drawSize)} across — tap DONE to apply the zone`}</p>
          {centreSource === 'gps' && locAccuracy != null ? <p className="small">GPS fix — {locationPrecisionLabel(locAccuracy)} (GPS accuracy ±{Math.round(locAccuracy)} m).</p> : null}
          {centreSource === 'placed' ? <p className="small">Placed by hand on the map — not a GPS fix. Tap “Use my location” for your real position.</p> : null}
          <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" disabled={draftPoints.length === 0} onClick={undoDraw}>Undo</button>
            <button type="button" className="btn btn-secondary" disabled={draftPoints.length === 0} onClick={redrawDraw}>Redraw</button>
            <button type="button" className="btn" disabled={!canApplyDraw(draftPoints)} onClick={commitDraft}>Done</button>
          </p>
        </>
      ) : (
        <>
          {centreSet && centreSource === 'gps' && locAccuracy != null ? <p className="small">GPS fix — {locationPrecisionLabel(locAccuracy)} (GPS accuracy ±{Math.round(locAccuracy)} m).</p> : null}
          {centreSet && centreSource === 'placed' ? <p className="small">Placed by hand on the map — not a GPS fix. Tap “Use my location” for your real position.</p> : null}
        </>
      )}
      <p aria-live="polite" className="small">{announce}</p>
    </div>
  );
}
