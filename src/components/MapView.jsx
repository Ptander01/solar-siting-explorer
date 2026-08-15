import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { GeoJsonLayer, PolygonLayer } from '@deck.gl/layers'
import 'maplibre-gl/dist/maplibre-gl.css'
import LayersPanel from './LayersPanel.jsx'
import ScoreHistogram from './ScoreHistogram.jsx'
import AnalysisPanel, { RESOLUTIONS } from './AnalysisPanel.jsx'
import { RAMPS, colorForScore, rampCssGradient } from '../lib/colorRamps.js'
import {
  PILOT_AOI,
  bboxToRing,
  bboxToLngLatBounds,
  bindBboxDraw,
} from '../lib/bboxDraw.js'
import { analyze, checkHealth } from '../lib/api.js'
import { readUrlState, writeUrlState } from '../lib/urlState.js'
import { usePanelCollapse } from '../lib/usePanelCollapse.js'

// Basemap styles. "streets" has a dark and a light variant so it tracks
// the UI theme (light UI over the dark vector basemap looked mismatched);
// satellite stays the same regardless of theme.
const BASEMAP_STYLES = {
  streetsDark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  streetsLight: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  satellite: {
    version: 8,
    sources: {
      'esri-satellite': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        attribution: 'Esri, Maxar, Earthstar Geographics',
      },
    },
    layers: [{ id: 'esri-satellite-layer', type: 'raster', source: 'esri-satellite' }],
  },
}

// Real HIFLD transmission-line attributes (confirmed from a live query —
// see pipeline/t_real_transmission_and_exclusions.py's printed field list).
function transmissionPopupHtml(props) {
  const parts = []
  if (props.VOLTAGE) parts.push(`${props.VOLTAGE} kV${props.VOLT_CLASS ? ` (${props.VOLT_CLASS})` : ''}`)
  if (props.OWNER) parts.push(props.OWNER)
  if (props.TYPE) parts.push(props.TYPE)
  if (props.STATUS) parts.push(props.STATUS)
  const body = parts.length ? parts.join('<br/>') : 'Transmission line (no attributes)'
  return `<div class="popup-body">${body}</div>`
}

// Inline style applied to the deck.gl (hover) tooltip — matches the same
// glass-panel look as the layers panel and the MapLibre popups. deck.gl's
// getTooltip only accepts an inline style object (no className hook), and
// it's built once at map-init time, so it needs a dark/light pair picked
// via a ref rather than reading CSS variables.
const DECK_TOOLTIP_BASE = {
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  borderRadius: '8px',
  padding: '6px 10px',
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontSize: '12px',
}
const DECK_TOOLTIP_STYLES = {
  dark: {
    ...DECK_TOOLTIP_BASE,
    background: 'linear-gradient(160deg, rgba(24,29,36,0.9) 0%, rgba(14,17,21,0.9) 100%)',
    border: '1px solid rgba(255,255,255,0.09)',
    color: '#e6e8eb',
    boxShadow: '0 8px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
  },
  light: {
    ...DECK_TOOLTIP_BASE,
    background: 'linear-gradient(160deg, rgba(255,255,255,0.92) 0%, rgba(232,236,240,0.92) 100%)',
    border: '1px solid rgba(20,30,40,0.12)',
    color: '#1f2937',
    boxShadow: '0 8px 24px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.7)',
  },
}

// The score "rasters" — only one renders at a time (see LayersPanel).
// Each gets its own default ramp so they stay visually distinct when you
// flip between them.
//
// `live` (B3) is the odd one out: it has no `path`, because its data comes
// from a POST /analyze response held in React state rather than a pre-baked
// file in public/data. It's kept in this same config map (rather than
// special-cased everywhere) so the tooltip, symbology, histogram, and
// filter machinery all treat it exactly like the baked layers — it's only
// filtered out of the radio list until a run has actually produced one.
const LIVE_LAYER_ID = 'live'
const RASTER_CONFIG = {
  suitability: { label: 'Suitability score (combined)', path: '/data/suitability_score.geojson', tooltipLabel: 'Suitability', defaultRamp: 'redGreen' },
  slope: { label: 'Slope score (input layer)', path: '/data/slope_score.geojson', tooltipLabel: 'Slope score', defaultRamp: 'blues' },
  landcover: { label: 'Land cover score (input layer)', path: '/data/landcover_score.geojson', tooltipLabel: 'Land cover score', defaultRamp: 'viridis' },
  // C2 — transmission proximity became a real scored criterion, so it gets a
  // standalone layer like the other two. The file only exists once
  // pipeline/regenerate_baked_layers.py has been run; until then the fetch
  // fails and the layer is hidden from the list rather than shown empty.
  transmission: { label: 'Transmission score (input layer)', path: '/data/transmission_score.geojson', tooltipLabel: 'Transmission score', defaultRamp: 'blues' },
  [LIVE_LAYER_ID]: { label: 'Live analysis (drawn AOI)', path: null, tooltipLabel: 'Suitability (live)', defaultRamp: 'redGreen' },
}
const RASTER_IDS = Object.keys(RASTER_CONFIG)
const BAKED_RASTER_IDS = RASTER_IDS.filter((id) => RASTER_CONFIG[id].path)

// Intended paint order, bottom to top:
//
//   basemap  <  score raster (deck)  <  protected-area fill  <  outline
//            <  transmission lines  <  AOI rectangle + draft (deck)
//
// Polygons under lines, and the deck raster under both.
//
// This has to be stated explicitly rather than left to insertion order.
// MapboxOverlay in interleaved mode inserts each deck layer into the MapLibre
// style as a custom layer, but a GeoJsonLayer pointed at a URL only creates
// that layer once its fetch resolves — so whether the score raster lands
// above or below the vector layers depends on which network request finishes
// first. Losing that race is what buried the transmission lines and protected
// areas under a 67%-opaque score raster: they were present, visible and
// correctly sourced, just painted over. Every structural assertion passed.
//
// The score layer names DECK_SCORE_BEFORE_ID as its `beforeId`, which pins it
// beneath the vector layers whenever those already exist. When they don't yet,
// deck appends it on top and the style handler adds them above it moments
// later — correct either way. The AOI layers get no beforeId, which puts them
// in deck's "last" layer group, above everything.
//
// DECK_SCORE_BEFORE_ID must name the BOTTOM-most vector layer. Naming any
// other one leaves the raster above everything added before it — which is
// exactly why the first attempt at this fix brought the protected areas back
// but left the transmission lines buried.
const DECK_SCORE_BEFORE_ID = 'protected-areas-fill'

// AOI rectangle colors, per theme. The committed AOI is deliberately
// achromatic (white on dark, near-black on light) so it doesn't read as
// another data layer next to the amber transmission lines and green
// protected areas; the in-progress draft borrows the UI accent instead, and
// only exists for the duration of a drag.
const AOI_COLORS = {
  dark: { line: [255, 255, 255, 230], fill: [255, 255, 255, 12], draft: [245, 158, 11, 235] },
  light: { line: [31, 41, 55, 230], fill: [31, 41, 55, 14], draft: [184, 121, 10, 235] },
}

// Defaults match pipeline/regenerate_baked_layers.py, so a live run over the
// pilot AOI with untouched controls reproduces the pre-baked layer rather
// than quietly differing from it.
const DEFAULT_ANALYSIS = {
  aoi: PILOT_AOI,
  slopeMaxDeg: 10,
  weights: { slope: 45, landcover: 30, transmission: 25 },
  transmissionMaxKm: 10,
  applyExclusions: true,
  resolution: 'standard',
  layer: 'suitability',
  resolutions: Object.keys(RESOLUTIONS),
  layers: RASTER_IDS,
}

function getInitialTheme() {
  if (typeof window === 'undefined') return 'dark'
  return localStorage.getItem('sse-theme') || 'dark'
}

function sameBbox(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function meanScoreOf(features) {
  if (!features.length) return 0
  const total = features.reduce((sum, f) => sum + (f.properties?.score ?? 0), 0)
  return Number((total / features.length).toFixed(2))
}

export default function MapView() {
  // C3 — seed every analysis input from the query string once, at mount, so
  // a shared link opens on the study area and parameters it encodes.
  const initial = useRef(readUrlState(DEFAULT_ANALYSIS)).current

  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const overlayRef = useRef(null)

  // Both floating panels fold away, remembered per-browser. Not in the URL —
  // see usePanelCollapse.js for why.
  const [layersCollapsed, toggleLayersCollapsed] = usePanelCollapse('layers')
  const [analysisCollapsed, toggleAnalysisCollapsed] = usePanelCollapse('analysis')

  // Independently toggleable vector overlays.
  const [layersVisible, setLayersVisible] = useState({ lines: true, protected: true })
  const toggleLayer = (id) => setLayersVisible((prev) => ({ ...prev, [id]: !prev[id] }))
  // Read inside the map's 'style.load' handler, which is bound once at
  // init time — a ref keeps it from closing over the initial value.
  const layersVisibleRef = useRef(layersVisible)
  useEffect(() => {
    layersVisibleRef.current = layersVisible
  }, [layersVisible])

  // Streets vs. satellite imagery. Switching calls map.setStyle(), which
  // wipes any sources/layers we added by hand — the 'style.load' handler
  // below re-adds them every time, guarded so it's safe on the very first
  // load too.
  // True once the MapLibre vector overlays exist in the current style. The
  // score layer's `beforeId` names one of them, and deck logs an error if it
  // names a layer that isn't there yet — so the beforeId is withheld until
  // this flips, and the deck effect re-runs to apply it. Reset on every
  // setStyle, since that wipes them.
  const [overlaysReady, setOverlaysReady] = useState(false)

  const [basemap, setBasemap] = useState('streets')
  const toggleBasemap = () => setBasemap((b) => (b === 'satellite' ? 'streets' : 'satellite'))
  const handlersBoundRef = useRef(false)

  // Light/dark UI theme — same data-theme attribute-swap + localStorage
  // pattern used elsewhere, applied to <html> so every CSS variable in
  // glass.css (and the "streets" basemap variant below) follows it.
  const [theme, setTheme] = useState(getInitialTheme)
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('sse-theme', theme)
  }, [theme])
  // Read inside the map-init effect's tooltip callback (built once, empty
  // deps) so it always reflects the current theme instead of the initial one.
  const themeRef = useRef(theme)
  useEffect(() => {
    themeRef.current = theme
  }, [theme])

  // The "streets" basemap has a dark and light variant; satellite doesn't
  // change with theme. Whenever the resolved style key changes, push it to
  // the map — skipped on mount since the map's already constructed with
  // the matching initial style.
  const activeStyleKeyRef = useRef(getInitialTheme() === 'light' ? 'streetsLight' : 'streetsDark')
  useEffect(() => {
    const key = basemap === 'satellite' ? 'satellite' : theme === 'light' ? 'streetsLight' : 'streetsDark'
    if (key === activeStyleKeyRef.current) return
    activeStyleKeyRef.current = key
    // setStyle wipes every source and layer we added by hand.
    setOverlaysReady(false)
    mapRef.current?.setStyle(BASEMAP_STYLES[key])
  }, [basemap, theme])

  // Which single score layer is currently shown (or null for none).
  const [activeRasterLayer, setActiveRasterLayer] = useState(initial.layer)
  // Kept in a ref too, so the tooltip callback (built once at map-init time)
  // always reads the current value instead of closing over the initial one.
  const activeRasterLayerRef = useRef(activeRasterLayer)
  useEffect(() => {
    activeRasterLayerRef.current = activeRasterLayer
  }, [activeRasterLayer])

  // Per-layer symbology (ramp + opacity) — each score layer remembers its
  // own settings when you switch away and back.
  const [symbologyByLayer, setSymbologyByLayer] = useState({
    suitability: { ramp: 'redGreen', opacity: 170 },
    slope: { ramp: 'blues', opacity: 170 },
    landcover: { ramp: 'viridis', opacity: 170 },
    transmission: { ramp: 'blues', opacity: 170 },
    [LIVE_LAYER_ID]: { ramp: 'redGreen', opacity: 190 },
  })
  const updateSymbology = (id, patch) =>
    setSymbologyByLayer((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  // Per-layer histogram/select-by-score filter range. {min:0,max:100} = no filter.
  const [rangeByLayer, setRangeByLayer] = useState({
    suitability: { min: 0, max: 100 },
    slope: { min: 0, max: 100 },
    landcover: { min: 0, max: 100 },
    transmission: { min: 0, max: 100 },
    [LIVE_LAYER_ID]: { min: 0, max: 100 },
  })
  const updateRange = (id, range) => setRangeByLayer((prev) => ({ ...prev, [id]: range }))

  // Features for the baked layers, fetched upfront so switching the active
  // layer redraws its histogram instantly instead of waiting on a fetch.
  // `live` starts null and is filled in by a /analyze response.
  const [featuresByLayer, setFeaturesByLayer] = useState({
    suitability: null,
    slope: null,
    landcover: null,
    transmission: null,
    [LIVE_LAYER_ID]: null,
  })
  useEffect(() => {
    BAKED_RASTER_IDS.forEach((id) => {
      fetch(RASTER_CONFIG[id].path)
        .then((r) => r.json())
        .then((geojson) => setFeaturesByLayer((prev) => ({ ...prev, [id]: geojson.features })))
        .catch(() => setFeaturesByLayer((prev) => ({ ...prev, [id]: [] })))
    })
  }, [])

  // ── B2: AOI state ──────────────────────────────────────────────────────
  // `aoi` is the committed study area (defaults to the pilot AOI the baked
  // layers were generated for); `draftAoi` is the rectangle following the
  // cursor mid-drag; `drawArmed` is whether the next drag draws instead of
  // panning.
  const [aoi, setAoi] = useState(initial.aoi)
  const [draftAoi, setDraftAoi] = useState(null)
  const [drawArmed, setDrawArmed] = useState(false)
  const isPilotAoi = sameBbox(aoi, PILOT_AOI)

  // Same once-bound-handler problem as theme/activeRasterLayer: the popup
  // and cursor handlers in the map-init effect are registered a single time,
  // so they need a ref to see the current draw-mode state.
  const drawArmedRef = useRef(drawArmed)
  useEffect(() => {
    drawArmedRef.current = drawArmed
  }, [drawArmed])

  const toggleDraw = () => setDrawArmed((armed) => !armed)
  const resetAoi = () => {
    setAoi(PILOT_AOI)
    mapRef.current?.fitBounds(bboxToLngLatBounds(PILOT_AOI), { padding: 60, duration: 700 })
  }

  // Handlers are attached only while draw mode is armed and torn down the
  // moment it disarms, so the map pans/zooms completely normally otherwise.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !drawArmed) return
    return bindBboxDraw(map, {
      onDraft: setDraftAoi,
      onCommit: (bbox) => {
        setAoi(bbox)
        setDrawArmed(false)
      },
      onCancel: () => setDrawArmed(false),
    })
  }, [drawArmed])

  // ── B3: analysis parameters + request state ────────────────────────────
  const [slopeMaxDeg, setSlopeMaxDeg] = useState(initial.slopeMaxDeg)
  const [weights, setWeights] = useState(initial.weights)
  const updateWeight = (key, value) =>
    setWeights((prev) => ({ ...prev, [key]: value }))
  const [transmissionMaxKm, setTransmissionMaxKm] = useState(initial.transmissionMaxKm)
  const [applyExclusions, setApplyExclusions] = useState(initial.applyExclusions)
  const [resolution, setResolution] = useState(initial.resolution)
  const [status, setStatus] = useState({ state: 'idle' })
  const [elapsedSec, setElapsedSec] = useState(0)
  const [apiOnline, setApiOnline] = useState(null) // null = not checked yet
  const abortRef = useRef(null)

  // The GeoJSON object handed straight to deck.gl for the live layer (the
  // baked layers pass a URL string instead and let deck.gl fetch it).
  const [liveGeojson, setLiveGeojson] = useState(null)

  // Signature of the inputs the last successful run used, so the panel can
  // say "parameters changed — re-run" instead of silently showing a live
  // layer that no longer matches the controls above it.
  const paramsSignature = useMemo(
    () =>
      JSON.stringify([
        aoi,
        slopeMaxDeg,
        weights,
        transmissionMaxKm,
        applyExclusions,
        resolution,
      ]),
    [aoi, slopeMaxDeg, weights, transmissionMaxKm, applyExclusions, resolution]
  )
  const [lastRunSignature, setLastRunSignature] = useState(null)
  const paramsDirty = lastRunSignature !== null && lastRunSignature !== paramsSignature

  useEffect(() => {
    const controller = new AbortController()
    checkHealth(controller.signal).then(setApiOnline)
    return () => controller.abort()
  }, [])

  // C3 — keep the query string in step with the controls. Runs on every
  // change (replaceState, so it doesn't flood the back button); the live
  // layer is excluded from the `layer` param since a link naming it would
  // open on an empty layer.
  useEffect(() => {
    writeUrlState({
      aoi,
      slopeMaxDeg,
      weights,
      transmissionMaxKm,
      applyExclusions,
      resolution,
      layer: activeRasterLayer,
    })
  }, [
    aoi,
    slopeMaxDeg,
    weights,
    transmissionMaxKm,
    applyExclusions,
    resolution,
    activeRasterLayer,
  ])

  // Elapsed counter — the whole point of showing it is that a live run is
  // seconds of real network + geoprocessing, unlike every other control in
  // this UI, which is instant.
  useEffect(() => {
    if (status.state !== 'running') return
    setElapsedSec(0)
    const startedAt = performance.now()
    const id = setInterval(() => {
      setElapsedSec(Math.round((performance.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [status.state])

  const runAnalysis = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const signature = paramsSignature
    const { cols, rows } = RESOLUTIONS[resolution]
    setStatus({ state: 'running' })

    try {
      const geojson = await analyze(
        {
          bbox: aoi,
          slopeMaxDeg,
          weights,
          transmissionMaxKm,
          applyExclusions,
          gridCols: cols,
          gridRows: rows,
        },
        controller.signal
      )
      const features = geojson.features ?? []
      if (!features.length) {
        setStatus({ state: 'error', message: 'The API returned no cells for this AOI.' })
        return
      }

      setFeaturesByLayer((prev) => ({ ...prev, [LIVE_LAYER_ID]: features }))
      setLiveGeojson(geojson)
      // A fresh result invalidates any select-by-score filter carried over
      // from the previous run — its score range may not even overlap.
      updateRange(LIVE_LAYER_ID, { min: 0, max: 100 })
      setActiveRasterLayer(LIVE_LAYER_ID)
      setApiOnline(true)
      setLastRunSignature(signature)
      setStatus({
        state: 'done',
        cellCount: geojson.metadata?.cell_count ?? features.length,
        // Prefer the server's own mean — it's computed over the full result
        // before rounding for display, and it's what the pipeline prints.
        meanScore: geojson.metadata?.mean_score ?? meanScoreOf(features),
        metadata: geojson.metadata,
      })
      mapRef.current?.fitBounds(bboxToLngLatBounds(aoi), { padding: 60, duration: 700 })
    } catch (err) {
      if (controller.signal.aborted) {
        setStatus({ state: 'idle' })
        return
      }
      // A network-level failure (as opposed to an HTTP error the API
      // returned) usually means the server isn't running at all — reflect
      // that in the panel's banner rather than only in this one message.
      if (err instanceof TypeError) setApiOnline(false)
      setStatus({ state: 'error', message: err.message })
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [
    aoi,
    slopeMaxDeg,
    weights,
    transmissionMaxKm,
    applyExclusions,
    resolution,
    paramsSignature,
  ])

  const cancelAnalysis = () => abortRef.current?.abort()

  useEffect(() => () => abortRef.current?.abort(), [])

  // Map + native MapLibre layers: real transmission lines (T1) and
  // protected-area exclusions (T2), both simple enough not to need deck.gl.
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLES[activeStyleKeyRef.current],
      center: [-96.875, 37.825],
      zoom: 10,
    })
    mapRef.current = map

    map.addControl(new maplibregl.NavigationControl(), 'top-right')

    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      getTooltip: ({ object }) => {
        if (!object) return null
        const activeId = activeRasterLayerRef.current
        const label = activeId ? RASTER_CONFIG[activeId].tooltipLabel : 'Score'
        const props = object.properties
        // The raw inputs behind the score, not the sub-scores — "2.5°" and
        // "3.2 km from a line" say why a cell scored what it did in a way
        // "slope_score 75" doesn't.
        //
        // Every field is guarded, because the properties available depend on
        // which vintage of data produced the feature: GeoJSON baked before
        // the transmission criterion existed carries only score/slope/land
        // cover, and a live run with the transmission weight at 0 skips the
        // HIFLD query entirely and returns a null distance. Unguarded, those
        // cases render "undefined" and "null km".
        const lines = [`${label}: ${props.score}/100`]
        if (typeof props.slope_deg === 'number') lines.push(`Slope: ${props.slope_deg}°`)
        if (props.landcover_class) lines.push(`Land cover: ${props.landcover_class}`)
        if (typeof props.transmission_km === 'number') {
          lines.push(`Transmission: ${props.transmission_km} km`)
        }
        // A cell cut to 5% of its score looks inexplicably bad otherwise.
        if (props.excluded) lines.push('<em>Protected — score excluded</em>')
        return {
          html: lines.join('<br/>'),
          style: DECK_TOOLTIP_STYLES[themeRef.current],
        }
      },
    })
    overlayRef.current = overlay
    map.addControl(overlay)

    // Sources + layers get wiped by setStyle() (basemap switching), so this
    // has to run again every time a new style finishes loading, guarded
    // against re-adding something that's already there.
    function addOverlaySourcesAndLayers() {
      // Called from several events, some of which fire before the new style
      // is queryable. Everything below is guarded on existence, so the
      // duplicate calls are cheap no-ops.
      if (!map.isStyleLoaded()) return

      // Added bottom-up, and the order matters twice over. Polygons go under
      // lines — standard cartographic practice, and concretely it stops the
      // 25%-alpha protected-area fill from washing over the transmission
      // lines. It also fixes DECK_SCORE_BEFORE_ID's meaning: the score raster
      // is pinned beneath the *first* of these, so that one has to be the
      // bottom-most, or the raster slots in above whatever was added earlier.
      if (!map.getSource('protected-areas')) {
        map.addSource('protected-areas', {
          type: 'geojson',
          data: '/data/protected_areas.geojson',
        })
      }
      if (!map.getLayer('protected-areas-fill')) {
        map.addLayer({
          id: 'protected-areas-fill',
          type: 'fill',
          source: 'protected-areas',
          paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.25 },
          layout: { visibility: layersVisibleRef.current.protected ? 'visible' : 'none' },
        })
      }
      if (!map.getLayer('protected-areas-outline')) {
        map.addLayer({
          id: 'protected-areas-outline',
          type: 'line',
          source: 'protected-areas',
          paint: { 'line-color': '#22c55e', 'line-width': 1 },
          layout: { visibility: layersVisibleRef.current.protected ? 'visible' : 'none' },
        })
      }

      if (!map.getSource('transmission-lines')) {
        map.addSource('transmission-lines', {
          type: 'geojson',
          data: '/data/transmission_lines.geojson',
        })
      }
      if (!map.getLayer('transmission-lines-layer')) {
        map.addLayer({
          id: 'transmission-lines-layer',
          type: 'line',
          source: 'transmission-lines',
          paint: { 'line-color': '#f59e0b', 'line-width': 3 },
          layout: { visibility: layersVisibleRef.current.lines ? 'visible' : 'none' },
        })
      }

      // Lets the deck effect apply its beforeId now that the target exists.
      // A no-op re-render on the repeat calls from 'idle'.
      setOverlaysReady(true)

      // Click/hover handlers are bound to the map instance itself (not the
      // style), so they'd stack up if re-registered on every basemap
      // switch — bind them exactly once.
      if (!handlersBoundRef.current) {
        handlersBoundRef.current = true
        map.on('click', 'transmission-lines-layer', (e) => {
          // While draw mode is armed, a drag that ends over a transmission
          // line still counts as a click — suppress the popup so drawing an
          // AOI doesn't leave stray popups behind it.
          if (drawArmedRef.current) return
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(transmissionPopupHtml(e.features[0].properties))
            .addTo(map)
        })
        map.on('mouseenter', 'transmission-lines-layer', () => {
          if (drawArmedRef.current) return
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', 'transmission-lines-layer', () => {
          if (drawArmedRef.current) return
          map.getCanvas().style.cursor = ''
        })
        map.on('click', 'protected-areas-fill', (e) => {
          if (drawArmedRef.current) return
          const props = e.features[0].properties
          const name = props.Mang_Name || props.MANG_NAME || 'Protected area'
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(`<div class="popup-body">${name}</div>`)
            .addTo(map)
        })
      }
    }

    // MapLibre fires 'style.load' only for the *initial* style. setStyle() —
    // which is what the basemap toggle calls — fires 'styledata' instead,
    // sometimes before the new style is queryable, followed by 'idle'.
    // Listening only for 'style.load' meant every basemap switch permanently
    // dropped the transmission and protected-area layers: the style wipe
    // removed them and nothing ever added them back. They were still checked
    // in the panel, which is what made it read as "the layers stopped
    // rendering" rather than "the basemap button is broken".
    //
    // All three are handled. The function is idempotent and guards on
    // isStyleLoaded(), so whichever fires first in a usable state does the
    // work and the others no-op. 'idle' is the backstop for the satellite
    // style, where every 'styledata' arrives too early.
    map.on('style.load', addOverlaySourcesAndLayers)
    map.on('styledata', addOverlaySourcesAndLayers)
    map.on('idle', addOverlaySourcesAndLayers)

    // C3 — a link carrying an AOI should open looking at it. The map's
    // constructor center/zoom stays pinned to the pilot area (it's the right
    // default for a bare visit), so this only fires when the URL asked for
    // somewhere else. `once` because a basemap switch re-fires style.load and
    // shouldn't yank the user back to the link's viewport.
    if (!sameBbox(initial.aoi, PILOT_AOI)) {
      map.once('load', () => {
        map.fitBounds(bboxToLngLatBounds(initial.aoi), { padding: 60, duration: 0 })
      })
    }

    return () => {
      map.remove()
      // The guard above is keyed to *this* map instance, but the ref
      // outlives it. React 18's StrictMode mounts, unmounts, and remounts
      // effects in development, so without this reset the second map would
      // see handlersBoundRef already true and never bind its click/hover
      // handlers — transmission-line and protected-area popups silently
      // stopped working under `npm run dev` (production, which mounts once,
      // was unaffected).
      handlersBoundRef.current = false
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getLayer('transmission-lines-layer')) return
    map.setLayoutProperty(
      'transmission-lines-layer',
      'visibility',
      layersVisible.lines ? 'visible' : 'none'
    )
  }, [layersVisible.lines])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getLayer('protected-areas-fill')) return
    const visibility = layersVisible.protected ? 'visible' : 'none'
    map.setLayoutProperty('protected-areas-fill', 'visibility', visibility)
    map.setLayoutProperty('protected-areas-outline', 'visibility', visibility)
  }, [layersVisible.protected])

  // deck.gl layers: the single active score layer, plus the AOI rectangle(s)
  // on top. Only one score layer is ever rendered — the three baked ones
  // would occlude each other anyway, and this is what lets each have its own
  // symbology + histogram (L2/L4/T3).
  //
  // MapboxOverlay.setProps({layers}) replaces the whole array, so the AOI
  // outline has to be composed into the same call rather than pushed
  // separately.
  useEffect(() => {
    if (!overlayRef.current) return

    const layers = []

    const config = activeRasterLayer ? RASTER_CONFIG[activeRasterLayer] : null
    const data = config ? (config.path ?? liveGeojson) : null
    if (config && data) {
      const symbology = symbologyByLayer[activeRasterLayer]
      const range = rangeByLayer[activeRasterLayer]
      layers.push(
        new GeoJsonLayer({
          id: `${activeRasterLayer}-score`,
          data,
          // Keeps the score raster beneath the transmission/protected
          // overlays regardless of which loads first — see the comment on
          // DECK_SCORE_BEFORE_ID. Withheld until that layer exists, since
          // deck errors on an unresolvable beforeId.
          beforeId: overlaysReady ? DECK_SCORE_BEFORE_ID : undefined,
          filled: true,
          stroked: false,
          getFillColor: (f) => {
            const score = f.properties.score
            const inRange = score >= range.min && score <= range.max
            const color = colorForScore(score, symbology.ramp, symbology.opacity)
            return inRange ? color : [color[0], color[1], color[2], 12]
          },
          // Hover tooltips would otherwise fire under the crosshair while
          // the user is dragging out a rectangle.
          pickable: !drawArmed,
          updateTriggers: {
            getFillColor: [symbology.ramp, symbology.opacity, range.min, range.max],
          },
        })
      )
    }

    const aoiColors = AOI_COLORS[theme]
    layers.push(
      new PolygonLayer({
        id: 'aoi-rect',
        data: [{ ring: bboxToRing(aoi) }],
        getPolygon: (d) => d.ring,
        filled: true,
        stroked: true,
        getFillColor: aoiColors.fill,
        getLineColor: aoiColors.line,
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        pickable: false,
        updateTriggers: { getFillColor: [theme], getLineColor: [theme] },
      })
    )

    if (draftAoi) {
      layers.push(
        new PolygonLayer({
          id: 'aoi-draft',
          data: [{ ring: bboxToRing(draftAoi) }],
          getPolygon: (d) => d.ring,
          filled: true,
          stroked: true,
          getFillColor: [aoiColors.draft[0], aoiColors.draft[1], aoiColors.draft[2], 30],
          getLineColor: aoiColors.draft,
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
          pickable: false,
          updateTriggers: { getFillColor: [theme], getLineColor: [theme] },
        })
      )
    }

    overlayRef.current.setProps({ layers })
  }, [
    activeRasterLayer,
    symbologyByLayer,
    rangeByLayer,
    liveGeojson,
    aoi,
    draftAoi,
    drawArmed,
    theme,
    overlaysReady,
  ])

  const activeConfig = activeRasterLayer ? RASTER_CONFIG[activeRasterLayer] : null
  const activeSymbology = activeRasterLayer ? symbologyByLayer[activeRasterLayer] : null
  const activeRange = activeRasterLayer ? rangeByLayer[activeRasterLayer] : null
  const activeFeatures = activeRasterLayer ? featuresByLayer[activeRasterLayer] : null

  // The live layer only becomes selectable once a run has produced one.
  const radioLayers = RASTER_IDS.filter((id) => {
    const features = featuresByLayer[id]
    // The live layer only appears once a run has produced one.
    if (id === LIVE_LAYER_ID) return features !== null
    // A baked layer whose file 404s (transmission_score.geojson before
    // regenerate_baked_layers.py has been run) resolves to an empty array —
    // hide it rather than offering a layer that renders nothing. null still
    // means "in flight", so layers stay listed while loading.
    return features === null || features.length > 0
  }).map((id) => ({
    id,
    label: RASTER_CONFIG[id].label,
    // The row's wash reflects the ramp that layer is *currently* using, not a
    // fixed default — change a ramp and the list follows.
    gradient: rampCssGradient(symbologyByLayer[id].ramp),
  }))

  const rasterControls = activeRasterLayer && (
    <div style={{ marginTop: 4 }}>
      <hr className="glass-divider" />
      <div className="glass-section-label">{activeConfig.label}</div>

      <div className="glass-section-label" style={{ marginTop: 8 }}>Color ramp</div>
      <select
        className="glass-select"
        value={activeSymbology.ramp}
        onChange={(e) => updateSymbology(activeRasterLayer, { ramp: e.target.value })}
        style={{ marginBottom: 10 }}
      >
        {Object.entries(RAMPS).map(([key, { label }]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>

      <div className="glass-section-label">
        Opacity ({Math.round((activeSymbology.opacity / 255) * 100)}%)
      </div>
      <input
        type="range"
        className="glass-slider"
        min={20}
        max={255}
        value={activeSymbology.opacity}
        onChange={(e) => updateSymbology(activeRasterLayer, { opacity: Number(e.target.value) })}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
        <span className="glass-section-label" style={{ marginBottom: 0 }}>Low</span>
        <div
          style={{
            width: 100,
            height: 8,
            borderRadius: 4,
            background: rampCssGradient(activeSymbology.ramp),
            boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.4)',
          }}
        />
        <span className="glass-section-label" style={{ marginBottom: 0 }}>High</span>
      </div>

      <div style={{ marginTop: 10 }}>
        {activeFeatures === null ? (
          <div className="glass-section-label" style={{ marginBottom: 0, opacity: 0.5 }}>Loading...</div>
        ) : (
          <ScoreHistogram
            features={activeFeatures}
            ramp={activeSymbology.ramp}
            selectedRange={activeRange}
            onRangeChange={(range) => updateRange(activeRasterLayer, range)}
          />
        )}
      </div>
    </div>
  )

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Both of these are mode toggles rather than radios, so aria-pressed
          is the right state to expose. They were the last two `<div onClick>`
          controls left after the layer-list accessibility pass — an
          automated check caught them, which is exactly the sort of thing
          eyeballing the UI misses. */}
      <div className="glass-panel" style={{ position: 'absolute', top: 108, right: 12, padding: 5 }}>
        <button
          type="button"
          aria-pressed={basemap === 'satellite'}
          aria-label={`Basemap: ${basemap === 'satellite' ? 'satellite imagery' : 'street map'}`}
          className={`glass-pill${basemap === 'satellite' ? ' glass-pill--on' : ''}`}
          onClick={toggleBasemap}
          style={{ marginBottom: 0 }}
        >
          <span className="glass-pill-body">
            <span className="glass-pill-dot" />
            {basemap === 'satellite' ? 'Satellite' : 'Streets'}
          </span>
        </button>
      </div>

      <div className="glass-panel" style={{ position: 'absolute', top: 150, right: 12, padding: 5 }}>
        <button
          type="button"
          aria-pressed={theme === 'light'}
          aria-label={`Theme: ${theme === 'light' ? 'light' : 'dark'}`}
          className={`glass-pill${theme === 'light' ? ' glass-pill--on' : ''}`}
          onClick={toggleTheme}
          style={{ marginBottom: 0 }}
        >
          <span className="glass-pill-body">
            <span className="glass-pill-dot" />
            {theme === 'light' ? 'Light' : 'Dark'}
          </span>
        </button>
      </div>

      <AnalysisPanel
        aoi={aoi}
        draftAoi={draftAoi}
        isPilotAoi={isPilotAoi}
        drawArmed={drawArmed}
        onToggleDraw={toggleDraw}
        onResetAoi={resetAoi}
        slopeMaxDeg={slopeMaxDeg}
        onSlopeMaxDegChange={setSlopeMaxDeg}
        weights={weights}
        onWeightChange={updateWeight}
        transmissionMaxKm={transmissionMaxKm}
        onTransmissionMaxKmChange={setTransmissionMaxKm}
        applyExclusions={applyExclusions}
        onApplyExclusionsChange={setApplyExclusions}
        resolution={resolution}
        onResolutionChange={setResolution}
        onRun={runAnalysis}
        onCancel={cancelAnalysis}
        status={status}
        elapsedSec={elapsedSec}
        apiOnline={apiOnline}
        paramsDirty={paramsDirty}
        collapsed={analysisCollapsed}
        onToggleCollapse={toggleAnalysisCollapsed}
      />

      <LayersPanel
        radioLayers={radioLayers}
        activeRadioId={activeRasterLayer}
        onRadioChange={setActiveRasterLayer}
        checkboxLayers={[
          {
            id: 'lines',
            label: 'Transmission lines (HIFLD)',
            visible: layersVisible.lines,
            // Same colors the MapLibre paint properties use below, so the
            // swatch can't drift from what's actually drawn.
            swatch: { type: 'line', color: '#f59e0b' },
          },
          {
            id: 'protected',
            label: 'Protected areas (PAD-US)',
            visible: layersVisible.protected,
            swatch: { type: 'fill', color: '#22c55e' },
          },
        ]}
        onToggle={toggleLayer}
        extra={rasterControls}
        collapsed={layersCollapsed}
        onToggleCollapse={toggleLayersCollapsed}
      />
    </div>
  )
}
