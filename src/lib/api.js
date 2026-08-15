// B3 — client for the FastAPI suitability service built in B1.
//
// Defaults to the same-origin path `/api` rather than http://localhost:8000
// so there's exactly one URL that works in all three environments:
//   - `npm run dev`  -> Vite proxies /api to localhost:8000 (vite.config.js)
//   - docker compose -> nginx proxies /api to the `api` service (nginx.conf)
//   - deployed       -> whatever reverse proxy sits in front does the same
// Same-origin also means the browser never sends a cross-origin request, so
// CORS isn't in the picture at all. (backend/main.py keeps its CORS
// middleware anyway, for anyone pointing a different origin at the API
// directly.) Override with VITE_API_BASE if the API lives somewhere else.
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

async function errorDetail(res) {
  // FastAPI reports HTTPException as {"detail": "..."} — surface that
  // verbatim, since suitability.py's messages are already user-facing
  // ("AOI is 1.4 sq degrees — max allowed for now is 1.0", "Couldn't fetch
  // SRTM tile ... — is this AOI over land?").
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') return body.detail
    if (Array.isArray(body?.detail)) return body.detail.map((d) => d.msg).join('; ')
  } catch {
    /* non-JSON error body — fall through to the status line */
  }
  return `Request failed (HTTP ${res.status})`
}

/** True if the API is reachable. Used to warn up front that the backend
 *  isn't running, rather than only finding out after a click. */
export async function checkHealth(signal) {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal })
    return res.ok
  } catch {
    return false
  }
}

/**
 * POST /analyze — runs the real slope + land-cover pipeline server-side for
 * an arbitrary bbox. Resolves to a GeoJSON FeatureCollection with the same
 * shape as the pre-baked public/data/*.geojson files, so the existing
 * deck.gl layer, histogram, and tooltip all render it unchanged.
 */
export async function analyze(
  {
    bbox,
    slopeMaxDeg,
    weights,
    transmissionMaxKm,
    applyExclusions,
    gridCols,
    gridRows,
  },
  signal
) {
  const res = await fetch(`${API_BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bbox,
      slope_max_deg: slopeMaxDeg,
      // Weights go over the wire raw. run_analysis() normalizes them to sum
      // to 1 and echoes the normalized values back in metadata.weights, so
      // the UI can present three independent 0-100 sliders (which is how
      // people actually think about relative priorities) without either side
      // having to agree on a convention first.
      slope_weight: weights.slope,
      landcover_weight: weights.landcover,
      transmission_weight: weights.transmission,
      transmission_max_km: transmissionMaxKm,
      apply_exclusions: applyExclusions,
      grid_cols: gridCols,
      grid_rows: gridRows,
    }),
    signal,
  })

  if (!res.ok) throw new Error(await errorDetail(res))
  return res.json()
}

/**
 * GET /context — transmission lines and protected areas for a map window.
 *
 * Display only: no scoring, no rasters, so it returns in about a second and
 * can follow the viewport as you pan. Exists because the pre-baked
 * public/data files are clipped to the pilot AOI, which meant drawing a study
 * area anywhere else produced a score measured against infrastructure the map
 * couldn't show you.
 */
export async function fetchContext(bbox, signal) {
  const query = bbox.map((v) => v.toFixed(4)).join(',')
  const res = await fetch(`${API_BASE}/context?bbox=${encodeURIComponent(query)}`, { signal })
  if (!res.ok) throw new Error(await errorDetail(res))
  return res.json()
}
