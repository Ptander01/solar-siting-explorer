# Suitability API (B1)

A small FastAPI service that wraps the same slope + land-cover suitability
logic as `pipeline/m5_suitability_score.py`, but callable on demand for any
bbox and weight parameters instead of only the hardcoded pilot AOI. This is
the first step toward letting a user draw their own study area on the map —
it doesn't do that yet (that's B2/B3); right now it's just the API,
verified against the known pilot-AOI result.

## What this does — and doesn't — do yet

- **Does:** fetch SRTM elevation + ESA WorldCover land cover for whatever
  bbox you send it, compute the same weighted slope/land-cover score as
  the pipeline script, grid-average it, and return GeoJSON.
- **Doesn't yet:** apply the protected-land exclusion or real transmission
  data from `pipeline/t_real_transmission_and_exclusions.py` — this
  endpoint's output matches `m5_suitability_score.py`'s output *before*
  that script runs. Folding the exclusion in is a reasonable next step,
  just not part of B1.
- **Isn't wired to the frontend yet.** The map still reads the static
  files in `public/data/`. B2 adds an AOI-drawing tool; B3 connects the
  layers panel's sliders to actually call this endpoint.

## Run it

A separate venv from `pipeline/`'s is fine — same core geoprocessing
dependencies, plus FastAPI/uvicorn:

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

You should see something like:

```
INFO:     Uvicorn running on http://127.0.0.1:8000
INFO:     Application startup complete.
```

Leave that running in its own terminal tab.

## Sanity-check it

In a second terminal, first check it's alive:

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

Then run it against the pilot AOI — the same bbox
`m5_suitability_score.py` has always used — so the result is checkable
against a number we already know:

```bash
curl -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"bbox": [-97.05, 37.70, -96.70, 37.95]}'
```

This will take a bit longer than instant — it's fetching real SRTM tiles
and querying Planetary Computer for land cover, not reading a cached
file — expect somewhere in the ballpark of 10-30 seconds depending on your
connection.

**What to check in the response:**

- It's a GeoJSON `FeatureCollection` with a `features` array.
- With the default grid (144×120), there should be around 17,000-17,300
  features (a few less than the full 17,280 is normal — cells right at the
  AOI edge can get clipped out).
- Each feature's `properties.score` should be a number 0-100. The pilot
  AOI's combined slope+land-cover score (before the protected-land
  exclusion this endpoint doesn't apply) has consistently averaged around
  **79-80/100** across every earlier run of the pipeline script — if the
  mean here is wildly different, something's off.

A quick way to check the mean without leaving the terminal (requires
`jq`, `brew install jq` if you don't have it):

```bash
curl -s -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"bbox": [-97.05, 37.70, -96.70, 37.95]}' \
  | jq '[.features[].properties.score] | add / length'
```

## Optional: try a different AOI

Any bbox works, as long as it's over land and no larger than 1 square
degree (a safety cap in `suitability.py`'s `MAX_AOI_DEG2` — a real
AOI-drawing tool would also want a client-side warning before ever
reaching this limit). For example, a small AOI elsewhere in Kansas:

```bash
curl -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"bbox": [-95.70, 39.00, -95.55, 39.10]}'
```

If that returns a sensible-looking score distribution too, B1 is solid and
ready for B2 (AOI drawing) to build on top of.
