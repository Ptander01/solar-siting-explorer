"""
T3: export the individual criteria layers (slope score, land cover score)
used in the M5 combined suitability score, so they can be inspected on
their own in the map's layers panel rather than only seeing the combined
result.

Reuses the same slope/land-cover scoring logic as m5_suitability_score.py,
gridded onto the same GRID_COLS x GRID_ROWS grid so all layers line up
spatially. Does NOT touch suitability_score.geojson — this only adds two
new output files, so it's safe to run any time after M3/M5, including
after the T1/T2 exclusion script.

Run (same venv as M3/M5, from the pipeline/ folder):
    python3 t3_export_criteria_layers.py

Needs internet access (streams land cover data) — run on your own machine.
Requires data/aoi_dem.tif to already exist (from M3).

Outputs:
  ../public/data/slope_score.geojson
  ../public/data/landcover_score.geojson
"""

import os

import numpy as np
import rasterio
import geopandas as gpd
from shapely.geometry import box
from rasterio.transform import rowcol
from rasterio.warp import reproject, Resampling

WEST, SOUTH, EAST, NORTH = -97.05, 37.70, -96.70, 37.95

DEM_PATH = "data/aoi_dem.tif"
SLOPE_OUT = "../public/data/slope_score.geojson"
LANDCOVER_OUT = "../public/data/landcover_score.geojson"

SLOPE_MAX_DEG = 10.0
GRID_COLS = 144  # keep in sync with m5_suitability_score.py's grid
GRID_ROWS = 120

WORLDCOVER_SUITABILITY = {
    10: 20, 20: 60, 30: 90, 40: 80, 50: 5, 60: 60,
    70: 0, 80: 0, 90: 5, 95: 5, 100: 50,
}
DEFAULT_LANDCOVER_SCORE = 50

WORLDCOVER_LABELS = {
    10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland",
    50: "Built-up", 60: "Bare / sparse vegetation", 70: "Snow and ice",
    80: "Permanent water bodies", 90: "Herbaceous wetland", 95: "Mangroves",
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
    return slope_score, slope_deg, transform, crs, shape


def get_landcover_score_aligned(ref_transform, ref_crs, ref_shape):
    import pystac_client
    import planetary_computer

    print("Searching Microsoft Planetary Computer for ESA WorldCover land cover...")
    catalog = pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )
    search = catalog.search(collections=["esa-worldcover"], bbox=[WEST, SOUTH, EAST, NORTH])
    items = list(search.items())
    if not items:
        raise RuntimeError("No ESA WorldCover items found for this AOI.")
    items.sort(key=lambda it: it.properties.get("start_datetime") or "", reverse=True)
    item = items[0]
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
    return score, nlcd_codes


def _dominant_landcover_label(code_block):
    codes = np.round(code_block).astype(int).ravel()
    if codes.size == 0:
        return "Unknown"
    values, counts = np.unique(codes, return_counts=True)
    dominant_code = int(values[np.argmax(counts)])
    return WORLDCOVER_LABELS.get(dominant_code, f"Class {dominant_code}")


def grid_average(score_arr, slope_deg_arr, landcover_codes_arr, transform):
    # score_arr is whichever of slope_score/landcover_score this call is
    # exporting; slope_deg_arr/landcover_codes_arr are always the same two
    # raw arrays, so both output files carry both raw values — lets the
    # frontend show the same tooltip fields regardless of which score
    # layer is active.
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

    slope_cells = grid_average(slope_score, slope_deg, landcover_codes, transform)
    slope_gdf = gpd.GeoDataFrame(slope_cells, crs=crs)
    os.makedirs(os.path.dirname(SLOPE_OUT), exist_ok=True)
    slope_gdf.to_file(SLOPE_OUT, driver="GeoJSON")
    print(f"Wrote {SLOPE_OUT} ({len(slope_gdf)} cells, mean {slope_gdf['score'].mean():.1f})")

    landcover_cells = grid_average(landcover_score, slope_deg, landcover_codes, transform)
    landcover_gdf = gpd.GeoDataFrame(landcover_cells, crs=crs)
    landcover_gdf.to_file(LANDCOVER_OUT, driver="GeoJSON")
    print(f"Wrote {LANDCOVER_OUT} ({len(landcover_gdf)} cells, mean {landcover_gdf['score'].mean():.1f})")


if __name__ == "__main__":
    main()
