// B2 — drag-a-rectangle AOI drawing on the MapLibre canvas.
//
// Why this is hand-rolled rather than a drawing library: the roadmap listed
// mapbox-gl-draw or deck.gl's EditableGeoJsonLayer as the candidates, and
// both are the wrong size for what's actually needed here. The /analyze
// endpoint takes a **bbox** — [west, south, east, north] — not an arbitrary
// polygon, so all the vertex-editing machinery those libraries exist to
// provide would be dead weight wrapped in a converter that throws most of
// it away. mapbox-gl-draw also carries real MapLibre-v4 compat friction
// (it reaches for `mapboxgl`-prefixed CSS classes and constants), and
// @deck.gl-community/editable-layers pins its own deck.gl version range.
// A rectangle drag is ~100 lines against MapLibre's own event API, adds no
// dependency, and matches the backend's contract exactly. If a future
// milestone ever needs a true freehand polygon AOI, that's the point to
// take on one of those dependencies — not before.

// The original hardcoded pilot AOI (Butler County, KS) — still the default
// so the app opens on the same view it always has, and so there's something
// to reset back to after drawing.
export const PILOT_AOI = [-97.05, 37.7, -96.7, 37.95]

// Mirrors MAX_AOI_DEG2 in backend/suitability.py. Checked client-side too so
// the user gets told *before* waiting on a request the server will reject —
// backend/suitability.py's own comment asks for exactly this.
export const MAX_AOI_DEG2 = 1.0

// A drag under this many pixels in either direction is treated as a stray
// click rather than an AOI, so a mis-click doesn't blow away the current one.
const MIN_DRAG_PX = 8

export function normalizeBbox(a, b) {
  return [
    Math.min(a.lng, b.lng),
    Math.min(a.lat, b.lat),
    Math.max(a.lng, b.lng),
    Math.max(a.lat, b.lat),
  ]
}

export function bboxAreaDeg2(bbox) {
  const [west, south, east, north] = bbox
  return (east - west) * (north - south)
}

// deck.gl PolygonLayer wants a ring of [lng, lat] pairs, closed.
export function bboxToRing(bbox) {
  const [west, south, east, north] = bbox
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ]
}

// MapLibre's fitBounds wants [[w, s], [e, n]].
export function bboxToLngLatBounds(bbox) {
  const [west, south, east, north] = bbox
  return [
    [west, south],
    [east, north],
  ]
}

export function formatBbox(bbox) {
  return bbox.map((v) => v.toFixed(3)).join(', ')
}

/**
 * Binds drag-rectangle handlers to a live MapLibre map.
 *
 * Returns an unbind function. Only called while draw mode is armed (see the
 * effect in MapView), so the map behaves completely normally the rest of the
 * time — no permanently-attached handlers competing with pan/zoom.
 *
 * onDraft fires continuously during the drag (for the live preview
 * rectangle); onCommit fires once on release with the final bbox; onCancel
 * fires on Escape.
 */
export function bindBboxDraw(map, { onDraft, onCommit, onCancel }) {
  const canvas = map.getCanvas()
  const previousCursor = canvas.style.cursor
  canvas.style.cursor = 'crosshair'

  // Without this, the drag pans the map instead of drawing. doubleClickZoom
  // is disabled too so a fast double-click while armed doesn't zoom.
  map.dragPan.disable()
  map.doubleClickZoom.disable()

  // Suppressing text selection is a direct consequence of disabling dragPan:
  // MapLibre's own drag handler is what normally swallows the gesture, so
  // with it off, a drag that strays over the layers or analysis panel starts
  // a native text selection and leaves the whole UI highlighted blue.
  const previousUserSelect = document.body.style.userSelect
  document.body.style.userSelect = 'none'

  let anchor = null // { lngLat, point }
  let latest = null // { lngLat, point }

  const onMouseDown = (e) => {
    anchor = { lngLat: e.lngLat, point: e.point }
    latest = anchor
    onDraft(normalizeBbox(anchor.lngLat, anchor.lngLat))
  }

  const onMouseMove = (e) => {
    if (!anchor) return
    latest = { lngLat: e.lngLat, point: e.point }
    onDraft(normalizeBbox(anchor.lngLat, latest.lngLat))
  }

  // Deliberately bound to the window, not the map: releasing the mouse
  // outside the canvas (easy to do when dragging toward a panel or off the
  // edge of the viewport) never fires MapLibre's own 'mouseup', which would
  // otherwise leave the drag stuck armed with a draft rectangle glued to the
  // cursor. The window sees the release wherever it happens, and `latest`
  // holds the last in-canvas position to finalize from.
  const onWindowMouseUp = () => {
    if (!anchor) return
    const start = anchor
    const end = latest
    anchor = null
    latest = null
    onDraft(null)

    const dx = Math.abs(end.point.x - start.point.x)
    const dy = Math.abs(end.point.y - start.point.y)
    if (dx < MIN_DRAG_PX || dy < MIN_DRAG_PX) return // stray click — stay armed

    onCommit(normalizeBbox(start.lngLat, end.lngLat))
  }

  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return
    anchor = null
    latest = null
    onDraft(null)
    onCancel()
  }

  map.on('mousedown', onMouseDown)
  map.on('mousemove', onMouseMove)
  window.addEventListener('mouseup', onWindowMouseUp)
  window.addEventListener('keydown', onKeyDown)

  return () => {
    map.off('mousedown', onMouseDown)
    map.off('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    window.removeEventListener('keydown', onKeyDown)
    canvas.style.cursor = previousCursor
    document.body.style.userSelect = previousUserSelect
    map.dragPan.enable()
    map.doubleClickZoom.enable()
  }
}
