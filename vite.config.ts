import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so dist/ works from any static host path
  base: './',
  // three.js alone is ~600 kB minified; the warning is expected
  build: { chunkSizeWarningLimit: 900 },
});
