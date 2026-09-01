import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const devPort = Number(process.env.HN_WEB_PORT || 5173);
const chatTarget = process.env.HN_CHAT_PROXY || 'http://127.0.0.1:8787';

// Path the app is served under. "/" for the container on its own port; a
// deployment that puts the demo under a prefix builds with e.g.
// HN_BASE_PATH=/hackernews/ so asset URLs and the runtime fetches in
// src/appUrl.ts carry it. Vite wants the trailing slash.
const base = process.env.HN_BASE_PATH || '/';

// In dev, proxy the chat backend so the browser talks to one origin.
export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: devPort,
    proxy: {
      '/chat': { target: chatTarget, changeOrigin: true },
      // Publisher REST — used by the Explorer and the render-check harness.
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    // Calibrated just above the known @malloydata/render + Vega chunk (~3.4 MB
    // raw), which is deliberately split out and lazily loaded — the default
    // 500 kB limit flagged that split on every build. Anything materially
    // bigger than the renderer is new bloat and should still warn. The number
    // that actually matters is the critical-path chunk (~120 kB gzipped).
    chunkSizeWarningLimit: 3500,
  },
});
