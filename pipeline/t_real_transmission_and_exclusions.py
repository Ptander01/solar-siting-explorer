"""
T1 + T2: real transmission-line data (replacing the M2 placeholder lines)
and real protected-land exclusions (folded into the M5 suitability score
as an actual scoring factor, not just a display layer).

Data sources — both verified public, no token/login required:
  - HIFLD Electric Power Transmission Lines
    https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0
  - USGS PAD-US v3.0 (Protected Areas Database of the US), Manager_Name layer
    https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Manager_Name/FeatureServer/0

Run (same venv as M3/M5, from the pipeline/ folder):
    python3 t_real_transmission_and_exclusions.py

Needs internet access — run on your own machine. Requires
public/data/suitability_score.geojson to already exist (from M5).

Outputs:
  ../public/data/transmission_lines.geojson  (real HIFLD data)
  ../public/data/protected_areas.geojson     (real PAD-US data)
  ../public/data/suitability_score.geojson   (overwritten — cells overlapping
                                               protected land get their score
                                               cut to 5% of its original value)
"""

import json
import os
import urllib.parse
import urllib.request

import geopandas as gpd

WEST, SOUTH, EAST, NORTH = -97.05, 37.70, -96.70, 37.95

TRANSMISSION_URL = (
    "https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/"
    "Electric_Power_Transmission_Lines/FeatureServer/0/query"
)
PROTECTED_URL = (
    "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/"
    "Manager_Name/FeatureServer/0/query"
)

SUITABILITY_PATH = "../public/data/suitability_score.geojson"
TRANSMISSION_OUT = "../public/data/transmission_lines.geojson"
PROTECTED_OUT = "../public/data/protected_areas.geojson"

EXCLUSION_FACTOR = 0.05  # protected-land cells keep only 5% of their score


def query_arcgis(base_url, bbox):
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
    with urllib.request.urlopen(url) as resp:
        data = json.loads(resp.read())
    if "error" in data:
        raise RuntimeError(f"ArcGIS query error: {data['error']}")
    return data


def main():
    bbox = (WEST, SOUTH, EAST, NORTH)
    os.makedirs(os.path.dirname(TRANSMISSION_OUT), exist_ok=True)

    print("Fetching real transmission lines from HIFLD...")
    lines = query_arcgis(TRANSMISSION_URL, bbox)
    with open(TRANSMISSION_OUT, "w") as f:
        json.dump(lines, f)
    features = lines.get("features", [])
    print(f"  {len(features)} transmission line segments -> {TRANSMISSION_OUT}")
    if features:
        print(f"  Available fields: {list(features[0]['properties'].keys())}")

    print("Fetching protected areas from PAD-US...")
    protected = query_arcgis(PROTECTED_URL, bbox)
    with open(PROTECTED_OUT, "w") as f:
        json.dump(protected, f)
    print(f"  {len(protected.get('features', []))} protected area polygons -> {PROTECTED_OUT}")

    print("Applying protected-area exclusion to the suitability score...")
    if not os.path.exists(SUITABILITY_PATH):
        raise SystemExit(f"Missing {SUITABILITY_PATH} — run m5_suitability_score.py first.")

    suitability = gpd.read_file(SUITABILITY_PATH)
    protected_features = protected.get("features", [])

    if protected_features:
        protected_gdf = gpd.GeoDataFrame.from_features(protected_features, crs="EPSG:4326")
        protected_union = (
            protected_gdf.union_all()
            if hasattr(protected_gdf, "union_all")
            else protected_gdf.unary_union
        )
        overlap = suitability.geometry.intersects(protected_union)
        n_excluded = int(overlap.sum())
        suitability.loc[overlap, "score"] = suitability.loc[overlap, "score"] * EXCLUSION_FACTOR
        print(f"  {n_excluded} of {len(suitability)} grid cells overlap protected land — suitability reduced")
    else:
        print("  No protected areas found in this AOI — nothing to exclude.")

    suitability.to_file(SUITABILITY_PATH, driver="GeoJSON")
    print(f"Updated {SUITABILITY_PATH}")
    print(f"New mean score: {suitability['score'].mean():.1f} / 100")


if __name__ == "__main__":
    main()
