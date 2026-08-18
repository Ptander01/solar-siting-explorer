// Viewport-driven infrastructure loading.
//
// The gap this covers: the pre-baked vector layers are clipped to the pilot
// AOI, so drawing a study area elsewhere gave a score measured against
// transmission lines the map couldn't show.
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
const AMBER = [245, 158, 11]

const STUB_STYLE = { version:8, sources:{}, layers:[{id:'bg',type:'background',paint:{'background-color':'#101418'}}] }
function grid(bbox,c,r){const [w,s,e,n]=bbox;const f=[]
 for(let i=0;i<r;i++)for(let j=0;j<c;j++){const x0=w+((e-w)*j)/c,x1=w+((e-w)*(j+1))/c,y0=s+((n-s)*i)/r,y1=s+((n-s)*(i+1))/r
  f.push({type:'Feature',properties:{score:50,slope_deg:2.5,landcover_class:'Grassland'},geometry:{type:'Polygon',coordinates:[[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]]}})}
 return {type:'FeatureCollection',features:f}}
const PILOT=[-97.05,37.7,-96.7,37.95]
function countAmber(png){let n=0
 for(let y=0;y<png.height;y++)for(let x=360;x<png.width-340;x++){const i=(png.width*y+x)<<2
  if(Math.abs(png.data[i]-AMBER[0])<=26&&Math.abs(png.data[i+1]-AMBER[1])<=26&&Math.abs(png.data[i+2]-AMBER[2])<=26)n++}
 return n}

function decodePng(buf){ return PNG.sync.read(buf) }

const contextCalls = []
let contextMode = 'live'   // 'live' | 'fail' | 'truncated'

const browser = await chromium.launch({args:['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader']})
const page = await browser.newPage({viewport:{width:1400,height:900}})
const errors=[]; page.on('pageerror',e=>errors.push(e.message))
await page.route('**/*', async route=>{
  const url=route.request().url()
  if(url.startsWith(BASE)&&!url.includes('/api/')&&!url.includes('/data/')) return route.continue()
  if(url.includes('basemaps.cartocdn.com')) return route.fulfill({contentType:'application/json',body:JSON.stringify(STUB_STYLE)})
  if(url.includes('arcgisonline.com')) return route.fulfill({status:204,body:''})
  if(url.includes('/data/transmission_score.geojson')) return route.fulfill({status:404,body:''})
  // The pre-baked pilot files: deliberately EMPTY, so any amber on screen can
  // only have come from a /context response.
  if(url.includes('/data/transmission_lines.geojson')||url.includes('/data/protected_areas.geojson'))
    return route.fulfill({contentType:'application/json',body:JSON.stringify({type:'FeatureCollection',features:[]})})
  if(url.includes('/data/')&&url.endsWith('.geojson'))
    return route.fulfill({contentType:'application/json',body:JSON.stringify(grid(PILOT,10,8))})
  if(url.includes('/api/health')) return route.fulfill({contentType:'application/json',body:JSON.stringify({status:'ok'})})
  if(url.includes('/api/context')){
    const bbox=new URL(url).searchParams.get('bbox').split(',').map(Number)
    contextCalls.push(bbox)
    if(contextMode==='fail') return route.fulfill({status:502,body:JSON.stringify({detail:'upstream down'})})
    // A line straight across the middle of whatever window was requested —
    // so it only lands on screen if the request used the *current* viewport.
    const midLat=(bbox[1]+bbox[3])/2
    return route.fulfill({contentType:'application/json',body:JSON.stringify({
      transmission:{type:'FeatureCollection',features:[{type:'Feature',properties:{VOLTAGE:230},
        geometry:{type:'LineString',coordinates:[[bbox[0],midLat],[bbox[2],midLat]]}}]},
      protected:{type:'FeatureCollection',features:[]},
      metadata:{bbox,transmission_count:1,protected_count:0,truncated:contextMode==='truncated'},
    })})
  }
  return route.fulfill({status:204,body:''})
})

await page.goto(BASE,{waitUntil:'networkidle'})
await page.waitForTimeout(3200)

check('Context is fetched on load', contextCalls.length >= 1, `${contextCalls.length} call(s)`)
const first = contextCalls[contextCalls.length-1]
check('Request uses the map viewport, not the pilot AOI',
  first[0] < PILOT[0] && first[2] > PILOT[2], JSON.stringify(first.map(v=>+v.toFixed(3))))
check('Infrastructure from /context is drawn', countAmber(decodePng(await page.screenshot())) > 300,
  `${countAmber(decodePng(await page.screenshot()))} amber px`)

// Pan somewhere new: a fresh request, and the line follows.
const before = contextCalls.length
await page.evaluate(() => window.scrollTo(0,0))
const canvas = page.locator('.maplibregl-canvas'); const b = await canvas.boundingBox()
await page.mouse.move(b.x+700, b.y+450)
await page.mouse.down()
await page.mouse.move(b.x+500, b.y+250,{steps:12})
await page.mouse.up()
await page.waitForTimeout(2200)
check('Panning triggers a new context request', contextCalls.length > before,
  `${before} -> ${contextCalls.length}`)
const moved = contextCalls[contextCalls.length-1]
check('The new request carries the new viewport',
  Math.abs(moved[0]-first[0]) > 0.001 || Math.abs(moved[1]-first[1]) > 0.001,
  JSON.stringify(moved.map(v=>+v.toFixed(3))))
check('Infrastructure is still drawn after panning away from the pilot AOI',
  countAmber(decodePng(await page.screenshot())) > 300)
await page.screenshot({path:shot('shot-context-panned.png')})

// Debounce: a continuous drag must not fire a request per frame.
const preDrag = contextCalls.length
await page.mouse.move(b.x+700, b.y+450)
await page.mouse.down()
for (let i=0;i<6;i++){ await page.mouse.move(b.x+700-i*30, b.y+450-i*20,{steps:3}); await page.waitForTimeout(60) }
await page.mouse.up()
await page.waitForTimeout(2000)
check('A continuous drag is debounced into one request',
  contextCalls.length - preDrag <= 2, `${contextCalls.length - preDrag} requests`)

// Zoom floor.
const preZoom = contextCalls.length
await page.keyboard.press('Escape')
await page.evaluate(() => {
  const root=document.getElementById('root')
  const k=Object.keys(root).find(x=>x.startsWith('__reactContainer'))
  const seen=new Set(); const st=[root[k]]
  while(st.length){const f=st.pop(); if(!f||seen.has(f))continue; seen.add(f)
    let s=f.memoizedState
    while(s){const v=s.memoizedState
      if(v&&v.current&&typeof v.current.getStyle==='function'){ v.current.setZoom(5); return }
      s=s.next}
    if(f.child)st.push(f.child); if(f.sibling)st.push(f.sibling)}
})
await page.waitForTimeout(2200)
check('No request below the zoom floor', contextCalls.length === preZoom,
  `${contextCalls.length - preZoom} extra`)
check('Zoomed out, the panel says why', 
  (await page.locator('.glass-panel').filter({has: page.locator('.glass-title',{hasText:'Layers'})}).innerText())
    .toLowerCase().includes('zoom in'))



check('No uncaught errors', errors.length === 0, errors.join('; '))
await browser.close()
const failed = results.filter(r=>!r.p)
console.log(`\n${results.length-failed.length}/${results.length} checks passed`)
process.exit(failed.length?1:0)
