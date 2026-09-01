/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';

/**
 * Two build profiles of the same SPA:
 *
 * - `npm run build`         → static, GitHub Pages (`base: '/PicToWebP/'`,
 *   CSP `connect-src 'none'`, in-browser backend, outDir `dist`).
 * - `npm run build:python`  → local server (`base: '/'`, CSP
 *   `connect-src 'self'`, Python backend, outDir `dist-python`).
 *
 * The backend is chosen at build time (see `src/backend/index.ts`) so the
 * static build never probes any network origin.
 */
const CSP = (connectSrc: string) =>
  [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // inline style attributes used by the UI
    "img-src 'self' blob: data:",
    `connect-src ${connectSrc}`,
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

function cspPlugin(connectSrc: string): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n  <meta http-equiv="Content-Security-Policy" content="${CSP(connectSrc)}">`,
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const isPython = mode === 'python';
  return {
    // Vitest: unit tests only — Playwright specs live in e2e/ and run via
    // `npm run test:e2e`; importing @playwright/test under vitest throws.
    test: {
      exclude: ['**/node_modules/**', '**/dist/**', '**/dist-python/**', 'e2e/**', 'e2e-python/**'],
    },
    // Python-hosted builds serve from the root; the static build sits under the
    // GitHub Pages project subpath.
    base: isPython ? '/' : '/PicToWebP/',
    build: {
      outDir: isPython ? 'dist-python' : 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
      target: 'es2020',
      minify: 'esbuild',
      cssMinify: true,
      sourcemap: false,
    },
    server: {
      port: 3000,
      open: true,
    },
    plugins: [cspPlugin(isPython ? "'self'" : "'none'")],
  };
});