// L3 + L4: the score histogram, colored to match the map's symbology, and
// doubling as a select-by-attribute filter — click a bar to select just
// that range, or click-and-drag across several to select a wider one.
// Clicking/dragging the exact same selection again clears it. Bars outside
// the current selection dim so it's obvious what's filtered.

import { useEffect, useRef, useState } from 'react'
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { colorForScoreCss } from '../lib/colorRamps.js'

const BIN_SIZE = 10
const BIN_COUNT = 100 / BIN_SIZE

function computeHistogram(features) {
  const bins = Array.from({ length: BIN_COUNT }, (_, i) => ({
    range: `${i * BIN_SIZE}-${i * BIN_SIZE + BIN_SIZE}`,
    binStart: i * BIN_SIZE,
    binEnd: i * BIN_SIZE + BIN_SIZE,
    count: 0,
  }))
  for (const f of features ?? []) {
    const score = f.properties?.score
    if (typeof score !== 'number') continue
    const idx = Math.min(Math.floor(score / BIN_SIZE), BIN_COUNT - 1)
    bins[idx].count += 1
  }
  return bins
}

export default function ScoreHistogram({ features, ramp, selectedRange, onRangeChange }) {
  const [dragAnchor, setDragAnchor] = useState(null)
  const [dragCurrent, setDragCurrent] = useState(null)
  const draggingRef = useRef(false)

  const bins = computeHistogram(features)
  const isFullRange = selectedRange.min === 0 && selectedRange.max === 100

  const preview =
    dragAnchor !== null && dragCurrent !== null
      ? {
          min: Math.min(dragAnchor, dragCurrent) * BIN_SIZE,
          max: Math.max(dragAnchor, dragCurrent) * BIN_SIZE + BIN_SIZE,
        }
      : null
  const activeRange = preview ?? selectedRange

  const handleMouseDown = (idx) => {
    draggingRef.current = true
    setDragAnchor(idx)
    setDragCurrent(idx)
  }
  const handleMouseEnter = (idx) => {
    if (draggingRef.current) setDragCurrent(idx)
  }

  useEffect(() => {
    const handleMouseUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      if (dragAnchor === null || dragCurrent === null) return

      const lo = Math.min(dragAnchor, dragCurrent)
      const hi = Math.max(dragAnchor, dragCurrent)
      const newMin = lo * BIN_SIZE
      const newMax = hi * BIN_SIZE + BIN_SIZE

      const sameAsCurrent =
        !isFullRange && selectedRange.min === newMin && selectedRange.max === newMax
      onRangeChange(sameAsCurrent ? { min: 0, max: 100 } : { min: newMin, max: newMax })

      setDragAnchor(null)
      setDragCurrent(null)
    }

    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [dragAnchor, dragCurrent, selectedRange, isFullRange, onRangeChange])

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
          Score distribution (click/drag to filter)
        </div>
        {!isFullRange && !preview && (
          <button
            onClick={() => onRangeChange({ min: 0, max: 100 })}
            style={{
              background: 'none',
              border: 'none',
              color: '#60a5fa',
              fontSize: 11,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Clear filter
          </button>
        )}
      </div>

      {!isFullRange && (
        <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
          Showing {activeRange.min}–{activeRange.max}
        </div>
      )}

      <ResponsiveContainer width="100%" height={80}>
        <BarChart data={bins} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="range"
            tick={{ fontSize: 8, fill: '#e6e8eb' }}
            interval={1}
            axisLine={{ stroke: 'rgba(255,255,255,0.2)' }}
            tickLine={false}
          />
          <YAxis hide />
          <Tooltip
            contentStyle={{
              background: '#111418',
              border: '1px solid rgba(255,255,255,0.15)',
              fontSize: 11,
              borderRadius: 6,
            }}
            labelStyle={{ color: '#e6e8eb' }}
            cursor={{ fill: 'rgba(255,255,255,0.06)' }}
          />
          <Bar dataKey="count" radius={[2, 2, 0, 0]} isAnimationActive={false}>
            {bins.map((bin, idx) => {
              const midpoint = bin.binStart + BIN_SIZE / 2
              const inRange = bin.binStart >= activeRange.min && bin.binEnd <= activeRange.max
              return (
                <Cell
                  key={bin.range}
                  fill={colorForScoreCss(midpoint, ramp)}
                  fillOpacity={inRange ? 1 : 0.25}
                  cursor="pointer"
                  onMouseDown={() => handleMouseDown(idx)}
                  onMouseEnter={() => handleMouseEnter(idx)}
                />
              )
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
