import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "backend"))
import suitability as S

calls = []
def fake(url, bbox):
    calls.append((("transmission" if "Transmission" in url else "protected"), tuple(round(v,4) for v in bbox)))
    if "Transmission" in url:
        return {"type":"FeatureCollection","exceededTransferLimit":False,"features":[
            {"type":"Feature","properties":{"VOLTAGE":138},"geometry":{"type":"LineString","coordinates":[[-97,37.9],[-96.7,37.9]]}}]}
    return {"type":"FeatureCollection","features":[
        {"type":"Feature","properties":{"Mang_Name":"R"},"geometry":{"type":"Polygon","coordinates":[[[-97,37.8],[-96.9,37.8],[-96.9,37.9],[-97,37.9],[-97,37.8]]]}},
        {"type":"Feature","properties":{"Mang_Name":"R2"},"geometry":{"type":"Polygon","coordinates":[[[-96.8,37.7],[-96.75,37.7],[-96.75,37.75],[-96.8,37.75],[-96.8,37.7]]]}}]}
S._query_arcgis = fake

fails=[]
def check(n, ok, d=""):
    print(f"{'PASS' if ok else 'FAIL'}  {n}{f' — {d}' if d else ''}")
    if not ok: fails.append(n)

BBOX=[-97.05,37.70,-96.70,37.95]
r = S.get_context_layers(BBOX)
check("returns both layers", set(r) >= {"transmission","protected","metadata"}, str(sorted(r)))
check("counts are reported", r["metadata"]["transmission_count"]==1 and r["metadata"]["protected_count"]==2,
      json.dumps(r["metadata"]))
check("not flagged as truncated", r["metadata"]["truncated"] is False)

tx = [c for c in calls if c[0]=="transmission"][0][1]
pr = [c for c in calls if c[0]=="protected"][0][1]
check("transmission query uses a padded bbox (a line just outside still shows)",
      tx[0] < BBOX[0] and tx[1] < BBOX[1] and tx[2] > BBOX[2] and tx[3] > BBOX[3], str(tx))
check("protected query uses the exact window", list(pr)==[round(v,4) for v in BBOX], str(pr))
pad_deg = BBOX[1]-tx[1]
check("padding is ~10km (the transmission cutoff)", 0.08 < pad_deg < 0.10, f"{pad_deg:.4f} deg")

# Truncation passthrough
S._query_arcgis = lambda u,b: {"type":"FeatureCollection","exceededTransferLimit":True,"features":[]}
check("ArcGIS transfer-limit flag is surfaced", S.get_context_layers(BBOX)["metadata"]["truncated"] is True)
S._query_arcgis = fake

for bad, label in [([-96.7,37.7,-97.05,37.95],"east<=west"), ([-97.05,37.95,-96.7,37.7],"north<=south")]:
    try:
        S.get_context_layers(bad); check(f"rejects degenerate bbox ({label})", False, "no error")
    except ValueError: check(f"rejects degenerate bbox ({label})", True)

try:
    S.get_context_layers([-100,35,-96,38])   # 12 sq deg
    check("rejects an over-cap window", False, "no error")
except S.AOITooLargeError as e:
    check("rejects an over-cap window", True, str(e)[:60])

check("context cap is looser than the analysis cap", S.MAX_CONTEXT_DEG2 > S.MAX_AOI_DEG2,
      f"{S.MAX_CONTEXT_DEG2} vs {S.MAX_AOI_DEG2}")
print(f"\n{'ALL PASSED' if not fails else str(len(fails))+' FAILED'}")
sys.exit(1 if fails else 0)
