"""Offline verification of backend/suitability.py's C1/C2 changes.

Network egress is blocked in this environment, so the three functions that
reach out (DEM fetch, WorldCover, ArcGIS) are stubbed with synthetic data
whose correct answer can be worked out by hand. That makes this a test of the
*scoring logic* — weighting, gridding, UTM distance, exclusion, output shape —
which is exactly the part that changed.
"""
import json
import os
import pathlib, sys

import numpy as np
import rasterio
from rasterio.transform import from_bounds

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "backend"))
import suitability as S

BBOX = [-97.05, 37.70, -96.70, 37.95]
DEM_W, DEM_H = 300, 250

failures = []


def check(name, passed, detail=""):
    print(f"{'PASS' if passed else 'FAIL'}  {name}{f' — {detail}' if detail else ''}")
    if not passed:
        failures.append(name)


def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


# ── Stubs ──────────────────────────────────────────────────────────────────
def fake_fetch_dem(bbox, work_dir):
    """Perfectly flat DEM -> slope 0 everywhere -> slope_score 100."""
    west, south, east, north = bbox
    transform = from_bounds(west, south, east, north, DEM_W, DEM_H)
    path = os.path.join(work_dir, "fake_dem.tif")
    with rasterio.open(
        path, "w", driver="GTiff", height=DEM_H, width=DEM_W, count=1,
        dtype="int16", crs="EPSG:4326", transform=transform,
    ) as dst:
        dst.write(np.full((DEM_H, DEM_W), 400, dtype="int16"), 1)
    return path


def fake_landcover(ref_transform, ref_crs, ref_shape, bbox):
    """All Grassland (code 30 -> score 90)."""
    return (
        np.full(ref_shape, 90, dtype=np.float32),
        np.full(ref_shape, 30, dtype=np.float32),
    )


# A single N-S transmission line on the AOI's western edge, and a protected
# polygon covering the western ~10% of the AOI.
LINE_LON = BBOX[0]
PROTECTED_EAST = BBOX[0] + (BBOX[2] - BBOX[0]) * 0.1


def fake_query_arcgis(base_url, bbox):
    if "Transmission" in base_url:
        return {"type": "FeatureCollection", "features": [{
            "type": "Feature", "properties": {"VOLTAGE": 138},
            "geometry": {"type": "LineString",
                         "coordinates": [[LINE_LON, 37.0], [LINE_LON, 38.5]]},
        }]}
    return {"type": "FeatureCollection", "features": [{
        "type": "Feature", "properties": {"Mang_Name": "Test Reserve"},
        "geometry": {"type": "Polygon", "coordinates": [[
            [BBOX[0], BBOX[1]], [PROTECTED_EAST, BBOX[1]],
            [PROTECTED_EAST, BBOX[3]], [BBOX[0], BBOX[3]], [BBOX[0], BBOX[1]],
        ]]},
    }]}


S._fetch_dem = fake_fetch_dem
S._get_landcover_score_aligned = fake_landcover
S._query_arcgis = fake_query_arcgis

# ── 1. Backward compatibility: no transmission weight ─────────────────────
r = S.run_analysis(BBOX, slope_weight=0.6, landcover_weight=0.4,
                   apply_exclusions=False, grid_cols=36, grid_rows=30)
md = r["metadata"]
expected = 0.6 * 100 + 0.4 * 90
check("Two-criterion score matches 0.6*100 + 0.4*90",
      approx(md["mean_score"], expected, 0.05), f"{md['mean_score']} vs {expected}")
check("Transmission not queried when its weight is 0",
      md["transmission_lines_found"] is None and md["transmission_max_km"] is None)
check("Cell count matches the requested grid", md["cell_count"] == 36 * 30,
      str(md["cell_count"]))

# ── 2. Weight normalization ───────────────────────────────────────────────
r2 = S.run_analysis(BBOX, slope_weight=60, landcover_weight=40,
                    apply_exclusions=False, grid_cols=12, grid_rows=10)
w = r2["metadata"]["weights"]
check("Un-normalized weights (60/40) normalize to 0.6/0.4",
      approx(w["slope"], 0.6, 1e-4) and approx(w["landcover"], 0.4, 1e-4),
      json.dumps(w))
check("Normalized weights sum to 1",
      approx(w["slope"] + w["landcover"] + w["transmission"], 1.0, 1e-4))

try:
    S.run_analysis(BBOX, slope_weight=0, landcover_weight=0, transmission_weight=0,
                   grid_cols=4, grid_rows=4)
    check("All-zero weights rejected", False, "no error raised")
except ValueError:
    check("All-zero weights rejected", True)

# ── 3. Transmission criterion ─────────────────────────────────────────────
r3 = S.run_analysis(BBOX, slope_weight=0, landcover_weight=0, transmission_weight=1,
                    transmission_max_km=10.0, apply_exclusions=False,
                    grid_cols=36, grid_rows=30)
feats = r3["features"]
md3 = r3["metadata"]
check("Transmission lines were found", md3["transmission_lines_found"] == 1,
      str(md3["transmission_lines_found"]))
check("Pure-transmission run reports weight 1.0",
      approx(md3["weights"]["transmission"], 1.0, 1e-4))

props = [f["properties"] for f in feats]
dists = [p["transmission_km"] for p in props]
scores = [p["score"] for p in props]
check("Every cell has a numeric distance", all(isinstance(d, float) for d in dists))

# Westernmost cells sit on the line -> near 0 km, score near 100.
west_cells = [p for p in props if p["transmission_km"] < 0.6]
check("Cells on the line score near 100",
      bool(west_cells) and all(p["score"] > 93 for p in west_cells),
      f"{len(west_cells)} cells, min score {min((p['score'] for p in west_cells), default=None)}")

# The AOI is ~31 km wide, so the eastern side is well past the 10 km cutoff.
far_cells = [p for p in props if p["transmission_km"] > 10.0]
check("Cells past the cutoff score exactly 0",
      bool(far_cells) and all(p["score"] == 0 for p in far_cells),
      f"{len(far_cells)} cells beyond 10km")

# Linearity: score should equal 100*(1 - d/10) inside the cutoff.
inside = [p for p in props if 0.5 < p["transmission_km"] < 9.5]
worst = max(abs(p["score"] - 100 * (1 - p["transmission_km"] / 10.0)) for p in inside)
check("Falloff is linear between 0 and the cutoff", worst < 0.15,
      f"max deviation {worst:.3f} over {len(inside)} cells")

check("Distances are metric, not degrees (AOI ~31 km wide)",
      25 < max(dists) < 36, f"max distance {max(dists):.1f} km")

# A tighter cutoff must push more cells to zero.
r3b = S.run_analysis(BBOX, slope_weight=0, landcover_weight=0, transmission_weight=1,
                     transmission_max_km=5.0, apply_exclusions=False,
                     grid_cols=36, grid_rows=30)
zeros_10 = sum(1 for f in feats if f["properties"]["score"] == 0)
zeros_5 = sum(1 for f in r3b["features"] if f["properties"]["score"] == 0)
check("A 5 km cutoff zeroes more cells than a 10 km cutoff", zeros_5 > zeros_10,
      f"{zeros_5} vs {zeros_10}")

# ── 4. Protected-land exclusion ───────────────────────────────────────────
r4 = S.run_analysis(BBOX, slope_weight=0.6, landcover_weight=0.4,
                    apply_exclusions=True, grid_cols=36, grid_rows=30)
md4 = r4["metadata"]
excluded = [f["properties"] for f in r4["features"] if f["properties"]["excluded"]]
kept = [f["properties"] for f in r4["features"] if not f["properties"]["excluded"]]
check("Protected areas were found", md4["protected_areas_found"] == 1)
check("Some but not all cells are excluded",
      0 < len(excluded) < md4["cell_count"],
      f"{len(excluded)} of {md4['cell_count']}")
check("metadata.excluded_cells matches the features",
      md4["excluded_cells"] == len(excluded))
check("Excluded cells keep exactly 5% of the unexcluded score",
      all(approx(p["score"], round(96.0 * 0.05, 1), 0.06) for p in excluded),
      f"sample {excluded[0]['score'] if excluded else None} (expected 4.8)")
check("Unexcluded cells are untouched",
      all(approx(p["score"], 96.0, 0.06) for p in kept))

r4b = S.run_analysis(BBOX, slope_weight=0.6, landcover_weight=0.4,
                     apply_exclusions=False, grid_cols=36, grid_rows=30)
check("apply_exclusions=False disables the exclusion",
      r4b["metadata"]["excluded_cells"] == 0
      and r4b["metadata"]["protected_areas_found"] is None)
check("Exclusion lowers the mean score",
      md4["mean_score"] < r4b["metadata"]["mean_score"],
      f"{md4['mean_score']} < {r4b['metadata']['mean_score']}")

# ── 5. Three criteria together ────────────────────────────────────────────
r5 = S.run_analysis(BBOX, slope_weight=0.5, landcover_weight=0.3, transmission_weight=0.2,
                    transmission_max_km=10.0, apply_exclusions=False,
                    grid_cols=36, grid_rows=30)
bad = []
for f in r5["features"]:
    p = f["properties"]
    want = 0.5 * p["slope_score"] + 0.3 * p["landcover_score"] + 0.2 * p["transmission_score"]
    if abs(p["score"] - want) > 0.11:
        bad.append((p["score"], want))
check("Combined score equals the weighted sum of its parts", not bad,
      f"{len(bad)} mismatches" + (f", e.g. {bad[0]}" if bad else ""))
check("Per-criterion sub-scores are all present",
      all(k in r5["features"][0]["properties"]
          for k in ("slope_score", "landcover_score", "transmission_score",
                    "slope_deg", "landcover_class", "transmission_km", "excluded")))

# ── 6. Output is valid, serializable GeoJSON ──────────────────────────────
try:
    text = json.dumps(r5, allow_nan=False)
    check("Result serializes as strict JSON (no NaN/Infinity)", True,
          f"{len(text)//1024} KB")
except ValueError as e:
    check("Result serializes as strict JSON (no NaN/Infinity)", False, str(e))
check("Top-level shape is a FeatureCollection with metadata",
      r5["type"] == "FeatureCollection" and "metadata" in r5)

# transmission_km must be null (not NaN) when no lines exist.
S._query_arcgis = lambda url, bbox: {"type": "FeatureCollection", "features": []}
r6 = S.run_analysis(BBOX, slope_weight=0.5, landcover_weight=0.3, transmission_weight=0.2,
                    apply_exclusions=True, grid_cols=12, grid_rows=10)
check("No lines in range -> transmission scores 0, distance null",
      all(f["properties"]["transmission_score"] == 0
          and f["properties"]["transmission_km"] is None for f in r6["features"]))
check("No-lines case is reported in metadata",
      r6["metadata"]["transmission_lines_found"] == 0)
try:
    json.dumps(r6, allow_nan=False)
    check("No-lines result still serializes strictly", True)
except ValueError as e:
    check("No-lines result still serializes strictly", False, str(e))

# ── 7. Guards ─────────────────────────────────────────────────────────────
for bad_bbox, label in [([-96.7, 37.7, -97.05, 37.95], "east <= west"),
                        ([-97.05, 37.95, -96.7, 37.7], "north <= south")]:
    try:
        S.run_analysis(bad_bbox, grid_cols=4, grid_rows=4)
        check(f"Rejects degenerate bbox ({label})", False, "no error")
    except ValueError:
        check(f"Rejects degenerate bbox ({label})", True)

try:
    S.run_analysis([-98.0, 37.0, -96.0, 38.0], grid_cols=4, grid_rows=4)
    check("Rejects an over-cap AOI", False, "no error")
except S.AOITooLargeError:
    check("Rejects an over-cap AOI", True)

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)
