'use client';
import { useState } from 'react';
import { MapLibreMapView } from './MapLibreMapView';
import type { MapViewProps } from './types';

export type { MapViewProps } from './types';

/** The ONE map (founder decision, 2026-11-19): MapLibre GL JS +
 *  Ola Maps vector tiles (default-dark-standard) — the bundled
 *  offline map is gone. NO fallback / switcher / reload — no
 *  alternate provider, no Leaflet view. If the Ola key is not set,
 *  the map is not constructed and this shows the missing-key
 *  banner. If the device has no WebGL or the library / style fails
 *  to load, this shows an honest error instead of a blank map or a
 *  different map: the zone, markers and match controls still work,
 *  and the game stays playable. */
export default function MapView(props: MapViewProps) {
  const [failedReason, setFailedReason] = useState<'missing-key' | 'load-failed' | undefined>(undefined);
  if (failedReason === 'missing-key') {
    return (
      <div>
        <div className="banner" role="alert">
          <strong>Map key not set — add NEXT_PUBLIC_OLA_MAPS_API_KEY in Vercel (Production + Preview) and redeploy. The game still works without the map picture.</strong>
        </div>
      </div>
    );
  }
  if (failedReason) {
    return (
      <div>
        <div className="banner" role="alert">
          <strong>This device cannot show the map.</strong> The map needs WebGL, which this device or browser does not provide. The zone, markers and match controls below still work — the game stays playable without the map picture.
        </div>
      </div>
    );
  }
  return <MapLibreMapView {...props} onInitFailed={(reason) => setFailedReason(reason ?? 'load-failed')} />;
}
