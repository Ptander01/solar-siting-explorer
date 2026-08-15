"""
Core suitability computation — the single source of truth for how a
suitability score is calculated in this project.

Originally (B1) this was a refactor of pipeline/m3_slope_suitability.py (DEM
fetch) and pipeline/m5_suitability_score.py (scoring/grid) so the same logic
could run for an arbitrary bbox + weights instead of only the hardcoded pilot
AOI. As of C1/C2 it has grown past those scripts and is now the canonical
implementation:

  - **C2 — transmission proximity is a real scored criterion.** It previously
    was not, anywhere in the project: m5 combined slope and land cover only,
    and t_real_transmission_and_exclusions.py fetched HIFLD lines purely as a
    display layer while applying the PAD-US exclusion to the score. The
    write-up nonetheless described a four-criterion score. This module closes
    that gap for real rather than by editing the claim down.
  - **C2 — the PAD-US protected-land exclusion** is applied here too, so a
    live run matches the baked layer's methodology instead of stopping at the
    pre-exclusion score.
  - **C1 — SRTM tiles are cached on disk** between requests instead of being
    re-downloaded into a per-request temp dir.

pipeline/regenerate_baked_layers.py imports run_analysis() from this module
to rebuild the pre-baked public/data/*.geojson, so the batch output and the
live API cannot drift apart. main.py's /analyze endpoint calls it too.
"""

import gzip
import json
import math
import os
import shutil
import tempfile
import urllib.parse
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

# Same public, no-token ArcGIS REST services the pipeline uses.
TRANSMISSION_URL = (
    "https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/"
    "Electric_Power_Transmission_Lines/FeatureServer/0/query"
)
PROTECTED_URL = (
    "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/"
    "Manager_Name/FeatureServer/0/query"
)

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

WORLDCOVER_LABELS = {
    10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland",
    50: "Built-up", 60: "Bare / sparse vegetation", 70: "Snow and ice",
    80: "Permanent water bodies", 90: "Herbaceous wetland", 95: "Mangroves",
    100: "Moss and lichen",
}

# Protected-land cells keep only 5% of their score — a hard exclusion rather
# than a soft penalty, matching how siting studies treat legally protected
# land (and matching EXCLUSION_FACTOR in the pipeline script).
EXCLUSION_FACTOR = 0.05

# Distance (km) at which the transmission-proximity score reaches 0. Default
# chosen to be the same shape of rule as the slope criterion: linear falloff
# from 100 at the line to 0 at the cutoff. 10 km is a defensible default for
# utility-scale interconnection — far enough that most of a county scores
# non-zero, close enough that the criterion actually discriminates — but it's
# a parameter precisely because the right value is project-specific.
DEFAULT_TRANSMISSION_MAX_KM = 10.0

# Safety cap so one request can't ask for, say, all of Kansas and take
# minutes to fetch/process. The frontend checks the same number client-side
# so an over-cap AOI is rejected before the request is made.
MAX_AOI_DEG2 = 1.0

# The equivalent cap for /context, which only fetches vector features for
# display — no rasters, no scoring — so it can afford a wider window than an
# analysis run. Still bounded: these are national datasets, and a request for
# the whole country would return tens of megabytes and help nobody. The
# frontend also refuses to ask below a zoom floor.
MAX_CONTEXT_DEG2 = 6.0

# Decimal places kept on output grid-cell coordinates. Six is ~10 cm at this
# latitude, against grid cells ~210 m across — so this is lossless in every
# sense that matters, and it is not a micro-optimization: numpy's linspace
# produces values like -97.04756944444445, and at 17,280 cells x 5 corners
# that repr alone was most of a 9 MB GeoJSON file. Rounding the grid edges
# (rather than the finished geometries) also makes adjacent cells share
# byte-identical edge coordinates instead of near-misses.
COORD_DECIMALS = 6

# C1 — where fetched SRTM tiles live between requests. Overridable so the
# container can mount a volume at a known path (see docker-compose.yml);
# defaults under the system temp dir so a bare `uvicorn main:app` still works
# with no setup.
CACHE_DIR = os.environ.get("SSE_CACHE_DIR") or os.path.join(
    tempfile.gettempdir(), "sse-dem-cache"
)


class AOITooLargeError(ValueError):
    pass


# ── SRTM elevation ─────────────────────────────────────────────────────────

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


def _cached_tile(name):
    """C1 — return a local path to SRTM tile `name`, downloading it only if
    it isn't already cached.

    SRTM tiles are immutable 1x1-degree products, so there's nothing to
    invalidate: a tile fetched once is good forever. Before this, every
    request re-downloaded ~25 MB per tile into a temp dir that was deleted
    moments later, which dominated the wall-clock time of a run and made
    re-running with different weights over the same area needlessly slow.

    The download goes to a `.part` file and is then atomically renamed, so a
    request that dies mid-download can't leave a truncated tile behind for
    the next one to read as valid.
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    hgt_path = os.path.join(CACHE_DIR, f"{name}.hgt")
    if os.path.exists(hgt_path) and os.path.getsize(hgt_path) > 0:
        return hgt_path

    url = f"{SRTM_BASE}/{name[:3]}/{name}.hgt.gz"
    gz_path = f"{hgt_path}.gz.part"
    part_path = f"{hgt_path}.part"
    try:
        urllib.request.urlretrieve(url, gz_path)
        with gzip.open(gz_path, "rb") as f_in, open(part_path, "wb") as f_out:
            shutil.copyfileobj(f_in, f_out)
        os.replace(part_path, hgt_path)
    except Exception as e:
        raise RuntimeError(
            f"Couldn't fetch SRTM tile {name} — is this AOI over land? ({e})"
        )
    finally:
        for leftover in (gz_path, part_path):
            if os.path.exists(leftover):
                try:
                    os.remove(leftover)
                except OSError:
                    pass
    return hgt_path


def _fetch_dem(bbox, work_dir):
    """Download (or reuse cached) SRTM tiles, mosaic, and clip to the AOI.
    Same flow as m3_slope_suitability.py's fetch_dem(); the mosaic/clip
    intermediates are per-request (they're AOI-specific), but the source
    tiles come from the shared cache."""
    west, south, east, north = bbox
    hgt_paths = [_cached_tile(name) for name in _tiles_for_bbox(west, south, east, north)]

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


# ── ESA WorldCover land cover ──────────────────────────────────────────────

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


# ── Vector criteria: transmission lines and protected areas ────────────────

def _query_arcgis(base_url, bbox):
    """Same public envelope query the pipeline script uses. Returns a GeoJSON
    dict; raises RuntimeError on an ArcGIS-level error so main.py can map it
    to a 502 rather than a generic 500."""
    params = {
        "where": "1=1",
        "geometry": ",".join(str(v) for v in bbox),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "outSR": "4326",
        "f": "geojson",
    }
    url = f"{base_url}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=90) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        raise RuntimeError(f"ArcGIS query failed ({base_url.split('/services/')[-1][:40]}): {e}")
    if "error" in data:
        raise RuntimeError(f"ArcGIS query error: {data['error']}")
    return data


def _buffered_bbox(bbox, pad_km):
    """Expand a bbox by roughly `pad_km` in every direction.

    This matters for the transmission criterion specifically: the ArcGIS
    envelope query only returns lines that intersect the box it's given, so
    querying the raw AOI would miss a line running 500 m outside its edge and
    score every nearby cell as if the grid were unreachable. Querying a
    padded box and *then* measuring distance is the difference between
    "distance to the nearest line" and "distance to the nearest line that
    happens to be inside my study area".
    """
    west, south, east, north = bbox
    lat_pad = pad_km / 111.32
    mid_lat = (north + south) / 2
    # Guard the cosine against a degenerate value near the poles.
    lon_scale = max(math.cos(math.radians(mid_lat)), 0.01)
    lon_pad = pad_km / (111.32 * lon_scale)
    return (west - lon_pad, south - lat_pad, east + lon_pad, north + lat_pad)


def _transmission_score(cells_gdf, bbox, transmission_max_km):
    """C2 — distance-to-nearest-transmission-line as a real scored criterion.

    Linear falloff: 100 at the line, 0 at `transmission_max_km`. Deliberately
    the same shape of rule as the slope criterion (100 at 0 degrees, 0 at
    slope_max_deg) — using one consistent, explainable curve across criteria
    is much easier to defend than a mix of curves with per-criterion
    justifications.

    Distances are measured in a projected CRS, not in degrees. GeoPandas'
    estimate_utm_crs() picks the appropriate UTM zone for the AOI, so
    `.distance()` returns metres rather than a degree value that means
    different things at different latitudes.

    Returns (score_array, distance_km_array, n_lines).
    """
    lines_geojson = _query_arcgis(
        TRANSMISSION_URL, _buffered_bbox(bbox, transmission_max_km)
    )
    features = lines_geojson.get("features", [])
    n_lines = len(features)

    if not features:
        # No line within the cutoff of this AOI. Scoring 0 is the correct
        # answer for a siting tool — genuinely remote land is genuinely worse
        # for interconnection — but it's surfaced in the response metadata so
        # the UI can say so rather than leaving the user to wonder why every
        # score dropped.
        zeros = np.zeros(len(cells_gdf), dtype=float)
        return zeros, np.full(len(cells_gdf), np.nan), 0

    lines_gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    utm = cells_gdf.estimate_utm_crs()
    cells_m = cells_gdf.to_crs(utm)
    lines_m = lines_gdf.to_crs(utm)
    lines_union = (
        lines_m.union_all() if hasattr(lines_m, "union_all") else lines_m.unary_union
    )

    distance_m = cells_m.geometry.distance(lines_union).to_numpy()
    distance_km = distance_m / 1000.0
    score = 100 * np.clip(
        (transmission_max_km - distance_km) / transmission_max_km, 0, 1
    )
    return score, distance_km, n_lines


def _protected_mask(cells_gdf, bbox):
    """C2 — which cells overlap PAD-US protected land. Same intersects()
    overlay as t_real_transmission_and_exclusions.py, just applied here so a
    live run reaches the same answer as the baked layer.

    Returns (bool_array, n_protected_features)."""
    protected_geojson = _query_arcgis(PROTECTED_URL, bbox)
    features = protected_geojson.get("features", [])
    if not features:
        return np.zeros(len(cells_gdf), dtype=bool), 0

    protected_gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    protected_union = (
        protected_gdf.union_all()
        if hasattr(protected_gdf, "union_all")
        else protected_gdf.unary_union
    )
    return cells_gdf.geometry.intersects(protected_union).to_numpy(), len(features)


# ── Gridding ───────────────────────────────────────────────────────────────

def _grid_cells(arrays, landcover_codes_arr, transform, bbox, grid_cols, grid_rows):
    """Average each raster in `arrays` (a name -> 2D array dict) onto the
    output grid in a single pass.

    This used to average one pre-combined array. It averages the criteria
    separately now because the transmission criterion is computed per *cell*
    (a vector distance, not a raster), so all three criteria have to meet at
    cell level to be weighted together. Keeping the per-criterion values also
    means the tooltip and the standalone criteria layers read straight off
    the same objects rather than recomputing anything.
    """
    west, south, east, north = bbox
    # Rounded here, at the source, so every consumer benefits: the pre-baked
    # files the browser downloads on first paint and the live /analyze
    # response both shrink, with no change to the frontend.
    lon_edges = np.round(np.linspace(west, east, grid_cols + 1), COORD_DECIMALS)
    lat_edges = np.round(np.linspace(south, north, grid_rows + 1), COORD_DECIMALS)
    any_arr = next(iter(arrays.values()))

    rows_out = []
    for i in range(grid_rows):
        for j in range(grid_cols):
            cell_w, cell_e = lon_edges[j], lon_edges[j + 1]
            cell_s, cell_n = lat_edges[i], lat_edges[i + 1]

            r0, c0 = rowcol(transform, cell_w, cell_n)
            r1, c1 = rowcol(transform, cell_e, cell_s)
            r0, r1 = sorted((max(r0, 0), min(r1, any_arr.shape[0])))
            c0, c1 = sorted((max(c0, 0), min(c1, any_arr.shape[1])))
            if r1 <= r0 or c1 <= c0:
                continue

            means = {}
            skip = False
            for name, arr in arrays.items():
                block = arr[r0:r1, c0:c1]
                if block.size == 0:
                    skip = True
                    break
                value = float(np.nanmean(block))
                if np.isnan(value):
                    skip = True
                    break
                means[name] = value
            if skip:
                continue

            means["landcover_class"] = _dominant_landcover_label(
                landcover_codes_arr[r0:r1, c0:c1]
            )
            means["geometry"] = box(cell_w, cell_s, cell_e, cell_n)
            rows_out.append(means)
    return rows_out


def _normalize_weights(slope_weight, landcover_weight, transmission_weight):
    """Weights are normalized rather than validated-and-rejected: a caller
    passing 60/40/20 almost certainly means "these relative priorities", not
    "please return scores that can exceed 100". Normalizing keeps the output
    on a real 0-100 scale no matter what comes in, and the normalized values
    are echoed back in the response metadata so the caller can see what was
    actually applied."""
    weights = np.array(
        [max(slope_weight, 0.0), max(landcover_weight, 0.0), max(transmission_weight, 0.0)],
        dtype=float,
    )
    total = weights.sum()
    if total <= 0:
        raise ValueError("At least one criterion weight must be greater than zero.")
    return weights / total


# ── Entry point ────────────────────────────────────────────────────────────

def run_analysis(
    bbox,
    slope_max_deg=10.0,
    slope_weight=0.6,
    landcover_weight=0.4,
    transmission_weight=0.0,
    transmission_max_km=DEFAULT_TRANSMISSION_MAX_KM,
    apply_exclusions=True,
    grid_cols=144,
    grid_rows=120,
):
    """bbox = [west, south, east, north] in decimal degrees.

    Returns a GeoJSON FeatureCollection dict — the same shape the frontend
    fetches from public/data/*.geojson — plus a top-level `metadata` member
    (a legal GeoJSON foreign member) describing what was actually applied:
    normalized weights, how many transmission lines and protected areas were
    found, how many cells were excluded, and the mean score.

    Each feature carries the combined `score` plus the per-criterion values
    behind it (`slope_deg`, `landcover_class`, `transmission_km`, and each
    criterion's own 0-100 sub-score), so the map can show its work.

    `transmission_weight` defaults to 0 for backward compatibility: an
    existing caller that passes only slope/landcover weights gets exactly the
    old two-criterion behaviour, and the extra ArcGIS round trip is skipped
    entirely rather than being fetched and multiplied by zero.
    """
    west, south, east, north = bbox
    if east <= west or north <= south:
        raise ValueError("bbox must be [west, south, east, north] with east > west and north > south")
    if transmission_max_km <= 0:
        raise ValueError("transmission_max_km must be greater than zero")

    area_deg2 = (east - west) * (north - south)
    if area_deg2 > MAX_AOI_DEG2:
        raise AOITooLargeError(
            f"AOI is {area_deg2:.3f} sq degrees — max allowed for now is {MAX_AOI_DEG2} "
            "(keeps one request from taking minutes to fetch and process)."
        )

    w_slope, w_landcover, w_transmission = _normalize_weights(
        slope_weight, landcover_weight, transmission_weight
    )

    with tempfile.TemporaryDirectory() as work_dir:
        dem_path = _fetch_dem(bbox, work_dir)
        slope_score, slope_deg, transform, crs, shape = _compute_slope_score(
            dem_path, bbox, slope_max_deg
        )
        landcover_score, landcover_codes = _get_landcover_score_aligned(
            transform, crs, shape, bbox
        )

    cells = _grid_cells(
        {
            "slope_score": slope_score,
            "landcover_score": landcover_score,
            "slope_deg": slope_deg,
        },
        landcover_codes,
        transform,
        bbox,
        grid_cols,
        grid_rows,
    )
    if not cells:
        raise RuntimeError("No grid cells produced for this AOI — is the bbox degenerate?")

    gdf = gpd.GeoDataFrame(cells, crs=crs)

    # Transmission is a per-cell vector measurement, so it joins the raster
    # criteria here rather than upstream.
    if w_transmission > 0:
        transmission_score, transmission_km, n_lines = _transmission_score(
            gdf, bbox, transmission_max_km
        )
    else:
        transmission_score = np.zeros(len(gdf), dtype=float)
        transmission_km = np.full(len(gdf), np.nan)
        n_lines = None  # not queried

    combined = (
        w_slope * gdf["slope_score"].to_numpy()
        + w_landcover * gdf["landcover_score"].to_numpy()
        + w_transmission * transmission_score
    )

    if apply_exclusions:
        excluded, n_protected = _protected_mask(gdf, bbox)
        combined = np.where(excluded, combined * EXCLUSION_FACTOR, combined)
    else:
        excluded = np.zeros(len(gdf), dtype=bool)
        n_protected = None

    gdf["score"] = np.round(combined, 1)
    gdf["slope_score"] = np.round(gdf["slope_score"], 1)
    gdf["landcover_score"] = np.round(gdf["landcover_score"], 1)
    gdf["slope_deg"] = np.round(gdf["slope_deg"], 1)
    gdf["transmission_score"] = np.round(transmission_score, 1)
    # NaN isn't valid JSON; None round-trips as null and the frontend already
    # guards these fields with typeof checks before rendering them.
    gdf["transmission_km"] = [
        None if np.isnan(d) else round(float(d), 2) for d in transmission_km
    ]
    gdf["excluded"] = excluded

    result = gdf.__geo_interface__
    result["metadata"] = {
        "bbox": list(bbox),
        "weights": {
            "slope": round(float(w_slope), 4),
            "landcover": round(float(w_landcover), 4),
            "transmission": round(float(w_transmission), 4),
        },
        "slope_max_deg": slope_max_deg,
        "transmission_max_km": transmission_max_km if w_transmission > 0 else None,
        "transmission_lines_found": n_lines,
        "protected_areas_found": n_protected,
        "excluded_cells": int(excluded.sum()),
        "cell_count": len(gdf),
        "mean_score": round(float(np.mean(gdf["score"])), 2),
        "grid": {"cols": grid_cols, "rows": grid_rows},
    }
    return result


# ── Map context (display-only vector layers) ───────────────────────────────

def get_context_layers(bbox, transmission_pad_km=DEFAULT_TRANSMISSION_MAX_KM):
    """Transmission lines and protected areas for an arbitrary window, for
    the map to *draw*. No scoring, no rasters.

    This exists because the pre-baked public/data/*.geojson files are clipped
    to the pilot AOI, so drawing a study area anywhere else produced a score
    claiming "2 km to the nearest line" over a map with no lines on it. The
    analysis was right and the map was empty — a bad combination, since the
    map is the only thing most people will judge it by.

    Deliberately shares _query_arcgis() and _buffered_bbox() with the scoring
    path rather than reimplementing the queries, so what gets drawn is the
    same data the scoring measured against. The transmission query uses the
    same padding for the same reason it does there: a line just outside the
    window still matters, and seeing it explains why nearby cells score well.
    """
    west, south, east, north = bbox
    if east <= west or north <= south:
        raise ValueError("bbox must be [west, south, east, north] with east > west and north > south")

    area_deg2 = (east - west) * (north - south)
    if area_deg2 > MAX_CONTEXT_DEG2:
        raise AOITooLargeError(
            f"Requested window is {area_deg2:.2f} sq degrees — max for map context is "
            f"{MAX_CONTEXT_DEG2}. Zoom in."
        )

    lines = _query_arcgis(TRANSMISSION_URL, _buffered_bbox(bbox, transmission_pad_km))
    protected = _query_arcgis(PROTECTED_URL, bbox)

    return {
        "transmission": lines,
        "protected": protected,
        "metadata": {
            "bbox": list(bbox),
            "transmission_count": len(lines.get("features", [])),
            "protected_count": len(protected.get("features", [])),
            # ArcGIS caps how many features one query returns and flags it
            # here. Passed through so the UI can admit the view is partial
            # rather than quietly drawing a subset as if it were everything.
            "truncated": bool(
                lines.get("exceededTransferLimit") or protected.get("exceededTransferLimit")
            ),
        },
    }
