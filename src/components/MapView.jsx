import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { GeoJsonLayer } from '@deck.gl/layers'
import 'maplibre-gl/dist/maplibre-gl.css'

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

// Red (low) -> yellow (mid) -> green (high), matching the 0-100 score from
// pipeline/m5_suitability_score.py.
function colorForScore(score) {
  const clamped = Math.max(0, Math.min(100, score ?? 0))
  const low = [239, 68, 68]
  const mid = [250, 204, 21]
  const high = [34, 197, 94]
  const [a, b, t] = clamped <= 50 ? [low, mid, clamped / 50] : [mid, high, (clamped - 50) / 50]
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    170,
  ]
}

export default function MapView() {
  const containerRef = useRef(null)
  const overlayRef = useRef(null)
  const [showSuitability, setShowSuitability] = useState(true)

  // Map + sample-lines layer setup (M1 + M2, unchanged)
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [-96.875, 37.825],
      zoom: 10,
    })

    map.addControl(new maplibregl.NavigationControl(), 'top-right')

    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      getTooltip: ({ object }) =>
        object && {
          text: `Suitability: ${object.properties.score}/100`,
        },
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

  // M5: combined slope + land-cover suitability score
  // (from pipeline/m5_suitability_score.py), color-graded red -> green.
  // Replaces the M4 flat-fill binary layer.
  useEffect(() => {
    if (!overlayRef.current) return
    overlayRef.current.setProps({
      layers: [
        new GeoJsonLayer({
          id: 'suitability-score',
          data: '/data/suitability_score.geojson',
          visible: showSuitability,
          filled: true,
          stroked: false,
          getFillColor: (f) => colorForScore(f.properties.score),
          pickable: true,
          updateTriggers: { getFillColor: [showSuitability] },
        }),
      ],
    })
  }, [showSuitability])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          background: 'rgba(17, 20, 24, 0.85)',
          color: '#e6e8eb',
          padding: '10px 12px',
          borderRadius: 8,
          fontFamily: 'system-ui, sans-serif',
          fontSize: 13,
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showSuitability}
            onChange={(e) => setShowSuitability(e.target.checked)}
          />
          Suitability score (slope + land cover)
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <span style={{ opacity: 0.7, fontSize: 11 }}>Low</span>
          <div
            style={{
              width: 100,
              height: 8,
              borderRadius: 4,
              background: 'linear-gradient(to right, #ef4444, #facc15, #22c55e)',
            }}
          />
          <span style={{ opacity: 0.7, fontSize: 11 }}>High</span>
        </div>
      </div>
    </div>
  )
}
