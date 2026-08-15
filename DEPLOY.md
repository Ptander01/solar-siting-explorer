# Deploying

Two pieces to place: a static frontend and a containerized Python API. The
frontend is trivial to host anywhere; the API needs a real container and a
persistent disk, so it needs somewhere that runs Docker.

Recommended pairing: **Vercel for the frontend, Fly.io for the API.** Vercel
because the repo is already a Vite app and it matches the rest of the
portfolio; Fly because it takes a Dockerfile directly, gives a persistent
volume for the SRTM cache, and scales to zero between visits.

---

## Decide this first: how the browser reaches the API

Locally the frontend calls the same-origin path `/api` and something in front
forwards it — Vite's proxy in dev, nginx in Docker. In a split deploy there is
no such thing in front, so you have to pick one. **This choice matters more
than it looks**, because an `/analyze` run legitimately takes 10–30 seconds and
longer at fine resolution over a fresh area.

### Option A — point the frontend straight at the API *(recommended)*

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

### Option B — proxy `/api` through Vercel

Keep the single-origin design: edit `vercel.json` and replace
`https://REPLACE-ME.fly.dev` with your API host. No CORS config needed at all,
and the API stays unreachable from other origins.

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

## Frontend — Vercel

1. Import the repo at [vercel.com/new](https://vercel.com/new). It should
   detect Vite; `vercel.json` pins the build command and output directory
   anyway.
2. Set `VITE_API_BASE` (Option A) or edit the rewrite destination (Option B).
3. Deploy.

The pre-baked layers in `public/data/` ship with the static build, so the map
renders fully on first paint whether or not the API is awake. Only **Run
analysis** needs the backend, and the panel says so if it's unreachable.

Make sure `public/data/` is committed and current — run
`python3 pipeline/regenerate_baked_layers.py` before deploying if you've
changed the methodology or weights.

## API — Fly.io

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

### Alternatives

**Render** — supports Docker and persistent disks, but disks require a paid
instance type, and free instances sleep with a longer cold start. Point it at
`backend/Dockerfile`, set `SSE_CACHE_DIR` to the mount path.

**Railway** — Docker-native and simple, but persistent volumes and pricing
have changed more than once; check current terms before relying on the cache.

**Anything serverless** (Vercel Functions, Lambda, Cloud Run gen1) — the
geospatial dependency stack is large and the runs are long. Cloud Run gen2 with
a mounted volume can work; classic function runtimes are a poor fit.

## After deploying

1. Load the site and confirm the pre-baked layers render.
2. Draw a small AOI and run an analysis. Time it. Then run the **same** AOI
   again — the second run should be noticeably faster, which is the DEM cache
   proving it's mounted correctly. If it isn't, the volume isn't attached.
3. Copy the share link, open it in a private window, confirm it restores the
   study area and parameters.
4. Update the **Live demo** link in `README.md` and in the portfolio case
   study.

## Cost

Both fit comfortably in free/hobby tiers for portfolio traffic. The thing to
watch is Fly's volume, which is billed by provisioned size whether or not it's
full — 3 GB is a few cents a month, but don't provision 50.
