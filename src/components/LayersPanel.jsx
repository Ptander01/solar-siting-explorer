// L1: layers panel shell — one entry per toggleable layer.
// L2: `extra` now carries per-layer symbology controls (opacity, color
// ramp) and the legend. L3 (histogram) and L4 (select-by-attribute) will
// extend this same panel next, rather than adding separate floating UI.

export default function LayersPanel({ layers, onToggle, extra }) {
  return (
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
        minWidth: 260,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 12, opacity: 0.8 }}>LAYERS</div>

      {layers.map((layer) => (
        <label
          key={layer.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            marginBottom: 6,
          }}
        >
          <input
            type="checkbox"
            checked={layer.visible}
            onChange={() => onToggle(layer.id)}
          />
          {layer.label}
        </label>
      ))}

      {extra}
    </div>
  )
}
