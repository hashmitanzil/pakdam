/** Local tile cache for the offline map (Cache Storage API).
 *
 *  The bundled PMTiles file is already a local file served by the
 *  app, so the map works offline without any cache. This cache
 *  exists for the two things that are NOT bundled today:
 *  (1) the online style JSONs / tiles a host loads while they DO
 *  have internet, so the map keeps working if the connection
 *  drops mid-game; (2) a record of how much map data is stored
 *  on the device, in plain words (the `OfflineMapNotice` component
 *  that used to show it was deleted 2026-11-18 — never rendered).
 *
 *  Cache Storage is the same store the PWA service worker uses,
 *  and it survives page reloads. Everything here is browser-only
 *  and no-ops (returns `supported: false`) on the server or in a
 *  browser without the Cache API. Nothing here downloads tiles
 *  in bulk from a live provider — entries are only added for URLs
 *  the map actually requested, one at a time. */
import { OFFLINE_PMTILES_URL, formatBytes } from './constants';

export const OFFLINE_MAP_CACHE_NAME = 'pakdam-offline-map-v1';

export interface CacheEntryInfo {
  url: string;
  bytes: number | null;
}

export interface CacheStatus {
  supported: boolean;
  /** Number of stored responses (0 when unsupported/empty). */
  entries: number;
  /** Total stored bytes, or null when sizes could not be read. */
  bytes: number | null;
  /** True when the bundled PMTiles file itself is in the cache. */
  packCached: boolean;
  entryList: CacheEntryInfo[];
}

function cacheApi(): CacheStorage | null {
  if (typeof window === 'undefined') return null;
  if (!('caches' in window)) return null;
  return window.caches;
}

/** Store one response (by URL) in the map cache. Returns false
 *  when caching is unavailable or the fetch failed — the caller
 *  carries on without a cached copy. */
export async function cacheUrl(url: string): Promise<boolean> {
  const api = cacheApi();
  if (!api) return false;
  try {
    const cache = await api.open(OFFLINE_MAP_CACHE_NAME);
    const res = await fetch(url);
    if (!res.ok) return false;
    await cache.put(url, res);
    return true;
  } catch {
    return false;
  }
}

/** Store the bundled PMTiles pack itself in the cache, so the
 *  "how much is cached" number in the notice includes it. */
export async function cacheOfflinePack(): Promise<boolean> {
  return cacheUrl(OFFLINE_PMTILES_URL);
}

/** How much map data is stored on this device right now. Sizes
 *  are read from the stored responses themselves (no invented
 *  numbers): a response whose size cannot be read counts as
 *  `bytes: null` for that entry and is left out of the total. */
export async function cacheStatus(): Promise<CacheStatus> {
  const api = cacheApi();
  if (!api) return { supported: false, entries: 0, bytes: null, packCached: false, entryList: [] };
  try {
    const cache = await api.open(OFFLINE_MAP_CACHE_NAME);
    const keys = await cache.keys();
    const entryList: CacheEntryInfo[] = [];
    let total: number | null = 0;
    let packCached = false;
    for (const request of keys) {
      const res = await cache.match(request);
      if (!res) continue;
      if (request.url.endsWith(OFFLINE_PMTILES_URL)) packCached = true;
      let size: number | null = null;
      try {
        size = (await res.clone().blob()).size;
      } catch {
        size = null;
      }
      if (size == null) total = null;
      else if (total != null) total += size;
      entryList.push({ url: request.url, bytes: size });
    }
    return { supported: true, entries: entryList.length, bytes: total, packCached, entryList };
  } catch {
    return { supported: false, entries: 0, bytes: null, packCached: false, entryList: [] };
  }
}

/** Remove everything this module cached. The bundled pack file
 *  itself is untouched (it ships with the app); only the extra
 *  cached copies are cleared. */
export async function clearMapCache(): Promise<boolean> {
  const api = cacheApi();
  if (!api) return false;
  try {
    return await api.delete(OFFLINE_MAP_CACHE_NAME);
  } catch {
    return false;
  }
}

/** One plain-language line for the notice, e.g.
 *  "2.2 MB of map saved on this device". */
export function cachedSizeLine(status: CacheStatus): string {
  if (!status.supported) return 'Map saving is not available in this browser.';
  if (status.entries === 0) return 'No map saved on this device yet.';
  if (status.bytes == null) return `${status.entries} map file${status.entries === 1 ? '' : 's'} saved on this device.`;
  return `${formatBytes(status.bytes)} of map saved on this device.`;
}
