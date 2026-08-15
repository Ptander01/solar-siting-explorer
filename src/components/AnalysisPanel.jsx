// B3 — controls for running the real suitability pipeline on demand against
// a user-drawn AOI, via the FastAPI /analyze endpoint from B1.
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

import { MAX_AOI_DEG2, bboxAreaDeg2, formatBbox } from '../lib/bboxDraw.js'

// Grid resolution presets. "Standard" matches GRID_COLS/GRID_ROWS in
// pipeline/m5_suitability_score.py, so a live run over the pilot AOI is
// directly comparable to the pre-baked layer. Coarser is genuinely useful
// while iterating on weights — _grid_average() in backend/suitability.py is
// an O(rows x cols) Python loop, so cell count drives most of the
// non-network time.
export const RESOLUTIONS = {
  coarse: { label: 'Coarse — 72 × 60', cols: 72, rows: 60 },
  standard: { label: 'Standard — 144 × 120', cols: 144, rows: 120 },
  fine: { label: 'Fine — 216 × 180', cols: 216, rows: 180 },
}

function StatusLine({ status, elapsedSec }) {
  if (status.state === 'running') {
    return (
      <div className="analysis-status">
        <span className="analysis-spinner" />
        Running… {elapsedSec}s
        <div className="analysis-status-note">
          Fetching SRTM tiles and WorldCover, then scoring the grid.
        </div>
      </div>
    )
  }
  if (status.state === 'error') {
    return (
      <div className="analysis-status analysis-status--error">
        {status.message}
      </div>
    )
  }
  if (status.state === 'done') {
    return (
      <div className="analysis-status analysis-status--ok">
        {status.cellCount.toLocaleString()} cells · mean score {status.meanScore}
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
  slopeWeight,
  onSlopeWeightChange,
  resolution,
  onResolutionChange,
  onRun,
  onCancel,
  status,
  elapsedSec,
  apiOnline,
  paramsDirty,
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

  return (
    <div
      className="glass-panel"
      style={{
        position: 'absolute',
        top: 192,
        right: 12,
        color: 'var(--cream)',
        padding: '14px 14px 16px',
        width: 264,
        maxHeight: 'calc(100% - 210px)',
        overflowY: 'auto',
      }}
    >
      <div className="glass-title">Analysis</div>

      {apiOnline === false && (
        <div className="analysis-status analysis-status--error" style={{ marginBottom: 10 }}>
          API not reachable. Start it with <code>uvicorn main:app --port 8000</code> in{' '}
          <code>backend/</code>, or <code>docker compose up</code>.
        </div>
      )}

      <div className="glass-section-label">Study area</div>
      <div className="glass-pill-track" style={{ marginBottom: 8 }}>
        <div
          className={`glass-pill${drawArmed ? ' glass-pill--on' : ''}`}
          onClick={onToggleDraw}
        >
          <span className="glass-pill-dot" />
          {drawArmed ? 'Drag on map… (Esc)' : 'Draw AOI'}
        </div>
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
        Weighting — slope {Math.round(slopeWeight * 100)}% / land cover{' '}
        {Math.round((1 - slopeWeight) * 100)}%
      </div>
      <input
        type="range"
        className="glass-slider"
        min={0}
        max={100}
        step={5}
        value={Math.round(slopeWeight * 100)}
        onChange={(e) => onSlopeWeightChange(Number(e.target.value) / 100)}
      />

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
          disabled={!canRun}
          style={{ opacity: canRun ? 1 : 0.45, cursor: canRun ? 'pointer' : 'not-allowed' }}
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
    </div>
  )
}
