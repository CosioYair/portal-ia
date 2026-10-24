import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En desarrollo, /api se redirige al backend local (apps/server). En producción el backend sirve dist/.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4310', changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: false }
});
