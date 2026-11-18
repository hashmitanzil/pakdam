'use client';
import { useState } from 'react';
import { MapLibreMapView } from './MapLibreMapView';
import type { MapViewProps } from './types';

export type { MapViewProps } from './types';

/** The ONE map (founder decision, 2026-11-17 19:34 IST): MapLibre
 *  GL JS + the BUNDLED offline map (Doranda + Hinoo, Ranchi).
 *  NO fallback / switcher / reload — no alternate provider, no
 *  Leaflet view. If the device has no WebGL or the library fails to
 *  load, this shows an honest error instead of a blank map or a
 *  different map: the zone, markers and match controls still work,
 *  and the game stays playable. */
export default function MapView(props: MapViewProps) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div>
        <div className="banner" role="alert">
          <strong>This device cannot show the map.</strong> The map needs WebGL, which this device or browser does not provide. The zone, markers and match controls below still work — the game stays playable without the map picture.
        </div>
      </div>
    );
  }
  return <MapLibreMapView {...props} onInitFailed={() => setFailed(true)} />;
}
