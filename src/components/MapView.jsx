import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { GeoJsonLayer } from '@deck.gl/layers'
import 'maplibre-gl/dist/maplibre-gl.css'
import LayersPanel from './LayersPanel.jsx'
import ScoreHistogram from './ScoreHistogram.jsx'
import { RAMPS, colorForScore, rampCssGradient } from '../lib/colorRamps.js'

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

// The three score "rasters" — only one renders at a time (see LayersPanel).
// Each gets its own default ramp so they stay visually distinct when you
// flip between them.
const RASTER_CONFIG = {
  suitability: { label: 'Suitability score (combined)', path: '/data/suitability_score.geojson', tooltipLabel: 'Suitability', defaultRamp: 'redGreen' },
  slope: { label: 'Slope score (input layer)', path: '/data/slope_score.geojson', tooltipLabel: 'Slope score', defaultRamp: 'blues' },
  landcover: { label: 'Land cover score (input layer)', path: '/data/landcover_score.geojson', tooltipLabel: 'Land cover score', defaultRamp: 'viridis' },
}
const RASTER_IDS = Object.keys(RASTER_CONFIG)

function getInitialTheme() {
  if (typeof window === 'undefined') return 'dark'
  return localStorage.getItem('sse-theme') || 'dark'
}

export default function MapView() {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const overlayRef = useRef(null)

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
    mapRef.current?.setStyle(BASEMAP_STYLES[key])
  }, [basemap, theme])

  // Which single score layer is currently shown (or null for none).
  const [activeRasterLayer, setActiveRasterLayer] = useState('suitability')
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
  })
  const updateSymbology = (id, patch) =>
    setSymbologyByLayer((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  // Per-layer histogram/select-by-score filter range. {min:0,max:100} = no filter.
  const [rangeByLayer, setRangeByLayer] = useState({
    suitability: { min: 0, max: 100 },
    slope: { min: 0, max: 100 },
    landcover: { min: 0, max: 100 },
  })
  const updateRange = (id, range) => setRangeByLayer((prev) => ({ ...prev, [id]: range }))

  // Features for all three layers, fetched upfront so switching the active
  // layer redraws its histogram instantly instead of waiting on a fetch.
  const [featuresByLayer, setFeaturesByLayer] = useState({
    suitability: null,
    slope: null,
    landcover: null,
  })
  useEffect(() => {
    RASTER_IDS.forEach((id) => {
      fetch(RASTER_CONFIG[id].path)
        .then((r) => r.json())
        .then((geojson) => setFeaturesByLayer((prev) => ({ ...prev, [id]: geojson.features })))
        .catch(() => setFeaturesByLayer((prev) => ({ ...prev, [id]: [] })))
    })
  }, [])

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
      getTooltip: ({ object, layer }) => {
        if (!object) return null
        const activeId = activeRasterLayerRef.current
        const label = activeId ? RASTER_CONFIG[activeId].tooltipLabel : 'Score'
        const props = object.properties
        // slope_deg/landcover_class are the raw inputs behind the score —
        // added by the pipeline alongside the 144x120 grid change. Guarded
        // with typeof/truthy checks so cached GeoJSON from before that
        // change (not yet re-run) doesn't show "undefined".
        const lines = [`${label}: ${props.score}/100`]
        if (typeof props.slope_deg === 'number') lines.push(`Slope: ${props.slope_deg}°`)
        if (props.landcover_class) lines.push(`Land cover: ${props.landcover_class}`)
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

      // Click/hover handlers are bound to the map instance itself (not the
      // style), so they'd stack up if re-registered on every basemap
      // switch — bind them exactly once.
      if (!handlersBoundRef.current) {
        handlersBoundRef.current = true
        map.on('click', 'transmission-lines-layer', (e) => {
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(transmissionPopupHtml(e.features[0].properties))
            .addTo(map)
        })
        map.on('mouseenter', 'transmission-lines-layer', () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', 'transmission-lines-layer', () => {
          map.getCanvas().style.cursor = ''
        })
        map.on('click', 'protected-areas-fill', (e) => {
          const props = e.features[0].properties
          const name = props.Mang_Name || props.MANG_NAME || 'Protected area'
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(`<div class="popup-body">${name}</div>`)
            .addTo(map)
        })
      }
    }

    map.on('style.load', addOverlaySourcesAndLayers)

    return () => map.remove()
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

  // deck.gl layers: only the single active score layer is ever rendered —
  // the three score layers would occlude each other anyway, and this is
  // what lets each one have its own symbology + histogram (L2/L4/T3) below.
  useEffect(() => {
    if (!overlayRef.current) return

    if (!activeRasterLayer) {
      overlayRef.current.setProps({ layers: [] })
      return
    }

    const config = RASTER_CONFIG[activeRasterLayer]
    const symbology = symbologyByLayer[activeRasterLayer]
    const range = rangeByLayer[activeRasterLayer]

    overlayRef.current.setProps({
      layers: [
        new GeoJsonLayer({
          id: `${activeRasterLayer}-score`,
          data: config.path,
          filled: true,
          stroked: false,
          getFillColor: (f) => {
            const score = f.properties.score
            const inRange = score >= range.min && score <= range.max
            const color = colorForScore(score, symbology.ramp, symbology.opacity)
            return inRange ? color : [color[0], color[1], color[2], 12]
          },
          pickable: true,
          updateTriggers: {
            getFillColor: [symbology.ramp, symbology.opacity, range.min, range.max],
          },
        }),
      ],
    })
  }, [activeRasterLayer, symbologyByLayer, rangeByLayer])

  const activeConfig = activeRasterLayer ? RASTER_CONFIG[activeRasterLayer] : null
  const activeSymbology = activeRasterLayer ? symbologyByLayer[activeRasterLayer] : null
  const activeRange = activeRasterLayer ? rangeByLayer[activeRasterLayer] : null
  const activeFeatures = activeRasterLayer ? featuresByLayer[activeRasterLayer] : null

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

      <div className="glass-panel" style={{ position: 'absolute', top: 108, right: 12, padding: 5 }}>
        <div
          className={`glass-pill${basemap === 'satellite' ? ' glass-pill--on' : ''}`}
          onClick={toggleBasemap}
          style={{ marginBottom: 0 }}
        >
          <span className="glass-pill-dot" />
          {basemap === 'satellite' ? 'Satellite' : 'Streets'}
        </div>
      </div>

      <div className="glass-panel" style={{ position: 'absolute', top: 150, right: 12, padding: 5 }}>
        <div
          className={`glass-pill${theme === 'light' ? ' glass-pill--on' : ''}`}
          onClick={toggleTheme}
          style={{ marginBottom: 0 }}
        >
          <span className="glass-pill-dot" />
          {theme === 'light' ? 'Light' : 'Dark'}
        </div>
      </div>

      <LayersPanel
        radioLayers={RASTER_IDS.map((id) => ({ id, label: RASTER_CONFIG[id].label }))}
        activeRadioId={activeRasterLayer}
        onRadioChange={setActiveRasterLayer}
        checkboxLayers={[
          { id: 'lines', label: 'Transmission lines (HIFLD)', visible: layersVisible.lines },
          { id: 'protected', label: 'Protected areas (PAD-US)', visible: layersVisible.protected },
        ]}
        onToggle={toggleLayer}
        extra={rasterControls}
      />
    </div>
  )
}
