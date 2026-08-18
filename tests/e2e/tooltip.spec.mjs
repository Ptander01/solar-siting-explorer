// The hover tooltip must surface every criterion behind the score — this
// existed because transmission proximity was computed and scored but never
// shown, so from the UI you couldn't tell the criterion existed at all.
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

const STUB_STYLE = { version:8, sources:{}, layers:[{id:'bg',type:'background',paint:{'background-color':'#101418'}}] }
// `extra` lets each case control which properties the features carry.
function grid(bbox, c, r, extra) {
  const [w,s,e,n] = bbox; const features = []
  for (let i=0;i<r;i++) for (let j=0;j<c;j++) {
    const x0=w+((e-w)*j)/c, x1=w+((e-w)*(j+1))/c, y0=s+((n-s)*i)/r, y1=s+((n-s)*(i+1))/r
    features.push({ type:'Feature', properties:{ score:64.2, ...extra(i,j) },
      geometry:{type:'Polygon',coordinates:[[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]]} })
  }
  return { type:'FeatureCollection', features }
}
const PILOT=[-97.05,37.7,-96.7,37.95]

// Case A: current-vintage data — all criteria present, nothing excluded.
const MODERN = () => ({ slope_deg:2.5, landcover_class:'Grassland',
  transmission_km: 3.2, transmission_score: 68, excluded: false })
// Case C: every cell on protected land. Whole-grid rather than a single band
// so the assertion doesn't depend on which cell the cursor lands in.
const EXCLUDED = () => ({ slope_deg:2.5, landcover_class:'Grassland',
  transmission_km: 3.2, transmission_score: 68, excluded: true })
// Case B: legacy data baked before the transmission criterion existed.
const LEGACY = () => ({ slope_deg:2.5, landcover_class:'Grassland' })

async function tooltipAt(page, fx, fy) {
  const canvas = page.locator('.maplibregl-canvas')
  const b = await canvas.boundingBox()
  await page.mouse.move(b.x + b.width*fx, b.y + b.height*fy)
  await page.waitForTimeout(700)
  const el = page.locator('#deckgl-wrapper .deck-tooltip, .deck-tooltip')
  if (!(await el.count())) return ''
  return (await el.first().innerText()).trim()
}

async function run(extra, label) {
  const browser = await chromium.launch({ args:['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'] })
  const page = await browser.newPage({ viewport:{width:1400,height:900} })
  await page.route('**/*', async route => {
    const url = route.request().url()
    if (url.startsWith(BASE) && !url.includes('/api/') && !url.includes('/data/')) return route.continue()
    if (url.includes('basemaps.cartocdn.com')) return route.fulfill({contentType:'application/json',body:JSON.stringify(STUB_STYLE)})
    if (url.includes('/data/transmission_score.geojson')) return route.fulfill({status:404,body:''})
    if (url.includes('/data/transmission_lines.geojson') || url.includes('/data/protected_areas.geojson'))
      return route.fulfill({contentType:'application/json',body:JSON.stringify({type:'FeatureCollection',features:[]})})
    if (url.includes('/data/') && url.endsWith('.geojson'))
      return route.fulfill({contentType:'application/json',body:JSON.stringify(grid(PILOT,10,8,extra))})
    if (url.includes('/api/health')) return route.fulfill({contentType:'application/json',body:JSON.stringify({status:'ok'})})
    return route.fulfill({status:204,body:''})
  })
  await page.goto(BASE,{waitUntil:'networkidle'})
  await page.waitForTimeout(2800)
  const mid = await tooltipAt(page, 0.5, 0.45)
  await page.screenshot({ path:shot(`shot-tooltip-${label}.png`) })
  await browser.close()
  return { mid }
}

const modern = await run(MODERN, 'modern')
check('Tooltip shows the combined score', modern.mid.includes('64.2/100'), modern.mid.replace(/\n/g,' | '))
check('Tooltip shows slope in degrees', modern.mid.includes('2.5°'))
check('Tooltip shows the land cover class', modern.mid.includes('Grassland'))
check('Tooltip shows distance to transmission', /Transmission:\s*3\.2 km/.test(modern.mid),
  modern.mid.replace(/\n/g,' | '))
check('Non-excluded cell is not flagged', !/Protected/i.test(modern.mid))

const excluded = await run(EXCLUDED, 'excluded')
check('Excluded cell is called out', /Protected/i.test(excluded.mid),
  excluded.mid.replace(/\n/g,' | '))
check('Excluded cell still shows its criteria',
  excluded.mid.includes('2.5°') && /Transmission:\s*3\.2 km/.test(excluded.mid))

const legacy = await run(LEGACY, 'legacy')
check('Legacy data still shows score/slope/land cover',
  legacy.mid.includes('64.2/100') && legacy.mid.includes('2.5°') && legacy.mid.includes('Grassland'),
  legacy.mid.replace(/\n/g,' | '))
check('Legacy data shows no transmission row rather than "undefined km"',
  !/Transmission/i.test(legacy.mid) && !/undefined|null|NaN/i.test(legacy.mid),
  legacy.mid.replace(/\n/g,' | '))

const failed = results.filter(r => !r.p)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
