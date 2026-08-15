import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // B3/B4 — the frontend always calls the API at the same-origin path
      // `/api` (see src/lib/api.js). In dev, that's this proxy pointing at a
      // locally-run `uvicorn main:app --port 8000`; in the Docker setup it's
      // nginx pointing at the `api` service (nginx.conf). One URL, no CORS,
      // no environment-specific branch in the app code.
      //
      // The path is rewritten because the FastAPI routes are mounted at the
      // root (`/analyze`, `/health`), not under `/api`.
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
