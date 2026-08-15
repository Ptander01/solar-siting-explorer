import { useEffect, useState } from 'react'

// Collapsed/expanded state for a floating panel, remembered across reloads.
//
// localStorage rather than the URL, deliberately — same reasoning as the color
// ramp and opacity in urlState.js. Whether *you* have a panel folded away is a
// view preference; the AOI and the criterion weights are the analysis. Two
// people opening the same shared link should see the same analysis, not
// inherit each other's panel layout.
export function usePanelCollapse(key, defaultCollapsed = false) {
  const storageKey = `sse-panel-${key}`

  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return defaultCollapsed
    try {
      const stored = localStorage.getItem(storageKey)
      return stored === null ? defaultCollapsed : stored === '1'
    } catch {
      // Private-mode / blocked storage — fall back to the default rather than
      // taking the whole map down over a panel preference.
      return defaultCollapsed
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, collapsed ? '1' : '0')
    } catch {
      /* ignore — see above */
    }
  }, [storageKey, collapsed])

  return [collapsed, () => setCollapsed((c) => !c)]
}
