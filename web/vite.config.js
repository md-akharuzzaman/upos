import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev` here + `npm run dev` in ../app. Vite proxies the API so the
// browser talks to one origin, exactly like in Azure (where Express serves the build).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080', '/health': 'http://localhost:8080' },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 600 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.js'],
    css: false,
    coverage: { include: ['src/**/*.{js,jsx}'], exclude: ['src/main.jsx', 'src/test-setup.js', 'src/**/*.test.*'] },
  },
});
