// Renders-on-the-map regression test.
//
// The bug this exists for: the transmission and protected-area layers were
// present in the style, visible, and correctly sourced — every structural
// check passed — while being painted over by the deck.gl score raster. The
// only assertion that would have caught it is one about pixels.
import { chromium } from 'playwright'
import fs from 'node:fs'
import { PNG } from 'pngjs'

const BASE = process.env.SSE_BASE_URL ?? 'http://localhost:5173'

// Screenshots land in tests/artifacts/ (gitignored). They are debugging aids,
// not assertions — every check in these suites is made against the DOM or the
// pixels, never against a stored image.
const ART = new URL('../artifacts/', import.meta.url).pathname
fs.mkdirSync(ART, { recursive: true })
const shot = (name) => ART + name

const results = []
const check = (n, p, d = '') => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`) }

const AMBER = [245, 158, 11]   // transmission line-color
const GREEN = [34, 197, 94]    // protected-area color

const STUB_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#101418' } }] }
function grid(bbox, c, r, fn) {
  const [w, s, e, n] = bbox; const features = []
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) {
    const x0 = w + ((e-w)*j)/c, x1 = w + ((e-w)*(j+1))/c
    const y0 = s + ((n-s)*i)/r, y1 = s + ((n-s)*(i+1))/r
    features.push({ type:'Feature', properties:{score:fn(i,j),slope_deg:2.5,landcover_class:'Grassland'},
      geometry:{type:'Polygon',coordinates:[[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]]} })
  }
  return { type:'FeatureCollection', features }
}
const PILOT = [-97.05, 37.7, -96.7, 37.95]

function decode(buf) { return PNG.sync.read(buf) }
function near(px, target, tol) {
  return Math.abs(px[0]-target[0]) <= tol && Math.abs(px[1]-target[1]) <= tol && Math.abs(px[2]-target[2]) <= tol
}
// Count pixels close to a target color, ignoring the panel areas on the left
// and right so panel swatches/washes can't be mistaken for map rendering.
function countColor(png, target, tol) {
  let n = 0
  for (let y = 0; y < png.height; y++) {
    for (let x = 360; x < png.width - 340; x++) {
      const i = (png.width * y + x) << 2
      if (near([png.data[i], png.data[i+1], png.data[i+2]], target, tol)) n++
    }
  }
  return n
}
function diffCount(a, b) {
  let n = 0
  for (let y = 0; y < a.height; y++) {
    for (let x = 360; x < a.width - 340; x++) {
      const i = (a.width * y + x) << 2
      if (Math.abs(a.data[i]-b.data[i]) > 12 || Math.abs(a.data[i+1]-b.data[i+1]) > 12 ||
          Math.abs(a.data[i+2]-b.data[i+2]) > 12) n++
    }
  }
  return n
}

const browser = await chromium.launch({ args:['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'] })
const page = await browser.newPage({ viewport:{width:1400,height:900} })
const errors = []; page.on('pageerror', e => errors.push(e.message))
await page.route('**/*', async route => {
  const url = route.request().url()
  if (url.startsWith(BASE) && !url.includes('/api/') && !url.includes('/data/')) return route.continue()
  if (url.includes('basemaps.cartocdn.com')) return route.fulfill({ contentType:'application/json', body:JSON.stringify(STUB_STYLE) })
  if (url.includes('/data/transmission_score.geojson')) return route.fulfill({status:404, body:''})
  if (url.includes('/data/transmission_lines.geojson'))
    return route.fulfill({ contentType:'application/json', body: JSON.stringify({type:'FeatureCollection',features:[
      // Horizontal, spanning the AOI — an easy wide target to sample.
      {type:'Feature',properties:{VOLTAGE:138},geometry:{type:'LineString',coordinates:[[-97.05,37.90],[-96.70,37.90]]}}]}) })
  if (url.includes('/data/protected_areas.geojson'))
    return route.fulfill({ contentType:'application/json', body: JSON.stringify({type:'FeatureCollection',features:[
      {type:'Feature',properties:{Mang_Name:'Reserve'},geometry:{type:'Polygon',coordinates:[[
        [-97.00,37.74],[-96.80,37.74],[-96.80,37.82],[-97.00,37.82],[-97.00,37.74]]]}}]}) })
  if (url.includes('/data/') && url.endsWith('.geojson'))
    // Uniform mid score so the raster under the overlays is a flat, known color.
    return route.fulfill({ contentType:'application/json', body: JSON.stringify(grid(PILOT,20,16,()=>50)) })
  if (url.includes('/api/health')) return route.fulfill({contentType:'application/json',body:JSON.stringify({status:'ok'})})
  return route.fulfill({status:204,body:''})
})

// layer=slope -> the blues ramp, so amber and green are unmistakable against it.
await page.goto(`${BASE}?layer=slope`, { waitUntil:'networkidle' })
await page.waitForTimeout(3000)

const both = decode(await page.screenshot())
const amberPx = countColor(both, AMBER, 26)
const greenPx = countColor(both, GREEN, 26)
check('Transmission line renders in its own amber, not tinted by the score layer',
  amberPx > 300, `${amberPx} amber px`)
check('Protected-area outline renders in its own green',
  greenPx > 80, `${greenPx} green px`)

const layersPanel = page.locator('.glass-panel').filter({ has: page.locator('.glass-title', { hasText: 'Layers' }) })
const txBox = layersPanel.locator('[role="checkbox"]').nth(0)
const protBox = layersPanel.locator('[role="checkbox"]').nth(1)

await txBox.click(); await page.waitForTimeout(900)
const noTx = decode(await page.screenshot())
check('Unchecking transmission lines visibly changes the map',
  diffCount(both, noTx) > 300, `${diffCount(both, noTx)} px changed`)
check('Amber is gone once the layer is off', countColor(noTx, AMBER, 26) < 30,
  `${countColor(noTx, AMBER, 26)} amber px`)
await txBox.click(); await page.waitForTimeout(900)
check('Re-checking brings the amber back', countColor(decode(await page.screenshot()), AMBER, 26) > 300)

await protBox.click(); await page.waitForTimeout(900)
const noProt = decode(await page.screenshot())
check('Unchecking protected areas visibly changes the map',
  diffCount(both, noProt) > 300, `${diffCount(both, noProt)} px changed`)
await protBox.click(); await page.waitForTimeout(900)

// The AOI outline must stay on top of the vector overlays.
const withAll = decode(await page.screenshot())
check('AOI rectangle still renders above everything',
  countColor(withAll, [255,255,255], 18) > 200,
  `${countColor(withAll, [255,255,255], 18)} white px`)
await page.screenshot({ path: shot('shot-render-fixed.png') })

// Survives a basemap swap, which wipes and re-adds the whole style.
await page.getByRole('button', { name: /^Basemap:/ }).click()
await page.waitForTimeout(2500)
await page.getByRole('button', { name: /^Basemap:/ }).click()
await page.waitForTimeout(2500)
check('Order survives a basemap swap (style wipe + re-add)',
  countColor(decode(await page.screenshot()), AMBER, 26) > 300,
  `${countColor(decode(await page.screenshot()), AMBER, 26)} amber px`)

check('No uncaught errors', errors.length === 0, errors.join('; '))
await browser.close()
const failed = results.filter(r => !r.p)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
