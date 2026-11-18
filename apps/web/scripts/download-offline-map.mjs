// Verify (and document how to refresh) the Pakdam OFFLINE map pack.
// Node CLI script — runs under node, not in the browser.
/* global console, process */
//
// Founder decision (2026-11-17 19:34 IST): ONE simple working map,
// downloaded offline and bundled in the app, covering Doranda + Hinoo,
// Ranchi, Jharkhand, for now. NO fallback / switcher / reload. GPS
// works on the downloaded map (device GPS is independent of tiles).
// The full live map service is a SEPARATE later task.
//
// LANDED APPROACH (2026-11-17, reconciliation; EXPANSION DEFERRED
// 2026-11-18): bundled Esri World Street Map raster tiles — 1,038
// JPEG tiles, zooms 12–17, bbox 23.325–23.38 N / 85.285–85.355 E,
// ~15 MB — served from `public/offline-map/tiles/{z}/{x}/{y}.jpg`
// via the MapLibre raster style `public/offline-map/style.json`
// (see `manifest.json`). A sample tile (16/48301/28392.jpg) was
// visually verified to paint REAL Ranchi streets. This replaced
// the PMTiles vector wiring, which was half-done: it needed
// vendored glyphs under `public/offline-map/fonts/` that were
// never copied, so its labels could never render. The raster style
// needs no glyphs, no pmtiles.js, no basemaps.js — just vendored
// MapLibre GL JS + local JPEG tiles, zero network requests at
// runtime. Doranda/Hinoo do not render as labels on the Esri
// tiles themselves; the app draws them (OFFLINE_AREA_LABELS in
// `maplibre.ts`, rendered by MapLibreMapView). The wider pack
// (1,918 tiles, bbox 23.30–23.405 / 85.26–85.38 at z12–16, z17
// capped to the extended core) was planned and its fetch script
// (`fetch-expanded-tiles.py`) is on disk, but the VM EPERM wave
// blocked all tile downloads before the 3:55 pm ship cutoff, so
// this 1,038-tile pack ships; the expansion follows as the
// immediate next delivery (re-run the fetch script, then restore
// the wide bbox / 1,918 counts here and in maplibre.ts).
//
// SPARE (not a live path): `public/offline-map/ranchi.pmtiles`
// (2,226,722 B, md5 9d99b0d4865496f73e230a9d92aa525e) plus
// `vendor/pmtiles.js` / `vendor/basemaps.js` stay on disk only.
// Nothing in `src/` loads them.
//
// This script does NOT download anything. It verifies the staged
// raster pack on disk (style + manifest + tile count + vendored
// MapLibre). To REFRESH the map, run
// `python3 apps/web/scripts/fetch-expanded-tiles.py` (downloads the
// Esri tiles for the wide bbox at z12–16 + the z17 core, verifies
// every tile, rewrites `manifest.json`) and replace `tiles/` +
// `manifest.json` together (keep the counts below in sync with
// the manifest).
//
// Run:  node apps/web/scripts/download-offline-map.mjs
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'offline-map');

// Doranda + Hinoo, Ranchi, Jharkhand — the raster tile bbox.
const BBOX = { minLat: 23.325, maxLat: 23.38, minLng: 85.285, maxLng: 85.355 };
const EXPECTED_TILES = 1038;
/** Planned tiles per zoom (bbox + 1-tile halo). */
const EXPECTED_PER_ZOOM = { 12: 12, 13: 20, 14: 30, 15: 80, 16: 224, 17: 672 };

const failed = [];
const ok = (rel, size) => console.log(`ok ${rel} (${size} bytes)`);

for (const rel of ['vendor/maplibre-gl.js', 'vendor/maplibre-gl.css']) {
  const path = join(OUT, rel);
  if (!existsSync(path)) { failed.push(`${rel}: MISSING`); continue; }
  const size = statSync(path).size;
  if (size === 0) { failed.push(`${rel}: 0 bytes`); continue; }
  ok(rel, size);
}

// The raster style must exist, parse, and point ONLY at local tiles.
const stylePath = join(OUT, 'style.json');
if (!existsSync(stylePath)) {
  failed.push('style.json: MISSING');
} else {
  const size = statSync(stylePath).size;
  let style;
  try {
    style = JSON.parse(readFileSync(stylePath, 'utf8'));
  } catch {
    failed.push('style.json: not valid JSON');
  }
  if (style) {
    const tiles = style.sources?.['offline-raster']?.tiles ?? [];
    if (tiles.length !== 1 || tiles[0] !== '/offline-map/tiles/{z}/{x}/{y}.jpg') {
      failed.push(`style.json: unexpected tile template ${JSON.stringify(tiles)}`);
    } else {
      ok('style.json', size);
    }
  }
}

// The manifest must exist and agree with the tiles on disk.
const manifestPath = join(OUT, 'manifest.json');
let manifestTotal = null;
let manifestPerZoom = null;
if (!existsSync(manifestPath)) {
  failed.push('manifest.json: MISSING');
} else {
  const size = statSync(manifestPath).size;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifestTotal = manifest.tiles?.total ?? null;
    manifestPerZoom = manifest.tiles?.perZoom ?? null;
    if (manifestTotal !== EXPECTED_TILES) {
      failed.push(`manifest.json: tiles.total ${manifestTotal}, expected ${EXPECTED_TILES}`);
    } else {
      ok('manifest.json', size);
    }
    const mb = manifest.bbox ?? {};
    if (mb.minLat !== BBOX.minLat || mb.maxLat !== BBOX.maxLat || mb.minLng !== BBOX.minLng || mb.maxLng !== BBOX.maxLng) {
      failed.push(`manifest.json: bbox ${JSON.stringify(mb)}, expected ${JSON.stringify(BBOX)}`);
    }
    for (const [z, expected] of Object.entries(EXPECTED_PER_ZOOM)) {
      const got = manifestPerZoom?.[z]?.total;
      if (got !== expected) failed.push(`manifest.json: perZoom z${z} total ${got}, expected ${expected}`);
    }
  } catch {
    failed.push('manifest.json: not valid JSON');
  }
}

// Count the actual tiles on disk (zooms 12–17).
let tileCount = 0;
let tileBytes = 0;
const perZoomOnDisk = {};
const tilesDir = join(OUT, 'tiles');
if (!existsSync(tilesDir)) {
  failed.push('tiles/: MISSING');
} else {
  for (const z of readdirSync(tilesDir)) {
    const zDir = join(tilesDir, z);
    if (!statSync(zDir).isDirectory()) continue;
    for (const x of readdirSync(zDir)) {
      const xDir = join(zDir, x);
      if (!statSync(xDir).isDirectory()) continue;
      for (const y of readdirSync(xDir)) {
        if (!y.endsWith('.jpg')) continue;
        tileCount += 1;
        perZoomOnDisk[z] = (perZoomOnDisk[z] ?? 0) + 1;
        tileBytes += statSync(join(xDir, y)).size;
      }
    }
  }
  console.log(`ok tiles/ (${tileCount} files, ${tileBytes} bytes)`);
  if (tileCount !== EXPECTED_TILES) {
    failed.push(`tiles/: ${tileCount} files, expected ${EXPECTED_TILES}`);
  }
  for (const [z, expected] of Object.entries(EXPECTED_PER_ZOOM)) {
    if ((perZoomOnDisk[z] ?? 0) !== expected) {
      failed.push(`tiles/: z${z} has ${perZoomOnDisk[z] ?? 0} files, expected ${expected}`);
    }
  }
  if (manifestTotal !== null && manifestTotal !== tileCount) {
    failed.push(`tiles/: manifest says ${manifestTotal}, disk has ${tileCount}`);
  }
  if (manifestPerZoom) {
    for (const [z] of Object.entries(EXPECTED_PER_ZOOM)) {
      if (manifestPerZoom[z]?.downloaded !== (perZoomOnDisk[z] ?? 0)) {
        failed.push(`tiles/: manifest perZoom z${z} downloaded ${manifestPerZoom[z]?.downloaded}, disk has ${perZoomOnDisk[z] ?? 0}`);
      }
    }
  }
}

// Spare PMTiles file: presence + size only — it is NOT loaded by src/.
const sparePath = join(OUT, 'ranchi.pmtiles');
if (!existsSync(sparePath)) {
  console.log('note ranchi.pmtiles: absent (spare only — fine, the raster pack is the live map)');
} else {
  const size = statSync(sparePath).size;
  const md5 = createHash('md5').update(readFileSync(sparePath)).digest('hex');
  console.log(`ok ranchi.pmtiles (spare, ${size} bytes, md5 ${md5})`);
  if (size !== 2226722 || md5 !== '9d99b0d4865496f73e230a9d92aa525e') {
    failed.push('ranchi.pmtiles: spare file changed (size/md5 mismatch — expected the staged 2,226,722 B file)');
  }
}

console.log(`bbox: ${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`);
if (failed.length > 0) {
  console.error(`OFFLINE MAP PACK INVALID:\n- ${failed.join('\n- ')}`);
  process.exit(1);
}
console.log('Offline map pack verified: 1,038 bundled raster tiles + vendored MapLibre, zero live tile sources.');
