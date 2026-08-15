// C3 — the app's analysis state, mirrored into the query string.
//
// The point is linkability: a specific study area with specific weights is
// the actual unit of work in a siting tool, and until now there was no way
// to send one to someone (or to reload the page without losing it). The URL
// is the natural place for that — no storage, no backend, and it survives a
// refresh, a bookmark, and a paste into Slack for free.
//
// Deliberately *not* in the URL: the active color ramp, opacity, and the
// histogram filter range. Those are view preferences rather than analysis
// inputs, and putting them in would make two links to the same analysis look
// different. localStorage already handles theme for the same reason.
//
// Every value is parsed defensively — a hand-edited or truncated URL should
// degrade to defaults rather than render a broken map.

const KEYS = {
  aoi: 'aoi',
  slopeMaxDeg: 'smax',
  weightSlope: 'ws',
  weightLandcover: 'wl',
  weightTransmission: 'wt',
  transmissionMaxKm: 'tmax',
  applyExclusions: 'excl',
  resolution: 'res',
  layer: 'layer',
}

function num(params, key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = params.get(key)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) return fallback
  return value
}

function parseAoi(params, fallback) {
  const raw = params.get(KEYS.aoi)
  if (!raw) return fallback
  const parts = raw.split(',').map(Number)
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return fallback
  const [west, south, east, north] = parts
  // Same validity rule the API enforces — a degenerate or inverted box from
  // a mangled URL should fall back rather than be sent to /analyze.
  if (east <= west || north <= south) return fallback
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return fallback
  if (Math.abs(north) > 90 || Math.abs(south) > 90) return fallback
  return parts
}

/** Read initial state from window.location, falling back to `defaults`. */
export function readUrlState(defaults) {
  if (typeof window === 'undefined') return defaults
  const params = new URLSearchParams(window.location.search)

  const layer = params.get(KEYS.layer)
  return {
    aoi: parseAoi(params, defaults.aoi),
    slopeMaxDeg: num(params, KEYS.slopeMaxDeg, defaults.slopeMaxDeg, { min: 1, max: 60 }),
    weights: {
      slope: num(params, KEYS.weightSlope, defaults.weights.slope, { min: 0, max: 100 }),
      landcover: num(params, KEYS.weightLandcover, defaults.weights.landcover, { min: 0, max: 100 }),
      transmission: num(params, KEYS.weightTransmission, defaults.weights.transmission, { min: 0, max: 100 }),
    },
    transmissionMaxKm: num(params, KEYS.transmissionMaxKm, defaults.transmissionMaxKm, { min: 1, max: 100 }),
    applyExclusions: params.has(KEYS.applyExclusions)
      ? params.get(KEYS.applyExclusions) !== '0'
      : defaults.applyExclusions,
    resolution: defaults.resolutions.includes(params.get(KEYS.resolution))
      ? params.get(KEYS.resolution)
      : defaults.resolution,
    // `live` is a result, not a layer that exists on load — a link that
    // named it would select an empty layer. Fall back and let a run select it.
    layer: layer && layer !== 'live' && defaults.layers.includes(layer) ? layer : defaults.layer,
  }
}

/** Mirror state into the query string without adding a history entry.
 *  replaceState, not pushState: every slider nudge would otherwise become a
 *  back-button step, which makes the back button useless. */
export function writeUrlState(state) {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams()
  params.set(KEYS.aoi, state.aoi.map((v) => v.toFixed(4)).join(','))
  params.set(KEYS.slopeMaxDeg, String(state.slopeMaxDeg))
  params.set(KEYS.weightSlope, String(state.weights.slope))
  params.set(KEYS.weightLandcover, String(state.weights.landcover))
  params.set(KEYS.weightTransmission, String(state.weights.transmission))
  params.set(KEYS.transmissionMaxKm, String(state.transmissionMaxKm))
  params.set(KEYS.applyExclusions, state.applyExclusions ? '1' : '0')
  params.set(KEYS.resolution, state.resolution)
  if (state.layer && state.layer !== 'live') params.set(KEYS.layer, state.layer)

  const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`
  window.history.replaceState(null, '', next)
}

export function currentShareUrl() {
  return typeof window === 'undefined' ? '' : window.location.href
}
