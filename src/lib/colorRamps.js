// Shared color-ramp utilities for the suitability score (0-100). Used by
// both the deck.gl map layer and the score histogram so they always agree
// on what color a given score renders as.

export const RAMPS = {
  redGreen: { label: 'Red → Green', stops: [[239, 68, 68], [250, 204, 21], [34, 197, 94]] },
  blues: { label: 'Blues (sequential)', stops: [[239, 246, 255], [96, 165, 250], [29, 78, 216]] },
  viridis: {
    label: 'Viridis',
    stops: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  },
}

function interpolateRamp(stops, t) {
  const clamped = Math.max(0, Math.min(1, t))
  const scaled = clamped * (stops.length - 1)
  const i = Math.floor(scaled)
  const frac = scaled - i
  const a = stops[i]
  const b = stops[Math.min(i + 1, stops.length - 1)]
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ]
}

export function colorForScore(score, rampKey, alpha = 255) {
  const t = Math.max(0, Math.min(100, score ?? 0)) / 100
  const [r, g, b] = interpolateRamp(RAMPS[rampKey].stops, t)
  return [r, g, b, alpha]
}

export function colorForScoreCss(score, rampKey) {
  const [r, g, b] = colorForScore(score, rampKey, 255)
  return `rgb(${r}, ${g}, ${b})`
}

export function rampCssGradient(rampKey) {
  const colors = RAMPS[rampKey].stops.map(([r, g, b]) => `rgb(${r},${g},${b})`).join(', ')
  return `linear-gradient(to right, ${colors})`
}
