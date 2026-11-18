#!/usr/bin/env python3
"""Fetch the expanded Pakdam offline Esri raster tile pack.

Expansion (2026-11-18, tile-expansion round): the founder said the
23.325-23.38 / 85.285-85.355 pack was too tight and that "Doranda" /
"Hinoo" do not render as area labels on the Esri tiles (verified by
reading tiles: Esri labels streets/colonies, never the two locality
names - app-drawn labels were added separately in MapLibreMapView).

  Wide bbox (z12-16 + 1-tile halo): lat 23.30-23.405, lng 85.26-85.38
    - covers Doranda + Hinoo + Hindpiri, Lower Bazar, Kadru, Kanke side
  z17 capped to an extended core (lat 23.315-23.39, lng 85.28-85.36
  + 1-tile halo): a full wide z17 would be 2,024 tiles (~30 MB) on its
  own; z17 stays over the core play area only. Consequence, recorded:
  at zoom 17 outside the z17 core the map requests tiles that are not
  in the bundle (404) - players zoom out to 16 there and the map
  paints. Extending z17 to the full wide bbox later is a re-run of
  this script with the z17 range widened.

Resumable: tiles already on disk with valid JPEG magic + size > 0
are skipped. Writes are atomic (temp file + os.replace) and every
fetched tile is verified (magic bytes FF D8 FF) before it counts.
Run:  python3 apps/web/scripts/fetch-expanded-tiles.py
"""
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# apps/web/scripts -> apps/web
WEB = os.path.join(REPO, "apps", "web")
OUT = os.path.join(WEB, "public", "offline-map", "tiles")
MANIFEST = os.path.join(WEB, "public", "offline-map", "manifest.json")
ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"

WIDE = {"minLat": 23.30, "maxLat": 23.405, "minLng": 85.26, "maxLng": 85.38}
Z17_CORE = {"minLat": 23.315, "maxLat": 23.39, "minLng": 85.28, "maxLng": 85.36}
HALO = 1
WORKERS = 8
RETRIES = 4


def tile_range(bbox, z, halo=HALO):
    n = 2 ** z

    def x(lng):
        return math.floor((lng + 180) / 360 * n)

    def y(lat):
        r = math.radians(lat)
        return math.floor((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)

    return (
        x(bbox["minLng"]) - halo,
        x(bbox["maxLng"]) + halo,
        y(bbox["maxLat"]) - halo,
        y(bbox["minLat"]) + halo,
    )


def plan():
    jobs = {}  # z -> list of (x, y)
    for z in range(12, 17):
        x0, x1, y0, y1 = tile_range(WIDE, z)
        jobs[z] = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    x0, x1, y0, y1 = tile_range(Z17_CORE, 17)
    jobs[17] = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    return jobs


def tile_path(z, x, y):
    return os.path.join(OUT, str(z), str(x), f"{y}.jpg")


def valid_jpeg(path):
    try:
        if not os.path.isfile(path) or os.path.getsize(path) == 0:
            return False
        with open(path, "rb") as f:
            return f.read(3) == b"\xff\xd8\xff"
    except OSError:
        return False


def fetch_one(args):
    z, x, y = args
    path = tile_path(z, x, y)
    if valid_jpeg(path):
        return (z, "skipped")
    url = ESRI.format(z=z, y=y, x=x)
    last_err = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Pakdam offline-map pack fetch)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            if len(data) == 0 or data[:3] != b"\xff\xd8\xff":
                raise ValueError(f"bad payload: {len(data)} bytes, magic {data[:3]!r}")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
            if not valid_jpeg(path):
                raise ValueError("written file failed re-read verification")
            return (z, "downloaded")
        except Exception as e:  # noqa: BLE001 - retry, record last error
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    print(f"FAILED {z}/{x}/{y}: {last_err}", flush=True)
    return (z, "failed")


def main():
    jobs = plan()
    total = sum(len(v) for v in jobs.values())
    print(f"planned total: {total} tiles")
    for z in sorted(jobs):
        print(f"  z{z}: {len(jobs[z])}")
    all_jobs = [(z, x, y) for z in sorted(jobs) for (x, y) in jobs[z]]
    counts = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for z, status in pool.map(fetch_one, all_jobs):
            c = counts.setdefault(z, {"downloaded": 0, "skipped": 0, "failed": 0})
            c[status] += 1
    # Disk verification: recount everything with valid JPEGs.
    per_zoom = {}
    grand_total = 0
    grand_bytes = 0
    for z in sorted(jobs):
        n = 0
        b = 0
        for (x, y) in jobs[z]:
            p = tile_path(z, x, y)
            if valid_jpeg(p):
                n += 1
                b += os.path.getsize(p)
        per_zoom[str(z)] = {"total": len(jobs[z]), "downloaded": n, "skipped": len(jobs[z]) - n}
        grand_total += n
        grand_bytes += b
        print(f"verify z{z}: {n}/{len(jobs[z])} valid, {b} bytes")
    failed = [f"{z}/{x}/{y}" for z in sorted(jobs) for (x, y) in jobs[z]
              if not valid_jpeg(tile_path(z, x, y))]
    print(f"TOTAL valid on disk: {grand_total}/{total} tiles, {grand_bytes} bytes")
    if failed:
        print(f"FAILED ({len(failed)}): {failed[:20]}")
    manifest = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "format": "raster-esri",
        "bbox": WIDE,
        "zooms": [12, 17],
        "tileTemplate": "/offline-map/tiles/{z}/{x}/{y}.jpg",
        "tiles": {
            "total": total,
            "downloaded": grand_total,
            "skipped": total - grand_total,
            "perZoom": per_zoom,
        },
        "bytes": {"downloaded": grand_bytes, "skipped": 0},
        "failed": failed,
        "halo": {
            "added": 1,
            "note": "1-tile halo around each zoom's rectangle so the initial viewport never requests a missing tile. z17 is capped to the extended core lat 23.315-23.39 / lng 85.28-85.36 (see fetch script header): at zoom 17 outside that core the map requests tiles not in the bundle.",
        },
        "expansion": {
            "date": "2026-11-18",
            "note": "Expanded from bbox 23.325-23.38 / 85.285-85.355 (1,038 tiles) to wide bbox 23.30-23.405 / 85.26-85.38 at z12-16, z17 kept to the extended core. Doranda/Hinoo do not render as labels on the Esri tiles themselves; app-drawn area labels were added in MapLibreMapView.tsx (OFFLINE_AREA_LABELS in maplibre.ts).",
        },
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(f"manifest written: {MANIFEST}")
    if failed:
        sys.exit(1)
    print("OK - pack complete")


if __name__ == "__main__":
    main()
