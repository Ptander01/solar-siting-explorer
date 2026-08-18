// The public demo's no-API state. This must read as a deliberate boundary,
// not a failure — it is what every visitor arriving from the portfolio link
// sees first.
import { chromium } from 'playwright'
import fs from 'node:fs'
const BASE = process.env.SSE_BASE_URL ?? 'http://localhost:5173'
const ART = new URL('../artifacts/', import.meta.url).pathname
fs.mkdirSync(ART, { recursive: true })
const shot = (name) => ART + name

const results = []
const check = (n,p,d='') => { results.push({n,p}); console.log(`${p?'PASS':'FAIL'}  ${n}${d?` — ${d}`:''}`) }
const STUB={version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#101418'}}]}
const PILOT=[-97.05,37.7,-96.7,37.95]
function grid(c,r){const [w,s,e,n]=PILOT;const f=[]
 for(let i=0;i<r;i++)for(let j=0;j<c;j++){const x0=w+((e-w)*j)/c,x1=w+((e-w)*(j+1))/c,y0=s+((n-s)*i)/r,y1=s+((n-s)*(i+1))/r
  f.push({type:'Feature',properties:{score:70,slope_score:88,landcover_score:64,transmission_score:41,slope_deg:2.5,landcover_class:'Grassland',transmission_km:5.9,excluded:false},
   geometry:{type:'Polygon',coordinates:[[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]]}})}
 return {type:'FeatureCollection',features:f}}

const apiCalls = []
const browser = await chromium.launch({args:['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader']})
const page = await browser.newPage({viewport:{width:1400,height:950}})
const errors=[]; page.on('pageerror',e=>errors.push(e.message))
await page.route('**/*', async route => {
  const url = route.request().url()
  if (url.startsWith(BASE) && !url.includes('/api/') && !url.includes('/data/')) return route.continue()
  if (url.includes('basemaps.cartocdn.com')) return route.fulfill({contentType:'application/json',body:JSON.stringify(STUB)})
  if (url.includes('/data/transmission_lines.geojson')||url.includes('/data/protected_areas.geojson'))
    return route.fulfill({contentType:'application/json',body:JSON.stringify({type:'FeatureCollection',features:[]})})
  if (url.includes('/data/suitability_score.geojson'))
    return route.fulfill({contentType:'application/json',body:JSON.stringify(grid(12,10))})
  if (url.includes('/data/')&&url.endsWith('.geojson')) return route.fulfill({status:404,body:''})
  // Exactly what a frontend-only Vercel deploy does: the SPA catch-all
  // answers /api/* with index.html and a 200.
  if (url.includes('/api/')) {
    apiCalls.push(new URL(url).pathname)
    return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><head><title>Solar Siting Explorer</title></head><body><div id="root"></div></body></html>'})
  }
  return route.fulfill({status:204,body:''})
})
await page.goto(BASE,{waitUntil:'networkidle'})
await page.waitForTimeout(3000)

const panel = page.locator('.glass-panel').filter({has: page.locator('.glass-title',{hasText:'Analysis'})})
const text = await panel.innerText()

check('Health check sees through the SPA fallback 200',
  await page.locator('.analysis-offline').isVisible())
check('Message leads with the explanation, not an error',
  /Live analysis runs locally/i.test(text), text.split('\n')[1] ?? '')
check('Says what IS real on the page', /pre-computed|symbology|shareable/i.test(text))
check('Links to the repo',
  (await page.locator('.analysis-offline-note a').getAttribute('href')) === 'https://github.com/Ptander01/solar-siting-explorer')
check('No developer-facing uvicorn/docker instructions in the visible copy',
  !/uvicorn|docker compose/i.test(text), text.replace(/\n/g,' | ').slice(0,120))
check('Not styled as an error', (await page.locator('.analysis-status--error').count()) === 0)

check('Run analysis is disabled',
  await page.getByRole('button',{name:'Run analysis'}).isDisabled())
check('Drawing an AOI is still offered', await page.getByText('Draw AOI').isVisible())
check('Weight and threshold controls still present',
  /criterion weights/i.test(text) && /max usable slope/i.test(text))

// The key regression: no doomed /context requests, and no scary note.
check('Only the health check was attempted, never /context',
  apiCalls.every(p => p.endsWith('/health')), apiCalls.join(', '))
const layers = page.locator('.glass-panel').filter({has: page.locator('.glass-title',{hasText:'Layers'})})
check('No "could not load infrastructure" note',
  !/could not load/i.test(await layers.innerText()))
check('Baked layers still render', (await page.locator('.recharts-wrapper').count()) > 0)

// Panning must not start firing failed requests either.
const canvas = page.locator('.maplibregl-canvas'); const b = await canvas.boundingBox()
await page.mouse.move(b.x+700,b.y+450); await page.mouse.down()
await page.mouse.move(b.x+500,b.y+250,{steps:10}); await page.mouse.up()
await page.waitForTimeout(2000)
check('Panning still makes no API calls',
  apiCalls.every(p => p.endsWith('/health')), apiCalls.join(', '))

await page.screenshot({path: shot('shot-offline.png')})
check('No uncaught errors', errors.length===0, errors.join('; '))
await browser.close()
const failed = results.filter(r=>!r.p)
console.log(`\n${results.length-failed.length}/${results.length} checks passed`)
process.exit(failed.length?1:0)
