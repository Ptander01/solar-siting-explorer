"""
B1: FastAPI wrapper around the suitability pipeline — same slope + land
cover scoring as pipeline/m5_suitability_score.py, callable for an
arbitrary bbox and weights instead of only the hardcoded pilot AOI. This
is step 1 toward letting a user draw their own study area and adjust
parameters live: B2 adds the draw tool to the map, B3 wires the layers
panel's sliders to call this endpoint. Not yet connected to the frontend.

Run (separate venv from pipeline/'s is fine — same dependencies plus
FastAPI/uvicorn):
    cd backend
    python3 -m venv venv && source venv/bin/activate
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

Then, with the server running, sanity-check it against the pilot AOI's
already-known result (see README.md for what to expect):
    curl -X POST http://localhost:8000/analyze \
      -H "Content-Type: application/json" \
      -d '{"bbox": [-97.05, 37.70, -96.70, 37.95]}'
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from suitability import (
    run_analysis,
    AOITooLargeError,
    DEFAULT_TRANSMISSION_MAX_KM,
)

app = FastAPI(title="Solar Siting Explorer — Suitability API")

# The Vite dev server runs on localhost:5173 by default — allow it (and
# the 127.0.0.1 form) to call this API directly from the browser once B3
# wires the frontend up to it.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    bbox: list[float] = Field(
        ...,
        min_length=4,
        max_length=4,
        description="[west, south, east, north] in decimal degrees",
    )
    slope_max_deg: float = 10.0
    slope_weight: float = 0.6
    landcover_weight: float = 0.4
    # Weights are relative and get normalized to sum to 1 in run_analysis, so
    # these are priorities rather than fractions. transmission_weight
    # defaults to 0 so an older client that doesn't know about the criterion
    # gets exactly the previous two-criterion behaviour, and the extra
    # ArcGIS round trip is skipped rather than fetched and multiplied by zero.
    transmission_weight: float = 0.0
    transmission_max_km: float = DEFAULT_TRANSMISSION_MAX_KM
    apply_exclusions: bool = True
    grid_cols: int = 144
    grid_rows: int = 120


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    try:
        return run_analysis(
            bbox=req.bbox,
            slope_max_deg=req.slope_max_deg,
            slope_weight=req.slope_weight,
            landcover_weight=req.landcover_weight,
            transmission_weight=req.transmission_weight,
            transmission_max_km=req.transmission_max_km,
            apply_exclusions=req.apply_exclusions,
            grid_cols=req.grid_cols,
            grid_rows=req.grid_rows,
        )
    except AOITooLargeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        # Upstream data source (SRTM tile fetch, Planetary Computer search)
        # failed — a 502 (bad gateway) fits better than a generic 500.
        raise HTTPException(status_code=502, detail=str(e))
