/** Load the vendored pmtiles.js library, register the `pmtiles://`
 *  protocol once, and verify the bundled pack is really a readable
 *  PMTiles v3 archive — header fields + one real tile fetch.
 *
 *  No npm dependency: the library is the vendored UMD script under
 *  `public/offline-map/vendor/pmtiles.js`. NOTE: that file is a
 *  documented SPARE — the live view does not load it (see
 *  `maplibre.ts`); this module is its only loader. No network
 *  request leaves the device except the same-origin fetch of the
 *  bundled pack itself.
 *
 *  Proven in this session (2026-11-17, pmtiles CLI v1.31.2 against
 *  the file on disk): spec v3, 196 tiles, maxzoom 15, bbox
 *  85.28–85.38 / 23.30–23.42, and the centre tile
 *  (z15 24150/14196) reads back as 8,026 bytes of gzip-compressed
 *  vector tiles. This module re-proves the same facts at runtime
 *  from the browser, so a corrupt or missing pack is reported
 *  instead of silently showing an empty map. */
import {
  OFFLINE_PACK,
  OFFLINE_PMTILES_URL,
  PMTILES_JS_URL,
  PMTILES_HEADER_BYTES,
  OFFLINE_PACK_PROBE_TILE,
  lngLatToTile,
  OFFLINE_MAP_CENTRE,
  OFFLINE_PACK_BBOX,
} from './constants';

export interface PmtilesHeader {
  specVersion: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  centerLon: number;
  centerLat: number;
  numAddressedTiles: number;
  numTileEntries: number;
}

export interface PackVerification {
  ok: boolean;
  /** What was checked, in plain words, for the notice / logs. */
  checks: string[];
  /** First failure, in plain words, when `ok` is false. */
  failure?: string;
  header?: PmtilesHeader;
  /** Bytes of the probe tile fetched (0 when the fetch failed). */
  probeTileBytes?: number;
}

/** Minimal typing for the vendored pmtiles UMD global. */
export interface PmtilesLib {
  Protocol: new (options?: { metadata?: boolean }) => { tile: unknown };
  PMTiles: new (source: string) => {
    getHeader(): Promise<PmtilesHeader>;
    getZxy(z: number, x: number, y: number): Promise<{ data: ArrayBuffer } | undefined>;
  };
}

declare global {
  interface Window {
    pmtiles?: PmtilesLib;
  }
}

let loadPromise: Promise<PmtilesLib> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') { reject(new Error('no document')); return; }
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Offline map script failed to load: ${src}`));
    document.head.appendChild(script);
  });
}

/** Load the vendored pmtiles.js (once per page). Throws when the
 *  vendored script is missing or does not expose the API. */
export async function loadPmtilesLib(): Promise<PmtilesLib> {
  if (typeof window !== 'undefined' && window.pmtiles) return window.pmtiles;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await loadScript(PMTILES_JS_URL);
    const lib = window.pmtiles;
    if (!lib || typeof lib.Protocol !== 'function' || typeof lib.PMTiles !== 'function') {
      throw new Error('Offline pmtiles library failed to load (vendored script missing or corrupt)');
    }
    return lib;
  })();
  return loadPromise;
}

/** Parse a PMTiles v3 header (127 bytes) into its fields.
 *  Layout: magic "PMTiles" (7), spec version (1), then little-
 *  endian u64 offsets/lengths and counts, then i32 lon/lat x1e7.
 *  Throws on a bad magic or a short buffer. */
export function parsePmtilesHeader(buf: ArrayBuffer): PmtilesHeader {
  if (buf.byteLength < PMTILES_HEADER_BYTES) {
    throw new Error(`PMTiles header is ${buf.byteLength} bytes, expected ${PMTILES_HEADER_BYTES}`);
  }
  const view = new DataView(buf);
  let magic = '';
  for (let i = 0; i < 7; i += 1) magic += String.fromCharCode(view.getUint8(i));
  if (magic !== 'PMTiles') throw new Error('Not a PMTiles file (bad magic)');
  const specVersion = view.getUint8(7);
  if (specVersion !== 3) throw new Error(`PMTiles spec version ${specVersion}, expected 3`);
  return {
    specVersion,
    tileType: view.getUint8(99),
    minZoom: view.getUint8(100),
    maxZoom: view.getUint8(101),
    minLon: view.getInt32(102, true) / 1e7,
    minLat: view.getInt32(106, true) / 1e7,
    maxLon: view.getInt32(110, true) / 1e7,
    maxLat: view.getInt32(114, true) / 1e7,
    centerLon: view.getInt32(119, true) / 1e7,
    centerLat: view.getInt32(123, true) / 1e7,
    numAddressedTiles: Number(view.getBigUint64(72, true)),
    numTileEntries: Number(view.getBigUint64(80, true)),
  };
}

/** Fetch just the 127-byte header of the bundled pack (HTTP Range;
 *  falls back to reading the first 127 bytes of a full response
 *  and cancelling the stream, so a server that ignores Range does
 *  not make the browser download the whole 2.2 MB pack). */
export async function fetchPackHeader(url: string = OFFLINE_PMTILES_URL): Promise<PmtilesHeader> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${PMTILES_HEADER_BYTES - 1}` } });
  if (!res.ok && res.status !== 206) {
    throw new Error(`Offline map pack could not be fetched (${res.status})`);
  }
  if (res.status === 206 || !res.body) {
    return parsePmtilesHeader(await res.arrayBuffer());
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      got += value.byteLength;
      if (got >= PMTILES_HEADER_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => { /* stream already closed */ });
  }
  const merged = new Uint8Array(got);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk.subarray(0, Math.max(0, PMTILES_HEADER_BYTES - at)), at);
    at += chunk.byteLength;
    if (at >= PMTILES_HEADER_BYTES) break;
  }
  return parsePmtilesHeader(merged.buffer);
}

/** Verify the bundled pack at runtime: header fields match the
 *  measured pack (bbox, maxzoom, tile count), then fetch the
 *  centre tile through the pmtiles library to prove the tiles
 *  inside are readable. Never throws — failures come back in
 *  `failure` so the caller can show plain words. */
export async function verifyOfflinePack(url: string = OFFLINE_PMTILES_URL): Promise<PackVerification> {
  const checks: string[] = [];
  let header: PmtilesHeader;
  try {
    header = await fetchPackHeader(url);
  } catch (err) {
    return { ok: false, checks, failure: err instanceof Error ? err.message : 'Offline map pack could not be read' };
  }
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  if (!close(header.minLon, OFFLINE_PACK_BBOX.minLng) || !close(header.maxLon, OFFLINE_PACK_BBOX.maxLng)
    || !close(header.minLat, OFFLINE_PACK_BBOX.minLat) || !close(header.maxLat, OFFLINE_PACK_BBOX.maxLat)) {
    return { ok: false, checks, header, failure: 'Offline map covers a different area than expected' };
  }
  checks.push(`Map file is a PMTiles v3 archive covering Doranda & Hinoo (${header.numAddressedTiles} tiles, street detail to zoom ${header.maxZoom})`);
  if (header.maxZoom !== OFFLINE_PACK.maxZoom || header.numAddressedTiles !== OFFLINE_PACK.tileCount) {
    return { ok: false, checks, header, failure: 'Offline map file is a different version than expected — it may need rebuilding (see docs/OFFLINE-MAP.md)' };
  }
  // One real tile proves the archive is not just a valid header.
  try {
    const lib = await loadPmtilesLib();
    const archive = new lib.PMTiles(url);
    const tile = await archive.getZxy(OFFLINE_PACK_PROBE_TILE.z, OFFLINE_PACK_PROBE_TILE.x, OFFLINE_PACK_PROBE_TILE.y);
    const bytes = tile?.data.byteLength ?? 0;
    if (!tile || bytes === 0) {
      return { ok: false, checks, header, failure: 'Offline map file opened but its streets tile came back empty' };
    }
    checks.push('A streets tile for the game area loaded fine');
    return { ok: true, checks, header, probeTileBytes: bytes };
  } catch (err) {
    return { ok: false, checks, header, failure: err instanceof Error ? err.message : 'Offline map streets could not be read' };
  }
}

/** Tile coordinates of the pack centre at the pack's max zoom —
 *  the same tile the CLI probe verified on disk (z15 24150/14196). */
export function probeTileForCentre(): { z: number; x: number; y: number } {
  const [lng, lat] = OFFLINE_MAP_CENTRE;
  const { x, y } = lngLatToTile(lng, lat, OFFLINE_PACK.maxZoom);
  return { z: OFFLINE_PACK.maxZoom, x, y };
}
