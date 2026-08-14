// Two kinds of layer selection here:
//   - radioLayers: the score "rasters" (suitability / slope / land cover).
//     Only one renders at a time — they'd occlude each other anyway, and
//     showing one at a time is what makes per-layer symbology + a
//     histogram (in `extra`) make sense, rather than a wall of controls.
//   - checkboxLayers: independently toggleable vector layers (transmission
//     lines, protected areas) that make sense to overlay together.
//
// Styled as a glass panel — backdrop blur, a soft outer shadow, and
// "lip" shadows on the pill track / checkboxes (raised when active,
// pressed into the track when idle) borrowed from another project's
// glassmorphism system. See src/styles/glass.css for the token set.

export default function LayersPanel({
  radioLayers,
  activeRadioId,
  onRadioChange,
  checkboxLayers,
  onToggle,
  extra,
}) {
  return (
    <div
      className="glass-panel"
      style={{
        position: 'absolute',
        top: 12,
        left: 12,
        color: '#e6e8eb',
        padding: '14px 14px 16px',
        minWidth: 260,
        maxWidth: 300,
      }}
    >
      <div className="glass-title">Layers</div>

      {radioLayers && radioLayers.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="glass-section-label">Score layer (one at a time)</div>
          <div className="glass-pill-track">
            {radioLayers.map((layer) => (
              <div
                key={layer.id}
                className={`glass-pill${activeRadioId === layer.id ? ' glass-pill--on' : ''}`}
                onClick={() => onRadioChange(layer.id)}
              >
                <span className="glass-pill-dot" />
                {layer.label}
              </div>
            ))}
            <div
              className={`glass-pill${activeRadioId === null ? ' glass-pill--on' : ''}`}
              onClick={() => onRadioChange(null)}
              style={{ opacity: activeRadioId === null ? 1 : 0.6 }}
            >
              <span className="glass-pill-dot" />
              None
            </div>
          </div>
        </div>
      )}

      {checkboxLayers && checkboxLayers.length > 0 && (
        <div>
          {radioLayers?.length ? <hr className="glass-divider" /> : null}
          {checkboxLayers.map((layer) => (
            <div
              key={layer.id}
              className={`glass-checkbox-row${layer.visible ? ' glass-checkbox-row--on' : ''}`}
              onClick={() => onToggle(layer.id)}
            >
              <span className="glass-checkbox-box">
                <span className="glass-checkbox-check" />
              </span>
              {layer.label}
            </div>
          ))}
        </div>
      )}

      {extra}
    </div>
  )
}
