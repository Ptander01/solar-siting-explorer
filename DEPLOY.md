# Deploying

Two pieces to place: a static frontend and a containerized Python API. The
frontend is trivial to host anywhere; the API needs a real runtime with heavy
geospatial binaries, which is where the interesting constraints are.

Two routes, in the order worth trying them:

1. **Vercel alone**, using its multi-service support to host both halves.
   Simplest by far if it works — one platform, one origin, no CORS, and
   `vercel.json` in this repo is already configured for it.
2. **Vercel + Fly.io**, static frontend and the API in a container. More moving
   parts, but nothing about it is in doubt.

---

## Route 1 — Vercel, both services

`vercel.json` declares a `frontend` service (Vite, repo root) and a `backend`
service (`backend/`), with `/api/*` rewritten to the backend and everything
else to the frontend. Import the repo at [vercel.com/new](https://vercel.com/new),
pick the **Services** preset, and deploy.

The browser keeps calling the same-origin path `/api`, exactly as in dev and
Docker, so **no `VITE_API_BASE` and no CORS configuration are needed**.

One routing subtlety is already handled: Vercel's service rewrite forwards
`/api/analyze` to the backend *without stripping the prefix*, while nginx and
Vite's dev proxy both strip it. `backend/main.py` registers its routes twice —
bare and under `/api` — so the service answers either way. Without that you get
a 404 in production while every other part of the deploy looks correct.

### Three things that could stop this working

Try it, but know the failure signatures rather than guessing at them:

- **Dependency size.** rasterio, geopandas, pyproj, shapely, pandas and numpy
  come to **~425 MB installed**, most of it bundled GDAL/GEOS/PROJ binaries.
  Platform size limits are the single most likely thing to reject this deploy.
  Symptom: the build fails at the packaging step, not at import.
- **No persistent disk.** The SRTM tile cache falls back to the system temp
  directory and won't survive between invocations, so every analysis
  re-downloads its elevation tiles. Not fatal — it's the behaviour from before
  the cache existed — but it makes repeat runs over one area as slow as the
  first, which is the case the cache was added for.
- **Request duration limits.** A fine-grid run over an area whose tiles aren't
  cached can exceed a minute, and with no persistent cache that's the *normal*
  case rather than the worst one. Symptom: a gateway timeout while the service
  is still working fine.

If any of those bite, the frontend service still deploys perfectly — drop the
`backend` service from `vercel.json`, set `VITE_API_BASE`, and continue with
Route 2 for the API.

---

## Route 2 — Vercel frontend, Fly.io API

Fly because the API wants two things a serverless platform doesn't give you: a
real container for the geospatial dependency stack, and a persistent disk for
the SRTM cache.

### Decide first: how the browser reaches the API

#### Option A — point the frontend straight at the API *(recommended)*

Set `VITE_API_BASE` at build time to the API's URL. The browser then calls the
Fly host directly, which means CORS applies — hence `SSE_ALLOWED_ORIGINS` on
the API.

```
# Vercel → Project → Settings → Environment Variables
VITE_API_BASE = https://your-api.fly.dev

# Fly
fly secrets set SSE_ALLOWED_ORIGINS="https://your-app.vercel.app"
```

Delete `vercel.json`'s `rewrites` block if you go this way.

**Why this is the recommendation:** nothing sits between the browser and a
long-running request, so there's no proxy timeout to run into. The cost is a
CORS preflight on each call, which is negligible next to the request itself.

#### Option B — proxy `/api` through Vercel

Keep the single-origin design: replace `vercel.json`'s service-based rewrites
with a rewrite to the Fly host. No CORS config needed at all, and the API stays
unreachable from other origins.

```jsonc
"rewrites": [
  { "source": "/api/:path*", "destination": "https://your-api.fly.dev/:path*" }
]
```

**The catch:** Vercel's edge proxy imposes its own ceiling on how long it will
wait for an external rewrite to respond, and a fine-grid run over an area whose
SRTM tiles aren't cached yet can exceed it — the user sees a gateway error
while the API is still working normally. If you take this route, test a
worst-case run (fine resolution, an AOI you've never analyzed) before calling
it done. It's tidier, and it's fine if your runs stay short; it is not the
safer default for this workload.

---

### Frontend — Vercel

1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. Drop the `backend` service from `vercel.json`, leaving the `frontend` one.
3. Set `VITE_API_BASE` (Option A) or point the rewrite at Fly (Option B).
4. Deploy.

The pre-baked layers in `public/data/` ship with the static build, so the map
renders fully on first paint whether or not the API is awake. Only **Run
analysis** needs the backend, and the panel says so if it's unreachable.

Make sure `public/data/` is committed and current — run
`python3 pipeline/regenerate_baked_layers.py` before deploying if you've
changed the methodology or weights.

### API — Fly.io

```bash
cd backend
fly launch --no-deploy          # accept the existing fly.toml; pick a unique app name
fly volumes create dem_cache --size 3 --region ord    # match primary_region
fly deploy
```

Then check it:

```bash
curl https://your-api.fly.dev/health
# {"status":"ok"}
```

Notes:

- **Rename the app** in `fly.toml` before launching — Fly app names are global.
- **The volume is not optional.** Without it, `SSE_CACHE_DIR` points at a path
  inside the container and the cache dies with every machine suspend, which
  removes most of the benefit. 3 GB holds ~100 SRTM tiles.
- **1 GB of memory**, not 512 MB. Rasterio holds the mosaicked DEM plus the
  reprojected WorldCover window, and the grid step builds a GeoDataFrame of up
  to ~39k cells at fine resolution.
- **Cold starts are expected.** `auto_stop_machines = "suspend"` scales to zero
  between visits; the first request after idle pays a few seconds of wake-up,
  which is minor next to the analysis. The frontend's health check may briefly
  report the API offline while it wakes — reloading fixes it.

#### Other hosts

**Render** — supports Docker and persistent disks, but disks require a paid
instance type, and free instances sleep with a longer cold start. Point it at
`backend/Dockerfile`, set `SSE_CACHE_DIR` to the mount path.

**Railway** — Docker-native and simple, but persistent volumes and pricing
have changed more than once; check current terms before relying on the cache.

**Classic serverless function runtimes** (Lambda, Cloud Run gen1) — the
dependency stack is far too large and the runs too long. Cloud Run gen2 with a
mounted volume can work.

## After deploying

1. Load the site and confirm the pre-baked layers render.
2. Draw a small AOI and run an analysis. Time it. Then run the **same** AOI
   again — the second run should be noticeably faster, which is the DEM cache
   proving it's mounted correctly. If it isn't, the volume isn't attached.
3. **Pan away from Butler County.** Transmission lines and protected areas
   should load for wherever you are — that's `/context`, and it's the quickest
   confirmation the API is reachable, since it needs no interaction.
4. Copy the share link, open it in a private window, confirm it restores the
   study area and parameters.
5. Update the **Live demo** link in `README.md` and in the portfolio case
   study.

## Cost

Both fit comfortably in free/hobby tiers for portfolio traffic. The thing to
watch is Fly's volume, which is billed by provisioned size whether or not it's
full — 3 GB is a few cents a month, but don't provision 50.
