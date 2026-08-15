"""
M5 (core): continuous multi-criteria suitability score for the pilot AOI.

    SUPERSEDED — use regenerate_baked_layers.py instead.

    This script scores slope and land cover only. Transmission proximity is
    now a real scored criterion and the protected-land exclusion is applied
    in the same pass, both of which live in backend/suitability.py (the one
    implementation the live API also uses). Running this will overwrite
    public/data/suitability_score.geojson with the older two-criterion
    numbers. Kept because it documents how the pipeline was built up
    milestone by milestone, not because it's the current path.

Grid resolution note: GRID_COLS/GRID_ROWS below control the size of the
score "squares" on the map — not the underlying data resolution (the DEM
is real 30m SRTM1, land cover is real 10m WorldCover; both stay at native
resolution). Raising GRID_COLS/GRID_ROWS just averages those pixels into
smaller cells, so the map shows finer detail. Keep this in sync with
GRID_COLS/GRID_ROWS in t3_export_criteria_layers.py so all three score
layers (suitability, slope, land cover) share the same grid.

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

GRID_COLS = 144
GRID_ROWS = 120

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

# Human-readable labels for the tooltip — same class codes as
# WORLDCOVER_SUITABILITY above.
WORLDCOVER_LABELS = {
    10: "Tree cover",
    20: "Shrubland",
    30: "Grassland",
    40: "Cropland",
    50: "Built-up",
    60: "Bare / sparse vegetation",
    70: "Snow and ice",
    80: "Permanent water bodies",
    90: "Herbaceous wetland",
    95: "Mangroves",
    100: "Moss and lichen",
}


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
    # Return the raw degrees too — the score alone doesn't tell you *why* a
    # cell scored the way it did, and that's useful in the map tooltip.
    return slope_score, slope_deg, transform, crs, shape


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
    # Return the raw class codes too, for the same reason as slope_deg above.
    return score, nlcd_codes


def _dominant_landcover_label(code_block):
    """Most frequent WorldCover class in a grid cell, as a human-readable
    label — a cell can span several class codes, so "the score" alone
    doesn't say what's actually on the ground there."""
    codes = np.round(code_block).astype(int).ravel()
    if codes.size == 0:
        return "Unknown"
    values, counts = np.unique(codes, return_counts=True)
    dominant_code = int(values[np.argmax(counts)])
    return WORLDCOVER_LABELS.get(dominant_code, f"Class {dominant_code}")


def grid_average(score_arr, slope_deg_arr, landcover_codes_arr, transform):
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

            mean_slope_deg = float(np.nanmean(slope_deg_arr[r0:r1, c0:c1]))
            landcover_class = _dominant_landcover_label(landcover_codes_arr[r0:r1, c0:c1])

            rows_out.append({
                "score": round(mean_score, 1),
                "slope_deg": round(mean_slope_deg, 1),
                "landcover_class": landcover_class,
                "geometry": box(cell_w, cell_s, cell_e, cell_n),
            })
    return rows_out


def main():
    if not os.path.exists(DEM_PATH):
        raise SystemExit("Missing data/aoi_dem.tif — run m3_slope_suitability.py first.")

    slope_score, slope_deg, transform, crs, shape = compute_slope_score()
    landcover_score, landcover_codes = get_landcover_score_aligned(transform, crs, shape)

    combined = SLOPE_WEIGHT * slope_score + LANDCOVER_WEIGHT * landcover_score

    cells = grid_average(combined, slope_deg, landcover_codes, transform)
    gdf = gpd.GeoDataFrame(cells, crs=crs)
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    gdf.to_file(OUTPUT_PATH, driver="GeoJSON")

    print(f"Wrote {OUTPUT_PATH} ({len(gdf)} grid cells)")
    print(f"Mean combined score: {gdf['score'].mean():.1f} / 100")


if __name__ == "__main__":
    main()
