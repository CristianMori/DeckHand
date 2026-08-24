import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname),
  build: {
    outDir: resolve(import.meta.dirname, '../server/public'),
    emptyOutDir: true,
  },
  server: {
    port: 5960,
    proxy: {
      '/api': 'http://127.0.0.1:5959',
      '/ws': { target: 'ws://127.0.0.1:5959', ws: true },
    },
  },
});
