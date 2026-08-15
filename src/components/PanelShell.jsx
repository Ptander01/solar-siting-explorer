// The floating glass panel both the Layers and Analysis panels sit in, with a
// collapse toggle in its header.
//
// Extracted rather than adding a button to each panel separately: they're the
// two things covering the map, so they need to fold away the same way, land in
// the same place in the tab order, and animate identically. One shell also
// means the collapsed state can't drift into two slightly different treatments.
//
// The toggle is a real <button> with aria-expanded and aria-controls — worth
// noting because the older pill and checkbox controls in this app are
// `<div onClick>` and are keyboard-inaccessible (a known outstanding issue, see
// the README's limitations). No reason to add a third one.

import { useId } from 'react'

function Chevron({ collapsed }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      style={{
        display: 'block',
        // Points up when open ("fold this away"), down when collapsed
        // ("bring it back").
        transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.2s ease',
      }}
    >
      <path
        d="M2.5 7.5L6 4l3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function PanelShell({
  title,
  collapsed,
  onToggleCollapse,
  // Rendered next to the title while collapsed — lets a panel keep signalling
  // something that still matters when its body is hidden (a run in progress,
  // an error), instead of the state silently disappearing.
  collapsedBadge,
  position,
  width,
  maxHeight,
  children,
}) {
  const bodyId = useId()

  return (
    <div
      className="glass-panel"
      style={{
        position: 'absolute',
        ...position,
        color: 'var(--cream)',
        padding: collapsed ? '10px 12px' : '14px 14px 16px',
        // A collapsed panel shrinks to its header rather than keeping the
        // body's width — the point is to give the map back its space.
        width: collapsed ? 'auto' : width,
        minWidth: collapsed ? 0 : undefined,
        maxHeight: collapsed ? undefined : maxHeight,
        overflowY: collapsed ? 'visible' : 'auto',
        transition: 'padding 0.18s ease',
      }}
    >
      <div className="panel-header">
        <div className="glass-title" style={{ marginBottom: 0 }}>
          {title}
        </div>
        {collapsed && collapsedBadge ? (
          <div className="panel-badge">{collapsedBadge}</div>
        ) : null}
        <button
          type="button"
          className="panel-collapse"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title} panel`}
          title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
        >
          <Chevron collapsed={collapsed} />
        </button>
      </div>

      {/* Unmounted rather than hidden when collapsed. The bodies hold a
          Recharts histogram and a stack of range inputs; keeping them mounted
          and display:none'd would leave Recharts measuring a zero-size
          container and re-rendering for nothing. */}
      {!collapsed && <div id={bodyId}>{children}</div>}
    </div>
  )
}
