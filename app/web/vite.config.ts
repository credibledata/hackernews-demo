import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy the chat backend so the browser talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/chat': { target: 'http://127.0.0.1:8787', changeOrigin: true },
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
