// Two kinds of layer selection here:
//   - radioLayers: the score "rasters" (suitability / slope / land cover /
//     transmission / live). Only one renders at a time — they'd occlude each
//     other anyway, and showing one at a time is what makes per-layer
//     symbology + a histogram (in `extra`) make sense, rather than a wall of
//     controls.
//   - checkboxLayers: independently toggleable vector layers (transmission
//     lines, protected areas) that make sense to overlay together.
//
// Styled as a glass panel — see src/styles/glass.css for the token set.
//
// Two things worth knowing about this file:
//
// 1. **Symbology hints.** Each score row carries a faint left-to-right wash
//    of that layer's *current* color ramp, and each vector row carries a
//    geometry-appropriate swatch (a stroke for lines, a filled chip for
//    polygons) in that layer's map color. Reading the list tells you what
//    you'd see on the map. It's driven by live symbology state, not a fixed
//    per-layer default, so changing a ramp updates the list too.
//
// 2. **These are real buttons.** They used to be `<div onClick>`, which meant
//    the entire layer list was unreachable by keyboard and invisible to a
//    screen reader. The score layers are now a proper `radiogroup` with
//    roving tabindex and arrow-key navigation; the vector layers are
//    `role="checkbox"` buttons. See glass.css for the focus treatment.

import { useRef } from 'react'
import PanelShell from './PanelShell.jsx'

// A one-off id for the "no score layer" option. `null` is the real value, but
// it can't be a React key or a ref index.
const NONE_ID = '__none__'

function LayerSwatch({ swatch }) {
  if (!swatch) return null
  // Lines get a stroke, polygons get a filled chip with an outline — the same
  // distinction desktop GIS makes, and it's free information: the shape tells
  // you the geometry type before you've looked at the map.
  if (swatch.type === 'line') {
    return (
      <span className="layer-swatch" aria-hidden="true">
        <span
          className="layer-swatch-line"
          style={{ background: swatch.color, boxShadow: `0 0 5px ${swatch.color}66` }}
        />
      </span>
    )
  }
  return (
    <span className="layer-swatch" aria-hidden="true">
      <span
        className="layer-swatch-fill"
        style={{ background: `${swatch.color}59`, borderColor: swatch.color }}
      />
    </span>
  )
}

export default function LayersPanel({
  radioLayers,
  activeRadioId,
  onRadioChange,
  checkboxLayers,
  onToggle,
  extra,
  collapsed,
  onToggleCollapse,
}) {
  // Collapsed, the header still names the layer that's actually drawn on the
  // map — otherwise folding the panel away loses the one piece of context you
  // need to read what you're looking at.
  const activeLabel = radioLayers?.find((l) => l.id === activeRadioId)?.label

  // "None" is a real option in the group, so exactly one radio is always
  // checked — which is what makes roving tabindex well-defined.
  const options = [...(radioLayers ?? []), { id: null, label: 'None', gradient: null }]
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.id === activeRadioId)
  )
  const optionRefs = useRef([])

  // Arrow keys move the selection *and* the focus, which is the expected
  // behaviour for a radiogroup (unlike a listbox, where they'd only move
  // focus). Home/End jump to the ends; the browser handles Enter/Space for
  // free because these are buttons.
  const onKeyDown = (event) => {
    const { key } = event
    let next = null
    if (key === 'ArrowDown' || key === 'ArrowRight') next = (activeIndex + 1) % options.length
    else if (key === 'ArrowUp' || key === 'ArrowLeft')
      next = (activeIndex - 1 + options.length) % options.length
    else if (key === 'Home') next = 0
    else if (key === 'End') next = options.length - 1
    if (next === null) return

    event.preventDefault()
    onRadioChange(options[next].id)
    optionRefs.current[next]?.focus()
  }

  return (
    <PanelShell
      title="Layers"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      collapsedBadge={activeLabel}
      position={{ top: 12, left: 12 }}
      width={276}
      maxHeight="calc(100% - 24px)"
    >
      {radioLayers && radioLayers.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="glass-section-label" id="score-layer-label">
            Score layer (one at a time)
          </div>
          <div
            className="glass-pill-track"
            role="radiogroup"
            aria-labelledby="score-layer-label"
            onKeyDown={onKeyDown}
          >
            {options.map((layer, index) => {
              const isNone = layer.id === null
              const selected = activeRadioId === layer.id
              return (
                <button
                  key={layer.id ?? NONE_ID}
                  ref={(el) => {
                    optionRefs.current[index] = el
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  // Roving tabindex: one stop for the whole group, so tabbing
                  // through the panel doesn't mean five stops on one control.
                  tabIndex={selected ? 0 : -1}
                  className={`glass-pill${selected ? ' glass-pill--on' : ''}`}
                  onClick={() => onRadioChange(layer.id)}
                  style={isNone && !selected ? { opacity: 0.6 } : undefined}
                >
                  {layer.gradient && (
                    <span
                      className="glass-pill-wash"
                      style={{ backgroundImage: layer.gradient }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="glass-pill-body">
                    <span className="glass-pill-dot" />
                    {layer.label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {checkboxLayers && checkboxLayers.length > 0 && (
        <div>
          {radioLayers?.length ? <hr className="glass-divider" /> : null}
          {checkboxLayers.map((layer) => (
            <button
              key={layer.id}
              type="button"
              role="checkbox"
              aria-checked={layer.visible}
              className={`glass-checkbox-row${layer.visible ? ' glass-checkbox-row--on' : ''}`}
              onClick={() => onToggle(layer.id)}
            >
              <span className="glass-checkbox-box">
                <span className="glass-checkbox-check" />
              </span>
              <LayerSwatch swatch={layer.swatch} />
              {layer.label}
            </button>
          ))}
        </div>
      )}

      {extra}
    </PanelShell>
  )
}
