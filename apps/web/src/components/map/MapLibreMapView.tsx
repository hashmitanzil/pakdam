'use client';
import { useEffect, useRef } from 'react';
import { ZONE_AUTO_CENTRE_MAX_ACCURACY_M } from '@pakdam/shared';
import { formatAgeAgo, haversineMeters, polygonCentroid } from '@/components/match/freshness';
import { locationPrecisionLabel } from '@/lib/geolocation';
import {
  loadMapLibre, isWebGLSupported, OLA_STYLE_URL,
  MAP_INITIAL_CENTRE, OLA_MAP_INITIAL_ZOOM, OLA_MAP_MIN_ZOOM,
  OLA_MAP_MAX_ZOOM, olaTransformRequest, isOlaConfigured,
  polygonToGeoJSON, circlePolygon, featureCollection,
  type MapLibreLib, type MapLibreMap, type MapLibreMarker,
} from './maplibre';
import type { MapViewProps, OverlayProps } from './types';

/** MapLibre GL JS + OLA MAPS vector tiles — the ONLY map
 *  (founder decision, 2026-11-19): replace the bundled offline map
 *  with Ola Maps, fully. The Ola `default-dark-standard` vector
 *  style is rendered by the same vendored MapLibre v5 engine
 *  (`public/vendor/maplibre/`) — zero bundled tiles, no offline
 *  pack, no downloaded-area guard, no maxBounds: the map is
 *  world-wide. Ola tiles carry real area labels (Doranda, Hinoo,
 *  …), so the app no longer draws its own area labels.
 *
 *  Auth: the style JSON's tile / sprite / glyph URLs carry no key,
 *  so the map is constructed with `transformRequest:
 *  olaTransformRequest`, which appends `api_key` (from
 *  NEXT_PUBLIC_OLA_MAPS_API_KEY) to every api.olamaps.io request.
 *  If no key is configured the map is NOT constructed at all —
 *  `onInitFailed('missing-key')` fires and the parent shows the
 *  missing-key banner. If the style fails to load (e.g. a wrong
 *  key → 401), the map 'error' event fires
 *  `onInitFailed('load-failed')` instead. Either way there is no
 *  blank silent map and no crash — the zone, markers and match
 *  controls below still work.
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
 *  Rapid movement also no longer thrashes the camera:
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

/** Fallback centre — Ranchi / Doranda, the game's home area — the
 *  map starts here when no location is set yet. The map is
 *  world-wide, so this is a starting centre only, not a boundary. */
const FALLBACK_CENTRE: [number, number] = MAP_INITIAL_CENTRE;

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
  /** The map failed to initialise (missing key, library / style
   *  load failure, no WebGL). There is no other map to retry with,
   *  by founder decision — the failure is reported up through
   *  onInitFailed with a reason, and the parent shows the matching
   *  banner. The zone, markers and match controls below still work. */
  const failedRef = useRef(false);
  const fail = (reason?: 'missing-key' | 'load-failed') => { if (!failedRef.current) { failedRef.current = true; onInitFailed?.(reason); } };

  const ensureSourcesAndLayers = (map: MapLibreMap) => {
    const add = (id: string, sourceId: string, kind: string, paint: Record<string, unknown>, layout?: Record<string, unknown>) => {
      if (!map.getSource(sourceId)) map.addSource(sourceId, { type: 'geojson', data: featureCollection([]) });
      if (!map.getLayer(id)) map.addLayer({ id, type: kind, source: sourceId, paint, layout: layout ?? {} });
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

    // Markers are rebuilt each sync (cheap: a pin + a few chips).
    // Marker chips use theme tokens (var(--surface)/var(--ink)/
    // var(--focus)/var(--line)/var(--muted)) so they follow dark mode
    // — never hardcoded light fills. (Ola tiles carry the real area
    // labels now, so the app draws no area labels of its own.)
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
    // The map is world-wide now, so there is no downloaded-area
    // guard: the camera may fly to a fix anywhere.
    // Rapid movement: fly only when the fix moved >25 m from the
    // last flown-to centre, so movement-pad steps cannot thrash
    // the camera animation into a blank frame.
    if (p.lat != null && p.lng != null) {
      const el = document.createElement('div');
      el.title = p.label;
      el.innerHTML = `<span style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#B91C1C;border:2px solid var(--surface);box-shadow:0 1px 4px rgba(0,0,0,0.4);"><span style="width:10px;height:10px;border-radius:50%;background:var(--surface);"></span></span>`;
      markersRef.current.push(new lib.Marker({ element: el }).setLngLat([p.lng, p.lat]).setPopup(new lib.Popup({ offset: 25 }).setText(p.label)).addTo(map));
      const accurateEnough = p.accuracyM == null || p.accuracyM <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M;
      const lastFlown = lastFlownRef.current;
      const movedM = lastFlown ? haversineMeters(lastFlown.lat, lastFlown.lng, p.lat, p.lng) : Infinity;
      const accuracyHalved = p.accuracyM != null && centredAccuracyRef.current != null && p.accuracyM < centredAccuracyRef.current / 2;
      if (accurateEnough && (!lastFlown || movedM > 25 || accuracyHalved)) {
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
    return FALLBACK_CENTRE;
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

  useEffect(() => {
    let cancelled = false;
    failedRef.current = false;
    (async () => {
      // No Ola key configured — do NOT construct the map. The
      // parent shows the missing-key banner; the game still works
      // without the map picture.
      if (!isOlaConfigured()) { if (!cancelled) fail('missing-key'); return; }
      let lib: MapLibreLib;
      try {
        lib = await loadMapLibre();
      } catch {
        if (!cancelled) fail('load-failed');
        return;
      }
      if (cancelled || !ref.current) return;
      // Real WebGL probe (loadMapLibre already checks too — this is
      // defence in depth before constructing the map). The old
      // `lib.supported()` call was the bug: MapLibre v5 has no such
      // export, so it threw on every device.
      if (!isWebGLSupported()) { fail('load-failed'); return; }
      libRef.current = lib;
      // Start on the fix when there is one, else on Ranchi /
      // Doranda (the game's home area). The map is world-wide, so
      // there is no area guard on the starting centre.
      const hasFix = lat != null && lng != null;
      const centre: [number, number] = hasFix && lat != null && lng != null ? [lng, lat] : MAP_INITIAL_CENTRE;
      let map: MapLibreMap;
      try {
        map = new lib.Map({
          container: ref.current,
          style: OLA_STYLE_URL,
          transformRequest: olaTransformRequest,
          center: centre,
          zoom: hasFix ? 15 : OLA_MAP_INITIAL_ZOOM,
          minZoom: OLA_MAP_MIN_ZOOM,
          maxZoom: OLA_MAP_MAX_ZOOM,
          dragRotate: false,
          touchPitch: false,
        });
      } catch {
        if (!cancelled) fail('load-failed');
        return;
      }
      mapRef.current = map;
      map.on('click', (e) => { if (e.lngLat) propsRef.current.onMapClick?.(e.lngLat.lat, e.lngLat.lng); });
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
      // Style-load failure (e.g. a wrong key → 401 on the style /
      // sprite / glyph requests): fail gracefully with
      // 'load-failed' instead of leaving a blank silent map. Only
      // errors before the style has loaded count — a tile error
      // (e.tile set) or an error after load must not kill the map.
      map.on('error', (e) => {
        if (loadedRef.current || styleLoadedRef.current) return;
        if (e.tile) return;
        if (!cancelled) fail('load-failed');
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

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <div ref={ref} className="mapbox" aria-label="Game map" />
        <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 5 }} role="group" aria-label="Map zoom controls">
          <button type="button" className="btn btn-secondary" style={{ minWidth: 48, minHeight: 48, padding: '8px 12px' }} onClick={() => zoomBy(1)} aria-label="Zoom in, centred on your location">+</button>
          <button type="button" className="btn btn-secondary" style={{ minWidth: 48, minHeight: 48, padding: '8px 12px' }} onClick={() => zoomBy(-1)} aria-label="Zoom out, centred on your location">−</button>
          <button type="button" className="btn btn-secondary" style={{ minWidth: 48, minHeight: 48, padding: '8px 12px' }} onClick={centreOnPin} aria-label="Centre the map on your location">◎</button>
        </div>
      </div>
      <p className="small">
        {lat != null ? `Your location — ${locationPrecisionLabel(accuracyM)} (accuracy ±${accuracyM ?? '?'} m — shown as an uncertainty area, never an exact dot)` : 'No location on the map yet — use your location or tap the map to place the zone. The map starts on the game area, never a guessed place.'}
        {zoneBoundary ? ' Solid red ring with a white edge: current play zone.' : ''}{nextZoneBoundary ? ' Dashed red line: next zone preview — planned size only, not the final zone (the server draws the real zone when the shrink fires).' : ''}
        {noGoAreas && noGoAreas.length > 0 ? ` Dark red hatched ${noGoAreas.length === 1 ? 'area' : 'areas'}: no-go — players must stay out.` : ''}
        {pingArea ? ` Shaded blue area: ${pingArea.label} — a coarse ping area, never an exact pin.` : ''}
        {pingAreas && pingAreas.length > 0 ? ` Shaded blue areas: ${pingAreas.map((a) => `${a.name} (${formatAgeAgo(a.reportedAt)})`).join(', ')} — coarse ping areas with offset centres and wide radii, never exact pins. A ping stays until the next ping replaces it — the age counts up.${pingHistoryOn ? ' Earlier pings stay visible (dimmer) because Show ping history is on.' : ' Only the latest ping shows — Show ping history is off.'}` : ''}
      </p>
    </div>
  );
}
