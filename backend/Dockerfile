# B4 — container for the FastAPI suitability service.
#
# python:3.11-slim rather than a GDAL base image on purpose: rasterio,
# shapely, and pyproj all ship manylinux wheels with their own bundled
# native libraries, so nothing here needs a system GDAL. That's the same
# reasoning that made the DEM fetch pure-Python back in M3 (the `elevation`
# package's dependency on gdalbuildvrt/gdal_translate CLI tools was what
# broke there) — keeping the native surface at zero is what makes this
# image reproducible instead of fiddly.

FROM python:3.11-slim

# curl is only here for the healthcheck below; the app itself needs nothing
# outside pip.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copied and installed before the source so an edit to suitability.py
# doesn't invalidate the (slow) dependency layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
