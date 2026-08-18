// End-to-end check for B2/B3 against a running Vite dev server.
// Every external host this app talks to (Carto basemaps, Esri imagery, the
// FastAPI backend) is stubbed at the network layer with page.route, so the
// test exercises the real React/MapLibre/deck.gl code with zero egress.
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.SSE_BASE_URL ?? 'http://localhost:5173'

// Screenshots land in tests/artifacts/ (gitignored). They are debugging aids,
// not assertions — every check in these suites is made against the DOM or the
// pixels, never against a stored image.
const ART = new URL('../artifacts/', import.meta.url).pathname
fs.mkdirSync(ART, { recursive: true })
const shot = (name) => ART + name

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Minimal but valid MapLibre style: no sprite, no glyphs, no remote sources.
const STUB_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#101418' } }],
}

function grid(bbox, cols, rows, scoreFn) {
  const [w, s, e, n] = bbox
  const features = []
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const x0 = w + ((e - w) * j) / cols
      const x1 = w + ((e - w) * (j + 1)) / cols
      const y0 = s + ((n - s) * i) / rows
      const y1 = s + ((n - s) * (i + 1)) / rows
      features.push({
        type: 'Feature',
        properties: {
          score: scoreFn(i, j),
          slope_deg: 2.5,
          landcover_class: 'Grassland',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

const PILOT = [-97.05, 37.7, -96.7, 37.95]

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

let analyzeRequestBody = null
let analyzeCallCount = 0

const routeHandler = async (route) => {
  const url = route.request().url()

  if (url.startsWith(BASE) && !url.includes('/api/') && !url.includes('/data/')) {
    return route.continue() // app assets from Vite
  }
  if (url.includes('basemaps.cartocdn.com')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(STUB_STYLE) })
  }
  if (url.includes('/data/transmission_lines.geojson')) {
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { VOLTAGE: 138, OWNER: 'Test Utility' },
          geometry: { type: 'LineString', coordinates: [[-97.0, 37.75], [-96.8, 37.9]] },
        }],
      }),
    })
  }
  if (url.includes('/data/protected_areas.geojson')) {
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
    })
  }
  if (url.includes('/data/transmission_score.geojson')) {
    // Not yet regenerated — the app should hide this layer, not show it empty.
    return route.fulfill({ status: 404, body: 'not found' })
  }
  if (url.includes('/data/') && url.endsWith('.geojson')) {
    // The three pre-baked score layers.
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(grid(PILOT, 12, 10, (i, j) => ((i * 12 + j) % 100) + 1)),
    })
  }
  if (url.includes('/api/health')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) })
  }
  if (url.includes('/api/analyze')) {
    analyzeCallCount++
    analyzeRequestBody = JSON.parse(route.request().postData())
    // Echo the grid size back to prove the resolution plumbing reached the
    // wire, plus a metadata block shaped like run_analysis()'s real response.
    const { bbox, grid_cols, grid_rows } = analyzeRequestBody
    const fc = grid(bbox, grid_cols, grid_rows, () => 42)
    fc.metadata = {
      bbox, cell_count: fc.features.length, mean_score: 42,
      transmission_lines_found: 7, protected_areas_found: 1, excluded_cells: 13,
      weights: { slope: 0.5, landcover: 0.25, transmission: 0.25 },
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fc) })
  }
  return route.fulfill({ status: 204, body: '' })
}
await page.route('**/*', routeHandler)

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

// ── 1. Panels render ──────────────────────────────────────────────────
check('Layers panel renders', await page.getByText('Layers', { exact: true }).isVisible())
check('Analysis panel renders', await page.getByText('Analysis', { exact: true }).isVisible())
check(
  'API health check reports online (no error banner)',
  !(await page.getByText('API not reachable').isVisible().catch(() => false))
)

const readout = page.locator('.analysis-readout')
const initialBbox = (await readout.innerText()).split('\n')[0].trim()
check(
  'Opens on the pilot AOI',
  initialBbox === '-97.050, 37.700, -96.700, 37.950',
  initialBbox
)
check(
  'Pilot AOI is labelled as such',
  (await readout.innerText()).includes('pilot AOI')
)
check(
  '"Reset to pilot AOI" hidden while on the pilot AOI',
  !(await page.getByRole('button', { name: 'Reset to pilot AOI' }).isVisible().catch(() => false))
)

// ── 2. Live layer not offered before a run ────────────────────────────
check(
  'Live layer absent from the layer list before any run',
  !(await page.getByText('Live analysis (drawn AOI)').isVisible().catch(() => false))
)

await page.screenshot({ path: shot('shot-1-initial.png') })

// ── 3. Draw an AOI ────────────────────────────────────────────────────
await page.getByText('Draw AOI').click()
check(
  'Draw mode arms and prompts for the drag',
  await page.getByText('Drag on map… (Esc)').isVisible()
)

const canvas = page.locator('.maplibregl-canvas')
const box = await canvas.boundingBox()
// Drag a rectangle in the open middle of the map. The canvas is full-bleed
// behind the glass panels, so these have to clear the layers panel (left,
// ~0-340px) and the analysis panel (right, ~1090px+) or the mousedown lands
// on a panel instead of the map.
const x0 = box.x + 470
const y0 = box.y + 250
const x1 = box.x + 700
const y1 = box.y + 470

await page.mouse.move(x0, y0)
await page.mouse.down()
await page.mouse.move(x0 + 110, y0 + 100, { steps: 8 })
const midDraftText = await readout.innerText()
const midDraft = midDraftText.split('\n')[0].trim()
const midDraftLabel = midDraftText.split('\n')[1] ?? ''
await page.screenshot({ path: shot('shot-2-dragging.png') })
await page.mouse.move(x1, y1, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(600)

const drawnBbox = (await readout.innerText()).split('\n')[0].trim()
check('AOI changed after the drag', drawnBbox !== initialBbox, drawnBbox)
check(
  'Committed AOI is west<east, south<north (normalized)',
  (() => {
    const [w, s, e, n] = drawnBbox.split(',').map((v) => Number(v.trim()))
    return e > w && n > s
  })(),
  drawnBbox
)
check(
  'Draw mode disarms after committing',
  await page.getByText('Draw AOI').isVisible()
)
check(
  'AOI now labelled "drawn"',
  (await readout.innerText()).includes('drawn')
)
check(
  '"Reset to pilot AOI" appears once off the pilot AOI',
  await page.getByRole('button', { name: 'Reset to pilot AOI' }).isVisible()
)
check(
  'Readout tracked the draft rectangle mid-drag',
  midDraft !== initialBbox && midDraft !== drawnBbox,
  `mid: ${midDraft}`
)
check('Readout labelled the in-progress drag', midDraftLabel.includes('drawing…'), midDraftLabel)

await page.screenshot({ path: shot('shot-3-drawn.png') })

// ── 4. Stray click must not clobber the AOI ───────────────────────────
await page.getByText('Draw AOI').click()
await page.mouse.move(box.x + 700, box.y + 400)
await page.mouse.down()
await page.mouse.move(box.x + 702, box.y + 402)
await page.mouse.up()
await page.waitForTimeout(300)
check(
  'Sub-threshold click leaves the AOI untouched',
  (await readout.innerText()).split('\n')[0].trim() === drawnBbox
)
// Escape cancels draw mode.
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
check('Escape disarms draw mode', await page.getByText('Draw AOI').isVisible())

// ── 5. Parameters + run ───────────────────────────────────────────────
// Filter on the panel's own title element: after a run the *layers* panel
// also contains the string "Live analysis (drawn AOI)", and Playwright's
// hasText is a case-insensitive substring match, so `hasText: 'Analysis'`
// on the panel would start matching both.
const analysisPanel = page
  .locator('.glass-panel')
  .filter({ has: page.locator('.glass-title', { hasText: 'Analysis' }) })

check(
  'Transmission layer hidden while its baked file 404s',
  !(await page.getByText('Transmission score (input layer)').isVisible().catch(() => false))
)

await analysisPanel.locator('select.glass-select').selectOption('coarse')
await page.waitForTimeout(200)

// Sliders in panel order: slope weight, land cover weight, transmission
// weight, max usable slope, transmission cutoff.
const analysisSliders = analysisPanel.locator('input.glass-slider')
check(
  'Analysis panel exposes five sliders',
  (await analysisSliders.count()) === 5,
  String(await analysisSliders.count())
)

await analysisSliders.nth(0).fill('50')
await analysisSliders.nth(1).fill('25')
await analysisSliders.nth(2).fill('25')
await analysisSliders.nth(3).fill('14')
await analysisSliders.nth(4).fill('15')
await page.waitForTimeout(250)

const labelText = (await analysisPanel.innerText()).toLowerCase()
check('Slope max slider label updates', labelText.includes('max usable slope (14°)'))
check('Transmission cutoff label updates', labelText.includes('transmission cutoff (15 km)'))
check(
  'Weights displayed as normalized shares (50/25/25)',
  labelText.includes('slope — 50%') &&
    labelText.includes('land cover — 25%') &&
    labelText.includes('transmission — 25%'),
  labelText.split('\n').filter((l) => l.includes('%')).join(' | ')
)

await page.getByRole('button', { name: 'Run analysis' }).click()
await page.waitForTimeout(2500)

check('Analyze endpoint was called exactly once', analyzeCallCount === 1, `calls: ${analyzeCallCount}`)
check(
  'Request carried the drawn bbox',
  JSON.stringify(analyzeRequestBody?.bbox?.map((v) => Number(v.toFixed(3)))) ===
    JSON.stringify(drawnBbox.split(',').map((v) => Number(v.trim()))),
  JSON.stringify(analyzeRequestBody?.bbox)
)
check('Request carried slope_max_deg=14', analyzeRequestBody?.slope_max_deg === 14,
  String(analyzeRequestBody?.slope_max_deg))
check(
  'Raw weights sent unnormalized (the server normalizes)',
  analyzeRequestBody?.slope_weight === 50 &&
    analyzeRequestBody?.landcover_weight === 25 &&
    analyzeRequestBody?.transmission_weight === 25,
  `${analyzeRequestBody?.slope_weight}/${analyzeRequestBody?.landcover_weight}/${analyzeRequestBody?.transmission_weight}`
)
check('Request carried transmission_max_km=15', analyzeRequestBody?.transmission_max_km === 15,
  String(analyzeRequestBody?.transmission_max_km))
check('Request carried apply_exclusions=true', analyzeRequestBody?.apply_exclusions === true)
check(
  'Coarse resolution mapped to 72x60',
  analyzeRequestBody?.grid_cols === 72 && analyzeRequestBody?.grid_rows === 60,
  `${analyzeRequestBody?.grid_cols}x${analyzeRequestBody?.grid_rows}`
)

const panelText = await analysisPanel.innerText()
check(
  'Status reports cell count and the server-supplied mean score',
  panelText.includes('4,320 cells') && panelText.includes('mean score 42'),
  panelText.split('\n').filter((l) => l.includes('cells')).join(' | ')
)
check(
  'Status surfaces transmission and exclusion metadata',
  panelText.includes('7 transmission segments in range') &&
    panelText.includes('13 cells excluded as protected'),
  panelText.split('\n').filter((l) => l.toLowerCase().includes('transmission')).join(' | ')
)
check(
  'Live layer becomes selectable after a successful run',
  await page.getByText('Live analysis (drawn AOI)').first().isVisible()
)
check(
  'Live layer auto-selected and drives the symbology section',
  (await page.locator('.glass-panel', { hasText: 'Layers' }).first().innerText())
    .includes('Live analysis (drawn AOI)')
)

await page.screenshot({ path: shot('shot-4-analyzed.png') })

// ── 5b. Exclusion toggle reaches the wire ─────────────────────────────
await page.getByText('Exclude protected land').click()
await page.waitForTimeout(250)
await page.getByRole('button', { name: 'Run analysis' }).click()
await page.waitForTimeout(2000)
check('Unchecking the exclusion sends apply_exclusions=false',
  analyzeRequestBody?.apply_exclusions === false,
  String(analyzeRequestBody?.apply_exclusions))
await page.getByText('Exclude protected land').click()
await page.waitForTimeout(250)

// ── 5c. Zero weights must disable the run ─────────────────────────────
await analysisSliders.nth(0).fill('0')
await analysisSliders.nth(1).fill('0')
await analysisSliders.nth(2).fill('0')
await page.waitForTimeout(300)
check(
  'All-zero weights disable Run and warn',
  (await page.getByRole('button', { name: 'Run analysis' }).isDisabled()) &&
    (await analysisPanel.innerText()).includes('non-zero weight')
)
await analysisSliders.nth(0).fill('50')
await analysisSliders.nth(1).fill('25')
await analysisSliders.nth(2).fill('25')
await page.waitForTimeout(300)

// ── 5d. C3 — permalink state ──────────────────────────────────────────
const shareUrl = page.url()
const q = new URL(shareUrl).searchParams
check(
  'URL carries the drawn AOI',
  q.get('aoi')?.split(',').length === 4 &&
    Math.abs(Number(q.get('aoi').split(',')[0]) - Number(drawnBbox.split(',')[0])) < 0.01,
  q.get('aoi')
)
check(
  'URL carries every analysis parameter',
  q.get('smax') === '14' && q.get('ws') === '50' && q.get('wl') === '25' &&
    q.get('wt') === '25' && q.get('tmax') === '15' && q.get('res') === 'coarse',
  shareUrl.split('?')[1]
)
check('URL never names the live layer', q.get('layer') !== 'live', String(q.get('layer')))

// Open the shared link in a clean page and confirm it restores.
const page2 = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page2.route('**/*', routeHandler)
await page2.goto(shareUrl, { waitUntil: 'networkidle' })
await page2.waitForTimeout(2500)
const panel2 = page2
  .locator('.glass-panel')
  .filter({ has: page2.locator('.glass-title', { hasText: 'Analysis' }) })
const restoredText = (await panel2.innerText()).toLowerCase()
const readout2Full = await page2.locator('.analysis-readout').innerText()
const readout2 = readout2Full.split('\n')[0].trim()
check('Shared link restores the AOI', readout2 === drawnBbox, readout2)
check(
  'Shared link restores weights and thresholds',
  restoredText.includes('slope — 50%') &&
    restoredText.includes('transmission — 25%') &&
    restoredText.includes('max usable slope (14°)') &&
    restoredText.includes('transmission cutoff (15 km)')
)
check(
  'Shared link restores the grid resolution',
  (await panel2.locator('select.glass-select').inputValue()) === 'coarse'
)
check('Shared link opens with the AOI marked drawn, not pilot', readout2Full.includes('drawn'))

// A mangled AOI must fall back to the pilot rather than render something broken.
const badUrl = shareUrl.replace(/aoi=[^&]*/, 'aoi=not,a,bbox,x')
await page2.goto(badUrl, { waitUntil: 'networkidle' })
await page2.waitForTimeout(2000)
check(
  'Malformed AOI in the URL falls back to the pilot AOI',
  (await page2.locator('.analysis-readout').innerText())
    .split('\n')[0].trim() === '-97.050, 37.700, -96.700, 37.950'
)
await page2.goto(shareUrl, { waitUntil: 'networkidle' })
await page2.waitForTimeout(1500)
await page2.screenshot({ path: shot('shot-5-shared-link.png') })
await page2.close()

// ── 6. Dirty-params hint ──────────────────────────────────────────────
await analysisSliders.nth(3).fill('9')
await page.waitForTimeout(300)
check(
  'Changing a parameter after a run shows the re-run hint',
  (await analysisPanel.innerText()).includes('Parameters changed')
)

// ── 7. Reset ──────────────────────────────────────────────────────────
await page.getByRole('button', { name: 'Reset to pilot AOI' }).click()
await page.waitForTimeout(500)
check(
  'Reset returns to the pilot AOI',
  (await readout.innerText()).split('\n')[0].trim() === '-97.050, 37.700, -96.700, 37.950'
)

// ── 8. No console errors ──────────────────────────────────────────────
const realErrors = consoleErrors.filter(
  (e) =>
    !/favicon|WebGL|SwiftShader|GPU stall|Failed to load resource.*204/i.test(e) &&
    // This suite deliberately 404s transmission_score.geojson to prove the
    // layer is hidden rather than shown empty before the pipeline has been
    // regenerated; the browser logs that 404 regardless.
    !/Failed to load resource.*404/i.test(e)
)
check('No uncaught console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' || '))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
