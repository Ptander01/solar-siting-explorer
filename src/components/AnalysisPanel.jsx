// B3/C2/C3 — controls for running the real suitability pipeline on demand
// against a user-drawn AOI, via the FastAPI /analyze endpoint.
//
// Lives in its own glass panel on the right rather than inside LayersPanel:
// the layers panel is already tall (radio pills + checkboxes + ramp +
// opacity + legend + histogram), and stacking analysis controls under all of
// that would push the run button below the fold on a laptop viewport.
//
// The distinction this panel has to make legible is that every control in
// LayersPanel is *symbology* — instant, client-side, just recoloring cells
// that are already loaded — while every control here is *analysis*, which
// re-runs real geoprocessing server-side and takes real seconds. Hence the
// explicit Run button (rather than sliders that fire on change), the elapsed
// timer, and the "parameters changed since last run" hint.

import { useState } from 'react'
import PanelShell from './PanelShell.jsx'
import { MAX_AOI_DEG2, bboxAreaDeg2, formatBbox } from '../lib/bboxDraw.js'
import { currentShareUrl } from '../lib/urlState.js'

// Grid resolution presets. "Standard" matches GRID_COLS/GRID_ROWS in
// pipeline/regenerate_baked_layers.py, so a live run over the pilot AOI is
// directly comparable to the pre-baked layer. Coarser is genuinely useful
// while iterating on weights — _grid_cells() in backend/suitability.py is
// an O(rows x cols) Python loop, so cell count drives most of the
// non-network time.
export const RESOLUTIONS = {
  coarse: { label: 'Coarse — 72 × 60', cols: 72, rows: 60 },
  standard: { label: 'Standard — 144 × 120', cols: 144, rows: 120 },
  fine: { label: 'Fine — 216 × 180', cols: 216, rows: 180 },
}

// The three scored criteria, in the order they appear as sliders.
const CRITERIA = [
  { key: 'slope', label: 'Slope' },
  { key: 'landcover', label: 'Land cover' },
  { key: 'transmission', label: 'Transmission' },
]

function StatusLine({ status, elapsedSec }) {
  if (status.state === 'running') {
    return (
      <div className="analysis-status">
        <span className="analysis-spinner" />
        Running… {elapsedSec}s
        <div className="analysis-status-note">
          Fetching elevation and land cover, then scoring the grid.
        </div>
      </div>
    )
  }
  if (status.state === 'error') {
    return <div className="analysis-status analysis-status--error">{status.message}</div>
  }
  if (status.state === 'done') {
    const md = status.metadata ?? {}
    return (
      <div className="analysis-status analysis-status--ok">
        {status.cellCount.toLocaleString()} cells · mean score {status.meanScore}
        <div className="analysis-status-note">
          {md.transmission_lines_found === 0
            ? 'No transmission lines within the cutoff — that criterion scored 0 everywhere.'
            : md.transmission_lines_found
              ? `${md.transmission_lines_found} transmission segments in range`
              : 'Transmission criterion not applied (weight 0)'}
          {md.excluded_cells > 0 && ` · ${md.excluded_cells.toLocaleString()} cells excluded as protected`}
        </div>
      </div>
    )
  }
  return null
}

export default function AnalysisPanel({
  aoi,
  draftAoi,
  isPilotAoi,
  drawArmed,
  onToggleDraw,
  onResetAoi,
  slopeMaxDeg,
  onSlopeMaxDegChange,
  weights,
  onWeightChange,
  transmissionMaxKm,
  onTransmissionMaxKmChange,
  applyExclusions,
  onApplyExclusionsChange,
  resolution,
  onResolutionChange,
  onRun,
  onCancel,
  status,
  elapsedSec,
  apiOnline,
  paramsDirty,
  collapsed,
  onToggleCollapse,
}) {
  // While a drag is in progress the readout follows the draft rectangle
  // rather than the committed AOI. That's not just cosmetic: the sq° figure
  // and the over-cap warning below are the only way to tell you're about to
  // draw something the API will reject, and finding that out *before*
  // releasing the mouse is the difference between resizing and redrawing.
  const displayAoi = draftAoi ?? aoi
  const drafting = Boolean(draftAoi)
  const area = bboxAreaDeg2(displayAoi)
  const tooLarge = area > MAX_AOI_DEG2
  const running = status.state === 'running'
  const canRun = apiOnline !== false && !tooLarge && !running && !drafting

  // Sliders are raw 0-100 priorities; the percentages shown are the
  // normalized shares the API will actually apply, so what's on screen
  // matches what comes back in metadata.weights.
  const weightTotal = CRITERIA.reduce((sum, c) => sum + weights[c.key], 0)
  const share = (key) =>
    weightTotal > 0 ? Math.round((weights[key] / weightTotal) * 100) : 0

  const [copied, setCopied] = useState(false)
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(currentShareUrl())
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked (insecure origin / denied permission) — the URL
         bar already holds the same link, so this is a convenience, not the
         only way to get it. */
    }
  }

  // A run keeps going while the panel is folded away, and so does a failure.
  // Surfacing both in the collapsed header is the difference between "I
  // collapsed this" and "I lost track of it".
  const collapsedBadge = running ? (
    <>
      <span className="analysis-spinner" />
      {elapsedSec}s
    </>
  ) : status.state === 'error' ? (
    <span style={{ color: '#f87171' }}>failed</span>
  ) : apiOnline === false ? (
    <span style={{ color: '#f87171' }}>API offline</span>
  ) : status.state === 'done' ? (
    `${status.meanScore} mean`
  ) : null

  return (
    <PanelShell
      title="Analysis"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      collapsedBadge={collapsedBadge}
      position={{ top: 192, right: 12 }}
      width={264}
      maxHeight="calc(100% - 210px)"
    >
      {apiOnline === false && (
        <div className="analysis-status analysis-status--error" style={{ marginBottom: 10 }}>
          API not reachable. Start it with <code>uvicorn main:app --port 8000</code> in{' '}
          <code>backend/</code>, or <code>docker compose up</code>.
        </div>
      )}

      <div className="glass-section-label">Study area</div>
      <div className="glass-pill-track" style={{ marginBottom: 8 }}>
        {/* A mode toggle, not a radio — aria-pressed says "this button is
            currently active", which is what arming draw mode means. */}
        <button
          type="button"
          aria-pressed={drawArmed}
          className={`glass-pill${drawArmed ? ' glass-pill--on' : ''}`}
          onClick={onToggleDraw}
        >
          <span className="glass-pill-body">
            <span className="glass-pill-dot" />
            {drawArmed ? 'Drag on map… (Esc)' : 'Draw AOI'}
          </span>
        </button>
      </div>

      <div className="analysis-readout">
        <div>{formatBbox(displayAoi)}</div>
        <div style={{ opacity: 0.7, marginTop: 2 }}>
          {area.toFixed(3)} sq°{' '}
          {drafting ? '· drawing…' : isPilotAoi ? '· pilot AOI' : '· drawn'}
        </div>
      </div>

      {tooLarge && (
        <div className="analysis-status analysis-status--error" style={{ marginTop: 8 }}>
          AOI is {area.toFixed(2)} sq° — the API caps a single run at {MAX_AOI_DEG2} sq°.
          Draw a smaller area.
        </div>
      )}

      {!isPilotAoi && !drafting && (
        <button className="glass-btn" style={{ marginTop: 8 }} onClick={onResetAoi}>
          Reset to pilot AOI
        </button>
      )}

      <hr className="glass-divider" />

      <div className="glass-section-label">Criterion weights</div>
      {CRITERIA.map(({ key, label }) => (
        <div key={key} style={{ marginBottom: 8 }}>
          <div className="glass-section-label" style={{ marginBottom: 4 }}>
            {label} — {share(key)}%
          </div>
          <input
            type="range"
            className="glass-slider"
            min={0}
            max={100}
            step={5}
            value={weights[key]}
            onChange={(e) => onWeightChange(key, Number(e.target.value))}
          />
        </div>
      ))}
      {weightTotal === 0 && (
        <div className="analysis-status analysis-status--error">
          At least one criterion needs a non-zero weight.
        </div>
      )}

      <hr className="glass-divider" />

      <div className="glass-section-label">Max usable slope ({slopeMaxDeg}°)</div>
      <input
        type="range"
        className="glass-slider"
        min={2}
        max={25}
        step={1}
        value={slopeMaxDeg}
        onChange={(e) => onSlopeMaxDegChange(Number(e.target.value))}
      />

      <div className="glass-section-label" style={{ marginTop: 12 }}>
        Transmission cutoff ({transmissionMaxKm} km)
      </div>
      <input
        type="range"
        className="glass-slider"
        min={1}
        max={50}
        step={1}
        value={transmissionMaxKm}
        disabled={weights.transmission === 0}
        style={{ opacity: weights.transmission === 0 ? 0.4 : 1 }}
        onChange={(e) => onTransmissionMaxKmChange(Number(e.target.value))}
      />

      <button
        type="button"
        role="checkbox"
        aria-checked={applyExclusions}
        className={`glass-checkbox-row${applyExclusions ? ' glass-checkbox-row--on' : ''}`}
        onClick={() => onApplyExclusionsChange(!applyExclusions)}
        style={{ marginTop: 10 }}
      >
        <span className="glass-checkbox-box">
          <span className="glass-checkbox-check" />
        </span>
        Exclude protected land
      </button>

      <div className="glass-section-label" style={{ marginTop: 12 }}>Grid resolution</div>
      <select
        className="glass-select"
        value={resolution}
        onChange={(e) => onResolutionChange(e.target.value)}
      >
        {Object.entries(RESOLUTIONS).map(([key, { label }]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 12 }}>
        <button
          className="glass-btn glass-btn--primary"
          onClick={onRun}
          disabled={!canRun || weightTotal === 0}
          style={{
            opacity: canRun && weightTotal > 0 ? 1 : 0.45,
            cursor: canRun && weightTotal > 0 ? 'pointer' : 'not-allowed',
          }}
        >
          {running ? 'Running…' : 'Run analysis'}
        </button>
        {running && (
          <button className="glass-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>

      {paramsDirty && status.state === 'done' && (
        <div className="analysis-status-note" style={{ marginTop: 6 }}>
          Parameters changed — re-run to update the live layer.
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <StatusLine status={status} elapsedSec={elapsedSec} />
      </div>

      <hr className="glass-divider" />
      <button className="glass-btn" onClick={copyLink} style={{ width: '100%' }}>
        {copied ? 'Link copied' : 'Copy link to this analysis'}
      </button>
      <div className="analysis-status-note" style={{ marginTop: 4 }}>
        The URL holds the AOI and every parameter above.
      </div>
    </PanelShell>
  )
}
