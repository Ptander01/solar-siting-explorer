"""
M3: slope-based solar siting suitability for one small pilot AOI.

Pilot AOI: a ~25km x 20km box around El Dorado, Butler County, KS — same
area as the sample transmission lines already on the map (M2), so
everything so far lines up spatially once this layer is added at M4.

What this does:
  1. Downloads the real SRTM1 (30m) elevation tile(s) covering the AOI
     directly from the public elevation-tiles-prod bucket (pure Python —
     no system GDAL command-line tools required, unlike the `elevation`
     package's default pipeline).
  2. Mosaics/clips them to the AOI.
  3. Computes slope in degrees from that DEM.
  4. Classifies suitable vs. unsuitable using SLOPE_THRESHOLD_DEG (utility-
     scale solar generally wants well under ~5 degrees).
  5. Polygonizes the suitable areas and writes them out as GeoJSON, ready
     to bring into the map at M4.

Run:
    cd pipeline
    python3 -m venv venv && source venv/bin/activate
    pip install -r requirements.txt
    python3 m3_slope_suitability.py

Needs real internet access (downloads ~1-4 small SRTM tiles, a few MB
total) — run this on your own machine, not inside a restricted sandbox.

Output: ../public/data/slope_suitability.geojson
"""

import gzip
import math
import os
import shutil
import urllib.request

import numpy as np
import rasterio
import geopandas as gpd
from shapely.geometry import shape, box, mapping
from rasterio.features import shapes
from rasterio.merge import merge
from rasterio.mask import mask

# --- Pilot AOI: box around El Dorado, Butler County, KS ---
WEST, SOUTH, EAST, NORTH = -97.05, 37.70, -96.70, 37.95

SRTM_BASE = "https://s3.amazonaws.com/elevation-tiles-prod/skadi"
TILE_CACHE_DIR = "data/srtm_cache"
DEM_PATH = "data/aoi_dem.tif"
OUTPUT_PATH = "../public/data/slope_suitability.geojson"
SLOPE_THRESHOLD_DEG = 5.0


def srtm_tile_name(lat, lon):
    lat_floor, lon_floor = math.floor(lat), math.floor(lon)
    ns = "N" if lat_floor >= 0 else "S"
    ew = "E" if lon_floor >= 0 else "W"
    return f"{ns}{abs(lat_floor):02d}{ew}{abs(lon_floor):03d}"


def tiles_for_bbox(west, south, east, north):
    names = set()
    for lat in range(math.floor(south), math.floor(north) + 1):
        for lon in range(math.floor(west), math.floor(east) + 1):
            names.add(srtm_tile_name(lat, lon))
    return sorted(names)


def download_tile(name, dest_dir):
    hgt_path = os.path.join(dest_dir, f"{name}.hgt")
    if os.path.exists(hgt_path):
        return hgt_path

    gz_path = os.path.join(dest_dir, f"{name}.hgt.gz")
    url = f"{SRTM_BASE}/{name[:3]}/{name}.hgt.gz"
    print(f"  downloading {name} ...")
    urllib.request.urlretrieve(url, gz_path)

    with gzip.open(gz_path, "rb") as f_in, open(hgt_path, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)
    os.remove(gz_path)
    return hgt_path


def fetch_dem():
    if os.path.exists(DEM_PATH):
        print(f"DEM already present at {DEM_PATH}, skipping download.")
        return DEM_PATH

    os.makedirs(TILE_CACHE_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(DEM_PATH), exist_ok=True)

    print("Downloading SRTM elevation tile(s) for the pilot AOI...")
    tile_names = tiles_for_bbox(WEST, SOUTH, EAST, NORTH)
    hgt_paths = [download_tile(name, TILE_CACHE_DIR) for name in tile_names]

    srcs = [rasterio.open(p) for p in hgt_paths]
    mosaic, out_transform = merge(srcs)
    out_meta = srcs[0].meta.copy()
    out_meta.update(
        {
            "driver": "GTiff",  # source tiles are read via the SRTMHGT driver, which only
                                 # writes a handful of fixed image sizes — force a plain
                                 # GeoTIFF for the merged/clipped outputs instead.
            "height": mosaic.shape[1],
            "width": mosaic.shape[2],
            "transform": out_transform,
        }
    )
    for s in srcs:
        s.close()

    merged_path = os.path.join(TILE_CACHE_DIR, "mosaic.tif")
    with rasterio.open(merged_path, "w", **out_meta) as dst:
        dst.write(mosaic)

    aoi_geom = [mapping(box(WEST, SOUTH, EAST, NORTH))]
    with rasterio.open(merged_path) as src:
        clipped, clipped_transform = mask(src, aoi_geom, crop=True)
        clipped_meta = src.meta.copy()
        clipped_meta.update(
            {
                "height": clipped.shape[1],
                "width": clipped.shape[2],
                "transform": clipped_transform,
            }
        )

    with rasterio.open(DEM_PATH, "w", **clipped_meta) as dst:
        dst.write(clipped)

    return DEM_PATH


def compute_slope_degrees(dem_path):
    with rasterio.open(dem_path) as src:
        elev = src.read(1).astype("float64")
        transform = src.transform
        deg_to_m = 111_320.0 * np.cos(np.radians((NORTH + SOUTH) / 2))
        px_m = transform.a * deg_to_m
        py_m = -transform.e * 111_320.0

        gy, gx = np.gradient(elev, py_m, px_m)
        slope_deg = np.degrees(np.arctan(np.sqrt(gx**2 + gy**2)))
        return slope_deg, transform, src.crs


def polygonize_suitable(slope_deg, transform, crs):
    suitable_mask = (slope_deg < SLOPE_THRESHOLD_DEG).astype("uint8")
    polygons = [
        shape(geom)
        for geom, _ in shapes(suitable_mask, mask=suitable_mask == 1, transform=transform)
    ]

    gdf = gpd.GeoDataFrame(
        {"suitability": ["suitable"] * len(polygons)}, geometry=polygons, crs=crs
    )
    gdf = gdf.dissolve(by="suitability").reset_index()
    gdf["criteria"] = f"slope < {SLOPE_THRESHOLD_DEG} deg"
    return gdf


def main():
    dem_path = fetch_dem()
    slope_deg, transform, crs = compute_slope_degrees(dem_path)
    gdf = polygonize_suitable(slope_deg, transform, crs)

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    gdf.to_file(OUTPUT_PATH, driver="GeoJSON")

    pct_suitable = 100 * (slope_deg < SLOPE_THRESHOLD_DEG).mean()
    print(f"Wrote {OUTPUT_PATH}")
    print(f"~{pct_suitable:.1f}% of the pilot AOI is under {SLOPE_THRESHOLD_DEG} degrees slope.")


if __name__ == "__main__":
    main()
