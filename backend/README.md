# Suitability API

FastAPI service exposing the project's scoring pipeline on demand for any
bounding box and weight set. `suitability.py` is the **single source of truth**
for how a suitability score is computed anywhere in this project —
`pipeline/regenerate_baked_layers.py` imports `run_analysis()` from it rather
than reimplementing it, so the pre-baked layers and a live run can't drift
apart.

See the root README for the criteria, scoring curves, and request/response
shape. This file is about running and checking the service.

## Run it

A separate venv from `pipeline/`'s is fine — same core geoprocessing
dependencies, plus FastAPI/uvicorn:

```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Or just `docker compose up` from the repo root, which runs this alongside the
frontend with the DEM cache on a named volume.

## Sanity-check it

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

Then run it against the pilot AOI. The first call fetches real SRTM tiles and
queries Planetary Computer, so expect roughly 10–30 seconds depending on your
connection; **subsequent calls over the same area are much faster** because the
SRTM tiles are cached on disk (see below).

```bash
curl -s -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"bbox": [-97.05, 37.70, -96.70, 37.95],
       "slope_weight": 45, "landcover_weight": 30, "transmission_weight": 25}' \
  | jq '.metadata'
```

`metadata` is the quickest way to confirm everything worked — it reports the
normalized weights actually applied, how many transmission segments and
protected areas were found, how many cells were excluded, the cell count and
the mean score:

```jsonc
{
  "bbox": [-97.05, 37.7, -96.7, 37.95],
  "weights": { "slope": 0.45, "landcover": 0.3, "transmission": 0.25 },
  "transmission_lines_found": 12,
  "protected_areas_found": 3,
  "excluded_cells": 214,
  "cell_count": 17280,
  "mean_score": 71.8
}
```

**What to check:**

- Around 17,000–17,300 features at the default 144×120 grid (a few short of
  17,280 is normal — cells at the AOI edge can clip out).
- Every `properties.score` is 0–100.
- `transmission_lines_found` is non-zero for this AOI. A zero here isn't
  necessarily a bug — it means no line within the cutoff, and the transmission
  criterion correctly scores 0 everywhere — but for Butler County it would be
  suspicious.
- **Historical reference point:** before transmission was a scored criterion,
  the slope + land-cover score for this AOI consistently averaged **79–80**
  pre-exclusion. You can still reproduce that number exactly, which is a useful
  regression check:

```bash
curl -s -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"bbox": [-97.05, 37.70, -96.70, 37.95],
       "slope_weight": 0.6, "landcover_weight": 0.4,
       "transmission_weight": 0, "apply_exclusions": false}' \
  | jq '.metadata.mean_score'
# ~79.4
```

## The DEM cache

SRTM tiles are cached on disk between requests rather than re-downloaded into a
per-request temp directory. SRTM is an immutable product, so there's nothing to
invalidate — fetched once, good forever.

- Location: `$SSE_CACHE_DIR`, defaulting to `<tempdir>/sse-dem-cache`. Docker
  Compose sets it to `/cache/dem` on a named volume so it survives rebuilds.
- Downloads write to a `.part` file and are atomically renamed, so a request
  that dies mid-download can't leave a truncated tile for the next one to read
  as valid.
- To clear it, delete the directory (or `docker volume rm
  solar-siting-explorer_dem-cache`).

## Guards

- `MAX_AOI_DEG2 = 1.0` — one request can't ask for a whole state. The frontend
  checks the same number client-side so an over-cap AOI is rejected before the
  request is made.
- Degenerate bboxes (`east <= west`, `north <= south`) and all-zero weights are
  rejected with `400`.
- Upstream failures (SRTM tile fetch, Planetary Computer, ArcGIS) return `502`
  with a message written to be shown to a user as-is — e.g. *"Couldn't fetch
  SRTM tile N37W097 — is this AOI over land?"*

## Deploying

See [`DEPLOY.md`](../DEPLOY.md) in the repo root.
