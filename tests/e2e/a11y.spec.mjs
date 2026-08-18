// Accessibility + symbology-hint checks for the layer list.
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
const check = (n, p, d = '') => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`) }

const STUB_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#101418' } }] }
function grid(bbox, c, r, fn) {
  const [w, s, e, n] = bbox; const features = []
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) {
    const x0 = w + ((e - w) * j) / c, x1 = w + ((e - w) * (j + 1)) / c
    const y0 = s + ((n - s) * i) / r, y1 = s + ((n - s) * (i + 1)) / r
    features.push({ type: 'Feature', properties: { score: fn(i, j), slope_deg: 2.5, landcover_class: 'Grassland' },
      geometry: { type: 'Polygon', coordinates: [[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]] } })
  }
  return { type: 'FeatureCollection', features }
}
const PILOT = [-97.05, 37.7, -96.7, 37.95]
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
const errors = []; page.on('pageerror', (e) => errors.push(e.message))
await page.route('**/*', async (route) => {
  const url = route.request().url()
  if (url.startsWith(BASE) && !url.includes('/api/') && !url.includes('/data/')) return route.continue()
  if (url.includes('basemaps.cartocdn.com')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(STUB_STYLE) })
  if (url.includes('/data/transmission_score.geojson')) return route.fulfill({ status: 404, body: '' })
  if (url.includes('/data/transmission_lines.geojson') || url.includes('/data/protected_areas.geojson'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) })
  if (url.includes('/data/') && url.endsWith('.geojson'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(grid(PILOT, 12, 10, (i,j) => ((i*12+j)%100)+1)) })
  if (url.includes('/api/health')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) })
  return route.fulfill({ status: 204, body: '' })
})
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2200)

// ── Semantics ──────────────────────────────────────────────────────────
const group = page.locator('[role="radiogroup"]')
check('Score layers are a radiogroup', (await group.count()) === 1)
check('Radiogroup is labelled', !!(await group.getAttribute('aria-labelledby')))
const radios = group.locator('[role="radio"]')
const nRadios = await radios.count()
check('Every score layer is a radio (incl. None)', nRadios === 4, String(nRadios))
check('Radios are <button> elements',
  (await radios.first().evaluate((el) => el.tagName)) === 'BUTTON')
let checkedCount = 0
for (let i = 0; i < nRadios; i++) if ((await radios.nth(i).getAttribute('aria-checked')) === 'true') checkedCount++
check('Exactly one radio is checked', checkedCount === 1, String(checkedCount))

const tabIndexes = await radios.evaluateAll((els) => els.map((e) => e.tabIndex))
check('Roving tabindex: one stop for the whole group',
  tabIndexes.filter((t) => t === 0).length === 1 && tabIndexes.filter((t) => t === -1).length === nRadios - 1,
  JSON.stringify(tabIndexes))

const boxes = page.locator('[role="checkbox"]')
check('Vector layers + exclusion toggle are checkboxes', (await boxes.count()) === 3, String(await boxes.count()))
check('Checkbox exposes its state',
  ['true','false'].includes(await boxes.first().getAttribute('aria-checked')))
check('No div-with-onClick controls remain in the panels',
  (await page.locator('.glass-panel div.glass-pill, .glass-panel div.glass-checkbox-row').count()) === 0)

// ── Keyboard: arrow keys drive the radiogroup ──────────────────────────
await radios.nth(0).focus()
check('Focused radio is the checked one', (await radios.nth(0).getAttribute('aria-checked')) === 'true')
await page.keyboard.press('ArrowDown')
await page.waitForTimeout(250)
check('ArrowDown moves selection to the next layer',
  (await radios.nth(1).getAttribute('aria-checked')) === 'true' &&
  (await radios.nth(0).getAttribute('aria-checked')) === 'false')
check('ArrowDown moves focus with the selection',
  await radios.nth(1).evaluate((el) => el === document.activeElement))
// .first() is the Analysis panel (it renders earlier in the DOM), so scope
// this to the Layers panel explicitly.
const layersPanelEarly = page.locator('.glass-panel')
  .filter({ has: page.locator('.glass-title', { hasText: 'Layers' }) })
check('Selecting by keyboard changes the panel body',
  (await layersPanelEarly.innerText()).toLowerCase().includes('slope score (input layer)'))
await page.keyboard.press('End')
await page.waitForTimeout(250)
check('End jumps to the last option (None)', (await radios.nth(3).getAttribute('aria-checked')) === 'true')
await page.keyboard.press('Home')
await page.waitForTimeout(250)
check('Home jumps back to the first', (await radios.nth(0).getAttribute('aria-checked')) === 'true')
await page.keyboard.press('ArrowUp')
await page.waitForTimeout(250)
check('ArrowUp wraps to the end', (await radios.nth(3).getAttribute('aria-checked')) === 'true')
await page.keyboard.press('ArrowDown')
await page.waitForTimeout(250)

// Checkbox via keyboard
const vecBox = boxes.nth(0)
await vecBox.focus()
const before = await vecBox.getAttribute('aria-checked')
await page.keyboard.press('Space')
await page.waitForTimeout(250)
check('Space toggles a layer checkbox', (await vecBox.getAttribute('aria-checked')) !== before)
await page.keyboard.press('Enter')
await page.waitForTimeout(250)
check('Enter toggles it back', (await vecBox.getAttribute('aria-checked')) === before)

// Focus ring actually renders
const outline = await radios.nth(0).evaluate((el) => {
  el.focus()
  return getComputedStyle(el).outlineWidth
})
check('Focused control gets a visible outline', outline !== '0px', outline)

// ── Symbology hints ────────────────────────────────────────────────────
const washes = page.locator('.glass-pill-wash')
check('Every score layer has a ramp wash (None does not)',
  (await washes.count()) === nRadios - 1, String(await washes.count()))

const gradients = await washes.evaluateAll((els) => els.map((e) => e.style.backgroundImage))
check('Washes carry distinct per-layer ramps',
  new Set(gradients).size === gradients.length, `${gradients.length} rows, ${new Set(gradients).size} distinct`)
check('Land cover row uses the viridis ramp',
  /rgb\(68,\s*1,\s*84\)/.test(gradients[2]), gradients[2]?.slice(0, 60))
check('Slope row uses the blues ramp',
  /rgb\(239,\s*246,\s*255\)/.test(gradients[1]), gradients[1]?.slice(0, 60))

const opacities = await washes.evaluateAll((els) => els.map((e) => Number(getComputedStyle(e).opacity)))
check('Wash is subtle, not dominant', opacities.every((o) => o > 0 && o <= 0.3), JSON.stringify(opacities))
check('Selected row washes slightly stronger than idle rows',
  Math.max(...opacities) > Math.min(...opacities), JSON.stringify(opacities))

// The wash must paint ABOVE the amber fill on the active row, or the hue is lost.
const stacking = await page.locator('.glass-pill--on').first().evaluate((pill) => {
  const wash = pill.querySelector('.glass-pill-wash')
  const body = pill.querySelector('.glass-pill-body')
  return { wash: getComputedStyle(wash).zIndex, body: getComputedStyle(body).zIndex,
           pos: getComputedStyle(wash).position }
})
check('Active row: wash overlays the fill, label sits above the wash',
  stacking.pos === 'absolute' && Number(stacking.body) > Number(stacking.wash),
  JSON.stringify(stacking))

check('Vector layers get geometry-appropriate swatches',
  (await page.locator('.layer-swatch-line').count()) === 1 &&
  (await page.locator('.layer-swatch-fill').count()) === 1)

// Changing a ramp must update the row's wash — the hint tracks live state.
await radios.nth(0).click()
await page.waitForTimeout(200)
const before0 = (await washes.nth(0).evaluate((e) => e.style.backgroundImage))
// Scope to the Layers panel — the Analysis panel renders first in the DOM
// and its .glass-select is the grid-resolution dropdown.
const layersPanel = page.locator('.glass-panel')
  .filter({ has: page.locator('.glass-title', { hasText: 'Layers' }) })
await layersPanel.locator('select.glass-select').selectOption('viridis')
await page.waitForTimeout(300)
const after0 = (await washes.nth(0).evaluate((e) => e.style.backgroundImage))
check('Changing a ramp updates that row’s wash', before0 !== after0 && /rgb\(68,\s*1,\s*84\)/.test(after0))

await page.screenshot({ path: shot('shot-s-dark.png') })
// Light mode
await page.getByText('Dark', { exact: true }).click()
await page.waitForTimeout(700)
const lightOpacity = await washes.first().evaluate((e) => Number(getComputedStyle(e).opacity))
check('Light theme dials the wash back', lightOpacity < Math.max(...opacities), String(lightOpacity))
await page.screenshot({ path: shot('shot-s-light.png') })

check('No uncaught errors', errors.length === 0, errors.join('; '))
await browser.close()
const failed = results.filter((r) => !r.p)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
