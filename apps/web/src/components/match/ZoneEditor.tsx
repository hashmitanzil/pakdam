'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { GeoPolygon } from '@pakdam/shared';
import { ZONE_RADIUS_UI_MAX_M, ZONE_RADIUS_MIN_M, ZONE_RADIUS_STEP_M, ZONE_AUTO_CENTRE_MAX_ACCURACY_M } from '@pakdam/shared';
import { circlePolygon } from '@pakdam/engine';
import { formatDistance } from '../match/freshness';
import { checkLocationPermission, coarseFixMessage, getBestCoarseFix, getCurrentFix, LOCATION_DENIED_HELP, locationPrecisionLabel, retryLocation, type ForegroundFix, type LocationProgress } from '@/lib/geolocation';
import { Button } from '@/components/ui/button';

const MapView = dynamic(() => import('../map/MapView'), { ssr: false });

/** Host zone editor (24 S02, location-first redesign Nov 2026): the game
 *  starts from LOCATION, never from a typed place name. There is no
 *  venue/area-name field anywhere in this component — the host taps
 *  "Use my location" (real GPS centre on a real map) or taps the map to
 *  drop the zone, sizes it with a slider (diameter shown in m/km), and
 *  draws no-go areas as circles on the map. On load the editor requests
 *  the host's real GPS location and centres there; until a fix arrives
 *  it shows "Finding your location…" and the zone stays un-centred —
 *  never a fallback place as the centre, and no city name anywhere in the map UI. No-go areas are drawn
 *  shapes, never a typed list of names. The old venue-derived
 *  area-check code is deleted: players confirm the same play area by
 *  the zone itself, in the lobby.
 *
 *  Keyboard: arrow keys move the centre, + / − change the radius,
 *  U undoes the last change — every change is announced. Zone presets
 *  are saved by name in localStorage (a saved zone shape, not a place
 *  name). Sizes are calibration OPEN — the radius suggestion is a
 *  starting point, not a measured value. */
export interface ZoneDraft {
  centreLat: number | null;
  centreLng: number | null;
  radiusMeters: number;
  noGoAreas: GeoPolygon[];
}

const PRESET_KEY = 'pakdam.zone-presets.v1';
const STEP_DEG = 0.0005; // ~55 m per arrow press — labelled on screen
const NO_GO_RADIUS_M = 25; // each drawn no-go circle, ~50 m across

/** Starting size suggestion from player count — a starting point only,
 *  NOT a measured value. The host checks the circle against the real
 *  ground and adjusts the slider. */
export function suggestedRadiusMeters(totalPlayers: number): number {
  return Math.min(1000, Math.max(200, 200 + 25 * (totalPlayers - 3)));
}

// Circle-polygon and scale-toward-centroid geometry live in the engine
// (@pakdam/engine: circlePolygon, scalePolygonTowardCentroid) — one
// definition shared by host setup, the play map and the shrink
// phases, so the drawn zone, the stored boundary and the shrunk
// copies can never disagree. Re-exported here for the existing
// import sites.
export { circlePolygon, scalePolygonTowardCentroid } from '@pakdam/engine';

export function zoneDraftToBoundary(d: ZoneDraft): GeoPolygon {
  if (d.centreLat == null || d.centreLng == null) return [];
  return circlePolygon(d.centreLat, d.centreLng, d.radiusMeters);
}

export default function ZoneEditor({
  value, onChange, suggestedRadius, totalPlayers,
}: {
  value: ZoneDraft;
  onChange: (d: ZoneDraft) => void;
  /** Radius (m) suggested for the current player count — the "reset to
   *  suggested size" target, shown next to the slider. */
  suggestedRadius: number;
  totalPlayers: number;
}) {
  const [history, setHistory] = useState<ZoneDraft[]>([]);
  const [announce, setAnnounce] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetMsg, setPresetMsg] = useState('');
  const [savedPresets, setSavedPresets] = useState<string[]>([]);
  const [locState, setLocState] = useState<'idle' | 'locating' | 'ok' | 'error'>('idle');
  const [locError, setLocError] = useState('');
  const [locAccuracy, setLocAccuracy] = useState<number | null>(null);
  /** Best accuracy seen so far while a fix is refining — shown live. */
  const [locBest, setLocBest] = useState<number | null>(null);
  /** Current stage of the location chain ("Trying high-accuracy
   *  GPS…", "Trying standard GPS…") — shown live while locating,
   *  so the host sees which method is being tried instead of a
   *  static spinner. */
  const [locStage, setLocStage] = useState<string | null>(null);
  /** The best coarse fix the chain saw (too coarse to auto-centre).
   *  Offered as "Use this approximate spot" — the host may CHOOSE
   *  it as a hand-placed pin, never applied silently. */
  const [approxFix, setApproxFix] = useState<ForegroundFix | null>(null);
  const [noGoMode, setNoGoMode] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PRESET_KEY);
      if (raw) setSavedPresets(Object.keys(JSON.parse(raw) as Record<string, ZoneDraft>));
    } catch { setSavedPresets([]); }
  }, []);

  const apply = useCallback((next: ZoneDraft, label: string) => {
    setHistory((h) => [...h.slice(-19), value]);
    onChange(next);
    setAnnounce(label);
  }, [onChange, value]);

  const undo = useCallback(() => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      if (!prev) { setAnnounce('Nothing to undo.'); return h; }
      onChange(prev);
      setAnnounce('Undid the last zone change.');
      return h.slice(0, -1);
    });
  }, [onChange]);

  const handleLocError = useCallback((msg: string) => {
    setLocState('error');
    setLocError(msg);
    setAnnounce(msg);
    // A coarse best fix is kept for the "Use this approximate spot"
    // offer — the host may choose it, it is never applied silently.
    const coarse = getBestCoarseFix();
    setApproxFix(coarse && coarse.accuracyMeters > ZONE_AUTO_CENTRE_MAX_ACCURACY_M ? coarse : null);
  }, []);

  /** Run one location attempt through `getter` (getCurrentFix or
   *  retryLocation). The staged chain fails over from one method to
   *  the next automatically; onProgress reports the best accuracy
   *  AND the stage, so the host watches GPS refining live. */
  const runLocation = useCallback((getter: (onProgress: LocationProgress) => Promise<ForegroundFix>) => {
    setLocState('locating');
    setLocError('');
    setLocBest(null);
    setLocStage(null);
    setApproxFix(null);
    getter((best, stage) => { setLocBest(best); if (stage) setLocStage(stage); })
      .then((fix) => {
        // Defence in depth for the founder's ±50 m auto-centre rule:
        // a fix coarser than ±50 m must NOT become the zone centre.
        if (fix.accuracyMeters > ZONE_AUTO_CENTRE_MAX_ACCURACY_M) {
          handleLocError(coarseFixMessage(fix.accuracyMeters));
          return;
        }
        setLocAccuracy(fix.accuracyMeters);
        setLocBest(null);
        setLocStage(null);
        setLocState('ok');
        apply(
          { ...value, centreLat: fix.lat, centreLng: fix.lng },
          `Your location found — GPS accuracy ±${Math.round(fix.accuracyMeters)} m. Zone centre set to where you are standing.`,
        );
      })
      .catch((msg: string) => handleLocError(msg));
  }, [apply, handleLocError, value]);

  const useMyLocation = useCallback(() => runLocation(getCurrentFix), [runLocation]);
  /** Manual retry: force-resets every busy flag in the chain and
   *  restarts from the permission check. */
  const retryLoc = useCallback(() => runLocation(retryLocation), [runLocation]);
  /** The host chose the coarse fix as a hand-placed pin. Never a GPS
   *  claim: locState goes back to 'idle' (no "✓ Location found"
   *  line) and the centre is labelled hand-placed by the announce. */
  const useApproximateSpot = useCallback(() => {
    if (!approxFix) return;
    const f = approxFix;
    setLocState('idle');
    setLocError('');
    setApproxFix(null);
    apply(
      { ...value, centreLat: f.lat, centreLng: f.lng },
      `Placed at your approximate location (±${Math.round(f.accuracyMeters)} m — GPS could not do better). Drag the pin to your exact spot.`,
    );
  }, [apply, approxFix, value]);

  // Auto-locate on mount when no centre is set yet. Permission is
  // checked FIRST: when location is already denied, the chain is
  // skipped entirely (no spinner, no waiting) and the denied help
  // shows with tap-the-map as the primary path.
  const useMyLocationRef = useRef(useMyLocation);
  useMyLocationRef.current = useMyLocation;
  const autoLocRequestedRef = useRef(false);
  useEffect(() => {
    if (autoLocRequestedRef.current) return;
    autoLocRequestedRef.current = true;
    if (value.centreLat == null || value.centreLng == null) {
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
  }, [value.centreLat, value.centreLng]);

  const onMapClick = useCallback((lat: number, lng: number) => {
    if (noGoMode) {
      apply(
        { ...value, noGoAreas: [...value.noGoAreas, circlePolygon(lat, lng, NO_GO_RADIUS_M)] },
        `No-go area added. ${value.noGoAreas.length + 1} no-go ${value.noGoAreas.length + 1 === 1 ? 'area' : 'areas'} on the map.`,
      );
    } else {
      apply(
        { ...value, centreLat: lat, centreLng: lng },
        'Zone centre moved.',
      );
    }
  }, [apply, noGoMode, value]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const isArrow = e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    const cLat = value.centreLat;
    const cLng = value.centreLng;
    if (isArrow && (cLat == null || cLng == null)) {
      e.preventDefault();
      setAnnounce('Set the zone centre first — use your location or tap the map.');
      return;
    }
    const step = STEP_DEG;
    if (e.key === 'ArrowUp' && cLat != null && cLng != null) { e.preventDefault(); apply({ ...value, centreLat: cLat + step }, 'Centre moved north.'); }
    else if (e.key === 'ArrowDown' && cLat != null && cLng != null) { e.preventDefault(); apply({ ...value, centreLat: cLat - step }, 'Centre moved south.'); }
    else if (e.key === 'ArrowLeft' && cLat != null && cLng != null) { e.preventDefault(); apply({ ...value, centreLng: cLng - step }, 'Centre moved west.'); }
    else if (e.key === 'ArrowRight' && cLat != null && cLng != null) { e.preventDefault(); apply({ ...value, centreLng: cLng + step }, 'Centre moved east.'); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); apply({ ...value, radiusMeters: value.radiusMeters + ZONE_RADIUS_STEP_M }, `Radius increased to ${value.radiusMeters + ZONE_RADIUS_STEP_M} metres — about ${formatDistance((value.radiusMeters + ZONE_RADIUS_STEP_M) * 2)} across.`); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); apply({ ...value, radiusMeters: Math.max(ZONE_RADIUS_MIN_M, value.radiusMeters - ZONE_RADIUS_STEP_M) }, `Radius decreased to ${Math.max(ZONE_RADIUS_MIN_M, value.radiusMeters - ZONE_RADIUS_STEP_M)} metres — about ${formatDistance(Math.max(ZONE_RADIUS_MIN_M, value.radiusMeters - ZONE_RADIUS_STEP_M) * 2)} across.`); }
    else if (e.key === 'u' || e.key === 'U') { e.preventDefault(); undo(); }
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) { setPresetMsg('Enter a preset name first.'); return; }
    if (name.length > 30) { setPresetMsg('Preset name is too long — 30 characters or fewer.'); return; }
    try {
      const all = JSON.parse(localStorage.getItem(PRESET_KEY) ?? '{}') as Record<string, ZoneDraft>;
      if (all[name]) { setPresetMsg(`A preset called “${name}” already exists — choose another name.`); return; }
      all[name] = value;
      localStorage.setItem(PRESET_KEY, JSON.stringify(all));
      setSavedPresets(Object.keys(all));
      setPresetMsg(`Preset “${name}” saved on this device.`);
    } catch { setPresetMsg('Could not save the preset on this device.'); }
  };

  const loadPreset = (name: string) => {
    try {
      const all = JSON.parse(localStorage.getItem(PRESET_KEY) ?? '{}') as Record<string, ZoneDraft>;
      const p = all[name];
      if (p) { apply(p, `Preset “${name}” loaded.`); }
    } catch { setPresetMsg('Could not load that preset.'); }
  };

  const centreSet = value.centreLat != null && value.centreLng != null;

  return (
    <div className="card">
      <h2>Step 2 — Play zone</h2>
      <p>Start from where you are standing. The zone is a circle on a real map — no place name to type. Your GPS sets the centre, and the size is suggested from your player count.</p>

      <p>
        <button type="button" className="btn btn-lg" onClick={useMyLocation} disabled={locState === 'locating'}>
          {locState === 'locating' ? 'Finding your location…' : 'Use my location'}
        </button>
      </p>
      {locState === 'locating' ? <p role="status">{locStage ?? 'Finding your location…'} Waiting for a good GPS fix (accuracy ±10 m or better) — this can take a few seconds outdoors. Indoors GPS may not lock at all.{locBest != null ? ` Best fix so far: ±${Math.round(locBest)} m — still refining…` : ''} You can tap the map right now to place the zone — no need to wait for GPS.</p> : null}
      {locState === 'ok' && locAccuracy != null ? <p role="status">✓ Location found — {locationPrecisionLabel(locAccuracy)} (GPS accuracy ±{Math.round(locAccuracy)} m). The map is centred where you are standing.</p> : null}
      {locState === 'error' ? (
        <div className="banner" role="alert">
          <strong>Location unavailable.</strong> {locError} Tap the map to place the zone where you are standing.
          {' '}
          <Button variant="secondary" size="sm" onClick={retryLoc}>Retry location</Button>
          {approxFix ? (
            <>
              {' '}
              <button type="button" className="btn btn-secondary" onClick={useApproximateSpot}>Use this approximate spot (±{Math.round(approxFix.accuracyMeters)} m)</button>
            </>
          ) : null}
        </div>
      ) : null}
      {!centreSet ? <p className="small">No centre yet. Tap “Use my location” above, or tap anywhere on the map to drop the zone there. Nothing is centred on a guessed place.</p> : null}

      <div
        ref={mapRef}
        className="zone-editor-map"
        role="region"
        aria-label={centreSet ? `Play zone map — centre set, about ${formatDistance(value.radiusMeters * 2)} across. Use arrow keys to move the zone, plus and minus to change its size, U to undo.` : 'Play zone map — no centre yet. Use your location or tap the map to place the zone.'}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <MapView
          lat={value.centreLat} lng={value.centreLng} accuracyM={locAccuracy} label="Zone centre"
          zoneBoundary={zoneDraftToBoundary(value)} noGoAreas={value.noGoAreas}
          onMapClick={onMapClick} keyboardPan={false}
        />
        <p><strong>Zone centre:</strong> {centreSet ? 'set' : 'not set yet'}</p>
        <p><strong>Zone size:</strong> about {formatDistance(value.radiusMeters * 2)} across (radius {formatDistance(value.radiusMeters)})</p>
        <p className="small">Tap the map to move the centre{noGoMode ? ' — no-go mode is on, so taps add no-go areas instead' : ''}. Keyboard: arrow keys move the centre (~55 m per press), + / − change the radius by 50 m, U undoes.</p>
        <p aria-live="polite" className="small">{announce}</p>
      </div>

      {/* No latitude/longitude fields (founder rule, 2026-11-17): the
          centre is set by GPS or by hand on the map, never typed or
          shown as numbers. */}

      <label className="label" htmlFor="zone-radius">
        Zone size — <output htmlFor="zone-radius">about {formatDistance(value.radiusMeters * 2)} across</output>
      </label>
      <input
        id="zone-radius" type="range" min={ZONE_RADIUS_MIN_M} max={Math.max(ZONE_RADIUS_UI_MAX_M, value.radiusMeters)} step={ZONE_RADIUS_STEP_M} value={value.radiusMeters}
        onChange={(e) => apply({ ...value, radiusMeters: Number(e.target.value) }, `Zone size changed — about ${formatDistance(Number(e.target.value) * 2)} across.`)}
        style={{ width: '100%', accentColor: '#B91C1C', height: 44 }}
        aria-describedby="zone-radius-hint"
      />
      <div style={{ display: 'flex', justifyContent: 'space-between' }} className="small"><span>200 m across</span><span>10 km across (slider range — no maximum)</span></div>
      <p id="zone-radius-hint" className="small">
        Radius {formatDistance(value.radiusMeters)} — about {formatDistance(value.radiusMeters * 2)} across.
        Suggested for {totalPlayers} players: about {formatDistance(suggestedRadius * 2)} across.
        The suggestion is a starting point, not a measured value — sizes are calibration OPEN, so check the circle against the real ground before you create the room.
      </p>
      <p>
        <button type="button" className="btn btn-secondary" onClick={() => apply({ ...value, radiusMeters: Math.max(ZONE_RADIUS_MIN_M, value.radiusMeters - ZONE_RADIUS_STEP_M) }, `Radius decreased to ${Math.max(ZONE_RADIUS_MIN_M, value.radiusMeters - ZONE_RADIUS_STEP_M)} metres.`)}>− 50 m</button>{' '}
        <button type="button" className="btn btn-secondary" onClick={() => apply({ ...value, radiusMeters: value.radiusMeters + ZONE_RADIUS_STEP_M }, `Radius increased to ${value.radiusMeters + ZONE_RADIUS_STEP_M} metres.`)}>+ 50 m</button>{' '}
        <button type="button" className="btn btn-secondary" onClick={() => apply({ ...value, radiusMeters: suggestedRadius }, 'Zone size reset to the suggested size.')}>Reset to suggested size</button>
      </p>
      <p><button type="button" className="btn btn-secondary" onClick={undo} disabled={history.length === 0}>Undo last map change (U)</button></p>

      <h3>No-go areas</h3>
      <p className="small">Draw the places players must stay out of — roads, water, private land, construction. Turn on no-go mode, then tap the map to drop a no-go circle. Each circle is about 50 m across. They are drawn shapes on the map — not a typed list of names.</p>
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
              <button type="button" className="btn btn-secondary" onClick={() => apply({ ...value, noGoAreas: value.noGoAreas.filter((_, j) => j !== i) }, `Removed no-go area ${i + 1}.`)}>Remove</button>
            </li>
          );
        })}</ul>
      )}

      <h3>Save as preset</h3>
      {savedPresets.length === 0 ? <p className="small">No saved presets yet — your first setup can be saved here.</p> : (
        <p>{savedPresets.map((n) => <button key={n} type="button" className="btn btn-secondary" onClick={() => loadPreset(n)}>{n}</button>)} </p>
      )}
      <label className="label" htmlFor="preset-name">Preset name (max 30 characters)</label>
      <input id="preset-name" className="input" value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={30} />
      <p><button type="button" className="btn btn-secondary" onClick={savePreset}>Save this zone as a preset</button></p>
      {presetMsg ? <p role="status">{presetMsg}</p> : null}
    </div>
  );
}
