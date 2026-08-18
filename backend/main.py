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

import os

from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from suitability import (
    run_analysis,
    get_context_layers,
    AOITooLargeError,
    DEFAULT_TRANSMISSION_MAX_KM,
)

app = FastAPI(title="Solar Siting Explorer — Suitability API")

# Routes are registered twice: bare, and again under /api.
#
# Whether the browser's `/api` prefix survives the trip depends entirely on
# what sits in front. nginx (docker-compose) and Vite's dev proxy both strip
# it, so this service sees /analyze. Vercel's multi-service rewrites route
# /api/* to this service without stripping, so it sees /api/analyze. Serving
# both is a couple of lines and removes an entire class of "works locally,
# 404s in production" — which is otherwise a genuinely annoying thing to
# diagnose, because every other part of the deploy looks correct.
router = APIRouter()

# In dev and in Docker the browser never makes a cross-origin request at all
# — it calls the same-origin path /api, which Vite's proxy or nginx forwards
# here (see src/lib/api.js). CORS only comes into play for a split deploy
# where the frontend is on a static host and the API is on its own domain, so
# the allowed origins are configurable rather than hardcoded.
#
#     SSE_ALLOWED_ORIGINS="https://your-app.vercel.app,https://yourdomain.com"
#
# Defaults to the Vite dev server so a bare `uvicorn main:app` still works if
# someone points a browser straight at it. See DEPLOY.md.
DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
allowed_origins = [
    origin.strip()
    for origin in os.environ.get("SSE_ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
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


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/context")
def context(
    bbox: str = Query(..., description="west,south,east,north in decimal degrees"),
):
    """Vector features for the current map view, so the infrastructure the
    scoring measures against is actually visible when you pan away from the
    pre-baked pilot area. GET (not POST) because it's a pure read keyed on a
    bbox — cacheable, and easy to poke at in a browser."""
    try:
        parts = [float(v) for v in bbox.split(",")]
    except ValueError:
        raise HTTPException(status_code=400, detail="bbox must be four comma-separated numbers")
    if len(parts) != 4:
        raise HTTPException(status_code=400, detail="bbox must be four comma-separated numbers")

    try:
        return get_context_layers(parts)
    except AOITooLargeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/analyze")
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


app.include_router(router)
# The duplicate is kept out of the OpenAPI schema so /docs lists each endpoint
# once rather than twice.
app.include_router(router, prefix="/api", include_in_schema=False)
