import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The client: root client/, built into dist/client, which the server serves (one origin: no CORS, cookies stay same-site).
export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/client', emptyOutDir: true, chunkSizeWarningLimit: 400 },
  server: { proxy: { '/api': 'http://127.0.0.1:4100' } },
});
