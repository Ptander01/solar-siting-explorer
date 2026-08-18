# Tests

Two independent suites, no test framework in either — they're plain scripts
that exit non-zero on failure, which keeps the dependency surface at
`playwright` + `pngjs` and makes each file readable start to finish.

Both are built so that **nothing reaches the network**. Every external host
this project touches — the SRTM bucket, Planetary Computer, the two ArcGIS
services, Carto's basemaps — is stubbed. The suites are therefore deterministic
and runnable offline, which matters because most of those sources are the parts
most likely to be slow, rate-limited, or briefly down.

## Backend — `tests/backend/`

Scoring maths, with the three network-touching functions replaced by synthetic
data whose correct answer can be worked out by hand: a perfectly flat DEM so
slope is exactly 0, uniform grassland, one transmission line on a known
meridian, one protected polygon covering a known tenth of the AOI. That makes
the assertions exact rather than approximate — the falloff really is linear to
within 0.15 of a point across every cell inside the cutoff, excluded cells keep
exactly 5%, and the combined score really is the weighted sum of its parts.

```bash
npm run test:api          # or: backend/venv/bin/python tests/backend/test_scoring.py
```

| File | Covers |
|---|---|
| `test_scoring.py` | weighting and normalization, the transmission falloff, UTM distance, the protected-land exclusion, output shape, guard rails |
| `test_context.py` | `/context` — bbox padding, caps, ArcGIS truncation passthrough |
| `test_regenerate.py` | `regenerate_baked_layers.py` end to end, including which properties each output carries |

## Browser — `tests/e2e/`

Real MapLibre and deck.gl in headless Chromium against a running dev server.

```bash
npm run dev               # terminal 1
npm run test:e2e          # terminal 2

npm run build && npm run preview   # terminal 1
npm run test:payload               # terminal 2 — needs a production build
```

`test:payload` deliberately runs against `preview` rather than `dev`: React
StrictMode double-invokes effects in development, which would double the fetch
count that suite exists to assert on.

| File | Covers |
|---|---|
| `analysis.spec.mjs` | AOI drawing, the `/analyze` round trip, permalinks |
| `render.spec.mjs` | **pixel-level** — that layers are actually painted |
| `tooltip.spec.mjs` | criteria surfaced across three data vintages |
| `panels.spec.mjs` | collapse, persistence, keyboard, live-run badge |
| `a11y.spec.mjs` | radiogroup semantics, roving tabindex, focus, symbology washes |
| `context.spec.mjs` | viewport fetching, debounce, zoom floor |
| `payload.spec.mjs` | one fetch on first paint, not five |
| `offline.spec.mjs` | the public demo's no-API state — see below |

### Why `offline.spec.mjs` exists

The deployed demo has no backend, so what a visitor sees when the API is
absent *is* the product for most people who follow the link. This suite
asserts that state is deliberate: the notice explains rather than errors, it
isn't styled as a failure, no doomed requests are made (a frontend-only host
answers `/api/*` with `index.html` and a 200, so the health check has to
inspect the body, not the status), and the client-side half — drawing,
weights, symbology, filtering — still works.

### Why `render.spec.mjs` counts pixels

It exists because of a bug where the transmission and protected-area layers
were present in the style, marked visible, correctly sourced — and invisible,
because the score raster was painting over them. Every structural assertion
passed. The only check that could have caught it is one that asks how many
transmission-amber pixels the map actually drew, so that's what it asks.

Screenshots are written to `tests/artifacts/` (gitignored) as debugging aids.
No assertion compares against a stored image.
