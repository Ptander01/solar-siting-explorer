"""
M5 (core): continuous multi-criteria suitability score for the pilot AOI.

Combines two real criteria into one 0-100 score, replacing the M3/M4 binary
"suitable/not" layer:
  - slope (from the DEM already downloaded in M3 — no new fetch needed)
  - land cover (ESA WorldCover 10m, streamed from Microsoft's Planetary
    Computer — NLCD isn't in that catalog, WorldCover is the equivalent
    public, global, no-token dataset)

Deliberately NOT included yet (future session, not today's scope):
  - real transmission-line proximity (M2's lines are placeholder data)
  - protected-land exclusions (PAD-US)
  - interactive weight sliders — weights below are hardcoded for now
  - Recharts stats panel

Run (from the pipeline/ folder, same venv as M3):
    pip install -r requirements.txt   # picks up two new packages
    python3 m5_suitability_score.py

Needs internet access — run on your own machine.

Output: ../public/data/suitability_score.geojson
  - a grid of cells over the pilot AOI, each with a `score` property (0-100)
"""

import os

import numpy as np
import rasterio
import geopandas as gpd
from shapely.geometry import box
from rasterio.transform import rowcol
from rasterio.warp import reproject, Resampling

# --- Same pilot AOI as M3: El Dorado, Butler County, KS ---
WEST, SOUTH, EAST, NORTH = -97.05, 37.70, -96.70, 37.95

DEM_PATH = "data/aoi_dem.tif"  # produced by M3 — run that first if missing
OUTPUT_PATH = "../public/data/suitability_score.geojson"

SLOPE_MAX_DEG = 10.0  # score reaches 0 at this slope; 100 at 0 degrees
SLOPE_WEIGHT = 0.6
LANDCOVER_WEIGHT = 0.4

GRID_COLS = 36
GRID_ROWS = 30

# ESA WorldCover class code -> suitability score (0-100). Open land (grass,
# cropland, bare/sparse ground) scores high; water, wetlands, and built-up
# areas score low. Legend: https://esa-worldcover.org/en/data-access
WORLDCOVER_SUITABILITY = {
    10: 20,   # Tree cover
    20: 60,   # Shrubland
    30: 90,   # Grassland
    40: 80,   # Cropland
    50: 5,    # Built-up
    60: 60,   # Bare / sparse vegetation
    70: 0,    # Snow and ice
    80: 0,    # Permanent water bodies
    90: 5,    # Herbaceous wetland
    95: 5,    # Mangroves
    100: 50,  # Moss and lichen
}
DEFAULT_LANDCOVER_SCORE = 50  # unmapped/unexpected class codes


def compute_slope_score():
    with rasterio.open(DEM_PATH) as src:
        elev = src.read(1).astype("float64")
        transform = src.transform
        crs = src.crs
        shape = elev.shape

        deg_to_m = 111_320.0 * np.cos(np.radians((NORTH + SOUTH) / 2))
        px_m = transform.a * deg_to_m
        py_m = -transform.e * 111_320.0
        gy, gx = np.gradient(elev, py_m, px_m)
        slope_deg = np.degrees(np.arctan(np.sqrt(gx**2 + gy**2)))

    slope_score = 100 * np.clip((SLOPE_MAX_DEG - slope_deg) / SLOPE_MAX_DEG, 0, 1)
    return slope_score, transform, crs, shape


def get_landcover_score_aligned(ref_transform, ref_crs, ref_shape):
    import pystac_client
    import planetary_computer

    print("Searching Microsoft Planetary Computer for ESA WorldCover land cover over the pilot AOI...")
    catalog = pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )
    search = catalog.search(collections=["esa-worldcover"], bbox=[WEST, SOUTH, EAST, NORTH])
    items = list(search.items())
    if not items:
        raise RuntimeError(
            "No ESA WorldCover items found on Planetary Computer for this AOI. If you "
            "see this, tell Claude — the collection name or query may need adjusting."
        )
    # WorldCover items are annual composites with a start/end range rather
    # than a single `datetime`, so sort on the range's start instead.
    items.sort(key=lambda it: it.properties.get("start_datetime") or "", reverse=True)
    item = items[0]
    print(f"Using WorldCover item: {item.id}")
    print(f"Available assets: {list(item.assets.keys())}")

    asset = item.assets.get("map") or item.assets.get("data") or next(iter(item.assets.values()))

    with rasterio.open(asset.href) as src:
        nlcd_codes = np.zeros(ref_shape, dtype=np.float32)
        reproject(
            source=rasterio.band(src, 1),
            destination=nlcd_codes,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=ref_transform,
            dst_crs=ref_crs,
            resampling=Resampling.nearest,
        )

    score = np.full(ref_shape, DEFAULT_LANDCOVER_SCORE, dtype=np.float32)
    for code, value in WORLDCOVER_SUITABILITY.items():
        score[np.round(nlcd_codes) == code] = value
    return score


def grid_average(score_arr, transform):
    lon_edges = np.linspace(WEST, EAST, GRID_COLS + 1)
    lat_edges = np.linspace(SOUTH, NORTH, GRID_ROWS + 1)

    rows_out = []
    for i in range(GRID_ROWS):
        for j in range(GRID_COLS):
            cell_w, cell_e = lon_edges[j], lon_edges[j + 1]
            cell_s, cell_n = lat_edges[i], lat_edges[i + 1]

            r0, c0 = rowcol(transform, cell_w, cell_n)
            r1, c1 = rowcol(transform, cell_e, cell_s)
            r0, r1 = sorted((max(r0, 0), min(r1, score_arr.shape[0])))
            c0, c1 = sorted((max(c0, 0), min(c1, score_arr.shape[1])))
            if r1 <= r0 or c1 <= c0:
                continue

            block = score_arr[r0:r1, c0:c1]
            if block.size == 0:
                continue
            mean_score = float(np.nanmean(block))
            if np.isnan(mean_score):
                continue

            rows_out.append(
                {"score": round(mean_score, 1), "geometry": box(cell_w, cell_s, cell_e, cell_n)}
            )
    return rows_out


def main():
    if not os.path.exists(DEM_PATH):
        raise SystemExit("Missing data/aoi_dem.tif — run m3_slope_suitability.py first.")

    slope_score, transform, crs, shape = compute_slope_score()
    landcover_score = get_landcover_score_aligned(transform, crs, shape)

    combined = SLOPE_WEIGHT * slope_score + LANDCOVER_WEIGHT * landcover_score

    cells = grid_average(combined, transform)
    gdf = gpd.GeoDataFrame(cells, crs=crs)
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    gdf.to_file(OUTPUT_PATH, driver="GeoJSON")

    print(f"Wrote {OUTPUT_PATH} ({len(gdf)} grid cells)")
    print(f"Mean combined score: {gdf['score'].mean():.1f} / 100")


if __name__ == "__main__":
    main()
