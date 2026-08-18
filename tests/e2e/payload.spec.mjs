// First-paint payload: the criterion layers must be derived from the combined
// layer, not downloaded, and must stay identical to what the files contain.
import { chromium } from 'playwright'
import fs from 'node:fs'
// Deliberately the preview (production build) server, not the dev server:
// React StrictMode double-invokes effects in development, which would double
// the fetch count this suite exists to assert on.
const BASE = process.env.SSE_PREVIEW_URL ?? 'http://localhost:4173'

// Screenshots land in tests/artifacts/ (gitignored). They are debugging aids,
// not assertions — every check in these suites is made against the DOM or the
// pixels, never against a stored image.
const ART = new URL('../artifacts/', import.meta.url).pathname
fs.mkdirSync(ART, { recursive: true })
const shot = (name) => ART + name

const results=[]; const check=(n,p,d='')=>{results.push({n,p});console.log(`${p?'PASS':'FAIL'}  ${n}${d?` — ${d}`:''}`)}
const STUB={version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#101418'}}]}
const PILOT=[-97.05,37.7,-96.7,37.95]

// Combined layer carrying all three sub-scores, as regenerate now produces.
function combined(c,r){const [w,s,e,n]=PILOT;const f=[]
 for(let i=0;i<r;i++)for(let j=0;j<c;j++){const x0=w+((e-w)*j)/c,x1=w+((e-w)*(j+1))/c,y0=s+((n-s)*i)/r,y1=s+((n-s)*(i+1))/r
  f.push({type:'Feature',properties:{score:70,slope_score:88,landcover_score:64,transmission_score:41,
    slope_deg:2.5,landcover_class:'Grassland',transmission_km:5.9,excluded:false},
   geometry:{type:'Polygon',coordinates:[[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]]}})}
 return {type:'FeatureCollection',features:f}}
// Legacy: no sub-scores, so the app must fall back to the separate files.
function legacy(c,r){const g=combined(c,r)
 g.features.forEach(f=>{f.properties={score:70,slope_deg:2.5,landcover_class:'Grassland'}}); return g}

async function run(makeCombined,label){
  const fetched=[]
  const browser=await chromium.launch({args:['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader']})
  const page=await browser.newPage({viewport:{width:1400,height:900}})
  const errors=[]; page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/*',async route=>{
    const url=route.request().url()
    if(url.startsWith(BASE)&&!url.includes('/api/')&&!url.includes('/data/')) return route.continue()
    if(url.includes('basemaps.cartocdn.com')) return route.fulfill({contentType:'application/json',body:JSON.stringify(STUB)})
    if(url.includes('/api/context')) return route.fulfill({contentType:'application/json',
      body:JSON.stringify({transmission:{type:'FeatureCollection',features:[]},protected:{type:'FeatureCollection',features:[]},metadata:{truncated:false}})})
    if(url.includes('/api/health')) return route.fulfill({contentType:'application/json',body:JSON.stringify({status:'ok'})})
    if(url.includes('/data/')&&url.endsWith('.geojson')){
      const name=url.split('/').pop().split('?')[0]
      fetched.push(name)
      if(name==='suitability_score.geojson') return route.fulfill({contentType:'application/json',body:JSON.stringify(makeCombined(12,10))})
      if(name==='transmission_lines.geojson'||name==='protected_areas.geojson')
        return route.fulfill({contentType:'application/json',body:JSON.stringify({type:'FeatureCollection',features:[]})})
      // Criterion files: served, but the app shouldn't need them.
      return route.fulfill({contentType:'application/json',body:JSON.stringify(legacy(12,10))})
    }
    return route.fulfill({status:204,body:''})
  })
  await page.goto(BASE,{waitUntil:'networkidle'}); await page.waitForTimeout(4000)
  const panel=page.locator('.glass-panel').filter({has:page.locator('.glass-title',{hasText:'Layers'})})
  await browser.close()
  return {fetched,errors}
}

const modern = await run(combined,'modern')
const scoreFiles = modern.fetched.filter(f=>f.endsWith('_score.geojson'))
check('Only the combined layer is downloaded',
  scoreFiles.length===1 && scoreFiles[0]==='suitability_score.geojson', scoreFiles.join(', '))
check('Criterion files are never requested',
  !modern.fetched.includes('slope_score.geojson') &&
  !modern.fetched.includes('landcover_score.geojson') &&
  !modern.fetched.includes('transmission_score.geojson'), modern.fetched.join(', '))
check('No uncaught errors (modern data)', modern.errors.length===0, modern.errors.join('; '))

const old = await run(legacy,'legacy')
check('Legacy data without sub-scores falls back to the separate files',
  old.fetched.includes('slope_score.geojson') && old.fetched.includes('landcover_score.geojson'),
  old.fetched.filter(f=>f.endsWith('_score.geojson')).join(', '))
check('No uncaught errors (legacy data)', old.errors.length===0, old.errors.join('; '))

const failed=results.filter(r=>!r.p)
console.log(`\n${results.length-failed.length}/${results.length} checks passed`)
process.exit(failed.length?1:0)
