# Map + location probes — 2026-11-17

Evidence base for the PUSH HARD map/location fix. All probes run with
`curl` from this VM (reads work; shell writes flap — see DECISIONS.md).
Tile coordinates: ocean tile z14/8192/8192; Ranchi land tile z14
x12074 y7098 (lat 23.35, lng 85.32); probe tile London z10 x511 y340.

**Status codes LIE for tiles.** Esri and OSM both return HTTP 200 for
a placeholder/block image. Only content checks work: byte-equality
across adjacent tiles at the same zoom (identical = placeholder/block
image; different = real map data).

## Providers tried

| Provider | URL probed | Status | Bytes | Verdict |
| --- | --- | --- | --- | --- |
| OpenFreeMap style liberty | `https://tiles.openfreemap.org/styles/liberty` | 200 | 43,311 | REAL style JSON |
| OpenFreeMap style bright | `https://tiles.openfreemap.org/styles/bright` | 200 | 48,762 | REAL style JSON |
| OpenFreeMap TileJSON | `https://tiles.openfreemap.org/planet` | 200 | — | REAL — tiles template `https://tiles.openfreemap.org/planet/20261115_080022_pt/{z}/{x}/{y}.pbf` (versioned, dated per planet build) |
| OpenFreeMap unversioned tile | `/planet/14/8192/8192.pbf` | 200 | 0 | DEAD — empty |
| OpenFreeMap unversioned tile (Ranchi) | `/planet/14/12074/7098.pbf` | 200 | 4 (0 on re-download) | DEAD — empty |
| OpenFreeMap VERSIONED tile (Ranchi) | `/planet/20261115_080022_pt/14/12074/7098.pbf` | 200 | 36,983 | REAL — real map data |
| OpenFreeMap VERSIONED tile (Ranchi z10) | `/planet/20261115_080022_pt/10/…` | 200 | 30,915 | REAL |
| Esri World Street Map | `server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/14/7098/12074` | 200 | 2,521 | PLACEHOLDER — grey JPEG "Map data not yet available" (same file for Street/Imagery/Dark Gray; same-zoom neighbours byte-identical) |
| Esri World Imagery | same host, `World_Imagery` | 200 | 2,521 | PLACEHOLDER — same file |
| Esri Canvas Dark Gray | same host, `Canvas/World_Dark_Gray_Base` | 200 | 2,521 | PLACEHOLDER — same file |
| OSM main | `tile.openstreetmap.org/14/12074/7098.png` | 200 | 6,725 | BLOCKED — PNG "403 Access blocked — App is not following the tile usage policy" |
| OSM France | `tile.openstreetmap.fr/osmfr/14/12074/7098.png` | 404 | 153 | DEAD |
| OSM HOT | `tile.openstreetmap.fr/hot/14/12074/7098.png` | 404 | 157 | DEAD |
| Wikimedia | `maps.wikimedia.org/osm-intl/14/12074/7098.png` | 200 | 3,569 | DEAD — HTML "Wikimedia Error" page |
| OSM.de | `tile.openstreetmap.de/14/12074/7098.png` | 200 | 324 | DEAD — HTML |
| wmflabs | `tiles.wmflabs.org/osm/14/12074/7098.png` | 200 | 324 | DEAD — HTML (identical to OSM.de) |
| openstreetmap.bzh | `tile.openstreetmap.bzh/br/14/12074/7098.png` | 200 | 324 | DEAD — HTML |
| CARTO | `basemaps.cartocdn.com` | — | — | REJECTED — stamps "API KEY REQUIRED" watermark on keyless tiles since 26 Aug 2026 |

Retrying all candidates with a Chrome Android User-Agent changed
NOTHING (same bytes/hashes) — blocking is IP-based, not UA-based.

## Cross-tile detector (validated)

- Esri same-zoom neighbours byte-identical (placeholder, 2,521 B each).
- OpenFreeMap versioned neighbours differ (36,983 B vs 46,662 B).
- Rule: fetch 2 adjacent land tiles; byte-identical → placeholder/block
  image; different → real. Placeholder hash VARIES by zoom (z10 tile
  sha `f332546b…` ≠ z14 `9eafd300…`), so exact-hash detection is INVALID.

## What the code does with this (runtime, not hardcoded)

- `apps/web/src/components/map/maplibre.ts`:
  `probeOpenFreeMap(styleUrl)` follows style → vector source (`tiles[]`
  used directly, or `url` → TileJSON fetched → `tiles[0]`) → one real
  tile from the resolved template; true only for OK + non-empty bytes.
  The version string is read from the TileJSON at runtime, never
  hardcoded. Probe tile is a FIXED land tile (London z10 x511 y340 —
  a tile that must carry features; never the user's location; an ocean
  tile can be legitimately near-empty and would read as a dead provider).
  `probeRasterProvider(template)` fetches two adjacent land tiles and
  returns `'real'` | `'placeholder'` | `'error'`. `resolvedStyle(id)`
  tries OpenFreeMap styles in order (standard: liberty, bright,
  positron; dark: dark, fiord; high-contrast: positron, bright) and
  falls back to the Esri street raster style when none probes real.
  `loadMapLibre()` tries bundled → jsDelivr → unpkg (same pinned
  version 5.24.1).
- `apps/web/src/components/map/MapLibreMapView.tsx`: map created with
  the probed style; a 10 s post-load watchdog switches to Esri street
  raster when 3+ tile errors happened and `areTilesLoaded()` is still
  false; vector sources only count toward "tiles loaded" (the old bug:
  GeoJSON overlay sources loaded instantly and suppressed the fallback).
- `apps/web/src/components/map/LeafletMapView.tsx` and
  `apps/web/src/components/host-setup/PlayAreaMap.tsx`: adaptive
  probe chain — candidates [Esri World Street Map, Esri World Imagery,
  Esri Dark Gray]; applies the first that probes 'real'; none → honest
  error banner + Retry (which re-probes). OSM main / OSM France are
  NOT in the chain (403 / 404, verified above).
- **Conclusion from this network: versioned OpenFreeMap is the ONLY
  provider serving real map data here.** Esri works on the founder's
  phone (verified real Ranchi streets) but NOT from this VM — kept as
  fallback, with the placeholder detected at runtime.

## Location — staged chain (implemented 2026-11-17)

`apps/web/src/lib/geolocation.ts` — `getCurrentFix` runs, in order:
0. permission check via `navigator.permissions.query` (2 s cap) —
   denied skips GPS entirely, no spinner;
1. high-accuracy `watchPosition`, 12 s — resolve on first GOOD fix
   (≤10 m), track best throughout;
2. high-accuracy one-shot `getCurrentPosition`, 10 s;
3. low-accuracy one-shot, 15 s;
4. cached one-shot (`maximumAge` 5 min), 8 s — accepted only ≤50 m.
Global deadline 45 s settles with the best fix (if ≤50 m) or the
plain-language timeout help. Each stage has its own timeout, so a
hanging method is abandoned and the next takes over. Static-provider
short-circuit: consecutive stages returning the IDENTICAL fix
(same lat/lng/accuracy) settle immediately — the provider has one fix
to give. `retryLocation()` force-resets (attempt token, watch id,
best fix) and restarts from the permission check. `getBestCoarseFix()`
exposes the best coarse fix for the "Use this approximate spot" offer
(host chooses it as a hand-placed pin, labelled approximate, never
applied silently). `pos.timestamp` is used for the fix `at` (sane
range, else now) so a cached fix shows its true age.

## Approaches tried and kept / dropped

- KEPT: OpenFreeMap vector via versioned tile path (read from TileJSON
  at runtime); Esri raster as fallback with placeholder detection;
  MapLibre primary, Leaflet fallback for WebGL-less devices; staged
  location chain; manual pin (tap/drag) as the primary path when GPS
  is denied or blocked.
- DROPPED: unversioned OpenFreeMap tile path (200/0 B — dead); OSM
  main (403 block image); OSM France / HOT (404); Wikimedia, OSM.de,
  wmflabs, openstreetmap.bzh (HTML error pages); CARTO (API-key
  watermark); Google Maps (founder-cancelled, 2026-11-17 — see
  DECISIONS.md); Mapbox/MapTiler (not used, per founder steer);
  hardcoding the OpenFreeMap version string (must come from TileJSON).

## NOT live-verified in a browser (2026-11-17)

Chromium cannot start on this VM (memfd `MAP_SHARED` mmap EPERM →
SIGTRAP at startup, both Playwright builds and /opt/meta-chromium).
The probe/adaptive-chain/staged-chain code is complete but NOT proven
in a live browser in this session. Do NOT call the map "fixed" until
tiles paint AND a location flow delivers a fix or a clear pin fallback
in a live browser.

## OFFLINE MAP — founder decision, 2026-11-17 19:34 IST (SUPERSEDES the adaptive chain above)

Founder: "NO fallback/switcher/reload, NO lat/lng in UI — ONE simple
working map, downloaded offline and bundled in the app, covering
Doranda + Hinoo, Ranchi, Jharkhand, for now. GPS works on the
downloaded map (device GPS is independent of tiles). Complete the
game on this offline map; full live map service is a SEPARATE later
task."

- Pack: `apps/web/scripts/download-offline-map.mjs` →
  `apps/web/public/offline-map/` — 17 vector tiles z10–z14, Liberty
  style rewritten to local paths, 4 sprite files, 18 Noto Sans glyph
  files, manifest.json — 41 files, 2.6 MB, ZERO 0-byte files
  (verified on disk 2026-11-17).
- KEY FINDING: the OpenFreeMap planet TileJSON declares `maxzoom: 14`
  — tiles above z14 are legitimately empty (HTTP 200, 0 bytes) and
  MapLibre overzooms the z14 tiles for closer zooms, exactly as the
  live service does. Verified: z13/z14 Ranchi tiles 47,719 /
  46,662 B real; z15/z16 0 B. The first downloader run (z10–z16)
  wasted time failing z15/z16 fetches before this was found.
- The adaptive probe chain, Esri fallback, Leaflet view, style
  toggle, retry buttons, and the accessibility "Map style" select
  are all DELETED — there is exactly one map, the bundled one.
- The MapLibre JS library itself still loads from the pinned
  jsDelivr/unpkg build until `npm install maplibre-gl@5.24.1` lands
  (blocked by the VM's EPERM write flapping); the MAP (tiles, style,
  glyphs, sprites) is fully bundled. When the package is installed
  the bundled import wins and no CDN is fetched at all.
- Still NOT live-verified in a browser (Chromium down). The pack is
  verified on disk and the code typechecks; painting in a live
  browser is unproven — do NOT call the map "fixed" until tiles
  paint in a live browser.
