"""
Core suitability computation — refactored out of pipeline/m3_slope_suitability.py
(DEM fetch) and pipeline/m5_suitability_score.py (scoring/grid) so it can run
for an arbitrary bbox + weights instead of only the hardcoded pilot AOI.

This is B1: an API skin on the existing pipeline, not new geoprocessing —
every function below is the same logic as the standalone scripts, just
parameterized instead of reading module-level WEST/SOUTH/EAST/NORTH
constants. main.py's /analyze endpoint calls run_analysis().

Deliberately NOT included yet (later milestones, not B1's scope):
  - the protected-land exclusion / real transmission data from
    pipeline/t_real_transmission_and_exclusions.py — this endpoint returns
    the same score m5_suitability_score.py produces before that script
    runs. Folding that in is a reasonable future step, but B1 is scoped to
    "reproduce m5, callable on demand."
  - AOI-drawing on the map (B2) and the weight/threshold sliders calling
    this endpoint (B3) — this file and main.py just need to exist and work
    correctly first, tested directly against the known pilot-AOI result.
"""

import gzip
import math
import os
import shutil
import tempfile
import urllib.request

import numpy as np
import rasterio
import geopandas as gpd
from shapely.geometry import box, mapping
from rasterio.transform import rowcol
from rasterio.merge import merge
from rasterio.mask import mask
from rasterio.warp import reproject, Resampling

SRTM_BASE = "https://s3.amazonaws.com/elevation-tiles-prod/skadi"

# Same ESA WorldCover class -> suitability mapping as m5_suitability_score.py.
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
DEFAULT_LANDCOVER_SCORE = 50

# Human-readable labels for the same codes — used in the tooltip fields
# below, same as pipeline/m5_suitability_score.py.
WORLDCOVER_LABELS = {
    10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland",
    50: "Built-up", 60: "Bare / sparse vegetation", 70: "Snow and ice",
    80: "Permanent water bodies", 90: "Herbaceous wetland", 95: "Mangroves",
    100: "Moss and lichen",
}

# Safety cap so one request can't ask for, say, all of Kansas and take
# minutes to fetch/process — a real AOI-drawing tool (B2) would also want
# a client-side warning before it ever gets here.
MAX_AOI_DEG2 = 1.0


class AOITooLargeError(ValueError):
    pass


def _srtm_tile_name(lat, lon):
    lat_floor, lon_floor = math.floor(lat), math.floor(lon)
    ns = "N" if lat_floor >= 0 else "S"
    ew = "E" if lon_floor >= 0 else "W"
    return f"{ns}{abs(lat_floor):02d}{ew}{abs(lon_floor):03d}"


def _tiles_for_bbox(west, south, east, north):
    names = set()
    for lat in range(math.floor(south), math.floor(north) + 1):
        for lon in range(math.floor(west), math.floor(east) + 1):
            names.add(_srtm_tile_name(lat, lon))
    return sorted(names)


def _download_tile(name, dest_dir):
    hgt_path = os.path.join(dest_dir, f"{name}.hgt")
    gz_path = os.path.join(dest_dir, f"{name}.hgt.gz")
    url = f"{SRTM_BASE}/{name[:3]}/{name}.hgt.gz"
    try:
        urllib.request.urlretrieve(url, gz_path)
    except Exception as e:
        raise RuntimeError(f"Couldn't fetch SRTM tile {name} — is this AOI over land? ({e})")
    with gzip.open(gz_path, "rb") as f_in, open(hgt_path, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)
    os.remove(gz_path)
    return hgt_path


def _fetch_dem(bbox, work_dir):
    """Same download -> mosaic -> clip flow as m3_slope_suitability.py's
    fetch_dem(), but writing into a per-request temp dir instead of the
    pipeline's cached data/ folder — every request is for a (possibly)
    different AOI, so there's nothing durable to cache yet."""
    west, south, east, north = bbox
    tile_names = _tiles_for_bbox(west, south, east, north)
    hgt_paths = [_download_tile(name, work_dir) for name in tile_names]

    srcs = [rasterio.open(p) for p in hgt_paths]
    mosaic, out_transform = merge(srcs)
    out_meta = srcs[0].meta.copy()
    out_meta.update({
        "driver": "GTiff",  # source tiles use the SRTMHGT driver, which only writes
                             # a handful of fixed sizes — force plain GeoTIFF instead.
        "height": mosaic.shape[1],
        "width": mosaic.shape[2],
        "transform": out_transform,
    })
    for s in srcs:
        s.close()

    merged_path = os.path.join(work_dir, "mosaic.tif")
    with rasterio.open(merged_path, "w", **out_meta) as dst:
        dst.write(mosaic)

    aoi_geom = [mapping(box(west, south, east, north))]
    with rasterio.open(merged_path) as src:
        clipped, clipped_transform = mask(src, aoi_geom, crop=True)
        clipped_meta = src.meta.copy()
        clipped_meta.update({
            "height": clipped.shape[1],
            "width": clipped.shape[2],
            "transform": clipped_transform,
        })

    dem_path = os.path.join(work_dir, "aoi_dem.tif")
    with rasterio.open(dem_path, "w", **clipped_meta) as dst:
        dst.write(clipped)
    return dem_path


def _compute_slope_score(dem_path, bbox, slope_max_deg):
    west, south, east, north = bbox
    with rasterio.open(dem_path) as src:
        elev = src.read(1).astype("float64")
        transform = src.transform
        crs = src.crs
        shape = elev.shape

        deg_to_m = 111_320.0 * np.cos(np.radians((north + south) / 2))
        px_m = transform.a * deg_to_m
        py_m = -transform.e * 111_320.0
        gy, gx = np.gradient(elev, py_m, px_m)
        slope_deg = np.degrees(np.arctan(np.sqrt(gx**2 + gy**2)))

    slope_score = 100 * np.clip((slope_max_deg - slope_deg) / slope_max_deg, 0, 1)
    return slope_score, slope_deg, transform, crs, shape


def _get_landcover_score_aligned(ref_transform, ref_crs, ref_shape, bbox):
    import pystac_client
    import planetary_computer

    west, south, east, north = bbox
    catalog = pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )
    search = catalog.search(collections=["esa-worldcover"], bbox=[west, south, east, north])
    items = list(search.items())
    if not items:
        raise RuntimeError("No ESA WorldCover items found on Planetary Computer for this AOI.")
    # WorldCover items are annual composites with a start/end range rather
    # than a single `datetime`, so sort on the range's start instead.
    items.sort(key=lambda it: it.properties.get("start_datetime") or "", reverse=True)
    item = items[0]
    asset = item.assets.get("map") or item.assets.get("data") or next(iter(item.assets.values()))

    with rasterio.open(asset.href) as src:
        codes = np.zeros(ref_shape, dtype=np.float32)
        reproject(
            source=rasterio.band(src, 1),
            destination=codes,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=ref_transform,
            dst_crs=ref_crs,
            resampling=Resampling.nearest,
        )

    score = np.full(ref_shape, DEFAULT_LANDCOVER_SCORE, dtype=np.float32)
    for code, value in WORLDCOVER_SUITABILITY.items():
        score[np.round(codes) == code] = value
    return score, codes


def _dominant_landcover_label(code_block):
    codes = np.round(code_block).astype(int).ravel()
    if codes.size == 0:
        return "Unknown"
    values, counts = np.unique(codes, return_counts=True)
    dominant_code = int(values[np.argmax(counts)])
    return WORLDCOVER_LABELS.get(dominant_code, f"Class {dominant_code}")


def _grid_average(score_arr, slope_deg_arr, landcover_codes_arr, transform, bbox, grid_cols, grid_rows):
    west, south, east, north = bbox
    lon_edges = np.linspace(west, east, grid_cols + 1)
    lat_edges = np.linspace(south, north, grid_rows + 1)

    rows_out = []
    for i in range(grid_rows):
        for j in range(grid_cols):
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


def run_analysis(bbox, slope_max_deg=10.0, slope_weight=0.6, landcover_weight=0.4,
                  grid_cols=144, grid_rows=120):
    """bbox = [west, south, east, north] in decimal degrees. Returns a
    GeoJSON FeatureCollection dict — same shape the frontend already
    fetches from public/data/suitability_score.geojson, just computed on
    demand instead of pre-baked. Each feature carries score plus the raw
    slope_deg/landcover_class it was computed from, same as the pipeline
    scripts, so the map tooltip works identically once this is wired in."""
    west, south, east, north = bbox
    if east <= west or north <= south:
        raise ValueError("bbox must be [west, south, east, north] with east > west and north > south")

    area_deg2 = (east - west) * (north - south)
    if area_deg2 > MAX_AOI_DEG2:
        raise AOITooLargeError(
            f"AOI is {area_deg2:.3f} sq degrees — max allowed for now is {MAX_AOI_DEG2} "
            "(keeps one request from taking minutes to fetch and process)."
        )

    with tempfile.TemporaryDirectory() as work_dir:
        dem_path = _fetch_dem(bbox, work_dir)
        slope_score, slope_deg, transform, crs, shape = _compute_slope_score(dem_path, bbox, slope_max_deg)
        landcover_score, landcover_codes = _get_landcover_score_aligned(transform, crs, shape, bbox)

    combined = slope_weight * slope_score + landcover_weight * landcover_score
    cells = _grid_average(combined, slope_deg, landcover_codes, transform, bbox, grid_cols, grid_rows)

    gdf = gpd.GeoDataFrame(cells, crs=crs)
    return gdf.__geo_interface__
