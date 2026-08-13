# Multi-stage build: build the static site, serve it with nginx.
# This is the M0 checkpoint — `docker build -t solar-siting-explorer .`
# then `docker run -p 8080:80 solar-siting-explorer` should show the blank
# App.jsx page at localhost:8080.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
