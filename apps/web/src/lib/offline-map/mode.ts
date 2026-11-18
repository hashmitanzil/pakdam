/** Online / offline mode decision for the map.
 *
 *  IMPORTANT — read before wiring this in: the live view today
 *  uses the BUNDLED ESRI RASTER tiles and is OFFLINE-ONLY by
 *  founder decision (2026-11-17 19:34 IST: "NO fallback/switcher/
 *  reload — ONE simple working map, downloaded offline"). The
 *  PMTiles file this module is built around is a documented SPARE
 *  on disk, not the live path. This module implements the switch
 *  the task brief asked for as a standalone, testable decision —
 *  it is NOT wired into `MapLibreMapView` or any other view, and
 *  no existing file was changed to add it. Wiring it in (or
 *  promoting the PMTiles pack to the live map) reintroduces a map
 *  switcher and needs a founder decision of its own — and the
 *  vendored glyphs must be restored first, or the PMTiles map
 *  will have no labels. The full live map service is a SEPARATE
 *  later task.
 *
 *  Fallback order this module implements (for that later task):
 *    1. online — Esri World Street Map, then OpenFreeMap Liberty,
 *       then OpenFreeMap Bright (see `ONLINE_MAP_CANDIDATES`);
 *    2. offline — the PMTiles pack (Doranda + Hinoo), used
 *       whenever the network is down or the online probe fails;
 *    3. offline-only — the PMTiles pack is the ONLY map (the
 *       analogue of the live view's current raster-only
 *       behaviour; no online attempt is made at all);
 *    4. unavailable — the pack failed verification AND no online
 *       map could be reached: plain words, no blank map, the
 *       pin/zone flow still works.
 *
 *  GPS is independent of all of this: the device GPS fix works
 *  on the downloaded map with no network (founder note). */
import {
  ONLINE_MAP_CANDIDATES,
  ONLINE_PROBE_TIMEOUT_MS,
  OFFLINE_PMTILES_URL,
  OFFLINE_PMTILES_ATTRIBUTION,
} from './constants';
import { verifyOfflinePack } from './pmtiles-loader';

export type MapMode = 'online' | 'offline' | 'offline-only' | 'unavailable';

export interface MapSource {
  kind: 'pmtiles' | 'online-style' | 'online-raster';
  /** What the view should load: a `pmtiles://` URL, a style JSON
   *  URL, or a raster tile template. */
  url: string;
  label: string;
  attribution: string;
}

export interface ModeDecision {
  mode: MapMode;
  /** The map source to use for this mode. */
  source: MapSource;
  /** Plain-words reason, for the notice / logs. */
  reason: string;
  /** True when the bundled pack verified OK. */
  packOk: boolean;
}

export const OFFLINE_ONLY_SOURCE: MapSource = {
  kind: 'pmtiles',
  url: `pmtiles://${OFFLINE_PMTILES_URL}`,
  label: 'Downloaded map — Doranda & Hinoo, Ranchi',
  attribution: OFFLINE_PMTILES_ATTRIBUTION,
};

function onlineSource(): MapSource {
  const first = ONLINE_MAP_CANDIDATES[0];
  if (!first) {
    return { kind: 'online-style', url: '', label: 'Live map', attribution: OFFLINE_PMTILES_ATTRIBUTION };
  }
  if ('tileTemplate' in first) {
    return { kind: 'online-raster', url: first.tileTemplate, label: first.label, attribution: first.attribution };
  }
  return { kind: 'online-style', url: first.styleUrl, label: first.label, attribution: first.attribution };
}

/** One small probe of the first online candidate: a GET that
 *  times out after `ONLINE_PROBE_TIMEOUT_MS` (a chosen default,
 *  not a measured value). Any 2xx response counts as "online".
 *  Returns false offline, on timeout, or on any error — the
 *  caller then uses the offline pack instead of failing. */
export async function probeOnline(timeoutMs: number = ONLINE_PROBE_TIMEOUT_MS): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const first = ONLINE_MAP_CANDIDATES[0];
  const url = first && 'styleUrl' in first
    ? first.styleUrl
    : 'https://tiles.openfreemap.org/styles/liberty';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Decide which map to show. `offlineOnly: true` (the default)
 *  reproduces offline-only behaviour (never attempts the network)
 *  with the PMTiles pack as the offline source — the analogue of
 *  the live view's current raster-only behaviour, NOT the live
 *  view itself. With `offlineOnly: false` (the later live-map
 *  task), the online probe runs first and the pack is the
 *  fallback. The pack is verified in both cases, so a corrupt
 *  pack is reported rather than shown as an empty map. */
export async function decideMapMode(options?: { offlineOnly?: boolean }): Promise<ModeDecision> {
  const offlineOnly = options?.offlineOnly ?? true;
  const pack = await verifyOfflinePack();
  if (offlineOnly) {
    if (pack.ok) {
      return { mode: 'offline-only', source: OFFLINE_ONLY_SOURCE, reason: 'Using the downloaded map — no live map is used.', packOk: true };
    }
    return {
      mode: 'unavailable',
      source: OFFLINE_ONLY_SOURCE,
      reason: pack.failure ?? 'The downloaded map could not be loaded.',
      packOk: false,
    };
  }
  if (await probeOnline()) {
    return { mode: 'online', source: onlineSource(), reason: 'Internet is available — using the live map.', packOk: pack.ok };
  }
  if (pack.ok) {
    return { mode: 'offline', source: OFFLINE_ONLY_SOURCE, reason: 'No internet right now — using the downloaded map.', packOk: true };
  }
  return {
    mode: 'unavailable',
    source: OFFLINE_ONLY_SOURCE,
    reason: pack.failure ?? 'No internet and the downloaded map could not be loaded.',
    packOk: false,
  };
}
