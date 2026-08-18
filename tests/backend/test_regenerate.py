"""Run pipeline/regenerate_baked_layers.py end to end with the three
network-touching functions stubbed, into a temp output dir. Verifies the
script itself — file writing, the criterion-layer projection, the properties
each output carries — which no test has covered until now."""
import json, os, pathlib, sys, tempfile, importlib
import numpy as np, rasterio
from rasterio.transform import from_bounds

REPO = str(pathlib.Path(__file__).resolve().parents[2])
sys.path.insert(0, os.path.join(REPO, "backend"))
import suitability as S

BBOX = [-97.05, 37.70, -96.70, 37.95]
W, H = 300, 250

def fake_fetch_dem(bbox, work_dir):
    w,s,e,n = bbox
    path = os.path.join(work_dir, "d.tif")
    with rasterio.open(path,"w",driver="GTiff",height=H,width=W,count=1,dtype="int16",
                       crs="EPSG:4326",transform=from_bounds(w,s,e,n,W,H)) as dst:
        dst.write(np.full((H,W),400,dtype="int16"),1)
    return path

def fake_lc(t,c,shape,bbox):
    return np.full(shape,90,dtype=np.float32), np.full(shape,30,dtype=np.float32)

def fake_arcgis(url, bbox):
    if "Transmission" in url:
        return {"type":"FeatureCollection","features":[{"type":"Feature","properties":{"VOLTAGE":138},
            "geometry":{"type":"LineString","coordinates":[[-97.05,37.90],[-96.70,37.90]]}}]}
    return {"type":"FeatureCollection","features":[{"type":"Feature","properties":{"Mang_Name":"R"},
        "geometry":{"type":"Polygon","coordinates":[[[-97.0,37.74],[-96.9,37.74],[-96.9,37.80],[-97.0,37.80],[-97.0,37.74]]]}}]}

S._fetch_dem = fake_fetch_dem
S._get_landcover_score_aligned = fake_lc
S._query_arcgis = fake_arcgis

sys.path.insert(0, os.path.join(REPO, "pipeline"))
import regenerate_baked_layers as R
# Same stubs must be visible through the names the script imported.
R._query_arcgis = fake_arcgis
R.run_analysis = S.run_analysis
R.GRID_COLS, R.GRID_ROWS = 144, 120
out = tempfile.mkdtemp()
R.OUT_DIR = out

fails = []
def check(n, ok, d=""):
    print(f"{'PASS' if ok else 'FAIL'}  {n}{f' — {d}' if d else ''}")
    if not ok: fails.append(n)

R.main()

expected = ["suitability_score.geojson","slope_score.geojson","landcover_score.geojson",
            "transmission_score.geojson","transmission_lines.geojson","protected_areas.geojson"]
for f in expected:
    check(f"writes {f}", os.path.exists(os.path.join(out,f)))

comb = json.load(open(os.path.join(out,"suitability_score.geojson")))
props = comb["features"][0]["properties"]
check("combined layer carries transmission_km", "transmission_km" in props, str(sorted(props)))
check("combined layer carries transmission_score", "transmission_score" in props)
check("combined layer carries the exclusion flag", "excluded" in props)
check("combined layer has a metadata block", "metadata" in comb)
check("metadata reports lines found", comb["metadata"]["transmission_lines_found"] == 1,
      str(comb["metadata"].get("transmission_lines_found")))
check("metadata reports excluded cells", comb["metadata"]["excluded_cells"] > 0,
      str(comb["metadata"].get("excluded_cells")))

tx = json.load(open(os.path.join(out,"transmission_score.geojson")))
tp = tx["features"][0]["properties"]
check("transmission layer promotes its sub-score to `score`", "score" in tp, str(sorted(tp)))
check("transmission layer keeps the distance", "transmission_km" in tp)
scores = [f["properties"]["score"] for f in tx["features"]]
check("transmission scores span 0..100", min(scores) == 0 and max(scores) > 90,
      f"min {min(scores)} max {max(scores)}")

sl = json.load(open(os.path.join(out,"slope_score.geojson")))
check("slope layer's score is the slope sub-score, not the combined one",
      sl["features"][0]["properties"]["score"] == 100.0,
      str(sl["features"][0]["properties"]["score"]))
check("all score layers share one grid",
      len({len(json.load(open(os.path.join(out,f)))["features"])
           for f in expected[:4]}) == 1)
for f in expected[:4]:
    json.dumps(json.load(open(os.path.join(out,f))), allow_nan=False)
check("every output is strict JSON (no NaN)", True)

print(f"\n{'ALL PASSED' if not fails else str(len(fails))+' FAILED'}")
sys.exit(1 if fails else 0)
