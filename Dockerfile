# Multi-stage build: build the static site, serve it with nginx.
#
# Since B4 the nginx stage also reverse-proxies /api to the `api` service
# (see nginx.conf and docker-compose.yml), so the browser talks to a single
# origin for both the app and the suitability API. Running this image on its
# own still works — the map and all three pre-baked score layers render — but
# the "Run analysis" button needs the API container, so `docker compose up`
# is the intended entry point.

FROM node:20-slim AS build
WORKDIR /app
# Lockfile included so the image installs the same tree the app was
# developed against; npm ci is the reproducible install (and errors out
# rather than silently drifting if the lockfile is stale).
COPY package.json package-lock.json ./
# The test suites bring in Playwright as a devDependency, and `npm ci` installs
# devDependencies because the Vite build needs them. Without this, Playwright's
# postinstall would pull several hundred MB of browsers into a build stage that
# never runs a test.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
