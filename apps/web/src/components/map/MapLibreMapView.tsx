'use client';
import { useEffect, useRef, useState } from 'react';
import { ZONE_AUTO_CENTRE_MAX_ACCURACY_M } from '@pakdam/shared';
import { formatAgeAgo, haversineMeters, polygonCentroid } from '@/components/match/freshness';
import { locationPrecisionLabel } from '@/lib/geolocation';
import {
  loadMapLibre, OFFLINE_STYLE_URL, OFFLINE_MAP_ATTRIBUTION,
  OFFLINE_MAP_CENTRE, OFFLINE_MAP_INITIAL_ZOOM, OFFLINE_MAP_MIN_ZOOM,
  OFFLINE_MAP_MAX_ZOOM, OFFLINE_MAP_MAX_BOUNDS, OFFLINE_MAP_AREA_MESSAGE,
  OUTSIDE_MAP_AREA_MESSAGE, isInsideOfflineMap,
  polygonToGeoJSON, circlePolygon, featureCollection,
  type MapLibreLib, type MapLibreMap, type MapLibreMarker,
} from './maplibre';
import type { MapViewProps, OverlayProps } from './types';

/** MapLibre GL JS + the BUNDLED offline map — the ONLY map
 *  (founder decision, 2026-11-17 19:34 IST): ONE simple working map,
 *  downloaded offline and bundled in the app, covering Doranda +
 *  Hinoo, Ranchi, Jharkhand, for now. NO fallback / switcher /
 *  reload. The full live map service is a SEPARATE later task.
 *
 *  The bundle is `apps/web/public/offline-map/`: 808 bundled Esri
 *  World Street Map raster tiles (zooms 12–17, Doranda + Hinoo)
 *  served by the raster style `public/offline-map/style.json`,
 *  rendered by vendored MapLibre v5 (`public/offline-map/vendor/`)
 *  — zero network requests at runtime. If the bundled tiles cannot
 *  be loaded, the view says so honestly — there is no alternate map
 *  provider to fall back to, by founder decision. If WebGL is
 *  unavailable or a vendored library fails to load, `onInitFailed`
 *  fires and the parent shows an honest error.
 *
 *  Same overlays as before (zone, next zone, ping areas, no-go
 *  areas, own location as an uncertainty circle), same ±50 m camera
 *  gate: the camera flies to the centre only the first time an
 *  ACCURATE fix appears — never to a coarse first fix (a coarse
 *  first fix put the correctly centred zone 2–3 km away on screen,
 *  2026-11-17). A first fix worse than ±50 m still draws its marker
 *  + accuracy circle, but the camera stays on the zone until a fix
 *  accurate to ±50 m or better arrives, or a later fix at least
 *  halves the accuracy the camera last centred on.
 *
 *  Blank-map guard (live check 2026-11-17 22:11 — tiles counted,
 *  nothing painted, reload did not fix it): the camera NEVER flies
 *  to a fix OUTSIDE the downloaded tile area. A fix outside the
 *  pack has no tiles under it, so flying there paints white — and
 *  on reload the same out-of-area fix re-centred the map there
 *  again, which is why reload did not fix it. The camera stays on
 *  the zone / downloaded area and the outside-area message shows
 *  instead. Rapid movement also no longer thrashes the camera:
 *  flyTo fires only when the fix moved >25 m or the accuracy at
 *  least halved. And the canvas is re-measured (resize) whenever
 *  its container changes size, so a hidden-then-shown map repaints
 *  its tiles instead of staying white.
 *
 *  Zoom buttons are the app's own (+ / − / centre), and they zoom
 *  ON THE PIN (or the zone centre when there is no pin) — never on
 *  the middle of the screen, which drifted the pin off-screen. */

const SOURCE_IDS = {
  zone: 'pakdam-zone',
  nextZone: 'pakdam-next-zone',
  pings: 'pakdam-pings',
  noGo: 'pakdam-nogo',
  accuracy: 'pakdam-accuracy',
} as const;

/** Centre of the bundled area (Doranda) — the map starts here when
 *  no location is set yet. There are no tiles for anywhere else, so
 *  a world view would be an empty background. */
const BBOX_CENTRE: [number, number] = OFFLINE_MAP_CENTRE;

export function MapLibreMapView({
  lat, lng, accuracyM, label, zoneBoundary, nextZoneBoundary, pingArea, pingAreas, pingHistoryOn, noGoAreas, onMapClick, onInitFailed,
}: MapViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<MapLibreLib | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const loadedRef = useRef(false);
  const styleLoadedRef = useRef(false);
  const centredAccuracyRef = useRef<number | null>(null);
  /** Last centre the camera actually flew to — flyTo fires only
   *  when the fix moved >25 m from it (or the accuracy halved), so
   *  rapid movement-pad steps cannot thrash the camera animation
   *  into a blank frame. */
  const lastFlownRef = useRef<{ lat: number; lng: number } | null>(null);
  /** Last measured container size — a size change means resize(). */
  const lastSizeRef = useRef<{ w: number; h: number } | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const propsRef = useRef<OverlayProps & { onMapClick?: (lat: number, lng: number) => void }>({ lat, lng, accuracyM, label, zoneBoundary, nextZoneBoundary, pingArea, pingAreas, pingHistoryOn, noGoAreas, onMapClick });
  propsRef.current = { lat, lng, accuracyM, label, zoneBoundary, nextZoneBoundary, pingArea, pingAreas, pingHistoryOn, noGoAreas, onMapClick };
  /** The bundled style file failed to load (missing/corrupt pack).
   *  Shown honestly, no retry button — there is no other map to
   *  retry with, by founder decision. The zone, markers and match
   *  controls below still work. */  const [mapError, setMapError] = useState(false);
  const failedRef = useRef(false);
  const fail = () => { if (!failedRef.current) { failedRef.current = true; onInitFailed?.(); } };

  const ensureSourcesAndLayers = (map: MapLibreMap) => {
    const add = (id: string, sourceId: string, kind: string, paint: Record<string, unknown>, layout?: Record<string, unknown>) => {
      if (!map.getSource(sourceId)) map.addSource(sourceId, { type: 'geojson', data: featureCollection([]) });
      if (!map.getLayer(id)) map.addLayer({ id, type: kind, source: sourceId, paint, layout });
    };
    // The zone ring must read as a RING at street zoom, not a faint
    // wash: a white halo under a thick red line, over a stronger
    // fill (live check 2026-11-17: the old 3px line / 0.07 fill was
    // barely visible). Halo first so it draws beneath the red line.
    add(SOURCE_IDS.zone, SOURCE_IDS.zone, 'fill', { 'fill-color': '#B91C1C', 'fill-opacity': 0.2 });
    add(`${SOURCE_IDS.zone}-halo`, SOURCE_IDS.zone, 'line', { 'line-color': '#FFFFFF', 'line-width': 9, 'line-opacity': 0.9 });
    add(`${SOURCE_IDS.zone}-line`, SOURCE_IDS.zone, 'line', { 'line-color': '#B91C1C', 'line-width': 5, 'line-opacity': 1 });
    add(SOURCE_IDS.nextZone, SOURCE_IDS.nextZone, 'line', { 'line-color': '#B91C1C', 'line-width': 3, 'line-dasharray': [4, 3] });
    add(SOURCE_IDS.pings, SOURCE_IDS.pings, 'fill', { 'fill-color': '#1D4ED8', 'fill-opacity': 0.18 });
    add(SOURCE_IDS.noGo, SOURCE_IDS.noGo, 'fill', { 'fill-color': '#7F1D1D', 'fill-opacity': 0.25 });
    add(SOURCE_IDS.accuracy, SOURCE_IDS.accuracy, 'fill', { 'fill-color': '#1D4ED8', 'fill-opacity': 0.1 });
  };

  const syncOverlays = (map: MapLibreMap, lib: MapLibreLib, p: OverlayProps) => {
    const set = (id: string, data: Record<string, unknown>) => { map.getSource(id)?.setData(data); };
    set(SOURCE_IDS.zone, p.zoneBoundary && p.zoneBoundary.length >= 3 ? polygonToGeoJSON(p.zoneBoundary) : featureCollection([]));
    set(SOURCE_IDS.nextZone, p.nextZoneBoundary && p.nextZoneBoundary.length >= 3 ? polygonToGeoJSON(p.nextZoneBoundary) : featureCollection([]));
    const pingFeatures: Record<string, unknown>[] = [];
    if (p.pingAreas === undefined && p.pingArea) pingFeatures.push(circlePolygon(p.pingArea.lat, p.pingArea.lng, p.pingArea.radiusMeters));
    for (const a of p.pingAreas ?? []) pingFeatures.push(circlePolygon(a.lat, a.lng, a.radiusMeters));
    set(SOURCE_IDS.pings, featureCollection(pingFeatures));
    set(SOURCE_IDS.noGo, featureCollection((p.noGoAreas ?? []).map((poly) => polygonToGeoJSON(poly))));
    set(SOURCE_IDS.accuracy, p.lat != null && p.lng != null && p.accuracyM != null && p.accuracyM > 0
      ? circlePolygon(p.lat, p.lng, p.accuracyM) : featureCollection([]));

    // Markers are rebuilt each sync (cheap: a pin + a few labels).
    // Marker chips use theme tokens (var(--surface)/var(--ink)/
    // var(--focus)/var(--line)/var(--muted)) so they follow dark mode
    // — never hardcoded light fills. Light values equal the old
    // hardcoded ones; the chips sit on the light raster tiles in
    // both themes, so they stay readable either way.
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    if (p.pingAreas) {
      for (const a of p.pingAreas) {
        const el = document.createElement('div');
        el.innerHTML = `<span style="background:${a.stale ? 'var(--surface-muted)' : 'var(--surface)'};border:2px solid ${a.stale ? 'var(--line)' : 'var(--focus)'};color:${a.stale ? 'var(--muted)' : 'var(--ink)'};border-radius:999px;padding:2px 8px;font-size:12px;font-weight:700;white-space:nowrap;">${a.name} · ${formatAgeAgo(a.reportedAt)}</span>`;
        markersRef.current.push(new lib.Marker({ element: el }).setLngLat([a.lng, a.lat]).addTo(map));
      }
    }
    // Centre marker (the YOU marker): a red pin. The camera flies to
    // the centre only the first time an ACCURATE fix appears — never
    // to a coarse first fix (founder rule: never auto-centre on a
    // fix worse than ±50 m — a coarse first fix put the correctly
    // centred zone 2–3 km away on screen, 2026-11-17). A first fix
    // worse than ±50 m still draws its marker + accuracy circle, but
    // the camera stays on the zone until a fix accurate to ±50 m or
    // better arrives, or a later fix at least halves the accuracy
    // the camera last centred on. A fix with no accuracy reported
    // keeps the old behaviour (fly) — it cannot be judged coarse.
    // NEVER fly to a fix outside the downloaded tile area: there
    // are no tiles there, so the map paints white — and on reload
    // the same fix would re-centre it there again (live check
    // 2026-11-17: tiles counted, nothing painted, reload no fix).
    // The marker still draws; the camera stays on the zone area.
    // Rapid movement: fly only when the fix moved >25 m from the
    // last flown-to centre, so movement-pad steps cannot thrash
    // the camera animation into a blank frame.
    if (p.lat != null && p.lng != null) {
      const el = document.createElement('div');
      el.title = p.label;
      el.innerHTML = `<span style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#B91C1C;border:2px solid var(--surface);box-shadow:0 1px 4px rgba(0,0,0,0.4);"><span style="width:10px;height:10px;border-radius:50%;background:var(--surface);"></span></span>`;
      markersRef.current.push(new lib.Marker({ element: el }).setLngLat([p.lng, p.lat]).setPopup(new lib.Popup({ offset: 25 }).setText(p.label)).addTo(map));
      const fixInsideMap = isInsideOfflineMap(p.lat, p.lng);
      const accurateEnough = p.accuracyM == null || p.accuracyM <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M;
      const lastFlown = lastFlownRef.current;
      const movedM = lastFlown ? haversineMeters(lastFlown.lat, lastFlown.lng, p.lat, p.lng) : Infinity;
      const accuracyHalved = p.accuracyM != null && centredAccuracyRef.current != null && p.accuracyM < centredAccuracyRef.current / 2;
      if (fixInsideMap && accurateEnough && (!lastFlown || movedM > 25 || accuracyHalved)) {
        map.flyTo({ center: [p.lng, p.lat], zoom: 16 });
        centredAccuracyRef.current = p.accuracyM;
        lastFlownRef.current = { lat: p.lat, lng: p.lng };
      }
    } else {
      centredAccuracyRef.current = null;
    }
  };

  /** Zoom anchor: the pin when there is one, else the zone centre,
   *  else the current camera centre — never the middle of the
   *  screen by default. Zooming on the pin keeps the pin in view;
   *  zooming on the screen centre drifted it off-screen. */
  const zoomAnchor = (): [number, number] => {
    const p = propsRef.current;
    if (p.lat != null && p.lng != null) return [p.lng, p.lat];
    if (p.zoneBoundary && p.zoneBoundary.length >= 3) {
      const c = polygonCentroid(p.zoneBoundary);
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
    let cancelled = false;
    failedRef.current = false;
    (async () => {
      let lib: MapLibreLib;
      try {
        lib = await loadMapLibre();
      } catch {
        if (!cancelled) fail();
        return;
      }
      if (cancelled || !ref.current) return;
      if (!lib.supported()) { fail(); return; }
      libRef.current = lib;
      // Never start the camera outside the downloaded tile area:
      // a fix outside the pack has no tiles under it, so the map
      // opens white — and the same fix would re-centre it there on
      // every reload. Start on the downloaded area instead; the
      // outside-area message explains why the pin is off the map.
      const fixInsideMap = lat != null && lng != null && isInsideOfflineMap(lat, lng);
      const centre: [number, number] = fixInsideMap && lat != null && lng != null ? [lng, lat] : BBOX_CENTRE;
      let map: MapLibreMap;
      try {
        map = new lib.Map({
          container: ref.current,
          style: OFFLINE_STYLE_URL,
          center: centre,
          zoom: fixInsideMap ? 15 : OFFLINE_MAP_INITIAL_ZOOM,
          minZoom: OFFLINE_MAP_MIN_ZOOM,
          maxZoom: OFFLINE_MAP_MAX_ZOOM,
          maxBounds: OFFLINE_MAP_MAX_BOUNDS,
          dragRotate: false,
          touchPitch: false,
        });
      } catch {
        if (!cancelled) fail();
        return;
      }
      mapRef.current = map;
      map.on('click', (e) => { if (e.lngLat) propsRef.current.onMapClick?.(e.lngLat.lat, e.lngLat.lng); });
      let preLoadErrors = 0;
      map.on('error', () => {
        // The bundled raster tiles failed. A single bad tile
        // mid-session is not fatal (the map keeps working); only a
        // pack that NEVER loads is an honest error — 3 errors before
        // the style loads means the tile pack is missing or corrupt.
        if (!styleLoadedRef.current) {
          preLoadErrors += 1;
          if (preLoadErrors >= 3) setMapError(true);
        }
      });
      map.on('style.load', () => {
        styleLoadedRef.current = true;
        ensureSourcesAndLayers(map);
        syncOverlays(map, lib, propsRef.current);
      });
      map.on('load', () => {
        loadedRef.current = true;
        ensureSourcesAndLayers(map);
        syncOverlays(map, lib, propsRef.current);
      });
      // A container that changes size (tab switch, layout shift)
      // leaves the WebGL canvas at its old size — blank or clipped
      // — until resize() is called. The observer re-measures on
      // every size change; the context handlers repaint after a
      // WebGL context loss / restore (another blank-white cause).
      if (typeof ResizeObserver !== 'undefined' && ref.current) {
        const resizeObserver = new ResizeObserver(() => { map.resize(); });
        resizeObserver.observe(ref.current);
        resizeObserverRef.current = resizeObserver;
      }
      map.on('webglcontextlost', () => { /* wait for restore */ });
      map.on('webglcontextrestored', () => { map.resize(); map.triggerRepaint(); });
      if (propsRef.current.onMapClick) map.getContainer().style.cursor = 'crosshair';
    })();
    return () => {
      cancelled = true;
      loadedRef.current = false;
      styleLoadedRef.current = false;
      lastFlownRef.current = null;
      lastSizeRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Map is created once. Overlay + marker updates run in the sync
    // effect below, reading live props — never by recreating the map.
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || !loadedRef.current || !styleLoadedRef.current) return;
    syncOverlays(map, lib, { lat, lng, accuracyM, label, zoneBoundary, nextZoneBoundary, pingArea, pingAreas, noGoAreas });
    // Container size changed since the last sync (layout shift,
    // tab switch): re-measure or the canvas stays at its old size.
    const el = ref.current;
    if (el) {
      const size = { w: el.clientWidth, h: el.clientHeight };
      const prev = lastSizeRef.current;
      if (!prev || prev.w !== size.w || prev.h !== size.h) {
        lastSizeRef.current = size;
        map.resize();
      }
    }
  });

  // The GPS fix (or centre) is outside the downloaded area: the
  // pin still works, but no streets will show there. No fallback,
  // no reload, no switcher — plain words only.
  const outsideArea = lat != null && lng != null && !isInsideOfflineMap(lat, lng);

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <div ref={ref} className="mapbox" aria-label="Game map" />
        <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 5 }} role="group" aria-label="Map zoom controls">
          <button type="button" className="btn btn-secondary" style={{ minWidth: 44, minHeight: 44, padding: '8px 12px' }} onClick={() => zoomBy(1)} aria-label="Zoom in, centred on your location">+</button>
          <button type="button" className="btn btn-secondary" style={{ minWidth: 44, minHeight: 44, padding: '8px 12px' }} onClick={() => zoomBy(-1)} aria-label="Zoom out, centred on your location">−</button>
          <button type="button" className="btn btn-secondary" style={{ minWidth: 44, minHeight: 44, padding: '8px 12px' }} onClick={centreOnPin} aria-label="Centre the map on your location">◎</button>
        </div>
      </div>
      {mapError ? (
        <div className="banner" role="alert">
          <strong>The offline map tiles could not be loaded.</strong> The bundled map may be missing from this build. The zone, markers and match controls below still work.
        </div>
      ) : null}
      {outsideArea ? (
        <p className="small" role="status">{OUTSIDE_MAP_AREA_MESSAGE}</p>
      ) : null}
      <p className="small">
        {lat != null ? `Your location — ${locationPrecisionLabel(accuracyM)} (accuracy ±${accuracyM ?? '?'} m — shown as an uncertainty area, never an exact dot)` : 'No location on the map yet — use your location or tap the map to place the zone. The map starts on the game area, never a guessed place.'}
        {zoneBoundary ? ' Solid red ring with a white edge: current play zone.' : ''}{nextZoneBoundary ? ' Dashed red line: next zone preview — planned size only, not the final zone (the server draws the real zone when the shrink fires).' : ''}
        {noGoAreas && noGoAreas.length > 0 ? ` Dark red hatched ${noGoAreas.length === 1 ? 'area' : 'areas'}: no-go — players must stay out.` : ''}
        {pingArea ? ` Shaded blue area: ${pingArea.label} — a coarse ping area, never an exact pin.` : ''}
        {pingAreas && pingAreas.length > 0 ? ` Shaded blue areas: ${pingAreas.map((a) => `${a.name} (${formatAgeAgo(a.reportedAt)})`).join(', ')} — coarse ping areas with offset centres and wide radii, never exact pins. A ping stays until the next ping replaces it — the age counts up.${pingHistoryOn ? ' Earlier pings stay visible (dimmer) because Show ping history is on.' : ' Only the latest ping shows — Show ping history is off.'}` : ''}
        {' '}Map data {OFFLINE_MAP_ATTRIBUTION}. {OFFLINE_MAP_AREA_MESSAGE}; no live map service.
      </p>
      <p className="small">
        Map style respects the colour-blind theme (Hunters ◆ H solid · Runners ▲ R hatched — shape and
        letter never change). Your own position is an uncertainty area, never a false-precision dot.
      </p>
    </div>
  );
}
