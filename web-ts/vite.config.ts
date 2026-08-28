import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
    target: 'es2020',
    minify: 'esbuild',
    cssMinify: true,
  },
  server: {
    port: 3000,
    open: true,
  },
});
