import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { GeoJsonLayer } from '@deck.gl/layers'
import 'maplibre-gl/dist/maplibre-gl.css'
import LayersPanel from './LayersPanel.jsx'
import ScoreHistogram from './ScoreHistogram.jsx'
import { RAMPS, colorForScore, rampCssGradient } from '../lib/colorRamps.js'

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

export default function MapView() {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const overlayRef = useRef(null)

  const [layersVisible, setLayersVisible] = useState({ suitability: true, lines: true })
  const toggleLayer = (id) => setLayersVisible((prev) => ({ ...prev, [id]: !prev[id] }))

  // L2: symbology state for the suitability layer.
  const [symbology, setSymbology] = useState({ ramp: 'redGreen', opacity: 170 })

  // L4: score range selected via the histogram. {min:0, max:100} = no filter.
  const [selectedRange, setSelectedRange] = useState({ min: 0, max: 100 })

  // Raw score data, fetched once, for the histogram — separate from the
  // deck.gl layer's own copy, since deck.gl doesn't expose its loaded
  // features back to React.
  const [suitabilityFeatures, setSuitabilityFeatures] = useState(null)
  useEffect(() => {
    fetch('/data/suitability_score.geojson')
      .then((r) => r.json())
      .then((geojson) => setSuitabilityFeatures(geojson.features))
      .catch(() => setSuitabilityFeatures([]))
  }, [])

  // Map + sample-lines layer setup (M1 + M2, unchanged)
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [-96.875, 37.825],
      zoom: 10,
    })
    mapRef.current = map

    map.addControl(new maplibregl.NavigationControl(), 'top-right')

    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      getTooltip: ({ object }) =>
        object && { text: `Suitability: ${object.properties.score}/100` },
    })
    overlayRef.current = overlay
    map.addControl(overlay)

    map.on('load', () => {
      map.addSource('sample-lines', {
        type: 'geojson',
        data: '/data/sample-lines.geojson',
      })

      map.addLayer({
        id: 'sample-lines-layer',
        type: 'line',
        source: 'sample-lines',
        paint: { 'line-color': '#f59e0b', 'line-width': 3 },
        layout: { visibility: layersVisible.lines ? 'visible' : 'none' },
      })

      map.on('click', 'sample-lines-layer', (e) => {
        const props = e.features[0].properties
        new maplibregl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(
            `<strong>${props.name}</strong><br/>${props.voltage_kv} kV<br/>${props.owner}`
          )
          .addTo(map)
      })

      map.on('mouseenter', 'sample-lines-layer', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'sample-lines-layer', () => {
        map.getCanvas().style.cursor = ''
      })
    })

    return () => map.remove()
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getLayer('sample-lines-layer')) return
    map.setLayoutProperty(
      'sample-lines-layer',
      'visibility',
      layersVisible.lines ? 'visible' : 'none'
    )
  }, [layersVisible.lines])

  // M5 suitability layer — visibility (L1), symbology (L2), and the
  // histogram's select-by-attribute filter (L4) all feed into this one
  // getFillColor function. Cells outside the selected range stay in place
  // (so the AOI's shape/context doesn't disappear) but fade to nearly
  // invisible rather than being removed from the data outright.
  useEffect(() => {
    if (!overlayRef.current) return
    overlayRef.current.setProps({
      layers: [
        new GeoJsonLayer({
          id: 'suitability-score',
          data: '/data/suitability_score.geojson',
          visible: layersVisible.suitability,
          filled: true,
          stroked: false,
          getFillColor: (f) => {
            const score = f.properties.score
            const inRange = score >= selectedRange.min && score <= selectedRange.max
            const color = colorForScore(score, symbology.ramp, symbology.opacity)
            return inRange ? color : [color[0], color[1], color[2], 12]
          },
          pickable: true,
          updateTriggers: {
            getFillColor: [symbology.ramp, symbology.opacity, selectedRange.min, selectedRange.max],
          },
        }),
      ],
    })
  }, [layersVisible.suitability, symbology.ramp, symbology.opacity, selectedRange])

  const suitabilityControls = layersVisible.suitability && (
    <div style={{ marginTop: 4, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
      <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>Color ramp</div>
      <select
        value={symbology.ramp}
        onChange={(e) => setSymbology((s) => ({ ...s, ramp: e.target.value }))}
        style={{ width: '100%', marginBottom: 8 }}
      >
        {Object.entries(RAMPS).map(([key, { label }]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>

      <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
        Opacity ({Math.round((symbology.opacity / 255) * 100)}%)
      </div>
      <input
        type="range"
        min={20}
        max={255}
        value={symbology.opacity}
        onChange={(e) => setSymbology((s) => ({ ...s, opacity: Number(e.target.value) }))}
        style={{ width: '100%' }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <span style={{ opacity: 0.7, fontSize: 11 }}>Low</span>
        <div
          style={{
            width: 100,
            height: 8,
            borderRadius: 4,
            background: rampCssGradient(symbology.ramp),
          }}
        />
        <span style={{ opacity: 0.7, fontSize: 11 }}>High</span>
      </div>

      <div style={{ marginTop: 10 }}>
        {suitabilityFeatures === null ? (
          <div style={{ fontSize: 11, opacity: 0.5 }}>Loading...</div>
        ) : (
          <ScoreHistogram
            features={suitabilityFeatures}
            ramp={symbology.ramp}
            selectedRange={selectedRange}
            onRangeChange={setSelectedRange}
          />
        )}
      </div>
    </div>
  )

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      <LayersPanel
        layers={[
          {
            id: 'suitability',
            label: 'Suitability score (slope + land cover)',
            visible: layersVisible.suitability,
          },
          {
            id: 'lines',
            label: 'Transmission lines (sample)',
            visible: layersVisible.lines,
          },
        ]}
        onToggle={toggleLayer}
        extra={suitabilityControls}
      />
    </div>
  )
}
