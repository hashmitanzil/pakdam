# Pakdam offline map — Doranda + Hinoo, Ranchi

Founder decision (2026-11-17 19:34 IST): **ONE simple working map,
downloaded offline and bundled in the app, covering Doranda + Hinoo,
Ranchi, Jharkhand, for now. NO fallback / switcher / reload, NO lat/lng
in the UI. GPS works on the downloaded map (device GPS is independent
of tiles). Complete the game on this offline map; the full live map
service is a SEPARATE later task.**

## What is live vs what this module is — read first

The live map view (`MapLibreMapView`) uses the **bundled Esri World
Street Map raster tiles**: 808 JPEG tiles, zooms 12–17, bbox
23.325–23.38 N / 85.285–85.355 E, 11,875,846 bytes, served from
`public/offline-map/tiles/{z}/{x}/{y}.jpg` via
`public/offline-map/style.json`. That was the 2026-11-17
reconciliation recorded in `maplibre.ts`: it was chosen over the
PMTiles vector file because the PMTiles wiring was half-done and
unprovable on disk — it needed vendored glyphs under
`public/offline-map/fonts/` that were never copied (the folder does
not exist), so its labels could never render. The raster style needs
no glyphs, no pmtiles.js, no basemaps.js. A sample raster tile
(16/48301/28392.jpg) was visually verified to paint real Ranchi
streets (Konka Road, M. G. Marg, Sharad Babu Lane).

The PMTiles file (`public/offline-map/ranchi.pmtiles`) remains on
disk as a **documented SPARE** — nothing in `src/` loads it, and
the verify script (`apps/web/scripts/download-offline-map.mjs`)
reports it as spare. This module
(`apps/web/src/lib/offline-map/`) and notice component
(`apps/web/src/components/map/OfflineMapNotice.tsx`) are the
**PMTiles-based offline layer** the task brief asked for:
loading, header checks, a local tile cache, the online/offline
mode decision, and the notice. It is **STANDALONE — not wired
into the live view**, and no existing file was changed to add it.
Promoting the PMTiles pack to the live map (or wiring the mode
switch in) needs a founder decision, and the glyphs must be
restored first.

This doc states what was **measured**, how to rebuild the pack,
and what is still unproven.

## What the PMTiles pack is (measured 2026-11-17)

| Fact | Value | How it was measured |
|---|---|---|
| File | `apps/web/public/offline-map/ranchi.pmtiles` (SPARE, not the live path) | on disk |
| Size | **2,226,722 bytes (~2.2 MB)** | `stat` + `du`; verify script reports the same as spare, md5 matches |
| md5 | `9d99b0d4865496f73e230a9d92aa525e` | `md5sum` |
| Format | PMTiles spec v3, vector tiles (MVT), gzip-compressed | `pmtiles show` (CLI v1.31.2) |
| Tiles | **196 addressed tiles** (196 entries, 196 contents) | `pmtiles show` header fields |
| Area | 85.28–85.38 E, 23.30–23.42 N — **wider** than the live raster bbox (85.285–85.355 / 23.325–23.38) | header bbox |
| Zooms | stored to maxzoom **15**; closer zooms overzoom z15 | header `maxzoom: 15` |
| Centre | 85.33 E, 23.36 N (Doranda) | header centre |
| Data date | OSM replication **2026-11-17T04:00:00Z** | pack metadata (`planetiler:osm:osmosisreplicationtime`) |
| Source build | Protomaps daily build **20261117** | pack metadata / build command |
| Tile probe | centre tile z15 24150/14196 reads back **8,026 bytes**, decompresses to 11,286 bytes of valid vector tiles (starts with a `boundaries` layer) | `pmtiles tile … 15 24150 14196` |

For comparison, the live raster pack: 808 tiles, 11,875,846 bytes
(~11.9 MB on the manifest; ~13 MB on disk), zooms 12–17,
verified by `node apps/web/scripts/download-offline-map.mjs`
(exit 0, 2026-11-17). The PMTiles pack is ~5× smaller and covers
a wider area, but needs the glyph files to render labels — see
"Known problems".

### Independent re-measurement (same day, same inputs)

A fresh `--dry-run` extract against today's Protomaps build
(`https://build.protomaps.com/20261117.pmtiles`, same bbox,
`--maxzoom=15`) measured: **196 tiles, 2.3 MB transferred,
2.2 MB archive** — the same size as the file on disk. The dry run
downloads nothing to disk; it only reads the remote index and
counts the tiles. A second dry run with `--maxzoom=17` measured
the **same 196 tiles / 2.2 MB**: the source build's maxzoom for
this data is 15, so asking for higher zooms adds nothing.

For scale: the whole Protomaps planet build is ~139 GB of tile
data (header `tileDataLength` on the 20261117 build). Never
download it — extract only the bbox, as below.

## How the extract is built (exact command)

Requires the `pmtiles` CLI (protomaps/go-pmtiles; v1.31.2 used for
the measurements above). It streams only the tiles in the bbox
via HTTP range requests — it does **not** download the planet file.

```sh
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles \
  ranchi.pmtiles --bbox=85.28,23.30,85.38,23.42 --maxzoom=15
```

Then replace `apps/web/public/offline-map/ranchi.pmtiles` with the
new file and update the expected size/md5 in
`apps/web/scripts/download-offline-map.mjs` and in
`apps/web/src/lib/offline-map/constants.ts` (`OFFLINE_PACK`).

Measure before committing a rebuild — do not guess the size:

```sh
# What a rebuild would weigh, without downloading it:
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles out.pmtiles \
  --bbox=85.28,23.30,85.38,23.42 --maxzoom=15 --dry-run
# Verify the file you built:
pmtiles show ranchi.pmtiles
node apps/web/scripts/download-offline-map.mjs
```

### How to update it

1. Pick the newest dated Protomaps build (builds are kept ~7 days;
   replace `<YYYYMMDD>` with that date).
2. Run the `--dry-run` first and note the tile count / archive size.
3. Run the real extract, replace the file, update size + md5 in the
   two places named above.
4. Re-run `node apps/web/scripts/download-offline-map.mjs` — it must
   exit 0.
5. **Restore the glyph files first** (see "Known problems") —
   without them the PMTiles map has no labels even if the streets
   render.
6. Field-test on a real phone in Doranda/Hinoo: streets must paint
   at street zooms and the GPS pin must sit on the right street.
   Until that field test happens, the PMTiles map is **not proven
   working** (see "Proven vs unproven").

### Widening the area

Widen `--bbox` and re-check the size with `--dry-run` first. The
existing script's own note says a whole-city extract is a few MB
and a whole-state extract would be hundreds of MB — that note is
**unmeasured** (no dry run was done for those areas in this
session), so treat it as a rough guide, not a fact. Do not widen
to a whole state without a dry-run number.

## How the module works

New files only (no existing file was edited):

- `apps/web/src/lib/offline-map/constants.ts` — pack facts
  (measured size/md5/tile count), the pack's own bbox (wider
  than the live raster bbox — deliberately NOT imported from
  `maplibre.ts`, whose constants now describe the raster bundle),
  online candidates, and the small helpers `formatBytes` /
  `lngLatToTile`.
- `apps/web/src/lib/offline-map/pmtiles-loader.ts` — loads the
  **vendored** `public/offline-map/vendor/pmtiles.js` (no npm
  dependency, no CDN; this module is its only loader in `src/`),
  parses the 127-byte PMTiles v3 header from a Range fetch, and
  verifies the pack at runtime: header bbox / maxzoom / tile
  count must match the measured pack, then one real tile (the
  Doranda centre tile) must fetch non-empty.
  `verifyOfflinePack()` never throws — failures come back as
  plain-words `failure` strings.
- `apps/web/src/lib/offline-map/cache.ts` — Cache Storage wrapper:
  store/fetch the pack and any online map responses the map
  actually requested, report how much is stored on the device
  (`cacheStatus()` reads sizes from the stored responses), and
  clear it. Browser-only; no-ops without the Cache API.
- `apps/web/src/lib/offline-map/mode.ts` — the online/offline
  decision (`decideMapMode()`), the probe, and the fallback order
  (below). The probe timeout (5,000 ms) is a **chosen default**,
  not a measured value.
- `apps/web/src/components/map/OfflineMapNotice.tsx` — plain-
  language notice: which map is in use and how much is cached.
  No lat/lng numbers anywhere, per founder rule.

## Fallback order

The order `decideMapMode()` implements (for the later live-map
task — **not** the live view's behaviour today, which is
raster-only with no switcher):

1. **Online** — Esri World Street Map raster, then OpenFreeMap
   Liberty, then OpenFreeMap Bright (see `ONLINE_MAP_CANDIDATES`).
   Esri is first because it was the provider verified painting
   real Ranchi streets on the founder's phone (2026-11-17);
   OpenFreeMap's *unversioned* tile path returned HTTP 200 with
   0-byte tiles, so only its versioned style URLs are listed
   (copied verbatim from `docs/MAP-LOCATION-PROBES.md:17-19`,
   where 200 responses were measured).
2. **Offline** — the PMTiles pack, whenever the network is down
   or the online probe fails.
3. **Offline-only** — the PMTiles pack is the only map; no online
   attempt is made. This is the analogue of the live view's
   current raster-only behaviour.
4. **Unavailable** — the pack failed verification AND no online
   map could be reached: plain words, no blank map; the pin and
   zone flow still work.

### Conflict to resolve before wiring the switch in

The task brief asked for "a clear online/offline switch (online
OpenFreeMap/Esri first, offline PMTiles when no network)". The
founder decision says the opposite for the live app: **no
switcher — one bundled offline map**. This module therefore
implements the switch as a standalone, testable decision that is
**NOT wired into** `MapLibreMapView`, `PlayAreaMap`, or any other
view, and no existing file was changed. Wiring it in (or
promoting the PMTiles pack to the live map) reintroduces a map
switcher and needs a founder decision of its own. Do not wire it
in silently.

## Proven vs unproven

**Proven in this session (2026-11-17, on disk + CLI):**

- The PMTiles pack file exists, is 2,226,722 bytes, md5 matches
  the recorded value, and its header is a valid PMTiles v3
  archive with exactly the claimed bbox, maxzoom 15, and 196 tiles.
- A real centre tile reads back as valid vector-tile data.
- A fresh dry-run extract against today's Protomaps build
  measures the same 196 tiles / 2.2 MB.
- The live raster pack verifies: `download-offline-map.mjs`
  exits 0 (808 tiles, 11,875,846 bytes).
- The new module files typecheck with the app
  (`npm run typecheck` in `apps/web` — zero errors from the new
  files; see verification note below).

**NOT proven — do not claim the PMTiles offline map works until
these are done:**

- **No live-browser paint test of the PMTiles map.** Chromium
  cannot start on this VM, and no phone field test was run in
  this session. Streets painting on a real phone in
  Doranda/Hinoo is still the founder's field test to do.
- **The glyph (label font) files are missing** — see below. The
  PMTiles map's labels cannot render until they are restored,
  which is why the raster pack is live instead.

## Known problems found while doing this work

1. **Glyph files missing — the reason PMTiles is spare, not live.**
   `public/offline-map/fonts/` does not exist on disk (all five
   glyph files the old verify script expected are absent), although
   the PMTiles style points at
   `/offline-map/fonts/{fontstack}/{range}.pbf`. This is already
   recorded in `maplibre.ts` as the reason the raster pack was
   chosen. It is NOT a defect in the live raster map (raster
   needs no glyphs). Fix only if the PMTiles pack is ever
   promoted to live: restore the glyph files, then re-verify.
2. **Vendored pmtiles.js version unconfirmed.** `maplibre.ts`
   (old comment) said pmtiles.js v3.2.0; the version string found
   in the vendored bundle reads 3.0.0. The library loads and the
   header checks pass either way, but the version in the comment
   is not verified — confirm it when the pack is next rebuilt.
3. **Stale doc lines.** `docs/DECISIONS.md` (§ "OFFLINE MAP")
   still describes the superseded OpenFreeMap vector-tile pack
   (41 files, 2.6 MB) in places. The raster pack described here
   is what is actually live, and the PMTiles pack described here
   is what is actually on disk as spare.

## Verification note

- `pmtiles show` / `pmtiles tile` / two `--dry-run` extracts /
  `node apps/web/scripts/download-offline-map.mjs`: all run
  2026-11-17, outputs quoted above.
- Typecheck: `npm run typecheck` in `apps/web` after adding these
  files. The new files must add zero errors. (Pre-existing errors
  elsewhere, if any, are not this module's to fix.)
- **Concurrency note:** while this work was being done, a parallel
  reconciliation worker replaced `maplibre.ts` / `MapLibreMapView`
  (14:34 IST) to land the raster approach. The first draft of this
  module was written against the pre-reconciliation file and was
  corrected after the typecheck exposed the drift; this doc and
  the module now describe the post-reconciliation code. No
  existing file was edited by this worker — only the new files
  listed above.
- **Deletion incident (14:44–14:45 IST, same day):** after the
  module typechecked clean, all six new source files (the whole
  `src/lib/offline-map/` folder and `OfflineMapNotice.tsx`)
  disappeared from disk — both parent directories show a
  14:44:49 mtime — while this doc survived untouched. No message
  explained it and no existing file was touched. The six files
  were recreated byte-identical (plus the decimal `formatBytes`
  fix) and re-verified immediately. If they disappear again, do
  not assume this worker removed them: check which parallel
  worker or process touched `src/` at that minute before
  re-doing the work a third time.
