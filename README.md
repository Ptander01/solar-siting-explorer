# Solar Siting Explorer

Interactive multi-criteria solar-siting suitability map. Built to close a specific
skill gap: modern open-source web mapping (MapLibre GL JS + deck.gl), on top of an
existing Python geospatial background (GeoPandas / Rasterio / GDAL).

## What it does

Renders a suitability score (0–100) for utility-scale solar siting across a small
pilot AOI (one county or similar), built from open criteria layers:

- **Slope** — derived from a USGS 3DEP DEM clip (Rasterio)
- **Land cover** — NLCD, reclassified into suitable/unsuitable
- **Transmission proximity** — distance to lines from HIFLD
- **Exclusions** — protected land from PAD-US

Criteria are weighted and combined in a Python pipeline, exported as vector tiles,
and rendered in a MapLibre map with deck.gl layers for the score surface and
interactive weight sliders.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Basemap / vector tiles | **MapLibre GL JS** | Open-source, no API key, industry-standard vector tile renderer — this is the actual skill gap to close |
| Data overlays (suitability surface, hover interactions) | **deck.gl** | WebGL layers (GridLayer/HeatmapLayer) composed on top of MapLibre for the scored surface; complementary skill, not a replacement |
| Frontend | React + Vite | Matches existing portfolio stack |
| Charts | Recharts | Score distribution / site stats panel, matches portfolio |
| Motion | Framer Motion | Panel transitions, matches portfolio |
| Geoprocessing | Python — GeoPandas, Rasterio, GDAL | Existing strength; this is where the "real analysis" lives, JS just renders it |
| Tiles | tippecanoe → PMTiles (served statically, no tile server needed) | Keeps the deploy simple — no backend required |
| Containerization | Docker (multi-stage: Python pipeline stage → static build → nginx) | Clean, reproducible, one `docker compose up` |

Note: there isn't a mature, widely-adopted library called "GeoLibre" as of this
writing — MapLibre GL JS is the real open-source-first choice (it's the
community-maintained fork of Mapbox GL JS after Mapbox's license change).
deck.gl is the right complement for the data-viz layers, not a competitor to
MapLibre — they're typically used together, which is what this project does.

## Milestones (small, single-sitting sized — check off as you go)

- [ ] **M0 — It runs.** Vite + React blank page. `docker build` + `docker run` serves it on localhost. No map yet — just confirm the container pipeline works.
- [ ] **M1 — Basemap.** MapLibre fills the viewport, dark-themed to match portfolio, pan/zoom works. No data yet.
- [ ] **M2 — One real layer.** Load a single static GeoJSON (e.g. transmission lines for one state) as a MapLibre layer. Click a feature → popup with attributes.
- [ ] **M3 — First suitability pass.** Python script computes slope suitability from a small DEM clip for ONE small AOI (one county), exports GeoJSON. No web changes yet — just confirm the analysis runs and looks right in QGIS.
- [ ] **M4 — Suitability on the map.** Bring the M3 output in as a deck.gl layer, color-graded by score. Toggle on/off.
- [ ] **M5 — Multi-criteria + interactivity.** Add remaining criteria layers, weight sliders (Framer Motion panel), Recharts panel showing score distribution for the current view.
- [ ] **M6 — Polish + ship.** Responsive layout, README write-up of methodology/limitations, deploy (Vercel for frontend, Docker Compose documented for full reproducibility), link from main portfolio.

Each milestone should end with something visibly different on screen — that's
the point, not a coincidence.

## Repo layout

```
solar-siting-explorer/
  src/            React app (MapLibre + deck.gl)
    components/   Map, layer panel, sliders, stats panel
    lib/          data loading, layer config
  pipeline/       Python geoprocessing (GeoPandas/Rasterio) — produces tiles/GeoJSON consumed by src/
  public/         static assets, PMTiles output lands here for the frontend build
  Dockerfile
  docker-compose.yml
```
