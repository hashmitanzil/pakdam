/** Offline-map constants — PMTiles pack for Doranda + Hinoo, Ranchi.
 *
 *  READ FIRST — what is live vs what this module is:
 *  The live map view (`MapLibreMapView`) uses the BUNDLED ESRI
 *  RASTER tiles (`public/offline-map/tiles/`, 808 JPEGs, zooms
 *  12–17, bbox 23.325–23.38 N / 85.285–85.355 E), by the
 *  2026-11-17 reconciliation recorded in `maplibre.ts`: the
 *  PMTiles wiring was half-done and its vendored glyphs were never
 *  copied (`public/offline-map/fonts/` does not exist), so its
 *  labels could never render. The PMTiles file
 *  (`public/offline-map/ranchi.pmtiles`) remains on disk as a
 *  DOCUMENTED SPARE — nothing in `src/` loads it.
 *
 *  This module is the PMTiles-based offline layer the task brief
 *  asked for: loading, header checks, a local tile cache, the
 *  online/offline mode decision, and the notice component. It is
 *  STANDALONE — it is not wired into the live view, and no
 *  existing file was changed to add it. Promoting the PMTiles
 *  pack to the live map (or wiring the mode switch in) needs a
 *  founder decision, and the glyphs must be restored first.
 *
 *  MEASURED pack (verified 2026-11-17 in this session, see
 *  `docs/OFFLINE-MAP.md` for the full evidence):
 *  - file: `apps/web/public/offline-map/ranchi.pmtiles`
 *  - size: 2,226,722 bytes (~2.2 MB), md5
 *    9d99b0d4865496f73e230a9d92aa525e
 *  - PMTiles spec v3, 196 addressed tiles, maxzoom 15,
 *    bbox 85.28–85.38 E, 23.30–23.42 N (WIDER than the live
 *    raster bbox), OSM data to 2026-11-17T04:00:00Z (Protomaps
 *    daily build 20261117).
 *  A fresh `--dry-run` extract against the same build measured
 *  the same: 196 tiles, 2.2 MB archive. Raising --maxzoom to 17
 *  adds nothing — the source build's maxzoom for this data is 15.
 *
 *  Values below that also exist in `maplibre.ts` are defined
 *  HERE for the PMTiles pack, not imported from it — the live
 *  file's constants now describe the raster bundle (different
 *  bbox, zooms 12–17, Esri attribution), and importing them
 *  would silently describe the wrong pack. */
import {
  OFFLINE_MAP_CENTRE,
  OFFLINE_VENDOR_BASE,
  OFFLINE_MAP_AREA_MESSAGE,
  OUTSIDE_MAP_AREA_MESSAGE,
} from '../../components/map/maplibre';

export {
  OFFLINE_MAP_CENTRE,
  OFFLINE_VENDOR_BASE,
  OFFLINE_MAP_AREA_MESSAGE,
  OUTSIDE_MAP_AREA_MESSAGE,
};

/** The PMTiles pack's own bbox (wider than the live raster bbox
 *  23.325–23.38 / 85.285–85.355). Do not use the live view's
 *  `OFFLINE_MAP_BBOX` here — it describes the raster tiles. */
export const OFFLINE_PACK_BBOX = {
  minLat: 23.30, maxLat: 23.42, minLng: 85.28, maxLng: 85.38,
} as const;

/** Attribution for the PMTiles pack's OSM data (from the pack's
 *  own metadata: "© OpenStreetMap"). NOT the live view's Esri
 *  attribution. */
export const OFFLINE_PMTILES_ATTRIBUTION = '© OpenStreetMap contributors';

/** The spare PMTiles file, served by Next.js from `public/`. */
export const OFFLINE_PMTILES_URL = '/offline-map/ranchi.pmtiles';

/** The bundled pack, as measured on disk (see header comment). */
export const OFFLINE_PACK = {
  /** Served by Next.js from `apps/web/public/offline-map/`. */
  url: OFFLINE_PMTILES_URL,
  /** Bytes, measured 2026-11-17 (`stat` + `md5sum` + `pmtiles show`). */
  bytes: 2226722,
  md5: '9d99b0d4865496f73e230a9d92aa525e',
  /** PMTiles spec version in the file header. */
  specVersion: 3,
  /** Addressed tiles in the file header (`numAddressedTiles`). */
  tileCount: 196,
  /** Highest zoom stored in the pack. Closer zooms overzoom z15. */
  maxZoom: 15,
  /** OSM replication timestamp recorded in the pack metadata. */
  osmDataTo: '2026-11-17T04:00:00Z',
  /** Protomaps daily build the pack was extracted from. */
  sourceBuild: '20261117',
} as const;

/** True when a fix sits inside the PMTiles pack's area (wider
 *  than the live raster area — see `OFFLINE_PACK_BBOX`). */
export function isInsidePmtilesPack(lat: number, lng: number): boolean {
  return lat >= OFFLINE_PACK_BBOX.minLat && lat <= OFFLINE_PACK_BBOX.maxLat
    && lng >= OFFLINE_PACK_BBOX.minLng && lng <= OFFLINE_PACK_BBOX.maxLng;
}

/** Vendored pmtiles.js (UMD) — local file only, never a CDN. */
export const PMTILES_JS_URL = `${OFFLINE_VENDOR_BASE}/pmtiles.js`;
/** The 127-byte PMTiles v3 header. */
export const PMTILES_HEADER_BYTES = 127;

/** A tile that must exist in the pack: the z15 tile over Doranda
 *  (the pack centre). Used as the readability probe. */
export const OFFLINE_PACK_PROBE_TILE = { z: 15, x: 24150, y: 14196 } as const;

/** One online candidate: either a raster tile template or a
 *  vector style URL. Explicit union (not `as const`) so the
 *  `'tileTemplate' in …` narrowing in `mode.ts` works. */
export type OnlineMapCandidate =
  | { id: string; label: string; tileTemplate: string; attribution: string }
  | { id: string; label: string; styleUrl: string; attribution: string };

/** Online candidates, in order, for the SEPARATE live-map task.
 *  NOT used by the live view today (bundled raster only, founder
 *  decision). URLs are copied verbatim from the repo's own probe
 *  record (`docs/MAP-LOCATION-PROBES.md:17-19`, 200 responses
 *  measured there) and from the bundled raster manifest — not
 *  guessed. Esri is first: it was the provider verified painting
 *  real Ranchi streets on the founder's phone (2026-11-17);
 *  OpenFreeMap's unversioned tile path returned HTTP 200 with
 *  0-byte tiles, so only its versioned style URLs are listed. */
export const ONLINE_MAP_CANDIDATES: OnlineMapCandidate[] = [
  {
    id: 'esri-raster',
    label: 'Esri World Street Map (raster)',
    /** Raster tile template from `public/offline-map/manifest.json`. */
    tileTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS user community',
  },
  {
    id: 'openfreemap-liberty',
    label: 'OpenFreeMap Liberty (vector)',
    /** Style JSON; the tiles it points at are versioned per build. */
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: '© OpenStreetMap contributors',
  },
  {
    id: 'openfreemap-bright',
    label: 'OpenFreeMap Bright (vector)',
    styleUrl: 'https://tiles.openfreemap.org/styles/bright',
    attribution: '© OpenStreetMap contributors',
  },
];

/** How long to wait for the online reachability probe before
 *  treating the network as unusable for maps. This is a CHOSEN
 *  default for this module, not a measured value — it is not a
 *  gameplay or safety threshold. */
export const ONLINE_PROBE_TIMEOUT_MS = 5000;

/** Human-readable byte size, e.g. 2226722 -> "2.2 MB". Decimal
 *  (1000-based) so it matches the `pmtiles` CLI and the docs,
 *  which both report this pack as 2.2 MB. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return 'unknown size';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit] as string}`;
}

/** Slippy-map tile coordinates for a lng/lat at a zoom. */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}
