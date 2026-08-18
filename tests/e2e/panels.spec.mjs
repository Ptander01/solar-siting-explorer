// Collapse/expand behaviour for both floating panels.
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
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const STUB_STYLE = {
  version: 8, sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#101418' } }],
}
function grid(bbox, cols, rows, fn) {
  const [w, s, e, n] = bbox; const features = []
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const x0 = w + ((e - w) * j) / cols, x1 = w + ((e - w) * (j + 1)) / cols
    const y0 = s + ((n - s) * i) / rows, y1 = s + ((n - s) * (i + 1)) / rows
    features.push({ type: 'Feature',
      properties: { score: fn(i, j), slope_deg: 2.5, landcover_class: 'Grassland' },
      geometry: { type: 'Polygon', coordinates: [[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]] } })
  }
  return { type: 'FeatureCollection', features }
}
const PILOT = [-97.05, 37.7, -96.7, 37.95]

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

let analyzeDelay = 0
const routeHandler = async (route) => {
  const url = route.request().url()
  if (url.startsWith(BASE) && !url.includes('/api/') && !url.includes('/data/')) return route.continue()
  if (url.includes('basemaps.cartocdn.com'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(STUB_STYLE) })
  if (url.includes('/data/transmission_score.geojson')) return route.fulfill({ status: 404, body: '' })
  if (url.includes('/data/transmission_lines.geojson') || url.includes('/data/protected_areas.geojson'))
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] }) })
  if (url.includes('/data/') && url.endsWith('.geojson'))
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(grid(PILOT, 12, 10, (i, j) => ((i * 12 + j) % 100) + 1)) })
  if (url.includes('/api/health'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) })
  if (url.includes('/api/analyze')) {
    const body = JSON.parse(route.request().postData())
    if (analyzeDelay) await new Promise((r) => setTimeout(r, analyzeDelay))
    const fc = grid(body.bbox, body.grid_cols, body.grid_rows, () => 42)
    fc.metadata = { bbox: body.bbox, cell_count: fc.features.length, mean_score: 42,
      transmission_lines_found: 7, protected_areas_found: 1, excluded_cells: 13 }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fc) })
  }
  return route.fulfill({ status: 204, body: '' })
}
await page.route('**/*', routeHandler)
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2200)

const layersPanel = page.locator('.glass-panel').filter({ has: page.locator('.glass-title', { hasText: 'Layers' }) })
const analysisPanel = page.locator('.glass-panel').filter({ has: page.locator('.glass-title', { hasText: 'Analysis' }) })
const layersBtn = layersPanel.locator('.panel-collapse')
const analysisBtn = analysisPanel.locator('.panel-collapse')

check('Both panels have a collapse button',
  (await layersBtn.count()) === 1 && (await analysisBtn.count()) === 1)
check('Panels start expanded (aria-expanded=true)',
  (await layersBtn.getAttribute('aria-expanded')) === 'true' &&
  (await analysisBtn.getAttribute('aria-expanded')) === 'true')
check('Collapse button is labelled for screen readers',
  (await layersBtn.getAttribute('aria-label')) === 'Collapse Layers panel',
  await layersBtn.getAttribute('aria-label'))
check('aria-controls points at the panel body',
  !!(await layersBtn.getAttribute('aria-controls')))

const expandedLayers = await layersPanel.boundingBox()
const expandedAnalysis = await analysisPanel.boundingBox()
await page.screenshot({ path: shot('shot-c-expanded.png') })

// ── Collapse the layers panel ──────────────────────────────────────────
await layersBtn.click()
await page.waitForTimeout(400)
const collapsedLayers = await layersPanel.boundingBox()
check('Collapsing shrinks the layers panel height',
  collapsedLayers.height < expandedLayers.height * 0.35,
  `${Math.round(expandedLayers.height)} -> ${Math.round(collapsedLayers.height)}`)
check('Collapsing shrinks its width too', collapsedLayers.width < expandedLayers.width,
  `${Math.round(expandedLayers.width)} -> ${Math.round(collapsedLayers.width)}`)
check('Layers panel body is gone', !(await page.getByText('Score layer (one at a time)').isVisible().catch(() => false)))
check('Layers title still visible', await layersPanel.locator('.glass-title').isVisible())
check('aria-expanded flips to false', (await layersBtn.getAttribute('aria-expanded')) === 'false')
check('Label flips to Expand', (await layersBtn.getAttribute('aria-label')) === 'Expand Layers panel')
check('Collapsed header names the active layer',
  (await layersPanel.locator('.panel-badge').innerText()).includes('Suitability score'),
  await layersPanel.locator('.panel-badge').innerText())
check('Panel stays anchored top-left',
  Math.abs(collapsedLayers.x - expandedLayers.x) < 2 && Math.abs(collapsedLayers.y - expandedLayers.y) < 2)
check('Analysis panel unaffected', (await analysisPanel.boundingBox()).height === expandedAnalysis.height)

// ── Collapse the analysis panel too ────────────────────────────────────
await analysisBtn.click()
await page.waitForTimeout(400)
const collapsedAnalysis = await analysisPanel.boundingBox()
check('Collapsing shrinks the analysis panel',
  collapsedAnalysis.height < expandedAnalysis.height * 0.25,
  `${Math.round(expandedAnalysis.height)} -> ${Math.round(collapsedAnalysis.height)}`)
check('Analysis body is gone', !(await page.getByText('Criterion weights').isVisible().catch(() => false)))
check('Analysis panel stays anchored top-right',
  Math.abs((collapsedAnalysis.x + collapsedAnalysis.width) -
           (expandedAnalysis.x + expandedAnalysis.width)) < 2)
await page.screenshot({ path: shot('shot-c-collapsed.png') })

// ── Map is still interactive underneath ────────────────────────────────
const canvas = page.locator('.maplibregl-canvas')
const box = await canvas.boundingBox()
await page.mouse.move(box.x + 200, box.y + 300)
await page.mouse.down(); await page.mouse.move(box.x + 260, box.y + 340, { steps: 5 }); await page.mouse.up()
await page.waitForTimeout(300)
check('Map still pans with both panels collapsed', errors.length === 0, errors.join('; '))

// ── Persistence across reload ──────────────────────────────────────────
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
check('Collapsed state survives a reload',
  (await layersPanel.locator('.panel-collapse').getAttribute('aria-expanded')) === 'false' &&
  (await analysisPanel.locator('.panel-collapse').getAttribute('aria-expanded')) === 'false')

// ── Expand again ───────────────────────────────────────────────────────
await layersPanel.locator('.panel-collapse').click()
await analysisPanel.locator('.panel-collapse').click()
await page.waitForTimeout(500)
check('Expanding restores the layers body', await page.getByText('Score layer (one at a time)').isVisible())
check('Expanding restores the analysis body', await page.getByText('Criterion weights').isVisible())
check('Histogram re-renders after expand',
  (await page.locator('.recharts-wrapper').count()) > 0)
const reExpanded = await layersPanel.boundingBox()
check('Re-expanded panel matches its original size',
  Math.abs(reExpanded.height - expandedLayers.height) < 4,
  `${Math.round(expandedLayers.height)} vs ${Math.round(reExpanded.height)}`)

// ── Keyboard operable ──────────────────────────────────────────────────
await layersPanel.locator('.panel-collapse').focus()
await page.keyboard.press('Enter')
await page.waitForTimeout(350)
check('Toggle works from the keyboard (Enter)',
  (await layersPanel.locator('.panel-collapse').getAttribute('aria-expanded')) === 'false')
await page.keyboard.press('Space')
await page.waitForTimeout(350)
check('Toggle works from the keyboard (Space)',
  (await layersPanel.locator('.panel-collapse').getAttribute('aria-expanded')) === 'true')

// ── Collapsed badge reports an in-flight run ───────────────────────────
analyzeDelay = 3000
await page.getByRole('button', { name: 'Run analysis' }).click()
await page.waitForTimeout(600)
await analysisPanel.locator('.panel-collapse').click()   // collapse mid-run
await page.waitForTimeout(1200)
const badge = await analysisPanel.locator('.panel-badge').innerText()
check('Collapsed badge shows the run is still going', /\d+s/.test(badge), badge)
check('Spinner visible in the collapsed header',
  await analysisPanel.locator('.analysis-spinner').isVisible())
await page.screenshot({ path: shot('shot-c-running-collapsed.png') })
await page.waitForTimeout(3500)
const doneBadge = await analysisPanel.locator('.panel-badge').innerText()
check('Collapsed badge reports the finished mean score', doneBadge.includes('42'), doneBadge)

check('No uncaught errors', errors.length === 0, errors.join('; '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
