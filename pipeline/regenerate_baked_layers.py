"""
Rebuild every pre-baked layer in public/data/ from a single analysis run.

**This is now the canonical way to regenerate the pilot AOI's data.** It
supersedes running m3 -> m5 -> t_real_transmission_and_exclusions -> t3 in
sequence. Those scripts still work and are worth keeping as a record of how
the pipeline was built up milestone by milestone, but they encode an older
methodology (see below) and will produce different numbers.

Why this exists
---------------
The scoring logic used to live in three places: m5_suitability_score.py,
t_real_transmission_and_exclusions.py, and (after B1) backend/suitability.py.
Three copies is how the baked layers and the live API drift apart, and it's
how the project ended up describing a four-criterion score while the code
computed two. This script imports run_analysis() from backend/suitability.py
— the same function the API calls — so the batch output and a live run are
the same computation with the same defaults, by construction.

What changed versus the older scripts
-------------------------------------
  - **Transmission proximity is now a real scored criterion**, not just a
    display layer. m5 scored slope and land cover only; the HIFLD lines were
    fetched purely to draw on the map.
  - **The protected-land exclusion is applied inside the same run**, rather
    than as a post-hoc pass that rewrote an already-written GeoJSON.
  - Weights are 45 / 30 / 25 (slope / land cover / transmission). That keeps
    the original 60:40 slope-to-land-cover ratio exactly (0.45:0.30 == 6:4)
    and gives interconnection proximity a 25% share — defensible for
    utility-scale solar, where distance to a suitable line is a leading cost
    driver, without letting it dominate the physical site constraints.

Run (from the pipeline/ folder, with the backend's dependencies available —
the backend venv works, or install pipeline/requirements.txt plus fastapi's
deps):
    python3 regenerate_baked_layers.py

Needs internet access — run on your own machine.

Outputs (all under ../public/data/):
    suitability_score.geojson    combined 0-100 score
    slope_score.geojson          slope criterion on its own
    landcover_score.geojson      land cover criterion on its own
    transmission_score.geojson   transmission criterion on its own (new)
    transmission_lines.geojson   HIFLD lines, for display
    protected_areas.geojson      PAD-US polygons, for display
"""

import json
import os
import sys

# backend/ holds the single source of truth for the scoring logic.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from suitability import (  # noqa: E402
    PROTECTED_URL,
    TRANSMISSION_URL,
    _buffered_bbox,
    _query_arcgis,
    run_analysis,
)

# --- Pilot AOI: El Dorado, Butler County, KS (unchanged) ---
BBOX = [-97.05, 37.70, -96.70, 37.95]

SLOPE_MAX_DEG = 10.0
SLOPE_WEIGHT = 0.45
LANDCOVER_WEIGHT = 0.30
TRANSMISSION_WEIGHT = 0.25
TRANSMISSION_MAX_KM = 10.0

GRID_COLS = 144
GRID_ROWS = 120

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "data")

# Which per-cell sub-score becomes the `score` field of each standalone
# criterion layer. The frontend's symbology, histogram and select-by-score
# filter all key off `score`, so each layer is just the same grid with a
# different column promoted.
CRITERION_LAYERS = {
    "slope_score.geojson": "slope_score",
    "landcover_score.geojson": "landcover_score",
    "transmission_score.geojson": "transmission_score",
}


def write_geojson(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f)


def criterion_layer(result, field):
    """Project the full result down to one criterion, promoting that
    criterion's sub-score to `score`. Keeps the raw context fields so the
    tooltip reads the same on every layer."""
    features = []
    for feat in result["features"]:
        props = feat["properties"]
        features.append({
            "type": "Feature",
            "geometry": feat["geometry"],
            "properties": {
                "score": props[field],
                "slope_deg": props.get("slope_deg"),
                "landcover_class": props.get("landcover_class"),
                "transmission_km": props.get("transmission_km"),
            },
        })
    return {"type": "FeatureCollection", "features": features}


def main():
    print(f"Running the full analysis for the pilot AOI {BBOX}...")
    print(f"  weights: slope {SLOPE_WEIGHT} / land cover {LANDCOVER_WEIGHT} / "
          f"transmission {TRANSMISSION_WEIGHT}")
    result = run_analysis(
        bbox=BBOX,
        slope_max_deg=SLOPE_MAX_DEG,
        slope_weight=SLOPE_WEIGHT,
        landcover_weight=LANDCOVER_WEIGHT,
        transmission_weight=TRANSMISSION_WEIGHT,
        transmission_max_km=TRANSMISSION_MAX_KM,
        apply_exclusions=True,
        grid_cols=GRID_COLS,
        grid_rows=GRID_ROWS,
    )
    md = result["metadata"]
    print(f"  {md['cell_count']} cells · mean score {md['mean_score']}")
    print(f"  {md['transmission_lines_found']} transmission line segments in range")
    print(f"  {md['protected_areas_found']} protected areas · "
          f"{md['excluded_cells']} cells excluded")

    combined_path = os.path.join(OUT_DIR, "suitability_score.geojson")
    write_geojson(combined_path, result)
    print(f"Wrote {combined_path}")

    for filename, field in CRITERION_LAYERS.items():
        path = os.path.join(OUT_DIR, filename)
        write_geojson(path, criterion_layer(result, field))
        print(f"Wrote {path}")

    # Display-only vector layers. Transmission uses the same padded bbox the
    # scoring does, so the lines drawn on the map are the same ones the
    # distances were measured against — otherwise a cell could score highly
    # off a line the user can't see.
    print("Fetching display layers...")
    lines = _query_arcgis(TRANSMISSION_URL, _buffered_bbox(BBOX, TRANSMISSION_MAX_KM))
    write_geojson(os.path.join(OUT_DIR, "transmission_lines.geojson"), lines)
    print(f"  {len(lines.get('features', []))} transmission segments")

    protected = _query_arcgis(PROTECTED_URL, BBOX)
    write_geojson(os.path.join(OUT_DIR, "protected_areas.geojson"), protected)
    print(f"  {len(protected.get('features', []))} protected areas")

    print("\nDone. All baked layers now share one grid and one methodology.")


if __name__ == "__main__":
    main()
